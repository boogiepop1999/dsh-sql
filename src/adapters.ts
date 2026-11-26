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

/**
 * 连接层的健康状态。
 *
 * `broken` = 这个适配器的底层连接已经断了（服务端关停、网络中断、被中间设备掐断……）。
 * 一旦置上就**不会自己恢复**：插件不自动重连、不自动重试，也不在下次调用时重建连接池。
 * 只有连接定义变了（`tools.ts` 的指纹失效）或插件重启才会换上新池。
 */
export interface ConnectionHealth {
  state: 'ok' | 'broken'
  /** broken 的原因（驱动原始错误的 message，可能为空串）。 */
  reason: string
  /** broken 的时刻（ISO 字符串）。 */
  at: string
}

const HEALTHY: ConnectionHealth = { state: 'ok', reason: '', at: '' }

/**
 * 判断一个错误是否属于「连接已经不可用」。
 *
 * **只认明确的连接类信号，不拿 message 做子串匹配** —— 跟 `isAbortError` 同一个道理：
 * `column "connection" does not exist` 这种普通 SQL 错误要是被误判成断连，
 * 会把一个只是写错列名的连接永久标死，用户改 SQL 也救不回来。
 */
export function isConnectionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string') return false
  // Node 网络层
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ECONNABORTED') return true
  if (code === 'ETIMEDOUT' || code === 'EPIPE' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') return true
  // PostgreSQL：08 类是连接异常；57P01/57P02/57P03 是服务端关停/崩溃恢复/正在启动
  if (/^08/.test(code)) return true
  if (code === '57P01' || code === '57P02' || code === '57P03') return true
  // mysql2
  if (code === 'PROTOCOL_CONNECTION_LOST' || code === 'PROTOCOL_SEQUENCE_TIMEOUT' || code === 'PROTOCOL_ENQUEUE_HANDSHAKE_TWICE') return true
  if (code === 'ER_SERVER_SHUTDOWN' || code === 'ER_CONNECTION_COUNT_ERROR' || code === 'HANDSHAKE_SSL_ERROR') return true
  return false
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' && code !== '' ? error.message + '（code=' + code + '）' : error.message
  }
  return String(error)
}

/**
 * 连接状态的可变持有者：mysql / postgres 两个适配器共用。
 *
 * sqlite 不接 error 事件（node:sqlite 是同步 API，错误直接从调用里抛），
 * 但它同样实现 `health()` —— 统一接口，工具层不必分支。
 */
class HealthTracker {
  private current: ConnectionHealth = HEALTHY
  get(): ConnectionHealth {
    return this.current
  }
  markBroken(error: unknown): void {
    // 第一条原因最有价值（后续往往只是「已关闭」的连带错误），保留它。
    if (this.current.state === 'broken') return
    this.current = { state: 'broken', reason: errorMessage(error), at: new Date().toISOString() }
  }
  markOk(): void {
    this.current = HEALTHY
  }
}

/**
 * 统一的「连接异常」错误。
 *
 * `message` 就是给模型看的那段文案：**必须同时说清「这是连接异常」和「不要重试」**，
 * 否则模型会自己脑补一轮重试，正好撞上用户明确不要的行为。
 */
export class ConnectionBrokenError extends Error {
  readonly connection: string
  readonly reason: string
  readonly at: string
  constructor(connection: string, reason: string, at: string) {
    super(
      '数据库连接异常，本次调用失败。\n'
      + '连接：' + connection + '\n'
      + '原因：' + (reason !== '' ? reason : '连接已断开（驱动未给出具体原因）') + '\n'
      + '时间：' + (at !== '' ? at : '未知') + '\n'
      + '状态：该连接已被标记为不可用，数据库服务可能已停止，不要重试工具！\n'
      + '   请先让用户确认数据库与网络恢复，再发起 sql_health（reset=true，connection=该连接）触发一次重建。',
    )
    this.name = 'ConnectionBrokenError'
    this.connection = connection
    this.reason = reason
    this.at = at
  }
}

