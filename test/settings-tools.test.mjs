// 配置管理四件套：sql_settings / sql_config_set / sql_connection_set / sql_connection_remove
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSettingsTools, buildSqlTools, SETTINGS_DIR_ENV, SETTINGS_FILE_NAME, loadSettings, settingsFile } from '../lib/index.js'

/** 每个用例独立临时目录，绝不碰真实 $DSH_HOME/sql。 */
function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sql-cfg-'))
  process.env[SETTINGS_DIR_ENV] = dir
  const tools = buildSettingsTools()
  const byName = (name) => tools.find((t) => t.name === name)
  return {
    dir,
    settingsPath: join(dir, SETTINGS_FILE_NAME),
    read: () => JSON.parse(readFileSync(join(dir, SETTINGS_FILE_NAME), 'utf8')),
    /** 按名字取已落盘的连接定义（connections 是字典，键即名字）。 */
    conn: (name) => JSON.parse(readFileSync(join(dir, SETTINGS_FILE_NAME), 'utf8')).connections?.[name],
    tool: byName,
    cleanup() { delete process.env[SETTINGS_DIR_ENV]; rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) },
  }
}

/** 建一个 sqlite 连接（部分更新语义：只给必要的字段）。 */
function connArgs(overrides = {}) {
  return { name: 'x', engine: 'sqlite', file: ':memory:', ...overrides }
}

test('四个工具都注册且名字正确', () => {
  const names = buildSettingsTools().map((t) => t.name).sort()
  assert.deepEqual(names, ['sql_config_set', 'sql_connection_remove', 'sql_connection_set', 'sql_settings'])
})

test('每个工具的 schema 是 object JSON Schema', () => {
  for (const tool of buildSettingsTools()) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.parameters.properties, 'object')
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
})

test('sql_settings：空配置正常渲染 + 三条告警', async () => {
  const box = makeSandbox()
  try {
    const value = await box.tool('sql_settings').execute({})
    assert.match(value.report, /# dsh-sql — 当前环境（未设置），0 个可见连接/)
    assert.match(value.report, /environments 为空/)
    assert.match(value.report, /activeEnv 未设置/)
    assert.match(value.report, /还没有任何连接/)
    const blocks = box.tool('sql_settings').output.render({}, value)
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /## 全局设置/)
    assert.deepEqual(box.read().connections, {}, '出厂不带任何连接')
  } finally { box.cleanup() }
})

test('sql_settings：只读与描述出现在报告里', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_connection_set').execute(connArgs({ name: 'prod', file: '/tmp/p.db', readOnly: true, description: '生产库，慎写' }))
    const value = await box.tool('sql_settings').execute({})
    assert.match(value.report, /🔒 是/)
    assert.match(value.report, /生产库，慎写/)
  } finally { box.cleanup() }
})

test('sql_settings：设置文件坏掉时不崩，把问题摊开', async () => {
  const box = makeSandbox()
  try {
    writeFileSync(box.settingsPath, '{ 坏掉的 JSON', 'utf8')
    const value = await box.tool('sql_settings').execute({})
    assert.match(value.report, /设置不可用/)
    assert.match(value.report, /不是合法 JSON/)
    assert.match(value.report, /配置文件/)
  } finally { box.cleanup() }
})

test('sql_connection_set：新增连接并落盘', async () => {
  const box = makeSandbox()
  try {
    const out = await box.tool('sql_connection_set').execute(
      connArgs({ name: 'qa', engine: 'mysql', host: '10.0.0.1', port: 3307, user: 'u', password: 'p', database: 'app' }),
    )
    assert.match(out.report, /已新增连接 "qa"/)
    const written = box.read()
    const qa = box.conn('qa')
    assert.equal(qa.engine, 'mysql')
    assert.equal(qa.host, '10.0.0.1')
    assert.equal(qa.port, 3307)
    assert.equal(qa.database, 'app')
  } finally { box.cleanup() }
})

