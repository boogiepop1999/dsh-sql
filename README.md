# dsh-sql

![banner](assets/banner.svg)

> **你的 agent 会查库了**：SQLite / MySQL / PostgreSQL 三引擎，只读白名单 + 连接级写开关 + 按环境筛选。**改配置不用重启。**

DSH（DeepSeek Harness）数据库插件：九个工具覆盖环境与连接管理、只读查询、写操作、结构探查、统计概览与探活自检。

![npm version](https://img.shields.io/npm/v/dsh-sql?label=npm&color=blue) ![npm downloads](https://img.shields.io/npm/dm/dsh-sql) ![license](https://img.shields.io/npm/l/dsh-sql) ![stars](https://img.shields.io/github/stars/STARDUSTLC666/dsh-sql?style=social)

## 安装

```bash
dsh plugin --profile web add dsh-sql
dsh plugin --profile web remove dsh-sql   # 卸载
```

装完重启 DSH Desktop 生效。本地路径安装一般是软链，之后改源码重启即可，不用重新 `add`。

## 配置：插件没有配置项

一切设置都在（**每次调用现读，改完立即生效，不用重启**）：

```
$DSH_HOME/sql/settings.json
```

`cordis.patch.yml` 里**不写任何配置项**，只有一行挂载声明 —— 那里是 `apply()` 时一次性读入的启动配置，改了要重启，写坏了还会让 DSH 起不来。

第一次调用任何工具时会自动生成出厂设置（**空的，需要自己配连接**）：

```jsonc
{
  "activeEnv": "",             // 当前环境；空 = 只有不限环境的连接可见
  "environments": [],          // 环境清单，如 ["qa", "prod"]
  "connections": {},           // 键即连接名；下面是长成的样子
  "maxRows": 1000              // 查询返回行数上限（1-10000）
}
```

配好连接后大致长这样：

```jsonc
{
  "activeEnv": "qa",
  "environments": ["qa", "prod"],
  "connections": {
    "polar": {
      "engine": "mysql",       // sqlite / mysql / postgres
      "host": "10.0.0.1",
      "port": 3306,            // mysql / postgres 必填，没有默认值
      "user": "ops_readonly",  // 密码走 DSH_SQL_PASSWORD_POLAR 环境变量
      "database": "app",
      "env": "qa",             // 所属环境
      "description": "QA 主库"
    },
    "gp-pro": {
      "engine": "postgres",
      "host": "10.0.0.2",
      "port": 5432,
      "user": "ops_readonly",
      "database": "cg-prd",    // postgres 必填
      "env": "prod",
      "readOnly": true,        // 该连接禁用写
      "description": "生产 GP，慎写"
    }
  },
  "maxRows": 1000
}
```

用编辑器改，或让 AI 用工具改：

```
sql_config_set({ environments: ["qa", "prod"], activeEnv: "qa" })
sql_connection_set({ name: "polar", engine: "mysql", host: "10.0.0.1", port: 3306, user: "ops_readonly", password: "...", database: "app", env: "qa" })
```

> ⚠ 连接密码在 `settings.json` 里是**明文**。这个文件别外传。

### 环境

**`environments` 是连接的分组标签，`activeEnv` 决定 `sql_settings` 和 `sql_health` 里哪些连接可见。**

匹配规则只有一条：**`env` 为空的连接在任何环境都可见**，否则要求 `env === activeEnv`；没匹配上的一律算「其它环境」。

- `activeEnv` 必须出自 `environments`（两个方向都校验：改当前环境、改清单都会检查）
- `environments` 传空数组 = 不使用环境，会**连带清空** `activeEnv`
- 连接的 `env` 必须出自 `environments`；**留空表示不限定环境**，这种连接在任何环境下都可见
- 删除某个环境不会拦住你，但会**提示还有哪些连接在用它**

`activeEnv` 为空时没有连接能靠环境名匹配，因此只有不限环境的那批可见 —— 与设了环境时同一套规则。

`activeEnv` 只影响 `sql_settings` 与 `sql_health` 的可见清单，**不影响 `sql_query` / `sql_exec` / `sql_schema` / `sql_stats`** —— 这四个用完整连接名，随时可以跨环境查。

### 超时

三个超时都是**代码常量**，**不在设置文件里、也不可配置**：

| 常量 | 值 | 用于 |
| :-- | :-- | :-- |
| `QUERY_TIMEOUT_MS` | 30 秒 | `sql_query` |
| `EXEC_TIMEOUT_MS` | 30 秒 | `sql_exec` |
| `STATS_TIMEOUT_MS` | 2 分钟 | `sql_stats`（逐表 `COUNT(*)`，单独放宽） |

其余工具的超时同样是代码常量：`sql_schema` / `sql_health` 各 30 秒，四个配置管理工具各 10 秒。

原因：Harness 的 `timeoutMs` 在工具注册时求值一次，做成配置项就得重启才生效 —— 与「改配置立即生效」的设计冲突，索性定死。要调就改 `src/config.ts` 重新构建。

超时是**护栏**而非「够用的上限」：走得通索引的查询秒级就回，走不通的再等也回不来，早失败能让 agent 更快改换查法。

**超时后的提示按读写分开**（安全优先，且**只指出问题、不列具体手段**——免得把 AI 的思路钉死）：

- `sql_query` 超时 → 说明这是工具护栏（不是环境不稳），**可有限重试**；多次仍超时则说明超出适用范围，要求与用户确认
- `sql_exec` 超时 → ⚠ 写操作**可能已在库上执行**，**禁止重试**，必须与用户确认

### 连接字段

**`connections` 是以连接名为键的对象**（键区分大小写）。

| 字段 | 引擎 | 说明 |
| :-- | :-- | :-- |
| `engine` | 全部 | `sqlite` / `mysql` / `postgres` |
| `file` | sqlite | **必填**：数据库文件路径，如 `:memory:` |
| `host` / `port` | mysql / postgres | **必填**；无默认值，不填会在写入与建连时报错 |
| `user` / `password` | mysql / postgres | 密码也可走环境变量 `DSH_SQL_PASSWORD_<连接名大写>` |
| `database` | postgres **必填**，mysql 可选 | MySQL 不填即不指定默认库，可用 `` `db`.`table` `` 全限定名 |
| `readOnly` | 全部 | 该连接禁用写操作，缺省 `false` |
| `env` | 全部 | 所属环境，必须已在 `environments` 里；留空 = 不限定环境 |
| `description` | 全部 | 用途说明，最长 100 字符，在 `sql_settings` 里展示 |

## 工具

| 工具 | 作用 | 安全 |
| :-- | :-- | :-- |
| `sql_settings` | 总览：当前环境的连接 + 全局设置 | 每次现读 |
| `sql_config_set` | 改全局设置（activeEnv / environments / 行数上限）| 环境双向校验 |
| `sql_connection_set` | 新增或更新一个连接 | 引擎与必填字段、port 正整数、env 归属校验 |
| `sql_connection_remove` | 删除一个连接 | 先确认存在 |
| `sql_query` | 只读查询（SELECT / PRAGMA / EXPLAIN / SHOW / DESCRIBE / WITH）| 关键字白名单 + 拒绝多语句 |
| `sql_exec` | 写操作 / DDL（INSERT / UPDATE / DELETE / CREATE / ALTER / DROP 等）| 连接级 readOnly + 单语句限制 |
| `sql_schema` | 表清单 / 表结构 | 标识符白名单校验 |
| `sql_stats` | 表数量、行数与库体积概览 | 表名引用 + 查询失败隔离 |
| `sql_health` | 逐连接探活（并发） | 不回显密码 |

> `connection` 是**必填**参数，值就是 `connections` 里的键（连接名）—— 多库协作没有「当前库」概念，一律显式指定。
> 四个配置管理工具带「仅当用户明确要求时才调用」的约定（它们是写配置的操作）。

### 示例

```text
sql_settings {}                                      # 看当前环境有哪些连接、全局设置是什么
sql_health {}                                        # 所有连接通不通（并发探活）
sql_schema { connection: polar }                     # 列出该连接的所有表
sql_schema { connection: polar, table: users }       # 看 users 表结构
sql_stats { connection: polar }                      # 查看该连接的数据规模
sql_query { connection: polar, sql: SELECT * FROM orders WHERE status = 'pending' LIMIT 50 }
sql_exec { connection: polar, sql: UPDATE orders SET status = 'paid' WHERE id = 42 }

sql_config_set { environments: ["qa", "prod"] }      # 配置环境清单
sql_config_set { activeEnv: "qa" }                   # 切到 qa
sql_connection_set { name: polar, engine: mysql, host: 10.0.0.1, port: 3306, user: ops, password: '...', database: app, env: qa }
sql_connection_remove { name: legacy }
```

## 安全设计

- **词法级只读保护**：`sql_query` 先剥离字符串与注释再校验，拒绝 data-modifying CTE、SELECT INTO、FOR UPDATE/FOR SHARE、PRAGMA 赋值与多语句
- **连接级 readOnly**：可逐个连接禁用写（生产库设 `readOnly: true`，QA 不受影响）
- **`activeEnv` 不限制访问其他环境的连接**：它只决定 `sql_settings` 与 `sql_health` 里列哪些连接；其余工具用完整连接名即可跨环境访问
- **不自带写审批**：插件不拦截写操作，权限交给 Harness 自身体系
- **标识符校验**：表名只允许字母/数字/下划线/`$`，杜绝 schema 注入
- **适配器指纹失效**：连接定义一改，缓存里的旧连接池立即失效重建，杜绝「改了配置却还打向老库」的静默错误
- **密钥可走环境变量**：密码支持 `DSH_SQL_PASSWORD_<连接名>`，优先于设置文件里的明文

## 实现要点

- **读取侧只归一化、不校验**：读配置不抛错，坏配置不会把插件锁死（问题在调用时暴露）；**校验只做在写入侧**（`sql_connection_set` 写入前把关必填字段与取值）
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
