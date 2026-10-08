// 浏览器侧 bundle（lib/client.js）：注册、渲染、保存。
//
// ⚠ **必须有深度渲染**：只断言 props 形状等于没测 —— 组件里读一个没传进来的 prop
// 就会让 React 卸载整棵子树，表现是"配置页整节消失"，而且不报错到控制台以外。
// 所以这里递归调用每个函数组件，让它的函数体真的执行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')

const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
  },
}

/** `SettingsFormModel` 的替身 —— 按真实行为实现（含 `bind` 返回的 store 要有 `set`）。 */
function primitivesStub() {
  return {
    SettingsValueField: 'SettingsValueField',
    SettingsFormModel: class {
      constructor(scope) { this.scope = scope; this.listeners = new Set(); this.drafts = new Map() }
      shell() {
        const s = this.scope.getSnapshot()
        if (s.status !== 'ready') throw new Error('shell() called before the scope is ready')
        return { available: true, writable: true, dirty: this.drafts.size > 0, invalid: false, saving: false, failed: false }
      }
      field(name) {
        if (this.drafts.has(name)) return { text: this.drafts.get(name), overridden: true, invalid: false }
        const v = this.scope.getSnapshot().value ?? {}
        return { text: v[name] === undefined ? '' : String(v[name]), overridden: false, invalid: false }
      }
      bind(project) {
        let current = project()
        const ls = new Set()
        return {
          getSnapshot: () => current,
          set: (next) => { current = next; ls.forEach((fn) => fn()) },
          subscribe: (fn) => { ls.add(fn); return () => ls.delete(fn) },
        }
      }
      actions() {
        const self = this
        return {
          edit(field, text) { self.drafts.set(field, text); self.publish() },
          resetField(field) { self.drafts.set(field, ''); self.publish() },
          save() { self.saved = true },
          discard() { self.drafts.clear(); self.publish() },
        }
      }
      publish() { this.listeners.forEach((fn) => fn()) }
      dispose() {}
    },
    settingsTextField: (field) => ({ field }),
    settingsNumberField: (field) => ({ field }),
  }
}

const VALUE = {
  activeEnv: 'qa',
  maxRows: 1000,
  environments: { e1: { name: 'qa' }, e2: { name: 'prod' } },
  connections: {
    polar: { engine: 'sqlite', file: ':memory:', env: 'qa', readOnly: true, description: '本地' },
    gp: { engine: 'postgres', host: '10.0.0.2', port: 5432, user: 'ro', database: 'cg', env: 'prod', readOnly: true },
    my: { engine: 'mysql', host: '10.0.0.1', port: 3306, user: 'ro', database: 'app', env: 'qa', readOnly: false },
  },
}

function harness({ ready = true, writable = true, value = VALUE } = {}) {
  let captured = null
  new Function('window', SRC)({ __ModuleLoader__: { load: (o) => { captured = o } } })
  const mod = captured.factory((name) => (name === 'react' ? reactStub : primitivesStub()))

  const mutations = []
  const scope = {
    getSnapshot: () => (ready
      ? { status: 'ready', writable, revision: 7, value }
      : { status: 'loading', writable: false, revision: undefined, value: undefined }),
    subscribe: (fn) => { fn(); return () => {} },
    mutate: async (ops, rev) => { mutations.push({ ops, rev }); return true },
  }

  let registration = null
  const ctx = {
    locale: { bind: () => (k) => k, register: () => () => {} },
    configForms: { get: () => scope, whileServed: (ids, fn) => fn() },
    slots: { inject: (n, fn) => fn(), register: (o, component) => { registration = { o, component }; return () => {} } },
    effect: (fn) => fn(),
  }
  return { mod, ctx, scope, mutations, get registration() { return registration } }
}

