/**
 * 数据库适配器层：sqlite（node:sqlite 内置）/ mysql（mysql2）/ postgres（pg）三实现。
 * 统一接口：listTables / describeTable / query / exec / ping / close。
 *
 * @module dsh-sql/adapters
 */
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { assertIdentifier, missingConnectionFields } from './config.js';
function abortReason(signal) {
    if (signal.reason !== undefined)
        return signal.reason;
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
}
/**
 * 把驱动抛出的错误转成「message 一定有内容」的错误。
 *
 * 驱动与 Node 有些情况下抛 `AggregateError` —— 例如 host 未给时 net 层同时试 IPv4/IPv6、
 * 全部失败后聚合 —— 而它的 `message` 默认为空串，真正的错误躺在 `errors[]` 里。
 * 原样抛出去，调用方（AI）只能看到一个空报错，无从判断是配置错还是网络不通。
 */
function describeDriverError(error) {
    if (error instanceof AggregateError && error.errors.length > 0) {
        const inner = error.errors.map((item) => describeDriverError(item).message).filter((text) => text !== '');
        if (inner.length > 0)
            return new Error(inner.join('；'), { cause: error });
    }
    if (error instanceof Error) {
        if (error.message !== '')
            return error;
        // message 为空时按 code / errno / syscall 拼一个，总比空字符串强。
        const detail = [error.name, error.code, error.syscall]
            .filter((part) => typeof part === 'string' && part !== '')
            .join(' ');
        return new Error(detail !== '' ? detail : '未知错误（驱动未给出信息）', { cause: error });
    }
    return new Error(String(error));
}
function toValue(value) {
    if (typeof value === 'bigint') {
        if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
            return Number(value);
        }
        return value.toString();
    }
    if (value instanceof Date)
        return value.toISOString();
    if (value instanceof Uint8Array)
        return Array.from(value);
    if (value instanceof Map)
        return Object.fromEntries(value);
    return value;
}
function rowsToColumns(rows) {
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    const values = rows.map((row) => columns.map((column) => toValue(row[column])));
    return { columns, rows: values };
}
function quoteSqliteIdentifier(name) {
    return '"' + name.replace(/"/g, '""') + '"';
}
function streamMysqlQuery(corePool, sql, limit, discard) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let columns = [];
        const rows = [];
        const stream = corePool.query(sql).stream({ highWaterMark: 64 });
        const finish = () => {
            if (settled)
                return;
            settled = true;
            resolve({ columns, rows });
        };
        stream.on('fields', (fields) => {
            columns = fields.map((field) => field.name);
        });
        // 必须消费这个 Readable，否则 mysql2 会一直卡在 highWaterMark 上。
        stream.on('data', (row) => {
            if (settled)
                return;
            if (columns.length === 0)
                columns = Object.keys(row);
            rows.push(columns.map((name) => toValue(row[name])));
            if (rows.length >= limit) {
                finish();
                stream.destroy();
                // 只销毁 Readable 时，mysql2 会把连接放回池里继续用。
                discard();
            }
        });
        stream.on('end', finish);
        stream.on('close', finish);
        stream.on('error', (error) => {
            if (settled)
                return;
            settled = true;
            reject(describeDriverError(error));
        });
    });
}
/** pg's `rows` option is a page size; row events avoid its full result accumulator. */
function streamPostgresQuery(client, sql, limit, discard) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let columns = [];
        const rows = [];
        const query = new pg.Query(sql);
        query.on('row', (row, result) => {
            if (settled)
                return;
            if (columns.length === 0)
                columns = result?.fields.map((field) => field.name) ?? Object.keys(row);
            rows.push(columns.map((name) => toValue(row[name])));
            if (rows.length >= limit) {
                // 关掉这条专用连接：既让服务端停止继续产出，也避免它被放回池里复用。
                settled = true;
                discard();
                resolve({ columns, rows });
            }
        });
        query.on('end', (result) => {
            if (settled)
                return;
            settled = true;
            if (columns.length === 0)
                columns = result.fields.map((field) => field.name);
            resolve({ columns, rows });
        });
        // 达上限后仍保留此监听：销毁 client 时驱动可能在本次查询上抛出异步的连接关闭错误。
        query.on('error', (error) => {
            if (settled)
                return;
            settled = true;
            reject(describeDriverError(error));
        });
        client.query(query);
    });
}
/** SQLite 适配器（node:sqlite，零依赖）。 */
class SqliteAdapter {
    engine = 'sqlite';
    db;
    constructor(file) {
        this.db = new DatabaseSync(file === ':memory:' ? ':memory:' : file);
        this.db.exec('PRAGMA busy_timeout = 5000');
    }
    async listTables(signal) {
        signal?.throwIfAborted();
        const result = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
        signal?.throwIfAborted();
        return result.map((row) => String(row.name));
    }
    async describeTable(table, signal) {
        signal?.throwIfAborted();
        const name = assertIdentifier(table, '表名');
        const rows = this.db.prepare('PRAGMA table_info(' + quoteSqliteIdentifier(name) + ')').all();
        signal?.throwIfAborted();
        return rows.map((row) => ({
            name: String(row.name),
            type: String(row.type ?? ''),
            notNull: Number(row.notnull) === 1,
            primaryKey: Number(row.pk) === 1,
        }));
    }
    async query(sql, limit, signal) {
        signal?.throwIfAborted();
        const statement = this.db.prepare(sql);
        if (limit === undefined || limit <= 0) {
            const rows = statement.all();
            signal?.throwIfAborted();
            return rowsToColumns(rows);
        }
        const columns = statement.columns().map((column) => column.name);
        const rows = [];
        for (const raw of statement.iterate()) {
            const row = raw;
            rows.push(columns.map((name) => toValue(row[name])));
            signal?.throwIfAborted();
            if (rows.length >= limit)
                break;
        }
        return { columns, rows };
    }
    async exec(sql, signal) {
        signal?.throwIfAborted();
        const single = sql.replace(/;\s*$/, '').trim();
        // 多语句必须拦下：node:sqlite 的 prepare().run() 遇到多语句**不报错、静默只执行第一条**，
        // 后面的语句会被无声丢弃。工具的 sql_exec 已拦一道，这里兜住直接调用适配器的场景。
        // 与 mysql / postgres 行为一致（那两个由驱动报错）。
        if (single.includes(';')) {
            throw new Error('SQLite 一次只能执行一条语句。请拆成多次调用。');
        }
        const result = this.db.prepare(single).run();
        signal?.throwIfAborted();
        return Number(result.changes);
    }
    async ping(signal) {
        signal?.throwIfAborted();
        this.db.prepare('SELECT 1').get();
        signal?.throwIfAborted();
    }
    async close() {
        this.db.close();
    }
}
/** MySQL 适配器（mysql2 连接池）。 */
class MysqlAdapter {
    engine = 'mysql';
    pool;
    constructor(connection) {
        this.pool = mysql.createPool({
            host: connection.host,
            port: connection.port,
            user: connection.user,
            password: connection.password,
            database: connection.database,
            connectionLimit: 5,
            enableKeepAlive: true,
        });
    }
    async withSignalConnection(signal, work) {
        signal?.throwIfAborted();
        // 取连接是连接失败的爆发点（host/端口/凭据错都在这里），转一手免得 message 为空。
        const connection = await this.pool.getConnection().catch((error) => { throw describeDriverError(error); });
        let destroyed = false;
        let rejectAbort = () => { };
        const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
        const discard = () => {
            if (destroyed)
                return;
            destroyed = true;
            connection.destroy();
        };
        const onAbort = () => {
            discard();
            rejectAbort(abortReason(signal));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            signal?.throwIfAborted();
            return await Promise.race([work(connection, discard), aborted]);
        }
        finally {
            signal?.removeEventListener('abort', onAbort);
            if (!destroyed)
                connection.release();
        }
    }
    async queryRows(sql, signal) {
        if (signal === undefined) {
            return await this.pool.query(sql).catch((error) => { throw describeDriverError(error); });
        }
        return await this.withSignalConnection(signal, async (connection) => await connection.query(sql));
    }
    async listTables(signal) {
        const [rows] = await this.queryRows('SHOW TABLES', signal);
        return rows.map((row) => String(Object.values(row)[0] ?? ''));
    }
    async describeTable(table, signal) {
        const name = assertIdentifier(table, '表名');
        const [rows] = await this.queryRows('DESCRIBE `' + name + '`', signal);
        return rows.map((row) => ({
            name: String(row.Field),
            type: String(row.Type ?? ''),
            notNull: String(row.Null ?? '').toUpperCase() === 'NO',
            primaryKey: String(row.Key ?? '').toUpperCase() === 'PRI',
        }));
    }
    async query(sql, limit, signal) {
        if (limit === undefined || limit <= 0) {
            const [rows] = await this.queryRows(sql, signal);
            return rowsToColumns(rows);
        }
        return await this.withSignalConnection(signal, async (connection, discard) => {
            const coreConnection = connection.connection;
            return await streamMysqlQuery(coreConnection, sql, limit, discard);
        });
    }
    async exec(sql, signal) {
        const [result] = await this.queryRows(sql, signal);
        return Number(result?.affectedRows ?? 0);
    }
    async ping(signal) {
        await this.queryRows('SELECT 1', signal);
    }
    async close() {
        await this.pool.end();
    }
}
/** PostgreSQL 适配器（pg 连接池）。 */
class PostgresAdapter {
    engine = 'postgres';
    pool;
    constructor(connection) {
        this.pool = new pg.Pool({
            host: connection.host,
            port: connection.port,
            user: connection.user,
            password: connection.password,
            database: connection.database,
            max: 5,
        });
    }
    async withSignalClient(signal, work) {
        signal?.throwIfAborted();
        // 取连接是连接失败的爆发点（host/端口/凭据错都在这里），转一手免得 message 为空。
        const client = await this.pool.connect().catch((error) => { throw describeDriverError(error); });
        let destroyed = false;
        let rejectAbort = () => { };
        const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
        const discard = () => {
            if (destroyed)
                return;
            destroyed = true;
            client.release(true);
        };
        const onAbort = () => {
            discard();
            rejectAbort(abortReason(signal));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            signal?.throwIfAborted();
            return await Promise.race([work(client, discard), aborted]);
        }
        finally {
            signal?.removeEventListener('abort', onAbort);
            if (!destroyed)
                client.release();
        }
    }
    async queryWithSignal(query, values, signal) {
        const run = async (client) => {
            return values === undefined ? await client.query(query) : await client.query(query, values);
        };
        if (signal === undefined) {
            return await run(this.pool).catch((error) => { throw describeDriverError(error); });
        }
        return await this.withSignalClient(signal, run);
    }
    async listTables(signal) {
        const result = await this.queryWithSignal("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name", undefined, signal);
        return result.rows.map((row) => String(row.table_name));
    }
    async describeTable(table, signal) {
        const name = assertIdentifier(table, '表名');
        const result = await this.queryWithSignal(`SELECT c.column_name, c.data_type, c.is_nullable,
              EXISTS (
                SELECT 1
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema = kcu.table_schema
                WHERE tc.table_schema = c.table_schema
                  AND tc.table_name = c.table_name
                  AND tc.constraint_type = 'PRIMARY KEY'
                  AND kcu.column_name = c.column_name
              ) AS is_primary
         FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = $1
        ORDER BY c.ordinal_position`, [name], signal);
        return result.rows.map((row) => ({
            name: String(row.column_name),
            type: String(row.data_type ?? ''),
            notNull: String(row.is_nullable) === 'NO',
            primaryKey: row.is_primary === true,
        }));
    }
    async query(sql, limit, signal) {
        if (limit === undefined || limit <= 0) {
            const result = await this.queryWithSignal(sql, undefined, signal);
            const rows = result.rows;
            return rowsToColumns(rows);
        }
        return await this.withSignalClient(signal, async (client, discard) => {
            return await streamPostgresQuery(client, sql, limit, discard);
        });
    }
    async exec(sql, signal) {
        const result = await this.queryWithSignal(sql, undefined, signal);
        return Number(result.rowCount ?? 0);
    }
    async ping(signal) {
        await this.queryWithSignal('SELECT 1', undefined, signal);
    }
    async close() {
        await this.pool.end();
    }
}
/** 按连接配置创建适配器。 */
export function createAdapter(connection) {
    // 不补默认值：缺字段要么是配置被手改坏了，要么是绕过 sql_connection_set 写入的。
    // 报出缺了什么，好过悄悄连到 localhost 或内存库上。
    // 规则与写入侧共用（missingConnectionFields），这里只负责措辞。
    const missing = missingConnectionFields(connection);
    if (missing.length > 0) {
        throw new Error('连接配置缺少必填字段：' + missing.join('、') + '。请用 sql_connection_set 补全。');
    }
    if (connection.engine === 'sqlite')
        return new SqliteAdapter(connection.file);
    if (connection.engine === 'mysql')
        return new MysqlAdapter(connection);
    return new PostgresAdapter(connection);
}
