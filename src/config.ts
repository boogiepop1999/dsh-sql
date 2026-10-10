/**
 * dsh-sql 配置的类型、形状约束与跨字段规则。
 *
 * 值由宿主的 settings 服务托管（profile 的 `cordis.patch.yml`），本模块只描述
 * **它长什么样、哪些组合不合法**，不含 I/O。
 *
 * @module dsh-sql/config
 */

/**
 * 单个数据库连接的参数。
 *
 * `name` 是**显示名 / 业务名** —— 工具调用的 `connection` 参数与设置页里看到的就是它。
 * 条目在 `connections` 字典里的**键是随机 id**（见 `SqlSettings`），与名字无关。
 *
 * ⚠ 键不能直接用名字。连接改名当时用"删旧键 + 加新键"实现，而**新键会走"新增整条"**：
 *   浏览器拿不到已存的密码（宿主跨线前脱敏），那条 `set` 里的 `password` 只能是空串
 *   —— 于是**改一次名就把密码清空**。键与名字解耦之后，改名只是改 `name` 字段
 *   （深路径 op），同级的 `password` 原样留在宿主里。与 dsh-api-call 的 `users` 同构。
 */
export interface SqlConnectionConfig {
  /** 连接名（业务名）。工具调用的 `connection` 参数认的就是它。 */
  name: string
  engine: 'sqlite' | 'mysql' | 'postgres'
  file?: string
  host?: string
  /**
   * 端口 —— **字符串**，与 schema 一致（配置里写的就是设置页框里看到的）。
   *
   * 空串 = 不填，连接时按引擎走默认端口（驱动自己兜）。非空的要能转成数字，
   * 转不出来的由建连时报错 —— 报错点只有这一个，带得上上下文。
   */
  port?: string
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
 * 一个环境。
 *
 * **只有名字** —— 与 dsh-api-call 的 environment 不同，SQL 连接的环境没有 baseUrl
 * 这类属性（地址在连接自己身上），所以条目里没有别的字段。
 *
 * 那为什么不用 `string[]`？因为要跟 api-call 的模型对齐（见 `SqlSettings.environments`），
 * 而且形状是对象的话，以后要加字段（默认 schema、说明……）不用再改一次形状。
 */
export interface SqlEnvironmentConfig {
  name: string
}

/**
 * 设置的形状 —— **也是运行时的形状**（读写同一份，没有第二套解析结果）。
 *
 * 字段都是可选的：这是**配置里可能是什么样**的声明。经 `normalizeSettings` 读进来的
 * 那份一定带 `connections`（缺失会兜成 `{}`），但 `activeEnv` / `environments` / `maxRows`
 * 仍可能缺席 —— 它们各有各的默认/校验点，见 `isReadOnly` / `requireMaxRows`。
 */
export interface SqlSettings {
  /** 当前环境名；空串 = 未设置。必须在 environments 里。 */
  activeEnv?: string
  /**
   * 环境清单：**随机 id → { name }**。
   *
   * 键是**与显示名无关的随机 id**，用户看不到也改不了；业务上引用环境一律用条目的
   * `name`（`activeEnv` 和 connection 的 `env` 存的都是名字）。
   *
   * 与 dsh-api-call 的 `environments` 同构（那边条目还带 baseUrl / allowInsecure）。
   * 这个形状是为了让设置页能用**深路径 op** 增删改单个环境：
   *
   *     { op: "set",   path: ["environments", "a3f2c1", "name"], value: "qa" }
   *     { op: "set",   path: ["environments", "b7e9d4"], value: { name: "uat" } }
   *     { op: "unset", path: ["environments", "b7e9d4"] }
   *
   * ⚠ **不接受旧的 `string[]` 形状**：数组只能整组替换（`set ["environments"]`），
   *   而"改一个环境名"用整组替换做就得自己算 diff —— 那是焦点丢失与误删的来源。
   *   旧配置（0.4.x 及以前）请手工改成新形状，或删掉让插件重新生成。
   */
  environments?: Record<string, SqlEnvironmentConfig>
  /**
   * 连接清单：**随机 id → { name, engine, ... }**。
   *
   * 键是**与显示名无关的随机 id**（跟 `environments` 同构），业务上引用连接一律用条目的
   * `name` —— 工具调用的 `connection` 参数、连接自己的 `env`、报告里显示的都是名字。
   *
   * ⚠ **不能用名字当键**：连接改名当时只能"删旧键 + 加新键"，而新键会走"新增整条"，
   *   浏览器拿不到已存的密码（宿主脱敏），那条 op 里的 `password` 只能是空串 ——
   *   **改一次名就把密码清空**。键与名字解耦后，改名只是改 `name` 字段。
   */
  connections?: Record<string, SqlConnectionConfig>
  maxRows?: number
}

/**
 * 环境清单里的**全部名字**（跳过没有 name 的畸形条目）。
 *
 * 顺序是**插入顺序**（JS 对象字符串键的枚举顺序），也就是用户添加的先后 ——
 * 报告里照这个顺序列，跟设置页看到的顺序一致。
 */
export function environmentNames(settings: SqlSettings): string[] {
  const dict = settings.environments
  if (dict === null || typeof dict !== 'object' || Array.isArray(dict)) return []
  return Object.values(dict)
    .map((entry) => (entry !== null && typeof entry === 'object' ? entry.name : undefined))
    .filter((name): name is string => typeof name === 'string' && name !== '')
}

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


/**
 * readOnly 的**生效值**：只有显式 `false` 才可写，其余一律只读。
 *
 * fail-safe 的判断点就在这里 —— 认不出来的值（`"true"` / `1` / `"false"` / 缺省）
 * 全按只读。写权限是危险的那一侧，宁可挡住也不能悄悄给库开写权限。
 *
 * **不在解析层兜底**：配置里写的是什么就是什么，只在用的时候判。这样"读的"和
 * "写的"永远是同一份，也不会因为读一次就把 `readOnly: true` 落到每个连接上。
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
      '（在插件设置页改）',
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
 * **建连侧（`createAdapter`）用这一份规则** —— 措辞由调用方拼，规则只此一处，
 * 两处各写一遍必然漂移（报错顺序都会不一致）。
 *
 * ⚠ **它管不了"保存时"**：条件是随 engine 变的（sqlite 要 file、mysql/pg 要 host、
 *   pg 还要 database），而 schemastery 的 schema 只能表达**单字段**的约束，
 *   表达不了"这个字段在那种情况下必填"。所以这一层只能在**建连时**判 ——
 *   报错会说清缺了哪几个字段，好过悄悄连到 localhost 或内存库上。
 *
 * **不查 `port`**：留空是合法值，连接时按引擎走默认端口（mysql 3306 /
 * postgres 5432，驱动自己就兜）。它也不再是"必填"了。
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
  if (connection.engine === 'postgres' && (connection.database === undefined || connection.database === '')) {
    missing.push('database')
  }
  return missing
}

/**
 * 按**显示名**取出一个连接（键是随机 id，名字只是条目里的一个字段）。
 *
 * 找不到返回 `undefined` —— 调用方自己决定是抛错还是当空处理。
 * 名字区分大小写，与工具层 `connection` 参数的语义一致。
 */
export function findConnectionByName(settings: SqlSettings, name: string): SqlConnectionConfig | undefined {
  const dict = settings.connections
  if (dict === null || typeof dict !== 'object' || Array.isArray(dict)) return undefined
  for (const entry of Object.values(dict)) {
    if (entry !== null && typeof entry === 'object' && entry.name === name) return entry
  }
  return undefined
}

/**
 * 连接清单里的**全部名字**（跳过没有 name 的畸形条目）。
 *
 * 顺序是插入顺序，也就是用户添加的先后 —— 报告与「⚠ 问题」节照这个顺序列。
 */
export function connectionNames(settings: SqlSettings): string[] {
  const dict = settings.connections
  if (dict === null || typeof dict !== 'object' || Array.isArray(dict)) return []
  return Object.values(dict)
    .map((entry) => (entry !== null && typeof entry === 'object' ? entry.name : undefined))
    .filter((name): name is string => typeof name === 'string' && name !== '')
}

/**
 * 挑出在 `activeEnv` 下**可用**的连接。
 *
 * 匹配规则只有一条：`env` 为空的连接**任何环境都算可用**，否则要求 `env === activeEnv`。
 *
 * 返回**「名字 → 连接定义」**的字典，而不是条目字典（id 是键的那种）——
 * 消费点（探活、报告）认的是业务名字，用名字当键让它们不用再反查一次。
 *
 * `activeEnv` 为空时没有连接能靠「环境名相同」匹配，因此只有 `env` 为空的那批可用 —— 与设了环境时同一套规则。
 */
export function splitConnectionsByEnv(settings: SqlSettings): Record<string, SqlConnectionConfig> {
  const activeEnv = typeof settings.activeEnv === 'string' ? settings.activeEnv.trim() : ''
  const available: Record<string, SqlConnectionConfig> = {}
  for (const connection of Object.values(settings.connections ?? {})) {
    const name = typeof connection?.name === 'string' ? connection.name : ''
    if (name === '') continue // 畸形条目（没有名字）谁都引用不到，跳过
    // `env` 空白（或没写）都算"不限环境"：空白串不是合法环境名，当成"属于名字是空白的
    // 环境"会让这条连接在**任何**环境下都匹配不上，凭空消失。
    const env = typeof connection.env === 'string' ? connection.env.trim() : ''
    // `env` 指向一个**不存在的环境**时这里自然落空（既不等于 activeEnv，也不是空串）——
    // 那种连接在任何环境下都不会出现，由 sql_settings 的「⚠ 问题」节点名。
    if (env === '' || env === activeEnv) available[name] = connection
  }
  return available
}
