import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSqlTools, resolveSettings, toCsv } from '../lib/index.js'

function makeTools() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sql-stats-'))
  const cfg = resolveSettings({ connections: { local: { engine: 'sqlite', file: join(dir, 'stats.db') } }, maxRows: 100 })
  const { tools } = buildSqlTools(() => cfg)
  const exec = tools.find((t) => t.name === 'sql_exec')
  return { tools, exec }
}

test('sql_stats：表数/行数/库体积', async () => {
  const { tools, exec } = makeTools()
  await exec.execute({ sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)', connection: 'local' })
  await exec.execute({ sql: "INSERT INTO items (label) VALUES ('a'), ('b'), ('c')", connection: 'local' })
  const stats = tools.find((t) => t.name === 'sql_stats')
  const value = await stats.execute({ connection: 'local' })
  assert.equal(value.connection, 'local')
  assert.equal(value.engine, 'sqlite')
  assert.ok(value.tableCount >= 1)
  const items = value.tables.find((t) => t.name === 'items')
  assert.equal(items.rowCount, 3)
  assert.ok(value.sizeBytes > 0)
  const blocks = stats.output.render({}, value)
  assert.match(blocks[0].text, /共 \d+ 张表/)
})

test('sql_stats：不存在的连接给中文指引', async () => {
  const { tools } = makeTools()
  const stats = tools.find((t) => t.name === 'sql_stats')
  await assert.rejects(() => stats.execute({ connection: 'nope' }), /sql_settings/)
})

test('sql_query format=csv：含表头与转义', async () => {
  const { tools, exec } = makeTools()
  await exec.execute({ sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT)', connection: 'local' })
  await exec.execute({ sql: "INSERT INTO t (note) VALUES ('he said \"hi\", ok'), ('line1\nline2')", connection: 'local' })
  const query = tools.find((t) => t.name === 'sql_query')
  const value = await query.execute({ sql: 'SELECT id, note FROM t ORDER BY id', format: 'csv', connection: 'local' })
  assert.equal(value.format, 'csv')
  const lines = value.formatted.split('\n')
  assert.equal(lines[0], 'id,note')
  assert.equal(lines[1], '1,"he said ""hi"", ok"')
  assert.match(lines[2], /^2,"line1/)
  const blocks = query.output.render({}, value)
  assert.match(blocks[0].text, /csv 格式/)
})

test('sql_query format=json：可解析回对象数组', async () => {
  const { tools, exec } = makeTools()
  await exec.execute({ sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT)', connection: 'local' })
  await exec.execute({ sql: "INSERT INTO t (note) VALUES ('x')", connection: 'local' })
  const query = tools.find((t) => t.name === 'sql_query')
  const value = await query.execute({ sql: 'SELECT id, note FROM t', format: 'json', connection: 'local' })
  const parsed = JSON.parse(value.formatted)
  assert.deepEqual(parsed, [{ id: 1, note: 'x' }])
})

test('sql_query 默认格式不产生 formatted 字段', async () => {
  const { tools, exec } = makeTools()
  await exec.execute({ sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY)', connection: 'local' })
  const query = tools.find((t) => t.name === 'sql_query')
  const value = await query.execute({ sql: 'SELECT * FROM t', connection: 'local' })
  assert.equal(value.formatted, undefined)
})

test('sql_query：非法 format 直接报错，不静默退化', async () => {
  const { tools } = makeTools()
  const query = tools.find((t) => t.name === 'sql_query')
  await assert.rejects(
    () => query.execute({ sql: 'SELECT 1', format: 'XML', connection: 'local' }),
    /format 只支持 table \/ csv \/ json/,
  )
})

test('toCsv 空结果只输出表头', () => {
  assert.equal(toCsv(['a', 'b'], []), 'a,b')
})

test('sql_health：只探活，不含全局设置', async () => {
  const { tools } = makeTools()
  const health = tools.find((t) => t.name === 'sql_health')
  const value = await health.execute({})
  assert.equal(value.ok, true)
  assert.equal(value.connections[0].ok, true)
  assert.equal(value.connections[0].name, 'local')
  assert.equal(value.maxRows, undefined, '全局设置归 sql_settings，不再出现在探活结果里')
  assert.deepEqual(Object.keys(value).sort(), ['connections', 'ok'])
  const blocks = health.output.render({}, value)
  assert.match(blocks[0].text, /探活：全部连接正常/)
})

test('sql_health：坏连接报 ok=false 且错误可读', async () => {
  const cfg = resolveSettings({ connections: { bad: { engine: 'mysql', host: '127.0.0.1', port: 1, database: 'x', user: 'u', password: 'p' } }, maxRows: 10, queryTimeoutMs: 5000, execTimeoutMs: 5000 })
  const { tools } = buildSqlTools(() => cfg)
  const health = tools.find((t) => t.name === 'sql_health')
  const value = await health.execute({})
  assert.equal(value.ok, false)
  assert.equal(value.connections[0].ok, false)
  assert.notEqual(value.connections[0].error, '')
})

test('sql_health：多连接并发探活，结果按配置顺序返回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sql-ping-'))
  const cfg = resolveSettings({
    connections: {
      a: { engine: 'sqlite', file: join(dir, 'a.db') },
      b: { engine: 'sqlite', file: join(dir, 'b.db') },
      c: { engine: 'sqlite', file: join(dir, 'c.db') },
    },
  })
  const { tools, adapters } = buildSqlTools(() => cfg)
  const health = tools.find((t) => t.name === 'sql_health')
  const started = Date.now()
  const value = await health.execute({})
  const elapsed = Date.now() - started
  assert.equal(value.ok, true)
  assert.deepEqual(value.connections.map((c) => c.name), ['a', 'b', 'c'], '保持配置顺序')
  assert.ok(value.connections.every((c) => c.ok === true && c.error === ''))
  assert.ok(elapsed < 2000, '并发探活不该串行累加耗时')
  for (const adapter of adapters.values()) await adapter.close()
  // Windows 上 SQLite 句柄释放有延迟，直接 rm 会偶发 EPERM
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('sql_health：只探在 activeEnv 下可见的连接', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sql-ping-env-'))
  const cfg = resolveSettings({
    activeEnv: 'qa',
    environments: ['qa', 'pro'],
    connections: {
      'qa-db': { engine: 'sqlite', file: join(dir, 'qa.db'), env: 'qa' },
      'pro-db': { engine: 'sqlite', file: join(dir, 'pro.db'), env: 'pro' },
      common: { engine: 'sqlite', file: join(dir, 'common.db') },
    },
  })
  const { tools, adapters } = buildSqlTools(() => cfg)
  const health = tools.find((t) => t.name === 'sql_health')
  const value = await health.execute({})
  assert.deepEqual(
    value.connections.map((c) => c.name),
    ['qa-db', 'common'],
    '当前环境的 + 未标环境的，pro 的排除在外',
  )
  assert.equal(value.ok, true)
  for (const adapter of adapters.values()) await adapter.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('sql_health：activeEnv 为空时只探不限环境的', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sql-ping-noenv-'))
  const cfg = resolveSettings({
    environments: ['qa', 'pro'],
    connections: {
      'qa-db': { engine: 'sqlite', file: join(dir, 'qa.db'), env: 'qa' },
      'pro-db': { engine: 'sqlite', file: join(dir, 'pro.db'), env: 'pro' },
      common: { engine: 'sqlite', file: join(dir, 'common.db') },
    },
  })
  const { tools, adapters } = buildSqlTools(() => cfg)
  const value = await tools.find((t) => t.name === 'sql_health').execute({})
  assert.deepEqual(value.connections.map((c) => c.name), ['common'], '没设环境 → 只有不限环境的')
  for (const adapter of adapters.values()) await adapter.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('sql_health：activeEnv 下没有可见连接时给指引而不是「全部正常」', async () => {
  const cfg = resolveSettings({
    activeEnv: 'qa',
    environments: ['qa', 'pro'],
    connections: { 'pro-db': { engine: 'sqlite', file: ':memory:', env: 'pro' } },
  })
  const { tools } = buildSqlTools(() => cfg)
  const value = await tools.find((t) => t.name === 'sql_health').execute({})
  assert.equal(value.ok, true)
  assert.deepEqual(value.connections, [])
  const blocks = tools.find((t) => t.name === 'sql_health').output.render({}, value)
  assert.match(blocks[0].text, /没有可见的连接/)
  assert.doesNotMatch(blocks[0].text, /全部连接正常/, '0 个连接不该说成全部正常')
})

test('sql_schema：查不存在的表说「不存在」，不能说成「0 张表」', async () => {
  const { tools, exec } = makeTools()
  await exec.execute({ sql: 'CREATE TABLE items (id INTEGER)', connection: 'local' })
  const schema = tools.find((t) => t.name === 'sql_schema')

  const missing = await schema.execute({ connection: 'local', table: 'nope' })
  assert.equal(missing.tableMissing, true)
  const text = schema.output.render({}, missing)[0].text
  assert.match(text, /不存在/)
  assert.doesNotMatch(text, /共 0 张表/, '「表不存在」不能让 AI 以为库是空的')
  assert.match(text, /items/, '附上可用表名，方便确认是写错还是没权限')

  const ok = await schema.execute({ connection: 'local', table: 'items' })
  assert.equal(ok.tableMissing, false)
  assert.match(schema.output.render({}, ok)[0].text, /表 items 的列/)
})

test('sql_stats：表数用 tableCount 且失败原因要显式给出', async () => {
  const cfg = resolveSettings({ connections: { local: { engine: 'sqlite', file: ':memory:' } } })
  const { tools } = buildSqlTools(() => cfg)
  const stats = tools.find((t) => t.name === 'sql_stats')

  // 直接构造 execute 在「表清单/库体积查询失败」时会返回的形状
  const value = {
    connection: 'my', engine: 'mysql', tableCount: 2, sizeBytes: -1,
    tables: [{ name: 'users', rowCount: 42 }, { name: 'orders', rowCount: 18 }],
    tablesError: 'permission denied for information_schema',
    sizeError: 'Access denied for PROCESS privilege',
  }
  const text = stats.output.render({}, value)[0].text
  assert.match(text, /共 2 张表/, '计数用 tableCount')
  assert.match(text, /表清单不可用：permission denied/)
  assert.match(text, /库体积不可用：Access denied/)
  assert.doesNotMatch(text, /共 3 张表/, '不能把失败项也算成表')
})
