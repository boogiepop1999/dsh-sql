/**
 * 运行时配置的 **Schemastery schema** —— 插件设置页的**唯一真源**。
 *
 * 与 `src/config.ts` 的 `SqlSettings` 是**同一份形状的两种表达**：
 *
 *   - `SqlSettings`（TS 接口）—— 给编译器和读代码的人看
 *   - 这里（运行时 schema）—— 给 `dsh-settings` 看：它投影成表单、做保存时的校验
 *
 * 两者**必须一致**，但没法合并：接口是编译期的东西，`dsh-settings` 要的是运行时的
 * 描述对象（带 `min` / `required` / `role` 这些元数据）。改了形状要**同时改两处** ——
 * `SQL_CONFIG_DEFAULTS` 就是给这条约束做漂移检测用的。
 *
 * ## 校验分三层，各管一段
 *
 * **① schema（这里）** —— 形状、类型、范围、必填。宿主在**保存时**校验，所以非法值
 *   进不了配置。
 *
 * **② 跨字段（`config.ts`）** —— schema 表达不了的，比如 `activeEnv` 必须命中
 *   `environments` 里某个条目的 `name`。这类"引用完整性"要看着整份配置才能判，
 *   只能在运行时查（`splitConnectionsByEnv` 按它挑出可用连接），报错在
 *   `sql_settings` 的「⚠ 问题」节里列出来。
 *
 * **③ 运行时事实** —— `requireMaxRows`（范围）与 `isReadOnly`（fail-safe 判只读）：
 *   前者 schema 已经保证了（见下），后者是"认不出来就按只读"的**安全侧兜底**，
 *   不是校验 —— 它必须留在使用处，因为读的是原值而不是校验后的值。
 *
 * 三层不重叠：一个规则**只在一个地方**表达。
 *
 * ## `environments` 为什么是「随机 id 为键的字典」
 *
 * 键是**与显示名无关的随机 id**，条目里 `name` 是普通字段。这样设置页能用
 * **深路径 op** 增删改单个环境：
 *
 *     { op: "set",   path: ["environments", "a3f2c1", "name"], value: "qa" }
 *     { op: "set",   path: ["environments", "b7e9d4"], value: { name: "uat" } }
 *     { op: "unset", path: ["environments", "b7e9d4"] }
 *
 * 用数组的话只能整组替换（`set ["environments"]`），而"改一个环境名"用整组替换做
 * 就得自己算 diff —— 那是焦点丢失与误删的来源。这个形状与 dsh-api-call 一致
 * （那边条目还带 baseUrl / allowInsecure）。
 *
 * ⚠ **迁移**：0.4.x 的 `environments` 是 `string[]`，**不做兼容**（`normalizeSettings`
 *   会直接报错并指出是旧形状）。id 是随机生成的，静默转一份出来会让用户下次打开
 *   设置页看到一堆不认识的键，不如让他明确重配一次。
 */
import z from '@deepseek-ai/schemastery'

/**
 * `z.object(...)` 的返回类型。
 *
 * ⚠ 显式标注是**必须的**：`declaration: true` 要求每个导出的类型都能被"命名"，
 *   而 `ConfigSchema` 的推断类型里含有 `@deepseek-ai/cosmokit` 的私有路径
 *   （`.pnpm/@deepseek-ai+cosmokit@1.8.5/...`）—— TS 会报 TS2742「类型不可移植」。
 *   标成这个宽泛的接口就把那段路径挡在声明文件之外。
 *
 * 导出是给 `index.ts` 标 `Config` 用的 —— 那里会遇到同一个问题。
 */
export type Schema = ReturnType<typeof z.object>

/**
 * 一个环境。
 *
 * **只有名字** —— SQL 连接的环境没有 baseUrl 这类属性（地址在连接自己身上），
 * 所以条目里没有别的字段。带 `description` 之类以后要加，形状已经是对象了，加字段
 * 不用再改一次结构。
 *
 * `name` `.required()`：它唯一的用途就是被 `activeEnv` 和连接的 `env` 指向 ——
 * 名字为空则指向不了，空值在保存时就该拦下。
 */
export const EnvironmentSchema = z.object({
  name: z.string().required().description('环境名，如 qa / uat / prod'),
})

