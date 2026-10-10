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
      emptyEnvs: '还没有环境。',

      connTitle: '连接',
      connName: '连接名',
      emptyConns: '还没有连接。',
      connEngine: '引擎',
      connFile: '数据库文件',
      connHost: '主机',
      connUser: '用户',
      connPassword: '密码',
      connDatabase: '数据库',
      connEnv: '限定环境',
      connReadOnly: '只读',
      connDescription: '用途说明',

      /**
       * placeholder 的两条规则（都写在**输入框内部**，不是行下面的说明）。
       *
       * ① **必填的写「必填」，非必填的留空** —— 早先每栏都塞"如 polar"这种示例，
       *    非必填的栏也顶着字，反而看不出哪个是必须的；示例还容易被照抄成一个
       *    填不出地址的假值。必填就说必填，具体填什么用户自己知道。
       *
       * ② **规则不显然的**（留空会怎样）才给一句话 —— 目前只有两处：
       *    `env` 留空 = 不限环境、mysql 的 `database` 留空会失去什么。
       *    像 host/port 这种一看就知道的不写，写了只是噪音。
       */
      required: '必填',
      phEnv: '留空表示不限定环境',
      // mysql 的 database 非必填，但留空有代价 —— 一句说清，短到能塞进输入框
      phDatabaseMysql: '可留空（库体积/表清单将不可用）',

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
      emptyEnvs: 'No environments yet.',

      connTitle: 'Connections',
      connName: 'Connection name',
      emptyConns: 'No connections yet.',
      connEngine: 'Engine',
      connFile: 'Database file',
      connHost: 'Host',
      connUser: 'User',
      connPassword: 'Password',
      connDatabase: 'Database',
      connEnv: 'Restricted to environment',
      connReadOnly: 'Read-only',
      connDescription: 'Description',

      required: 'Required',
      phEnv: 'Leave blank for any environment',
      phDatabaseMysql: 'Optional (size and table list then unavailable)',

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
    /**
     * 卡片顶部那行：名字 + 引擎 + 只读 + 删除。下面一条淡线跟字段区分开。
     *
     * `alignItems: 'flex-end'`（不是 center）—— 名字/引擎都是「标签 + 控件」的竖排，
     * 底边对齐才会让两个输入框齐平；用 center 的话有没有标签会决定高低，一眼就歪。
     * 只读与删除是单行控件，靠 `marginBottom` 对齐到输入框那一行。
     */
    const ROW_HEAD = {
      display: 'flex', gap: '10px', alignItems: 'flex-end',
      paddingBottom: '10px', borderBottom: '1px solid rgba(128,128,128,.18)',
    }
    /** 两列布局：连接字段多，一列铺开太长。 */
    const GRID = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }
    const FIELD = { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }
    const LABEL = { fontSize: '11px', opacity: 0.65 }
    /**
     * 装 `Switch` 的盒子 —— 撑到与 `INPUT` 等高（`minHeight: 30px`），开关居中。
     *
     * 存在的唯一理由是**对齐**：`ROW_HEAD` 是 `alignItems: flex-end`，
     * 而 Switch 比 input 矮。没有这层盒子，开关会贴行底、跟旁边的输入框错开一截。
     */
    const SWITCH_BOX = { display: 'flex', alignItems: 'center', minHeight: '30px' }
    const INPUT = {
      width: '100%', boxSizing: 'border-box', padding: '6px 9px', borderRadius: '6px',
      border: '1px solid rgba(128,128,128,.35)', background: 'transparent',
      color: 'inherit', font: 'inherit', fontSize: '12px', minHeight: '30px',
    }

    /**
     * `<select>` 的输入框样式 —— **不能直接用 `INPUT`**。
     *
     * ⚠ `INPUT.background: 'transparent'` 对文本框没问题（底下的卡片底色透出来），
     *   但 `<select>` 的**下拉弹层是系统绘制的**，它不继承 `color`：深色主题下
     *   弹层用系统默认的浅色底 + 我们传不下去的浅色字 → **白底白字，看不见选项**。
     *   （截图里就是这个问题。）
     *
     * 所以 select 一律**不设 background / color**，全走浏览器默认 —— 弹层与收起态
     * 由浏览器按当前配色方案自己配色，我们不去干预。
     */
    const SELECT = { ...INPUT, background: undefined, color: undefined }

    const BTN = {
      padding: '6px 12px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.35)',
      background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '12px', cursor: 'pointer',
    }
    const BTN_DANGER = { ...BTN, borderColor: 'rgba(220,90,90,.5)', color: '#e07a7a' }

    /** 引擎下拉的选项（顺序即展示顺序）。 */
    const ENGINES = ['sqlite', 'mysql', 'postgres'] as const

    /** 新建连接的默认引擎。 */
    const DEFAULT_ENGINE = 'mysql'

    /**
     * 新建连接时按引擎预置的字段（值一律"空 / 安全默认"）。
     *
     * ⚠ **必须与服务端 `connectionFieldKeys`（src/config.ts）的字段集对齐** ——
     *   那份是"这个引擎有哪些字段"的唯一真源。client 是独立 bundle
     *   （只 `require` react 与官方 primitives），require 不到服务端模块，
     *   所以这里是它的浏览器侧副本。改了那边记得一起改。
     *
     * 不预置别的引擎的字段：sqlite 用不到 `host`/`port`，硬塞进去只会在配置里
     * 留下一堆与这条连接无关的空键。
     *
     * `port` 特意是 `undefined` 而不是 0：0 不是合法端口，留 `undefined` 才能让
     * 服务端的 `missingConnectionFields` 明确报"缺少 port"（见 `editConn` 的说明）。
     */
    const ENGINE_DEFAULTS: Record<string, Record<string, unknown>> = {
      sqlite: { engine: 'sqlite', file: '', env: '', description: '', readOnly: true },
      mysql: {
        engine: 'mysql', host: '', port: undefined, user: '',
        database: '', env: '', description: '', readOnly: true,
      },
      postgres: {
        engine: 'postgres', host: '', port: undefined, user: '',
        database: '', env: '', description: '', readOnly: true,
      },
    }

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
      const def = props.def ?? {}
      // 名字是**条目里的字段**（键是随机 id）—— 跟环境一样，改名只改字段，
      // 不动键，所以密码不会被"新增整条"清空（见下 onRename 的说明）。
      const name = typeof def.name === 'string' ? def.name : ''
      const disabled = props.disabled
      const engine = typeof def.engine === 'string' && def.engine !== '' ? def.engine : 'sqlite'

      /**
       * 一个「标签 + 输入框」的字段。
       *
       * `placeholderKey` 是词条名，**省略就留空**。规则见词典那里的说明：
       * 必填的给 `required`（「必填」），非必填的**留空**，只有留空有代价的
       * （`env`）才另给一句。这不是校验（校验归建连侧的 `missingConnectionFields`）。
       */
      const text = (key: string, labelKey: string, placeholderKey?: string) =>
        react.createElement(
          'label',
          { key, style: FIELD },
          react.createElement('span', { style: LABEL }, t(labelKey)),
          react.createElement('input', {
            style: INPUT,
            type: 'text',
            autoComplete: 'off',
            value: def[key] == null ? '' : String(def[key]),
            placeholder: placeholderKey === undefined ? '' : t(placeholderKey),
            disabled,
            onChange: (e: any) => props.onEdit(key, e.target.value),
          }),
        )

      const fields: any[] = []

      if (engine === 'sqlite') {
        fields.push(text('file', 'connFile', 'required'))
      } else {
        fields.push(text('host', 'connHost', 'required'))
        // port 是数字：用 `inputMode="numeric"` 唤出数字键盘，**不做前端校验** ——
        // 填了字母就在提交时被 `Number()` 判成 `undefined`（= 不设），
        // 由建连侧的 `missingConnectionFields` 统一报"缺少 port"（见 editConn 的说明）。
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
              // port 与 host 同属必填（`missingConnectionFields` 会拦），所以也标必填
              placeholder: t('required'),
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
        // `database` 的必填性**随引擎变**：postgres 必填、mysql 可选。
        // 这种条件必填 schema 表达不了（见 config.ts 的 missingConnectionFields），
        // 所以两边的 placeholder 文案不同 —— 必填说"必填"，mysql 则说明留空的影响。
        fields.push(
          react.createElement(
            'label',
            { key: 'database', style: FIELD },
            react.createElement('span', { style: LABEL }, t('connDatabase')),
            react.createElement('input', {
              style: INPUT,
              type: 'text',
              autoComplete: 'off',
              value: def.database == null ? '' : String(def.database),
              placeholder: engine === 'postgres' ? t('required') : t('phDatabaseMysql'),
              disabled,
              onChange: (e: any) => props.onEdit('database', e.target.value),
            }),
          ),
        )
      }

      return react.createElement(
        'div',
        { style: ROW },
        react.createElement(
          'div',
          { style: ROW_HEAD },
          // ⚠ 名字框必须和引擎一样套在 `label > span + 控件` 里。
          //   裸 input 比带 label 的兄弟矮一个标签的高度，而 ROW_HEAD 是 `alignItems: flex-end`
          //   —— 不套的话名字框会跟「引擎」那两个字错开一截（曾经的"第一行不齐平"）。
          react.createElement(
            'label',
            { style: { ...FIELD, flex: '0 0 220px' } },
            react.createElement('span', { style: LABEL }, t('connName')),
            react.createElement('input', {
              style: { ...INPUT, fontWeight: 600 },
              value: name,
              disabled,
              // 连接名必填（schema 的 `.required()`，也是工具入参的寻址方式）
              placeholder: t('required'),
              // 改名 = 改 `name` 字段（深路径 op）—— 键是随机 id，不动，所以
              // 同级的 `password` 原样留在宿主里（浏览器本来就拿不到它）。
              onChange: (e: any) => props.onEdit('name', e.target.value),
            }),
          ),
          react.createElement(
            'label',
            { style: { ...FIELD, flex: '0 0 140px' } },
            react.createElement('span', { style: LABEL }, t('connEngine')),
            react.createElement(
              'select',
              {
                style: SELECT,
                value: engine,
                disabled,
                onChange: (e: any) => props.onEdit('engine', e.target.value),
              },
              ENGINES.map((g) => react.createElement('option', { key: g, value: g }, g)),
            ),
          ),
          // 只读开关：切引擎会让可用字段变，所以放头行（跟名字/引擎一行）。
          // 用官方 `Switch`（与 dsh-api-call 同款），不是原生 checkbox —— 原生那个
          // 在这里只是个系统小方框，跟整页的观感对不上。
          //
          // ⚠ 语义是**反的**：开关"开" = 只读 = `readOnly: true`（fail-safe 那一侧）。
          //   `def.readOnly !== false` 与 `isReadOnly()` 同一套判法 —— 缺省/非法值都
          //   算只读，所以这里"开"的两个来源（true 与 undefined）表现一致。
          //
          // ⚠ 外面这层盒子**不是多余的**：`ROW_HEAD` 是 `alignItems: flex-end`，
          //   而 `Switch` 比 input 矮（input 有 `minHeight: 30px`）。不套盒子的话
          //   开关会贴着行底、跟名字/引擎的输入框错开一截。
          //   盒子撑到与 input 等高，开关在里面垂直居中，三者的底边就齐了。
          react.createElement(
            'label',
            { style: { ...FIELD, flex: 'none' } },
            react.createElement('span', { style: LABEL }, t('connReadOnly')),
            react.createElement(
              'span',
              { style: SWITCH_BOX },
              react.createElement(primitives.Switch, {
                checked: def.readOnly !== false,
                disabled,
                label: t('connReadOnly'),
                onChange: (v: boolean) => props.onEdit('readOnly', v),
              }),
            ),
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
          text('env', 'connEnv', 'phEnv'),
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
          // 环境名必填（schema 的 `.required()`，也是 activeEnv / 连接的 env 的引用目标）
          placeholder: t('required'),
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

    /**
     * 由表单模型算出的卡片级状态 —— 与 dsh-api-call 的 `cardState` 同构。
     *
     * ⚠ `invalid` 必须**同时**看 `shell.invalid` 与逐字段的 `invalid`：
     *   shell 的只说"有计划但某项没法转成写入"，而草稿里已经打错的数字落在
     *   `field().invalid` 上；光看 shell 会让"填了字母"的输入框也能点保存。
     */
    /** 官方 `SettingsForm` 认的状态形状（与 dsh-api-call 的 `cardState` 同构）。 */
    interface CardShellState {
      available: boolean
      writable: boolean
      dirty: boolean
      invalid: boolean
      saving: boolean
      failed: boolean
    }

    function cardState(shell: any, fields: any[]): CardShellState {
      return {
        available: shell.available,
        writable: shell.writable,
        dirty: shell.dirty,
        invalid: shell.invalid || fields.some((f) => f.invalid),
        saving: shell.saving,
        failed: shell.failed,
      }
    }

    function formLabels(t: (key: string) => string): Record<string, string> {
      return {
        save: t('save'),
        saving: t('saving'),
        saveFailed: t('saveFailed'),
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
      }
    }

    function apiCallCardFactory(api: any) {
      return function SqlConfigCard(props: any) {
        const t = props.t
        const state = props.useConfigCard((s: any) => s)

        // 标量字段：逐字段取出来喂给 cardState（它要判 invalid）
        const fields = ['activeEnv', 'maxRows'].map((key) => state.form[key] ?? {})
        // `state.shell` 在 scope 未就绪时是那个全 false 的占位，形状一致。
        const shell = cardState(state.shell ?? {}, fields)
        // 字典草稿也算"脏"：用户可能只改了连接，没碰标量字段。
        // ⚠ 这个 `dirty` 是给官方 `SettingsForm` 决定按钮变色的 —— 少了它，
        //   改了连接也会显示成"没改动"，按钮不会亮。
        const full = {
          ...shell,
          dirty: shell.dirty === true || state.dirty === true,
        }
        const disabled = full.writable !== true || full.saving === true

        return react.createElement(
          // ⚠ 外壳必须用官方的 `SettingsForm`，**不能自己画 `<div>` + 裸 `<button>`**。
          //
          //   官方的这个组件负责三件事，自绘版一件都做不了：
          //     ① 画「保存 / 丢弃」按钮，并按 dirty / saving / failed 变色
          //        （自绘的裸 button 只会 disabled，用户看不出"改了没保存"）
          //     ② 把 onSave / onDiscard 接到官方状态机上
          //     ③ 渲染 unavailable / readOnly 那两行提示
          //
          //   之前的 bug 就出在这里：自绘按钮没有正确的 dirty 语义，表现成
          //   "保存按钮不变色"，而标量字段的改动经由官方模型直接落了盘 ——
          //   "没点保存就生效"。这一层交给官方组件，两边就都不会发生了。
          primitives.SettingsForm,
          {
            labels: formLabels(t),
            state: full,
            onSave: props.save,
            onDiscard: props.discard,
          },

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
            Object.keys(state.connDraft).map((id) =>
              react.createElement(ConnectionCard, {
                key: id,
                t,
                def: state.connDraft[id],
                passwordDraft: state.passwordDraft[id] ?? '',
                disabled,
                onEdit: (key: string, value: unknown) => props.editConn(id, key, value),
                onRemove: () => props.removeConn(id),
              }),
            ),
            react.createElement('button', { type: 'button', style: BTN, disabled, onClick: props.addConn }, t('addConn')),
          ),
          // 「保存 / 丢弃」由官方 `SettingsForm` 画（见上面的说明）——
          // 这里**不要再自绘一个保存按钮**。
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

      let envDraft: Record<string, any> | null = null
      let connDraft: Record<string, any> | null = null
      /** 连接密码草稿：`条目 id -> 明文`。空串 = 不改动已存的那个。 */
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

      // ⚠ **顺序要紧，且与 dsh-api-call 一致**：
      //
      //     ① syncDrafts()        —— 先把草稿建起来
      //     ② form.bind(project)  —— `bind` 会**立即调一次** `project()`
      //     ③ scope.subscribe(…)  —— 宿主配置变了再重建
      //
      //   把 `syncDrafts()` 放到 `bind` 之后是错的：scope 已就绪时，`bind` 那一刻
      //   草稿还是 `null`，`project()` 里的 `envDraft ?? {}` 就把**空字典**投了出去。
      //   而 `syncDrafts()` 只赋值、**不刷新 store** —— 那个空投影会一直挂着，
      //   直到下一次 `refresh()`（编辑或宿主推送）才恢复。表现就是"环境和连接两节
      //   明明是配好的，却显示空"。
      syncDrafts()

      const store = form.bind(project)
      const refresh = () => store.set(project())

      const unsubscribeScope = scope.subscribe(() => { syncDrafts(); refresh() })

      /** 编成深路径 ops。 */
      function dictOps(base: Record<string, any>, draft: Record<string, any> | null, field: string) {
        const ops: any[] = []
        if (!draft) return ops
        for (const key of Object.keys(draft)) {
          const next = draft[key]
          const prev = Object.prototype.hasOwnProperty.call(base, key) ? base[key] : undefined
          if (prev === undefined) {
            // 新增整条。连接要显式带 `password: ''`（新连接本来就没密码，让 schema 的
            // 默认值明确落地）；**环境没有密码字段**，别给它塞。
            const seed = field === 'connections' ? { password: '', ...next } : next
            ops.push({ op: 'set', path: [field, key], value: seed })
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

      function discard() {
        // 扔掉草稿 → 下次 sync 从宿主值重建（与 api-call 的 discard 同构）
        envDraft = null
        connDraft = null
        passwordDraft = {}
        syncDrafts()
        refresh()
        form.actions().discard()
      }

      const actions = {
        edit: (field: string, text: string) => form.actions().edit(field, text),
        save,
        discard,

        // 新增一律**留空**，不预填任何名字 —— 预填的 `qa` / `main` 只是噪声：
        // 用户还得先删掉它才能写自己要的，而忘了删就会存下一个假名字。
        // 空名由 `name` 的 schema（`.required()`）在保存时拦下，不会静默入库。
        addEnv: () => {
          const id = newId()
          envDraft = { ...(envDraft ?? {}), [id]: { name: '' } }
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
          const id = newId()
          // `name` 才是业务名（键是随机 id）。**留空不预填** —— 理由同 addEnv。
          //
          // 其余字段按**该引擎用得到的**给（见 ENGINE_DEFAULTS）：字段集与
          //   服务端 `connectionFieldKeys`（src/config.ts）对齐 —— 那份是
          //   "这个引擎有哪些字段"的唯一真源，这里只是它的浏览器侧副本
          //   （client 是独立 bundle，require 不到服务端模块，只能各写一份）。
          // 值一律是"空/安全默认"，不编造连接信息：`readOnly: true` 与 fail-safe
          //   一致，空串字段本来就等于没填。
          connDraft = {
            ...(connDraft ?? {}),
            [id]: { name: '', ...ENGINE_DEFAULTS[DEFAULT_ENGINE] },
          }
          refresh()
        },
        removeConn: (id: string) => {
          if (!connDraft?.[id]) return
          const next = { ...connDraft }
          delete next[id]
          connDraft = next
          if (passwordDraft[id] !== undefined) {
            const kept = { ...passwordDraft }
            delete kept[id]
            passwordDraft = kept
          }
          refresh()
        },
        editConn: (id: string, key: string, value: unknown) => {
          if (!connDraft?.[id]) return
          if (key === 'password') {
            passwordDraft = { ...passwordDraft, [id]: String(value) }
            refresh()
            return
          }
          // port 从输入框来的是字符串，转成数字。
          //
          // ⚠ 空串与"转不出数字"都留 `undefined`（= 不设），**不能存 NaN**：
          //   `Number('abc')` 是 NaN，而 `JSON.stringify({port:NaN})` 会写成 `null`
          //   —— schema 的 `z.number()` 收下 `null`，于是配置里静默多出一个 `port: null`，
          //   连库时才以"端口不对"的形式暴露，离原因很远。
          //   留 undefined 的话，`missingConnectionFields` 会明确报"缺少 port"。
          let v: unknown = value
          if (key === 'port') {
            const n = value === '' ? NaN : Number(value)
            v = Number.isFinite(n) ? n : undefined
          }
          const next = { ...connDraft }
          next[id] = { ...next[id], [key]: v }
          connDraft = next
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
                    // ⚠ 只给 `hooks` 与动作，**不给 `useConfigCard`** ——
                    //   它由插槽框架通过 `props` 提供（卡片里用的是 `props.useConfigCard`）。
                    //   自己再塞一份是同名重复：框架那份优先，行为又一致，纯属噪声。
                    //   与 dsh-api-call 的 `inject()` 保持同构。
                    hooks: { configCard: store },
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
