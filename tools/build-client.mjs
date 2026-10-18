// 浏览器半身那一份产物的构建口：按蓝本取出面板要的样式表、收拢选择器，再捆成外壳认得的 `lib/client.js`。
// 收拢只重写选择器、声明一个字节不动——那几张表是照整页写的（`body`、`html`、`*`），面板在 DSH 里只占一格。
// 规则之间的注释留在产物里、不进选择器：注释里的逗号会被当成选择器分隔符，`:root` 因此整段对不上而没被认出来。
//
//   node tools/build-client.mjs
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * 收拢的那一层：加什么前缀（`add`）、页面根那几条落在谁身上（`root`）、表里那枚「嵌入」记号
 * 换成谁（`marker`）。
 *
 * 主面板那一层只加前缀。依赖与问题那两张表多两件事，都因为蓝本里它们是**两份独立文档**、
 * 进了面板却是同一棵树下的一格：
 *
 * - 前缀走 `:where()`：蓝本那些「嵌入时让位」的规矩是靠比基础规则高一档特异性取胜的
 *   （`.is-embed .pf-band` 压 `.pf-band`）。前缀要是直接写类名，两边被拉成同一档，胜负改成
 *   按源次序，而基础规则恰好写在让位规则后面——顶上就多出一截留白。
 * - 两张表各挂各的记号，不共用一枚：共用的话一张表的规矩会落在另一格上（问题池那个
 *   `padding: 0` 会盖掉依赖那页的下边距）。
 *
 * 记号挂在面板里那两个 `.pf-pane` 上，与蓝本各文档的 `is-embed` 是同一个位置。
 */
const pageLayer = (root) => ({ root, add: root })
const embedLayer = (root) => ({ root, add: `:where(${root})`, marker: 'is-embed' })

/** 次序就是蓝本 `<link>` 的次序。 */
const SHEETS = [
  { sheet: 'tokens.css', scope: pageLayer('.pf-page') },
  { sheet: 'styles/main.css', scope: pageLayer('.pf-page') },
  { sheet: 'styles/board.css', scope: pageLayer('.pf-page') },
  { sheet: 'styles/lines.css', scope: pageLayer('.pf-page') },
  { sheet: 'styles/detail.css', scope: pageLayer('.pf-page') },
  { sheet: 'styles/notes.css', scope: pageLayer('.pf-page') },
  /* 这两张表里都写着自己的 `.pf-head`，收进 `.pf-page` 会把主面板自己的页头一起改掉；
     它们在蓝本里各自是一份独立文档，靠 `.is-embed` 让出页头与页边距。 */
  { sheet: 'styles/field.css', scope: embedLayer('.pf-wires') },
  { sheet: 'styles/register.css', scope: embedLayer('.pf-issue') },
]

/** 蓝本末位挂着、但整张表不该进包：只取落在主面板 DOM 上的那几条。 */
const CARRIED = [{
  sheet: 'styles/settings.css',
  selectors: ['.pf-stage', '.pf-frame', '.pf-configwrap', '.pf-configwrap .pf-scroll', '.pf-config', '.pf-config .pf-setrow', '.pf-vlayer'],
}]

const SCOPE = pageLayer('.pf-page')

/** 进包的每一层：一道选择器落在哪一层上都算收拢过。 */
const SCOPES = [...new Map(SHEETS.map((entry) => [entry.scope.root, entry.scope])).values()]

const PAGE_SELECTORS = new Set([':root', 'html', 'body'])

/**
 * 那道尺子自己认的那一批：蓝本里写在页面自己那一层（`:root` / `html` / `body`）与全局
 * （`*`，两个伪元素在内）的选择器。它与 `PAGE_SELECTORS` 是两套——上面那一套说的是「收拢
 * 时怎么改」，这一份说的是「哪些选择器本该落在页面那一层」。两套合成一套的话，从上面那一套
 * 里拿掉一条选择器，尺子会跟着不看它，这一道就拦不住了。
 */
const PAGE_LEVEL_SELECTORS = new Set([':root', 'html', 'body', '*', '*::before', '*::after'])

/** 里面还住着规则的那几种 at-rule：收拢要往里走一层。 */
const NESTING_AT_RULES = ['@media', '@supports', '@layer']

