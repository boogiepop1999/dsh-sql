import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, Config } from '../lib/index.js'

/**
 * 造一份能被插件读的配置对象。
 *
 * 宿主把条目的 config 交给 `apply(ctx, config)`，而 `.volatile()` 的字段上报一个
 * `get()` —— 插件**每次调用时现取**，所以测试里也可以只给普通对象（`readConfigValue`
 * 两种都认）。
 */
function makeConfig(overrides = {}) {
  return {
    activeEnv: '',
    maxRows: 1000,
    environments: {},
    connections: {},
    ...overrides,
  }
}

function makeFakeCtx() {
  const registered = []
  const listeners = {}
  const ctx = {
    tools: {
      register(definition, ...extra) {
        registered.push({ definition, extra })
        return () => {
          const index = registered.findIndex((item) => item.definition === definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    on(event, listener) {
      (listeners[event] ??= []).push(listener)
      return () => {}
    },
    /**
     * `ctx.inject(deps, cb)` —— 真实 Cordis 在服务可用时**调用回调**，并给它一个子级 ctx。
     *
     * 这里默认**不调**（模拟 settings 服务不存在：headless 组合、或服务未挂载）——
     * 顶层那批工具必须在这种情况照常注册。要测 `sql_env_use` 时把
     * `ctx.__withSettings` 设成 true，走服务可用的那条路。
     */
    inject(deps, callback) {
      if (ctx.__withSettings) {
        callback({ ...ctx, settings: { configure() {}, async update() {} }, fiber: {}, effect: (fn) => fn() })
      }
      return {}
    },
  }
  return { ctx, registered, listeners }
}

test('inject 声明 tools（settings 不是硬依赖，走 ctx.inject 子级）', () => {
  assert.deepEqual(inject, ['tools'])
})

test('导出名为 Config 的 schema —— 少了它配置页根本不会出现', () => {
  // `dsh-settings` 读的是 `entry.fiber.runtime.Config`（见它的 `schema(entry)`）。
  // 光 `export * from './config-schema.js'` 导出的名字是 `ConfigSchema`，宿主不认 ——
  // 表现是**插件加载异常 / 配置节不出现**，而且没有任何报错指向这里。
  assert.ok(Config, '必须导出 Config')
  assert.equal(typeof Config.toJSON, 'function', 'dsh-settings 会调 toJSON()，必须是 schemastery schema')

  const wire = JSON.stringify(Config.toJSON())
  assert.ok(wire.includes('volatile'), '没有 volatile 的字段不会进表单')
  assert.ok(wire.includes('secret'), 'password 必须是 secret，否则会下发到浏览器')
})

test('apply 注册 6 个工具（5 个数据库操作 + sql_settings）', () => {
  const { ctx, registered } = makeFakeCtx()
  apply(ctx, makeConfig())
  assert.equal(registered.length, 6, 'settings 不可用时没有 sql_env_use')
  assert.ok(registered.every((item) => item.extra.length === 0))
  assert.ok(registered.every((item) => !Object.hasOwn(item.definition, 'gate')))
  const names = registered.map((item) => item.definition.name).sort()
  assert.deepEqual(names, ['sql_exec', 'sql_health', 'sql_query', 'sql_schema', 'sql_settings', 'sql_stats'])
})

test('settings 可用时多注册 sql_env_use（唯一会写配置的工具）', () => {
  const { ctx, registered } = makeFakeCtx()
  ctx.__withSettings = true
  apply(ctx, makeConfig())
  const names = registered.map((item) => item.definition.name).sort()
  assert.deepEqual(
    names,
    ['sql_env_use', 'sql_exec', 'sql_health', 'sql_query', 'sql_schema', 'sql_settings', 'sql_stats'],
  )
})

test('apply 收 ctx + config 两个参数（配置由宿主注入，不再读文件）', () => {
  assert.equal(apply.length, 2, 'apply(ctx, config) —— 配置走宿主，插件自己不碰文件')
})

test('不再注册 tools/pre-execute 审批钩子（插件不自带写审批）', () => {
  const { ctx, listeners } = makeFakeCtx()
  apply(ctx, makeConfig())
  assert.equal(listeners['tools/pre-execute'], undefined)
})

test('dispose 卸载全部工具', () => {
  const { ctx, registered, listeners } = makeFakeCtx()
  apply(ctx, makeConfig())
  assert.equal(registered.length, 6)
  for (const listener of listeners.dispose ?? []) listener()
  assert.equal(registered.length, 0)
})

test('配置是 .volatile() 的话走 get() 取当前值（改完立即生效）', () => {
  const { ctx, registered } = makeFakeCtx()
  let current = makeConfig({ activeEnv: 'qa' })
  // 模拟宿主的响应式 config：get() 每次返回当前值
  apply(ctx, { get: () => current })

  const settingsTool = registered.find((i) => i.definition.name === 'sql_settings').definition
  return settingsTool.execute({}).then((first) => {
    assert.match(first.report, /当前环境 qa/)
    // 宿主改配置（设置页保存 → Loader 重载）
    current = makeConfig({ activeEnv: 'prod' })
    return settingsTool.execute({}).then((second) => {
      assert.match(second.report, /当前环境 prod/, '每次调用现取 —— 不能把 config 存起来')
    })
  })
})
