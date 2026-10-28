/**
 * The one CSS rule walk both tools share: comment stripping, brace balancing and the at-rule
 * descent each live here once, so the two readers of the panel's sheets cannot grow two
 * grammars. What a caller does with each block stays the caller's business.
 */

/** Comments never enter selectors; they are stripped, keeping the separation they drew. */
export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//gu, ' ')
}

/**
 * The index of the `}` that closes the `{` at `open`, braces inside balanced. Throws when the
 * sheet never balances — a truncated sheet read as one giant rule would say nothing true.
 */
export function closingBrace(css, open) {
  let depth = 1
  let k = open + 1
  while (k < css.length) {
    if (css[k] === '{') depth += 1
    else if (css[k] === '}') {
      depth -= 1
      if (depth === 0) return k
    }
    k += 1
  }
  throw new Error('cssrules: unbalanced braces')
}

/** At-rules that contain style rules: what the `'containers'` strategy descends into. */
export const NESTING_AT_RULES = ['@media', '@supports', '@layer']

/**
 * Every block of one sheet, in source order, flattened across the at-rules the descent
 * strategy walks into.
 *
 * `descend` picks the strategy, per at-rule prelude:
 *   - `'containers'` (default) — only the container at-rules (`@media`, `@supports`,
 *     `@layer`) are descended into; every other at-rule (`@keyframes`, `@font-face`) is
 *     carried through whole. build-client's layer ruler reads here.
 *   - `'all'` — every at-rule's body is walked into, `@keyframes` steps included; a rule
 *     inside any of them reports the nearest container prelude as `at`. css-check reads here.
 *
 * Kinds: `'rule'` is a plain rule — `prelude` stripped of comments and trimmed, `body` the
 * raw text between its braces, `at` the nearest container it sits under (`''` at the top
 * level); `'whole'` is a block carried through verbatim from `start` to `end` (a
 * non-descended at-rule, or a segment holding nothing but a comment); `'text'` is whatever
 * trails the last block; `'open'` / `'close'` bracket a descended container, `raw` carrying
 * the comments around its prelude.
 *
 * @param {{ descend?: 'containers' | 'all' }} [options]
 */
export function cssBlocks(css, { descend = 'containers' } = {}) {
  const blocks = []
  const walk = (text, at) => {
    let i = 0
    while (i < text.length) {
      const open = text.indexOf('{', i)
      if (open < 0) {
        blocks.push({ kind: 'text', text: text.slice(i) })
        break
      }
      const raw = text.slice(i, open)
      const close = closingBrace(text, open)
      const body = text.slice(open + 1, close)
      const prelude = stripComments(raw).trim()
      const container = descend === 'all' || NESTING_AT_RULES.some((rule) => prelude.startsWith(rule))
      if (prelude.startsWith('@') && container) {
        blocks.push({ kind: 'open', prelude, raw, at })
        walk(body, prelude)
        blocks.push({ kind: 'close' })
      } else if (prelude.startsWith('@') || prelude.length === 0) {
        /* @keyframes / @font-face / a comment-only segment: carried through verbatim. */
        blocks.push({ kind: 'whole', prelude, raw, body, start: i, end: close + 1 })
      } else {
        blocks.push({ kind: 'rule', prelude, raw, body, at })
      }
      i = close + 1
    }
  }
  walk(css, '')
  return blocks
}
