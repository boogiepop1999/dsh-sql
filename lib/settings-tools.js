/**
 * 配置管理工具：sql_settings / sql_config_set / sql_connection_set / sql_connection_remove。
 *
 * 只管设置文件，不碰连接池。写操作一律「现读 → 改 → 校验 → 原子写回」。
 *
 * @module dsh-sql/settings-tools
 */
import { DESCRIPTION_MAX_LENGTH, missingConnectionFields, fillConnectionKeys, invalidReadOnly, isReadOnly, requireMaxRows, splitConnectionsByEnv, } from './config.js';
import { loadSettings, normalizeSettings, saveSettings, settingsFile } from './settings.js';
import { CONFIG_WRITE_WARNING, compileParameters, requiredString, asRecord, textOutput, } from './tool-kit.js';
/** 可被 sql_config_set 修改的全局字段及其范围。 */
export const CONFIG_LIMITS = {
    maxRows: { min: 1, max: 10000, label: '查询返回行数上限' },
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
    return { settings: loaded.settings, file: loaded.file };
}
/**
 * 读 → 改 → 形状把关 → 原子写回。change 收到的是深拷贝，就地改完返回即可。
 *
 * **写盘前再过一遍 `normalizeSettings`**：change 是各工具自己写的，万一塞进未知字段
 * 或把 `connections` 写成了别的形状，这一步会拦下/剔除，而不是把垃圾落进文件。
 * 读写的都是同一份（normalizeSettings 的产物），所以拿它当底稿时"没提到的字段"
 * 自然原样保留 —— 增量语义不受影响。
 */
