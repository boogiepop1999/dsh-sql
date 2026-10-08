/**
 * dsh-sql —— SQLite / MySQL / PostgreSQL 多连接数据库工具插件。
 *
 * 六个工具：配置报告 1（sql_settings）+ 环境切换 1（sql_env_use）+
 * 数据库操作 5（sql_query / sql_exec / sql_schema / sql_stats / sql_health）。
 *
 * 配置编辑**统一走插件设置页**（`Config` 导出 + 客户端 bundle），不由工具改 ——
 * 跟 dsh-api-call 保持一致。留给 AI 的唯一写操作是 `sql_env_use`：切当前环境是
 * 「每次任务都可能用到」的常规动作，跟"改连接 / 加环境"不是一类事。
 *
 * 配置落在**当前 profile 的 `cordis.patch.yml`**（`id: sql` 的 config 段），
 * 由 DSH 的 settings 服务托管：带 schema 校验、写入回滚、Loader 热重载。
 *
 * @module dsh-sql
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { type Schema } from './config-schema.js';
/** `defineTool` 产出的工具定义 —— 类型从宿主推断（见 tools.ts 的同类说明）。 */
type SqlToolDefinition = ReturnType<typeof defineTool>;
/** cordis 服务注入：apply 里要用 ctx.tools，必须显式声明。 */
export declare const name = "sql";
export declare const inject: string[];
/** 插件所需的最小 ctx 面。 */
export interface SqlPluginContext {
    tools: {
        register(definition: SqlToolDefinition): () => void;
    };
    on(event: 'dispose', listener: () => void): () => void;
    /** settings 服务不是硬依赖 —— 用 `inject` 子级按需挂载（见 apply）。 */
    inject(deps: string[], callback: (ctx: SqlSettingsContext) => void): unknown;
}
/** `ctx.inject(['settings'], …)` 给出的那个子级 ctx。 */
export interface SqlSettingsContext extends SqlPluginContext {
    settings?: {
        configure?(presentation: {
            auto: boolean;
        }, owner?: unknown): void;
        update?(ns: string, patch: Record<string, unknown>): Promise<unknown>;
    };
    fiber?: unknown;
    effect?(callback: () => unknown, label?: string): unknown;
}
/**
 * 插件入口 —— 宿主把配置当**第二个参数**传进来（`apply(ctx, config)`）。
 *
 * 配置全程走宿主：读是 `configReader`（每次现取），写是设置页 → `settings.update`。
 * 插件自己**不碰任何配置文件** —— 校验、原子写、热重载都是宿主的活。
 */
export declare function apply(ctx: SqlPluginContext, config?: unknown): void;
export * from './adapters.js';
export * from './config.js';
export * from './config-schema.js';
export * from './settings.js';
export * from './settings-tools.js';
export * from './sql-lex.js';
export * from './tool-kit.js';
export * from './tools.js';
/**
 * 插件的运行时配置 schema —— **这个名字不能改**。
 *
 * `dsh-settings` 读的是 `entry.fiber.runtime.Config`（见它的 `schema(entry)`：
 * `const schema = entry.fiber?.runtime?.Config`）。所以必须导出一个叫 **`Config`**
 * 的东西，否则：
 *
 *   - 配置**不会**出现在插件详情页（`describe()` 找不到这个字段）
 *   - `ctx.configForms.get('sql')` 拿不到 schema，页面渲染不出来
 *   - 保存时宿主也没法按 schema 校验
 *
 * ⚠ 光 `export * from './config-schema.js'` **不够** —— 那样导出的名字是
 *   `ConfigSchema`，宿主不认。必须是 `Config`（跟 dsh-api-call 同一个约定）。
 *
 * 另外：`dsh-settings` 取 schema 时会调 `schema.toJSON()`，所以这里必须是
 * **Schemastery 的 schema 对象**，不能换成别的形状。
 *
 * ⚠ 显式标注 `Schema` 是**必须的**：`declaration: true` 要求每个导出的类型都能被
 *   "命名"，而这里的推断类型含 `@deepseek-ai/cosmokit` 的私有路径
 *   （`.pnpm/@deepseek-ai+cosmokit@1.8.5/...`）—— TS 会报 TS2742「类型不可移植」。
 */
export declare const Config: Schema;
