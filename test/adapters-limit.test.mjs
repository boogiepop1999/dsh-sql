import { test } from 'node:test'
import assert from 'node:assert/strict'
import MysqlQuery from '../node_modules/mysql2/lib/commands/query.js'
import pg from 'pg'
import { createAdapter } from '../lib/index.js'

function pgFixture(values, { fail = false, stall = false } = {}) {
  const adapter = createAdapter({ name: 'pg', engine: 'postgres', host: 'h', port: 5432, user: 'u', password: 'p', database: 'app' })
  const state = { released: [], produced: 0, query: undefined }
  adapter.pool = {
    async connect() {
      return {
        release(force) { state.released.push(force === true) },
        query(query) {
          assert.ok(query instanceof pg.Query)
          state.query = query
          queueMicrotask(() => {
            if (stall) return
            if (fail) return query.emit('error', new Error('pg query failed'))
            query.handleRowDescription({ fields: [{ name: 'a', dataTypeID: 23, format: 'text' }] })
            for (const value of values) {
              if (state.released.includes(true)) break
              state.produced += 1
              query.handleDataRow({ fields: [Buffer.from(String(value))] })
            }
            if (state.released.includes(true)) query.emit('error', new Error('connection closed'))
            else query.emit('end', query._result)
          })
          return query
        },
      }
    },
  }
  return { adapter, state }
}

test('PostgreSQL：真实 pg.Query 行事件在上限结束，内部不累计结果', async () => {
  const { adapter, state } = pgFixture([1, 2, 3, 4, 5])
  const result = await adapter.query('SELECT a FROM t ORDER BY a', 3)
  assert.deepEqual(result, { columns: ['a'], rows: [[1], [2], [3]] })
  assert.equal(state.produced, 3)
  assert.deepEqual(state.released, [true])
  assert.deepEqual(state.query._result.rows, [])
})

function mysqlFixture(values, { fail = false, stall = false } = {}) {
  const adapter = createAdapter({ name: 'my', engine: 'mysql', host: 'h', port: 3306, user: 'u', password: 'p', database: 'app' })
  const state = { destroyed: false, released: false, produced: 0 }
  adapter.pool = {
    async getConnection() {
      return {
        destroy() { state.destroyed = true },
        release() { state.released = true },
        connection: {
          query(sql) {
            const query = new MysqlQuery({ sql })
            let paused = false
            let ended = false
            const pump = () => {
              if (ended || state.destroyed) return
              if (stall) return
              if (fail) { ended = true; query.emit('error', new Error('mysql query failed')); return }
              while (!paused && !state.destroyed && state.produced < values.length) {
                query.emit('result', { a: values[state.produced++] })
              }
              if (!state.destroyed && state.produced === values.length) {
                ended = true
                query.emit('end')
              }
            }
            query._connection = {
              pause() { paused = true },
              resume() { paused = false; queueMicrotask(pump) },
            }
            queueMicrotask(() => { query.emit('fields', [{ name: 'a' }]); pump() })
            return query
          },
        },
      }
    },
  }
  return { adapter, state }
}

test('MySQL：真实 mysql2 Readable 消费超过 64 行，并在上限销毁专用连接', { timeout: 1000 }, async () => {
  const { adapter, state } = mysqlFixture(Array.from({ length: 250 }, (_, i) => i))
  const result = await adapter.query('SELECT a FROM t ORDER BY a', 150)
  assert.deepEqual(result.columns, ['a'])
  assert.equal(result.rows.length, 150)
  assert.deepEqual(result.rows[149], [149])
  assert.equal(state.destroyed, true)
  assert.equal(state.released, false)
})

test('MySQL / PostgreSQL：少于上限和零行结果保留列名、正常归还连接', async () => {
  for (const makeFixture of [mysqlFixture, pgFixture]) {
    for (const values of [[], [1, 2]]) {
      const { adapter, state } = makeFixture(values)
      const result = await adapter.query('SELECT a FROM t', 10)
      assert.deepEqual(result, { columns: ['a'], rows: values.map(value => [value]) })
      if (makeFixture === mysqlFixture) {
        assert.equal(state.destroyed, false)
        assert.equal(state.released, true)
      } else assert.deepEqual(state.released, [false])
    }
  }
})

