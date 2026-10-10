/**
 * 测试夹具：把「按名字写的连接表」转成配置真正用的形状。
 *
 * 配置里 `connections` 是 **「随机 id → { name, engine, ... }」**（跟 `environments`
 * 同构）。用例里写成 `{ polar: { engine: 'mysql' } }` 读起来清楚得多，所以在这里
 * 转一道 —— id 用可预测的 `c1` / `c2`…，方便断言时对照。
 *
 * ⚠ 键**不能**用连接名：那会让"改名"变成删旧键 + 加新键，而新增整条时浏览器拿不到
 *   已存的密码，等于改一次名清空密码。这条约束见 `src/config.ts` 的 `SqlSettings`。
 *
 * 条目里若已显式给了 `name`，以它为准（允许用例自己造「名字与键不一致」的场景）。
 */
export function conns(byName) {
  const out = {}
  let n = 0
  for (const [name, entry] of Object.entries(byName ?? {})) {
    out[`c${++n}`] = { name, ...(entry ?? {}) }
  }
  return out
}

/** 同上，但只给一个连接（用例里最常用）。 */
export function oneConn(name, entry) {
  return conns({ [name]: entry })
}