/** 统一适配器接口。 */
export interface DatabaseAdapter {
  engine: 'sqlite' | 'mysql' | 'postgres'
  /** 当前连接健康状态；broken 之后适配器不可再用（工具层据此拒绝调用，不重连）。 */
  health(): ConnectionHealth
  /**
   * 清掉 broken 标记，回到 ok。
   *
   * **只给「显式重连」用**（`sql_health` 的 `reset` 参数）：调用方先关掉旧适配器、
   * 再建一个新的并调它。插件自己**不会**在任何自动路径上调这个方法 ——
   * 不然就成了「偷偷重连」，跟「数据库挂了就别自动连」的要求相悖。
   */
  markHealthy(): void
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
    const parts: string[] = []
    let blank = 0
    for (const item of error.errors) {
      const converted = describeDriverError(item)
      // isBlankDetail 标出的是「掏不出信息」的兜底文案，不是真内容 —— 平铺时只计数，不重复贴出来。
      if (isBlankDetail(converted)) blank += 1
      else parts.push(converted.message)
    }
    if (blank > 0) parts.push(String(blank) + ' 个子错误未提供信息')
    return new Error(parts.join('；'), { cause: error })
  }
  if (error instanceof Error) {
    if (error.message !== '') return error
    // message 为空时按 code / syscall 拼一个。**不拿 name 当内容** —— 单独一个
    // 「Error」或「AggregateError」等于没报，反而让上层以为拿到了有用信息。
    const code = (error as { code?: unknown }).code
    const syscall = (error as { syscall?: unknown }).syscall
    const detail = [code, syscall].filter((part) => typeof part === 'string' && part !== '').join(' ')
    return detail !== ''
      ? new Error(error.name + ' ' + detail, { cause: error })
      : blankDetail(error.name)
  }
  return new Error(String(error))
}

