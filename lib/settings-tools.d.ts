/**
 * 配置报告工具：`sql_settings`。
 *
 * 配置编辑统一走**插件设置页**（见 config-schema.ts），所以这里只剩**只读报告** ——
 * 它的「⚠ 问题」节是发现配置错误的主要渠道：设置页只保证形状（schema），
 * "activeEnv 得命中某个环境的名字"这类跨字段规则只能在运行时判。
 *
 * @module dsh-sql/settings-tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { type SqlSettings } from './config.js';
/** `defineTool` 产出的工具定义 —— 类型从宿主推断（见 tools.ts 的同类说明）。 */
type SqlToolDefinition = ReturnType<typeof defineTool>;
/**
 * 构建配置报告工具。
 *
 * `getConfig` 由 `apply` 注入（`configReader(config)`），**每次调用时现取** ——
 * 配置编辑在设置页，改完下一次调用就生效。
 */
export declare function buildSettingsTools(getConfig: () => SqlSettings): SqlToolDefinition[];
export {};
