/**
 * 配置报告工具：`sql_settings`。
 *
 * 配置编辑统一走**插件设置页**（见 config-schema.ts），所以这里只剩**只读报告** ——
 * 它的「⚠ 问题」节是发现配置错误的主要渠道：设置页只保证形状（schema），
 * "activeEnv 得命中某个环境的名字"这类跨字段规则只能在运行时判。
 *
 * @module dsh-sql/settings-tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  environmentNames,
  invalidReadOnly,
  isReadOnly,
  requireMaxRows,
  splitConnectionsByEnv,
  type SqlConnectionConfig,
  type SqlSettings,
} from './config.js'
import { asRecord } from './tool-kit.js'

/** `defineTool` 产出的工具定义 —— 类型从宿主推断（见 tools.ts 的同类说明）。 */
type SqlToolDefinition = ReturnType<typeof defineTool>

/** 表格单元格：转义 `|` 以免撑坏 Markdown 表。 */
function cell(text: unknown): string {
  return String(text ?? '').replace(/\|/g, '\\|')
}

/**
 * 表格里**所有空值统一显示成这一个词**。
 *
 * 从前这里好几种写法（未设置 / 空）混着用，同一张表里"空"要被认出好几遍。
 * 现在只留一词：表格如实说"这里是空的"，该怎么办交给「⚠ 问题」节。
 */
const EMPTY = '（空）'

/**
 * 构建配置报告工具。
 *
 * `getConfig` 由 `apply` 注入（`configReader(config)`），**每次调用时现取** ——
 * 配置编辑在设置页，改完下一次调用就生效。
 */
