/**
 * 构建后处理：把 `lib/client.js` 里 tsc 补的 ESM 标记剥掉。
 *
 * ## 为什么必须剥
 *
 * `src/client.ts` 走 tsc 编译（保持 TS 项目的单一构建链路），但它的**产物是浏览器
 * bundle** —— 由 DSH 的 ModuleLoader 当**普通 script** 加载（不是 ESM module）。
 * tsc 见源文件里有 `import`/`export` 语义就会在末尾补一句 `export {};` 把它标成模块，
 * 而浏览器解析 script 时遇到 `export` **直接语法报错**，整个表单消失。
 *
 * ## 为什么不用别的办法
 *
 * - 单独配一份 `tsconfig.client.json`（`module: "none"`）→ 会连带把 `import type`
 *   之类的类型导入也拒掉，得把 client.ts 的写法改成不用 import，得不偿失
 * - 手写 `lib/client.js`（像 dsh-api-call 那样）→ sql 是 TS 项目，混着写两种风格更乱
 *
 * 后处理一行正则最省事，而且**会验证结果**（剥完不该再有 ESM 语法），
 * 所以不会"改了配置忘了配套"导致静默失效。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = new URL('../lib/client.js', import.meta.url)
const before = readFileSync(FILE, 'utf8')

// 只剥 tsc 补的那句模块标记；源文件里我们本来就没有真的 import/export
const after = before
  .replace(/^export \{\};\s*$/m, '')
  .replace(/^\/\/# sourceMappingURL=.*$/m, '')

if (after === before) {
  console.log('lib/client.js：没有需要剥的 ESM 标记')
} else {
  writeFileSync(FILE, after)
  console.log('lib/client.js：已剥掉 ESM 标记')
}

// 验证：剥完之后不该再有顶层 import/export（那些在 script 里都是语法错误）
const rest = after
  .split('\n')
  .map((line, i) => [i + 1, line])
  .filter(([, line]) => /^\s*(import|export)\s/.test(line))
if (rest.length > 0) {
  console.error('❌ lib/client.js 里还有 ESM 语法，浏览器会语法报错：')
  for (const [n, line] of rest) console.error(`   行${n}: ${line.trim()}`)
  process.exit(1)
}
console.log('lib/client.js：确认无 ESM 语法，可作为 script 加载')
