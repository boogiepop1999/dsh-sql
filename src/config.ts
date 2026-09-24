/**
 * dsh-sql 设置解析与校验：类型即 `$DSH_HOME/sql/settings.json` 的形状。
 *
 * @module dsh-sql/config
 */

/**
 * 单个数据库连接的参数。
 *
 * **不含 name** —— 名字是 connections 字典的键（见 `SqlSettings`）。
 */
export interface SqlConnectionConfig {
  engine: 'sqlite' | 'mysql' | 'postgres'
  file?: string
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
  /**
   * 该连接是否禁用写操作。
   *
   * **缺省 / 非法值一律按 `true`（只读）处理** —— 写权限是危险的那一侧，
   * 认不出来就别放行。要开写必须**显式写 `false`**。
   */
  readOnly?: boolean
  /** 所属环境（如 qa / prod）；留空表示不限定环境（任何环境都可用）。 */
  env?: string
  /** 连接用途说明（展示用，最长 100 字符）。 */
  description?: string
}

/**
 * 设置文件的形状 —— **也是运行时的形状**（读写同一份，没有第二套解析结果）。
 *
 * 字段都是可选的：这是**文件里可能是什么样**的声明。经 `normalizeSettings` 读进来的
 * 那份一定带 `connections`（缺失会兜成 `{}`），但 `activeEnv` / `environments` / `maxRows`
 * 仍可能缺席 —— 它们各有各的默认/校验点，见 `isReadOnly` / `requireMaxRows`。
 */
export interface SqlSettings {
  /** 当前环境名；空串 = 未设置。必须在 environments 里。 */
  activeEnv?: string
  /** 环境清单（去重、非空字符串）。 */
  environments?: string[]
  /** 连接表：键即连接名（区分大小写）。 */
  connections?: Record<string, SqlConnectionConfig>
  maxRows?: number
}

const ENGINES = ['sqlite', 'mysql', 'postgres'] as const

/**
 * 单次查询超时。**代码常量，不可配置** —— Harness 的 `timeoutMs` 在工具注册时求值一次，
 * 做成配置项就得重启才生效，与「改配置立即生效」冲突，因此定死。
 *
 * 30 秒是**护栏**不是「够用的上限」：走得通索引的查询秒级就回，走不通的 60 秒也回不来。
 * 早失败能让 agent 更快改换查法，而不是白等。
 */
export const QUERY_TIMEOUT_MS = 30000

/**
 * 单次写操作超时。比查询更该早掐：正常写操作都是秒级，超过 30 秒的多半在等锁或动大表，
 * 让 agent 干等没意义，且等得越久越可能把一个大操作放跑完。
 */
export const EXEC_TIMEOUT_MS = 30000

/**
 * `sql_stats` 专用超时 —— 它逐表跑 `COUNT(*)`，表一多就慢，
 * 跟「跑一条业务查询」不是一回事，因此单独放宽。
 *
 * 2 分钟够用：再大的库该按 schema 分批查，而不是靠调大超时硬扛。
 */
export const STATS_TIMEOUT_MS = 120000

/** 连接密码环境变量名：DSH_SQL_PASSWORD_<NAME 大写>。 */
export function passwordEnvName(name: string): string {
  return 'DSH_SQL_PASSWORD_' + name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
}

/** description 字段最大长度；超长由 sql_connection_set 报错拦下（读取侧不校验也不截断）。 */
export const DESCRIPTION_MAX_LENGTH = 100

/**
 * readOnly 的**生效值**：只有显式 `false` 才可写，其余一律只读。
 *
 * fail-safe 的判断点就在这里 —— 认不出来的值（`"true"` / `1` / `"false"` / 缺省）
 * 全按只读。写权限是危险的那一侧，宁可挡住也不能悄悄给库开写权限。
 *
 * **不在解析层兜底**（不像 `readOnly` 曾经那样把结果写回设置对象）：配置文件里写的是什么
 * 就是什么，只在用的时候判。这样"读的"和"写的"永远是同一份，也不会因为读一次就把
 * `readOnly: true` 落到每个连接上。
 *
 * 值非法时 `sql_settings` 会把它列进「问题」——那里直接看原值判（见 `readOnlyProblem`）。
 */
export function isReadOnly(connection: SqlConnectionConfig | undefined): boolean {
  return connection?.readOnly !== false
}

/**
 * `readOnly` 写了非法值吗？（不是 `true` / `false` / 缺省时返回那个原值，否则 `undefined`）
 *
 * 只用于**展示**：`sql_settings` 把它摆到「问题」一节，免得"值写错了"这件事没人知道、
 * 只表现为"莫名其妙写不了"。缺省不算非法 —— `isReadOnly` 会把缺省当只读，那是有意的。
 */
export function invalidReadOnly(connection: SqlConnectionConfig | undefined): unknown {
  const value = connection?.readOnly
  if (value === undefined || typeof value === 'boolean') return undefined
  return value
}

/**
 * `maxRows` 的生效值：**必须是 1~10000 的整数**，缺省 1000。
 *
 * 不合规直接报错，不静默夹取 —— 夹取会让人以为"设了 50000"，实际跑的是 10000，
 * 而且一声不吭。要改就该知道自己在改什么。
 *
 * 只收真正的 number：`Number('500')` / `Number(true)` 都能算出数字，放过去会让
 * `maxRows: true` 悄悄变成 1（以为"开着"，实际把行数上限压到 1）。
 */