test('sql_connection_set：同名覆盖，不产生重复项', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_connection_set').execute(connArgs({ name: 'qa', file: '/a.db' }))
    await box.tool('sql_connection_set').execute(connArgs({ name: 'qa', file: '/b.db' }))
    const written = box.read()
    assert.deepEqual(Object.keys(written.connections).filter((k) => k === 'qa'), ['qa'], '键唯一，天然不重复')
    assert.equal(box.conn('qa').file, '/b.db')
  } finally { box.cleanup() }
})

test('sql_connection_set：名字区分大小写（QA 与 qa 是两条）', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_connection_set').execute(connArgs({ name: 'qa', file: '/a.db' }))
    await box.tool('sql_connection_set').execute(connArgs({ name: 'QA', file: '/b.db' }))
    assert.equal(box.conn('qa').file, '/a.db')
    assert.equal(box.conn('QA').file, '/b.db')
  } finally { box.cleanup() }
})

test('sql_connection_set：引擎非法报错且不落盘', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_settings').execute({})   // 先生成出厂设置
    const before = box.read()
    await assert.rejects(
      () => box.tool('sql_connection_set').execute(connArgs({ name: 'x', engine: 'oracle' })),
      /engine 必须是 sqlite \/ mysql \/ postgres/,
    )
    assert.deepEqual(box.read(), before, '校验失败不该改文件')
  } finally { box.cleanup() }
})

test('sql_connection_set：postgres 缺 database 报错', async () => {
  const box = makeSandbox()
  try {
    await assert.rejects(
      () => box.tool('sql_connection_set').execute(connArgs({ name: 'pg', engine: 'postgres', host: 'h', port: 5432 })),
      /postgres 连接必须给 database/,
    )
  } finally { box.cleanup() }
})

test('sql_connection_set：mysql 允许 database 为空', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_connection_set').execute(connArgs({ name: 'my', engine: 'mysql', host: 'h', port: 3306 }))
    const my = box.conn('my')
    assert.ok(my !== undefined)
    assert.ok(my.database === undefined || my.database === '')
  } finally { box.cleanup() }
})

test('sql_connection_set：部分更新 —— 未给的字段保持不变（password 不会被清掉）', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_connection_set').execute(
      connArgs({ name: 'qa', engine: 'mysql', host: '10.0.0.1', port: 3306, user: 'u', password: 'secret', database: 'app' }),
    )
    // 只改 readOnly，其余一律不动
    const out = await box.tool('sql_connection_set').execute({ name: 'qa', readOnly: true })

    assert.match(out.report, /已更新连接 "qa"/)
    const qa = box.conn('qa')
    assert.equal(qa.readOnly, true, 'readOnly 应已更新')
    assert.equal(qa.password, 'secret', 'password 必须保留')
    assert.equal(qa.user, 'u', 'user 必须保留')
    assert.equal(qa.host, '10.0.0.1', 'host 必须保留')
    assert.equal(qa.port, 3306, 'port 必须保留')
    assert.equal(qa.database, 'app', 'database 必须保留')
    assert.equal(qa.engine, 'mysql', 'engine 必须保留')
  } finally { box.cleanup() }
})

test('sql_connection_set：空串就是空串（不做清空语义）', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_connection_set').execute(
      connArgs({ name: 'qa', engine: 'mysql', host: 'h', port: 3306, user: 'u', password: 'p', database: 'app', description: '备注' }),
    )
    await box.tool('sql_connection_set').execute({ name: 'qa', description: '' })

    const qa = box.conn('qa')
    assert.equal(qa.description, '', '空串原样写入')
    assert.equal(qa.database, 'app', '未提及的 database 不受影响')
    assert.equal(qa.password, 'p', '未提及的 password 不受影响')
    assert.equal(qa.host, 'h', '未提及的 host 不受影响')
  } finally { box.cleanup() }
})

