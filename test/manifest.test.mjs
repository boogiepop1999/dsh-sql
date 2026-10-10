import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

test('dsh.bundle.patch 与 exports', () => {
  const pkg = require('../package.json')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(existsSync(new URL('../cordis.patch.yml', import.meta.url)))
  assert.equal(pkg.exports['./package.json'], './package.json')
})

test('cordis.patch.yml 插入行名为 dsh-sql', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /name: 'dsh-sql'/)
  assert.match(patch, /- insert:/)
})

test('名称与版本', () => {
  const pkg = require('../package.json')
  assert.equal(pkg.name, 'dsh-sql')
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
})

/**
 * 构建产物的**形状**检查 —— 防的是"编译了但跑错命令"。
 *
 * ## 为什么需要这条
 *
 * `src/client.ts` 走 tsc 编译，但它的产物 `lib/client.js` 是**浏览器 bundle**，
 * 由 DSH 的 ModuleLoader 当**普通 script** 加载。tsc 见源文件里有 import/export
 * 语义，会在产物末尾补一句 `export {};` 标成模块 —— 而 script 里出现 `export`
 * 直接语法报错，结果是**插件 import failed、DSH 整个起不来**。
 *
 * 剥掉那句标记是 `scripts/fix-client-bundle.mjs` 的活，而它**只在 `npm run build`
 * 里**（见 package.json 的 scripts）。于是：
 *
 *     npm run build   ✅  tsc + 后处理
 *     npx tsc -p …    ❌  只有 tsc → 产物被污染，而且**不报任何错**
 *
 * 这个坑很隐蔽：`lib/` 被 .gitignore（`git status` 看不出来），tsc 自己也不报错，
 * 要等下次启动 DSH 才炸。**真踩过一次**，代价是应用无法启动。
 *
 * ## 为什么不会误报
 *
 * `pnpm test` = `pnpm run build && node --test`，先跑**正确**的构建再测。
 * 所以正常流程下产物一定是干净的；只有"绕过 build 单跑 tsc"才会红。
 *
 * ⚠ 这条**抓不住**"编译完不跑测试就直接重启 DSH"的情况 —— 那种只能靠人记得
 *   用 `npm run build`。要根治得改构建链（让 tsc 的输出碰不到这个文件）。
 */
test('lib/client.js 必须是 ModuleLoader bundle（防 tsc 单独编译污染产物）', () => {
  const file = new URL('../lib/client.js', import.meta.url)
  assert.ok(existsSync(file), 'lib/client.js 不存在 —— 先跑 `npm run build`')
  const src = readFileSync(file, 'utf8')

  // ① 不能有顶层 import/export —— 在 script 里是语法错误
  const esm = src
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /^\s*(import|export)\s/.test(line))
  assert.equal(
    esm.length,
    0,
    'lib/client.js 含 ESM 语法，浏览器会语法报错、插件无法加载。' +
    `改用 \`npm run build\`（它会跑 scripts/fix-client-bundle.mjs）而不是单跑 tsc。\n` +
    esm.map(([n, line]) => `  行${n}: ${line.trim()}`).join('\n'),
  )

  // ② 必须是 ModuleLoader 的 bundle（正向确认，防"编译成了别的东西"）
  assert.match(src, /__ModuleLoader__\.load\(/, 'lib/client.js 不是 ModuleLoader bundle')
})

/**
 * 反向保险：`src/client.ts` 自己**不该**有真的 import/export 语句。
 *
 * 后处理用的是"剥掉 tsc 补的那句 `export {};`"这种窄口径正则 —— 它能成立的前提是
 * **源文件里本来就没有真的 ESM 语法**（只有 `import type`，编译后会被擦掉）。
 * 哪天有人在 client.ts 里写了真的 `export const`，那句就剥不掉了，产物直接坏 ——
 * 而 fix-client-bundle.mjs 的验证会拦下（它 exit 1），这里再提前说一句，
 * 让报错落在**源文件**上而不是产物上。
 */
test('src/client.ts 不含真的 import/export（后处理只剥 tsc 补的标记）', () => {
  const src = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
  const esm = src
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /^\s*(import|export)\s+(?!type\b)/.test(line))
  assert.equal(
    esm.length,
    0,
    'src/client.ts 出现了真的 import/export —— 产物是浏览器 bundle（非 ESM），' +
    '后处理只剥 tsc 补的 `export {};`，剥不掉真语句。\n' +
    esm.map(([n, line]) => `  行${n}: ${line.trim()}`).join('\n'),
  )
})
