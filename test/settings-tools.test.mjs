// 配置报告工具：sql_settings。
//
// 配置**编辑**已经搬到插件设置页（见 config-schema.ts），所以这里只剩只读报告 ——
// 它的「⚠ 问题」节是发现配置错误的主要渠道：设置页只保证形状（schema），
// "activeEnv 得命中某个环境的名字"这类跨字段规则只能在运行时判。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSettingsTools } from '../lib/index.js'

/**
 * 造一个"配置沙盒"。
 *
 * 配置现在是**宿主注入的对象**（`apply(ctx, config)`），不再走文件 —— 所以测试里
 * 也只是一份普通对象：`write()` 改它、`tool()` 拿到工具、`read()` 读回来。
 * 不碰文件系统，也就没有临时目录、环境变量、清理那一套。
 */
function makeSandbox(initial = {}) {
  let config = { activeEnv: '', maxRows: 1000, environments: {}, connections: {}, ...initial }
  const tools = buildSettingsTools(() => config)
  return {
    tool: (name) => tools.find((t) => t.name === name),
    /** 换一份配置（模拟宿主文档变了 —— 报告每次现取，所以下一步就生效）。 */
    write: (value) => { config = value },
    /** 读回当前配置（断言用）。 */
    read: () => config,
  }
}

/**
 * 造一份环境字典（新形状：「随机 id → { name }」）。
 *
 * 测试里按名字给（`envs('qa','uat')`）比手写随机 id 清楚；id 用一个可预测的短串，
 * 方便出问题时对着看。
 */
function envs(...names) {
  return Object.fromEntries(names.map((name, i) => ['e' + (i + 1), { name }]))
}

/**
 * 造一个连接定义。字段给全（跟出厂样子一致），要改哪项就覆盖哪项。
 *
 * 连接在报告里只被**读**（表格那几列），所以这里不需要默认值 —— 报告不校验，
 * 缺字段就是显示成空。要造"值非法"的场景（readOnly 写了字符串）显式覆盖即可。
 */
function conn(overrides = {}) {
  return {
    engine: 'sqlite',
    file: ':memory:',
    env: '',
    description: '',
    readOnly: false,
    ...overrides,
  }
}

