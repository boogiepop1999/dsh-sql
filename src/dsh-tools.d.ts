/**
 * `@deepseek-ai/dsh-tools` 的最小类型声明。
 *
 * ## 为什么要手写这一份
 *
 * 宿主的包里 `package.json` 声明了 `"types": "lib/types/index.d.ts"`，但那个文件
 * **实际没有发布**（`files` 里列了，装出来的包里却没有）。所以 TS 项目 import 它会报
 * `Cannot find module '@deepseek-ai/dsh-tools'`。
 *
 * ## 为什么不用 `as any` 糊过去
 *
 * `defineTool` 的价值有一半在**类型**上：`execute(args)` 能推出 `args.sql` 是
 * `string`、`args.connection` 是 `string | undefined`。糊成 `any` 就白切了。
 *
 * ## ⚠ 这份声明是**照宿主实现写的**，不是抄的官方类型
 *
 * 依据是 `lib/index.js` 里的实现（`defineTool` 与 `runSchemaCompiler`）。所以：
 *
 *   - 只声明 ==本项目用到的部分==，宁可窄不要错
 *   - **宿主接口若变了，这里不会报错** —— 升级 DSH 后要回头看这个文件
 *
 * 三处关键事实（从实现里读出来的）：
 *   1. `parameters` 是**参数简表**（字段名 → 描述节点），由
 *      `parameterSchemaSpecToJsonSchema` 编译成 JSON Schema，**并据此在 execute 前校验**
 *   2. `output.schema` 用同一套作者节点，但 **`allowRequired: false`**（不能写 required）
 *   3. `execute(args, exec)` 收到的 `args` 已经过校验，`exec.signal` 是取消信号
 *
 * @module @deepseek-ai/dsh-tools (ambient)
 */
declare module '@deepseek-ai/dsh-tools' {
  /** JSON Schema 支持的基础类型（见宿主的 `SCHEMA_TYPES`）。 */
  export type SchemaType =
    | 'object'
    | 'array'
    | 'string'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'null'

  /**
   * 作者侧的 schema 节点。
   *
   * 允许的约束关键字与注释关键字取自宿主的 `CONSTRAINT_KEYWORDS` / `ANNOTATION_KEYWORDS`；
   * `json` 是作者侧特有的宽松类型（编译成"只带注释"的 schema）。
   */
  export interface AuthorSchema {
    type?: SchemaType | 'json' | readonly SchemaType[]
    description?: string
    title?: string
    default?: unknown
    examples?: readonly unknown[]
    enum?: readonly unknown[]
    const?: unknown
    /** 子属性（`type: 'object'` 时）。 */
    properties?: Record<string, AuthorSchema>
    /** 必填字段名（`type: 'object'` 时；`output.schema` 里不允许）。 */
    required?: readonly string[]
    additionalProperties?: boolean | AuthorSchema
    /** 数组元素（`type: 'array'` 时）。 */
    items?: AuthorSchema
    oneOf?: readonly AuthorSchema[]
  }

  /** 一个参数：`required: true` 表示必填（会被收进 JSON Schema 的 `required`）。 */
  export interface ParameterSpec extends AuthorSchema {
    required?: boolean
  }

  /** 模型可见的内容块。 */
  export interface ContentBlock {
    type: 'text'
    text: string
  }

  /** `execute` 收到的执行上下文。 */
  export interface ToolExecution {
    /** 取消信号（超时 / 用户中断）。 */
    signal?: AbortSignal
  }

  /** 工具的输出声明：`schema` 描述返回值，`render` 把它转成内容块。 */
  export interface ToolOutput<Value = unknown> {
    schema: AuthorSchema
    render(args: unknown, value: Value): ContentBlock[]
  }

  /** `defineTool` 的入参（本插件用到的部分）。 */
  export interface ToolOptions<Args = Record<string, unknown>, Value = unknown> {
    name: string
    description: string
    parameters: Record<string, ParameterSpec>
    output: ToolOutput<Value>
    execute(args: Args, exec: ToolExecution): Promise<unknown>
    timeoutMs?: number
    isConcurrencySafe?(args: Args): boolean
  }

  /** `defineTool` 的产物 —— 可直接交给 `ctx.tools.register`。 */
  export interface DefinedTool {
    name: string
    description: string
    parameters: unknown
    output: unknown
    execute(args: unknown, exec: unknown): Promise<unknown>
    timeoutMs?: number
    isConcurrencySafe?(args: unknown): boolean
  }

  /**
   * 定义一个工具：把参数简表编译成 JSON Schema，**并在 `execute` 之前校验入参**。
   *
   * 校验不通过会抛 `ToolArgsError`（`code: 'INVALID_ARGS'`），所以 `execute` 里
   * **不要**再写一遍"缺了就抛"。
   */
  export function defineTool<Args = Record<string, unknown>, Value = unknown>(
    options: ToolOptions<Args, Value>,
  ): DefinedTool
}
