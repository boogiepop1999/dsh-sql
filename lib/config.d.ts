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
    engine: 'sqlite' | 'mysql' | 'postgres';
    file?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    /** 该连接是否禁用写操作（默认 false，即允许写）。 */
    readOnly?: boolean;
    /** 所属环境（如 qa / prod）；留空表示不限定环境（任何环境都可用）。 */
    env?: string;
    /** 连接用途说明（展示用，最长 100 字符）。 */
    description?: string;
}
/** 具名连接：名字 + 参数。 */
export interface NamedSqlConnection extends SqlConnectionConfig {
    name: string;
}
/** 设置文件的形状。 */
export interface SqlSettings {
    /** 当前环境名；空串 = 未设置。必须在 environments 里。 */
    activeEnv?: string;
    /** 环境清单（去重、非空字符串）。 */
    environments?: string[];
    /** 连接表：键即连接名（区分大小写）。 */
    connections?: Record<string, SqlConnectionConfig>;
    maxRows?: number;
}
/** 解析后的设置。 */
export interface ResolvedSqlSettings {
    activeEnv: string;
    environments: string[];
    /** 连接列表（已把键还原成 name，便于按顺序渲染）。 */
    connections: NamedSqlConnection[];
    maxRows: number;
}
/**
 * 单次查询超时。**代码常量，不可配置** —— Harness 的 `timeoutMs` 在工具注册时求值一次，
 * 做成配置项就得重启才生效，与「改配置立即生效」冲突，因此定死。
 *
 * 30 秒是**护栏**不是「够用的上限」：走得通索引的查询秒级就回，走不通的 60 秒也回不来。
 * 早失败能让 agent 更快改换查法，而不是白等。
 */
export declare const QUERY_TIMEOUT_MS = 30000;
/**
 * 单次写操作超时。比查询更该早掐：正常写操作都是秒级，超过 30 秒的多半在等锁或动大表，
 * 让 agent 干等没意义，且等得越久越可能把一个大操作放跑完。
 */
export declare const EXEC_TIMEOUT_MS = 30000;
/**
 * `sql_stats` 专用超时 —— 它逐表跑 `COUNT(*)`，表一多就慢，
 * 跟「跑一条业务查询」不是一回事，因此单独放宽。
 *
 * 2 分钟够用：再大的库该按 schema 分批查，而不是靠调大超时硬扛。
 */
export declare const STATS_TIMEOUT_MS = 120000;
/** 连接密码环境变量名：DSH_SQL_PASSWORD_<NAME 大写>。 */
export declare function passwordEnvName(name: string): string;
/** description 字段最大长度，超出截断。 */
export declare const DESCRIPTION_MAX_LENGTH = 100;
/**
 * 解析设置：**只归一化，不校验**（校验在写入工具里做）。
 * 也**不补任何连接** —— 没配连接就是没有，由 sql_settings 在告警里指出来。
 */
export declare function resolveSettings(settings: SqlSettings | undefined | null, env?: NodeJS.ProcessEnv): ResolvedSqlSettings;
/** 校验表名/标识符，防注入到 schema 语句。 */
export declare function assertIdentifier(name: string, label: string): string;
/**
 * 列出连接缺少的必填字段（空数组 = 齐了）。
 *
 * **写入侧（`sql_connection_set`）与建连侧（`createAdapter`）共用这一份规则** ——
 * 两处各写一遍必然漂移（曾经就出现过报错顺序不一致）。措辞由调用方拼，规则只此一处。
 *
 * 不查 `user` / `password`：有的库确实不要密码。也不查 mysql 的 `database`：
 * 不指定默认库时可用全限定名查询。
 */
export declare function missingConnectionFields(connection: SqlConnectionConfig): string[];
/**
 * 按 activeEnv 切分连接：能用的 / 不能用的。
 *
 * 匹配规则只有一条：`env` 为空的连接**任何环境都算可用**，否则要求 `env === activeEnv`。
 * 没匹配上的一律算「其它环境」。
 *
 * `activeEnv` 为空时没有连接能靠「环境名相同」匹配，因此只有 `env` 为空的那批可用 —— 与设了环境时同一套规则。
 */
export declare function splitConnectionsByEnv(settings: ResolvedSqlSettings): {
    available: NamedSqlConnection[];
    excluded: NamedSqlConnection[];
};
