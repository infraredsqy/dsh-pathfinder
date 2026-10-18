// 浏览器半身那一份产物的构建口。
//
// 三步，一步不少：
//   1. 把面板要的那几张样式表从 `mock/` 取出来——`mock/tokens.css` 这份共同地面，
//      加上它用到的模块表，次序就是蓝本 `<link>` 的次序。蓝本是唯一来源，这里不摆第二份抄本。
//   2. 用 rolldown 把 `src/client/index.ts` 捆成一份 CJS，`react` 留在外面。
//   3. 把那一段套进外壳要的那个壳：`window.__ModuleLoader__.load({ id, factory })`，
//      factory 里的 `require` 由外壳的模块表给（`react` 就在基线表上）。
//
// 样式在捆之前做一次作用域收拢：**只重写选择器，声明一个字节不动**。那几张表是照整页写的
// （`body`、`html`、`*`），面板在 DSH 里只占一格，整页的规矩不该由它来立。每张表收进哪一层
// 由下面的 `SHEETS` 定：主面板那六张收进 `.pf-page`，依赖与问题那两张收进 `.pf-pane.is-embed`
// （理由写在 `SHEETS` 旁边那一段）。收拢的规矩是：
//
//   - 落点在页面根上的那几条（`:root` / `html` / `body`）改成落在面板根自己身上
//     （`.pf-page`）——它们本来就写在页面根上，收拢后落到面板根上才等价。`body` 这一条
//     尤其不能丢：`mock/tokens.css` 的墨阶声明在 `body` 上是 load-bearing 的，`var()`
//     在声明所在的那一层求值。
//   - 全局那一条（`*`，连同它的两个伪元素）要**连面板根自己一起收**（`.pf-page,
//     .pf-page *` …）：`*` 在页面里连 `html` / `body` / `.pf-page` 一起管，只收成
//     `.pf-page *` 那一层，面板根自己就漏在外面——`mock/tokens.css` 的 `box-sizing`
//     reset 正写在它上面，而 `.pf-page` 是整块地界里唯一带内缩又拿 `height: 100%` 的盒。
//   - 别的一律加一层前缀（`.pf-page <选择器>`）；`html, body` 这种逗号列表逐段改完去重。
//   - 规则之间的注释只留在产物里，不进选择器：注释里那些逗号曾被当成选择器分隔符，
//     `:root` 也因此整段对不上而没被认出来——那两条令牌规则失去落点，就是这样来的。
//
// 改完再走一道自检（`assertRootLanding`）：页面根 / 全局那一批选择器收拢之后必须仍然
// 盖住面板根自己。收拢漏掉的声明在页面上不报错、只是不生效——`--pf-*` 令牌、`box-sizing`
// reset 都这么丢过——所以这一类在构建这一步就拦下来，不留到界面上看。
//
// 末尾还有一道（`assertScopedProduct`）：进包的每一条选择器都必须**打头**落在面板那一层
// 上。「这一段已经收过拢了」按**选择器段**认——切段之后逐段比，不看子串：名字以 `pf-page`
// 开头的类（`.pf-pagewrap`）不算，照样加前缀。认错的话那条规则会原样进包、落在页面根上管到
// DSH 的整个外壳，页面上不报错，所以真漏出去的那一条在这儿非零退出。
//
// 另有一处不在那六张表里：蓝本的主面板末位还挂着 `settings.css`——那一格的「设置」看法就是
// 这张表画的（舞台、框、设置那一列的版面），而同一张表里还住着另一页（h-settings）的规矩。
// 所以按 CARRIED 逐条取：主面板上真的生效的那几条，选择器一条一条明写在这儿，不取整张表，
// 也不在这里抄第二份。
//
//   node tools/build-client.mjs
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** 面板用到的模块表，次序就是 `<link>` 的次序，`scope` 是这张表收进哪一层。 */
const SHEETS = [
  { sheet: 'tokens.css', scope: '.pf-page' },
  { sheet: 'styles/main.css', scope: '.pf-page' },
  { sheet: 'styles/board.css', scope: '.pf-page' },
  { sheet: 'styles/lines.css', scope: '.pf-page' },
  { sheet: 'styles/detail.css', scope: '.pf-page' },
  { sheet: 'styles/notes.css', scope: '.pf-page' },
  /* 依赖与问题这两格在蓝本里各自是一份独立文档，靠 `.is-embed` 那几行把页头与页边距让给
     宿主。收进面板里它们是两个自带一块地界的格（`.pf-pane.is-embed`），所以这两张表收进
     `.is-embed` 那一层：两张表里都写着自己的 `.pf-head`，收进 `.pf-page` 会把主面板自己
     的页头一起改掉。 */
  { sheet: 'styles/field.css', scope: '.is-embed' },
  { sheet: 'styles/register.css', scope: '.is-embed' },
]