/** 「掏不出信息」的兜底错误：带 `blankDetail` 标记，便于平铺时识别而不必猜文案。 */
interface BlankDetail extends Error {
  blankDetail: true
}
function blankDetail(name: string): BlankDetail {
  const error = new Error('未知错误（' + name + ' 未给出任何信息）') as BlankDetail
  error.blankDetail = true
  return error
}
function isBlankDetail(error: Error): error is BlankDetail {
  return (error as Partial<BlankDetail>).blankDetail === true
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
  private readonly healthTracker = new HealthTracker()
  private db: DatabaseSync
  constructor(file: string) {
    this.db = new DatabaseSync(file === ':memory:' ? ':memory:' : file)
    this.db.exec('PRAGMA busy_timeout = 5000')
  }
  health(): ConnectionHealth {
    return this.healthTracker.get()
  }
  markHealthy(): void {
    this.healthTracker.markOk()
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

/**
 * 把配置里的 `port` 字符串转成驱动要的端口号。
 *
 * 配置里存的是**字符串**（设置页框里输入的原样值，见 config-schema.ts），
 * 两个驱动都要数字。
 *
 *   `''` / 缺省  → `undefined` —— **交给驱动兜默认端口**（mysql2 → 3306、
 *                  pg → 5432）。实测过：空值进去，驱动自己就走约定端口，
 *                  所以这里不需要自己写一份"引擎 → 默认端口"的表。
 *   别的         → `Number()`。**转不出来时原样交给驱动报错**（不在这里拦）：
 *                  两个驱动的报错都带得上"端口"字样，而在这里拦就得多写一份
 *                  规则、还得决定用什么措辞，不如让驱动说。
 */
function driverPort(port: string | undefined): number | undefined {
  if (port === undefined || port === '') return undefined
  return Number(port)
}

/** MySQL 适配器（mysql2 连接池）。 */
class MysqlAdapter implements DatabaseAdapter {
  engine = 'mysql' as const
  private pool: mysql.Pool
  private readonly healthTracker = new HealthTracker()
  constructor(connection: SqlConnectionConfig) {
    this.pool = mysql.createPool({
      host: connection.host,
      port: driverPort(connection.port),
      user: connection.user,
      password: connection.password,
      database: connection.database,
      connectionLimit: 5,
      enableKeepAlive: true,
    })
    // mysql2 的池也会把空闲连接的断连错误 emit 出来；不接就冒到进程（同 PG 那次崩溃）。
    // 只登记状态，不重连、不重试。
    ;(this.pool as unknown as { on(event: 'error', listener: (error: unknown) => void): void })
      .on('error', (error: unknown) => {
        if (isConnectionError(error)) this.healthTracker.markBroken(error)
      })
  }
  health(): ConnectionHealth {
    return this.healthTracker.get()
  }
  markHealthy(): void {
    this.healthTracker.markOk()
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
    } catch (error) {
      // 连接断了 → 登记 broken（工具层下一次调用据此直接报错，不重连）。
      // 调用方仍然拿到这个错误（各工具统一渲染成「连接异常，请勿重试」）。
      if (isConnectionError(error)) this.healthTracker.markBroken(error)
      throw error
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (!destroyed) connection.release()
    }
  }
  private async queryRows(sql: string, signal?: AbortSignal): Promise<any> {
    if (signal === undefined) {
      return await this.pool.query(sql).catch((error: unknown) => {
        if (isConnectionError(error)) this.healthTracker.markBroken(error)
        throw describeDriverError(error)
      })
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
  private readonly healthTracker = new HealthTracker()
  constructor(connection: SqlConnectionConfig) {
    this.pool = new pg.Pool({
      host: connection.host,
      port: driverPort(connection.port),
      user: connection.user,
      password: connection.password,
      database: connection.database,
      max: 5,
    })
    // ⚠ **这一行是防宿主崩溃的关键**。
    //
    //   pg 的 Client 在连接出错时会 `this.emit('error', err)`（见 pg/lib/client.js 的
    //   `_handleErrorWhileConnecting` / `_handleErrorEvent`）。Node 里没人监听的 'error'
    //   事件会被当成未捕获异常直接抛到进程 —— 也就是那张崩溃截图：
    //
    //     dsh: fatal uncaught exception: Error: Connection terminated unexpectedly
    //       at Connection.<anonymous> (pg/lib/connection.js:73)
    //
    //   空闲连接被服务端/中间设备断开时正好走这条路：那一刻没有任何查询在等它，
    //   于是没人接这个 error，整个 dsh host 陪葬。
    //
    //   挂上监听后，这个错误只是被「收下」并登记成 broken，进程不受影响。
    //   顺带好处：池级 error 被消费后，pg 不会再把这条死连接放回可用列表。
    this.pool.on('error', (error: Error) => {
      this.healthTracker.markBroken(error)
    })
  }
  health(): ConnectionHealth {
    return this.healthTracker.get()
  }
  markHealthy(): void {
    this.healthTracker.markOk()
  }
  private async withSignalClient<T>(signal: AbortSignal | undefined, work: (client: pg.PoolClient, discard: () => void) => Promise<T>): Promise<T> {
    signal?.throwIfAborted()
    // 取连接是连接失败的爆发点（host/端口/凭据错都在这里），转一手免得 message 为空。
    const client = await this.pool.connect().catch((error: unknown) => {
      if (isConnectionError(error)) this.healthTracker.markBroken(error)
      throw describeDriverError(error)
    })
    let destroyed = false
    let rejectAbort: (reason: unknown) => void = () => {}
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    const discard = (): void => {
      if (destroyed) return
      destroyed = true
      client.release(true)
    }
    // 插件自己手里的这条 client 也要接住 error：它断了时 pg 同样会 emit（见池上那段注释），
    // 而这个 client 已经不在池的监听范围内。只登记状态，不重连。
    const onClientError = (error: unknown): void => {
      this.healthTracker.markBroken(error)
    }
    client.on('error', onClientError)
    const onAbort = (): void => {
      discard()
      rejectAbort(abortReason(signal!))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      signal?.throwIfAborted()
      return await Promise.race([work(client, discard), aborted])
    } catch (error) {
      // 连接断了 → 登记 broken；调用方仍拿到这个错误（工具层渲染成「连接异常，请勿重试」）。
      if (isConnectionError(error)) this.healthTracker.markBroken(error)
      throw error
    } finally {
      signal?.removeEventListener('abort', onAbort)
      client.removeListener('error', onClientError)
      if (!destroyed) client.release()
    }
  }
  private async queryWithSignal(query: any, values: unknown[] | undefined, signal?: AbortSignal): Promise<any> {
    const run = async (client: { query(query: any, values?: unknown[]): Promise<any> }): Promise<any> => {
      return values === undefined ? await client.query(query) : await client.query(query, values)
    }
    if (signal === undefined) {
      return await run(this.pool).catch((error: unknown) => {
        if (isConnectionError(error)) this.healthTracker.markBroken(error)
        throw describeDriverError(error)
      })
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
    throw new Error('未知引擎 ' + JSON.stringify(connection.engine) + '（可选：sqlite / mysql / postgres）。请在插件设置页修正。')
  }
  // 不补默认值：缺字段要么是配置被手改坏了，要么是绕过设置页写进去的。
  // 报出缺了什么，好过悄悄连到 localhost 或内存库上。
  // 规则与建连侧共用（missingConnectionFields），这里只负责措辞。
  const missing = missingConnectionFields(connection)
  if (missing.length > 0) {
    throw new Error('连接配置缺少必填字段：' + missing.join('、') + '。请在插件设置页补全。')
  }
  if (connection.engine === 'sqlite') return new SqliteAdapter(connection.file as string)
  if (connection.engine === 'mysql') return new MysqlAdapter(connection)
  return new PostgresAdapter(connection)
}