/** 递归展开整棵树 —— 每个函数组件都真的调用一遍。 */
function deep(node, extra, depth = 0, counter = { n: 0 }) {
  if (depth > 60 || node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((c) => deep(c, extra, depth + 1, counter))
  if (typeof node.type === 'function') {
    counter.n++
    return deep(node.type({ ...node.props, ...extra }), extra, depth + 1, counter)
  }
  return { type: node.type, props: node.props, children: deep(node.children, extra, depth + 1, counter) }
}

function collect(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((c) => collect(c, out)); return out }
  if (node.props) out.push({ type: node.type, props: node.props })
  collect(node.children, out)
  return out
}

// ── 加载与注册 ─────────────────────────────────────────────────────────────

test('bundle 能作为 script 加载（不能有 ESM 语法）', () => {
  let captured = null
  assert.doesNotThrow(
    () => new Function('window', SRC)({ __ModuleLoader__: { load: (o) => { captured = o } } }),
    '有 import/export 的话浏览器会直接语法报错，整个配置页消失',
  )
  assert.equal(captured.id, 'dsh-sql')
})

test('bundle 里没有顶层 import/export', () => {
  const bad = SRC.split('\n').filter((l) => /^\s*(import|export)\s/.test(l))
  assert.deepEqual(bad, [], 'tsc 会补 `export {};`，构建后处理脚本负责剥掉它')
})

test('apply 声明了 slots / locale / configForms', () => {
  const h = harness()
  assert.deepEqual(h.mod.inject, ['slots', 'locale', 'configForms'])
})

test('插槽注册：name / key / locale 三者都对', () => {
  const h = harness()
  h.mod.apply(h.ctx)
  assert.equal(h.registration.o.name, 'plugins.bundle.config')
  assert.equal(h.registration.o.key, 'dsh-sql', 'key 必须是 npm 包名，不是 profile 条目 id')
  assert.equal(h.registration.o.locale, 'sql')
})

test('scope 未就绪时 apply 不抛错（否则整个配置表单消失）', () => {
  const h = harness({ ready: false })
  assert.doesNotThrow(() => h.mod.apply(h.ctx))
})

// ── 渲染 ───────────────────────────────────────────────────────────────────

test('深度渲染整棵树不抛错（三种引擎都覆盖）', () => {
  const h = harness()
  h.mod.apply(h.ctx)
  const face = h.registration.o.inject()
  const counter = { n: 0 }
  assert.doesNotThrow(
    () => deep(h.registration.component({ t: (k) => k, ...face }), face, 0, counter),
    '只断言 props 形状等于没测 —— 组件读一个没传的 prop 就会让整棵子树被卸载',
  )
  assert.ok(counter.n >= 4, `至少要真的调用到主卡片与各连接卡片，实际 ${counter.n}`)
})

test('渲染出的值覆盖三种引擎各自的字段', () => {
  const h = harness()
  h.mod.apply(h.ctx)
  const face = h.registration.o.inject()
  const nodes = collect(deep(h.registration.component({ t: (k) => k, ...face }), face))
  const values = nodes.map((n) => n.props.value).filter((v) => v !== undefined)

  assert.ok(values.includes('qa') && values.includes('prod'), '环境名')
  for (const name of ['polar', 'gp', 'my']) assert.ok(values.includes(name), '连接名 ' + name)
  assert.equal(nodes.filter((n) => n.type === 'select').length, 3, '每个连接一个引擎下拉')
  assert.ok(values.includes(':memory:'), 'sqlite 的 file')
  assert.ok(values.includes('10.0.0.2'), 'postgres 的 host')
  assert.ok(values.includes('3306'), 'mysql 的 port')
})

// ── 草稿与保存 ─────────────────────────────────────────────────────────────

test('初始草稿来自宿主值', () => {
  const h = harness()
  h.mod.apply(h.ctx)
  const snap = h.registration.o.inject().hooks.configCard.getSnapshot()
  assert.deepEqual(Object.keys(snap.envDraft), ['e1', 'e2'])
  assert.deepEqual(Object.keys(snap.connDraft), ['polar', 'gp', 'my'])
  assert.equal(snap.dirty, false, '什么都没改')
})

