import { type SqlToolDefinition } from './tool-kit.js';
/** 可被 sql_config_set 修改的全局字段及其范围。 */
export declare const CONFIG_LIMITS: {
    readonly maxRows: {
        readonly min: 1;
        readonly max: 10000;
        readonly label: "查询返回行数上限";
    };
};
/** 构建四个配置管理工具。 */
export declare function buildSettingsTools(): SqlToolDefinition[];
