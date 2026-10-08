/**
 * 工具定义与入参读取的**辅助零件**。
 *
 * 工具定义本身用宿主的 `defineTool`（见 `@deepseek-ai/dsh-tools`），这里**不再自造**
 * `SqlToolDefinition` / `compileParameters` / `textOutput` 那一套 —— 自己造的 schema
 * 不会被宿主校验，等于白写：`defineTool` 会在 `execute` 之前按 `parameters` 校验入参，
 * 不通过直接抛 `ToolArgsError`；手写的那套只能靠各工具自己兜。
 *
 * ## 校验分三层（跟 dsh-api-call 一致，别混）
 *
 *  ① **入参形状**（类型、必填）→ `defineTool` 的 `parameters` 简表，**自动**校验。
 *     `execute` 里**不要**再写一遍"缺了就抛"。
 *  ② **业务语义**（如"api 只能是路径不能是完整 URL"、超时必须是正数）→ `execute` 里手写。
 *  ③ **配置完整性**（activeEnv 得命中某个环境、连接的 env 在不在清单里）→
 *     `sql_settings` 的「⚠ 问题」节，那才是发现这类错误的渠道。
 *
 * 这个文件里留下的都是第 ①② 层用得上的：安全读入参、取取消信号、认中止错误、超时文案。
 *
 * @module dsh-sql/tool-kit
 */
/**
 * 安全地把入参当对象读。
 *
 * `defineTool` 已经保证了形状，但 `execute` 的 `args` 类型是它推断出来的，
 * 这里再兜一层是为了让"读一个可能不存在的键"不用到处写断言。
 */
export declare function asRecord(value: unknown): Record<string, unknown>;
/** 读一个可选的非空字符串参数。 */
export declare function optionalString(args: Record<string, unknown>, key: string): string | undefined;
/** 读一个必填的非空字符串参数。 */
export declare function requiredString(args: Record<string, unknown>, key: string, label: string): string;
/** 从 Harness 的执行上下文里取取消信号。 */
export declare function executionSignal(exec: unknown): AbortSignal | undefined;
/**
 * 判断一个错误是否是中止（超时 / 取消）导致的。
 *
 * **不能拿 message 做子串匹配** —— 那样 `no such table: abort_log` 这类普通错误
 * 会被误判成超时，进而被套上「禁止重试，请与用户确认」，把 agent 的自愈路径掐死。
 * 只认明确的信号：`name === 'AbortError'` 或 `code === 'ABORT_ERR'`。
 */
export declare function isAbortError(error: unknown): boolean;
/**
 * 查询超时的提示：点明这是工具护栏（不是环境不稳），并给出「可有限重试」的边界。
 *
 * 只指出问题与边界，**不给具体手段** —— 列一堆招法反而会把思路钉死。
 */
export declare function queryTimeoutError(seconds: number, sql: string): Error;
/**
 * 写操作超时的提示：**禁止重试** —— 超时只说明本端不再等待，
 * 服务端可能仍在执行、也可能已经提交，重跑有把变更做两遍的风险。
 */
export declare function execTimeoutError(seconds: number, sql: string): Error;
