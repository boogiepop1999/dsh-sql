/**
 * dsh-sql —— 浏览器侧：插件详情页里的配置表单。
 *
 * ## 为什么必须有这个文件
 *
 * 光在服务端导出 `Config`（Schemastery schema）**不会**让配置页面出现。
 * 插件详情页的「配置」这一节由 `dsh-client-ui-plugin-manager` 决定显不显示：
 *
 *     configured: ledger.bundles.has(openPkg.name)
 *     //           ↑ keysOf("plugins.bundle.config") —— 有哪些客户端插件注册了这个插槽
 *
 * 也就是说：**只有往 `plugins.bundle.config` 注册过、且 key 命中包名，那个节才存在**。
 * 注册了它，页面由我们自己渲染；不注册，DSH 不会替你自动生成。
 *
 * ## 两个 id 不是一回事（踩过就会白折腾很久）
 *
 *     ctx.configForms.get("sql")             ← profile 条目 id（cordis.patch.yml 里的 id）
 *     slots.register({ key: "dsh-sql" })     ← npm 包名（openPkg.name）
 *
 * 前者定位**设置命名空间**（读写哪份配置），后者决定**这页挂在哪个插件详情页下**。
 * 写反了的表现是：页面永远不出现，且没有任何报错。
 *
 * ## 值怎么流
 *
 *     ctx.configForms.get(id)  ← 官方共享表单控制器
 *        │  读：scope.getSnapshot().value / .revision / .writable
 *        └── 写：scope.mutate(ops, revision) → 宿主校验 → 原子写 patch → Loader 热重载
 *
 * ## 与 dsh-api-call 的两处不同
 *
 * ① **`environments` 是「随机 id → { name }」的字典**（跟 api-call 同构），所以环境
 *    条目本身用深路径 op 增删改；但条目里**只有 name**（SQL 的环境没有地址之类的属性）。
 *
 * ② **`connections` 是「连接名 → 连接定义」的字典，键就是业务上的名字** ——
 *    跟 api-call 的 `users` 不同（那边键是随机 id）。所以这里**改名 = 删旧键 + 加新键**，
 *    要在一个 revision 栅栏下原子提交；而字段编辑只发改过的那个字段（深路径），
 *    这样同级的 `password` 不会被整组写回抹掉。
 *
 * ## 为什么连接不能用 `SettingsFormModel`
 *
 * 它的 `plan()` 把路径无条件包成**单层** `[field]`，表达不了
 * `["connections","polar","host"]` 这种深路径。所以整个表单（含标量）都自管草稿，
 * 由 `formIssues`/`draftOps` 编成 ops 一次提交。
 *
 * ⚠ 但**标量必须走官方模型**：`activeEnv` / `maxRows` 是顶层字段，官方模型够用，
 *   而且它会替我们处理"空串 = 清空字段"这类语义。见 `apply` 里的 `SettingsFormModel`。
 *
 * ## 密码
 *
 * `password` 是 `role('secret')` 字段，宿主在跨线前把值整个抹掉 —— 浏览器拿不到它。
 * 所以密码框**永远是空的**：空 = 不改动已存的密码，填了才覆盖。
 * 提示固定一句，不区分"已配置 / 没配置"（那份 secrets 侧信道在浏览器这条路上拿不到）。
 *
 * @module dsh-sql/client
 */

/** 浏览器侧拿到的 `require` 工厂（DSH 的 ModuleLoader 提供）。 */
type Require = (name: string) => unknown

