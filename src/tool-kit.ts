/**
 * 工具定义的公共零件：类型、参数编译与入参读取辅助。
 * 供 tools.ts（数据库操作）与 settings-tools.ts（配置管理）共用。
 *
 * @module dsh-sql/tool-kit
 */

/** 模型可见的内容块。 */
export interface ContentBlock {
  type: 'text'
  text: string
}

/** 注册给 ctx.tools.register 的原始工具定义。 */
export interface SqlToolDefinition {
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): ContentBlock[]
  }
  execute(args: unknown, exec: unknown): Promise<unknown>
  timeoutMs?: number
}

/** 参数字段简表的一项。 */
export interface ParameterSpec {
  type?: string
  required?: boolean
  description?: string
}

/** 把「字段名 → { type, required, description }」的简表编译成 JSON Schema。 */
export function compileParameters(spec: Record<string, ParameterSpec>): { type: 'object'; properties: Record<string, unknown>; required?: string[] } {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, prop] of Object.entries(spec)) {
    if (prop?.required === true) required.push(key)
    const node: Record<string, unknown> = {}
    if (typeof prop?.type === 'string') node.type = prop.type
    if (typeof prop?.description === 'string') node.description = prop.description
    properties[key] = node
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
}

/** 安全地把入参当对象读。 */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/** 读一个可选的非空字符串参数。 */
export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 读一个必填的非空字符串参数。 */
export function requiredString(args: Record<string, unknown>, key: string, label: string): string {
  const value = optionalString(args, key)
  if (value === undefined) throw new Error(label + '（参数 ' + key + '）为必填，请提供非空字符串。')
  return value
}

/** 从 Harness 的执行上下文里取取消信号。 */
export function executionSignal(exec: unknown): AbortSignal | undefined {
  if (typeof exec !== 'object' || exec === null) return undefined
  const signal = (exec as { signal?: unknown }).signal
  return signal instanceof AbortSignal ? signal : undefined
}

/** 文本型工具的统一输出外壳。 */
export const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { report: { type: 'string' } },
  },
  render: (_args: unknown, value: unknown): ContentBlock[] => {
    return [{ type: 'text', text: asRecord(value).report as string }]
  },
}

/** 所有配置管理工具共用的告诫语。 */
export const CONFIG_WRITE_WARNING = '⚠ **仅当用户明确要求时才调用 —— 不得自行判断、不得主动调用。**'
