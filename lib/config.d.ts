/**
 * dsh-sql 设置解析与校验：类型即 `$DSH_HOME/sql/settings.json` 的形状。
 *
 * @module dsh-sql/config
 */
/** 单个数据库连接。 */
export interface SqlConnectionConfig {
    name: string;
    engine: 'sqlite' | 'mysql' | 'postgres';
    file?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    /** 该连接是否禁用写操作（默认 false，即允许写）。 */
    readOnly?: boolean;
    /** 连接用途说明（展示用，最长 100 字符）。 */
    description?: string;
}
/** 设置文件的形状。 */
export interface SqlSettings {
    connections?: SqlConnectionConfig[];
    maxRows?: number;
    queryTimeoutMs?: number;
    execTimeoutMs?: number;
}
/** 解析后的设置。 */
export interface ResolvedSqlSettings {
    connections: SqlConnectionConfig[];
    maxRows: number;
    queryTimeoutMs: number;
    execTimeoutMs: number;
}
/** 连接密码环境变量名：DSH_SQL_PASSWORD_<NAME 大写>。 */
export declare function passwordEnvName(name: string): string;
/** description 字段最大长度，超出截断。 */
export declare const DESCRIPTION_MAX_LENGTH = 100;
/**
 * 解析并校验设置；无连接时给一个内存 SQLite 兜底连接。
 */
export declare function resolveSettings(settings: SqlSettings | undefined | null, env?: NodeJS.ProcessEnv): ResolvedSqlSettings;
/** 校验表名/标识符，防注入到 schema 语句。 */
export declare function assertIdentifier(name: string, label: string): string;