interface ClientContext {
  locale: {
    bind(ns: string): (key: string, params?: Record<string, unknown>) => string
    register(ns: string, dicts: Record<string, unknown>): () => void
  }
  configForms: {
    get(id: string): ConfigScope
    whileServed(ids: string[], fn: () => unknown): () => void
  }
  slots: {
    inject(name: string, fn: () => unknown): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  effect(fn: () => unknown, label?: string): void
}

/** `ctx.configForms.get(id)` 给出的那份共享表单控制器。 */
interface ConfigScope {
  getSnapshot(): {
    status?: string
    writable?: boolean
    revision?: number
    value?: Record<string, unknown>
  }
  subscribe(fn: () => void): () => void
  mutate(ops: unknown[], revision?: number): Promise<boolean>
}

declare const window: { __ModuleLoader__: { load(entry: { id: string; factory: (require: Require) => unknown }): void } }

window.__ModuleLoader__.load({
  id: 'dsh-sql',
  factory: (require) => {
    const module = { exports: {} as Record<string, unknown> }
    const react = require('react') as any
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives') as any

    /** 本地化命名空间。 */
    const NS = 'sql'

    /** 设置命名空间 = profile 条目 id（`cordis.patch.yml` 里的 `id: sql`）。 */
    const SETTINGS_ID = 'sql'

    /** 插槽 key = **npm 包名**。必须与 package.json 的 `name` 一致。 */
    const PACKAGE_NAME = 'dsh-sql'

    // ── 词条 ──────────────────────────────────────────────────────────────

    const zh = {
      fieldActiveEnv: '当前环境',
      hintActiveEnv: '环境名（下面环境列表里某一项的名字）；留空表示未指定环境。',
      fieldMaxRows: '查询返回行数上限',
      hintMaxRows: '单次查询最多返回这么多行。范围 1~10000。',

      envTitle: '环境',
      envName: '环境名',
      envNamePlaceholder: '如 qa / prod',
      emptyEnvs: '还没有环境。',

      connTitle: '连接',
      connName: '连接名',
      connNamePlaceholder: '如 polar',
      emptyConns: '还没有连接。',
      connEngine: '引擎',
      connFile: '数据库文件',
      connFilePlaceholder: 'SQLite 文件路径，如 :memory:',
      connHost: '主机',
      connUser: '用户',
      connPassword: '密码',
      connDatabase: '数据库',
      connEnv: '限定环境',
      connEnvPlaceholder: '留空表示不限定环境',
      connReadOnly: '只读',
      connDescription: '用途说明',
      // 密码框永远是空的（宿主脱敏），一句把"没动"和"要改"都说清
      passwordPlaceholder: '留空表示不改动，输入新值可替换',

      addEnv: '添加环境',
      addConn: '添加连接',
      remove: '删除',

      save: '保存',
      saving: '保存中…',
      saveFailed: '保存未生效，请检查后重试。',
      unavailable: '配置尚不可用。',
      readOnly: '当前配置不可写。',
      invalidNumber: '请填一个数字。',

      engineSqlite: 'sqlite',
      engineMysql: 'mysql',
      enginePostgres: 'postgres',
    }

    const en: typeof zh = {
      fieldActiveEnv: 'Active environment',
      hintActiveEnv: 'Name of an entry in the environment list below; empty means none is selected.',
      fieldMaxRows: 'Row cap',
      hintMaxRows: 'Rows one query may return. Range 1~10000.',

      envTitle: 'Environments',
      envName: 'Name',
      envNamePlaceholder: 'e.g. qa / prod',
      emptyEnvs: 'No environments yet.',

      connTitle: 'Connections',
      connName: 'Connection name',
      connNamePlaceholder: 'e.g. polar',
      emptyConns: 'No connections yet.',
      connEngine: 'Engine',
      connFile: 'Database file',
      connFilePlaceholder: 'SQLite file path, e.g. :memory:',
      connHost: 'Host',
      connUser: 'User',
      connPassword: 'Password',
      connDatabase: 'Database',
      connEnv: 'Restricted to environment',
      connEnvPlaceholder: 'Leave blank for any environment',
      connReadOnly: 'Read-only',
      connDescription: 'Description',
      passwordPlaceholder: 'Leave blank to keep it; type a new one to replace',

      addEnv: 'Add environment',
      addConn: 'Add connection',
      remove: 'Remove',

      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The save did not take effect; check the values and retry.',
      unavailable: 'Settings are not available.',
      readOnly: 'This configuration is not writable.',
      invalidNumber: 'Enter a number.',

      engineSqlite: 'sqlite',
      engineMysql: 'mysql',
      enginePostgres: 'postgres',
    }

    // ── 小工具 ────────────────────────────────────────────────────────────

    /** 深拷贝（配置都是 JSON 形状，够用且不必依赖 structuredClone 的可用性）。 */
    function clone<T>(value: T): T {
      return value === undefined ? (undefined as T) : JSON.parse(JSON.stringify(value))
    }

    /**
     * 造一个新的条目 id（只给 `environments` 用）。
     *
     * id **只用于寻址**（React key、配置的键、深路径 op 的第二段），用户看不到也
     * 改不了 —— 显示名是条目里的 `name` 字段。
     *
     * 用随机值而不是递增编号：递增编号在"删了再加"时会重用数字，React 可能把旧节点
     * 的状态复用到新条目上（表现是新增的条目里冒出刚删掉那条的内容）。随机值不会撞。
     *
     * ## ⚠ 必须是「字母开头 + 纯小写十六进制」
     *
     * 这个 id 会被写进 **YAML**（profile 的 `cordis.patch.yml`），而 YAML 会**重新解释**
     * 某些裸标量：
     *
     *     `802e1106`  →  Infinity（科学计数法！）
     *     `12345`     →  数字
     *     `on`/`yes`  →  true
     *     `~`/`null`  →  null
     *
     * 这个坑真踩过：`randomUUID().slice(0,8)` 生成了 `802e1106`，写进 YAML 后
     * 读回来变成 `Infinity`，设置页里那个环境的 key 就成了个怪东西。
     *
     * 所以约束两条：
     *   ① **以字母开头** → 绝不可能是数字字面量
     *   ② 只用 `a-f0-9`  → 不会撞上 `on` / `yes` / `null` 这类特殊词
     */
    function newId(): string {
      // 用 randomUUID 的十六进制，但**强制首字符是字母**
      let hex = ''
      try {
        const c = (globalThis as any).crypto
        if (c && typeof c.randomUUID === 'function') hex = String(c.randomUUID()).replace(/-/g, '')
      } catch { /* 落到下面的兜底 */ }
      if (!/^[0-9a-f]+$/i.test(hex)) {
        hex = ''
        for (let i = 0; i < 16; i++) hex += Math.floor(Math.random() * 16).toString(16)
      }
      // 首字符落到 a~f：`a`..`f` 是 6/16 的概率，重试两次就够
      const head = 'abcdef'[Math.floor(Math.random() * 6)]
      const body = (hex.slice(0, 7) + '0000000').slice(0, 7)
      return head + body
    }

    /** 生成一个与现有条目不冲突的显示名（用于"添加"）。这不是校验，只是省得先弹输入框。 */
    function uniqueName(dict: Record<string, any>, base: string): string {
      const taken: Record<string, boolean> = {}
      for (const entry of Object.values(dict ?? {})) {
        if (entry && typeof entry.name === 'string') taken[entry.name] = true
      }
      if (!taken[base]) return base
      for (let n = 2; ; n++) {
        const candidate = base + n
        if (!taken[candidate]) return candidate
      }
    }

    /** 生成一个与现有**连接名**不冲突的名字（连接的键就是名字）。 */
    function uniqueKey(dict: Record<string, unknown>, base: string): string {
      if (!Object.prototype.hasOwnProperty.call(dict ?? {}, base)) return base
      for (let n = 2; ; n++) {
        const candidate = base + n
        if (!Object.prototype.hasOwnProperty.call(dict ?? {}, candidate)) return candidate
      }
    }

    // ── 样式 ──────────────────────────────────────────────────────────────

    const SECTION = { minWidth: 0, padding: '16px 0', borderTop: '1px solid rgba(128,128,128,.25)' }
    const H3 = { margin: '0 0 4px', fontSize: '13px', fontWeight: 600 }
    const P = { margin: '0 0 12px', fontSize: '12px', opacity: 0.72 }
    const EMPTY_STYLE = { margin: '0 0 10px', fontSize: '12px', opacity: 0.6 }

    /**
     * 一个条目 = **一张卡**（四条边 + 内边距 + 底色）。
     *
     * 早先只靠一条淡底边框分隔，结果是"字段全平铺、看不出条目在哪儿结束" ——
     * 下一个条目的名字框看着像上一个条目的字段。
     */
    const ROW = {
      display: 'flex', flexDirection: 'column', gap: '8px',
      padding: '12px', marginBottom: '10px', borderRadius: '8px',
      border: '1px solid rgba(128,128,128,.3)',
      background: 'rgba(128,128,128,.05)',
    }
    /** 卡片顶部那行：名字 + 删除。下面一条淡线跟字段区分开。 */
    const ROW_HEAD = {
      display: 'flex', gap: '10px', alignItems: 'center',
      paddingBottom: '10px', borderBottom: '1px solid rgba(128,128,128,.18)',
    }
    /** 两列布局：连接字段多，一列铺开太长。 */
    const GRID = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }
    const FIELD = { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }
    const LABEL = { fontSize: '11px', opacity: 0.65 }
    const INPUT = {
      width: '100%', boxSizing: 'border-box', padding: '6px 9px', borderRadius: '6px',
      border: '1px solid rgba(128,128,128,.35)', background: 'transparent',
      color: 'inherit', font: 'inherit', fontSize: '12px', minHeight: '30px',
    }
    const BTN = {
      padding: '6px 12px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.35)',
      background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '12px', cursor: 'pointer',
    }
    const BTN_DANGER = { ...BTN, borderColor: 'rgba(220,90,90,.5)', color: '#e07a7a' }
    const CHECKBOX_ROW = { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', minHeight: '30px' }

    /** 引擎下拉的选项（顺序即展示顺序）。 */
    const ENGINES = ['sqlite', 'mysql', 'postgres'] as const

    // ── 渲染：一个连接 ────────────────────────────────────────────────────

    /**
     * 连接的字段按引擎显示 —— 这是**界面上的**便利，不是校验：
     * 保存时 schema 只保证形状（`file`/`host` 都是可选的字符串），
     * "sqlite 必须有 file"这类**条件必填**由服务端建连时判（`missingConnectionFields`），
     * 因为 schemastery 表达不了"这个字段在那种引擎下必填"。
     *
     * ⚠ 但字段值**一律保留**，切引擎不丢别的引擎的输入 —— 用户可能只是想对比一下。
     */
    function ConnectionCard(props: any) {
      const t = props.t
      const name = props.name
      const def = props.def ?? {}
      const disabled = props.disabled
      const engine = typeof def.engine === 'string' && def.engine !== '' ? def.engine : 'sqlite'

      const text = (key: string, labelKey: string, placeholder?: string) =>
        react.createElement(
          'label',
          { key, style: FIELD },
          react.createElement('span', { style: LABEL }, t(labelKey)),
          react.createElement('input', {
            style: INPUT,
            type: 'text',
            autoComplete: 'off',
            value: def[key] == null ? '' : String(def[key]),
            placeholder: placeholder ?? '',
            disabled,
            onChange: (e: any) => props.onEdit(key, e.target.value),
          }),
        )

      const fields: any[] = []

      if (engine === 'sqlite') {
        fields.push(text('file', 'connFile', t('connFilePlaceholder')))
      } else {
        fields.push(text('host', 'connHost'))
        // port 是数字：用 numberField 让"填了字母"能被标红，而不是悄悄存成字符串
        fields.push(
          react.createElement(
            'label',
            { key: 'port', style: FIELD },
            react.createElement('span', { style: LABEL }, t('connHost') + ' / port'),
            react.createElement('input', {
              style: INPUT,
              type: 'text',
              inputMode: 'numeric',
              value: def.port == null ? '' : String(def.port),
              disabled,
              onChange: (e: any) => props.onEdit('port', e.target.value),
            }),
          ),
        )
        fields.push(text('user', 'connUser'))
        // 密码：**明文输入**（值永远初始为空，用户只在这里输新密码；打错当场看得见）
        fields.push(
          react.createElement(
            'label',
            { key: 'password', style: FIELD },
            react.createElement('span', { style: LABEL }, t('connPassword')),
            react.createElement('input', {
              style: INPUT,
              type: 'text',
              autoComplete: 'off',
              value: props.passwordDraft ?? '',
              placeholder: t('passwordPlaceholder'),
              disabled,
              onChange: (e: any) => props.onEdit('password', e.target.value),
            }),
          ),
        )
        fields.push(text('database', 'connDatabase'))
      }

      return react.createElement(
        'div',
        { style: ROW },
        react.createElement(
          'div',
          { style: ROW_HEAD },
          react.createElement('input', {
            style: { ...INPUT, flex: '0 0 220px', fontWeight: 600 },
            value: name,
            disabled,
            placeholder: t('connNamePlaceholder'),
            'aria-label': t('connName'),
            // 改名走 onRename（删旧键 + 加新键），不是改字段
            onChange: (e: any) => props.onRename(e.target.value),
          }),
          react.createElement(
            'label',
            { style: { ...FIELD, flex: '0 0 140px' } },
            react.createElement('span', { style: LABEL }, t('connEngine')),
            react.createElement(
              'select',
              {
                style: INPUT,
                value: engine,
                disabled,
                onChange: (e: any) => props.onEdit('engine', e.target.value),
              },
              ENGINES.map((g) => react.createElement('option', { key: g, value: g }, g)),
            ),
          ),
          // 只读开关：切引擎会让可用字段变，所以放头行（跟名字/引擎一行）
          react.createElement(
            'label',
            { style: { ...CHECKBOX_ROW, flex: 'none' } },
            react.createElement('input', {
              type: 'checkbox',
              checked: def.readOnly !== false,
              disabled,
              onChange: (e: any) => props.onEdit('readOnly', e.target.checked),
            }),
            t('connReadOnly'),
          ),
          react.createElement(
            'button',
            { type: 'button', style: { ...BTN_DANGER, flex: 'none', marginLeft: 'auto' }, disabled, onClick: props.onRemove },
            t('remove'),
          ),
        ),
        react.createElement('div', { style: GRID }, fields),
        react.createElement(
          'div',
          { style: GRID },
          text('env', 'connEnv', t('connEnvPlaceholder')),
          text('description', 'connDescription'),
        ),
      )
    }

    // ── 渲染：环境（只有 name，所以一行一个） ──────────────────────────────

    function EnvironmentCard(props: any) {
      const t = props.t
      return react.createElement(
        'div',
        { style: { ...ROW, flexDirection: 'row', alignItems: 'center', gap: '10px' } },
        react.createElement('input', {
          style: { ...INPUT, flex: '0 0 240px', fontWeight: 600 },
          value: props.def?.name ?? '',
          disabled: props.disabled,
          placeholder: t('envNamePlaceholder'),
          'aria-label': t('envName'),
          onChange: (e: any) => props.onEdit('name', e.target.value),
        }),
        react.createElement(
          'button',
          { type: 'button', style: { ...BTN_DANGER, flex: 'none' }, disabled: props.disabled, onClick: props.onRemove },
          t('remove'),
        ),
      )
    }

    // ── 卡片 ──────────────────────────────────────────────────────────────

    function apiCallCardFactory(api: any) {
      return function SqlConfigCard(props: any) {
        const t = props.t
        const state = props.useConfigCard((s: any) => s)
        const disabled = !state.writable || state.saving

        return react.createElement(
          'div',
          null,
          !state.writable
            ? react.createElement('p', { style: P, role: 'status' }, t('readOnly'))
            : null,

          // 标量：走官方组件（`text`/`onEdit` 由 SettingsFormModel 提供）
          react.createElement(primitives.SettingsValueField, {
            id: 'dsh-sql-activeEnv',
            label: t('fieldActiveEnv'),
            hint: t('hintActiveEnv'),
            text: state.form.activeEnv?.text ?? '',
            onEdit: (text: string) => props.edit('activeEnv', text),
            disabled,
          }),
          react.createElement(primitives.SettingsValueField, {
            id: 'dsh-sql-maxRows',
            label: t('fieldMaxRows'),
            hint: t('hintMaxRows'),
            text: state.form.maxRows?.text ?? '',
            onEdit: (text: string) => props.edit('maxRows', text),
            invalid: state.form.maxRows?.invalid,
            invalidLabel: t('invalidNumber'),
            numeric: true,
            disabled,
          }),

          // 环境清单
          react.createElement(
            'section',
            { style: SECTION },
            react.createElement('h3', { style: H3 }, t('envTitle')),
            Object.keys(state.envDraft).length === 0
              ? react.createElement('p', { style: EMPTY_STYLE }, t('emptyEnvs'))
              : null,
            Object.keys(state.envDraft).map((id) =>
              react.createElement(EnvironmentCard, {
                key: id,
                t,
                def: state.envDraft[id],
                disabled,
                onEdit: (key: string, value: unknown) => props.editEnv(id, key, value),
                onRemove: () => props.removeEnv(id),
              }),
            ),
            react.createElement('button', { type: 'button', style: BTN, disabled, onClick: props.addEnv }, t('addEnv')),
          ),

          // 连接清单
          react.createElement(
            'section',
            { style: SECTION },
            react.createElement('h3', { style: H3 }, t('connTitle')),
            Object.keys(state.connDraft).length === 0
              ? react.createElement('p', { style: EMPTY_STYLE }, t('emptyConns'))
              : null,
            Object.keys(state.connDraft).map((name) =>
              react.createElement(ConnectionCard, {
                key: name,
                t,
                name,
                def: state.connDraft[name],
                passwordDraft: state.passwordDraft[name] ?? '',
                disabled,
                onEdit: (key: string, value: unknown) => props.editConn(name, key, value),
                onRename: (next: string) => props.renameConn(name, next),
                onRemove: () => props.removeConn(name),
              }),
            ),
            react.createElement('button', { type: 'button', style: BTN, disabled, onClick: props.addConn }, t('addConn')),
          ),

          // 底部：保存
          react.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '12px', paddingTop: '12px' } },
            react.createElement(
              'button',
              {
                type: 'button',
                style: BTN,
                disabled: disabled || !state.dirty,
                onClick: props.save,
              },
              state.saving ? t('saving') : t('save'),
            ),
            state.failed ? react.createElement('span', { style: { fontSize: '12px', color: '#e07a7a' } }, t('saveFailed')) : null,
          ),
        )
      }
    }

