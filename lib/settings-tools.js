/**
 * 配置管理工具：sql_settings / sql_config_set / sql_connection_set / sql_connection_remove。
 *
 * 只管设置文件，不碰连接池。写操作一律「现读 → 改 → 校验 → 原子写回」。
 *
 * @module dsh-sql/settings-tools
 */
import { DESCRIPTION_MAX_LENGTH, resolveSettings, } from './config.js';
import { loadSettings, saveSettings, settingsFile } from './settings.js';
import { CONFIG_WRITE_WARNING, compileParameters, requiredString, asRecord, textOutput, } from './tool-kit.js';
/** 可被 sql_config_set 修改的全局字段及其范围。 */
export const CONFIG_LIMITS = {
    maxRows: { min: 1, max: 10000, label: '查询返回行数上限' },
    queryTimeoutMs: { min: 5000, max: 600000, label: '查询超时（毫秒）' },
    execTimeoutMs: { min: 5000, max: 600000, label: '写操作超时（毫秒）' },
};
/** 表格单元格：转义 `|` 以免撑坏 Markdown 表。 */
function cell(text) {
    return String(text ?? '').replace(/\|/g, '\\|');
}
/** 连接表的类型守卫：必须是对象（键即连接名），不是数组。 */
function isConnectionTable(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** 读设置；坏了就把错误留给调用方（sql_settings 自己兜，写工具直接抛）。 */
function current() {
    const loaded = loadSettings();
    return { settings: loaded.settings, resolved: loaded.resolved, file: loaded.file };
}
/**
 * 读 → 改 → 校验 → 原子写回。change 收到的是深拷贝，就地改完返回即可。
 *
 * 关键：**校验用 resolveSettings，写盘用 draft 本身**，两者不能合并成一步。
 *
 * `resolveSettings` 会给缺省字段兜底（如 file 补 `:memory:`、database 补 `''`），
 * 若把它的返回值拿去写盘，「传 null 清空某字段」会被兜底值悄悄填回来 —— 清空失效，
 * 而且不报错。所以它只用来**判合法性**，不参与落盘。
 */
function mutate(change) {
    const { settings, file } = current();
    const draft = JSON.parse(JSON.stringify(settings));
    const next = change(draft);
    // 权威校验：字段非法在这里抛错，不落盘。
    resolveSettings(next);
    saveSettings(next, undefined);
    return { settings: next, file: settingsFile() };
}
/** 构建四个配置管理工具。 */
export function buildSettingsTools() {
    const sqlSettings = {
        name: 'sql_settings',
        description: '总览：连接名清单 + 全局设置。\n' +
            '报告是现成的 Markdown，**汇报时原样贴出**，别改写别压缩。',
        parameters: compileParameters({}),
        output: {
            schema: {
                type: 'object',
                properties: { report: { type: 'string' } },
                additionalProperties: true,
            },
            render: (_args, value) => [{ type: 'text', text: asRecord(value).report }],
        },
        async execute() {
            // 设置永远能读出来（读不出来也要让人看见问题），所以这里自己兜错误。
            let loaded;
            let error;
            try {
                loaded = loadSettings();
            }
            catch (caught) {
                error = caught instanceof Error ? caught.message : String(caught);
            }
            const lines = [];
            const file = settingsFile();
            if (loaded === undefined) {
                lines.push('# dsh-sql — 设置不可用');
                lines.push('');
                lines.push('## ⚠ 问题');
                lines.push('- ' + String(error));
                lines.push('- 配置文件：`' + file + '`');
                return { report: lines.join('\n') };
            }
            const { activeEnv, environments, connections: allConnections } = loaded.resolved;
            const connected = (conn) => conn.env === undefined || conn.env === '';
            // 当前环境的连接 + 无环境特征的连接（后者在哪都能用）
            const inScope = activeEnv === ''
                ? allConnections
                : allConnections.filter((conn) => connected(conn) || conn.env === activeEnv);
            const outOfScope = activeEnv === ''
                ? []
                : allConnections.filter((conn) => !connected(conn) && conn.env !== activeEnv);
            const head = activeEnv !== '' ? '当前环境 ' + activeEnv : '当前环境（未设置）';
            lines.push('# dsh-sql — ' + head + '，' + String(inScope.length) + ' / ' + String(allConnections.length) + ' 个连接');
            lines.push('');
            lines.push('## 连接' + (activeEnv !== '' ? '（当前环境可用）' : ''));
            lines.push('| 连接名 | 引擎 | 环境 | 只读 | 描述 |');
            lines.push('| --- | --- | --- | --- | --- |');
            for (const connection of inScope) {
                lines.push('| ' + cell(connection.name) +
                    ' | ' + cell(connection.engine) +
                    ' | ' + cell(connection.env ?? '--') +
                    ' | ' + (connection.readOnly === true ? '🔒 是' : '否') +
                    ' | ' + cell(connection.description ?? '') + ' |');
            }
            if (outOfScope.length > 0) {
                lines.push('');
                lines.push('其它环境的连接：' + outOfScope.map((conn) => conn.name).join('、'));
            }
            lines.push('');
            lines.push('## 全局设置');
            lines.push('| 项 | 值 |');
            lines.push('| --- | --- |');
            lines.push('| 当前环境 | ' + (activeEnv !== '' ? cell(activeEnv) : '（未设置）') + ' |');
            lines.push('| 环境清单 | ' + (environments.length > 0 ? environments.map(cell).join('、') : '（空）') + ' |');
            lines.push('| 行数上限 | ' + String(loaded.resolved.maxRows) + ' |');
            lines.push('| 查询超时 | ' + String(loaded.resolved.queryTimeoutMs) + 'ms |');
            lines.push('| 写超时 | ' + String(loaded.resolved.execTimeoutMs) + 'ms |');
            lines.push('| 配置文件 | `' + cell(loaded.file) + '` |');
            const problems = [];
            if (environments.length === 0)
                problems.push('environments 为空，请先用 sql_config_set 配置环境清单。');
            if (activeEnv === '')
                problems.push('activeEnv 未设置，请先用 sql_config_set 指定当前环境。');
            if (allConnections.length === 0)
                problems.push('还没有任何连接，请先用 sql_connection_set 添加。');
            if (problems.length > 0) {
                lines.push('');
                lines.push('## ⚠ 问题');
                for (const problem of problems)
                    lines.push('- ' + problem);
            }
            return { report: lines.join('\n') };
        },
        timeoutMs: 10000,
    };
    const sqlConfigSet = {
        name: 'sql_config_set',
        description: '改全局设置：activeEnv / environments / maxRows / queryTimeoutMs / execTimeoutMs，至少一个入参。改动重启 DSH 后生效。\n' +
            CONFIG_WRITE_WARNING,
        parameters: compileParameters({
            activeEnv: { type: 'string', description: '当前环境名。必须已存在于 environments 里；传空串表示不设置环境。' },
            environments: { type: 'array', description: '环境清单（字符串数组，自动去重、去空）。非空时改完 activeEnv 必须仍在其中；传空数组表示不使用环境，会一并清空 activeEnv。' },
            maxRows: { type: 'number', description: '查询返回行数上限（1-10000）。' },
            queryTimeoutMs: { type: 'number', description: '单次查询超时（毫秒，5000-600000）。' },
            execTimeoutMs: { type: 'number', description: '单次写操作超时（毫秒，5000-600000）。' },
        }),
        output: textOutput,
        async execute(rawArgs) {
            const args = asRecord(rawArgs);
            const keys = Object.keys(CONFIG_LIMITS);
            const touchEnv = args.activeEnv !== undefined || args.environments !== undefined;
            if (keys.every((key) => args[key] === undefined) && !touchEnv) {
                throw new Error('至少要给 activeEnv / environments / ' + keys.join(' / ') + ' 之一。');
            }
            // 先做范围校验，把「能直接照做」的错误在写盘前抛出来。
            for (const key of keys) {
                const raw = args[key];
                if (raw === undefined)
                    continue;
                const limit = CONFIG_LIMITS[key];
                const value = Number(raw);
                if (!Number.isFinite(value) || value < limit.min || value > limit.max) {
                    throw new Error(key + '（' + limit.label + '）必须是 ' + limit.min + '~' + limit.max + ' 之间的数字，收到 ' + JSON.stringify(raw) + '。');
                }
            }
            // 环境清单：必须是非空字符串数组，去重。
            let nextEnvironments;
            if (args.environments !== undefined) {
                if (!Array.isArray(args.environments)) {
                    throw new Error('environments 必须是字符串数组，收到 ' + JSON.stringify(args.environments) + '。');
                }
                const cleaned = [];
                for (const item of args.environments) {
                    if (typeof item !== 'string' || item.trim() === '') {
                        throw new Error('environments 里只能是非空字符串，收到 ' + JSON.stringify(item) + '。');
                    }
                    const name = item.trim();
                    if (!cleaned.includes(name))
                        cleaned.push(name);
                }
                nextEnvironments = cleaned;
            }
            const { settings: before } = current();
            const beforeEnvironments = Array.isArray(before.environments) ? before.environments : [];
            const effectiveEnvironments = nextEnvironments ?? beforeEnvironments;
            // environments 清空是强语义：顺带把 activeEnv 也清掉，避免「清单为空但当前环境还在」的矛盾状态。
            const clearedEnvironments = nextEnvironments !== undefined && nextEnvironments.length === 0;
            // 双向校验：改完 activeEnv 必须落在 environments 里。传空 = 清空，不校验。
            const nextActiveEnv = clearedEnvironments
                ? ''
                : args.activeEnv !== undefined
                    ? String(args.activeEnv).trim()
                    : (typeof before.activeEnv === 'string' ? before.activeEnv : '');
            if (nextActiveEnv !== '' && !effectiveEnvironments.includes(nextActiveEnv)) {
                const available = effectiveEnvironments.length > 0 ? effectiveEnvironments.join('、') : '（空）';
                throw new Error('activeEnv "' + nextActiveEnv + '" 不在 environments 里（可选：' + available + '）。' +
                    '请一并修改 environments，或改成一个已存在的环境。');
            }
            const { settings } = mutate((draft) => {
                for (const key of keys) {
                    if (args[key] !== undefined)
                        draft[key] = Number(args[key]);
                }
                if (nextEnvironments !== undefined)
                    draft.environments = nextEnvironments;
                if (args.activeEnv !== undefined || clearedEnvironments)
                    draft.activeEnv = nextActiveEnv;
                return draft;
            });
            const changed = [];
            if (args.activeEnv !== undefined && !clearedEnvironments)
                changed.push('activeEnv=' + String(settings.activeEnv ?? ''));
            if (nextEnvironments !== undefined)
                changed.push('environments=' + (nextEnvironments.length > 0 ? nextEnvironments.join('、') : '（空）'));
            for (const key of keys) {
                if (args[key] !== undefined)
                    changed.push(key + '=' + String(settings[key]));
            }
            const lines = ['已更新设置：' + changed.join('，')];
            if (clearedEnvironments && before.activeEnv !== undefined && before.activeEnv !== '') {
                lines.push('⚠ activeEnv 一并清空（原 ' + String(before.activeEnv) + '），现在不再按环境筛选。');
            }
            // 删掉某个环境时，提示还有哪些连接挂在它下面（不阻断 —— 那些连接仍可用，只是不再属于任何环境）。
            if (nextEnvironments !== undefined) {
                const removed = beforeEnvironments.filter((name) => !nextEnvironments.includes(name));
                const table = isConnectionTable(settings.connections) ? settings.connections : {};
                for (const envName of removed) {
                    const users = Object.entries(table)
                        .filter(([, conn]) => conn?.env === envName)
                        .map(([connName]) => connName);
                    if (users.length > 0) {
                        lines.push('⚠ 环境 "' + envName + '" 已移除，但仍有连接在用它：' + users.join('、') + '（需要的话用 sql_connection_set 改掉它们的 env）');
                    }
                }
            }
            return { report: lines.join('\n') };
        },
        timeoutMs: 10000,
    };
    const sqlConnectionSet = {
        name: 'sql_connection_set',
        description: '新增或覆盖一个连接。**未给的字段保持不变；给了就设为该值（空串即空串）**。先 sql_settings 看现值。立即生效，不用重启。\n' +
            CONFIG_WRITE_WARNING,
        parameters: compileParameters({
            name: { type: 'string', required: true, description: '连接名。不存在则新建，存在则更新。' },
            engine: { type: 'string', description: '引擎：sqlite / mysql / postgres。' },
            file: { type: 'string', description: 'engine=sqlite 用：如 :memory:。' },
            host: { type: 'string', description: '主机。' },
            port: { type: 'number', description: '端口。' },
            user: { type: 'string', description: '用户名。' },
            password: { type: 'string', description: '密码。' },
            database: { type: 'string', description: '库名。' },
            readOnly: { type: 'boolean', description: '禁用该连接的写操作，默认 false。' },
            env: { type: 'string', description: '所属环境（如 qa / prod）；留空表示不属于任何环境。' },
            description: { type: 'string', description: '连接说明，最长 ' + DESCRIPTION_MAX_LENGTH + ' 字符。' },
        }),
        output: textOutput,
        async execute(rawArgs) {
            const args = asRecord(rawArgs);
            const name = requiredString(args, 'name', '连接名');
            // 名字是字典的键：存在就是「更新」，不存在就是「新建」，两者的必填要求不同。
            const { settings } = current();
            const table = isConnectionTable(settings.connections) ? settings.connections : {};
            const existing = Object.hasOwn(table, name) ? table[name] : undefined;
            // 引擎：给了用给的，否则沿用已有的；都没有（即新建）则必填。
            const engineRaw = args.engine;
            let engine;
            if (typeof engineRaw === 'string' && engineRaw.trim() !== '') {
                engine = engineRaw.trim();
                if (engine !== 'sqlite' && engine !== 'mysql' && engine !== 'postgres') {
                    throw new Error('engine 必须是 sqlite / mysql / postgres 之一，收到 ' + JSON.stringify(engineRaw) + '。');
                }
            }
            else if (existing !== undefined) {
                engine = existing.engine;
            }
            else {
                throw new Error('新建连接必须给 engine（sqlite / mysql / postgres）。');
            }
            // 以现有定义为底稿做增量修改：更新时保留未提及的字段（尤其 password，绝不能因
            // 「这次没提」而被清掉）；新建时从 { engine } 起步。
            const base = existing !== undefined
                ? JSON.parse(JSON.stringify(existing))
                : { engine };
            /**
             * 逐字段应用「不传=不动，给值=设为该值」。
             *
             * 没有「清空」概念：空串就是空串（原样写入），不做特殊处理。
             */
            const applyText = (key) => {
                const value = args[key];
                if (value === undefined)
                    return;
                const text = String(value).trim();
                if (key === 'description' && text.length > DESCRIPTION_MAX_LENGTH) {
                    throw new Error('description 最长 ' + DESCRIPTION_MAX_LENGTH + ' 字符，收到 ' + text.length + ' 字符。');
                }
                base[key] = text;
            };
            /** port 是数字，单独处理（校验正整数）。 */
            const applyPort = () => {
                const value = args.port;
                if (value === undefined)
                    return;
                const port = Number(value);
                if (!Number.isInteger(port) || port <= 0)
                    throw new Error('port 必须是正整数，收到 ' + JSON.stringify(value) + '。');
                base.port = port;
            };
            /** readOnly 是布尔，单独处理（只有 true 才算开）。 */
            const applyReadOnly = () => {
                const value = args.readOnly;
                if (value === undefined)
                    return;
                base.readOnly = value === true;
            };
            applyText('file');
            applyText('host');
            applyText('user');
            applyText('password');
            applyText('database');
            applyText('env');
            applyText('description');
            applyPort();
            applyReadOnly();
            const entry = { ...base, engine };
            // 换引擎时清掉另一套字段，避免残留（如 sqlite→mysql 后还留着 file）。
            if (engine === 'sqlite') {
                delete entry.host;
                delete entry.port;
                delete entry.user;
                delete entry.password;
                delete entry.database;
            }
            else {
                delete entry.file;
            }
            // —— 写入前校验（读取侧不校验，这里是唯一把关点）——
            // PostgreSQL 必须指定库；MySQL 的 database 可选（不填即不指定默认库，可用全限定名查询）。
            if (engine === 'postgres' && (entry.database === undefined || entry.database === '')) {
                throw new Error('postgres 连接必须给 database（库名）。');
            }
            // env 必须出自环境清单（留空表示无环境特征，不校验）。
            if (entry.env !== undefined && entry.env !== '') {
                const known = Array.isArray(settings.environments) ? settings.environments : [];
                if (!known.includes(entry.env)) {
                    const available = known.length > 0 ? known.join('、') : '（空）';
                    throw new Error('env "' + entry.env + '" 不在 environments 里（可选：' + available + '）。' +
                        '先用 sql_config_set 把它加进 environments，或留空表示不属于任何环境。');
                }
            }
            // 按名字 upsert：键即名字，同名天然只有一条。
            mutate((draft) => {
                const target = isConnectionTable(draft.connections) ? draft.connections : {};
                target[name] = entry;
                draft.connections = target;
                return draft;
            });
            const verb = existing !== undefined ? '已更新连接' : '已新增连接';
            return { report: verb + ' "' + name + '"（' + engine + '）。' };
        },
        timeoutMs: 10000,
    };
    const sqlConnectionRemove = {
        name: 'sql_connection_remove',
        description: '删除一个连接（连带关闭它的连接池），先 sql_settings 看现值。立即生效，不用重启。\n' + CONFIG_WRITE_WARNING,
        parameters: compileParameters({
            name: { type: 'string', required: true, description: '连接名。' },
        }),
        output: textOutput,
        async execute(rawArgs) {
            const name = requiredString(rawArgs !== null && typeof rawArgs === 'object' ? asRecord(rawArgs) : {}, 'name', '连接名');
            const { settings } = current();
            const table = isConnectionTable(settings.connections) ? settings.connections : {};
            if (!Object.hasOwn(table, name)) {
                const known = Object.keys(table);
                throw new Error('连接 "' + name + '" 不存在，可用：' + (known.length > 0 ? known.join('、') : '（空，用 sql_connection_set 添加）'));
            }
            mutate((draft) => {
                const target = isConnectionTable(draft.connections) ? draft.connections : {};
                delete target[name];
                draft.connections = target;
                return draft;
            });
            return { report: '已删除连接 "' + name + '"。' };
        },
        timeoutMs: 10000,
    };
    return [sqlSettings, sqlConfigSet, sqlConnectionSet, sqlConnectionRemove];
}