test('保存：改环境名 / 连接字段 / 密码都发成深路径 op', async () => {
  const h = harness()
  h.mod.apply(h.ctx)
  const face = h.registration.o.inject()

  face.editEnv('e2', 'name', 'production')
  face.editConn('gp', 'host', '10.0.0.9')
  face.editConn('gp', 'password', 'SECRET')
  face.save()
  await new Promise((r) => setTimeout(r, 5))

  const ops = h.mutations[0]?.ops ?? []
  assert.deepEqual(
    ops.find((o) => o.path[0] === 'environments'),
    { op: 'set', path: ['environments', 'e2', 'name'], value: 'production' },
  )
  assert.deepEqual(
    ops.find((o) => o.path[1] === 'gp' && o.path[2] === 'host'),
    { op: 'set', path: ['connections', 'gp', 'host'], value: '10.0.0.9' },
  )
  assert.deepEqual(
    ops.find((o) => o.path[1] === 'gp' && o.path[2] === 'password'),
    { op: 'set', path: ['connections', 'gp', 'password'], value: 'SECRET' },
  )
  assert.equal(h.mutations[0].rev, 7, '带 revision 栅栏')
})

test('保存：没动过的连接字段不发 op（尤其是 password）', async () => {
  const h = harness()
  h.mod.apply(h.ctx)
  const face = h.registration.o.inject()
  face.editConn('gp', 'host', '10.0.0.9')
  face.save()
  await new Promise((r) => setTimeout(r, 5))

  const paths = (h.mutations[0]?.ops ?? []).map((o) => JSON.stringify(o.path))
  assert.equal(paths.some((p) => p.includes('password')), false, '没动密码就不能写它 —— 整组写回会把它抹掉')
})

test('保存：改名连接 = 原子地删旧键 + 加新键', async () => {
  const h = harness()
  h.mod.apply(h.ctx)
  const face = h.registration.o.inject()
  face.renameConn('polar', 'local')
  face.save()
  await new Promise((r) => setTimeout(r, 5))

  const ops = h.mutations[0]?.ops ?? []
  assert.deepEqual(ops.find((o) => o.op === 'unset'), { op: 'unset', path: ['connections', 'polar'] })
  const added = ops.find((o) => o.op === 'set' && o.path.length === 2)
  assert.equal(added.path[1], 'local', '新键用了新名字')
  assert.equal(added.value.engine, 'sqlite', '定义原样带过去')
})

test('保存：什么都没改就不写入', async () => {
  const h = harness()
  h.mod.apply(h.ctx)
  h.registration.o.inject().save()
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(h.mutations.length, 0)
})

test('新增/删除条目', () => {
  const h = harness()
  h.mod.apply(h.ctx)
  const face = h.registration.o.inject()

  // 新增：多出一个条目，且**不会**跟已有的撞名字 / 撞键
  face.addEnv()
  const withNewEnv = face.hooks.configCard.getSnapshot().envDraft
  assert.equal(Object.keys(withNewEnv).length, 3)
  const names = Object.values(withNewEnv).map((e) => e.name)
  assert.equal(new Set(names).size, names.length, '新环境的名字不能跟已有的重名')

  face.addConn()
  const withNewConn = face.hooks.configCard.getSnapshot().connDraft
  assert.equal(Object.keys(withNewConn).length, 4, '新连接的键不能跟已有的撞')
  assert.equal(withNewConn.main?.engine, 'sqlite', '新连接默认 sqlite')

  // 删除：只删指定的那个
  face.removeEnv('e1')
  face.removeConn('gp')
  const snap = face.hooks.configCard.getSnapshot()
  assert.equal(snap.envDraft.e1, undefined, 'e1 被删掉')
  assert.equal(snap.envDraft.e2?.name, 'prod', 'e2 原样保留')
  assert.equal(snap.connDraft.gp, undefined, 'gp 被删掉')
  assert.deepEqual(Object.keys(snap.connDraft).sort(), ['main', 'my', 'polar'])
})