test('只注册 sql_settings 一个工具（配置编辑已搬到设置页）', () => {
  const names = buildSettingsTools().map((t) => t.name).sort()
  assert.deepEqual(names, ['sql_settings'])
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
  const value = await box.tool('sql_settings').execute({})
  assert.match(value.report, /# dsh-sql — 当前环境（空），0 个可见连接/)
  assert.match(value.report, /environments 为空/)
  assert.match(value.report, /activeEnv 未设置/)
  assert.match(value.report, /还没有任何连接/)
  const blocks = box.tool('sql_settings').output.render({}, value)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /## 全局设置/)
  assert.deepEqual(box.read().connections, {}, '出厂不带任何连接')
})

test('sql_settings：只读与描述出现在报告里', async () => {
  const box = makeSandbox({
    connections: { prod: conn({ file: '/tmp/p.db', readOnly: true, description: '生产库，慎写' }) },
  })
  const value = await box.tool('sql_settings').execute({})
  assert.match(value.report, /🔒 是/)
  assert.match(value.report, /生产库，慎写/)
})

test('sql_settings：报告里指路到插件设置页（不再提配置文件）', async () => {
  // 配置编辑已经搬到设置页，落盘位置（profile 的 cordis.patch.yml）是宿主的内部实现 ——
  // 报告里不该再出现文件路径让人去手改。
  const box = makeSandbox()
  const value = await box.tool('sql_settings').execute({})
  assert.match(value.report, /配置位置 \| 插件设置页/)
  assert.doesNotMatch(value.report, /settings\.json|\.dsh[\\/]sql/)
})

test('sql_settings：值不对（不是格式坏）时照常渲染，只在问题节里指路', async () => {
  // 新装时配置全空是**正常的中间状态**，不该变成一片报错。
  const box = makeSandbox()
  const value = await box.tool('sql_settings').execute({})
  assert.match(value.report, /^# dsh-sql/, '仍然给出报告')
  assert.match(value.report, /## ⚠ 问题/, '问题集中放在末尾')
  assert.match(value.report, /activeEnv 未设置.*插件设置页/)
  // 环境单列一节；当前环境与环境清单**不再**在「全局设置」里重复（跟 api-call 一致）
  assert.match(value.report, /## 环境\n（空）/, '环境为空时这一节直接写（空）')
  assert.doesNotMatch(value.report, /\| 当前环境 \|/)
  assert.doesNotMatch(value.report, /\| 环境清单 \|/)
})

test('sql_settings：连接表的环境列，空 env 显示「不限环境」（不是空格子）', async () => {
  // env 为空串/只有空白都算"不限环境"（切分逻辑就是这么判的），表格必须跟它一致。
  // 从前这里用 `??` 兜底，只认 undefined/null，空串会渲染成一个空格子 —— 看着像漏填。
  const box = makeSandbox()
  box.write({
    environments: envs('qa'),
    activeEnv: 'qa',
    connections: {
      'no-env': conn(),
      'blank-env': conn({ env: '   ' }),
      'in-qa': conn({ env: 'qa' }),
    },
  })

  const value = await box.tool('sql_settings').execute({})
  assert.match(value.report, /\| no-env \| sqlite \| 不限环境 \|/, '没写 env')
  assert.match(value.report, /\| blank-env \| sqlite \| 不限环境 \|/, '只有空白也算不限环境')
  assert.match(value.report, /\| in-qa \| sqlite \| qa \|/, '有 env 就直接写环境名')
  assert.doesNotMatch(value.report, /\|  {2,}\|/, '不该再有空格子')
})

// ── activeEnv / environments ───────────────────────────────────────────────

test('sql_settings：按 activeEnv 筛选，留空的连接哪个环境都列', async () => {
  const box = makeSandbox()
  box.write({
    environments: envs('qa', 'prod'),
    activeEnv: 'qa',
    connections: {
      'qa-only': conn({ env: 'qa' }),
      'prod-only': conn({ env: 'prod' }),
      anywhere: conn(),
    },
  })

  const value = await box.tool('sql_settings').execute({})
  assert.match(value.report, /当前环境 qa/)
  // 当前环境可用：qa-only + anywhere（留空）；prod-only 不在表里
  assert.match(value.report, /qa-only/)
  assert.match(value.report, /anywhere/)
  assert.match(value.report, /其它环境的连接：prod-only/)
  // prod-only 只出现在「其它环境」那行，不进表
  const tableRows = value.report.split('\n').filter((line) => line.startsWith('| ') && line.includes('| sqlite |'))
  assert.equal(tableRows.some((row) => row.includes('prod-only')), false)
})

test('sql_settings：activeEnv 为空时只列不限环境的，带环境的进「其它环境」', async () => {
  const box = makeSandbox()
  box.write({
    environments: envs('qa', 'prod'),
    connections: {
      'qa-only': conn({ env: 'qa' }),
      'prod-only': conn({ env: 'prod' }),
      scratch: conn(),
    },
  })

  const value = await box.tool('sql_settings').execute({})
  assert.match(value.report, /当前环境（空），1 个可见连接/)
  assert.match(value.report, /## 可见连接（不限环境）/)
  assert.match(value.report, /scratch/)
  assert.match(value.report, /其它环境的连接：qa-only、prod-only/)
  assert.doesNotMatch(value.report, /\| qa-only \|/, '带环境的连接不进可用表')
  assert.doesNotMatch(value.report, /\| prod-only \|/, '带环境的连接不进可用表')
})

test('sql_settings：activeEnv 设了环境时，当前环境的 + default 的同列可用', async () => {
  const box = makeSandbox()
  box.write({
    environments: envs('qa', 'prod'),
    activeEnv: 'qa',
    connections: {
      'qa-only': conn({ env: 'qa' }),
      'prod-only': conn({ env: 'prod' }),
      scratch: conn(),
    },
  })

  const value = await box.tool('sql_settings').execute({})
  assert.match(value.report, /当前环境 qa，2 个可见连接/)
  assert.match(value.report, /## 可见连接（当前环境 qa）/)
  assert.match(value.report, /\| qa-only \|/)
  assert.match(value.report, /\| scratch \|/, '不限环境的连接在任何环境都可用')
  assert.match(value.report, /其它环境的连接：prod-only/)
})

test('sql_settings：环境清单被改小后，落到范围外的 activeEnv / 连接 env 都在问题节报出来', async () => {
  // 设置页只保证形状（schema），"activeEnv 得命中某个环境的名字"这类跨字段规则
  // 只能在运行时判 —— 所以读取侧的「⚠ 问题」节是**主要**的发现渠道。
  // 不说的话，表现只是"当前环境名不对 / 某个连接凭空消失"，没人想得到是环境清单变了。
  const box = makeSandbox()
  box.write({
    environments: envs('qa', 'prod'),
    activeEnv: 'prod',
    connections: { 'prod-db': conn({ env: 'prod' }) },
  })

  // 模拟"在设置页删了环境但没改引用"：换一份少一个环境的配置
  box.write({ ...box.read(), environments: envs('qa') })

  const value = await box.tool('sql_settings').execute({})
  assert.match(value.report, /activeEnv "prod" 不在环境清单里/, '当前环境指向了不存在的环境')
  assert.match(value.report, /连接 "prod-db" 的 env "prod" 不在环境清单里/, '连接的 env 也指向了不存在的环境')
  assert.match(value.report, /它在任何环境下都不会出现/, '要说清后果，否则看不出严重性')
  // 两条都要带指路（该去哪儿改）—— 配置编辑已经全在设置页
  assert.match(value.report, /插件设置页/)
})

test('sql_settings：环境未配置时给出软提示，且不引导手动编辑', async () => {
  const box = makeSandbox()
  const value = await box.tool('sql_settings').execute({})
  assert.match(value.report, /## ⚠ 问题/)
  assert.match(value.report, /environments 为空，请先在插件设置页添加环境。/)
  // 提示带上可选值（现在清单为空，所以是（空））—— 跟 api-call 一致
  assert.match(value.report, /activeEnv 未设置，请先在插件设置页指定当前环境（可选: （空））。/)
  assert.doesNotMatch(value.report, /手动|编辑文件|settings\.json 里填/)
})

