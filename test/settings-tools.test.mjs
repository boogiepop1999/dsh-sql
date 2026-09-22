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
    tool: byName,
    cleanup() { delete process.env[SETTINGS_DIR_ENV]; rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) },
  }
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

test('sql_settings：首次调用生成出厂设置并渲染连接表', async () => {
  const box = makeSandbox()
  try {
    const value = await box.tool('sql_settings').execute({})
    assert.match(value.report, /# dsh-sql — 共 1 个连接/)
    assert.match(value.report, /default/)
    assert.match(value.report, /sqlite/)
    const blocks = box.tool('sql_settings').output.render({}, value)
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /## 全局设置/)
    const written = box.read()
    assert.equal(written.connections[0].name, 'default')
  } finally { box.cleanup() }
})

test('sql_settings：只读与描述出现在报告里', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_connection_set').execute({ name: 'prod', engine: 'sqlite', file: '/tmp/p.db', readOnly: true, description: '生产库，慎写' })
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
    const out = await box.tool('sql_connection_set').execute({
      name: 'qa', engine: 'mysql', host: '10.0.0.1', port: 3307, user: 'u', password: 'p', database: 'app',
    })
    assert.match(out.report, /已写入连接 "qa"/)
    const written = box.read()
    const qa = written.connections.find((c) => c.name === 'qa')
    assert.equal(qa.engine, 'mysql')
    assert.equal(qa.host, '10.0.0.1')
    assert.equal(qa.port, 3307)
    assert.equal(qa.database, 'app')
  } finally { box.cleanup() }
})

test('sql_connection_set：同名覆盖，不产生重复项', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_connection_set').execute({ name: 'qa', engine: 'sqlite', file: '/a.db' })
    await box.tool('sql_connection_set').execute({ name: 'qa', engine: 'sqlite', file: '/b.db' })
    const written = box.read()
    const matches = written.connections.filter((c) => c.name === 'qa')
    assert.equal(matches.length, 1, '同名应覆盖而非追加')
    assert.equal(matches[0].file, '/b.db')
  } finally { box.cleanup() }
})

test('sql_connection_set：引擎非法报错且不落盘', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_settings').execute({})   // 先生成出厂设置
    const before = box.read()
    await assert.rejects(
      () => box.tool('sql_connection_set').execute({ name: 'x', engine: 'oracle' }),
      /engine 必须是 sqlite \/ mysql \/ postgres/,
    )
    assert.deepEqual(box.read(), before, '校验失败不该改文件')
  } finally { box.cleanup() }
})

test('sql_connection_set：postgres 缺 database 报错', async () => {
  const box = makeSandbox()
  try {
    await assert.rejects(
      () => box.tool('sql_connection_set').execute({ name: 'pg', engine: 'postgres', host: 'h' }),
      /缺少 database/,
    )
  } finally { box.cleanup() }
})

test('sql_connection_set：mysql 允许不填 database', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_connection_set').execute({ name: 'my', engine: 'mysql', host: 'h' })
    const my = box.read().connections.find((c) => c.name === 'my')
    assert.ok(my !== undefined)
    assert.ok(my.database === undefined || my.database === '')
  } finally { box.cleanup() }
})

test('sql_connection_set：description 超 100 字符被截断', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_connection_set').execute({ name: 'a', engine: 'sqlite', description: 'x'.repeat(150) })
    const a = box.read().connections.find((c) => c.name === 'a')
    assert.equal(a.description.length, 100)
  } finally { box.cleanup() }
})

test('sql_connection_remove：删除连接并落盘', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_connection_set').execute({ name: 'gone', engine: 'sqlite' })
    const out = await box.tool('sql_connection_remove').execute({ name: 'gone' })
    assert.match(out.report, /已删除连接 "gone"/)
    assert.equal(box.read().connections.some((c) => c.name === 'gone'), false)
  } finally { box.cleanup() }
})

test('sql_connection_remove：不存在的连接报错并列出可用项', async () => {
  const box = makeSandbox()
  try {
    await box.tool('sql_settings').execute({})
    await assert.rejects(
      () => box.tool('sql_connection_remove').execute({ name: 'nope' }),
      /连接 "nope" 不存在.*default/s,
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
    await assert.rejects(() => box.tool('sql_config_set').execute({ queryTimeoutMs: 10 }), /5000~600000/)
    assert.deepEqual(box.read(), before)
  } finally { box.cleanup() }
})

test('闭环：工具写入的连接，sql_query 立刻能用（不重启）', async () => {
  const box = makeSandbox()
  try {
    const dbFile = join(box.dir, 'live.db')
    await box.tool('sql_connection_set').execute({ name: 'live', engine: 'sqlite', file: dbFile })

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
    await box.tool('sql_connection_set').execute({ name: 'temp', engine: 'sqlite', file: join(box.dir, 'temp.db') })
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
    await box.tool('sql_connection_set').execute({ name: 'cap', engine: 'sqlite', file: dbFile })

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
