/**
 * 数据库操作工具：sql_query / sql_exec / sql_schema / sql_stats / sql_health。
 *
 * 设置每次调用现读，工具体内一律走 `loadConfig()`，不留配置副本。
 *
 * @module dsh-sql/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { type DatabaseAdapter } from './adapters.js';
import { type SqlSettings } from './config.js';
/** 校验只读查询：词法去噪后白名单开头 + 写关键字扫描 + 单语句。 */
export declare function assertReadQuery(sql: string): string;
/** 查询结果转 CSV 文本（RFC 4180 风格转义）。 */
export declare function toCsv(columns: string[], rows: unknown[][]): string;
/**
 * 一个 `defineTool` 产出的工具定义 —— **类型从宿主推断**，不再自己声明。
 *
 * 早先这里用自造的 `SqlToolDefinition`，那玩意儿的 `parameters` 是手写的 JSON Schema，
 * 宿主**不会校验**（它的校验读的是 `defineTool` 归一化后的 schema）。
 * 现在直接用 `ReturnType<typeof defineTool>`，跟宿主完全对齐。
 */
type SqlToolDefinition = ReturnType<typeof defineTool>;
/** 构建工具定义；配置**每次调用现读**，adapters 按连接名缓存并按指纹失效。 */
export declare function buildSqlTools(loadConfig: () => SqlSettings): {
    tools: SqlToolDefinition[];
    adapters: ReadonlyMap<string, DatabaseAdapter>;
};
export {};
