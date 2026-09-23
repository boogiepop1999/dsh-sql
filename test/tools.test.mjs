import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSqlTools, resolveSettings, assertReadQuery } from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-sql-tools-'))
const cfg = resolveSettings({ connections: { local: { engine: 'sqlite', file: join(dir, 'app.db') } }, maxRows: 2 })
const fixed = (config) => () => config
const { tools, adapters } = buildSqlTools(fixed(cfg))
const query = tools.find((t) => t.name === 'sql_query')
const exec = tools.find((t) => t.name === 'sql_exec')
const schema = tools.find((t) => t.name === 'sql_schema')

test('工具 timeoutMs 取配置值', () => {
  const timed = buildSqlTools(fixed(resolveSettings({
    connections: cfg.connections,
    maxRows: 2,
    queryTimeoutMs: 15000,
    execTimeoutMs: 30000,
  }))).tools
  assert.equal(timed.find((t) => t.name === 'sql_query').timeoutMs, 15000)
  assert.equal(timed.find((t) => t.name === 'sql_exec').timeoutMs, 30000)
  assert.equal(timed.find((t) => t.name === 'sql_health').timeoutMs, 30000)
})

test('构建 5 个数据库操作工具且名字正确', () => {
  assert.deepEqual(tools.map((t) => t.name).sort(), ['sql_exec', 'sql_health', 'sql_query', 'sql_schema', 'sql_stats'])
})

test('每个工具 schema 是 object JSON Schema', () => {
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.parameters.properties, 'object')
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
})

test('不传 connection 直接报错（不再有默认连接）', async () => {
  await assert.rejects(() => query.execute({ sql: 'SELECT 1' }), /必须显式指定 connection/)
  await assert.rejects(() => exec.execute({ sql: 'SELECT 1' }), /必须显式指定 connection/)
  await assert.rejects(() => schema.execute({}), /必须显式指定 connection/)
})

test('sql_exec + sql_query + sql_schema 全链路', async () => {
  await exec.execute({ sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)', connection: 'local' })
  const insert = await exec.execute({ sql: "INSERT INTO items (label) VALUES ('a'), ('b'), ('c')", connection: 'local' })
  assert.equal(insert.changes, 3)
  const result = await query.execute({ sql: 'SELECT * FROM items ORDER BY id', connection: 'local' })
  assert.equal(result.rowCount, 3)
  assert.equal(result.rows.length, 2, 'maxRows=2 截断')
  assert.equal(result.truncated, true)
  const tables = await schema.execute({ connection: 'local' })
  assert.ok(tables.tables.includes('items'))
  const columns = await schema.execute({ table: 'items', connection: 'local' })
  assert.equal(columns.columns.length, 2)
  assert.equal(columns.columns[0].primaryKey, true)
})

test('sql_query 拒绝写语句与多语句', async () => {
  await assert.rejects(() => query.execute({ sql: 'DROP TABLE items', connection: 'local' }), /只接受只读语句/)
  await assert.rejects(() => query.execute({ sql: 'SELECT 1; SELECT 2', connection: 'local' }), /一条语句/)
})

test('sql_exec 在该连接 readOnly=true 时被禁用', async () => {
  const ro = buildSqlTools(fixed(resolveSettings({ connections: { local: { engine: 'sqlite', file: join(dir, 'app.db'), readOnly: true } } }))).tools
  const roExec = ro.find((t) => t.name === 'sql_exec')
  await assert.rejects(
    () => roExec.execute({ sql: 'INSERT INTO items (label) VALUES (\'x\')', connection: 'local' }),
    /readOnly=true/,
  )
})

test('连接级 readOnly 只影响该连接，其他连接仍可写', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'dsh-sql-rw-'))
  const multi = resolveSettings({
    connections: {
      locked: { engine: 'sqlite', file: join(dir2, 'a.db'), readOnly: true },
      open: { engine: 'sqlite', file: join(dir2, 'b.db') },
    },
  })
  const { tools: multiTools, adapters: multiAdapters } = buildSqlTools(fixed(multi))
  const multiExec = multiTools.find((t) => t.name === 'sql_exec')
  await assert.rejects(() => multiExec.execute({ sql: 'CREATE TABLE t (id INTEGER)', connection: 'locked' }), /readOnly=true/)
  const ok = await multiExec.execute({ sql: 'CREATE TABLE t (id INTEGER)', connection: 'open' })
  assert.equal(ok.connection, 'open')
  // 只读连接在写被拒前不该建适配器；只有 open 一个进池，关掉它临时目录才能删
  assert.equal(multiAdapters.size, 1, '只读连接不该建适配器')
  for (const adapter of multiAdapters.values()) await adapter.close()
  rmSync(dir2, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test('未知连接抛中文错误', async () => {
  await assert.rejects(() => query.execute({ sql: 'SELECT 1', connection: 'nope' }), /未找到名为 nope/)
})

test('execute 返回值可 JSON 序列化', async () => {
  const value = await query.execute({ sql: 'SELECT 1 AS one', connection: 'local' })
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
})

test('工具执行把 exec.signal 传入数据库适配器', async () => {
  const controller = new AbortController()
  controller.abort(new Error('cancel sql tool'))
  await assert.rejects(
    () => query.execute({ sql: 'SELECT 1', connection: 'local' }, { signal: controller.signal }),
    /cancel sql tool/,
  )
})

test('assertReadQuery 不误伤字符串/注释里的分号与写关键字', () => {
  assert.equal(assertReadQuery("SELECT 'delete;' AS label"), "SELECT 'delete;' AS label")
  assert.equal(assertReadQuery('SELECT 1 -- 注释里的 update\n'), 'SELECT 1 -- 注释里的 update')
  assert.equal(assertReadQuery('SELECT $tag$; update$tag$ AS body'), 'SELECT $tag$; update$tag$ AS body')
  assert.equal(assertReadQuery("SELECT data #>> '{a,b}' AS value FROM t"), "SELECT data #>> '{a,b}' AS value FROM t")
})

test('assertReadQuery 拒绝 data-modifying CTE / INTO OUTFILE / 行锁 / PRAGMA 赋值', () => {
  assert.throws(() => assertReadQuery('WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone'), /DELETE/)
  assert.throws(() => assertReadQuery("SELECT * FROM t INTO OUTFILE '/tmp/x'"), /INTO/)
  assert.throws(() => assertReadQuery('SELECT * FROM t FOR UPDATE'), /FOR UPDATE/)
  assert.throws(() => assertReadQuery('PRAGMA journal_mode = WAL'), /PRAGMA 写操作/)
})

test('assertReadQuery 连续调用始终拒绝同一 data-modifying CTE', () => {
  const sql = 'WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone'
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.throws(() => assertReadQuery(sql), /DELETE/)
  }
})

test('assertReadQuery 放行 SHOW CREATE TABLE 等元数据语句', () => {
  assert.equal(assertReadQuery('SHOW CREATE TABLE users'), 'SHOW CREATE TABLE users')
  assert.equal(assertReadQuery('EXPLAIN SELECT 1'), 'EXPLAIN SELECT 1')
})

test('cleanup', async () => {
  for (const adapter of adapters.values()) await adapter.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