export function buildSettingsTools(getConfig: () => SqlSettings): SqlToolDefinition[] {
  const sqlSettings = defineTool({
    name: 'sql_settings',
    description:
      '总览：连接名清单 + 全局设置。\n' +
      '报告已是 Markdown，直接粘进正文渲染。配置改完立即生效，不用重启。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: { report: { type: 'string' } },
        additionalProperties: true,
      },
      render: (_args: unknown, value: unknown) => [
        { type: 'text', text: String(asRecord(value).report ?? '') },
      ],
    },
    async execute() {
      // 配置由宿主 settings 服务提供（`apply` 注入的 `getConfig`）。**每次现取**，
      // 所以设置页改完下一次调用就生效。
      //
      // 「值不对」（没配 activeEnv、环境清单为空、readOnly 写成了字符串）是正常的
      // 中间状态 —— 照常出报告，在末尾的「⚠ 问题」节里逐项指路。
      // 那**是发现这类错误的主要渠道**：设置页只保证形状（schema），
      // "activeEnv 得命中某个环境的名字"这类跨字段规则只能在运行时判。
      const settings = getConfig()

      const lines: string[] = []

      const allConnections = settings.connections ?? {}
      const { available: inScope, excluded: outOfScope } = splitConnectionsByEnv(settings)
      // 字段都是可选的（手改配置可能缺），这里统一成"空串 / 空清单"再渲染。
      // 环境清单是「id → { name }」的字典，报告里认的是**名字** —— 用 `environmentNames` 摊平。
      const activeEnv = typeof settings.activeEnv === 'string' ? settings.activeEnv.trim() : ''
      const environments = environmentNames(settings)

      const head = activeEnv !== '' ? '当前环境 ' + activeEnv : '当前环境' + EMPTY
      lines.push('# dsh-sql — ' + head + '，' + String(Object.keys(inScope).length) + ' 个可见连接')
      lines.push('')
      // 环境单列一节、一行列出（跟 api-call 一致）：这一节只回答"有哪些环境、当前是哪个"，
      // 拿来做表格反而只剩一列，不如一行文字好读。
      lines.push('## 环境', environments.length > 0
        ? environments.map((name) => (name === activeEnv ? '**' + cell(name) + '** ← 当前' : cell(name))).join(' ｜ ')
        : EMPTY)
      lines.push('')
      lines.push('## 可见连接' + (activeEnv !== '' ? '（当前环境 ' + activeEnv + '）' : '（不限环境）'))
      lines.push('| 连接名 | 引擎 | 环境 | 只读 | 描述 |')
      lines.push('| --- | --- | --- | --- | --- |')
      for (const [name, connection] of Object.entries(inScope)) {
        // readOnly 值非法时表格里**只显示生效结果**（已按 fail-safe 算成只读）；
        // "值写错了"这件事本身是问题，放「⚠ 问题」节去说 —— 表格只陈述现状。
        const readOnlyCell = isReadOnly(connection) ? '🔒 是' : '否'
        // env 用 `||` 而不是 `??`：空串（以及只有空白）都算"不限环境"，与切分逻辑同一套规则。
        // 用 `??` 只兜 undefined/null，空串会渲染成一个空格子，看着像"漏填"。
        const envCell = typeof connection.env === 'string' ? connection.env.trim() : ''
        lines.push(
          '| ' + cell(name) +
          ' | ' + cell(connection.engine) +
          ' | ' + cell(envCell || '不限环境') +
          ' | ' + readOnlyCell +
          ' | ' + cell(connection.description ?? '') + ' |',
        )
      }
      const outOfScopeNames = Object.keys(outOfScope)
      if (outOfScopeNames.length > 0) {
        lines.push('')
        lines.push('其它环境的连接：' + outOfScopeNames.join('、'))
      }

      // 行数上限非法时报告还得打得开（让人看见问题），所以这里兜错误而不是让它抛。
      // 表格里那一格**只写生效结果**：非法时按出厂值算，具体错在哪放「⚠ 问题」节。
      let maxRowsValue: number | undefined
      let maxRowsError: string | undefined
      try {
        maxRowsValue = requireMaxRows(settings)
      } catch (error) {
        maxRowsError = error instanceof Error ? error.message : String(error)
      }

      lines.push('')
      // 当前环境与环境清单**不在这里重复**：上面「## 环境」一节已经说清了，
      // 全局设置这节只放"设置项"本身。
      lines.push('## 全局设置')
      lines.push('| 项 | 值 |')
      lines.push('| --- | --- |')
      lines.push('| 行数上限 | ' + (maxRowsValue !== undefined ? cell(String(maxRowsValue)) : EMPTY) + ' |')
      // 不写"配置文件"那一行了：配置编辑已经搬到插件设置页，落盘位置（profile 的
      // `cordis.patch.yml`）是宿主的内部实现，使用者要改就去设置页。
      lines.push('| 配置位置 | 插件设置页 |')

      // 问题集中放最后，逐项列出「缺什么 + 该调哪个工具」。
      //
      // ⚠ 这里只放**值不对**（没配、配错、指向了不存在的环境）。**格式坏了**
      // （文件不是合法 JSON）在前面就抛异常了，走不到这里。
      //
      // 配置编辑统一走**插件设置页**之后，就没有"写入侧把关"这回事了 ——
      // 设置页只保证形状（schema），"activeEnv 得命中某个环境的名字"这类跨字段规则
      // 只能在运行时判，所以这里的「问题」节是**主要的**发现渠道，不是兜底。
      const problems: string[] = []
      const envList = environments.length > 0 ? environments.join(', ') : EMPTY
      if (environments.length === 0) problems.push('environments 为空，请先在插件设置页添加环境。')
      if (activeEnv === '') {
        problems.push('activeEnv 未设置，请先在插件设置页指定当前环境（可选: ' + envList + '）。')
      } else if (!environments.includes(activeEnv)) {
        // 环境清单被改过（删掉了当前环境），而 activeEnv 还指着它
        problems.push(
          'activeEnv "' + activeEnv + '" 不在环境清单里（可选: ' + envList +
          '）：请在插件设置页把「当前环境」改成清单里的一个，或把它加回环境清单。',
        )
      }
      if (Object.keys(allConnections).length === 0) problems.push('还没有任何连接，请先在插件设置页添加。')
      // 连接的 env 指向清单外的环境：它在**任何**环境下都不会出现（既不是"不限环境"，
      // 也匹配不上 activeEnv），所以必须说出来 —— 否则这条连接就像凭空消失了。
      for (const [name, connection] of Object.entries(allConnections)) {
        const env = typeof connection?.env === 'string' ? connection.env.trim() : ''
        if (env === '' || environments.includes(env)) continue
        problems.push(
          '连接 "' + name + '" 的 env "' + env + '" 不在环境清单里（可选: ' + envList +
          '）：它在任何环境下都不会出现。请在插件设置页改掉，或把它加回环境清单。',
        )
      }
      // maxRows 非法：使用处（sql_query）会直接报错，这里先提一句，免得"查询全挂"来得突然
      if (maxRowsError !== undefined) problems.push(maxRowsError)
      // readOnly 值非法：生效值已按只读算（fail-safe），但必须说出来 ——
      // 否则表现只是"莫名其妙写不了"，没人想得到是值写错了。
      for (const [name, connection] of Object.entries(allConnections)) {
        const bad = invalidReadOnly(connection)
        if (bad === undefined) continue
        problems.push(
          '连接 "' + name + '" 的 readOnly 值非法（' + JSON.stringify(bad) +
          '），已按 true（只读）处理。要开写请在插件设置页改成布尔 false。',
        )
      }
      if (problems.length > 0) {
        lines.push('')
        lines.push('## ⚠ 问题')
        for (const problem of problems) lines.push('- ' + problem)
      }

      return { report: lines.join('\n') }
    },
    timeoutMs: 10000,
  })

  // ⚠ 三个配置工具（sql_config_set / sql_connection_set / sql_connection_remove）
  //   已删除 —— 配置编辑统一走**插件设置页**，与 dsh-api-call 保持一致。
  //   留给 AI 的唯一写操作是 `sql_env_use`（只切当前环境），见 index.ts。
  return [sqlSettings]
}
