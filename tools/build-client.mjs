// Build entry for the browser half's artifact: join the panel's stylesheets and bundle them with
// its React half into `lib/client.js` for the shell.
//
//   node tools/build-client.mjs
//
// The sheets in `src/client/styles/` are written in the shape they ship in: every selector already
// leads with its cell's layer class (`.pf-page` on the main panel, `.pf-wires` / `.pf-issue` on the
// two embedded panes). That is what this entry used to rewrite at build time, and the reason it had
// to: a sheet written for a document of its own carries `body { overflow: hidden }`, `:root` tokens
// and a `*` reset, none of which belong on DSH's document — the `overflow` alone would hide the
// shell. The rewrite happened once, when the sheets moved in here; the source is now the artifact,
// so all this entry does with styles is read nine files in order and join them.
//
// One check stays at build time: a selector that escapes its layer lands on the host page, fails
// silently inside the panel, and can break DSH's own shell. A leak stops the build.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const STYLES = join(root, 'src', 'client', 'styles')

/**
 * The sheets that ship, in cascade order, each with the one layer class its selectors must lead
 * with.
 *
 * Order is load-bearing. The two embedded sheets are standalone documents where they were drawn,
 * and inside the panel they compete with the main panel's sheets for the same element names
 * (`.pf-row` in the detail pane, the main panel's own `.pf-head`); they win those by "same
 * specificity, later in order", so they follow the main panel's sheets here. The main panel's
 * sheet order follows the layer order a reader sees.
 */
const SHEETS = [
  { sheet: 'tokens.css', root: '.pf-page' },
  { sheet: 'main.css', root: '.pf-page' },
  { sheet: 'board.css', root: '.pf-page' },
  { sheet: 'lines.css', root: '.pf-page' },
  { sheet: 'detail.css', root: '.pf-page' },
  { sheet: 'notes.css', root: '.pf-page' },
  { sheet: 'field.css', root: '.pf-wires' },
  { sheet: 'register.css', root: '.pf-issue' },
  { sheet: 'settings.css', root: '.pf-page' },
]

/** At-rules that contain rules: the selector walk descends one level into them. */
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
 * root; their tokens are `pf-pagewrap` and the like, unequal to `pf-page`, so the leak is caught.
 */
function hasScopeClass(part, className) {
  return part
    .split(/[\s>+~]+/u)
    .flatMap((segment) => segment.split(/[.#:[\]]/u))
    .some((token) => token === className)
}

/**
 * The layer ruler: every selector that ships must lead with one of the layer classes — the first
 * segment of a selector must genuinely carry it.
 *
 * A wrong prefix, or a segment the split fails to recognize (classes like `.pf-pagewrap` that embed
 * the panel root's name), escapes it. Rules that miss their layer fail silently on the page while
 * styling DSH's shell, so this step stops the build instead.
 *
 * @param css - The joined sheet body.
 * @param roots - Every layer class that ships (`.pf-page`, `.pf-wires`, `.pf-issue`).
 * @returns Selectors leading with no layer; empty list if none.
 */
function assertScopedProduct(css, roots) {
  const classes = roots.map((root) => root.replace(/^\./u, ''))
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

const css = SHEETS
  .map(({ sheet }) => readFileSync(join(STYLES, sheet), 'utf8'))
  .filter((part) => part.trim().length > 0)
  .join('\n')
const leaked = assertScopedProduct(css, [...new Set(SHEETS.map(({ root }) => root))])
if (leaked.length > 0) {
  throw new Error(`build-client: 产物里有选择器没落在面板那一层上（逃到宿主页面去了）：\n  ${leaked.join('\n  ')}`)
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