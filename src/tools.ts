/**
 * 数据库操作工具：sql_query / sql_exec / sql_schema / sql_stats / sql_health。
 *
 * 设置每次调用现读，工具体内一律走 `loadConfig()`，不留配置副本。
 *
 * @module dsh-sql/tools
 */
import { createAdapter, type DatabaseAdapter } from './adapters.js'
import { type SqlSettings, type SqlConnectionConfig, isReadOnly, requireMaxRows, passwordEnvName, splitConnectionsByEnv, QUERY_TIMEOUT_MS, EXEC_TIMEOUT_MS, STATS_TIMEOUT_MS } from './config.js'
import { countStatements, splitStatements, stripSqlNoise } from './sql-lex.js'
import {
  asRecord,
  compileParameters,
  execTimeoutError,
  executionSignal,
  isAbortError,
  optionalString,
  queryTimeoutError,
  requiredString,
  type SqlToolDefinition,
} from './tool-kit.js'

/** 只读语句关键字白名单。 */
const READ_KEYWORDS = /^(select|pragma|explain|show|describe|desc|with)\b/i

/** 写操作关键字：出在 SELECT/EXPLAIN/WITH 语句里即拒绝。 */
const WRITE_KEYWORDS = /\b(insert|update|delete|replace|merge|drop|alter|create|truncate|call|execute|copy|grant|revoke|attach|detach|vacuum|reindex|refresh|set|reset|begin|commit|rollback|savepoint|release|analyze|load_extension)\b/i

/** 校验只读查询：词法去噪后白名单开头 + 写关键字扫描 + 单语句。 */
export function assertReadQuery(sql: string): string {
  const trimmed = sql.trim()
  const clean = stripSqlNoise(trimmed)
  const first = /^[a-z]+/i.exec(clean.trim())?.[0]?.toLowerCase() ?? ''
  if (!READ_KEYWORDS.test(clean.trim())) {
    throw new Error('sql_query 只接受只读语句（SELECT / PRAGMA / EXPLAIN / SHOW / DESCRIBE / WITH）。写操作请用 sql_exec。')
  }
  const statements = splitStatements(trimmed)
  if (statements.length > 1) throw new Error('sql_query 一次只能执行一条语句（收到 ' + String(statements.length) + ' 条）。请拆成多次调用，或用 UNION / 子查询合并成一条。')
  const single = statements[0]?.trim() ?? ''
  if (first === 'pragma') {
    if (/=/.test(single)) throw new Error('sql_query 不接受带赋值参数的 PRAGMA 写操作（如 PRAGMA journal_mode=WAL），请用 sql_exec。')
  } else if (first === 'show' || first === 'describe' || first === 'desc') {
    // SHOW / DESCRIBE 本身只读，不再扫写关键字（避免误伤 SHOW CREATE TABLE）。
  } else {
    if (/\binto\b/i.test(single)) throw new Error('sql_query 不接受 SELECT INTO（写表或 OUTFILE），请用 sql_exec。')
    if (/\bfor\s+(update|no\s+key\s+update|share|key\s+share)\b/i.test(single)) throw new Error('sql_query 不接受 FOR UPDATE/FOR SHARE 行锁查询，请用 sql_exec。')
    const hit = WRITE_KEYWORDS.exec(single)
    if (hit !== null) {
      throw new Error('检测到写操作关键字 ' + hit[0].toUpperCase() + '，sql_query 只接受只读查询。写操作请用 sql_exec。')
    }
  }
  return trimmed.replace(/;+\s*$/, '').trim()
}

const querySchema = {
  type: 'object',
  properties: {
    connection: { type: 'string' },
    columns: { type: 'array', items: { type: 'string' } },
    rows: { type: 'array', items: { type: 'array', items: {} } },
    rowCount: { type: 'integer' },
    truncated: { type: 'boolean' },
    maxRows: { type: 'integer' },
    format: { type: 'string' },
    formatted: { type: 'string' },
  },
  additionalProperties: true,
}

const execSchema = {
  type: 'object',
  properties: {
    connection: { type: 'string' },
    changes: { type: 'integer' },
  },
  additionalProperties: true,
}