export function requireMaxRows(settings: SqlSettings): number {
  const raw = settings.maxRows
  if (raw === undefined) return 1000
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 10000) {
    throw new Error(
      'maxRows 必须是 1~10000 之间的整数，收到 ' + JSON.stringify(raw) +
      '（用 sql_config_set 改，或直接编辑配置文件）',
    )
  }
  return raw
}

/** 校验表名/标识符，防注入到 schema 语句。 */
export function assertIdentifier(name: string, label: string): string {
  const trimmed = name.trim()
  if (!/^[A-Za-z0-9_$]+$/.test(trimmed)) {
    throw new Error(label + ' 非法（只允许字母/数字/下划线/美元符）：' + name)
  }
  return trimmed
}

/**
 * 新建连接时该引擎适用的字段清单 —— 用于把 key **补建出来**（值留空）。
 *
 * 与 `missingConnectionFields` 是两条不同的规则，别混：
 *   - `missingConnectionFields`：**值**必须有效（host 不能是空串）—— 新建 / 编辑 / 建连共用，
 *     这是**校验**，不通过就报错。
 *   - 本函数：**key** 要落全 —— 只在**新建**时用，且**只负责补空、不负责报错**。
 *     目的是让配置一次落全，手改文件时"这个连接有哪些字段"一目了然，不用去猜某个键
 *     是"没配"还是"漏配"（undefined 与空串在读取侧往往等价，但给人的信息完全不同）。
 *
 * 只列该引擎用得到的字段：sqlite 没有 host/port/…，mysql 没有 file。
 */
export function connectionFieldKeys(engine: SqlConnectionConfig['engine']): string[] {
  return engine === 'sqlite'
    ? ['file', 'env', 'description', 'readOnly']
    : ['host', 'port', 'user', 'password', 'database', 'env', 'description', 'readOnly']
}

/**
 * 补齐新建连接缺失的字段 key（**值留空**：字符串空串、readOnly 用 `true`）。
 *
 * readOnly 补 `true` 而不是 false —— 与解析侧的 fail-safe 一致：不显式声明就按只读，
 * 要开写必须自己写 `false`。新连接默认只读，想写的人才去改，比"默认可写、忘了关"安全。
 *
 * 就地修改传入对象并返回它。`port` 特殊：它没有"空"可言（0 不是合法端口），
 * 所以**不补** —— 缺了就该被 `missingConnectionFields` 拦下，而不是造个假值蒙混过去。
 */
export function fillConnectionKeys(connection: SqlConnectionConfig): SqlConnectionConfig {
  const target = connection as unknown as Record<string, unknown>
  for (const key of connectionFieldKeys(connection.engine)) {
    if (target[key] !== undefined) continue
    if (key === 'port') continue
    target[key] = key === 'readOnly' ? true : ''
  }
  return connection
}

/**
 * 列出连接缺少的必填字段（空数组 = 齐了）。
 *
 * **写入侧（`sql_connection_set`）与建连侧（`createAdapter`）共用这一份规则** ——
 * 两处各写一遍必然漂移（曾经就出现过报错顺序不一致）。措辞由调用方拼，规则只此一处。
 *
 * 不查 `user` / `password`：有的库确实不要密码。也不查 mysql 的 `database`：
 * 不指定默认库时可用全限定名查询。
 */
export function missingConnectionFields(connection: SqlConnectionConfig): string[] {
  const missing: string[] = []
  if (connection.engine === 'sqlite') {
    if (connection.file === undefined || connection.file === '') missing.push('file')
    return missing
  }
  if (connection.host === undefined || connection.host === '') missing.push('host')
  if (connection.port === undefined) missing.push('port')
  if (connection.engine === 'postgres' && (connection.database === undefined || connection.database === '')) {
    missing.push('database')
  }
  return missing
}

/**
 * 按 activeEnv 切分连接：能用的 / 不能用的。
 *
 * 匹配规则只有一条：`env` 为空的连接**任何环境都算可用**，否则要求 `env === activeEnv`。
 * 没匹配上的一律算「其它环境」。
 *
 * 两侧都返回**连接表**（键即名字）而不是数组 —— 名字本来就在键上，摊平成数组反而
 * 让每个消费点都得靠 `.name` 反查。
 *
 * `activeEnv` 为空时没有连接能靠「环境名相同」匹配，因此只有 `env` 为空的那批可用 —— 与设了环境时同一套规则。
 */
export function splitConnectionsByEnv(settings: SqlSettings): {
  available: Record<string, SqlConnectionConfig>
  excluded: Record<string, SqlConnectionConfig>
} {
  const activeEnv = typeof settings.activeEnv === 'string' ? settings.activeEnv.trim() : ''
  const available: Record<string, SqlConnectionConfig> = {}
  const excluded: Record<string, SqlConnectionConfig> = {}
  for (const [name, connection] of Object.entries(settings.connections ?? {})) {
    // `env` 空白（或没写）都算"不限环境"：空白串不是合法环境名，当成"属于名字是空白的
    // 环境"会让这条连接在**任何**环境下都匹配不上，凭空消失。
    const env = typeof connection?.env === 'string' ? connection.env.trim() : ''
    if (env === '') available[name] = connection
    else if (env === activeEnv) available[name] = connection
    else excluded[name] = connection
  }
  return { available, excluded }
}
