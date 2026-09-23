/**
 * SQL 词法处理：去噪与语句切分。
 *
 * 独立成模块是因为**工具层（`tools.ts`）与适配器层（`adapters.ts`）都要用同一套判断** ——
 * 两处各写一套（一个去噪、一个裸 `includes(';')`）会得出不同结论：注释里的分号会让
 * `CREATE TABLE t (id INT) /* ; *​/` 被误判成多语句。
 *
 * @module dsh-sql/sql-lex
 */

/**
 * 去掉字符串、引号标识符与注释，保留真实 SQL 关键字与分号。
 *
 * 目的是让「语句里是否出现写关键字 / 分号」的判断不被字面量骗到：
 * `SELECT * FROM t WHERE note = 'delete from x'` 里的 `delete` 不算。
 */
export function stripSqlNoise(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      i += 2
      while (i < sql.length && sql[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i + 1 < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (ch === '#' && (i === 0 || /\s/.test(sql[i - 1]))) {
      if (/^#(?:>>?|-)/.test(sql.slice(i))) {
        out += ch
        i += 1
        continue
      }
      i += 1
      while (i < sql.length && sql[i] !== '\n') i += 1
      continue
    }
    if (ch === "'") {
      out += ' '
      i += 1
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue }
        if (sql[i] === "'") { i += 1; break }
        if (sql[i] === '\\') { i += 2; continue }
        i += 1
      }
      continue
    }
    if (ch === '"' || ch === '`') {
      out += ' '
      i += 1
      while (i < sql.length) {
        if (sql[i] === ch) { i += 1; break }
        if (sql[i] === '\\') { i += 2; continue }
        i += 1
      }
      continue
    }
    if (ch === '[') {
      out += ' '
      i += 1
      while (i < sql.length && sql[i] !== ']') i += 1
      i += 1
      continue
    }
    if (ch === '$') {
      const dollar = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i))
      if (dollar !== null) {
        out += ' '
        i += dollar[0].length
        const end = sql.indexOf(dollar[0], i)
        i = end === -1 ? sql.length : end + dollar[0].length
        continue
      }
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * 去噪后按分号切出非空语句。
 *
 * **这是全项目唯一的「几条语句」判断口径** —— 工具层的多语句拦截与适配器的单语句保护
 * 都走它，避免两套规则给出不同结论。
 */
export function splitStatements(sql: string): string[] {
  return stripSqlNoise(sql).split(';').filter((part) => part.trim() !== '')
}

/** 数语句条数。 */
export function countStatements(sql: string): number {
  return splitStatements(sql).length
}
