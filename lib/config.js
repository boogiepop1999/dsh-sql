/**
 * dsh-sql 设置解析与校验：类型即 `$DSH_HOME/sql/settings.json` 的形状。
 *
 * @module dsh-sql/config
 */
const ENGINES = ['sqlite', 'mysql', 'postgres'];
/**
 * 单次查询超时。**代码常量，不可配置** —— Harness 的 `timeoutMs` 在工具注册时求值一次，
 * 做成配置项就得重启才生效，与「改配置立即生效」冲突，因此定死。
 *
 * 30 秒是**护栏**不是「够用的上限」：走得通索引的查询秒级就回，走不通的 60 秒也回不来。
 * 早失败能让 agent 更快改换查法，而不是白等。
 */
export const QUERY_TIMEOUT_MS = 30000;
/**
 * 单次写操作超时。比查询更该早掐：正常写操作都是秒级，超过 30 秒的多半在等锁或动大表，
 * 让 agent 干等没意义，且等得越久越可能把一个大操作放跑完。
 */
export const EXEC_TIMEOUT_MS = 30000;
/**
 * `sql_stats` 专用超时 —— 它逐表跑 `COUNT(*)`，表一多就慢，
 * 跟「跑一条业务查询」不是一回事，因此单独放宽。
 *
 * 2 分钟够用：再大的库该按 schema 分批查，而不是靠调大超时硬扛。
 */
export const STATS_TIMEOUT_MS = 120000;
/** 连接密码环境变量名：DSH_SQL_PASSWORD_<NAME 大写>。 */
export function passwordEnvName(name) {
    return 'DSH_SQL_PASSWORD_' + name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}
/** description 字段最大长度，超出截断。 */
export const DESCRIPTION_MAX_LENGTH = 100;
/**
 * 解析设置：**只归一化，不校验**（校验在写入工具里做）。
 * 也**不补任何连接** —— 没配连接就是没有，由 sql_settings 在告警里指出来。
 */
export function resolveSettings(settings, env = process.env) {
    const cfg = settings ?? {};
    const activeEnv = typeof cfg.activeEnv === 'string' ? cfg.activeEnv.trim() : '';
    const environments = Array.isArray(cfg.environments)
        ? [...new Set(cfg.environments.filter((item) => typeof item === 'string').map((item) => item.trim()).filter((item) => item !== ''))]
        : [];
    const rawConnections = typeof cfg.connections === 'object' && cfg.connections !== null && !Array.isArray(cfg.connections)
        ? cfg.connections
        : {};
    const connections = [];
    for (const [name, raw] of Object.entries(rawConnections)) {
        if (typeof raw !== 'object' || raw === null)
            continue;
        const engine = raw.engine;
        const connection = { name, engine: engine };
        connection.readOnly = raw.readOnly === true;
        if (typeof raw.env === 'string' && raw.env.trim() !== '')
            connection.env = raw.env.trim();
        if (typeof raw.description === 'string' && raw.description.trim() !== '') {
            connection.description = raw.description.trim();
        }
        if (connection.engine === 'sqlite') {
            connection.file = typeof raw.file === 'string' && raw.file.trim() !== '' ? raw.file.trim() : ':memory:';
        }
        else {
            connection.host = typeof raw.host === 'string' && raw.host.trim() !== '' ? raw.host.trim() : 'localhost';
            connection.port = typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port > 0 ? raw.port : (connection.engine === 'postgres' ? 5432 : 3306);
            connection.user = typeof raw.user === 'string' && raw.user.trim() !== '' ? raw.user.trim() : '';
            connection.database = typeof raw.database === 'string' ? raw.database.trim() : '';
            const direct = typeof raw.password === 'string' ? raw.password.trim() : '';
            connection.password = direct !== '' ? direct : (env[passwordEnvName(name)]?.trim() ?? '');
        }
        connections.push(connection);
    }
    let maxRows = 1000;
    if (cfg.maxRows !== undefined)
        maxRows = Math.min(10000, Math.max(1, Math.round(cfg.maxRows)));
    return { activeEnv, environments, connections, maxRows };
}
/** 校验表名/标识符，防注入到 schema 语句。 */
export function assertIdentifier(name, label) {
    const trimmed = name.trim();
    if (!/^[A-Za-z0-9_$]+$/.test(trimmed)) {
        throw new Error(label + ' 非法（只允许字母/数字/下划线/美元符）：' + name);
    }
    return trimmed;
}
/**
 * 按 activeEnv 切分连接：能用的 / 不能用的。
 *
 * 匹配规则只有一条：`env` 为空的连接**任何环境都算可用**，否则要求 `env === activeEnv`。
 * 没匹配上的一律算「其它环境」。
 *
 * `activeEnv` 为空时没有连接能靠「环境名相同」匹配，因此只有 `env` 为空的那批可用 —— 与设了环境时同一套规则。
 */
export function splitConnectionsByEnv(settings) {
    const { activeEnv, connections } = settings;
    const available = [];
    const excluded = [];
    for (const connection of connections) {
        if (connection.env === undefined || connection.env === '')
            available.push(connection);
        else if (connection.env === activeEnv)
            available.push(connection);
        else
            excluded.push(connection);
    }
    return { available, excluded };
}
