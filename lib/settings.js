/**
 * dsh-sql 设置：连接定义与全局项集中在一个文件里，**每次现读**（改完立即生效，不用重启）。
 *
 *   $DSH_HOME/sql/settings.json
 *
 * @module dsh-sql/settings
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/** 设置文件名。 */
export const SETTINGS_FILE_NAME = 'settings.json';
/** 覆盖设置文件目录的环境变量（测试隔离用，避免碰真实 $DSH_HOME）。 */
export const SETTINGS_DIR_ENV = 'DSH_SQL_SETTINGS_DIR';
/** 解析 DSH_HOME（与 dsh 自身的约定一致）。 */
function resolveDshHome(env = process.env) {
    return env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
}
/** 插件数据目录；`DSH_SQL_SETTINGS_DIR` 可整体覆盖。 */
export function pluginDataDir(env = process.env) {
    const override = env[SETTINGS_DIR_ENV]?.trim();
    if (override !== undefined && override !== '')
        return override;
    return join(resolveDshHome(env), 'sql');
}
/** 设置文件路径。 */
export function settingsFile(env = process.env) {
    return join(pluginDataDir(env), SETTINGS_FILE_NAME);
}
/** 原子写 JSON：先写临时文件再 rename，避免留下半截文件。 */
export function writeJsonAtomic(file, value) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    renameSync(tmp, file);
}
/**
 * 规范化设置：**只查顶层形状 + 剔未知字段**，不管内部字段的对错。
 *
 * 读与写都走这一份 —— **没有 trim、没有类型过滤、不补默认值**。这样"读到的"就是
 * "写入的"，不存在两套形状不同的数据（早先这里还有个 `resolveSettings` 专门给运行时
 * 做归一化，导致同一个文件读出来两个样子，已删）。
 *
 * 唯一替下游兜的是 `connections` 缺失时补 `{}` —— 下游到处写 `settings.connections[name]`，
 * undefined 会直接崩。
 *
 * 其余字段的兜底/校验都在**使用处**：`isReadOnly()` 按 fail-safe 判只读、
 * `requireMaxRows()` 校验行数上限、`resolveConnection()` 合流密码环境变量。
 */
export function normalizeSettings(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(SETTINGS_FILE_NAME + ' 顶层必须是一个对象。');
    }
    const source = raw;
    const out = {};
    if (source.activeEnv !== undefined)
        out.activeEnv = source.activeEnv;
    if (source.environments !== undefined) {
        if (!Array.isArray(source.environments))
            throw new Error('environments 必须是一个数组。');
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
/** 出厂设置：字段按 `SqlSettings` 最新定义**全部显式写出**，作为可直接照改的样例。 */
export function defaultSettings() {
    return {
        activeEnv: '',
        environments: [],
        connections: {},
        maxRows: 1000,
    };
}
/**
 * 读设置；文件不存在就写一份出厂设置再返回。
 *
 * 每次调用都重新读盘 —— 换来的「改动下一次调用必然生效」不需要任何刷缓存逻辑。
 * 文件坏了直接抛错（给路径与原因），不静默回退，否则会被误当成「配置没生效」。
 */
export function loadSettings(env = process.env) {
    const file = settingsFile(env);
    if (!existsSync(file)) {
        const seeded = defaultSettings();
        writeJsonAtomic(file, seeded);
        return { settings: seeded, file, created: true };
    }
    let text;
    try {
        text = readFileSync(file, 'utf8');
    }
    catch (error) {
        throw new Error(file + ' 读不出来：' + (error instanceof Error ? error.message : String(error)));
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        throw new Error(file + ' 不是合法 JSON：' + (error instanceof Error ? error.message : String(error)) +
            '（修好它，或删掉让插件重新生成）');
    }
    return { settings: normalizeSettings(parsed), file, created: false };
}
/** 原子写回设置。调用方负责先 `normalizeSettings` 校验。 */
export function saveSettings(settings, env = process.env) {
    const file = settingsFile(env);
    writeJsonAtomic(file, normalizeSettings(settings));
    return file;
}
