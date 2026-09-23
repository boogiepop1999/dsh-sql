import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveSettings,
  assertIdentifier,
  passwordEnvName,
  splitConnectionsByEnv,
  queryTimeoutError,
  execTimeoutError,
  isAbortError,
  QUERY_TIMEOUT_MS,
  EXEC_TIMEOUT_MS,
  STATS_TIMEOUT_MS,
} from '../lib/index.js'

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

test('超时是代码常量，不进设置文件也不被解析', () => {
  assert.equal(QUERY_TIMEOUT_MS, 30000)
  assert.equal(EXEC_TIMEOUT_MS, 30000)
  assert.equal(STATS_TIMEOUT_MS, 120000)
  const cfg = resolveSettings({ queryTimeoutMs: 7000, execTimeoutMs: 9999999 })
  assert.equal(cfg.queryTimeoutMs, undefined, '设置文件里的超时字段被忽略')
  assert.equal(cfg.execTimeoutMs, undefined)
})

test('maxRows 钳制到 10000', () => {
  assert.equal(resolveSettings({ maxRows: 999999 }).maxRows, 10000)
})

test('超时提示：查询可有限重试，写操作一律禁止重试', () => {
  const q = queryTimeoutError(30, 'SELECT * FROM big').message
  assert.match(q, /30 秒/)
  assert.match(q, /超时只说明本端不再等待/, '两边都要点明超时的本质')
  assert.match(q, /本工具限制执行大语句查询/, '让 AI 知道是护栏，不是环境不稳')
  assert.match(q, /可以适量更换条件重试/)
  assert.match(q, /若多次仍超时/, '给出兜底：多次不行就找人')
  assert.match(q, /请与用户确认/)
  assert.match(q, /SELECT \* FROM big/, '带上原语句，便于定位')

  const e = execTimeoutError(30, 'UPDATE t SET x=1').message
  assert.match(e, /30 秒/)
  assert.match(e, /超时只说明本端不再等待/)
  assert.match(e, /写操作可能已在库上执行/, '重试有风险的根据')
  assert.match(e, /执行超时禁止重试/)
  assert.match(e, /需要与用户确认/)
  assert.match(e, /UPDATE t SET x=1/)
  // 写侧绝不能出现任何鼓励重试的措辞
  for (const bad of ['可以适量', '可以重试', '重试是安全的', '换个方式']) {
    assert.ok(!e.includes(bad), '写提示不该鼓励重试：' + bad)
  }
  // 只指出问题，不列具体手段 —— 免得把 AI 的思路钉死
  for (const advice of ['EXPLAIN', 'LIMIT', 'sql_schema', 'COUNT', '索引', '·']) {
    assert.ok(!q.includes(advice), '查询提示不该给具体手段：' + advice)
    assert.ok(!e.includes(advice), '写提示不该给具体手段：' + advice)
  }
})

test('isAbortError 只认中止类错误', () => {
  const abort = new Error('The operation was aborted.')
  abort.name = 'AbortError'
  assert.equal(isAbortError(abort), true)
  assert.equal(isAbortError(new Error('connect ECONNREFUSED')), false)
  assert.equal(isAbortError('not an error'), false)
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