test('sql_connection_set：新建时未给 file 用默认值，给了就照给', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_connection_set').execute({ name: 'a', engine: 'sqlite' })
    const a = box.conn('a')
    assert.equal(a.file, undefined, '未给 file 时不写这个键（解析时兜底 :memory:）')

    await box.tool('sql_connection_set').execute({ name: 'b', engine: 'sqlite', file: '/tmp/b.db' })
    const b = box.conn('b')
    assert.equal(b.file, '/tmp/b.db')
  } finally { box.cleanup() }
})

test('sql_connection_set：新建必须给 engine', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_settings').execute({})
    const before = box.read()
    await assert.rejects(
      () => box.tool('sql_connection_set').execute({ name: 'noengine' }),
      /新建连接必须给 engine/,
    )
    assert.deepEqual(box.read(), before, '报错不该改文件')
  } finally { box.cleanup() }
})

test('sql_connection_set：换引擎时清掉另一套字段', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_connection_set').execute(
      connArgs({ name: 'swap', engine: 'mysql', host: 'h', port: 3306, user: 'u', password: 'p', database: 'app' }),
    )
    await box.tool('sql_connection_set').execute({ name: 'swap', engine: 'sqlite', file: '/tmp/s.db' })

    const swap = box.conn('swap')
    assert.equal(swap.engine, 'sqlite')
    assert.equal(swap.file, '/tmp/s.db')
    assert.equal(swap.host, undefined, 'mysql 的 host 应被清掉')
    assert.equal(swap.password, undefined, 'mysql 的 password 应被清掉')
  } finally { box.cleanup() }
})

test('sql_connection_set：description 超 100 字符直接报错（不截断）', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_settings').execute({})
    const before = box.read()
    await assert.rejects(
      () => box.tool('sql_connection_set').execute(connArgs({ name: 'a', description: 'x'.repeat(150) })),
      /description 最长 100 字符，收到 150 字符/,
    )
    assert.deepEqual(box.read(), before, '报错不该改文件')

    // 恰好 100 字符可以通过
    await box.tool('sql_connection_set').execute(connArgs({ name: 'b', description: 'y'.repeat(100) }))
    const b = box.conn('b')
    assert.equal(b.description.length, 100)
  } finally { box.cleanup() }
})

test('sql_connection_remove：删除连接并落盘', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_connection_set').execute(connArgs({ name: 'gone' }))
    const out = await box.tool('sql_connection_remove').execute({ name: 'gone' })
    assert.match(out.report, /已删除连接 "gone"/)
    assert.equal(Object.hasOwn(box.read().connections, 'gone'), false)
  } finally { box.cleanup() }
})

test('sql_connection_remove：不存在的连接报错并列出可用项', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_connection_set').execute(connArgs({ name: 'real' }))
    await assert.rejects(
      () => box.tool('sql_connection_remove').execute({ name: 'nope' }),
      /连接 "nope" 不存在.*real/s,
    )
  } finally { box.cleanup() }
})

test('sql_config_set：改 maxRows 并落盘', async () => {
  const box = makeSandbox()
  try {
    const out = await box.tool('sql_config_set').execute({ maxRows: 250 })
    assert.match(out.report, /maxRows=250/)
    assert.equal(box.read().maxRows, 250)
  } finally { box.cleanup() }
})

test('sql_config_set：不给任何字段报错', async () => {
  const box = makeSandbox()
  try {
    await assert.rejects(() => box.tool('sql_config_set').execute({}), /至少要给/)
  } finally { box.cleanup() }
})

test('sql_config_set：超范围报错且不落盘', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_settings').execute({})
    const before = box.read()
    await assert.rejects(() => box.tool('sql_config_set').execute({ maxRows: 99999 }), /1~10000/)
    assert.deepEqual(box.read(), before)
  } finally { box.cleanup() }
})

test('sql_config_set：只传已废弃的超时字段会被当成没给任何参数', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_settings').execute({})
    await assert.rejects(
      () => box.tool('sql_config_set').execute({ queryTimeoutMs: 30000 }),
      /至少要给 activeEnv \/ environments \/ maxRows 之一/,
    )
  } finally { box.cleanup() }
})

