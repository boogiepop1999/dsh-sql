/**
 * 数据库适配器层：sqlite（node:sqlite 内置）/ mysql（mysql2）/ postgres（pg）三实现。
 * 统一接口：listTables / describeTable / query / exec / ping / close。
 *
 * @module dsh-sql/adapters
 */
import { DatabaseSync } from 'node:sqlite'
import mysql from 'mysql2/promise'
import pg from 'pg'
import { assertIdentifier, missingConnectionFields, type SqlConnectionConfig } from './config.js'
import { countStatements } from './sql-lex.js'

/** 查询结果：列名 + 行（值数组，无损 JSON 友好）。 */
export interface QueryResult {
  columns: string[]
  rows: unknown[][]
}

/** 表列信息。 */
export interface ColumnInfo {
  name: string
  type: string
  notNull: boolean
  primaryKey: boolean
}

/** 统一适配器接口。 */
export interface DatabaseAdapter {
  engine: 'sqlite' | 'mysql' | 'postgres'
  listTables(signal?: AbortSignal): Promise<string[]>
  describeTable(table: string, signal?: AbortSignal): Promise<ColumnInfo[]>
  query(sql: string, limit?: number, signal?: AbortSignal): Promise<QueryResult>
  exec(sql: string, signal?: AbortSignal): Promise<number>
  ping(signal?: AbortSignal): Promise<void>
  close(): Promise<void>
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

/**
 * 把驱动抛出的错误转成「message 一定有内容」的错误。
 *
 * 驱动与 Node 有些情况下抛 `AggregateError` —— 例如 host 未给时 net 层同时试 IPv4/IPv6、
 * 全部失败后聚合 —— 而它的 `message` 默认为空串，真正的错误躺在 `errors[]` 里。
 * 原样抛出去，调用方（AI）只能看到一个空报错，无从判断是配置错还是网络不通。
 */
function describeDriverError(error: unknown): Error {
  if (error instanceof AggregateError && error.errors.length > 0) {
    const inner = error.errors.map((item) => describeDriverError(item).message).filter((text) => text !== '')
    if (inner.length > 0) return new Error(inner.join('；'), { cause: error })
  }
  if (error instanceof Error) {
    if (error.message !== '') return error
    // message 为空时按 code / errno / syscall 拼一个，总比空字符串强。
    const detail = [error.name, (error as { code?: unknown }).code, (error as { syscall?: unknown }).syscall]
      .filter((part) => typeof part === 'string' && part !== '')
      .join(' ')
    return new Error(detail !== '' ? detail : '未知错误（驱动未给出信息）', { cause: error })
  }
  return new Error(String(error))
}

function toValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(value)
    }
    return value.toString()
  }
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return Array.from(value)
  if (value instanceof Map) return Object.fromEntries(value)
  return value
}

function rowsToColumns(rows: Array<Record<string, unknown>>): QueryResult {
  const columns = rows.length > 0 ? Object.keys(rows[0]) : []
  const values = rows.map((row) => columns.map((column) => toValue(row[column])))
  return { columns, rows: values }
}

function quoteSqliteIdentifier(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

function streamMysqlQuery(corePool: { query(querySql: string): any }, sql: string, limit: number, discard: () => void): Promise<QueryResult> {
  return new Promise<QueryResult>((resolve, reject) => {
    let settled = false
    let columns: string[] = []
    const rows: unknown[][] = []
    const stream = corePool.query(sql).stream({ highWaterMark: 64 })
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve({ columns, rows })
    }
    stream.on('fields', (fields: Array<{ name: string }>) => {
      columns = fields.map((field) => field.name)
    })
    // 必须消费这个 Readable，否则 mysql2 会一直卡在 highWaterMark 上。
    stream.on('data', (row: Record<string, unknown>) => {
      if (settled) return
      if (columns.length === 0) columns = Object.keys(row)
      rows.push(columns.map((name) => toValue(row[name])))
      if (rows.length >= limit) {
        finish()
        stream.destroy()
        // 只销毁 Readable 时，mysql2 会把连接放回池里继续用。
        discard()
      }
    })
    stream.on('end', finish)
    stream.on('close', finish)
    stream.on('error', (error: unknown) => {
      if (settled) return
      settled = true
      reject(describeDriverError(error))
    })
  })
}