function mutate(change) {
    const { settings, file } = current();
    const draft = JSON.parse(JSON.stringify(settings));
    const next = normalizeSettings(change(draft));
    saveSettings(next, undefined);
    return { settings: next, file: settingsFile() };
}
/** 构建四个配置管理工具。 */
export function buildSettingsTools() {
    const sqlSettings = {
        name: 'sql_settings',
        description: '总览：连接名清单 + 全局设置。\n' +
            '报告是现成的 Markdown，**汇报时原样贴出**，别改写别压缩。配置文件改动立即生效，不用重启。',
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
            const allConnections = loaded.settings.connections ?? {};
            const { available: inScope, excluded: outOfScope } = splitConnectionsByEnv(loaded.settings);
            // 设置里的字段都是可选的（手写文件可能缺），这里统一成"空串 / 空数组"再渲染
            const activeEnv = typeof loaded.settings.activeEnv === 'string' ? loaded.settings.activeEnv.trim() : '';
            const environments = Array.isArray(loaded.settings.environments) ? loaded.settings.environments : [];
            const head = activeEnv !== '' ? '当前环境 ' + activeEnv : '当前环境（未设置）';
            lines.push('# dsh-sql — ' + head + '，' + String(Object.keys(inScope).length) + ' 个可见连接');
            lines.push('');
            lines.push('## 可见连接' + (activeEnv !== '' ? '（当前环境 ' + activeEnv + '）' : '（不限环境）'));
            lines.push('| 连接名 | 引擎 | 环境 | 只读 | 描述 |');
            lines.push('| --- | --- | --- | --- | --- |');
            for (const [name, connection] of Object.entries(inScope)) {
                // 非法 readOnly 值就地标出来：生效值已按只读算，但"为什么写不了"得让人看见
                const readOnlyCell = invalidReadOnly(connection) !== undefined
                    ? '🔒 是（值非法，按只读）'
                    : (isReadOnly(connection) ? '🔒 是' : '否');
                lines.push('| ' + cell(name) +
                    ' | ' + cell(connection.engine) +
                    ' | ' + cell(connection.env ?? '不限环境') +
                    ' | ' + readOnlyCell +
                    ' | ' + cell(connection.description ?? '') + ' |');
            }
            const outOfScopeNames = Object.keys(outOfScope);
            if (outOfScopeNames.length > 0) {
                lines.push('');
                lines.push('其它环境的连接：' + outOfScopeNames.join('、'));
            }
            // 行数上限非法时报告还得打得开 —— 这正是 sql_settings 的职责（让人看见问题），
            // 所以这里兜错误而不是让它抛。
            let maxRowsText;
            try {
                maxRowsText = String(requireMaxRows(loaded.settings));
            }
            catch (error) {
                maxRowsText = '⚠ ' + (error instanceof Error ? error.message : String(error));
            }
            lines.push('');
            lines.push('## 全局设置');
            lines.push('| 项 | 值 |');
            lines.push('| --- | --- |');
            lines.push('| 当前环境 | ' + (activeEnv !== '' ? cell(activeEnv) : '（未设置）') + ' |');
            lines.push('| 环境清单 | ' + (environments.length > 0 ? environments.map(cell).join('、') : '（空）') + ' |');
            lines.push('| 行数上限 | ' + cell(maxRowsText) + ' |');
            lines.push('| 配置文件 | `' + cell(loaded.file) + '` |');
            const problems = [];
            if (environments.length === 0)
                problems.push('environments 为空，请先用 sql_config_set 配置环境清单。');
            if (activeEnv === '')
                problems.push('activeEnv 未设置，请先用 sql_config_set 指定当前环境。');
            if (Object.keys(allConnections).length === 0)
                problems.push('还没有任何连接，请先用 sql_connection_set 添加。');
            // maxRows 非法：使用处（sql_query）会直接报错，这里先提一句，免得"查询全挂"来得突然
            if (maxRowsText.startsWith('⚠ '))
                problems.push(maxRowsText.slice(2));
            // readOnly 值非法：生效值已按只读算（fail-safe），但必须说出来 ——
            // 否则表现只是"莫名其妙写不了"，没人想得到是值写错了。
            for (const [name, connection] of Object.entries(allConnections)) {
                const bad = invalidReadOnly(connection);
                if (bad === undefined)
                    continue;
                problems.push('连接 "' + name + '" 的 readOnly 值非法（' + JSON.stringify(bad) +
                    '），已按 true（只读）处理。要开写请改成布尔 false（用 sql_connection_set，或直接编辑配置文件）。');
            }
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
        description: '改全局设置，参数至少一个，先 sql_settings 看现值。\n' +
            CONFIG_WRITE_WARNING,
        parameters: compileParameters({
            activeEnv: { type: 'string', description: '当前环境名。传空串表示不设置环境。' },
            environments: { type: 'array', description: '环境清单（字符串数组），如 ["qa", "prod"]。传空数组会连带清空 activeEnv。' },
            maxRows: { type: 'number', description: '查询返回行数上限（1-10000）。' },
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
            // 只收真正的 number —— Number('5') / Number(true) 都能算出数字，静默接受会让
            // maxRows: true 悄悄变成 1（用户以为「开着」，实际把行数上限压到了 1）。
            for (const key of keys) {
                const raw = args[key];
                if (raw === undefined)
                    continue;
                const limit = CONFIG_LIMITS[key];
                if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < limit.min || raw > limit.max) {
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
                lines.push('⚠ activeEnv 一并清空（原 ' + String(before.activeEnv) + '），现在只列不限定环境的连接。');
            }
            // 删掉某个环境时，提示还有哪些连接的 env 指向它（不阻断 —— 只是那些连接从此匹配不上任何环境）。
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
        description: '新增或更新一个连接。**未给的字段保持不变；给了就设为该值**。先 sql_settings 看现值。\n' +
            CONFIG_WRITE_WARNING,
        parameters: compileParameters({
            name: { type: 'string', required: true, description: '连接名。' },
            engine: { type: 'string', description: '引擎：sqlite / mysql / postgres。' },
            file: { type: 'string', description: 'engine=sqlite 时才传。' },
            host: { type: 'string', description: '主机。' },
            port: { type: 'number', description: '端口。' },
            user: { type: 'string', description: '用户名。' },
            password: { type: 'string', description: '密码。' },
            database: { type: 'string', description: '库名。' },
            readOnly: { type: 'boolean', description: '是否禁用该连接的写操作。**默认 true **。' },
            env: { type: 'string', description: '所属环境（如 qa / prod）。留空表示不限定环境。' },
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
            // 引擎：新建时必填；**已有连接不许改引擎** —— 换引擎等于把一条连接变成另一条
            // （sqlite 的 file 与 mysql 的 host/port/… 是两套完全不同的字段），
            // 与其悄悄删掉一半字段，不如让人删掉重建：名字相同、配置却是另一套，最容易踩坑。
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
            if (existing !== undefined && engine !== existing.engine) {
                throw new Error('连接 "' + name + '" 已是 ' + existing.engine + '，不能改成 ' + engine +
                    '。换引擎请用 sql_connection_remove 删掉重建（用 sql_connection_set 新建同名连接）。');
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
            }; /** port 是数字，单独处理；只收真正的正整数。 */
            const applyPort = () => {
                const value = args.port;
                if (value === undefined)
                    return;
                if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
                    throw new Error('port 必须是正整数，收到 ' + JSON.stringify(value) + '。');
                }
                base.port = value;
            };
            /** readOnly 是布尔，单独处理；非布尔一律报错 —— 传 "false" 之类会被解析侧按 true 吞掉（fail-safe），当场报错比让写入静默失败好。 */
            const applyReadOnly = () => {
                const value = args.readOnly;
                if (value === undefined)
                    return;
                if (typeof value !== 'boolean') {
                    throw new Error('readOnly 必须是布尔值（true / false），收到 ' + JSON.stringify(value) + '。');
                }
                base.readOnly = value;
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
            // 引擎不可变（上面已拦），所以这里不需要再按引擎清理另一套字段。
            const entry = { ...base, engine };
            // —— 写入前校验（读取侧不校验，这里是唯一把关点）——
            // 规则在 missingConnectionFields 里（与建连侧共用），这里只负责措辞。
            // 新增要求各字段 key 都落下：**不报错、直接补空**（见 fillConnectionKeys），
            // 所以它排在必填校验**之前** —— 先把 key 补全，再看值够不够。
            if (existing === undefined)
                fillConnectionKeys(entry);
            const missing = missingConnectionFields(entry);
            if (missing.length > 0) {
                throw new Error('连接 "' + name + '"（' + engine + '）缺少必填字段：' + missing.join('、') + '。请用 sql_connection_set 补全。');
            }
            // env 必须出自环境清单（留空 = 不限定环境，不校验）。
            if (entry.env !== undefined && entry.env !== '') {
                const known = Array.isArray(settings.environments) ? settings.environments : [];
                if (!known.includes(entry.env)) {
                    const available = known.length > 0 ? known.join('、') : '（空）';
                    throw new Error('env "' + entry.env + '" 不在 environments 里（可选：' + available + '）。' +
                        '可以用 sql_config_set 把它加进 environments，或留空表示不限定环境。');
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
        description: '删除一个连接（连带关闭它的连接池）。\n' + CONFIG_WRITE_WARNING,
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