    // ── apply ─────────────────────────────────────────────────────────────

    function apply(ctx: ClientContext) {
      const t = ctx.locale.bind(NS)

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-sql: dictionaries')

      const scope = ctx.configForms.get(SETTINGS_ID)

      // 标量走官方模型（顶层字段，官方够用）
      const form = new primitives.SettingsFormModel(scope, [
        primitives.settingsTextField('activeEnv'),
        primitives.settingsNumberField('maxRows'),
      ])

      const listeners = new Set<() => void>()
      let envDraft: Record<string, any> | null = null
      let connDraft: Record<string, any> | null = null
      /** 连接密码草稿：`连接名 -> 明文`。空串 = 不改动已存的那个。 */
      let passwordDraft: Record<string, string> = {}
      /** 宿主原值快照 —— 用来判断草稿有没有变。 */
      let baseline = { environments: {} as Record<string, any>, connections: {} as Record<string, any> }

      const scopeReady = () => {
        const s = scope.getSnapshot()
        return s.status === 'ready' && s.value !== undefined
      }

      function dictOf(value: unknown): Record<string, any> {
        const d = clone(value)
        return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, any>) : {}
      }

      /** 从宿主值重建 baseline 与草稿。**只在草稿为 null 时覆盖**，否则会吞掉用户输入。 */
      function syncDrafts() {
        if (!scopeReady()) return
        const value = scope.getSnapshot().value ?? {}
        baseline = { environments: dictOf(value.environments), connections: dictOf(value.connections) }
        if (envDraft === null) envDraft = clone(baseline.environments)
        if (connDraft === null) connDraft = clone(baseline.connections)
      }

