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

/**
 * `SettingsFormModel` 的替身 —— **按真实实现的行为还原**。
 *
 * 对照的是 app.asar 里 `dsh-client-ui-primitives/lib/index.js` 的
 * `SettingsFormModel`（约 7151-7360 行）。三件必须还原的事：
 *
 *   ① `edit()` **只 stage，绝不写盘**；`save()` 才是唯一的 `scope.mutate` 入口。
 *   ② `shell().dirty` 看的是 `plan().length > 0`，不是"有没有草稿"——
 *      文本改回原值后 plan 就空了，dirty 必须跟着变回 false。
 *   ③ `save()` 用**暂存时快照的 revision** 做栅栏（真实实现是 `this.baseline?.revision`）。
 *
 * ⚠ 早先的 stub 把 `save()` 写成"只设个标记、根本不 mutate"，于是
 *   "没点保存就不写盘"那条测试**在怎么错的代码上都是绿的** —— 它测不出任何东西。
 *   替身不忠实，回归测试就是安慰剂。
 */
function primitivesStub() {
  return {
    SettingsValueField: 'SettingsValueField',
    // 官方外壳：负责画「保存 / 丢弃」按钮并按 dirty 变色。
    // 这里只留一个可辨识的标记 —— 渲染测试会断言它**在树里**（自绘外壳的回归防线）。
    SettingsForm: 'SettingsForm',
    // 只读开关用的官方组件。真实签名是 `{ checked, onChange, label, disabled }`，
    // `onChange` 直接给**新值**（布尔），不是 event —— 测试里按这个形状断言。
    Switch: 'Switch',
    SettingsFormModel: class {
      constructor(scope) {
        this.scope = scope
        this.listeners = new Set()
        this.staged = new Map()
        this.baseline = undefined
        this.saving = false
        this.failed = false
      }
      field(name) {
        const staged = this.staged.get(name)
        if (staged !== undefined) return { text: staged.text, overridden: true, invalid: false }
        const v = this.scope.getSnapshot().value ?? {}
        return { text: v[name] === undefined ? '' : String(v[name]), overridden: false, invalid: false }
      }
      /** 真实实现：把暂存编成 ops，只对**真的变了**的字段产出 op。 */
      plan() {
        const plan = []
        for (const [field, staged] of this.staged) {
          const v = this.scope.getSnapshot().value ?? {}
          const cur = v[field] === undefined ? '' : String(v[field])
          if (staged.text === cur) continue // 改回原值 → 不产出 → dirty 也跟着变 false
          plan.push({ field, op: { op: 'set', path: [field], value: staged.text } })
        }
        return plan
      }
      shell() {
        const snapshot = this.scope.getSnapshot()
        const plan = this.plan()
        return {
          available: snapshot.status === 'ready',
          writable: snapshot.writable,
          dirty: plan.length > 0,
          invalid: false,
          saving: this.saving,
          failed: this.failed,
        }
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
          // ⚠ 只暂存，**不调 scope.mutate** —— 这是真实行为，也是本文件最重要的还原点
          edit(field, text) { self.stage(field, { text }); self.publish() },
          resetField(field) { self.stage(field, { text: '' }); self.publish() },
          save() { return self.save() },
          discard() { self.staged.clear(); self.baseline = undefined; self.failed = false; self.publish() },
        }
      }
      stage(field, edit) {
        this.baseline ??= this.scope.getSnapshot()
        this.staged.set(field, edit)
        this.failed = false
        this.publish()
      }
      /** 真实实现：save() 里才 mutate，且用暂存时快照的 revision 当栅栏。 */
      async save() {
        const plan = this.plan()
        if (!plan.length || this.saving || !this.scope.getSnapshot().writable) return
        this.saving = true
        this.failed = false
        this.publish()
        try {
          const ops = plan.map((item) => item.op)
          const landed = !ops.length || await this.scope.mutate(ops, this.baseline?.revision)
          if (landed) {
            this.staged.clear()
            this.baseline = undefined
          }
          this.failed = !landed
        } catch (_e) {
          this.failed = true
        } finally {
          this.saving = false
          this.publish()
        }
      }
      publish() { this.listeners.forEach((fn) => fn()) }
      dispose() { this.listeners.clear() }
    },
    settingsTextField: (field) => ({ field }),
    settingsNumberField: (field) => ({ field }),
  }
}

