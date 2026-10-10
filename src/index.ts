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

import { defineTool, type ToolOutput } from '@deepseek-ai/dsh-tools'
import { normalizeSettings } from './settings.js'
import { buildSettingsTools } from './settings-tools.js'
import { buildSqlTools } from './tools.js'
import { environmentNames, type SqlSettings } from './config.js'
import { ConfigSchema, type Schema } from './config-schema.js'

/** `defineTool` 产出的工具定义 —— 类型从宿主推断（见 tools.ts 的同类说明）。 */
type SqlToolDefinition = ReturnType<typeof defineTool>

/** cordis 服务注入：apply 里要用 ctx.tools，必须显式声明。 */
export const name = 'sql'
export const inject = ['tools']

/** 插件所需的最小 ctx 面。 */
export interface SqlPluginContext {
  tools: { register(definition: SqlToolDefinition): () => void }
  on(event: 'dispose', listener: () => void): () => void
  /** settings 服务不是硬依赖 —— 用 `inject` 子级按需挂载（见 apply）。 */
  inject(deps: string[], callback: (ctx: SqlSettingsContext) => void): unknown
}

/** `ctx.inject(['settings'], …)` 给出的那个子级 ctx。 */
export interface SqlSettingsContext extends SqlPluginContext {
  settings?: {
    configure?(presentation: { auto: boolean }, owner?: unknown): void
    update?(ns: string, patch: Record<string, unknown>): Promise<unknown>
  }
  fiber?: unknown
  effect?(callback: () => unknown, label?: string): unknown
}

/**
 * 工具输出的统一外壳：`sql_settings` 与 `sql_env_use` 共用。
 *
 * ⚠ **`output.schema` 里不能写 `required`** —— 宿主的 `compileValueSchema` 用的是
 * `allowRequired: false`（返回值 schema 只描述形状，不强制字段）。
 * 写了会抛 `JsonSchemaError: schema.required is not supported by the value schema DSL`。
 *
 * ⚠ 也不能写空节点（`items: {}` 这种）—— 宿主会 `assertSupportedJsonSchema` 拦下。
 *   "任意值"要写作者侧的 `{ type: 'json' }`。
 */
const TEXT_OUTPUT: ToolOutput<{ report: string }> = {
  schema: {
    type: 'object',
    properties: { report: { type: 'string' } },
    additionalProperties: false,
  },
  render: (_args: unknown, value: unknown) => [
    { type: 'text', text: String((value as { report?: string })?.report ?? '') },
  ],
}

/**
 * 读出当前生效的配置对象。
 *
 * Cordis 把条目的 config 交给 `apply(ctx, config)`，而 `.volatile()` 声明的字段
 * 是**响应式的**：配置对象上报一个 `get()`，取它才拿到当前值。宿主改完配置
 * （设置页保存 → 写 patch → Loader 热重载）之后，这里读到的就是新值。
 *
 * ⚠ 必须**每次调用时现取**，不能在 `apply` 里取一次存起来：存下来就变成
 *   "改了要重启"的旧行为，而且症状是静默的（工具照常工作，只是永远用旧值）。
 *
 * ⚠ 也不能回退到读 `$DSH_HOME/sql/settings.json` —— 那会造成两套数据源。
 *   真出过这个问题：设置页显示 5 个连接（读 patch），而工具有的是空配置（读文件）。
 */
function configReader(config: unknown): () => SqlSettings {
  return () => normalizeSettings(readConfigValue(config))
}

/** 从 `apply` 收到的 config 里取出普通对象（`.volatile()` 的要调 `.get()`）。 */
function readConfigValue(config: unknown): unknown {
  const c = config as { get?: () => unknown } | undefined
  if (c !== null && typeof c === 'object' && typeof c.get === 'function') return c.get()
  return config ?? {}
}

/**
 * 插件入口 —— 宿主把配置当**第二个参数**传进来（`apply(ctx, config)`）。
 *
 * 配置全程走宿主：读是 `configReader`（每次现取），写是设置页 → `settings.update`。
 * 插件自己**不碰任何配置文件** —— 校验、原子写、热重载都是宿主的活。
 */
export function apply(ctx: SqlPluginContext, config?: unknown): void {
  const getConfig = configReader(config)

  const { tools, adapters } = buildSqlTools(getConfig)
  const allTools = [...buildSettingsTools(getConfig), ...tools]

  const disposers: Array<() => void> = []
  for (const definition of allTools) {
    disposers.push(ctx.tools.register(definition))
  }
  ctx.on('dispose', () => {
    for (const dispose of disposers) dispose()
    for (const adapter of adapters.values()) void adapter.close()
  })

  // `sql_env_use` 注册在 settings 子级里 —— 它是**唯一**会写配置的工具，而要写就必须
  // 有 settings 服务。放在子级里，服务不在时这个工具干脆不存在（而不是存在但一调就炸）。
  //
  // ⚠ `ctx.inject(deps, cb)` 在 Cordis 里就是 `ctx.plugin({ inject, apply })`，
  //   也就是**起了一个子插件**：依赖的服务一变，旧 fiber 销毁、新 fiber 重跑回调，
  //   而销毁会连带清理这个子级名下的注册。所以这里**不进 `disposers`** ——
  //   交给 Cordis 比我们自己记账可靠（`sql_env_use` 的回调可能晚于 `apply` 末尾那行
  //   `ctx.on('dispose', …)`，那时 `disposers` 已经被清空）。
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect?.(
      () => settingsCtx.settings?.configure?.({ auto: false }),
      'sql: settings presentation',
    )

    settingsCtx.tools.register(defineTool({
      name: 'sql_env_use',
      // 描述与 dsh-api-call 的 `api_env_use` **逐字一致** —— 两个插件的「切环境」是同一
      // 件事，说法不一致会让模型以为是两种操作。参数同理：只有名字，不带说明。
      description:
        '切换当前环境，⚠ **仅当用户明确要求时才调用 —— 不得自行判断、不得主动调用。**',
      parameters: {
        env: { type: 'string', required: true },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        // `env` 的类型由 `defineTool` 校验保证（必填 string），这里只做 trim ——
        // "空字符串算没给"是**业务语义**，归这一层判。
        const envName = String(args.env ?? '').trim()
        if (!envName) throw new Error('缺少 env（环境名）。先用 sql_settings 看可选值。')

        // 先确认这个名字真的存在 —— 报错格式跟「⚠ 问题」节保持一致（都列可选值），
        // 否则同一件事会有两套说法。
        const available = environmentNames(getConfig())
        if (!available.includes(envName)) {
          throw new Error(
            '未知环境 "' + envName + '"，可选: ' + (available.length > 0 ? available.join(', ') : '（空）') +
            '。要新增环境请在插件设置页添加。',
          )
        }

        // `update` 是**深合并**：只给 activeEnv，别的字段一个都不碰。
        //
        // ⚠ 不传 expectedRevision：那是"读-改-写"用的乐观锁，而这里改的是**单字段**、
        //   而且是"设成某个值"这种幂等操作 —— 拿旧 revision 反而会让"设置页刚存完
        //   我又切一下"这种正常操作被拒。
        await settingsCtx.settings?.update?.('sql', { activeEnv: envName })

        return { report: '已切到环境 "' + envName + '"。已写进配置，下次调用生效。' }
      },
      timeoutMs: 10000,
    }))
  })
}

export * from './adapters.js'
export * from './config.js'
export * from './config-schema.js'
export * from './settings.js'
export * from './settings-tools.js'
export * from './sql-lex.js'
export * from './tool-kit.js'
export * from './tools.js'

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
export const Config: Schema = ConfigSchema
