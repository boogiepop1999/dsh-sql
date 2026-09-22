/**
 * 工具定义的公共零件：类型、参数编译与入参读取辅助。
 * 供 tools.ts（数据库操作）与 settings-tools.ts（配置管理）共用。
 *
 * @module dsh-sql/tool-kit
 */
/** 模型可见的内容块。 */
export interface ContentBlock {
    type: 'text';
    text: string;
}
/** 注册给 ctx.tools.register 的原始工具定义。 */
export interface SqlToolDefinition {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
    output: {
        schema: Record<string, unknown>;
        render(args: unknown, value: unknown): ContentBlock[];
    };
    execute(args: unknown, exec: unknown): Promise<unknown>;
    timeoutMs?: number;
}
/** 参数字段简表的一项。 */
export interface ParameterSpec {
    type?: string;
    required?: boolean;
    description?: string;
}
/** 把「字段名 → { type, required, description }」的简表编译成 JSON Schema。 */
export declare function compileParameters(spec: Record<string, ParameterSpec>): {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
};
/** 安全地把入参当对象读。 */
export declare function asRecord(value: unknown): Record<string, unknown>;
/** 读一个可选的非空字符串参数。 */
export declare function optionalString(args: Record<string, unknown>, key: string): string | undefined;
/** 读一个必填的非空字符串参数。 */
export declare function requiredString(args: Record<string, unknown>, key: string, label: string): string;
/** 从 Harness 的执行上下文里取取消信号。 */
export declare function executionSignal(exec: unknown): AbortSignal | undefined;
/** 文本型工具的统一输出外壳。 */
export declare const textOutput: {
    schema: {
        type: string;
        additionalProperties: boolean;
        properties: {
            report: {
                type: string;
            };
        };
    };
    render: (_args: unknown, value: unknown) => ContentBlock[];
};
/** 所有配置管理工具共用的告诫语。 */
export declare const CONFIG_WRITE_WARNING = "\u26A0 **\u4EC5\u5F53\u7528\u6237\u660E\u786E\u8981\u6C42\u65F6\u624D\u8C03\u7528 \u2014\u2014 \u4E0D\u5F97\u81EA\u884C\u5224\u65AD\u3001\u4E0D\u5F97\u4E3B\u52A8\u8C03\u7528\u3002**";
