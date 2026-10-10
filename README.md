# dsh-sql

![banner](assets/banner.svg)

> **你的 agent 会查库了**：SQLite / MySQL / PostgreSQL 三引擎，只读白名单 + 连接级写开关 + 按环境筛选。**改配置不用重启。**

DSH（DeepSeek Harness）数据库插件：七个工具覆盖环境切换、只读查询、写操作、结构探查、统计概览与探活自检，配置报告兼作排查入口。

![npm version](https://img.shields.io/npm/v/dsh-sql?label=npm&color=blue) ![npm downloads](https://img.shields.io/npm/dm/dsh-sql) ![license](https://img.shields.io/npm/l/dsh-sql) ![stars](https://img.shields.io/github/stars/STARDUSTLC666/dsh-sql?style=social)

## 安装

```bash
dsh plugin --profile web add dsh-sql
dsh plugin --profile web remove dsh-sql   # 卸载
```

装完重启 DSH Desktop 生效。本地路径安装一般是软链，之后改源码重启即可，不用重新 `add`。

## 配置在插件设置页，不由工具改

环境、连接、行数上限这些**人配一次、长期不动**的东西，在 **插件 → 已安装 → dsh-sql**
的配置区填写。改动立即生效，不用重启 DSH。

配置落在**当前 profile 的 `cordis.patch.yml`**（`id: sql` 的 `config` 段），
由 DSH 的 settings 服务托管：带 schema 校验、草稿与保存两段式、写入失败回滚。

**字段全缺时不必手写** —— schema 里有 `.default()`，缺的字段由宿主按出厂值补上，
所以只写自己关心的那几项就行。最小可用的一份配置（**空的，需要自己配连接**）：

```yaml
- id: sql
  config:
    activeEnv: ""            # 当前环境；空 = 只有不限环境的连接可见
    maxRows: 1000            # 查询返回行数上限（1-10000）
    environments: {}         # 环境清单：随机 id → { name }
    connections: {}          # 连接清单：随机 id → { name, engine, ... }
```

配好之后大致长这样：

```yaml
- id: sql
  config:
    activeEnv: qa
    maxRows: 1000
    environments:            # ⚠ 键是**随机 id**，业务上认的是 name
      c79eee46:
        name: qa
      2a67a891:
        name: prod
    connections:             # ⚠ 键同样是**随机 id**（见下方说明）
      b1d4f7a2:
        name: polar          # ← 连接名在这里，工具调用的 connection 参数认它
        engine: mysql        # sqlite / mysql / postgres
        host: 10.0.0.1
        port: 3306           # mysql / postgres 必填，没有默认值
        user: ops_readonly
        password: ""         # 留空则回退到 DSH_SQL_PASSWORD_POLAR 环境变量
        database: app
        env: qa              # 所属环境（写**名字**，不是 id）
        readOnly: false      # 显式开写 —— 不写这个字段就是只读
        description: QA 主库
      5e8c0a31:
        name: gp-pro
        engine: postgres
        host: 10.0.0.2
        port: 5432
        user: ops_readonly
        password: ""
        database: cg-prd     # postgres 必填
        env: prod
        readOnly: true
        description: 生产 GP，慎写
```

> **两个清单的键都是随机 id，不是名字。** id 由设置页生成，用户看不到也改不了；
> 显示名是条目里的 `name` 字段。`activeEnv` 和连接的 `env` 存的都是**名字**。
>
> 连接这条尤其要紧：**键与名字必须解耦**。若拿连接名当键，改名就只能"删旧键 + 加新键"，
> 而新键走的是"新增整条"——浏览器拿不到已存的密码（宿主跨线前脱敏），那条 op 里的
> `password` 只能是空串，于是**改一次名就把密码清空**。键是 id 时改名只是改 `name` 字段，
> 同级的 `password` 原样留在宿主里。详见 `src/config-schema.ts` 的说明。

> `readOnly` 不写就是**只读**。上例的 `polar` 显式给了 `false`，因为 QA 连接要能写。

> ⚠ 连接密码在 `cordis.patch.yml` 里是**明文**。这个文件别外传。设置页里的密码框
> 永远是空的（宿主脱敏），工具输出里也**不显示密码**。

### 环境

**`environments` 是连接的分组标签，`activeEnv` 决定 `sql_settings` 和 `sql_health` 里哪些连接可见。**

匹配规则只有一条：**`env` 为空的连接在任何环境都可见**，否则要求 `env === activeEnv`；没匹配上的一律算「其它环境」。
- **清单本身**：`environments` 是「随机 id → `{ name }`」的字典；业务上引用环境一律用
  `name`（`activeEnv` 和连接的 `env` 存的都是名字）
- **`activeEnv` 与连接的 `env` 都应当命中某个环境的 `name`** —— 这条是**跨字段**规则，
  schema 表达不了，所以**不在保存时拦**，而是由 `sql_settings` 的「⚠ 问题」节点名。
  指向不存在的环境时：`activeEnv` 表现为"当前环境名不对"，连接的 `env` 表现为
  "这条连接在任何环境下都不会出现"—— 不说出来就像凭空消失了
- **连接的 `env` 留空 = 不限定环境**，这种连接在任何环境下都可见

`activeEnv` 为空时没有连接能靠环境名匹配，因此只有不限环境的那批可见 —— 与设了环境时同一套规则。

`activeEnv` 只影响 `sql_settings` 与 `sql_health` 的可见清单，**不影响 `sql_query` / `sql_exec` / `sql_schema` / `sql_stats`** —— 这四个用完整连接名，随时可以跨环境查。

### 超时

三个超时都是**代码常量**，**不在配置里、也不可配置**：

| 常量 | 值 | 用于 |
| :-- | :-- | :-- |
| `QUERY_TIMEOUT_MS` | 30 秒 | `sql_query` |
| `EXEC_TIMEOUT_MS` | 30 秒 | `sql_exec` |
| `STATS_TIMEOUT_MS` | 2 分钟 | `sql_stats`（逐表 `COUNT(*)`，单独放宽） |

其余工具的超时同样是代码常量：`sql_schema` / `sql_health` 各 30 秒，`sql_settings` / `sql_env_use` 各 10 秒。

原因：Harness 的 `timeoutMs` 在工具注册时求值一次，做成配置项就得重启才生效 —— 与「改配置立即生效」的设计冲突，索性定死。要调就改 `src/config.ts` 重新构建。

超时是**护栏**而非「够用的上限」：走得通索引的查询秒级就回，走不通的再等也回不来，早失败能让 agent 更快改换查法。

**超时后的提示按读写分开**（安全优先，且**只指出问题、不列具体手段**——免得把 AI 的思路钉死）：

- `sql_query` 超时 → 说明这是工具护栏（不是环境不稳），**可有限重试**；多次仍超时则说明超出适用范围，要求与用户确认
- `sql_exec` 超时 → ⚠ 写操作**可能已在库上执行**，**禁止重试**，必须与用户确认

### 连接字段

**`connections` 是「随机 id → 连接定义」的对象**；连接名是条目里的 `name` 字段，
不是键（键是 id）。工具调用的 `connection` 参数认的是 **`name`，且区分大小写**。

| 字段 | 引擎 | 说明 |
| :-- | :-- | :-- |
| `name` | 全部 | **连接名（业务名）**，必填。工具调用的 `connection` 参数、报告里显示的都是它 |
| `engine` | 全部 | `sqlite` / `mysql` / `postgres`。**新建时必填；已有连接不可改** —— 要换引擎请删掉重建 |
| `file` | sqlite | **必填**：数据库文件路径，如 `:memory:` |
| `host` / `port` | mysql / postgres | **必填**；无默认值，不填会在写入与建连时报错。`port` 须为正整数 |
| `user` / `password` | mysql / postgres | 可选（有的库不要账号）。密码留空时回退到环境变量 `DSH_SQL_PASSWORD_<连接名大写>`，**文件里的明文优先** |
| `database` | postgres **必填**，mysql 可选 | MySQL 不填即不指定默认库，可用 `` `db`.`table` `` 全限定名 |
| `readOnly` | 全部 | 是否禁用写操作。**缺省 / 非法值一律按 `true`（只读）**；要开写必须显式写 `false`。值非法时 `sql_settings` 会把它列进「问题」 |
| `env` | 全部 | 所属环境，必须已在 `environments` 里；留空 = 不限定环境 |
| `description` | 全部 | 用途说明，最长 100 字符，在 `sql_settings` 里展示 |

**保存时 vs 建连时**（配置编辑在设置页，工具不再经手）：

- **设置页保存时**：schema 管**形状与单字段约束**（`engine` 必填、`maxRows` 1~10000、
  `name` 非空）。非法值存不进去。
- **建连时**：**条件必填**由 `missingConnectionFields` 判（sqlite 要 `file`、
  mysql/pg 要 `host`+`port`、pg 还要 `database`）—— schemastery 只能表达单字段规则，
  表达不了"这个字段在那种引擎下必填"，所以这一层只能在使用处。报错会说清缺了哪几个。
- **运行时的跨字段规则**：`activeEnv` 与连接的 `env` 得命中某个环境的 `name`。
  这条 schema 也表达不了（要看着整份配置才能判），由 `sql_settings` 的
  **「⚠ 问题」节**点名 —— 那是发现这类错误的主要渠道。

## 工具

| 工具 | 作用 | 安全 |
| :-- | :-- | :-- |
| `sql_settings` | 总览：当前环境的连接 + 全局设置。**排查问题先看这个** | 每次现读 |
| `sql_env_use` | 切换当前环境（**写进配置**，跟设置页里改一样） | 环境名必须在清单里 |
| `sql_query` | 只读查询（SELECT / PRAGMA / EXPLAIN / SHOW / DESCRIBE / WITH）| 关键字白名单 + 拒绝多语句 |
| `sql_exec` | 写操作 / DDL（INSERT / UPDATE / DELETE / CREATE / ALTER / DROP 等）| 连接级 readOnly + 单语句限制 |
| `sql_schema` | 表清单 / 表结构 | 标识符白名单校验 |
| `sql_stats` | 表数量、行数与库体积概览 | 表名引用 + 查询失败隔离 |
| `sql_health` | 逐连接探活（并发） | 不回显密码 |

> `connection` 是**必填**参数，值就是连接的 `name`（不是它在配置里的键 id）—— 多库协作没有「当前库」概念，一律显式指定。
>
> **配置编辑在插件设置页**，工具里只剩 `sql_env_use` 一个写操作 —— 切环境是"每次任务都可能
> 用到"的常规动作，跟"改连接 / 加环境"不是一类事。它带「仅当用户明确要求时才调用」的约定。

### 示例

```text
sql_settings {}                                      # 看当前环境有哪些连接、全局设置是什么
sql_health {}                                        # 所有连接通不通（并发探活）
sql_schema { connection: polar }                     # 列出该连接的所有表
sql_schema { connection: polar, table: users }       # 看 users 表结构
sql_stats { connection: polar }                      # 查看该连接的数据规模
sql_query { connection: polar, sql: SELECT * FROM orders WHERE status = 'pending' LIMIT 50 }
sql_exec { connection: polar, sql: UPDATE orders SET status = 'paid' WHERE id = 42 }

sql_env_use { env: qa }                              # 切到 qa（写进配置，下次调用生效）
```

> 环境清单、连接、`maxRows` 都在**插件设置页**里加改 —— 见上面「配置」一节。

## 安全设计

- **词法级只读保护**：`sql_query` 先剥离字符串与注释再校验，拒绝 data-modifying CTE、SELECT INTO、FOR UPDATE/FOR SHARE、PRAGMA 赋值与多语句
- **连接级 readOnly（fail-safe）**：**不写就按只读**，要开写必须显式 `readOnly: false`（生产库不用特意设 `true`，忘写也不会误开写权限）。值非法（如 `"false"`）同样按只读，并在 `sql_settings` 的「问题」里点出来
- **`activeEnv` 不限制访问其他环境的连接**：它只决定 `sql_settings` 与 `sql_health` 里列哪些连接；其余工具用完整连接名即可跨环境访问
- **不自带写审批**：插件不拦截写操作，权限交给 Harness 自身体系
- **标识符校验**：表名只允许字母/数字/下划线/`$`，杜绝 schema 注入
- **适配器指纹失效**：连接定义一改，缓存里的旧连接池立即失效重建，杜绝「改了配置却还打向老库」的静默错误
- **密钥可走环境变量**：连接的 `password` 留空时回退到 `DSH_SQL_PASSWORD_<连接名大写>`。**配置里的明文优先**，环境变量在**建连前现取**、不写回配置（否则密钥会被落盘）
- **密码不过线**：`password` 是 `role('secret')` 字段，宿主在跨线前把值整个抹掉 ——
  设置页里的密码框**永远是空的**，空 = 不改动已存的那个

## 实现要点

- **形状归 schema，值归使用处**：`src/config-schema.ts` 是配置形状与单字段约束的
  **唯一真源**（宿主保存时校验）；`normalizeSettings` 只做「查顶层形状 + 剔未知字段 +
  `connections` 缺省兜底 `{}`」，**不 trim、不类型过滤、不补默认值**
- **字段的兜底/校验在使用处**：`isReadOnly()` 按 fail-safe 判只读、`requireMaxRows()`
  校验行数上限（非法直接报错，不静默夹取）、`missingConnectionFields()` 判条件必填、
  密码环境变量在建连前合流。**合流只在使用时发生，绝不写回文件**（否则密钥会落盘成明文）
- **跨字段规则只能在运行时判**：`activeEnv` / 连接的 `env` 得命中某个环境的 `name` ——
  schema 表达不了（要看着整份配置），由 `sql_settings` 的「⚠ 问题」节点名
- **读取侧不抛错（形状除外）**：读配置不因"值不对"而抛，坏配置不会把插件锁死
  （问题在调用时暴露或在「问题」节列出）；**形状坏了**（不是对象 / 旧格式）才直接抛
- **不补默认值**：连接字段「有就写，没有就不写」，缺了报错而不是猜 —— 猜出来的默认值会把「配置错了」伪装成「连不上」
- **流式行数钳制**：最多收集 `maxRows+1` 行，超量标记 `truncated`；MySQL / PostgreSQL 达上限时关闭该查询的专用连接，未达上限则归还连接池，避免全量结果驻留内存
- **可取消执行**：遵守 Harness 的 `exec.signal`，取消时销毁正在工作的专用连接
- **大整数无损**：bigint 在安全整数范围内输出 number，超出则输出十进制字符串，避免静默丢精度
- **并发探活**：`sql_health` 并发测试所有连接，N 个连接不通只等一次超时而非 N 次

## 开发

引擎实现：SQLite 走 Node 内置的 `node:sqlite`（零依赖），MySQL 走 mysql2 连接池，PostgreSQL 走 pg 连接池。

```bash
pnpm install
pnpm build      # tsc 编译到 lib/
pnpm test       # 构建 + 完整测试套件（含真实 SQLite 集成）
```

## License

MIT