/** pg 的 `rows` 选项是「每页大小」，用 row 事件才能避开它的全量结果累积。 */
function streamPostgresQuery(client: pg.PoolClient, sql: string, limit: number, discard: () => void): Promise<QueryResult> {
  return new Promise<QueryResult>((resolve, reject) => {
    let settled = false
    let columns: string[] = []
    const rows: unknown[][] = []
    const query = new pg.Query<Record<string, unknown>>(sql)
    query.on('row', (row, result) => {
      if (settled) return
      if (columns.length === 0) columns = result?.fields.map((field) => field.name) ?? Object.keys(row)
      rows.push(columns.map((name) => toValue(row[name])))
      if (rows.length >= limit) {
        // 关掉这条专用连接：既让服务端停止继续产出，也避免它被放回池里复用。
        settled = true
        discard()
        resolve({ columns, rows })
      }
    })
    query.on('end', (result) => {
      if (settled) return
      settled = true
      if (columns.length === 0) columns = result.fields.map((field) => field.name)
      resolve({ columns, rows })
    })
    // 达上限后仍保留此监听：销毁 client 时驱动可能在本次查询上抛出异步的连接关闭错误。
    query.on('error', (error) => {
      if (settled) return
      settled = true
      reject(describeDriverError(error))
    })
    // client.query() 的返回值必须接住：pg 在连接已损坏时不 emit 'error' 事件，
    // 而是让这个 promise reject（"Client has encountered a connection error and is not queryable"）。
    // 不接的后果是三重灾难 —— unhandledRejection 直接崩掉 Node 进程、本 Promise 永不 settle、
    // 那条 client 永不归还，跑几次就耗尽连接池。
    const sent = client.query(query) as unknown
    if (sent instanceof Promise) {
      sent.catch((error: unknown) => {
        if (settled) return
        settled = true
        discard()
        reject(describeDriverError(error))
      })
    }
  })
}

/** SQLite 适配器（node:sqlite，零依赖）。 */
class SqliteAdapter implements DatabaseAdapter {
  engine = 'sqlite' as const
  private db: DatabaseSync
  constructor(file: string) {
    this.db = new DatabaseSync(file === ':memory:' ? ':memory:' : file)
    this.db.exec('PRAGMA busy_timeout = 5000')
  }
  async listTables(signal?: AbortSignal) {
    signal?.throwIfAborted()
    const result = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<Record<string, unknown>>
    signal?.throwIfAborted()
    return result.map((row) => String(row.name))
  }
  async describeTable(table: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const name = assertIdentifier(table, '表名')
    const rows = this.db.prepare('PRAGMA table_info(' + quoteSqliteIdentifier(name) + ')').all() as Array<Record<string, unknown>>
    signal?.throwIfAborted()
    return rows.map((row) => ({
      name: String(row.name),
      type: String(row.type ?? ''),
      notNull: Number(row.notnull) === 1,
      primaryKey: Number(row.pk) === 1,
    }))
  }
  async query(sql: string, limit?: number, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const statement = this.db.prepare(sql)
    if (limit === undefined || limit <= 0) {
      const rows = statement.all() as Array<Record<string, unknown>>
      signal?.throwIfAborted()
      return rowsToColumns(rows)
    }
    const columns = statement.columns().map((column) => column.name)
    const rows: unknown[][] = []
    for (const raw of statement.iterate()) {
      const row = raw as Record<string, unknown>
      rows.push(columns.map((name) => toValue(row[name])))
      signal?.throwIfAborted()
      if (rows.length >= limit) break
    }
    return { columns, rows }
  }
  async exec(sql: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    // 多语句必须拦下：node:sqlite 的 prepare().run() 遇到多语句**不报错、静默只执行第一条**，
    // 后面的语句会被无声丢弃。工具层已拦一道，这里兜住直接调用适配器的场景，
    // 与 mysql / postgres 一致（那两个由驱动报错）。
    //
    // 判断用 countStatements（去噪后数）而不是裸 includes(';')：后者会被注释或字面量里的
    // 分号骗到，把 `CREATE TABLE t (id INT) /* ; */` 这种单语句误报成多语句。
    // 注意执行仍用原始 sql —— 去噪会抹掉字面量，只适合拿来判断。
    if (countStatements(sql) > 1) {
      throw new Error('SQLite 一次只能执行一条语句。请拆成多次调用。')
    }
    const result = this.db.prepare(sql.replace(/;\s*$/, '').trim()).run()
    signal?.throwIfAborted()
    return Number(result.changes)
  }
  async ping(signal?: AbortSignal) {
    signal?.throwIfAborted()
    this.db.prepare('SELECT 1').get()
    signal?.throwIfAborted()
  }
  async close() {
    this.db.close()
  }
}

