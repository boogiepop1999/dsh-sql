import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSettings, assertIdentifier, passwordEnvName, splitConnectionsByEnv } from '../lib/index.js'

/** 解析后的连接按名字取（字典 → 列表，列表元素带 name）。 */
const byName = (cfg, name) => cfg.connections.find((conn) => conn.name === name)

test('空配置不补任何连接（由 sql_settings 告警指路）', () => {
  const cfg = resolveSettings({})
  assert.equal(cfg.connections.length, 0)
  assert.equal(cfg.maxRows, 1000)
  assert.equal(cfg.activeEnv, '')
  assert.deepEqual(cfg.environments, [])
})

test('多连接解析 + 密码环境变量回退', () => {
  const cfg = resolveSettings({
    connections: {
      local: { engine: 'sqlite', file: './x.db' },
      prod: { engine: 'postgres', host: 'db.internal', database: 'app' },
    },
  }, { DSH_SQL_PASSWORD_PROD: 'secret123' })
  assert.equal(cfg.connections.length, 2)
  const prod = byName(cfg, 'prod')
  assert.equal(prod.port, 5432)
  assert.equal(prod.password, 'secret123')
  assert.equal(passwordEnvName('my-db'), 'DSH_SQL_PASSWORD_MY_DB')
})

test('字典的键即连接名（区分大小写）', () => {
  const cfg = resolveSettings({
    connections: {
      qa: { engine: 'sqlite', file: ':memory:' },
      QA: { engine: 'sqlite', file: ':memory:' },
    },
  })
  assert.equal(cfg.connections.length, 2, '大小写不同视为两条')
  assert.ok(byName(cfg, 'qa') !== undefined)
  assert.ok(byName(cfg, 'QA') !== undefined)
})

test('读取侧不校验：非法配置也原样读出（校验在写入工具）', () => {
  // 这些以前会抛错，现在读取侧一律放行 —— 配置错了不该让插件整体崩掉。
  assert.doesNotThrow(() => resolveSettings({ connections: { x: { engine: 'oracle' } } }))
  assert.doesNotThrow(() => resolveSettings({ connections: { a: { engine: 'postgres' } } }))
  assert.doesNotThrow(() => resolveSettings({ maxRows: -1 }))
  assert.doesNotThrow(() => resolveSettings({ environments: 'not-an-array' }))
})

test('database 读取侧不强制：postgres 缺库也能读出来', () => {
  const mysql = resolveSettings({ connections: { my: { engine: 'mysql', host: 'db' } } })
  assert.equal(byName(mysql, 'my').database, '')
  const withDb = resolveSettings({ connections: { my: { engine: 'mysql', host: 'db', database: 'app' } } })
  assert.equal(byName(withDb, 'my').database, 'app')
  const pg = resolveSettings({ connections: { pg: { engine: 'postgres', host: 'db' } } })
  assert.equal(byName(pg, 'pg').database, '', '读取侧不拦，由 sql_connection_set 把关')
})

test('连接级 readOnly 与 description', () => {
  const cfg = resolveSettings({
    connections: {
      qa: { engine: 'sqlite', file: ':memory:' },
      prod: { engine: 'sqlite', file: ':memory:', readOnly: true, description: '  生产库，慎写  ' },
    },
  })
  assert.equal(byName(cfg, 'qa').readOnly, false, '默认可写')
  assert.equal(byName(cfg, 'qa').description, undefined)
  assert.equal(byName(cfg, 'prod').readOnly, true)
  assert.equal(byName(cfg, 'prod').description, '生产库，慎写', '首尾空白应被去掉')
})

test('description 读取侧不截断也不校验（长度由写入侧把关）', () => {
  const long = 'x'.repeat(150)
  const cfg = resolveSettings({ connections: { a: { engine: 'sqlite', file: ':memory:', description: long } } })
  assert.equal(byName(cfg, 'a').description, long, '原样读出，不截断')
})

