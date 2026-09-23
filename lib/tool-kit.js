/**
 * 工具定义的公共零件：类型、参数编译与入参读取辅助。
 * 供 tools.ts（数据库操作）与 settings-tools.ts（配置管理）共用。
 *
 * @module dsh-sql/tool-kit
 */
/** 把「字段名 → { type, required, description }」的简表编译成 JSON Schema。 */
export function compileParameters(spec) {
    const properties = {};
    const required = [];
    for (const [key, prop] of Object.entries(spec)) {
        if (prop?.required === true)
            required.push(key);
        const node = {};
        if (typeof prop?.type === 'string')
            node.type = prop.type;
        else if (Array.isArray(prop?.type) && prop.type.length > 0)
            node.type = prop.type;
        if (typeof prop?.description === 'string')
            node.description = prop.description;
        properties[key] = node;
    }
    return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}
/** 安全地把入参当对象读。 */
export function asRecord(value) {
    return typeof value === 'object' && value !== null ? value : {};
}
/** 读一个可选的非空字符串参数。 */
export function optionalString(args, key) {
    const value = args[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
/** 读一个必填的非空字符串参数。 */
export function requiredString(args, key, label) {
    const value = optionalString(args, key);
    if (value === undefined)
        throw new Error(label + '（参数 ' + key + '）为必填，请提供非空字符串。');
    return value;
}
/** 从 Harness 的执行上下文里取取消信号。 */
export function executionSignal(exec) {
    if (typeof exec !== 'object' || exec === null)
        return undefined;
    const signal = exec.signal;
    return signal instanceof AbortSignal ? signal : undefined;
}
/** 文本型工具的统一输出外壳。 */
export const textOutput = {
    schema: {
        type: 'object',
        additionalProperties: false,
        properties: { report: { type: 'string' } },
    },
    render: (_args, value) => {
        return [{ type: 'text', text: asRecord(value).report }];
    },
};
/** 所有配置管理工具共用的告诫语。 */
export const CONFIG_WRITE_WARNING = '⚠ **仅当用户明确要求时才调用 —— 不得自行判断、不得主动调用。**';
