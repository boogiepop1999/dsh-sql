/**
 * SQL 词法处理：去噪与语句切分。
 *
 * 独立成模块是因为**工具层（`tools.ts`）与适配器层（`adapters.ts`）都要用同一套判断** ——
 * 两处各写一套（一个去噪、一个裸 `includes(';')`）会得出不同结论：注释里的分号会让
 * `CREATE TABLE t (id INT) /* ; *​/` 被误判成多语句。
 *
 * @module dsh-sql/sql-lex
 */
/**
 * 去掉字符串、引号标识符与注释，保留真实 SQL 关键字与分号。
 *
 * 目的是让「语句里是否出现写关键字 / 分号」的判断不被字面量骗到：
 * `SELECT * FROM t WHERE note = 'delete from x'` 里的 `delete` 不算。
 */
export declare function stripSqlNoise(sql: string): string;
/**
 * 去噪后按分号切出非空语句。
 *
 * **这是全项目唯一的「几条语句」判断口径** —— 工具层的多语句拦截与适配器的单语句保护
 * 都走它，避免两套规则给出不同结论。
 */
export declare function splitStatements(sql: string): string[];
/** 数语句条数。 */
export declare function countStatements(sql: string): number;
