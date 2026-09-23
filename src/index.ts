/**
 * dsh-sql —— SQLite / MySQL / PostgreSQL 多连接数据库工具插件。
 *
 * 九个工具：配置管理 4（sql_settings / sql_config_set / sql_connection_set /
 * sql_connection_remove）+ 数据库操作 5（sql_query / sql_exec / sql_schema /
 * sql_stats / sql_health）。
 *
 * 插件没有配置项：一切设置见 $DSH_HOME/sql/settings.json，每次调用现读。
 *
 * @module dsh-sql
 */

import { loadSettings } from './settings.js'
import { buildSettingsTools } from './settings-tools.js'
import { buildSqlTools } from './tools.js'
import type { SqlToolDefinition } from './tool-kit.js'

/** cordis 服务注入：apply 里要用 ctx.tools，必须显式声明。 */
export const name = 'sql'
export const inject = ['tools']

/** 插件所需的最小 ctx 面。 */
export interface SqlPluginContext {
  tools: { register(definition: SqlToolDefinition): () => void }
  on(event: 'dispose', listener: () => void): () => void
}

/** 插件入口：启动读一次仅做校验与生成出厂设置，运行时一律现读。 */
export function apply(ctx: SqlPluginContext): void {
  loadSettings()

  const { tools, adapters } = buildSqlTools(() => loadSettings().resolved)
  const allTools = [...buildSettingsTools(), ...tools]

  const disposers: Array<() => void> = []
  for (const definition of allTools) {
    disposers.push(ctx.tools.register(definition))
  }
  ctx.on('dispose', () => {
    for (const dispose of disposers) dispose()
    for (const adapter of adapters.values()) void adapter.close()
  })
}

export * from './adapters.js'
export * from './config.js'
export * from './settings.js'
export * from './settings-tools.js'
export * from './sql-lex.js'
export * from './tool-kit.js'
export * from './tools.js'
