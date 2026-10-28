// The panel's self-check fixture: real records → real host half → real panel, all three in one run.
// Every item prints its reading; any error on the console is a failure.
//
//   node tools/panel-check.mjs
//
// Layout: this entry carries the scene parameters, the check-section sequence and the summary
// report. The stages the checks stand on live in panel-check/fixtures.mjs (record scenes, host
// wiring, jsdom/React boot), the DOM drivers in panel-check/drivers.mjs, and the check sections
// themselves in panel-check/sections/ — one module per ---- banner.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { makeDrivers } from './panel-check/drivers.mjs'
import { startFixture } from './panel-check/fixtures.mjs'
import { runBootRegistry } from './panel-check/sections/boot-registry.mjs'
import { runConfigPane } from './panel-check/sections/config-pane.mjs'
import { runDetailAndRefuse } from './panel-check/sections/detail-refuse.mjs'
import { runIssuePane } from './panel-check/sections/issue-pane.mjs'
import { runLanguage } from './panel-check/sections/language.mjs'
import { runLifecycle } from './panel-check/sections/lifecycle.mjs'
import { runMapPane } from './panel-check/sections/map-pane.mjs'
import { runPickerAndTokens } from './panel-check/sections/picker-tokens.mjs'
import { runSettingsSection } from './panel-check/sections/settings-section.mjs'
import { runViews } from './panel-check/sections/views.mjs'
import { runWorkspaces } from './panel-check/sections/workspaces.mjs'

const failures = []
const lines = []
function check(what, ok, reading) {
  lines.push(`${ok ? 'ok  ' : 'FAIL'}  ${what}  ${reading}`)
  if (!ok) failures.push(what)
}

/* ---- The scene parameters: five workspaces, one session id each -------------------------- */

const SCENES = {
  /** First workspace: a writable copy of the record — the main pass reads and writes it. */
  main: { name: 'workspace', sessionId: 'panel-check-session' },
  /** Second workspace: empty, no `.pf` at all — the "current workspace has no pathfinder records" case. */
  empty: { name: 'empty', sessionId: 'panel-check-empty' },
  /** Third workspace: `.pf` and its four files exist, but none is readable JSON — the "records unreadable" case. */
  broken: { name: 'broken', sessionId: 'panel-check-broken' },
  /** Fourth workspace: the three pipeline files exist, the issue pool file does not — the "issue pane collapses to one line" case. */
  bare: { name: 'bare', sessionId: 'panel-check-bare' },
  /** Fifth workspace: issue pool only (what `pf issue scan` writes in a repo with no pipeline yet),
   * none of the three pipeline files — the "map collapses to one line" case. */
  poor: { name: 'poor', sessionId: 'panel-check-poor' },
}

/* The fixture: record copies, the real host half over them, jsdom + React and the built browser half. */
const fixture = await startFixture({ check, scenes: SCENES })
/* The DOM drivers over that fixture: one press, one type, one pick — each waiting the panel's read-back. */
const drivers = makeDrivers(fixture)
/* One shared bag the sections read and write: the fixture's stages, the drivers, the report's lines. */
const ctx = { ...fixture, ...drivers, check, lines }

/* ---- The check sections, in the order they print ----------------------------------------- */

await runBootRegistry(ctx)
await runViews(ctx)
await runWorkspaces(ctx)
await runPickerAndTokens(ctx)
await runSettingsSection(ctx)
await runMapPane(ctx)
await runIssuePane(ctx)
await runConfigPane(ctx)
await runDetailAndRefuse(ctx)
await runLifecycle(ctx)
await runLanguage(ctx)

/* ---- 7. Console ---------------------------------------------------------- */

check('控制台没有 error', ctx.consoleErrors.length === 0, ctx.consoleErrors.length === 0 ? '0 条' : ctx.consoleErrors.join(' | '))

/* ---- Readings to file ---------------------------------------------------- */

const report = lines.join('\n')
writeFileSync(join(fixture.work, 'panel-check.txt'), `${report}\n`)
console.log(report)
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${String(lines.filter((line) => line.startsWith('ok  ')).length)} passed, ${String(failures.length)} failed`)
process.exit(failures.length === 0 ? 0 : 1)