test('闭环：工具写入的连接，sql_query 立刻能用（不重启）', async () => {
  const box = makeSandbox()
  try {
    const dbFile = join(box.dir, 'live.db')
    await box.tool('sql_connection_set').execute(connArgs({ name: 'live', file: dbFile }))

    // 每次调用都重新构建工具，模拟「新一次调用读到新设置」
    const { tools, adapters } = buildSqlTools(() => loadSettings().resolved)
    const exec = tools.find((t) => t.name === 'sql_exec')
    const query = tools.find((t) => t.name === 'sql_query')

    await exec.execute({ sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)', connection: 'live' })
    await exec.execute({ sql: "INSERT INTO t (v) VALUES ('hello')", connection: 'live' })
    const result = await query.execute({ sql: 'SELECT v FROM t', connection: 'live' })
    assert.deepEqual(result.rows, [['hello']])

    for (const adapter of adapters.values()) await adapter.close()
  } finally { box.cleanup() }
})

test('闭环：sql_connection_remove 后该连接立刻不可用', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_connection_set').execute(connArgs({ name: 'temp', file: join(box.dir, 'temp.db') }))
    await box.tool('sql_connection_remove').execute({ name: 'temp' })

    const { tools } = buildSqlTools(() => loadSettings().resolved)
    const query = tools.find((t) => t.name === 'sql_query')
    await assert.rejects(() => query.execute({ sql: 'SELECT 1', connection: 'temp' }), /未找到名为 temp/)
  } finally { box.cleanup() }
})

test('闭环：sql_config_set 改的 maxRows 立刻生效', async () => {
  const box = makeSandbox()
  try {
    const dbFile = join(box.dir, 'cap.db')
    await box.tool('sql_connection_set').execute(connArgs({ name: 'cap', file: dbFile }))

    const first = buildSqlTools(() => loadSettings().resolved)
    const exec = first.tools.find((t) => t.name === 'sql_exec')
    await exec.execute({ sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY)', connection: 'cap' })
    await exec.execute({ sql: 'INSERT INTO t (id) VALUES (1),(2),(3)', connection: 'cap' })

    await box.tool('sql_config_set').execute({ maxRows: 2 })

    const second = buildSqlTools(() => loadSettings().resolved)
    const query = second.tools.find((t) => t.name === 'sql_query')
    const result = await query.execute({ sql: 'SELECT * FROM t', connection: 'cap' })
    assert.equal(result.maxRows, 2)
    assert.equal(result.truncated, true)
    assert.equal(result.rows.length, 2)

    // 先关掉 SQLite 句柄，否则 Windows 上临时目录删不掉
    for (const adapter of first.adapters.values()) await adapter.close()
    for (const adapter of second.adapters.values()) await adapter.close()
  } finally { box.cleanup() }
})

test('settingsFile 受 DSH_SQL_SETTINGS_DIR 控制', () => {
  const box = makeSandbox()
  try {
    assert.equal(settingsFile(), join(box.dir, SETTINGS_FILE_NAME))
  } finally { box.cleanup() }
})

// ── activeEnv / environments ───────────────────────────────────────────────

test('出厂设置：activeEnv 与 environments 都是空', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_settings').execute({})
    const written = box.read()
    assert.equal(written.activeEnv, '')
    assert.deepEqual(written.environments, [])
  } finally { box.cleanup() }
})

test('sql_config_set：写 environments（去重、去空）', async () => {
  const box = makeSandbox()
  try {
    const out = await box.tool('sql_config_set').execute({ environments: ['qa', 'qa', 'prod'] })
    assert.match(out.report, /environments=qa、prod/)
    assert.deepEqual(box.read().environments, ['qa', 'prod'])
  } finally { box.cleanup() }
})