      function isDirty() {
        if (envDraft === null || connDraft === null) return false
        if (JSON.stringify(envDraft) !== JSON.stringify(baseline.environments)) return true
        if (JSON.stringify(connDraft) !== JSON.stringify(baseline.connections)) return true
        for (const k of Object.keys(passwordDraft)) if (passwordDraft[k]) return true
        return false
      }

      function project() {
        if (!scopeReady()) {
          return {
            shell: { available: false, writable: false, dirty: false, invalid: false, saving: false, failed: false },
            form: {},
            envDraft: {},
            connDraft: {},
            passwordDraft: {},
            dirty: false,
            writable: false,
            saving: false,
            failed: false,
          }
        }
        const byKey: Record<string, any> = {}
        for (const key of ['activeEnv', 'maxRows']) byKey[key] = form.field(key)
        const shell = form.shell()
        return {
          shell,
          form: byKey,
          envDraft: envDraft ?? {},
          connDraft: connDraft ?? {},
          passwordDraft,
          dirty: shell.dirty || isDirty(),
          writable: shell.writable,
          saving: shell.saving,
          failed: shell.failed,
        }
      }

      const store = form.bind(project)
      const refresh = () => store.set(project())

      syncDrafts()

      const unsubscribeScope = scope.subscribe(() => { syncDrafts(); refresh() })