/** 蓝本那一页末位还挂着、但整张表不该进包的那几张：取它里面落在主面板 DOM 上的那几条。 */
const CARRIED = [{
  sheet: 'styles/settings.css',
  selectors: ['.pf-stage', '.pf-frame', '.pf-configwrap', '.pf-configwrap .pf-scroll', '.pf-config', '.pf-config .pf-setrow', '.pf-vlayer'],
}]

/** 主面板那一层。 */
const SCOPE = '.pf-page'

/** 进包的每一层：一道选择器落在哪一层上都算收拢过。 */
const SCOPES = [...new Set(SHEETS.map((entry) => entry.scope))]

/** 原本落在页面根上的那几条选择器：收拢后落到面板根自己身上。 */
const PAGE_SELECTORS = new Set([':root', 'html', 'body'])

/**
 * 那道尺子自己认的那一批：蓝本里写在页面自己那一层（`:root` / `html` / `body`）与全局
 * （`*`，两个伪元素在内）的选择器。
 *
 * 这一份与 `PAGE_SELECTORS` 是**两套**：上面那一套说的是「收拢时怎么改」，这一份说的是
 * 「哪些选择器本该落在页面那一层」。尺子照这一份认人——两套合成一套的话，从上面那一套里
 * 拿掉一条选择器，尺子会跟着不看它，这一道就拦不住了。
 */
const PAGE_LEVEL_SELECTORS = new Set([':root', 'html', 'body', '*', '*::before', '*::after'])

/** 里面还住着规则的那几种 at-rule：收拢要往里走一层。 */
const NESTING_AT_RULES = ['@media', '@supports', '@layer']

/** 把一段文本里的注释摘掉——注释不进选择器，它们另有去处。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//gu, ' ')
}

/** 一段文本里的注释，按原来的次序拼起来（产物里照样读得到）。 */
function comments(text) {
  return text.match(/\/\*[\s\S]*?\*\//gu)?.join('\n') ?? ''
}

/** 与 `open` 那个 `{` 配对的那个 `}` 落在哪儿。 */
function closingBrace(css, open) {
  let depth = 1
  let k = open + 1
  while (k < css.length && depth > 0) {
    if (css[k] === '{') depth += 1
    else if (css[k] === '}') depth -= 1
    if (depth === 0) break
    k += 1
  }
  return k
}

/**
 * 走一张表，把每条规则的选择器交给 `rewrite`。
 * @param css - 表身。
 * @param rewrite - 收到这条规则的选择器，返回改写后的那一串；返回 `null` 就把这条丢掉。
 * @returns 改写后的表身。
 */
function mapRules(css, rewrite) {
  let out = ''
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open < 0) {
      out += css.slice(i)
      break
    }
    const raw = css.slice(i, open)
    const close = closingBrace(css, open)
    const body = css.slice(open + 1, close)
    const prelude = stripComments(raw).trim()
    if (NESTING_AT_RULES.some((rule) => prelude.startsWith(rule))) {
      const inner = mapRules(body, rewrite)
      if (stripComments(inner).trim().length > 0) out += `${comments(raw)}${prelude}{${inner}}`
    } else if (prelude.startsWith('@')) {
      /* @keyframes / @font-face：整块原样带走，里面没有选择器可收拢。 */
      out += css.slice(i, close + 1)
    } else if (prelude.length > 0) {
      const scoped = rewrite(prelude)
      if (scoped !== null) out += `${comments(raw)}${scoped}{${body}}`
    } else {
      /* 只有注释的一截：原样留着。 */
      out += css.slice(i, close + 1)
    }
    i = close + 1
  }
  return out
}