/** MySQL 适配器（mysql2 连接池）。 */
class MysqlAdapter implements DatabaseAdapter {
  engine = 'mysql' as const
  private pool: mysql.Pool
  constructor(connection: SqlConnectionConfig) {
    this.pool = mysql.createPool({
      host: connection.host,
      port: connection.port,
      user: connection.user,
      password: connection.password,
      database: connection.database,
      connectionLimit: 5,
      enableKeepAlive: true,
    })
  }
  private async withSignalConnection<T>(signal: AbortSignal | undefined, work: (connection: mysql.PoolConnection, discard: () => void) => Promise<T>): Promise<T> {
    signal?.throwIfAborted()
    // 取连接是连接失败的爆发点（host/端口/凭据错都在这里），转一手免得 message 为空。
    const connection = await this.pool.getConnection().catch((error: unknown) => { throw describeDriverError(error) })
    let destroyed = false
    let rejectAbort: (reason: unknown) => void = () => {}
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    const discard = (): void => {
      if (destroyed) return
      destroyed = true
      connection.destroy()
    }
    const onAbort = (): void => {
      discard()
      rejectAbort(abortReason(signal!))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      signal?.throwIfAborted()
      return await Promise.race([work(connection, discard), aborted])
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (!destroyed) connection.release()
    }
  }
  private async queryRows(sql: string, signal?: AbortSignal): Promise<any> {
    if (signal === undefined) {
      return await this.pool.query(sql).catch((error: unknown) => { throw describeDriverError(error) })
    }
    return await this.withSignalConnection(signal, async (connection) => await connection.query(sql))
  }
  async listTables(signal?: AbortSignal) {
    const [rows] = await this.queryRows('SHOW TABLES', signal) as unknown as [Array<Record<string, unknown>>, unknown]
    return rows.map((row) => String(Object.values(row)[0] ?? ''))
  }
  async describeTable(table: string, signal?: AbortSignal) {
    const name = assertIdentifier(table, '表名')
    const [rows] = await this.queryRows('DESCRIBE `' + name + '`', signal) as unknown as [Array<Record<string, unknown>>, unknown]
    return rows.map((row) => ({
      name: String(row.Field),
      type: String(row.Type ?? ''),
      notNull: String(row.Null ?? '').toUpperCase() === 'NO',
      primaryKey: String(row.Key ?? '').toUpperCase() === 'PRI',
    }))
  }
  async query(sql: string, limit?: number, signal?: AbortSignal) {
    if (limit === undefined || limit <= 0) {
      const [rows] = await this.queryRows(sql, signal) as unknown as [Array<Record<string, unknown>>, unknown]
      return rowsToColumns(rows)
    }
    return await this.withSignalConnection(signal, async (connection, discard) => {
      const coreConnection = (connection as unknown as { connection: { query(querySql: string): any } }).connection
      return await streamMysqlQuery(coreConnection, sql, limit, discard)
    })
  }
  async exec(sql: string, signal?: AbortSignal) {
    const [result] = await this.queryRows(sql, signal) as unknown as [{ affectedRows?: number }, unknown]
    return Number(result?.affectedRows ?? 0)
  }
  async ping(signal?: AbortSignal) {
    await this.queryRows('SELECT 1', signal)
  }
  async close() {
    await this.pool.end()
  }
}

