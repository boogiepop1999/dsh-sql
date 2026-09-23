import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdapter } from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-sql-int-'))
const file = join(dir, 'test.db')
const adapter = createAdapter({ name: 't', engine: 'sqlite', file })

test('SQLite：建表/插入/查询/描述/列表', async () => {
  await adapter.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL)')
  await adapter.exec("INSERT INTO users (name, score) VALUES ('张三', 99.5)")
  await adapter.exec("INSERT INTO users (name, score) VALUES ('李四', 88)")
  const result = await adapter.query('SELECT id, name, score FROM users ORDER BY id')
  assert.deepEqual(result.columns, ['id', 'name', 'score'])
  assert.equal(result.rows.length, 2)
  assert.deepEqual(result.rows[0], [1, '张三', 99.5])
  const tables = await adapter.listTables()
  assert.ok(tables.includes('users'))
  const columns = await adapter.describeTable('users')
  assert.equal(columns.length, 3)
  assert.equal(columns[0].primaryKey, true)
  assert.equal(columns[1].notNull, true)
})

test('SQLite：exec 返回 changes；多语句拦下（不静默丢语句）', async () => {
  const changes = await adapter.exec('UPDATE users SET score = 100 WHERE name = \'张三\'')
  assert.equal(changes, 1)
  // node:sqlite 的 prepare().run() 遇多语句不报错、只执行第一条 —— 必须自己拦，否则后续语句被无声丢弃。
  await assert.rejects(
    () => adapter.exec('CREATE TABLE a (x INTEGER); CREATE TABLE b (y INTEGER)'),
    /一次只能执行一条语句/,
  )
})

test('SQLite：query(limit) 只迭代前 N 行，不全量载入', async () => {
  const capped = await adapter.query('SELECT id, name FROM users ORDER BY id', 1)
  assert.deepEqual(capped.columns, ['id', 'name'])
  assert.equal(capped.rows.length, 1)
  assert.deepEqual(capped.rows[0], [1, '张三'])
})

test('SQLite：ping 与关闭', async () => {
  await adapter.ping()
  await adapter.close()
  await assert.rejects(() => adapter.ping())
})

test('cleanup', () => { rmSync(dir, { recursive: true, force: true }) })
