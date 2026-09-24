import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertIdentifier,
  passwordEnvName,
  isReadOnly,
  invalidReadOnly,
  requireMaxRows,
  splitConnectionsByEnv,
  normalizeSettings,
  queryTimeoutError,
  execTimeoutError,
  isAbortError,
  QUERY_TIMEOUT_MS,
  EXEC_TIMEOUT_MS,
  STATS_TIMEOUT_MS,
} from '../lib/index.js'

// 这一份测的是**纯函数**：设置怎么读进来（normalizeSettings）、
// 以及运行时怎么取值（isReadOnly / requireMaxRows / splitConnectionsByEnv）。
// 以前这里有一整套 resolveSettings 的用例；那一层已删除，行为搬到了使用处。
// 「使用处」的行为由 tools.test.mjs / settings-tools.test.mjs 覆盖。

test('normalizeSettings：只查顶层形状 + 剔未知字段', () => {
  const out = normalizeSettings({
    activeEnv: 'qa',
    environments: ['qa'],
    connections: { a: { engine: 'sqlite', file: ':memory:' } },
    maxRows: 500,
    unknownTop: '丢掉',
  })
  assert.equal(out.activeEnv, 'qa')
  assert.deepEqual(out.environments, ['qa'])
  assert.equal(out.maxRows, 500)
  assert.equal(out.unknownTop, undefined, '未知顶层字段被剔除')
  // 连接内部的字段**一概不动** —— 没有 trim、没有类型过滤、不补默认值
  assert.deepEqual(out.connections.a, { engine: 'sqlite', file: ':memory:' })
})

test('normalizeSettings：connections 缺失兜底成空对象', () => {
  // 下游到处写 settings.connections[name]，undefined 会直接崩
  assert.deepEqual(normalizeSettings({}).connections, {})
  assert.deepEqual(normalizeSettings({ activeEnv: 'qa' }).connections, {})
})

test('normalizeSettings：顶层不是对象 / connections 不是对象都报错', () => {
  assert.throws(() => normalizeSettings(null), /顶层必须是一个对象/)
  assert.throws(() => normalizeSettings([]), /顶层必须是一个对象/)
  assert.throws(() => normalizeSettings('x'), /顶层必须是一个对象/)
  assert.throws(() => normalizeSettings({ connections: [] }), /connections 必须是一个对象/)
  assert.throws(() => normalizeSettings({ environments: 'nope' }), /environments 必须是一个数组/)
})

test('normalizeSettings：不做归一化（无 trim、无默认值、不校验）', () => {
  const long = 'x'.repeat(150)
  const out = normalizeSettings({
    activeEnv: '  qa  ',
    connections: {
      a: { engine: 'oracle' },                          // 非法引擎也原样读出
      b: { engine: 'sqlite', env: '  ', description: long, readOnly: 'true' },
    },
  })
  assert.equal(out.activeEnv, '  qa  ', '不 trim —— 读到的就是文件里的')
  assert.equal(out.connections.a.engine, 'oracle', '不校验引擎')
  assert.equal(out.connections.b.env, '  ', '不 trim')
  assert.equal(out.connections.b.description, long, '不截断')
  assert.equal(out.connections.b.readOnly, 'true', '类型也原样保留')
})

test('normalizeSettings：maxRows 非法不在这里抛（由 requireMaxRows 把关）', () => {
  assert.doesNotThrow(() => normalizeSettings({ maxRows: -1 }))
  assert.doesNotThrow(() => normalizeSettings({ maxRows: 'x' }))
})

test('isReadOnly：只有显式 false 才可写，其余一律只读（fail-safe）', () => {
  assert.equal(isReadOnly({ engine: 'sqlite', readOnly: false }), false, '显式 false 才放行')
  assert.equal(isReadOnly({ engine: 'sqlite', readOnly: true }), true)
  assert.equal(isReadOnly({ engine: 'sqlite' }), true, '缺省就是只读')
  // 认不出来的值全部当只读 —— 写权限是危险的那一侧
  assert.equal(isReadOnly({ engine: 'sqlite', readOnly: 'false' }), true, '"false" 字符串不算')
  assert.equal(isReadOnly({ engine: 'sqlite', readOnly: 'true' }), true)
  assert.equal(isReadOnly({ engine: 'sqlite', readOnly: 0 }), true)
  assert.equal(isReadOnly({ engine: 'sqlite', readOnly: 1 }), true)
  assert.equal(isReadOnly({ engine: 'sqlite', readOnly: null }), true)
  assert.equal(isReadOnly(undefined), true, '连接都没有也算只读')
})

test('invalidReadOnly：只标真正的非法值，缺省不算', () => {
  assert.equal(invalidReadOnly({ engine: 'sqlite' }), undefined, '缺省是有意的默认')
  assert.equal(invalidReadOnly({ engine: 'sqlite', readOnly: true }), undefined)
  assert.equal(invalidReadOnly({ engine: 'sqlite', readOnly: false }), undefined)
  // 非法值：原样返回，供 sql_settings 展示
  assert.equal(invalidReadOnly({ engine: 'sqlite', readOnly: 'true' }), 'true')
  assert.equal(invalidReadOnly({ engine: 'sqlite', readOnly: 'false' }), 'false')
  assert.equal(invalidReadOnly({ engine: 'sqlite', readOnly: 1 }), 1)
  assert.equal(invalidReadOnly({ engine: 'sqlite', readOnly: null }), null)
  assert.equal(invalidReadOnly(undefined), undefined)
})