test('sql_config_set：environments 非数组或含空元素时报错', async () => {
  const box = makeSandbox()
  try {
    await assert.rejects(() => box.tool('sql_config_set').execute({ environments: 'qa' }), /必须是字符串数组/)
    await assert.rejects(() => box.tool('sql_config_set').execute({ environments: ['qa', ''] }), /只能是非空字符串/)
    await assert.rejects(() => box.tool('sql_config_set').execute({ environments: ['qa', 1] }), /只能是非空字符串/)
  } finally { box.cleanup() }
})

test('sql_config_set：activeEnv 必须在 environments 里', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_config_set').execute({ environments: ['qa', 'prod'] })
    await assert.rejects(
      () => box.tool('sql_config_set').execute({ activeEnv: 'uat' }),
      /activeEnv "uat" 不在 environments 里（可选：qa、prod）/,
    )
    const ok = await box.tool('sql_config_set').execute({ activeEnv: 'qa' })
    assert.match(ok.report, /activeEnv=qa/)
    assert.equal(box.read().activeEnv, 'qa')
  } finally { box.cleanup() }
})

test('sql_config_set：反向校验 —— 改 environments 不能把当前 activeEnv 挤掉', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_config_set').execute({ environments: ['qa', 'prod'] })
    await box.tool('sql_config_set').execute({ activeEnv: 'qa' })

    const before = box.read()
    await assert.rejects(
      () => box.tool('sql_config_set').execute({ environments: ['prod'] }),
      /activeEnv "qa" 不在 environments 里/,
    )
    assert.deepEqual(box.read(), before, '校验失败不该改文件')

    // 同批把 activeEnv 一起改走就放行
    const ok = await box.tool('sql_config_set').execute({ environments: ['prod'], activeEnv: 'prod' })
    assert.match(ok.report, /activeEnv=prod/)
    assert.equal(box.read().activeEnv, 'prod')
  } finally { box.cleanup() }
})

test('sql_config_set：environments 传空数组会连带清空 activeEnv', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_config_set').execute({ environments: ['qa', 'prod'] })
    await box.tool('sql_config_set').execute({ activeEnv: 'qa' })

    const out = await box.tool('sql_config_set').execute({ environments: [] })
    assert.match(out.report, /environments=（空）/)
    assert.match(out.report, /activeEnv 一并清空（原 qa）/)
    assert.deepEqual(box.read().environments, [])
    assert.equal(box.read().activeEnv, '')
  } finally { box.cleanup() }
})

test('sql_config_set：activeEnv 传空串可单独清空', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_config_set').execute({ environments: ['qa'] })
    await box.tool('sql_config_set').execute({ activeEnv: 'qa' })
    await box.tool('sql_config_set').execute({ activeEnv: '' })
    assert.equal(box.read().activeEnv, '')
    assert.deepEqual(box.read().environments, ['qa'], '清单不受影响')
  } finally { box.cleanup() }
})

test('sql_connection_set：env 必须出自 environments', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_settings').execute({})
    const before = box.read()
    await assert.rejects(
      () => box.tool('sql_connection_set').execute(connArgs({ name: 'x', env: 'qa' })),
      /env "qa" 不在 environments 里（可选：（空））/,
    )
    assert.deepEqual(box.read(), before, '报错不该改文件')

    await box.tool('sql_config_set').execute({ environments: ['qa'] })
    const ok = await box.tool('sql_connection_set').execute(connArgs({ name: 'x', env: 'qa' }))
    assert.match(ok.report, /已新增连接 "x"/)
    assert.equal(box.conn('x').env, 'qa')
  } finally { box.cleanup() }
})

test('sql_connection_set：env 留空合法（不限定环境）', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_connection_set').execute(connArgs({ name: 'any' }))
    const any = box.conn('any')
    assert.equal(any.env, undefined)
  } finally { box.cleanup() }
})

test('sql_config_set：删环境时提示还在用它的连接', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_config_set').execute({ environments: ['qa', 'prod'] })
    await box.tool('sql_connection_set').execute(connArgs({ name: 'a', env: 'qa' }))
    await box.tool('sql_connection_set').execute(connArgs({ name: 'b', env: 'prod' }))

    const out = await box.tool('sql_config_set').execute({ environments: ['prod'], activeEnv: 'prod' })
    assert.match(out.report, /环境 "qa" 已移除，但仍有连接在用它：a/)
  } finally { box.cleanup() }
})

