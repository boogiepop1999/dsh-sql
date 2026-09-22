/**
 * dsh-sql 设置解析与校验：类型即 `$DSH_HOME/sql/settings.json` 的形状。
 *
 * @module dsh-sql/config
 */
const ENGINES = ['sqlite', 'mysql', 'postgres'];
/** 连接密码环境变量名：DSH_SQL_PASSWORD_<NAME 大写>。 */
export function passwordEnvName(name) {
    return 'DSH_SQL_PASSWORD_' + name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}
/** description 字段最大长度，超出截断。 */
export const DESCRIPTION_MAX_LENGTH = 100;
/**
 * 解析并校验设置；无连接时给一个内存 SQLite 兜底连接。
 */
export function resolveSettings(settings, env = process.env) {
    const cfg = settings ?? {};
    const rawConnections = Array.isArray(cfg.connections) ? cfg.connections : [];
    const connections = [];
    const seen = new Set();
    for (const raw of rawConnections) {
        if (typeof raw !== 'object' || raw === null)
            continue;
        const name = typeof raw.name === 'string' ? raw.name.trim() : '';
        if (name === '')
            throw new Error('connections 里每个连接都需要 name 字段。');
        if (seen.has(name.toLowerCase()))
            throw new Error('连接名重复：' + name + '。');
        seen.add(name.toLowerCase());
        const engine = raw.engine;
        if (!ENGINES.includes(engine))
            throw new Error('连接 ' + name + ' 的 engine 必须是 sqlite / mysql / postgres 之一。');
        const connection = { name, engine: engine };
        connection.readOnly = raw.readOnly === true;
        if (typeof raw.description === 'string' && raw.description.trim() !== '') {
            connection.description = raw.description.trim().slice(0, DESCRIPTION_MAX_LENGTH);
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
            // PostgreSQL 必须指定库；MySQL 的 database 可选（不填即不指定默认库，可用全限定名查询）。
            if (connection.engine === 'postgres' && connection.database === '') {
                throw new Error('连接 ' + name + '（postgres）缺少 database 字段。');
            }
        }
        connections.push(connection);
    }
    if (connections.length === 0) {
        connections.push({ name: 'default', engine: 'sqlite', file: ':memory:', readOnly: false });
    }
    let maxRows = 1000;
    if (cfg.maxRows !== undefined) {
        if (typeof cfg.maxRows !== 'number' || !Number.isInteger(cfg.maxRows) || cfg.maxRows <= 0)
            throw new Error('maxRows 必须是大于 0 的整数。');
        maxRows = Math.min(10000, cfg.maxRows);
    }
    let queryTimeoutMs = 60000;
    if (cfg.queryTimeoutMs !== undefined) {
        if (typeof cfg.queryTimeoutMs !== 'number' || !Number.isFinite(cfg.queryTimeoutMs) || cfg.queryTimeoutMs <= 0)
            throw new Error('queryTimeoutMs 必须是大于 0 的数字（毫秒）。');
        queryTimeoutMs = Math.min(600000, Math.max(5000, Math.round(cfg.queryTimeoutMs)));
    }
    let execTimeoutMs = 120000;
    if (cfg.execTimeoutMs !== undefined) {
        if (typeof cfg.execTimeoutMs !== 'number' || !Number.isFinite(cfg.execTimeoutMs) || cfg.execTimeoutMs <= 0)
            throw new Error('execTimeoutMs 必须是大于 0 的数字（毫秒）。');
        execTimeoutMs = Math.min(600000, Math.max(5000, Math.round(cfg.execTimeoutMs)));
    }
    return { connections, maxRows, queryTimeoutMs, execTimeoutMs };
}
/** 校验表名/标识符，防注入到 schema 语句。 */
export function assertIdentifier(name, label) {
    const trimmed = name.trim();
    if (!/^[A-Za-z0-9_$]+$/.test(trimmed)) {
        throw new Error(label + ' 非法（只允许字母/数字/下划线/美元符）：' + name);
    }
    return trimmed;
}