/**
 * 一个连接。
 *
 * `password` 打 `role("secret")`：`dsh-settings` 在跨线前把它**整个抹掉**，只留
 * 「这个位置有值 / 没值」的标记。它保护的是**界面**，不是存储：密码本来就以明文躺在
 * profile 的 patch 里，挡不住能读文件的人 —— 挡住的是密码出现在前端。
 *
 * ⚠ `password` **不能标 `.required()`**：它不下发到浏览器（回填时永远是空串），标必填
 *   会让"只想改个地址"的保存被拒。而且 SQL 连接的密码**不一定存在配置里** ——
 *   也可以用环境变量 `DSH_SQL_PASSWORD_<名字>`（见 config.ts 的 `passwordEnvName`），
 *   那是本地判不出来的，更不该拦。
 *
 * `engine` `.required()`：它决定用哪个驱动、哪些字段有意义 —— 猜错的话报错离原因很远
 *   （拿 mysql 的参数去连 pg）。空值在保存时就该拦下。
 *
 * `readOnly` **不在这里校验**（不标 `.required()`，也用 `z.boolean()`）：非法值
 *   （`"true"` / `1`）由使用处的 `isReadOnly` 按 fail-safe 当只读处理，并在
 *   `sql_settings` 的「问题」节里点名。schema 挡一道的话那些"值写错了但作业还能跑"
 *   的情况就变成"整份配置存不进去"，反而更容易让人去关掉校验。
 *
 * `host` / `port` / `file` / `database` 的必填性**取决于 engine**（sqlite 要 file，
 *   mysql/pg 要 host+port，pg 还要 database）—— 这种条件必填 schema 表达不了，
 *   留在 `missingConnectionFields`（建连时判）。
 */
export const ConnectionSchema = z.object({
  name: z.string().required().description('连接名，如 polar / gp-qa（工具调用的 connection 参数认它）'),
  engine: z.string().required().description('sqlite / mysql / postgres'),
  file: z.string().default('').description('SQLite 数据库文件路径（engine=sqlite 时必填）'),
  host: z.string().default('').description('主机名（engine=mysql / postgres 时必填）'),
  // 不标 .min(1)/.max(65535)：端口非法由建连时报错，而且 schema 只能表达单字段范围，
  // 管不了"这个连接要不要端口"（sqlite 根本没有）。
  port: z.number().description('端口'),
  user: z.string().default('').description('登录用户'),
  password: z.string().role('secret').default('').description('登录密码（只写，不回显）'),
  database: z.string().default('').description('数据库名（engine=postgres 时必填）'),
  readOnly: z.boolean().default(true).description('禁止写操作；缺省按只读处理'),
  env: z.string().default('').description('限定环境名；留空表示任何环境都能用'),
  description: z.string().max(100).default('').description('这个连接干什么用的（最长 100 字符）'),
})

/**
 * 全部运行时配置。**schema 是校验的唯一真源。**
 *
 * 字段与 `src/config.ts` 的 `SqlSettings` 一一对应。
 */
export const ConfigSchema: Schema = z.object({
  activeEnv: z.string().default('').description('当前环境名（environments 里某个条目的 name）'),
  maxRows: z.number().min(1).max(10000).default(1000)
    .description('查询返回行数上限（1~10000）'),
  environments: z.dict(EnvironmentSchema).default({})
    .description('环境清单：随机 id → { name }'),
  connections: z.dict(ConnectionSchema).default({})
    .description('连接清单：随机 id → { name, engine, ... }（键是 id，不是连接名）'),
}).volatile()

/**
 * schema 里表达的默认值快照 —— **仅供测试对照**，运行时不读它。
 *
 * 存在的意义是让 `config.ts` 的 `defaultSettings()` 与 schema 漂移时能被测出来：
 * 两边都是"配置的默认值"，一处改了另一处忘改，症状是**首次运行**（配置里还没有这个
 * 字段）与**设置页重置**给出不同结果。
 */
export const SQL_CONFIG_DEFAULTS = {
  activeEnv: '',
  maxRows: 1000,
  environments: {},
  connections: {},
}

export default ConfigSchema
