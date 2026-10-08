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
export {};
