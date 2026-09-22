# dsh-sql

![banner](assets/banner.svg)

> **你的 agent 会查库了**：SQLite / MySQL / PostgreSQL 三引擎，只读白名单 + 连接级写开关。**改配置不用重启。**

DSH（DeepSeek Harness）数据库插件：九个工具覆盖连接管理、只读查询、写操作、结构探查、统计概览与探活自检。

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

`cordis.patch.yml` 一个字都不用写 —— 那里是 `apply()` 时一次性读入的启动配置，改了要重启，写坏了还会让 DSH 起不来。

第一次调用任何工具时会自动生成出厂设置：

```jsonc
{
  "connections": [
    {
      "name": "default",
      "engine": "sqlite",      // sqlite / mysql / postgres
      "file": ":memory:",      // sqlite 用：文件路径
      "readOnly": false        // true 时禁用该连接的写操作
    }
  ],
  "maxRows": 1000,             // 查询返回行数上限（1-10000）
  "queryTimeoutMs": 60000,     // 单次查询超时（5 秒 - 10 分钟）
  "execTimeoutMs": 120000      // 单次写操作超时（5 秒 - 10 分钟）
}
```

用编辑器改，或让 AI 用工具改：

```
sql_connection_set({ name: "qa", engine: "mysql", host: "10.0.0.1", database: "app" })
sql_config_set({ maxRows: 2000 })
```

> ⚠ 连接密码在 `settings.json` 里是**明文**。这个文件别外传。

### 连接字段

| 字段 | 引擎 | 说明 |
| :-- | :-- | :-- |
| `name` | 全部 | 连接名（必填，唯一） |
| `engine` | 全部 | `sqlite` / `mysql` / `postgres` |
| `file` | sqlite | 数据库文件路径，缺省 `:memory:` |
| `host` / `port` | mysql / postgres | 缺省 `localhost`、`3306` / `5432` |
| `user` / `password` | mysql / postgres | 密码也可走环境变量 `DSH_SQL_PASSWORD_<连接名大写>` |
| `database` | postgres **必填**，mysql 可选 | MySQL 不填即不指定默认库，可用 `` `db`.`table` `` 全限定名 |
| `readOnly` | 全部 | 该连接禁用写操作，缺省 `false` |
| `description` | 全部 | 用途说明，最长 100 字符，在 `sql_settings` 里展示 |

## 工具

| 工具 | 作用 | 安全 |
| :-- | :-- | :-- |
| `sql_settings` | 总览：连接清单 + 全局设置 + 数据目录 | 每次现读 |
| `sql_config_set` | 改全局设置（maxRows / 超时）| 范围校验后才落盘 |
| `sql_connection_set` | 新增或覆盖一个连接 | 引擎字段校验 |
| `sql_connection_remove` | 删除一个连接 | 先确认存在 |
| `sql_query` | 只读查询（SELECT / PRAGMA / EXPLAIN / SHOW / DESCRIBE / WITH）| 关键字白名单 + 拒绝多语句 |
| `sql_exec` | 写操作 / DDL（可多语句脚本）| 连接级 readOnly |
| `sql_schema` | 表清单 / 表结构 | 标识符白名单校验 |
| `sql_stats` | 表数量、行数与库体积概览 | 表名引用 + 查询失败隔离 |
| `sql_health` | 逐连接探活（并发） | 不回显密码 |

> `connection` 是**必填**参数 —— 多库协作场景没有「当前库」概念，一律显式指定。
> 四个配置管理工具带「仅当用户明确要求时才调用」的约定（它们是写配置的操作）。

### 示例

```text
sql_settings {}                                      # 看有哪些连接、全局设置是什么
sql_health {}                                        # 所有连接通不通（并发探活）
sql_schema { connection: qa }                        # 列出该连接的所有表
sql_schema { connection: qa, table: users }          # 看 users 表结构
sql_stats { connection: qa }                         # 查看该连接的数据规模
sql_query { connection: qa, sql: SELECT * FROM orders WHERE status = 'pending' LIMIT 50 }
sql_exec { connection: qa, sql: UPDATE orders SET status = 'paid' WHERE id = 42 }

sql_connection_set { name: qa, engine: mysql, host: 10.0.0.1, database: app }
sql_config_set { maxRows: 2000 }
sql_connection_remove { name: legacy }
```

## 安全设计

- **词法级只读保护**：`sql_query` 先剥离字符串与注释再校验，拒绝 data-modifying CTE、SELECT INTO、FOR UPDATE/FOR SHARE、PRAGMA 赋值与多语句
- **连接级 readOnly**：可逐个连接禁用写（生产库设 `readOnly: true`，QA 不受影响）
- **不自带写审批**：插件不拦截写操作，权限交给 Harness 自身体系
- **标识符校验**：表名只允许字母/数字/下划线，杜绝 schema 注入
- **适配器指纹失效**：连接定义一改，缓存里的旧连接池立即失效重建，杜绝「改了配置却还打向老库」的静默错误
- **密钥可走环境变量**：密码支持 `DSH_SQL_PASSWORD_<连接名>`，优先于设置文件里的明文

## 实现要点

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
