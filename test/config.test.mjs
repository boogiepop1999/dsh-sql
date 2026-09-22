import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSettings, assertIdentifier, passwordEnvName } from '../lib/index.js'

test('默认：内存 SQLite 兜底连接', () => {
  const cfg = resolveSettings({})
  assert.equal(cfg.connections.length, 1)
  assert.equal(cfg.connections[0].name, 'default')
  assert.equal(cfg.connections[0].engine, 'sqlite')
  assert.equal(cfg.connections[0].file, ':memory:')
  assert.equal(cfg.connections[0].readOnly, false)
  assert.equal(cfg.maxRows, 1000)
})

test('多连接解析 + 密码环境变量回退', () => {
  const cfg = resolveSettings({
    connections: [
      { name: 'local', engine: 'sqlite', file: './x.db' },
      { name: 'prod', engine: 'postgres', host: 'db.internal', database: 'app' },
    ],
  }, { DSH_SQL_PASSWORD_PROD: 'secret123' })
  assert.equal(cfg.connections.length, 2)
  const prod = cfg.connections[1]
  assert.equal(prod.port, 5432)
  assert.equal(prod.password, 'secret123')
  assert.equal(passwordEnvName('my-db'), 'DSH_SQL_PASSWORD_MY_DB')
})

test('配置非法抛中文错误', () => {
  assert.throws(() => resolveSettings({ connections: [{ name: '', engine: 'sqlite' }] }), /需要 name/)
  assert.throws(() => resolveSettings({ connections: [{ name: 'x', engine: 'oracle' }] }), /sqlite \/ mysql \/ postgres/)
  assert.throws(() => resolveSettings({ connections: [{ name: 'a', engine: 'sqlite' }, { name: 'A', engine: 'sqlite' }] }), /重复/)
  assert.throws(() => resolveSettings({ connections: [{ name: 'a', engine: 'postgres' }] }), /缺少 database/)
  assert.throws(() => resolveSettings({ maxRows: -1 }), /maxRows/)
})

test('database 仅 postgres 必填，mysql 可留空', () => {
  const mysql = resolveSettings({ connections: [{ name: 'my', engine: 'mysql', host: 'db' }] })
  assert.equal(mysql.connections[0].database, '')
  const withDb = resolveSettings({ connections: [{ name: 'my', engine: 'mysql', host: 'db', database: 'app' }] })
  assert.equal(withDb.connections[0].database, 'app')
  assert.throws(() => resolveSettings({ connections: [{ name: 'pg', engine: 'postgres', host: 'db' }] }), /缺少 database/)
})

test('连接级 readOnly 与 description', () => {
  const cfg = resolveSettings({
    connections: [
      { name: 'qa', engine: 'sqlite', file: ':memory:' },
      { name: 'prod', engine: 'sqlite', file: ':memory:', readOnly: true, description: '  生产库，慎写  ' },
    ],
  })
  assert.equal(cfg.connections[0].readOnly, false, '默认可写')
  assert.equal(cfg.connections[0].description, undefined)
  assert.equal(cfg.connections[1].readOnly, true)
  assert.equal(cfg.connections[1].description, '生产库，慎写', '首尾空白应被去掉')
})

test('description 超 100 字符截断', () => {
  const long = 'x'.repeat(150)
  const cfg = resolveSettings({ connections: [{ name: 'a', engine: 'sqlite', file: ':memory:', description: long }] })
  assert.equal(cfg.connections[0].description.length, 100)
})

test('queryTimeoutMs / execTimeoutMs 默认、校验与钳制', () => {
  const defaults = resolveSettings({})
  assert.equal(defaults.queryTimeoutMs, 60000)
  assert.equal(defaults.execTimeoutMs, 120000)
  const custom = resolveSettings({ queryTimeoutMs: 7000, execTimeoutMs: 9999999 })
  assert.equal(custom.queryTimeoutMs, 7000)
  assert.equal(custom.execTimeoutMs, 600000)
  assert.throws(() => resolveSettings({ queryTimeoutMs: -1 }), /queryTimeoutMs/)
  assert.throws(() => resolveSettings({ execTimeoutMs: 'x' }), /execTimeoutMs/)
})

test('maxRows 钳制到 10000', () => {
  assert.equal(resolveSettings({ maxRows: 999999 }).maxRows, 10000)
})

test('assertIdentifier 防注入', () => {
  assert.equal(assertIdentifier('users', '表名'), 'users')
  assert.throws(() => assertIdentifier('users; DROP TABLE x', '表名'), /非法/)
  assert.throws(() => assertIdentifier('a b', '表名'), /非法/)
})