test('PostgreSQL：有界查询转发驱动错误并归还连接', async () => {
  const { adapter, state } = pgFixture([], { fail: true })
  await assert.rejects(adapter.query('SELECT broken', 10), /pg query failed/)
  assert.deepEqual(state.released, [false])
})

test('MySQL：有界查询转发 Readable 错误', async () => {
  const { adapter, state } = mysqlFixture([], { fail: true })
  await assert.rejects(adapter.query('SELECT broken', 10), /mysql query failed/)
  assert.equal(state.released, true)
})

test('MySQL / PostgreSQL：有界查询取消时销毁专用连接', async () => {
  for (const makeFixture of [mysqlFixture, pgFixture]) {
    const { adapter, state } = makeFixture([], { stall: true })
    const controller = new AbortController()
    const pending = adapter.query('SELECT slow', 10, controller.signal)
    await new Promise(resolve => setImmediate(resolve))
    controller.abort(new Error('cancel capped query'))
    await assert.rejects(pending, /cancel capped query/)
    if (makeFixture === mysqlFixture) {
      assert.equal(state.destroyed, true)
      assert.equal(state.released, false)
    } else assert.deepEqual(state.released, [true])
  }
})

test('MySQL / PostgreSQL：已取消的有界查询不请求连接', async () => {
  for (const engine of ['mysql', 'postgres']) {
    // 这个用例只验证「取消时不请求连接」，pool 随即被替换成探针，
    // 但 createAdapter 会校验必填字段，所以得给全。
    const adapter = createAdapter({
      name: 'unused',
      engine,
      host: 'h',
      port: engine === 'postgres' ? 5432 : 3306,
      user: 'u',
      password: 'p',
      database: 'app',
    })
    adapter.pool = {
      connect() { assert.fail('must not connect') },
      getConnection() { assert.fail('must not acquire') },
    }
    const controller = new AbortController()
    controller.abort(new Error('cancelled before query'))
    await assert.rejects(adapter.query('SELECT a', 10, controller.signal), /cancelled before query/)
  }
})

test('查询结果 bigint：安全整数转 number，超出安全范围转十进制字符串', async () => {
  const adapter = createAdapter({ name: 'my', engine: 'mysql', host: 'h', port: 3306, user: 'u', password: 'p', database: 'app' })
  adapter.pool = {
    async query(sql) {
      assert.equal(sql, 'SELECT safe, too_large, too_small FROM t')
      return [[{
        safe: 9007199254740991n,
        too_large: 9007199254740993n,
        too_small: -9007199254740993n,
      }], []]
    },
  }

  const result = await adapter.query('SELECT safe, too_large, too_small FROM t')
  assert.deepEqual(result.columns, ['safe', 'too_large', 'too_small'])
  assert.deepEqual(result.rows, [[9007199254740991, '9007199254740993', '-9007199254740993']])
  assert.doesNotThrow(() => JSON.stringify(result))
})

test('MySQL：取消信号销毁专用连接，不把取消后的连接放回池', async () => {
  const adapter = createAdapter({ name: 'my', engine: 'mysql', host: 'h', port: 3306, user: 'u', password: 'p', database: 'app' })
  let destroyed = false
  let released = false
  adapter.pool = {
    async getConnection() {
      return {
        query: async () => await new Promise(() => {}),
        destroy() { destroyed = true },
        release() { released = true },
      }
    },
  }
  const controller = new AbortController()
  const pending = adapter.query('SELECT SLEEP(10)', undefined, controller.signal)
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort(new Error('cancel mysql'))
  await assert.rejects(pending, /cancel mysql/)
  assert.equal(destroyed, true)
  assert.equal(released, false)
})

test('PostgreSQL：取消信号销毁专用连接', async () => {
  const adapter = createAdapter({ name: 'pg', engine: 'postgres', host: 'h', port: 5432, user: 'u', password: 'p', database: 'app' })
  let forcedRelease = false
  adapter.pool = {
    async connect() {
      return {
        query: async () => await new Promise(() => {}),
        release(force) { forcedRelease = force === true },
      }
    },
  }
  const controller = new AbortController()
  const pending = adapter.query('SELECT pg_sleep(10)', undefined, controller.signal)
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort(new Error('cancel postgres'))
  await assert.rejects(pending, /cancel postgres/)
  assert.equal(forcedRelease, true)
})