test('requireMaxRows：缺省 1000；非法直接报错（不静默夹取）', () => {
  assert.equal(requireMaxRows({}), 1000)
  assert.equal(requireMaxRows({ maxRows: 250 }), 250)
  assert.equal(requireMaxRows({ maxRows: 1 }), 1)
  assert.equal(requireMaxRows({ maxRows: 10000 }), 10000)

  // 超范围 / 非整数 / 非数字都报错 —— 夹取会让人以为"设了 50000"实际跑 10000
  assert.throws(() => requireMaxRows({ maxRows: 999999 }), /1~10000 之间的整数/)
  assert.throws(() => requireMaxRows({ maxRows: 0 }), /1~10000 之间的整数/)
  assert.throws(() => requireMaxRows({ maxRows: -1 }), /1~10000 之间的整数/)
  assert.throws(() => requireMaxRows({ maxRows: 1.5 }), /1~10000 之间的整数/)
  assert.throws(() => requireMaxRows({ maxRows: '500' }), /1~10000 之间的整数/)
  assert.throws(() => requireMaxRows({ maxRows: true }), /1~10000 之间的整数/)
  // 报错要指明怎么改
  assert.throws(() => requireMaxRows({ maxRows: 999999 }), /sql_config_set/)
})

test('超时是代码常量，不进设置文件也不被解析', () => {
  assert.equal(QUERY_TIMEOUT_MS, 30000)
  assert.equal(EXEC_TIMEOUT_MS, 30000)
  assert.equal(STATS_TIMEOUT_MS, 120000)
  const out = normalizeSettings({ queryTimeoutMs: 7000, execTimeoutMs: 9999999 })
  assert.equal(out.queryTimeoutMs, undefined, '设置文件里的超时字段被剔除')
  assert.equal(out.execTimeoutMs, undefined)
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

test('isAbortError 只认中止信号，不拿 message 做子串匹配', () => {
  const abort = new Error('The operation was aborted.')
  abort.name = 'AbortError'
  assert.equal(isAbortError(abort), true)
  assert.equal(isAbortError(Object.assign(new Error('x'), { code: 'ABORT_ERR' })), true)
  assert.equal(isAbortError(new Error('connect ECONNREFUSED')), false)
  assert.equal(isAbortError('not an error'), false)
  // 回归：message 里带 abort 的普通数据库错误不能被误判成超时，
  // 否则会被套上「禁止重试，请与用户确认」，把 agent 的自愈路径掐死。
  assert.equal(isAbortError(new Error('no such table: abort_log')), false)
  assert.equal(isAbortError(new Error('abort_table_permission denied')), false)
  assert.equal(isAbortError(new Error('relation "abort_log" does not exist')), false)
})

test('assertIdentifier 防注入', () => {
  assert.equal(assertIdentifier('users', '表名'), 'users')
  assert.throws(() => assertIdentifier('users; DROP TABLE x', '表名'), /非法/)
  assert.throws(() => assertIdentifier('a b', '表名'), /非法/)
})

test('passwordEnvName：连接名 → 环境变量名', () => {
  assert.equal(passwordEnvName('my-db'), 'DSH_SQL_PASSWORD_MY_DB')
  assert.equal(passwordEnvName('polar'), 'DSH_SQL_PASSWORD_POLAR')
})

// ── splitConnectionsByEnv ────────────────────────────────────────────────
// 现在直接收设置本体（不再有"解析后"的中间形状）

test('splitConnectionsByEnv：当前环境的 + 未标环境的可用，其它环境排除', () => {
  const { available, excluded } = splitConnectionsByEnv({
    activeEnv: 'qa',
    environments: ['qa', 'pro'],
    connections: {
      'qa-db': { engine: 'sqlite', env: 'qa' },
      'pro-db': { engine: 'sqlite', env: 'pro' },
      common: { engine: 'sqlite' },
      'blank-env': { engine: 'sqlite', env: '   ' },
    },
  })
  assert.deepEqual(Object.keys(available), ['qa-db', 'common', 'blank-env'])
  assert.deepEqual(Object.keys(excluded), ['pro-db'])
})

test('splitConnectionsByEnv：activeEnv 为空时只有不限环境的可用', () => {
  const { available, excluded } = splitConnectionsByEnv({
    environments: ['qa', 'pro'],
    connections: {
      'qa-db': { engine: 'sqlite', env: 'qa' },
      'pro-db': { engine: 'sqlite', env: 'pro' },
      common: { engine: 'sqlite' },
    },
  })
  assert.deepEqual(Object.keys(available), ['common'], '没设环境 → 只有不限环境的')
  assert.deepEqual(Object.keys(excluded), ['qa-db', 'pro-db'], '带环境的一律算其它环境')
})

test('splitConnectionsByEnv：环境名区分大小写；activeEnv 会 trim', () => {
  const upper = splitConnectionsByEnv({
    activeEnv: 'QA',
    connections: { 'qa-db': { engine: 'sqlite', env: 'qa' } },
  })
  assert.deepEqual(Object.keys(upper.available), [], 'QA ≠ qa')
  assert.deepEqual(Object.keys(upper.excluded), ['qa-db'])

  const padded = splitConnectionsByEnv({
    activeEnv: '  qa  ',
    connections: { 'qa-db': { engine: 'sqlite', env: 'qa' } },
  })
  assert.deepEqual(Object.keys(padded.available), ['qa-db'], 'activeEnv 两侧空白应被忽略')
})

test('splitConnectionsByEnv：connections 缺失时返回两个空表，不崩', () => {
  const { available, excluded } = splitConnectionsByEnv({ activeEnv: 'qa' })
  assert.deepEqual(available, {})
  assert.deepEqual(excluded, {})
})