const schemaToolSchema = {
  type: 'object',
  properties: {
    connection: { type: 'string' },
    table: { type: 'string' },
    tableMissing: { type: 'boolean' },
    tables: { type: 'array', items: { type: 'string' } },
    columns: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, type: { type: 'string' }, notNull: { type: 'boolean' }, primaryKey: { type: 'boolean' } },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
}

// ---------- 输出格式与统计辅助 ----------

/** 按引擎给标识符加引号，防止表名破坏 SQL。 */
function quoteIdent(engine: string, name: string): string {
  if (engine === 'mysql') return '`' + name.replace(/`/g, '``') + '`'
  return '"' + name.replace(/"/g, '""') + '"'
}

/** 查询结果转 CSV 文本（RFC 4180 风格转义）。 */
export function toCsv(columns: string[], rows: unknown[][]): string {
  const escape = (cell: unknown): string => {
    if (cell === null || cell === undefined) return ''
    const text = Array.isArray(cell) || typeof cell === 'object' ? JSON.stringify(cell) : String(cell)
    return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
  }
  const lines = [columns.map(escape).join(',')]
  for (const row of rows) lines.push(row.map(escape).join(','))
  return lines.join('\n')
}

/** 人类可读的字节数。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

/** 库体积：SQLite 用页数×页大小；MySQL/PostgreSQL 走系统函数；失败抛错由调用方兜底。 */
async function databaseSize(adapter: DatabaseAdapter, engine: string, database: string | undefined, signal?: AbortSignal): Promise<number> {
  if (engine === 'sqlite') {
    const pageCount = await adapter.query('PRAGMA page_count', 1, signal)
    const pageSize = await adapter.query('PRAGMA page_size', 1, signal)
    return Number(pageCount.rows[0]?.[0] ?? 0) * Number(pageSize.rows[0]?.[0] ?? 0)
  }
  if (engine === 'mysql') {
    // 用配置里的库名，不用 DATABASE() —— 后者依赖会话默认库，没设时返回 NULL 会静默给出空结果。
    // 调用方已保证 mysql 走到这里时 database 一定存在。
    const result = await adapter.query(
      "SELECT SUM(DATA_LENGTH + INDEX_LENGTH) FROM information_schema.tables WHERE TABLE_SCHEMA = '" + String(database).replace(/'/g, "''") + "'",
      1,
      signal,
    )
    return Number(result.rows[0]?.[0] ?? -1)
  }
  const result = await adapter.query('SELECT pg_database_size(current_database())', 1, signal)
  return Number(result.rows[0]?.[0] ?? -1)
}

const statsSchema = {
  type: 'object',
  properties: {
    connection: { type: 'string' },
    engine: { type: 'string' },
    tableCount: { type: 'integer' },
    tables: { type: 'array', items: { type: 'object', additionalProperties: true } },
    tablesError: { type: 'string' },
    sizeBytes: { type: 'integer' },
    sizeError: { type: 'string' },
  },
  additionalProperties: true,
}

const healthSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    connections: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, ok: { type: 'boolean' }, error: { type: 'string' } },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
}

/**
 * 连接定义 + 名字。
 *
 * 只在**适配器层**需要 —— 建池子、缓存、报错信息都要用到名字。
 * 配置层不用它：那里的名字就是连接表的键（见 `ResolvedConnection`）。
 */
type NamedSqlConnection = SqlConnectionConfig & { name: string }

/** 适配器缓存项：适配器 + 建它时用的连接定义指纹。 */
interface CachedAdapter {
  adapter: DatabaseAdapter
  fingerprint: string
}

/** 连接定义指纹：任一影响连接身份的字段变了，缓存就必须失效。 */
function connectionFingerprint(connection: NamedSqlConnection): string {
  return [
    connection.engine,
    connection.host,
    connection.port,
    connection.user,
    connection.password,
    connection.database,
    connection.file,
  ].join('\u0000')
}

/** 构建工具定义；设置**每次调用现读**，adapters 按连接名缓存并按指纹失效。 */
export function buildSqlTools(loadConfig: () => SqlSettings): { tools: SqlToolDefinition[]; adapters: ReadonlyMap<string, DatabaseAdapter> } {
  /**
   * 适配器缓存：按连接名缓存，但每次比对指纹。
   *
   * 不比指纹就会静默出错：连接定义改了（host / 密码 / 库），缓存里还是老池，
   * 查询继续打向老库且不报错。所以是「对不上就重建」，不是「没有才建」。
   */
  const cache = new Map<string, CachedAdapter>()

  /** 对外暴露的适配器视图（供 dispose 关闭）。 */
  const adapters = new Map<string, DatabaseAdapter>()

  /** 解析连接名 → 连接定义（不建适配器）。名字区分大小写。 */
  const resolveConnection = (name: string | undefined): NamedSqlConnection => {
    if (name === undefined) {
      throw new Error('必须显式指定 connection 参数（不再有默认连接）。可用 sql_settings 查看连接清单。')
    }
    const cfg = loadConfig()
    // 连接表以名字为键，直接取即可 —— 不用再遍历找 .name
    const stored = cfg.connections?.[name]
    if (stored === undefined) {
      throw new Error('未找到名为 ' + name + ' 的数据库连接。可用 sql_settings 查看连接清单。')
    }
    /**
     * 密码可走环境变量：**文件里的明文优先，没有才取 `DSH_SQL_PASSWORD_<连接名大写>`**。
     *
     * 合流只在**这里**做（用的时候现算），**绝不写回设置文件** —— 读的 settings 就是写的
     * 那份，一旦在解析层合流，环境变量里的密钥就会被落盘成明文。
     */
    const connection: NamedSqlConnection = { name, ...stored }
    if (connection.password === undefined || connection.password === '') {
      const fromEnv = process.env[passwordEnvName(name)]?.trim() ?? ''
      if (fromEnv !== '') connection.password = fromEnv
    }
    return connection
  }

  /** 连接定义 → 适配器（惰性创建；定义变了则关掉旧的、重建）。 */
  const adapterFor = (connection: NamedSqlConnection): DatabaseAdapter => {
    const fingerprint = connectionFingerprint(connection)
    const cached = cache.get(connection.name)
    if (cached !== undefined) {
      if (cached.fingerprint === fingerprint) return cached.adapter
      // 定义变了：旧池不再代表这个连接，关掉它再建新的。
      // 失败不影响新池可用（旧连接可能已经断了），所以不 await、只报不抛。
      void cached.adapter.close().catch(() => {})
    }
    const adapter = createAdapter(connection)
    cache.set(connection.name, { adapter, fingerprint })
    adapters.set(connection.name, adapter)
    return adapter
  }

  const getAdapter = (name: string | undefined): { adapter: DatabaseAdapter; name: string; connection: NamedSqlConnection } => {
    const connection = resolveConnection(name)
    return { adapter: adapterFor(connection), name: connection.name, connection }
  }

  /** 逐连接并发探活：串行下 N 个不通要等 N 次超时，并发只等最慢的一个。只探在 activeEnv 下可见的连接。 */
  const pingAllConnections = async (signal?: AbortSignal): Promise<Array<Record<string, unknown>>> => {
    const cfg = loadConfig()
    const { available } = splitConnectionsByEnv(cfg)
    return await Promise.all(Object.entries(available).map(async ([name, connection]) => {
      const entry: Record<string, unknown> = { name }
      try {
        await adapterFor({ name, ...connection }).ping(signal)
        entry.ok = true
        entry.error = ''
      } catch (error) {
        signal?.throwIfAborted()
        entry.ok = false
        entry.error = error instanceof Error ? error.message : String(error)
      }
      return entry
    }))
  }

  const sqlQuery: SqlToolDefinition = {
    name: 'sql_query',
    description: '执行只读 SQL 查询（SELECT / PRAGMA / EXPLAIN / SHOW / DESCRIBE / WITH）。一次只能一条语句，会做词法校验拦截写操作。',
    parameters: compileParameters({
      sql: { type: 'string', required: true },
      connection: { type: 'string', required: true, description: '连接名。用 sql_settings 查看可见连接。' },
      format: { type: 'string', description: '输出格式：table（默认表格）/ csv / json。csv 与 json 会额外返回 formatted 文本，便于落盘或转存。' },
    }),
    output: {
      schema: querySchema,
      render: (_args, value) => {
        const rec = asRecord(value)
        if (typeof rec.formatted === 'string' && rec.formatted !== '') {
          const preview = rec.formatted.length > 4000 ? rec.formatted.slice(0, 4000) + '\n…（预览已截断）' : rec.formatted
          return [{ type: 'text', text: '查询返回 ' + rec.rowCount + ' 行（' + String(rec.format) + ' 格式）：\n' + preview }]
        }
        const rows = Array.isArray(rec.rows) ? rec.rows : []
        const lines = ['查询返回 ' + rec.rowCount + ' 行' + (rec.truncated === true ? '（截断到 ' + rec.maxRows + ' 行）' : '') + '，列：' + (Array.isArray(rec.columns) ? rec.columns.join(', ') : '')]
        for (const row of rows.slice(0, 20)) {
          lines.push('- ' + (Array.isArray(row) ? row.map((cell) => String(cell)).join(' | ') : String(row)))
        }
        if (rows.length > 20) lines.push('…仅展示前 20 行')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs: unknown, exec: unknown) {
      const args = asRecord(rawArgs)
      const sql = assertReadQuery(requiredString(args, 'sql', 'SQL 语句'))
      const maxRows = requireMaxRows(loadConfig())
      const { adapter, name } = getAdapter(optionalString(args, 'connection'))
      let result
      try {
        result = await adapter.query(sql, maxRows + 1, executionSignal(exec))
      } catch (error) {
        // 超时按「撤销用户的取消」处理：只有非取消的中止才换成指导性文案。
        if (isAbortError(error) && executionSignal(exec)?.aborted !== true) {
          throw queryTimeoutError(QUERY_TIMEOUT_MS / 1000, sql)
        }
        throw error
      }
      const total = result.rows.length
      const rows = result.rows.slice(0, maxRows)
      const format = optionalString(args, 'format')?.toLowerCase() ?? 'table'
      if (format !== 'table' && format !== 'csv' && format !== 'json') {
        throw new Error('format 只支持 table / csv / json，收到 ' + JSON.stringify(format) + '。')
      }
      const base = {
        connection: name,
        columns: result.columns,
        rows,
        rowCount: total,
        truncated: total > maxRows,
        maxRows,
      }
      if (format === 'csv') return { ...base, format, formatted: toCsv(result.columns, rows) }
      if (format === 'json') {
        const objects = rows.map((row) => Object.fromEntries(result.columns.map((column, i) => [column, row[i]])))
        return { ...base, format, formatted: JSON.stringify(objects, null, 2) }
      }
      return base
    },
    timeoutMs: QUERY_TIMEOUT_MS,
  }

  const sqlExec: SqlToolDefinition = {
    name: 'sql_exec',
    description: '执行写操作或 DDL（INSERT / UPDATE / DELETE / CREATE / ALTER / DROP 等）。一次只能一条语句。受该连接的 readOnly 开关保护，返回影响行数。',
    parameters: compileParameters({
      sql: { type: 'string', required: true },
      connection: { type: 'string', required: true, description: '连接名。用 sql_settings 查看可见连接。' },
    }),
    output: {
      schema: execSchema,
      render: (_args, value) => {
        const rec = asRecord(value)
        return [{ type: 'text', text: '执行完成（' + rec.connection + '）：影响 ' + rec.changes + ' 行。' }]
      },
    },
    async execute(rawArgs: unknown, exec: unknown) {
      const args = asRecord(rawArgs)
      const sql = requiredString(args, 'sql', 'SQL 语句')
      // 驱动层本就不接受多语句。提前拦下是为了给出「请拆成多次调用」这种能照做的报错，
      // 否则 AI 拿到的是驱动的语法错误，会以为 SQL 本身写错了。
      const count = countStatements(sql)
      if (count > 1) {
        throw new Error('sql_exec 一次只能执行一条语句（收到 ' + String(count) + ' 条）。请拆成多次调用。')
      }
      // 先解析定义并判 readOnly，再建适配器 —— 只读连接不该被建出一个用不上的连接池。
      const connection = resolveConnection(optionalString(args, 'connection'))
      if (isReadOnly(connection)) {
        throw new Error('连接 ' + connection.name + ' 的 readOnly=true，sql_exec 已被禁用。需要写操作请把该连接的 readOnly 改为 false（用 sql_connection_set，或直接编辑配置文件）。')
      }
      let changes: number
      try {
        changes = await adapterFor(connection).exec(sql, executionSignal(exec))
      } catch (error) {
        if (isAbortError(error) && executionSignal(exec)?.aborted !== true) {
          throw execTimeoutError(EXEC_TIMEOUT_MS / 1000, sql)
        }
        throw error
      }
      return { connection: connection.name, changes }
    },
    timeoutMs: EXEC_TIMEOUT_MS,
  }

  const sqlSchema: SqlToolDefinition = {
    name: 'sql_schema',
    description: '查看数据库结构：返回表清单，或指定 table 时返回该表的列信息（名称/类型/非空/主键）。',
    parameters: compileParameters({
      table: { type: 'string' },
      connection: { type: 'string', required: true, description: '连接名。用 sql_settings 查看可见连接。' },
    }),
    output: {
      schema: schemaToolSchema,
      render: (_args, value) => {
        const rec = asRecord(value)
        const columns = Array.isArray(rec.columns) ? rec.columns : []
        if (columns.length > 0) {
          const lines = ['表 ' + rec.table + ' 的列：']
          for (const item of columns) {
            const c = asRecord(item)
            lines.push('- ' + c.name + ' ' + c.type + (c.primaryKey === true ? '（主键）' : '') + (c.notNull === true ? '（非空）' : ''))
          }
          return [{ type: 'text', text: lines.join('\n') }]
        }
        // 指定了表名却查不到列 —— 是「这张表不存在」（或没权限），
        // 不能说成「库里有 0 张表」，那会让 AI 以为库是空的。
        if (rec.tableMissing === true) {
          const known = Array.isArray(rec.tables) ? rec.tables : []
          const hint = known.length > 0 ? '可用表（前 20 张）：' + known.slice(0, 20).join(', ') : '该连接下没有可见的表。'
          return [{ type: 'text', text: '表 ' + rec.table + ' 不存在，或当前用户没有权限查看它。' + hint }]
        }
        const tables = Array.isArray(rec.tables) ? rec.tables : []
        return [{ type: 'text', text: '共 ' + tables.length + ' 张表：' + tables.join(', ') }]
      },
    },
    async execute(rawArgs: unknown, exec: unknown) {
      const args = asRecord(rawArgs)
      const { adapter, name } = getAdapter(optionalString(args, 'connection'))
      const table = optionalString(args, 'table')
      const signal = executionSignal(exec)
      if (table !== undefined) {
        const columns = await adapter.describeTable(table, signal)
        // 查不到列时把全部表名一并带上，方便确认是表名写错还是真没权限。
        const tables = columns.length === 0 ? await adapter.listTables(signal) : []
        return { connection: name, table, columns, tables, tableMissing: columns.length === 0 }
      }
      const tables = await adapter.listTables(signal)
      return { connection: name, tables, columns: [] }
    },
    timeoutMs: 30000,
  }

  const sqlStats: SqlToolDefinition = {
    name: 'sql_stats',
    description: '数据库概览统计：表数量、每张表的行数、库体积（SQLite 按页计算，MySQL/PostgreSQL 走系统表）。',
    parameters: compileParameters({
      connection: { type: 'string', required: true, description: '连接名。用 sql_settings 查看可见连接。' },
    }),
    output: {
      schema: statsSchema,
      render: (_args, value) => {
        const rec = asRecord(value)
        const tables = Array.isArray(rec.tables) ? rec.tables : []
        // 计数用 tableCount（execute 里已剔除失败项），不能拿 tables.length 当表数。
        const count = typeof rec.tableCount === 'number' ? rec.tableCount : tables.length
        const size = typeof rec.sizeBytes === 'number' && rec.sizeBytes >= 0 ? '，库体积 ' + formatBytes(rec.sizeBytes) : ''
        const lines = ['连接 ' + rec.connection + '（' + rec.engine + '）：共 ' + count + ' 张表' + size + '。']
        if (typeof rec.tablesError === 'string' && rec.tablesError !== '') lines.push('⚠ 表清单不可用：' + rec.tablesError)
        if (typeof rec.sizeError === 'string' && rec.sizeError !== '') lines.push('⚠ 库体积不可用：' + rec.sizeError)
        for (const item of tables.slice(0, 30)) {
          const t = asRecord(item)
          lines.push('- ' + t.name + '：' + (typeof t.rowCount === 'number' ? t.rowCount + ' 行' : '行数未知' + (t.error ? '（' + t.error + '）' : '')))
        }
        if (tables.length > 30) lines.push('…仅展示前 30 张表')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs: unknown, exec: unknown) {
      const args = asRecord(rawArgs)
      const { adapter, name, connection } = getAdapter(optionalString(args, 'connection'))
      const engine = adapter.engine
      const signal = executionSignal(exec)
      // MySQL 的库体积与表清单都依赖「当前库」，而 database 是可选的。
      // 不设默认库时不猜也不绕（DATABASE() 会返回 NULL，静默给出空结果），如实标记不可用。
      const noDefaultDb = engine === 'mysql' && connection.database === undefined
      let sizeBytes = -1
      let sizeError = ''
      if (noDefaultDb) {
        sizeError = '该连接未设置 database（默认库），库体积不可用。'
      } else {
        try {
          sizeBytes = await databaseSize(adapter, engine, connection.database, signal)
        } catch (error) {
          signal?.throwIfAborted()
          sizeBytes = -1
          sizeError = error instanceof Error ? error.message : String(error)
        }
      }
      const tables: Array<Record<string, unknown>> = []
      let tablesError = ''
      if (noDefaultDb) {
        tablesError = '该连接未设置 database（默认库），表清单不可用。'
      } else if (engine === 'mysql' || engine === 'postgres') {
        try {
          // 这里不走 DATABASE()，用连接配置里的库名 —— 语义明确，不依赖会话状态。
          const sql = engine === 'mysql'
            ? "SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.tables WHERE TABLE_SCHEMA = '" + String(connection.database).replace(/'/g, "''") + "'"
            : 'SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname'
          const result = await adapter.query(sql, undefined, signal)
          for (const row of result.rows) {
            tables.push({ name: String(row[0]), rowCount: typeof row[1] === 'number' ? row[1] : Number(row[1] ?? 0) })
          }
        } catch (error) {
          signal?.throwIfAborted()
          tablesError = error instanceof Error ? error.message : String(error)
        }
      } else {
        const names = await adapter.listTables(signal)
        for (const table of names) {
          try {
            const result = await adapter.query('SELECT COUNT(*) FROM ' + quoteIdent(engine, table), 1, signal)
            tables.push({ name: table, rowCount: Number(result.rows[0]?.[0] ?? 0) })
          } catch (error) {
            signal?.throwIfAborted()
            tables.push({ name: table, error: error instanceof Error ? error.message : String(error) })
          }
        }
      }
      return { connection: name, engine, tableCount: tables.length, tables, tablesError, sizeBytes, sizeError }
    },
    timeoutMs: STATS_TIMEOUT_MS,
  }

  const sqlHealth: SqlToolDefinition = {
    name: 'sql_health',
    description: '逐连接做连通性测试（SELECT 1），返回每个连接通不通。只探在 activeEnv 下可见的连接。',
    parameters: compileParameters({}),
    output: {
      schema: healthSchema,
      render: (_args, value) => {
        const rec = asRecord(value)
        const connections = Array.isArray(rec.connections) ? rec.connections : []
        const bad = connections.filter((c) => asRecord(c).ok !== true)
        if (connections.length === 0) {
          return [{ type: 'text', text: 'dsh-sql 探活：activeEnv 下没有可见的连接。用 sql_settings 看配置、sql_connection_set 添加。' }]
        }
        const lines = ['dsh-sql 探活' + (bad.length === 0 ? '：全部连接正常。' : '：' + bad.length + ' / ' + connections.length + ' 个连接异常。')]
        for (const item of connections) {
          const c = asRecord(item)
          lines.push('- ' + c.name + (c.ok === true ? ' ✅' : ' ❌ ' + String(c.error ?? '')))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(_rawArgs: unknown, exec: unknown) {
      const connections = await pingAllConnections(executionSignal(exec))
      const bad = connections.filter((c) => c.ok !== true)
      return { ok: bad.length === 0, connections }
    },
    timeoutMs: 30000,
  }

  return { tools: [sqlQuery, sqlExec, sqlSchema, sqlStats, sqlHealth], adapters }
}
