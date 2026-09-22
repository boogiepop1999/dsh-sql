/**
 * 配置管理工具：sql_settings / sql_config_set / sql_connection_set / sql_connection_remove。
 *
 * 只管设置文件，不碰连接池。写操作一律「现读 → 改 → 校验 → 原子写回」。
 *
 * @module dsh-sql/settings-tools
 */
import {
  DESCRIPTION_MAX_LENGTH,
  resolveSettings,
  type ResolvedSqlSettings,
  type SqlConnectionConfig,
  type SqlSettings,
} from './config.js'
import { loadSettings, saveSettings, settingsFile } from './settings.js'
import {
  CONFIG_WRITE_WARNING,
  compileParameters,
  optionalString,
  requiredString,
  asRecord,
  textOutput,
  type SqlToolDefinition,
} from './tool-kit.js'

/** 可被 sql_config_set 修改的全局字段及其范围。 */
export const CONFIG_LIMITS = {
  maxRows: { min: 1, max: 10000, label: '查询返回行数上限' },
  queryTimeoutMs: { min: 5000, max: 600000, label: '查询超时（毫秒）' },
  execTimeoutMs: { min: 5000, max: 600000, label: '写操作超时（毫秒）' },
} as const

type ConfigKey = keyof typeof CONFIG_LIMITS

/** 把连接定义渲染成一行「名字（引擎 @ 目标）」+ 只读/描述标记。 */
function connectionTarget(connection: SqlConnectionConfig): string {
  if (connection.engine === 'sqlite') return connection.file ?? ':memory:'
  const database = connection.database !== undefined && connection.database !== '' ? connection.database : '（未指定）'
  return (connection.host ?? '') + '/' + database
}

/** 表格单元格：转义 `|` 以免撑坏 Markdown 表。 */
function cell(text: unknown): string {
  return String(text ?? '').replace(/\|/g, '\\|')
}

/** 读设置；坏了就把错误留给调用方（sql_settings 自己兜，写工具直接抛）。 */
function current(): { settings: SqlSettings; resolved: ResolvedSqlSettings; file: string } {
  const loaded = loadSettings()
  return { settings: loaded.settings, resolved: loaded.resolved, file: loaded.file }
}

/** 读 → 改 → 校验 → 原子写回。change 收到的是深拷贝，改完返回即可。 */
function mutate(change: (draft: SqlSettings) => SqlSettings): { settings: SqlSettings; file: string } {
  const { settings, file } = current()
  const draft = JSON.parse(JSON.stringify(settings)) as SqlSettings
  const next = change(draft)
  // 先构造一次完整设置（校验连接字段），再由 saveSettings 做权威校验与落盘。
  const validated = resolveSettings(next)
  saveSettings({ ...next, connections: validated.connections }, undefined)
  return { settings: next, file: settingsFile() }
}