      /** 编成深路径 ops。 */
      function dictOps(base: Record<string, any>, draft: Record<string, any> | null, field: string) {
        const ops: any[] = []
        if (!draft) return ops
        for (const key of Object.keys(draft)) {
          const next = draft[key]
          const prev = Object.prototype.hasOwnProperty.call(base, key) ? base[key] : undefined
          if (prev === undefined) {
            // 新增整条。显式带 `password: ''` 是刻意的：新条目本来就没密码。
            ops.push({ op: 'set', path: [field, key], value: { password: '', ...next } })
            continue
          }
          for (const k of Object.keys(next)) {
            if (JSON.stringify(next[k]) === JSON.stringify(prev[k])) continue
            ops.push({ op: 'set', path: [field, key, k], value: next[k] })
          }
        }
        for (const key of Object.keys(base)) {
          if (!Object.prototype.hasOwnProperty.call(draft, key)) ops.push({ op: 'unset', path: [field, key] })
        }
        return ops
      }

      function save() {
        const ops: any[] = []
        if (envDraft) ops.push(...dictOps(baseline.environments, envDraft, 'environments'))
        // ⚠ 连接：**先删后改**由 ops 顺序保证不了，所以改名是"原子一批"提交 ——
        //   删旧键 + 加新键在同一个 revision 栅栏下，不会留中间态。
        if (connDraft) ops.push(...dictOps(baseline.connections, connDraft, 'connections'))
        for (const name of Object.keys(passwordDraft)) {
          if (!passwordDraft[name]) continue
          if (!connDraft || !connDraft[name]) continue
          ops.push({ op: 'set', path: ['connections', name, 'password'], value: passwordDraft[name] })
        }

        if (!ops.length) {
          form.actions().save()
          return
        }
        const snapshot = scope.getSnapshot()
        if (!snapshot.writable) return
        void scope.mutate(ops, snapshot.revision).then((ok) => {
          if (!ok) return
          envDraft = null
          connDraft = null
          passwordDraft = {}
          syncDrafts()
          refresh()
          form.actions().save()
        })
      }

