// Build entry for the browser half's artifact: pull the sheets the panel needs from the mock
// blueprint, scope the selectors, then bundle into `lib/client.js` for the shell.
// Scoping rewrites selectors only — not one declaration byte changes: the sheets are written for
// whole pages (`body`, `html`, `*`), while the panel occupies a single cell in DSH.
// Comments between rules stay in the artifact and never enter the selector pass: commas inside a
// comment would be parsed as selector separators, so a `:root` block would fail to match as a whole.
//
//   node tools/build-client.mjs
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * A scoping layer: what prefix to add (`add`), where page-root rules land (`root`), and what the
 * sheet's own "embed" marker becomes (`marker`).
 *
 * The main panel layer only adds a prefix. The wires and issue sheets carry two extras, because in
 * the mock they are **two standalone documents** that each become one cell under the same tree:
 *
 * - The prefix is that cell's page marker (`.pf-wires` / `.pf-issue`), without `:where()`: in the
 *   mock each sheet is the only sheet in its document, but inside the panel it competes with the
 *   panel's own sheets for the same elements (`.pf-row` in the detail pane and the main panel's
 *   `.pf-head` share the names). It wins by "same specificity, later in order" — this sheet sits
 *   last. A bare prefix would drop specificity a notch and those same-named rules would overtake it.
 * - The sheet's own yield rules (`.is-embed X`) get bumped one notch, written as `.is-embed.pf-issue X`:
 *   the mock writes them to sit "one notch above the base rule"; lose that notch and the top padding returns.
 * - Each sheet carries its own marker, never shared: a shared marker would let one sheet's rules
 *   land on the other cell (the issue pool's `padding: 0` would override the wires page's bottom margin).
 *
 * The marker sits on the two `.pf-pane` elements, the same spot as each mock document's `is-embed`:
 * the `.is-embed` class stays, the page marker follows it.
 */
const pageLayer = (root) => ({ root, add: root })
const embedLayer = (root) => ({ root, add: root, marker: 'is-embed' })

/** Order mirrors the mock's `<link>` order. */
const SHEETS = [
  { sheet: 'tokens.css', scope: pageLayer('.pf-page') },
  { sheet: 'styles/main.css', scope: pageLayer('.pf-page') },
  { sheet: 'styles/board.css', scope: pageLayer('.pf-page') },
  { sheet: 'styles/lines.css', scope: pageLayer('.pf-page') },
  { sheet: 'styles/detail.css', scope: pageLayer('.pf-page') },
  { sheet: 'styles/notes.css', scope: pageLayer('.pf-page') },
  /* Both sheets define their own `.pf-head`; scoping them into `.pf-page` would restyle the main
     panel's own header too. In the mock each is a standalone document that yields header and page
     margins via `.is-embed`. */
  { sheet: 'styles/field.css', scope: embedLayer('.pf-wires') },
  { sheet: 'styles/register.css', scope: embedLayer('.pf-issue') },
]

/** Linked last in the mock, but the sheet itself must not ship: only the rules landing on the main panel DOM are taken. */
const CARRIED = [{
  sheet: 'styles/settings.css',
  selectors: ['.pf-stage', '.pf-frame', '.pf-configwrap', '.pf-configwrap .pf-scroll', '.pf-config', '.pf-config .pf-setrow', '.pf-vlayer'],
}]

const SCOPE = pageLayer('.pf-page')

/** Every layer that ships: a selector landing on any of them counts as scoped. */
const SCOPES = [...new Map(SHEETS.map((entry) => [entry.scope.root, entry.scope])).values()]

const PAGE_SELECTORS = new Set([':root', 'html', 'body'])

/**
 * What the ruler itself recognizes: selectors written at page level (`:root` / `html` / `body`) and
 * globally (`*`, its two pseudo-elements included) in the mock. Kept separate from `PAGE_SELECTORS` —
 * that set says "how to rewrite while scoping", this one says "which selectors belong at page
 * level". Merged into one, removing a selector from the former would make the ruler skip it too,
 * and this check could no longer catch it.
 */
const PAGE_LEVEL_SELECTORS = new Set([':root', 'html', 'body', '*', '*::before', '*::after'])

/** At-rules that contain rules: scoping descends one level into them. */
const NESTING_AT_RULES = ['@media', '@supports', '@layer']