/** 构建四个配置管理工具。 */
export function buildSettingsTools(): SqlToolDefinition[] {
  const sqlSettings: SqlToolDefinition = {
    name: 'sql_settings',
    description:
      '总览：连接清单 + 全局设置 + 配置目录。\n' +
      '报告是现成的 Markdown，**汇报时原样贴出**，别改写别压缩。\n' +
      '设置文件改动立即生效，不用重启。',
    parameters: compileParameters({}),
    output: {
      schema: {
        type: 'object',
        properties: { report: { type: 'string' } },
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: asRecord(value).report as string }],
    },
    async execute() {
      // 设置永远能读出来（读不出来也要让人看见问题），所以这里自己兜错误。
      let loaded: ReturnType<typeof loadSettings> | undefined
      let error: string | undefined
      try {
        loaded = loadSettings()
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught)
      }

      const lines: string[] = []
      const file = settingsFile()

      if (loaded === undefined) {
        lines.push('# dsh-sql — 设置不可用')
        lines.push('')
        lines.push('## ⚠ 问题')
        lines.push('- ' + String(error))
        lines.push('- 配置文件：`' + file + '`')
        return { report: lines.join('\n') }
      }

      const connections = loaded.resolved.connections
      lines.push('# dsh-sql — 共 ' + String(connections.length) + ' 个连接')
      lines.push('')
      lines.push('## 连接')
      lines.push('| 连接 | 引擎 | 目标 | 只读 | 描述 |')
      lines.push('| --- | --- | --- | --- | --- |')
      for (const connection of connections) {
        lines.push(
          '| ' + cell(connection.name) +
          ' | ' + cell(connection.engine) +
          ' | ' + cell(connectionTarget(connection)) +
          ' | ' + (connection.readOnly === true ? '🔒 是' : '否') +
          ' | ' + cell(connection.description ?? '') + ' |',
        )
      }

      lines.push('')
      lines.push('## 全局设置')
      lines.push('| 项 | 值 |')
      lines.push('| --- | --- |')
      lines.push('| 行数上限 | ' + String(loaded.resolved.maxRows) + ' |')
      lines.push('| 查询超时 | ' + String(loaded.resolved.queryTimeoutMs) + 'ms |')
      lines.push('| 写超时 | ' + String(loaded.resolved.execTimeoutMs) + 'ms |')
      lines.push('| 配置文件 | `' + cell(loaded.file) + '` |')

      return { report: lines.join('\n') }
    },
    timeoutMs: 10000,
  }

  const sqlConfigSet: SqlToolDefinition = {
    name: 'sql_config_set',
    description:
      '改全局设置：maxRows / queryTimeoutMs / execTimeoutMs，至少给一个。\n\n' + CONFIG_WRITE_WARNING,
    parameters: compileParameters({
      maxRows: { type: 'number', description: '查询返回行数上限（1-10000）。' },
      queryTimeoutMs: { type: 'number', description: '单次查询超时（毫秒，5000-600000）。' },
      execTimeoutMs: { type: 'number', description: '单次写操作超时（毫秒，5000-600000）。' },
    }),
    output: textOutput,
    async execute(rawArgs) {
      const args = asRecord(rawArgs)
      const keys = Object.keys(CONFIG_LIMITS) as ConfigKey[]
      if (keys.every((key) => args[key] === undefined)) {
        throw new Error('至少要给 ' + keys.join(' / ') + ' 之一。')
      }
      // 先做范围校验，把「能直接照做」的错误在写盘前抛出来。
      for (const key of keys) {
        const raw = args[key]
        if (raw === undefined) continue
        const limit = CONFIG_LIMITS[key]
        const value = Number(raw)
        if (!Number.isFinite(value) || value < limit.min || value > limit.max) {
          throw new Error(key + '（' + limit.label + '）必须是 ' + limit.min + '~' + limit.max + ' 之间的数字，收到 ' + JSON.stringify(raw) + '。')
        }
      }
      const { settings } = mutate((draft) => {
        for (const key of keys) {
          if (args[key] !== undefined) (draft as Record<string, unknown>)[key] = Number(args[key])
        }
        return draft
      })
      const changed = keys.filter((key) => args[key] !== undefined).map((key) => key + '=' + String((settings as Record<string, unknown>)[key]))
      return { report: '已更新设置：' + changed.join('，') }
    },
    timeoutMs: 10000,
  }

  const sqlConnectionSet: SqlToolDefinition = {
    name: 'sql_connection_set',
    description:
      '新增或覆盖一个连接（**完全覆盖，不做隐式合并** —— 没给的字段就按默认值走），先 sql_settings 看现值。\n' +
      'engine=sqlite 用 file；engine=mysql/postgres 用 host/port/user/password/database，其中 database 仅 postgres 必填。\n\n' +
      CONFIG_WRITE_WARNING,
    parameters: compileParameters({
      name: { type: 'string', required: true, description: '连接名。' },
      engine: { type: 'string', required: true, description: '引擎：sqlite / mysql / postgres。' },
      file: { type: 'string', description: 'engine=sqlite 时用：数据库文件路径，缺省 :memory:。' },
      host: { type: 'string', description: 'mysql / postgres 用：主机，缺省 localhost。' },
      port: { type: 'number', description: '端口，缺省 3306（mysql）/ 5432（postgres）。' },
      user: { type: 'string', description: '用户名。' },
      password: { type: 'string', description: '密码（明文存入设置文件）。' },
      database: { type: 'string', description: '库名。postgres 必填；mysql 可留空（不指定默认库）。' },
      readOnly: { type: 'boolean', description: '是否禁用该连接的写操作，缺省 false。' },
      description: { type: 'string', description: '连接用途说明（最长 ' + DESCRIPTION_MAX_LENGTH + ' 字符，超出截断）。' },
    }),
    output: textOutput,
    async execute(rawArgs) {
      const args = asRecord(rawArgs)
      const name = requiredString(args, 'name', '连接名')
      const engine = requiredString(args, 'engine', '引擎')
      if (engine !== 'sqlite' && engine !== 'mysql' && engine !== 'postgres') {
        throw new Error('engine 必须是 sqlite / mysql / postgres 之一，收到 ' + JSON.stringify(engine) + '。')
      }
      const entry: SqlConnectionConfig = { name, engine }
      if (args.readOnly !== undefined) entry.readOnly = args.readOnly === true
      if (optionalString(args, 'description') !== undefined) entry.description = optionalString(args, 'description')
      if (engine === 'sqlite') {
        if (optionalString(args, 'file') !== undefined) entry.file = optionalString(args, 'file')
      } else {
        if (optionalString(args, 'host') !== undefined) entry.host = optionalString(args, 'host')
        if (args.port !== undefined) entry.port = Number(args.port)
        if (optionalString(args, 'user') !== undefined) entry.user = optionalString(args, 'user')
        if (args.password !== undefined) entry.password = String(args.password)
        if (optionalString(args, 'database') !== undefined) entry.database = optionalString(args, 'database')
      }
      mutate((draft) => {
        const list = Array.isArray(draft.connections) ? draft.connections : []
        const index = list.findIndex((item) => typeof item?.name === 'string' && item.name.toLowerCase() === name.toLowerCase())
        if (index >= 0) list[index] = entry
        else list.push(entry)
        draft.connections = list
        return draft
      })
      return { report: '已写入连接 "' + name + '"（' + engine + '）。' }
    },
    timeoutMs: 10000,
  }

  const sqlConnectionRemove: SqlToolDefinition = {
    name: 'sql_connection_remove',
    description:
      '删除一个连接（连带关闭它的连接池），先 sql_settings 看现值。\n\n' + CONFIG_WRITE_WARNING,
    parameters: compileParameters({
      name: { type: 'string', required: true, description: '连接名。' },
    }),
    output: textOutput,
    async execute(rawArgs) {
      const name = requiredString(rawArgs !== null && typeof rawArgs === 'object' ? asRecord(rawArgs) : {}, 'name', '连接名')
      const { settings } = current()
      const list = Array.isArray(settings.connections) ? settings.connections : []
      const exists = list.some((item) => typeof item?.name === 'string' && item.name.toLowerCase() === name.toLowerCase())
      if (!exists) {
        const known = list.map((item) => item?.name).filter((item): item is string => typeof item === 'string')
        throw new Error('连接 "' + name + '" 不存在，可用：' + (known.length > 0 ? known.join('、') : '（空，用 sql_connection_set 添加）'))
      }
      mutate((draft) => {
        draft.connections = (draft.connections ?? []).filter(
          (item) => !(typeof item?.name === 'string' && item.name.toLowerCase() === name.toLowerCase()),
        )
        return draft
      })
      return { report: '已删除连接 "' + name + '"。' }
    },
    timeoutMs: 10000,
  }

  return [sqlSettings, sqlConfigSet, sqlConnectionSet, sqlConnectionRemove]
}
