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
    queryTimeoutMs?: number;
    execTimeoutMs?: number;
}
/** 解析后的设置。 */
export interface ResolvedSqlSettings {
    activeEnv: string;
    environments: string[];
    /** 连接列表（已把键还原成 name，便于按顺序渲染）。 */
    connections: NamedSqlConnection[];
    maxRows: number;
    queryTimeoutMs: number;
    execTimeoutMs: number;
}
/** 连接密码环境变量名：DSH_SQL_PASSWORD_<NAME 大写>。 */
export declare function passwordEnvName(name: string): string;
/** description 字段最大长度，超出截断。 */
export declare const DESCRIPTION_MAX_LENGTH = 100;
/**
 * 解析设置：**只归一化，不校验**（校验在写入工具里做）。
 * 也**不补任何连接** —— 没配连接就是没有，由 sql_settings 在告警里指出来。
 */ export declare function resolveSettings(settings: SqlSettings | undefined | null, env?: NodeJS.ProcessEnv): ResolvedSqlSettings;
/** 校验表名/标识符，防注入到 schema 语句。 */
export declare function assertIdentifier(name: string, label: string): string;
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
