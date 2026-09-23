/**
 * dsh-sql 设置：连接定义与全局项集中在一个文件里，**每次现读**（改完立即生效，不用重启）。
 *
 *   $DSH_HOME/sql/settings.json
 *
 * @module dsh-sql/settings
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveSettings, type SqlSettings, type SqlConnectionConfig, type ResolvedSqlSettings } from './config.js'

/** 设置文件名。 */
export const SETTINGS_FILE_NAME = 'settings.json'

/** 覆盖设置文件目录的环境变量（测试隔离用，避免碰真实 $DSH_HOME）。 */
export const SETTINGS_DIR_ENV = 'DSH_SQL_SETTINGS_DIR'

/** 解析 DSH_HOME（与 dsh 自身的约定一致）。 */
function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh')
}

/** 插件数据目录；`DSH_SQL_SETTINGS_DIR` 可整体覆盖。 */
export function pluginDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SETTINGS_DIR_ENV]?.trim()
  if (override !== undefined && override !== '') return override
  return join(resolveDshHome(env), 'sql')
}

/** 设置文件路径。 */
export function settingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(pluginDataDir(env), SETTINGS_FILE_NAME)
}

/** 原子写 JSON：先写临时文件再 rename，避免留下半截文件。 */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

/**
 * 规范化设置：只保留已知字段。
 *
 * 返回的是**剔除未知字段后的原值**，不是 `resolveSettings` 的结果 —— 后者会给缺省字段
 * 兜底（file 补 `:memory:` 等），拿它写盘会让「显式清空某字段」失效。
 */
export function normalizeSettings(raw: unknown): SqlSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(SETTINGS_FILE_NAME + ' 顶层必须是一个对象。')
  }
  const source = raw as Record<string, unknown>
  const out: SqlSettings = {}
  if (source.activeEnv !== undefined) out.activeEnv = source.activeEnv as string
  if (source.environments !== undefined) {
    if (!Array.isArray(source.environments)) throw new Error('environments 必须是一个数组。')
    out.environments = source.environments as string[]
  }
  if (source.connections !== undefined) {
    if (typeof source.connections !== 'object' || source.connections === null || Array.isArray(source.connections)) {
      throw new Error('connections 必须是一个对象（键即连接名）。')
    }
    out.connections = source.connections as Record<string, SqlConnectionConfig>
  }
  for (const key of ['maxRows', 'queryTimeoutMs', 'execTimeoutMs'] as const) {
    if (source[key] !== undefined) out[key] = source[key] as number
  }
  return out
}

/** 出厂设置：字段按 `SqlSettings` 最新定义**全部显式写出**，作为可直接照改的样例。 */
export function defaultSettings(): SqlSettings {
  return {
    activeEnv: '',
    environments: [],
    connections: {},
    maxRows: 1000,
    queryTimeoutMs: 60000,
    execTimeoutMs: 120000,
  }
}

/** 读设置的结果。 */
export interface LoadedSettings {
  settings: SqlSettings
  /** 解析后的权威设置（含兜底连接与钳制后的数值）。 */
  resolved: ResolvedSqlSettings
  file: string
  /** 本次调用是否新建了文件（首次生成出厂设置）。 */
  created: boolean
}

/**
 * 读设置；文件不存在就写一份出厂设置再返回。
 *
 * 每次调用都重新读盘 —— 换来的「改动下一次调用必然生效」不需要任何刷缓存逻辑。
 * 文件坏了直接抛错（给路径与原因），不静默回退，否则会被误当成「配置没生效」。
 */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): LoadedSettings {
  const file = settingsFile(env)

  if (!existsSync(file)) {
    const seeded = defaultSettings()
    writeJsonAtomic(file, seeded)
    return { settings: seeded, resolved: resolveSettings(seeded, env), file, created: true }
  }

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(file + ' 读不出来：' + (error instanceof Error ? error.message : String(error)))
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(
      file + ' 不是合法 JSON：' + (error instanceof Error ? error.message : String(error)) +
      '（修好它，或删掉让插件重新生成）',
    )
  }

  const settings = normalizeSettings(parsed)
  return { settings, resolved: resolveSettings(settings, env), file, created: false }
}

/** 原子写回设置。调用方负责先 `normalizeSettings` 校验。 */
export function saveSettings(settings: SqlSettings, env: NodeJS.ProcessEnv = process.env): string {
  const file = settingsFile(env)
  writeJsonAtomic(file, normalizeSettings(settings))
  return file
}