test('env 读取侧归一：空串不写入', () => {
  const cfg = resolveSettings({
    connections: {
      a: { engine: 'sqlite', env: 'qa' },
      b: { engine: 'sqlite', env: '  ' },
    },
  })
  assert.equal(byName(cfg, 'a').env, 'qa')
  assert.equal(byName(cfg, 'b').env, undefined)
})

test('environments 读取侧去重去空', () => {
  const cfg = resolveSettings({ environments: ['qa', 'qa', '', '  ', 'prod'] })
  assert.deepEqual(cfg.environments, ['qa', 'prod'])
})

test('activeEnv 读取侧 trim，缺省为空串', () => {
  assert.equal(resolveSettings({}).activeEnv, '')
  assert.equal(resolveSettings({ activeEnv: '  qa  ' }).activeEnv, 'qa')
})

test('queryTimeoutMs / execTimeoutMs 缺省与钳制', () => {
  const defaults = resolveSettings({})
  assert.equal(defaults.queryTimeoutMs, 60000)
  assert.equal(defaults.execTimeoutMs, 120000)
  const custom = resolveSettings({ queryTimeoutMs: 7000, execTimeoutMs: 9999999 })
  assert.equal(custom.queryTimeoutMs, 7000)
  assert.equal(custom.execTimeoutMs, 600000)
  // 非法值不再抛错（范围校验在 sql_config_set），读取侧只做钳制
  assert.doesNotThrow(() => resolveSettings({ queryTimeoutMs: -1 }))
  assert.doesNotThrow(() => resolveSettings({ execTimeoutMs: 'x' }))
})

test('maxRows 钳制到 10000', () => {
  assert.equal(resolveSettings({ maxRows: 999999 }).maxRows, 10000)
})

test('assertIdentifier 防注入', () => {
  assert.equal(assertIdentifier('users', '表名'), 'users')
  assert.throws(() => assertIdentifier('users; DROP TABLE x', '表名'), /非法/)
  assert.throws(() => assertIdentifier('a b', '表名'), /非法/)
})

test('splitConnectionsByEnv：当前环境的 + 未标环境的可用，其它环境排除', () => {
  const cfg = resolveSettings({
    activeEnv: 'qa',
    environments: ['qa', 'pro'],
    connections: {
      'qa-db': { engine: 'sqlite', env: 'qa' },
      'pro-db': { engine: 'sqlite', env: 'pro' },
      common: { engine: 'sqlite' },
      'blank-env': { engine: 'sqlite', env: '   ' },
    },
  })
  const { available, excluded } = splitConnectionsByEnv(cfg)
  assert.deepEqual(available.map((c) => c.name), ['qa-db', 'common', 'blank-env'])
  assert.deepEqual(excluded.map((c) => c.name), ['pro-db'])
})

test('splitConnectionsByEnv：activeEnv 为空时只有不限环境的可用', () => {
  const cfg = resolveSettings({
    environments: ['qa', 'pro'],
    connections: {
      'qa-db': { engine: 'sqlite', env: 'qa' },
      'pro-db': { engine: 'sqlite', env: 'pro' },
      common: { engine: 'sqlite' },
    },
  })
  const { available, excluded } = splitConnectionsByEnv(cfg)
  assert.deepEqual(available.map((c) => c.name), ['common'], '没设环境 → 只有不限环境的')
  assert.deepEqual(excluded.map((c) => c.name), ['qa-db', 'pro-db'], '带环境的一律算其它环境')
})

test('splitConnectionsByEnv：环境名区分大小写', () => {
  const cfg = resolveSettings({
    activeEnv: 'QA',
    connections: { 'qa-db': { engine: 'sqlite', env: 'qa' } },
  })
  const { available, excluded } = splitConnectionsByEnv(cfg)
  assert.deepEqual(available, [], 'QA ≠ qa')
  assert.deepEqual(excluded.map((c) => c.name), ['qa-db'])
})