test('sql_settings：按 activeEnv 筛选，留空的连接哪个环境都列', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_config_set').execute({ environments: ['qa', 'prod'] })
    await box.tool('sql_config_set').execute({ activeEnv: 'qa' })
    await box.tool('sql_connection_set').execute(connArgs({ name: 'qa-only', env: 'qa' }))
    await box.tool('sql_connection_set').execute(connArgs({ name: 'prod-only', env: 'prod' }))
    await box.tool('sql_connection_set').execute(connArgs({ name: 'anywhere' }))

    const value = await box.tool('sql_settings').execute({})
    assert.match(value.report, /当前环境 qa/)
    // 当前环境可用：qa-only + anywhere（留空）；prod-only 不在表里
    assert.match(value.report, /qa-only/)
    assert.match(value.report, /anywhere/)
    assert.match(value.report, /其它环境的连接：prod-only/)
    // prod-only 只出现在「其它环境」那行，不进表
    const tableRows = value.report.split('\n').filter((line) => line.startsWith('| ') && line.includes('| sqlite |'))
    assert.equal(tableRows.some((row) => row.includes('prod-only')), false)
  } finally { box.cleanup() }
})

test('sql_settings：activeEnv 为空时只列不限环境的，带环境的进「其它环境」', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_config_set').execute({ environments: ['qa', 'prod'] })
    await box.tool('sql_connection_set').execute(connArgs({ name: 'qa-only', env: 'qa' }))
    await box.tool('sql_connection_set').execute(connArgs({ name: 'prod-only', env: 'prod' }))
    await box.tool('sql_connection_set').execute(connArgs({ name: 'scratch' }))

    const value = await box.tool('sql_settings').execute({})
    assert.match(value.report, /当前环境（未设置），1 个可见连接/)
    assert.match(value.report, /## 可见连接（不限环境）/)
    assert.match(value.report, /scratch/)
    assert.match(value.report, /其它环境的连接：qa-only、prod-only/)
    assert.doesNotMatch(value.report, /\| qa-only \|/, '带环境的连接不进可用表')
    assert.doesNotMatch(value.report, /\| prod-only \|/, '带环境的连接不进可用表')
  } finally { box.cleanup() }
})

test('sql_settings：activeEnv 设了环境时，当前环境的 + default 的同列可用', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_config_set').execute({ environments: ['qa', 'prod'], activeEnv: 'qa' })
    await box.tool('sql_connection_set').execute(connArgs({ name: 'qa-only', env: 'qa' }))
    await box.tool('sql_connection_set').execute(connArgs({ name: 'prod-only', env: 'prod' }))
    await box.tool('sql_connection_set').execute(connArgs({ name: 'scratch' }))

    const value = await box.tool('sql_settings').execute({})
    assert.match(value.report, /当前环境 qa，2 个可见连接/)
    assert.match(value.report, /## 可见连接（当前环境 qa）/)
    assert.match(value.report, /\| qa-only \|/)
    assert.match(value.report, /\| scratch \|/, '不限环境的连接在任何环境都可用')
    assert.match(value.report, /其它环境的连接：prod-only/)
  } finally { box.cleanup() }
})

test('sql_settings：环境未配置时给出软提示，且不引导手动编辑', async () => {
  const box = makeSandbox()
  try {
    const value = await box.tool('sql_settings').execute({})
    assert.match(value.report, /## ⚠ 问题/)
    assert.match(value.report, /environments 为空，请先用 sql_config_set 配置环境清单。/)
    assert.match(value.report, /activeEnv 未设置，请先用 sql_config_set 指定当前环境。/)
    assert.doesNotMatch(value.report, /手动|编辑文件|settings\.json 里填/)
  } finally { box.cleanup() }
})