/**
 * 这一段选择器里有没有面板根那枚类名——**切段之后逐段比，不看子串**：先按组合子切开，
 * 每段再按 `.` / `#` / `:` / `[` 切出记号，整枚记号等于 `pf-page` 才算数。
 *
 * 子串那一版（`part.includes('.pf-page')`）会把 `.pf-pagewrap`、`.pf-pagefoot` 这类名字
 * 认成「已经在面板那一层里了」，那条规则整条漏出去落在页面根上——正是这个文件开头说不该
 * 发生的事；而这些名字切出来的记号是 `pf-pagewrap`，与 `pf-page` 不等，照样加前缀。
 *
 * @param part - 逗号列表里的一段选择器。
 * @param className - 面板根那枚类名（不带点）。
 */
function hasScopeClass(part, className) {
  return part
    .split(/[\s>+~]+/u)
    .flatMap((segment) => segment.split(/[.#:[\]]/u))
    .some((token) => token === className)
}

/**
 * 一条选择器收进面板那一层：页面根那几条落到面板根自己身上，`*` 连同面板根一起收，
 * 其余加一层前缀。
 * @param part - 逗号列表里的一段选择器。
 * @param prefix - 面板根那一层。
 * @returns 收拢后的那几段（`*` 这类要拆成两段：面板根自己 + 后代）。
 */
function scopeSelector(part, prefix) {
  if (hasScopeClass(part, prefix.slice(1))) return [part]
  if (PAGE_SELECTORS.has(part.toLowerCase())) return [prefix]
  if (part === '*') return [prefix, `${prefix} *`]
  if (part.startsWith('*::')) return [`${prefix}${part.slice(1)}`, `${prefix} ${part}`]
  return [`${prefix} ${part}`]
}

/** 一整串选择器（逗号列表）收拢，重复的只留一条。 */
function scopePrelude(prelude, prefix) {
  const parts = prelude
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .flatMap((part) => scopeSelector(part, prefix))
  return [...new Set(parts)].join(', ')
}

/**
 * 那道尺子：蓝本里固定在页面根（`:root` / `html` / `body`）与全局（`*` / `*::before` /
 * `*::after`）上的声明，收拢之后必须仍然落在面板根自己身上——页面根那几条落在
 * `.pf-page`，`*` 那几条落在 `.pf-page` 与它的两个伪元素上。
 *
 * 收拢漏掉的声明不报错、只是不生效，界面上一眼看不出（`--pf-*` 令牌与 `box-sizing`
 * reset 都是这么丢的），所以在构建这一步把这一批点出来。
 *
 * @param name - 表名，报错时报得出是哪一份。
 * @param css - 表身，收拢前。
 * @param prefix - 面板根那一层。
 * @returns 落空的那些（选择器 + 收拢后长什么样）；一条都没有就是空清单。
 */
function assertRootLanding(name, css, prefix) {
  const stray = []
  mapRules(css, (prelude) => {
    for (const part of prelude.split(',').map((one) => one.trim()).filter((one) => one.length > 0)) {
      const low = part.toLowerCase()
      if (!PAGE_LEVEL_SELECTORS.has(low)) continue
      const scoped = scopeSelector(part, prefix)
      const wanted = low.startsWith('*') ? `${prefix}${low.slice(1)}` : prefix
      if (!scoped.includes(wanted)) stray.push(`${name}: ${part} → ${scoped.join(', ')}`)
    }
    return prelude
  })
  return stray
}

/** 把一张表按面板那一层收拢。 */
function scopeSheet(css, prefix) {
  return mapRules(css, (prelude) => scopePrelude(prelude, prefix))
}

/**
 * 第二道尺子（管产物的形状）：进包的每一条选择器都必须**打头**落在面板那一层上——
 * 一条选择器的第一段里要真有一枚独立的面板根类名。
 *
 * 上面那道管的是「页面根 / 全局那一批收拢后还盖不盖得住面板根自己」，它认人凭的是
 * `PAGE_LEVEL_SELECTORS` 那六个整段相等的选择器；前缀写错、或者一段没被认出来
 * （`.pf-pagewrap` 这类名字里带面板根的类），不在它眼皮底下。收拢漏掉的规矩在页面上
 * 不报错、只是管到了 DSH 的外壳，所以在这一步把整条选择器点出来。
 *
 * @param css - 收拢之后的表身。
 * @param prefixes - 进包的每一层。
 * @returns 没有打头落在任何一层上的那些选择器；一条都没有就是空清单。
 */
function assertScopedProduct(css, prefixes) {
  const classes = prefixes.map((prefix) => prefix.slice(1))
  const leaked = []
  mapRules(css, (prelude) => {
    for (const part of prelude.split(',').map((one) => one.trim()).filter((one) => one.length > 0)) {
      const head = part.split(/[\s>+~]+/u)[0]
      if (!classes.some((className) => hasScopeClass(head, className))) leaked.push(part)
    }
    return prelude
  })
  return [...new Set(leaked)]
}

/** 从一张表里按选择器拣出规则（选择器原样挑出来，收拢另说）。 */
function pickRules(css, selectors) {
  const wanted = new Set(selectors)
  return mapRules(css, (prelude) => {
    const kept = prelude
      .split(',')
      .map((part) => part.trim())
      .filter((part) => wanted.has(part))
    return kept.length > 0 ? [...new Set(kept)].join(', ') : null
  })
}

const sources = SHEETS.map(({ sheet, scope }) => ({ sheet, scope, css: readFileSync(join(root, 'mock', sheet), 'utf8') }))
const strayed = sources.flatMap(({ sheet, css, scope }) => assertRootLanding(sheet, css, scope))
if (strayed.length > 0) {
  throw new Error(`build-client: 收拢之后有声明落不到面板根上（页面根 / 全局那一批）：\n  ${strayed.join('\n  ')}`)
}
const sheets = sources.map(({ css, scope }) => scopeSheet(css, scope))
/* 蓝本末位那张表的共享两条：它们在蓝本的主面板上真的生效，次序也照蓝本摆在最后。 */
const carried = CARRIED.map(({ sheet, selectors }) =>
  scopeSheet(pickRules(readFileSync(join(root, 'mock', sheet), 'utf8'), selectors), SCOPE))
const css = [...sheets, ...carried].filter((part) => part.trim().length > 0).join('\n')
const leaked = assertScopedProduct(css, [...SCOPES, SCOPE])
if (leaked.length > 0) {
  throw new Error(`build-client: 产物里有选择器没落在面板那一层上（收拢漏了）：\n  ${leaked.join('\n  ')}`)
}

const bundle = await rolldown({
  input: join(root, 'src/client/index.ts'),
  platform: 'browser',
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'],
  },
  external: ['react'],
  plugins: [
    {
      name: 'pathfinder-styles',
      resolveId(source) {
        return source === 'virtual:pf-styles' ? source : null
      },
      load(id) {
        return id === 'virtual:pf-styles' ? `export default ${JSON.stringify(css)}` : null
      },
    },
  ],
})

await bundle.write({
  format: 'cjs',
  exports: 'named',
  sourcemap: false,
  file: join(root, 'lib/client-body.js'),
})
await bundle.close()

const body = readFileSync(join(root, 'lib/client-body.js'), 'utf8')
if (body.includes('__ModuleLoader__')) throw new Error('build-client: the bundle already carries the loader shell')

const head = `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {\n`
  + 'var module = { exports: {} }; var exports = module.exports;\n'
const tail = '\nreturn module.exports; } });\n'
writeFileSync(join(root, 'lib/client.js'), head + body + tail)
// 中间件当场删掉，它只在上面那一步有用。留着的话 `files` 里那条 `lib/**/*.js` 会把它
// 一起收进包——外壳套完的那一份已经在 lib/client.js 里，它纯属第二份。
rmSync(join(root, 'lib/client-body.js'))
console.log(`build-client: lib/client.js written (${String(head.length + body.length + tail.length)} chars, ${String(css.length)} chars of css)`)