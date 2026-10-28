/**
 * The sheets that ship, in cascade order, each with the one layer class its selectors must lead
 * with. One list for every reader of the panel's styles: `build-client.mjs` joins it into the
 * artifact, `css-check.mjs` asks its questions over exactly these files in exactly this order —
 * a sheet not on this list does not ship, and a check run over any other set would answer
 * questions about a page that is never built.
 *
 * Order is load-bearing. The embedded sheet is a standalone document where it was drawn, and inside
 * the panel it competes with the main panel's sheets for the same element names (`.pf-row` in the
 * detail pane, the main panel's own `.pf-head`); it wins those by "same specificity, later in
 * order", so it follows the main panel's sheets here. The main panel's sheet order follows the layer
 * order a reader sees.
 */
export const SHEETS = [
  { sheet: 'tokens.css', root: '.pf-page' },
  { sheet: 'main.css', root: '.pf-page' },
  { sheet: 'map.css', root: '.pf-page' },
  { sheet: 'lines.css', root: '.pf-page' },
  { sheet: 'detail.css', root: '.pf-page' },
  { sheet: 'notes.css', root: '.pf-page' },
  { sheet: 'register.css', root: '.pf-issue' },
  { sheet: 'settings.css', root: '.pf-page' },
]