/** Comments never enter selectors; they are handled separately. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//gu, ' ')
}

/** These comments stay readable in the artifact. */
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
 * Walk one sheet, handing each rule's selectors to `rewrite`.
 * @param rewrite - Receives a rule's selectors, returns the rewritten string; returning `null` drops the rule.
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
      /* @keyframes / @font-face: carried through as-is; no selectors inside to scope. */
      out += css.slice(i, close + 1)
    } else if (prelude.length > 0) {
      const scoped = rewrite(prelude)
      if (scoped !== null) out += `${comments(raw)}${scoped}{${body}}`
    } else {
      /* Comment-only segment: kept as-is. */
      out += css.slice(i, close + 1)
    }
    i = close + 1
  }
  return out
}

/**
 * Whether this selector segment carries the layer's class — compared per token, not by substring:
 * split on combinators first, then split each segment on `.` / `#` / `:` / `[` into tokens; only a
 * whole token equal to `pf-page` counts.
 *
 * A substring version (`part.includes('.pf-page')`) would treat names like `.pf-pagewrap` and
 * `.pf-pagefoot` as "already inside the panel layer", letting the whole rule escape onto the page
 * root; their tokens are `pf-pagewrap` and the like, unequal to `pf-page`, so the prefix still applies.
 */
function hasScopeClass(part, className) {
  return part
    .split(/[\s>+~]+/u)
    .flatMap((segment) => segment.split(/[.#:[\]]/u))
    .some((token) => token === className)
}

/** The sheet's own "embed" marker (`.is-embed`) is matched as a whole class name; names like `pf-embedx` do not count. */
function markerPattern(marker) {
  return new RegExp(`\\.${marker}(?![\\w-])`, 'gu')
}

/**
 * @param scope - The layer (see `pageLayer` / `embedLayer`).
 * @returns The scoped segments (`*` splits in two: the layer itself + descendants).
 */
function scopeSelector(part, scope) {
  /* Rules carrying the sheet's own "embed" marker: rewritten to "this marker + this cell's page
     marker" — the mock relies on it sitting one notch above the base rule; two classes restore
     that notch while landing only on this cell. */
  if (scope.marker !== undefined && hasScopeClass(part, scope.marker)) {
    return [part.replace(markerPattern(scope.marker), `.${scope.marker}${scope.root}`)]
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
 * The first ruler: declarations pinned to the page root and globals in the mock must still land on
 * the layer's root itself after scoping — page-root rules land on `root`, `*` rules land on `root`
 * and its two pseudo-elements.
 *
 * A declaration missed by scoping fails silently and is invisible in the UI (that is how `--pf-*`
 * tokens and the `box-sizing` reset were lost), so this step flags the batch at build time.
 *
 * @param name - Sheet name, so failures report which sheet.
 * @param css - Sheet body, before scoping.
 * @param scope - The layer (see `pageLayer` / `embedLayer`).
 * @returns The misses (selector + what it looks like after scoping); empty list if none.
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
 * The second ruler (product shape): every selector that ships must lead with a layer — the first
 * segment of a selector must genuinely carry one of the layer class names.
 *
 * The first ruler covers "do the page-root / global batch still cover this layer's root after
 * scoping", matching on the six whole-segment selectors in `PAGE_LEVEL_SELECTORS`; a wrong prefix,
 * or a segment it fails to recognize (classes like `.pf-pagewrap` that embed the panel root's
 * name), escapes it. Rules missed by scoping fail silently on the page while styling DSH's shell,
 * so this step flags the whole selector.
 *
 * @param css - Sheet body after scoping.
 * @param scopes - Every layer that ships.
 * @returns Selectors leading with no layer; empty list if none.
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
/* The two shared rules from the mock's last sheet: they genuinely apply on the mock's main panel, and keep the mock's last position in the order. */
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
// The intermediate artifact is deleted on the spot; only the step above uses it. If kept, the
// `lib/**/*.js` entry in `files` would bundle it too — the shell-wrapped copy already lives in
// lib/client.js and this would be a pure duplicate.
rmSync(join(root, 'lib/client-body.js'))
console.log(`build-client: lib/client.js written (${String(head.length + body.length + tail.length)} chars, ${String(css.length)} chars of css)`)