      const actions = {
        edit: (field: string, text: string) => form.actions().edit(field, text),
        save,

        addEnv: () => {
          envDraft = { ...(envDraft ?? {}) }
          const id = newId()
          envDraft[id] = { name: uniqueName(envDraft, 'qa') }
          refresh()
        },
        removeEnv: (id: string) => {
          if (!envDraft?.[id]) return
          const next = { ...envDraft }
          delete next[id]
          envDraft = next
          refresh()
        },
        editEnv: (id: string, key: string, value: unknown) => {
          if (!envDraft?.[id]) return
          const next = { ...envDraft }
          next[id] = { ...next[id], [key]: value }
          envDraft = next
          refresh()
        },

        addConn: () => {
          const cur = { ...(connDraft ?? {}) }
          const name = uniqueKey(cur, 'main')
          cur[name] = { engine: 'sqlite', file: '', port: undefined, user: '', database: '', env: '', readOnly: true, description: '' }
          connDraft = cur
          refresh()
        },
        removeConn: (name: string) => {
          if (!connDraft?.[name]) return
          const next = { ...connDraft }
          delete next[name]
          connDraft = next
          if (passwordDraft[name] !== undefined) {
            const kept = { ...passwordDraft }
            delete kept[name]
            passwordDraft = kept
          }
          refresh()
        },
        editConn: (name: string, key: string, value: unknown) => {
          if (!connDraft?.[name]) return
          if (key === 'password') {
            passwordDraft = { ...passwordDraft, [name]: String(value) }
            refresh()
            return
          }
          // port 从输入框来的是字符串，转成数字（空串 = 不设，留 undefined）
          let v: unknown = value
          if (key === 'port') v = value === '' ? undefined : Number(value)
          const next = { ...connDraft }
          next[name] = { ...next[name], [key]: v }
          connDraft = next
          refresh()
        },
        /** 改名 = 删旧键 + 加新键，**在同一个草稿里**做，保存时原子提交。 */
        renameConn: (from: string, to: string) => {
          if (!connDraft?.[from] || from === to) return
          const next: Record<string, any> = {}
          for (const k of Object.keys(connDraft)) {
            if (k === from) next[to] = connDraft[k]
            else if (k !== to) next[k] = connDraft[k]
          }
          connDraft = next
          if (passwordDraft[from] !== undefined) {
            const kept = { ...passwordDraft }
            kept[to] = kept[from]
            delete kept[from]
            passwordDraft = kept
          }
          refresh()
        },
      }

      ctx.effect(
        () =>
          ctx.configForms.whileServed([SETTINGS_ID], () =>
            ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: PACKAGE_NAME,
                  locale: NS,
                  inject: () => ({
                    hooks: { configCard: store },
                    useConfigCard: (sel: (s: any) => unknown) => sel(store.getSnapshot()),
                    ...actions,
                  }),
                },
                apiCallCardFactory(actions),
              ),
            ),
          ),
        'dsh-sql: settings page',
      )

      ctx.effect(
        () => () => {
          unsubscribeScope()
          listeners.clear()
          form.dispose()
        },
        'dsh-sql: settings form subscription',
      )
    }

    module.exports.apply = apply
    module.exports.inject = ['slots', 'locale', 'configForms']
    return module.exports
  },
})