/** 注释不进选择器，它们另有去处。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//gu, ' ')
}

/** 产物里照样读得到这些注释。 */
function comments(text) {
  return text.match(/\/\*[\s\S]*?\*\//gu)?.join('\n') ?? ''
}

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
 * 这一段选择器里有没有这一层那枚类名——切段之后逐段比，不看子串：先按组合子切开，
 * 每段再按 `.` / `#` / `:` / `[` 与括号切出记号，整枚记号等于 `pf-page` 才算数。括号也要切，
 * 是因为前缀有一种写法是函数伪类（`:where(.pf-wires)`），里面的类名得单独成枚才认得出。
 *
 * 子串那一版（`part.includes('.pf-page')`）会把 `.pf-pagewrap`、`.pf-pagefoot` 这类名字
 * 认成「已经在面板那一层里了」，那条规则整条漏出去落在页面根上；这些名字切出来的记号是
 * `pf-pagewrap`，与 `pf-page` 不等，照样加前缀。
 *
 * @param part - 逗号列表里的一段选择器。
 * @param className - 这一层那枚类名（不带点）。
 */
function hasScopeClass(part, className) {
  return part
    .split(/[\s>+~]+/u)
    .flatMap((segment) => segment.split(/[.#:()[\]]/u))
    .some((token) => token === className)
}

/** 表里那枚「嵌入」记号（`.is-embed`）按整枚类名认，`pf-embedx` 这类名字不算。 */
function markerPattern(marker) {
  return new RegExp(`\\.${marker}(?![\\w-])`, 'gu')
}

/**
 * @param part - 逗号列表里的一段选择器。
 * @param scope - 这一层（见 `pageLayer` / `embedLayer`）。
 * @returns 收拢后的那几段（`*` 这类要拆成两段：这一层自己 + 后代）。
 */
function scopeSelector(part, scope) {
  /* 表里自己写着「嵌入」那枚记号的规矩，换成这一层的页面记号：它比基础规则高一档的地位
     正是蓝本写这两行时借的东西，换成 `add`（带 `:where()` 的那一版）就没有了。 */
  if (scope.marker !== undefined && hasScopeClass(part, scope.marker)) {
    return [part.replace(markerPattern(scope.marker), scope.root)]
  }
  if (hasScopeClass(part, scope.root.slice(1))) return [part]
  if (PAGE_SELECTORS.has(part.toLowerCase())) return [scope.root]
  if (part === '*') return [scope.root, `${scope.root} *`]
  if (part.startsWith('*::')) return [`${scope.root}${part.slice(1)}`, `${scope.root} ${part}`]
  return [`${scope.add} ${part}`]
}

function scopePrelude(prelude, scope) {
  const parts = prelude
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .flatMap((part) => scopeSelector(part, scope))
  return [...new Set(parts)].join(', ')
}

/**
 * 那道尺子：蓝本里固定在页面根与全局上的声明，收拢之后必须仍然落在这一层的根自己身上——
 * 页面根那几条落在 `root`，`*` 那几条落在 `root` 与它的两个伪元素上。
 *
 * 收拢漏掉的声明不报错、只是不生效，界面上一眼看不出（`--pf-*` 令牌与 `box-sizing`
 * reset 都是这么丢的），所以在构建这一步把这一批点出来。
 *
 * @param name - 表名，报错时报得出是哪一份。
 * @param css - 表身，收拢前。
 * @param scope - 这一层（见 `pageLayer` / `embedLayer`）。
 * @returns 落空的那些（选择器 + 收拢后长什么样）；一条都没有就是空清单。
 */
function assertRootLanding(name, css, scope) {
  const stray = []
  mapRules(css, (prelude) => {
    for (const part of prelude.split(',').map((one) => one.trim()).filter((one) => one.length > 0)) {
      const low = part.toLowerCase()
      if (!PAGE_LEVEL_SELECTORS.has(low)) continue
      const scoped = scopeSelector(part, scope)
      const wanted = low.startsWith('*') ? `${scope.root}${low.slice(1)}` : scope.root
      if (!scoped.includes(wanted)) stray.push(`${name}: ${part} → ${scoped.join(', ')}`)
    }
    return prelude
  })
  return stray
}

function scopeSheet(css, scope) {
  return mapRules(css, (prelude) => scopePrelude(prelude, scope))
}

/**
 * 第二道尺子（管产物的形状）：进包的每一条选择器都必须打头落在某一层上——一条选择器的
 * 第一段里要真有一枚独立的层类名。
 *
 * 上面那道管的是「页面根 / 全局那一批收拢后还盖不盖得住这一层的根自己」，它认人凭的是
 * `PAGE_LEVEL_SELECTORS` 那六个整段相等的选择器；前缀写错、或者一段没被认出来
 * （`.pf-pagewrap` 这类名字里带面板根的类），不在它眼皮底下。收拢漏掉的规矩在页面上不报错、
 * 只是管到了 DSH 的外壳，所以在这一步把整条选择器点出来。
 *
 * @param css - 收拢之后的表身。
 * @param scopes - 进包的每一层。
 * @returns 没有打头落在任何一层上的那些选择器；一条都没有就是空清单。
 */
function assertScopedProduct(css, scopes) {
  const classes = scopes.map((scope) => scope.root.slice(1))
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