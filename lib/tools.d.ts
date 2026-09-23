/**
 * 数据库操作工具：sql_query / sql_exec / sql_schema / sql_stats / sql_health。
 *
 * 设置每次调用现读，工具体内一律走 `loadConfig()`，不留配置副本。
 *
 * @module dsh-sql/tools
 */
import { type DatabaseAdapter } from './adapters.js';
import { type ResolvedSqlSettings } from './config.js';
import { type SqlToolDefinition } from './tool-kit.js';
/** 校验只读查询：词法去噪后白名单开头 + 写关键字扫描 + 单语句。 */
export declare function assertReadQuery(sql: string): string;
/** 查询结果转 CSV 文本（RFC 4180 风格转义）。 */
export declare function toCsv(columns: string[], rows: unknown[][]): string;
/** 构建工具定义；设置**每次调用现读**，adapters 按连接名缓存并按指纹失效。 */
export declare function buildSqlTools(loadConfig: () => ResolvedSqlSettings): {
    tools: SqlToolDefinition[];
    adapters: ReadonlyMap<string, DatabaseAdapter>;
};
