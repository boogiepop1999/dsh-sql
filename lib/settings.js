/**
 * 规范化配置：**只查顶层形状 + 剔未知字段**，不管内部字段的对错。
 *
 * 值的来源是宿主的文档（可能缺字段、可能带我们不认识的键），所以这一步是必要的收口：
 * 把"不是我们的字段"滤掉，把"必须存在的容器"补齐。
 *
 * **没有 trim、没有类型过滤、不补标量默认值** —— 补默认值会让"未设置"与"设成了默认值"
 * 变得无法区分，而报告里恰恰要区分这两件事（见 `sql_settings` 末尾的「⚠ 问题」节）。
 * 标量的缺省由 `src/config-schema.ts` 的 `.default()` 在**保存时**完成，
 * 跟这里读取时的形状收口不是一回事。
 *
 * ⚠ `environments` **只认「id → { name }」的新形状**，不接受 0.4.x 的 `string[]`。
 *   数组只能整组替换，而设置页要用深路径 op 增删改单个环境（见 config-schema.ts）。
 *   旧形状在这里被拦下并指出该怎么改，而不是静默转一份出来 —— 转出来的 id 是随机的，
 *   用户下次打开设置页会看到一堆不认识的键，反而更迷惑。
 */
export function normalizeSettings(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('配置顶层必须是一个对象。');
    }
    const source = raw;
    const out = {};
    if (source.activeEnv !== undefined)
        out.activeEnv = source.activeEnv;
    if (source.environments !== undefined) {
        if (typeof source.environments !== 'object' || source.environments === null || Array.isArray(source.environments)) {
            throw new Error('environments 必须是「id → { name }」的对象，收到 ' + JSON.stringify(source.environments) + '。' +
                (Array.isArray(source.environments)
                    ? '（这是 0.4.x 的旧形状；请在插件设置页重新添加这些环境，或手改配置）'
                    : ''));
        }
        out.environments = source.environments;
    }
    if (source.connections !== undefined) {
        if (typeof source.connections !== 'object' || source.connections === null || Array.isArray(source.connections)) {
            throw new Error('connections 必须是一个对象（键即连接名）。');
        }
        out.connections = source.connections;
    }
    else {
        // 缺失时兜底成空对象 —— 下游到处写 `settings.connections[name]`，undefined 会直接崩
        out.connections = {};
    }
    if (source.maxRows !== undefined)
        out.maxRows = source.maxRows;
    return out;
}
/**
 * 出厂配置 —— 字段按 `SqlSettings` 定义**全部显式写出**，作为可直接照改的样例。
 *
 * 必须与 `src/config-schema.ts` 的 `.default()` 一致（`SQL_CONFIG_DEFAULTS` 就是
 * 给这条约束做漂移检测用的）：一处改了另一处忘改，症状是"文件不存在的首次运行"
 * 与"表单重置"给出不同结果。
 *
 * **环境与连接一律留空**：这两个是部署细节，塞占位数据只会让人先做一轮"清理"
 * 而不是"配置"，而且假地址真会被误当能用的东西。
 */
export function defaultSettings() {
    return {
        activeEnv: '',
        environments: {},
        connections: {},
        maxRows: 1000,
    };
}