/** PostgreSQL 适配器（pg 连接池）。 */
class PostgresAdapter implements DatabaseAdapter {
  engine = 'postgres' as const
  private pool: pg.Pool
  constructor(connection: SqlConnectionConfig) {
    this.pool = new pg.Pool({
      host: connection.host,
      port: connection.port,
      user: connection.user,
      password: connection.password,
      database: connection.database,
      max: 5,
    })
  }
  private async withSignalClient<T>(signal: AbortSignal | undefined, work: (client: pg.PoolClient, discard: () => void) => Promise<T>): Promise<T> {
    signal?.throwIfAborted()
    // 取连接是连接失败的爆发点（host/端口/凭据错都在这里），转一手免得 message 为空。
    const client = await this.pool.connect().catch((error: unknown) => { throw describeDriverError(error) })
    let destroyed = false
    let rejectAbort: (reason: unknown) => void = () => {}
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    const discard = (): void => {
      if (destroyed) return
      destroyed = true
      client.release(true)
    }
    const onAbort = (): void => {
      discard()
      rejectAbort(abortReason(signal!))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      signal?.throwIfAborted()
      return await Promise.race([work(client, discard), aborted])
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (!destroyed) client.release()
    }
  }
  private async queryWithSignal(query: any, values: unknown[] | undefined, signal?: AbortSignal): Promise<any> {
    const run = async (client: { query(query: any, values?: unknown[]): Promise<any> }): Promise<any> => {
      return values === undefined ? await client.query(query) : await client.query(query, values)
    }
    if (signal === undefined) {
      return await run(this.pool).catch((error: unknown) => { throw describeDriverError(error) })
    }
    return await this.withSignalClient(signal, run)
  }
  async listTables(signal?: AbortSignal) {
    const result = await this.queryWithSignal("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name", undefined, signal)
    return result.rows.map((row: Record<string, unknown>) => String(row.table_name))
  }
  async describeTable(table: string, signal?: AbortSignal) {
    const name = assertIdentifier(table, '表名')
    const result = await this.queryWithSignal(
      `SELECT c.column_name, c.data_type, c.is_nullable,
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
        ORDER BY c.ordinal_position`,
      [name],
      signal,
    )
    return result.rows.map((row: Record<string, unknown>) => ({
      name: String(row.column_name),
      type: String(row.data_type ?? ''),
      notNull: String(row.is_nullable) === 'NO',
      primaryKey: row.is_primary === true,
    }))
  }
  async query(sql: string, limit?: number, signal?: AbortSignal) {
    if (limit === undefined || limit <= 0) {
      const result = await this.queryWithSignal(sql, undefined, signal)
      const rows = result.rows as Array<Record<string, unknown>>
      return rowsToColumns(rows)
    }
    return await this.withSignalClient(signal, async (client, discard) => {
      return await streamPostgresQuery(client, sql, limit, discard)
    })
  }
  async exec(sql: string, signal?: AbortSignal) {
    const result = await this.queryWithSignal(sql, undefined, signal)
    return Number(result.rowCount ?? 0)
  }
  async ping(signal?: AbortSignal) {
    await this.queryWithSignal('SELECT 1', undefined, signal)
  }
  async close() {
    await this.pool.end()
  }
}

/** 按连接配置创建适配器。 */
export function createAdapter(connection: SqlConnectionConfig): DatabaseAdapter {
  // engine 在类型上是联合类型，但配置来自 JSON —— 运行时可能是任何值。
  // 这里不兜底成 postgres：把 "oracle" 当成 postgres 去连，报出来的是 DNS 错误，
  // 完全看不出真正原因是引擎名写错了。
  if (connection.engine !== 'sqlite' && connection.engine !== 'mysql' && connection.engine !== 'postgres') {
    throw new Error('未知引擎 ' + JSON.stringify(connection.engine) + '（可选：sqlite / mysql / postgres）。请用 sql_connection_set 修正。')
  }
  // 不补默认值：缺字段要么是配置被手改坏了，要么是绕过 sql_connection_set 写入的。
  // 报出缺了什么，好过悄悄连到 localhost 或内存库上。
  // 规则与写入侧共用（missingConnectionFields），这里只负责措辞。
  const missing = missingConnectionFields(connection)
  if (missing.length > 0) {
    throw new Error('连接配置缺少必填字段：' + missing.join('、') + '。请用 sql_connection_set 补全。')
  }
  if (connection.engine === 'sqlite') return new SqliteAdapter(connection.file as string)
  if (connection.engine === 'mysql') return new MysqlAdapter(connection)
  return new PostgresAdapter(connection)
}
