import { type SqlSettings, type ResolvedSqlSettings } from './config.js';
/** 设置文件名。 */
export declare const SETTINGS_FILE_NAME = "settings.json";
/** 覆盖设置文件目录的环境变量（测试隔离用，避免碰真实 $DSH_HOME）。 */
export declare const SETTINGS_DIR_ENV = "DSH_SQL_SETTINGS_DIR";
/** 插件数据目录；`DSH_SQL_SETTINGS_DIR` 可整体覆盖。 */
export declare function pluginDataDir(env?: NodeJS.ProcessEnv): string;
/** 设置文件路径。 */
export declare function settingsFile(env?: NodeJS.ProcessEnv): string;
/** 原子写 JSON：先写临时文件再 rename，避免留下半截文件。 */
export declare function writeJsonAtomic(file: string, value: unknown): void;
/**
 * 规范化设置：只保留已知字段。
 *
 * 返回的是**剔除未知字段后的原值**，不是 `resolveSettings` 的结果 —— 后者会给缺省字段
 * 兜底（file 补 `:memory:` 等），拿它写盘会让「显式清空某字段」失效。
 */
export declare function normalizeSettings(raw: unknown): SqlSettings;
/** 出厂设置：字段按 `SqlSettings` 最新定义**全部显式写出**，作为可直接照改的样例。 */
export declare function defaultSettings(): SqlSettings;
/** 读设置的结果。 */
export interface LoadedSettings {
    settings: SqlSettings;
    /** 解析后的权威设置（含兜底连接与钳制后的数值）。 */
    resolved: ResolvedSqlSettings;
    file: string;
    /** 本次调用是否新建了文件（首次生成出厂设置）。 */
    created: boolean;
}
/**
 * 读设置；文件不存在就写一份出厂设置再返回。
 *
 * 每次调用都重新读盘 —— 换来的「改动下一次调用必然生效」不需要任何刷缓存逻辑。
 * 文件坏了直接抛错（给路径与原因），不静默回退，否则会被误当成「配置没生效」。
 */
export declare function loadSettings(env?: NodeJS.ProcessEnv): LoadedSettings;
/** 原子写回设置。调用方负责先 `normalizeSettings` 校验。 */
export declare function saveSettings(settings: SqlSettings, env?: NodeJS.ProcessEnv): string;