const VALUE = {
  activeEnv: 'qa',
  maxRows: 1000,
  environments: { e1: { name: 'qa' }, e2: { name: 'prod' } },
  // 键是**随机 id**，名字在条目的 `name` 上（跟环境同构）。改名只改 name 字段。
  connections: {
    c1: { name: 'polar', engine: 'sqlite', file: ':memory:', env: 'qa', readOnly: true, description: '本地' },
    c2: { name: 'gp', engine: 'postgres', host: '10.0.0.2', port: 5432, user: 'ro', database: 'cg', env: 'prod', readOnly: true },
    c3: { name: 'my', engine: 'mysql', host: '10.0.0.1', port: 3306, user: 'ro', database: 'app', env: 'qa', readOnly: false },
  },
}

/**
 * @param opts.ready      scope 是否就绪
 * @param opts.writable   配置是否可写
 * @param opts.value      宿主值
 * @param opts.subscribeEager  真实的 `scope.subscribe(fn)` 会**同步立即回调一次**。
 *   默认 true（照真实行为）。置 false 可模拟"订阅后宿主**不再推送**"——
 *   用来看代码是否**只靠自己**就把草稿建起来了，而不是搭订阅那次回调的便车。
 */
function harness({ ready = true, writable = true, value = VALUE, subscribeEager = true } = {}) {
  let captured = null
  new Function('window', SRC)({ __ModuleLoader__: { load: (o) => { captured = o } } })
  const mod = captured.factory((name) => (name === 'react' ? reactStub : primitivesStub()))

  const mutations = []
  const scope = {
    getSnapshot: () => (ready
      ? { status: 'ready', writable, revision: 7, value }
      : { status: 'loading', writable: false, revision: undefined, value: undefined }),
    subscribe: (fn) => {
      if (subscribeEager) fn()
      return () => {}
    },
    /**
     * 真实的 `mutate(ops, revision)` **带 revision 栅栏**：传了旧 revision 会被拒
     * （返回 false），宿主就是这么防"读-改-写"撞车的。替身必须同样对待 ——
     * 否则"两条路径各用各自基线"这类冲突在测试里永远不会暴露。
     */
    mutate: async (ops, rev) => {
      if (rev !== undefined && rev !== 7) {
        mutations.push({ ops, rev, rejected: true })
        return false
      }
      mutations.push({ ops, rev })
      return true
    },
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

/**
 * 按**框架的方式**拼出卡片要的 props。
 *
 * ⚠ `useConfigCard` 是**插槽框架**通过 `props` 给的，**不是**插件 `inject()` 给的
 *   （对比 dsh-api-call：它的 `inject()` 里没有这一项，而卡片照样在用）。
 *   所以测试必须自己模拟框架把它放进 props —— 直接从 `face` 里摊是拿不到的。
 *
 * `t` 用恒等函数：这样断言里看到的就是 i18n 的 **key**，改文案不会碰测试。
 */
function cardProps(face) {
  return {
    t: (k) => k,
    useConfigCard: (sel) => sel(face.hooks.configCard.getSnapshot()),
    ...face,
  }
}

test('深度渲染整棵树不抛错（三种引擎都覆盖）', () => {
  const h = harness()
  h.mod.apply(h.ctx)
  const face = h.registration.o.inject()
  const counter = { n: 0 }
  assert.doesNotThrow(
    () => deep(h.registration.component(cardProps(face)), face, 0, counter),
    '只断言 props 形状等于没测 —— 组件读一个没传的 prop 就会让整棵子树被卸载',
  )
  assert.ok(counter.n >= 4, `至少要真的调用到主卡片与各连接卡片，实际 ${counter.n}`)
})

test('渲染出的值覆盖三种引擎各自的字段', () => {
  const h = harness()
  h.mod.apply(h.ctx)
  const face = h.registration.o.inject()
  const nodes = collect(deep(h.registration.component(cardProps(face)), face))
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
  assert.deepEqual(Object.keys(snap.connDraft), ['c1', 'c2', 'c3'], '草稿的键是随机 id，不是连接名')
  assert.equal(snap.dirty, false, '什么都没改')
})

/**
 * 初始化顺序：`syncDrafts()` 必须在 `form.bind(project)` **之前**。
 *
 * `bind` 会**立即调一次** `project()`，而 `project()` 里是 `envDraft ?? {}` ——
 * 草稿还没建的话它就把**空字典**投了出去；而 `syncDrafts()` 只赋值、不刷新 store，
 * 那个空投影会一直挂着。表现就是"环境和连接明明配好了，设置页却显示空"。
 *
 * ⚠ 这条测试必须用 `subscribeEager: false`：真实宿主订阅后会同步回调一次，
 *   而那次回调会调 `syncDrafts()` —— 它会**替顺序错误兜底**，于是顺序写反了也测不出来。
 *   关掉那次回调，才能验出"代码是不是只靠自己就把草稿建对了"。
 */
test('回归：syncDrafts 在 bind 之前 —— 首次投影就该带上草稿', () => {
  const h = harness({ subscribeEager: false })
  h.mod.apply(h.ctx)

  // 不看 `face.xxx()`，直接读 `bind` 的**首次投影**（store 的初始快照）
  const snap = h.registration.o.inject().hooks.configCard.getSnapshot()
  assert.deepEqual(Object.keys(snap.connDraft), ['c1', 'c2', 'c3'],
    'bind 的首次投影就该有连接草稿 —— 没有说明 syncDrafts 跑到 bind 后面去了')
  assert.deepEqual(Object.keys(snap.envDraft), ['e1', 'e2'],
    'bind 的首次投影就该有环境草稿')
})

// ── 回归：编辑不得自动落盘、外壳必须是官方的 ───────────────────────────────

test('回归：只编辑不点保存 → 绝不写盘', async () => {
  const h = harness()
  h.mod.apply(h.ctx)
  const face = h.registration.o.inject()

  // 字典草稿：改字段、加条目、删条目、输密码 —— 一个都不能自己落盘
  face.editEnv('e2', 'name', 'production')
  face.editConn('c1', 'host', '10.0.0.9')
  face.editConn('c1', 'password', 'SECRET')
  face.addConn()
  face.removeConn('c2')
  face.addEnv()
  // 标量字段（走官方 SettingsFormModel 的暂存）
  face.edit('activeEnv', 'prod')

  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(h.mutations, [], '没点保存就写盘 = 用户改动被静默提交，这是数据安全问题')
})

test('回归：编辑后 dirty 变 true（保存按钮才会变色）', () => {
  const h = harness()
  h.mod.apply(h.ctx)
  const face = h.registration.o.inject()
  const card = face.hooks.configCard

  assert.equal(card.getSnapshot().dirty, false, '初始不脏')

  // 只改字典（不碰标量）也必须算脏 —— 早先这里漏了，按钮不会变色
  face.editConn('c1', 'host', '10.0.0.9')
  assert.equal(card.getSnapshot().dirty, true, '改连接字段后必须算脏')

  // 草稿回到宿主值就该不脏
  face.editConn('c1', 'host', VALUE.connections.c1.host)
  assert.equal(card.getSnapshot().dirty, false, '改回原值后不算脏')
})

test('回归：外壳用官方 SettingsForm（自带保存/丢弃按钮与 dirty 变色）', () => {
  const h = harness()
  h.mod.apply(h.ctx)
  const face = h.registration.o.inject()
  const nodes = collect(deep(h.registration.component(cardProps(face)), face))

  const shell = nodes.find((n) => n.type === 'SettingsForm')
  assert.ok(shell, '必须用官方 SettingsForm 当外壳 —— 自绘的裸 button 没有 dirty 语义')
  assert.equal(typeof shell.props.onSave, 'function', 'onSave 要交给官方组件')
  assert.equal(typeof shell.props.onDiscard, 'function', 'onDiscard 要交给官方组件')
  assert.ok(shell.props.state, 'state 要传进去，官方据此决定按钮变色')
  assert.ok(shell.props.labels, 'labels 要传进去')

  // 自绘的保存按钮必须已经删掉，否则又会出现"变了色也点不动/点得动却不变色"
  const buttons = nodes.filter((n) => n.type === 'button')
  assert.equal(
    buttons.some((b) => String(b.children?.[0] ?? b.props?.children ?? '') === 'save'),
    false,
    '不能再自绘保存按钮',
  )
})

test('保存：改环境名 / 连接字段 / 密码都发成深路径 op', async () => {
  const h = harness()
  h.mod.apply(h.ctx)
  const face = h.registration.o.inject()

  face.editEnv('e2', 'name', 'production')
  face.editConn('c2', 'host', '10.0.0.9')
  face.editConn('c2', 'password', 'SECRET')
  face.save()
  await new Promise((r) => setTimeout(r, 5))

  const ops = h.mutations[0]?.ops ?? []
  assert.deepEqual(
    ops.find((o) => o.path[0] === 'environments'),
    { op: 'set', path: ['environments', 'e2', 'name'], value: 'production' },
  )
  assert.deepEqual(
    ops.find((o) => o.path[1] === 'c2' && o.path[2] === 'host'),
    { op: 'set', path: ['connections', 'c2', 'host'], value: '10.0.0.9' },
  )
  assert.deepEqual(
    ops.find((o) => o.path[1] === 'c2' && o.path[2] === 'password'),
    { op: 'set', path: ['connections', 'c2', 'password'], value: 'SECRET' },
  )
  assert.equal(h.mutations[0].rev, 7, '带 revision 栅栏')
})

test('保存：没动过的连接字段不发 op（尤其是 password）', async () => {
  const h = harness()
  h.mod.apply(h.ctx)
  const face = h.registration.o.inject()
  face.editConn('c2', 'host', '10.0.0.9')
  face.save()
  await new Promise((r) => setTimeout(r, 5))

  const paths = (h.mutations[0]?.ops ?? []).map((o) => JSON.stringify(o.path))
  assert.equal(paths.some((p) => p.includes('password')), false, '没动密码就不能写它 —— 整组写回会把它抹掉')
})

test('保存：改名连接只改 name 字段，**不动键**（否则密码会被清空）', async () => {
  // 键是随机 id，名字是条目里的字段 —— 所以改名走深路径 `["connections", id, "name"]`。
  //
  // ⚠ 这条是**防回归**的关键：若改回"键即名字"，改名就只能删旧键 + 加新键，而新键
  //   走"新增整条" —— 浏览器拿不到已存的密码（宿主脱敏），那条 op 里的 password
  //   只能是空串，于是**改一次名就把密码清空**。
  const h = harness()
  h.mod.apply(h.ctx)
  const face = h.registration.o.inject()
  face.editConn('c1', 'name', 'local')
  face.save()
  await new Promise((r) => setTimeout(r, 5))

  const ops = h.mutations[0]?.ops ?? []
  assert.deepEqual(ops, [{ op: 'set', path: ['connections', 'c1', 'name'], value: 'local' }],
    '只发一条改名字段的 op：没有 unset、没有"新增整条"')
  assert.equal(ops.some((o) => o.op === 'unset'), false, '键不该被删')
  assert.equal(ops.some((o) => o.path.length === 2), false, '不该整条重写 —— 那会把 password 冲成空串')
})

test('保存：port 填了非数字不写 NaN/null，当作"没设"', async () => {
  // port 输入框是 `type="text"`（只是唤数字键盘，不做前端校验），所以用户能填进字母。
  // 若原样 `Number()` 存进草稿，`JSON.stringify({port:NaN})` 会写成 `null` ——
  // schema 的 `z.number()` 收下它，配置里就静默多一个 `port: null`，连库时才报错。
  const h = harness()
  h.mod.apply(h.ctx)
  const face = h.registration.o.inject()

  face.editConn('c3', 'port', 'abc')
  face.save()
  await new Promise((r) => setTimeout(r, 5))

  const ops = h.mutations[0]?.ops ?? []
  const portOp = ops.find((o) => o.path[1] === 'c3' && o.path[2] === 'port')
  assert.ok(portOp, 'port 变了就该发 op')
  assert.equal(portOp.value, undefined, '非法输入当作"没设"，不能是 NaN / null')

  // 合法数字照常转
  const h2 = harness()
  h2.mod.apply(h2.ctx)
  const face2 = h2.registration.o.inject()
  face2.editConn('c3', 'port', '1234')
  face2.save()
  await new Promise((r) => setTimeout(r, 5))
  const portOp2 = (h2.mutations[0]?.ops ?? []).find((o) => o.path[1] === 'c3' && o.path[2] === 'port')
  assert.equal(portOp2.value, 1234)
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

  // 新增：多出一个条目，**不预填名字**（空名由 schema 的 .required() 在保存时拦下）
  face.addEnv()
  const withNewEnv = face.hooks.configCard.getSnapshot().envDraft
  assert.equal(Object.keys(withNewEnv).length, 3)
  const newEnvId = Object.keys(withNewEnv).find((k) => !['e1', 'e2'].includes(k))
  assert.equal(withNewEnv[newEnvId]?.name, '', '新环境不预填名字')

  face.addConn()
  const withNewConn = face.hooks.configCard.getSnapshot().connDraft
  assert.equal(Object.keys(withNewConn).length, 4, '新连接的键不能跟已有的撞')
  const newId = Object.keys(withNewConn).find((k) => !['c1', 'c2', 'c3'].includes(k))
  assert.equal(withNewConn[newId]?.engine, 'mysql', '新连接默认 mysql')
  assert.equal(withNewConn[newId]?.name, '', '新连接不预填名字')
  assert.equal(withNewConn[newId]?.readOnly, true, '新连接默认只读（与 fail-safe 一致）')
  // 预置的字段必须**是 mysql 用得到的那些**（与服务端 connectionFieldKeys 对齐）：
  // 有 host/port/database，**没有** sqlite 专用的 file
  assert.equal(withNewConn[newId]?.host, '', 'mysql 要 host')
  assert.equal(withNewConn[newId]?.port, undefined, 'port 留 undefined，好让服务端报"缺少 port"')
  assert.equal(
    Object.prototype.hasOwnProperty.call(withNewConn[newId], 'file'),
    false,
    '不该预置 sqlite 专用的 file',
  )

  // 删除：只删指定的那个
  face.removeEnv('e1')
  face.removeConn('c2')
  const snap = face.hooks.configCard.getSnapshot()
  assert.equal(snap.envDraft.e1, undefined, 'e1 被删掉')
  assert.equal(snap.envDraft.e2?.name, 'prod', 'e2 原样保留')
  assert.equal(snap.connDraft.c2, undefined, 'c2 被删掉')
  assert.deepEqual(Object.keys(snap.connDraft).sort(), [newId, 'c1', 'c3'].sort())
  assert.equal(Object.keys(snap.envDraft).includes('e1'), false, 'e1 已删')
})
