#!/usr/bin/env node
/* Regenerate mock/issues.js from a real .pf ledger.
 *
 * The other half of the record. `ledger.js` holds the work; this holds the debt:
 * the issue register (.pf/issues/issues.json), the policy line the pool is
 * measured against, and the readings the pipeline itself took of that measure at
 * each node's closing beat.
 *
 * Nothing here is invented and nothing is reworded: a case's title, evidence,
 * recommendation and disposition are the record's own sentences, verbatim.
 *
 * Two of the three facts the page needs are not stored as plain fields, so they
 * are read out of the record where the record does state them:
 *
 *   line     issue_pool_weight_limit, a policy on one of the cycles
 *   weights  "P3/P2/P1/P0 = 1/2/4/8", written into the spec the maintenance
 *            channel generated; the tool has no config field for it
 *
 *   issue     id, title, severity, status, module, source, decision,
 *             discovered, updated_at, check_count, files[],
 *             description, suggestion, reason, plan_path
 *   reading   the metric at one node's closing beat: at, value, cycle, node, title
 *   maint     a maintenance run against this pool: id, title, created, completed
 *
 * Only the cut that turns a register into a state is invented, and it lives in
 * data.js with every other reading of a moment.
 *
 *   node tools/gen-issues.mjs [--ledger <path to .pf>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'mock', 'issues.js');

const argv = process.argv.slice(2);
const at = argv.indexOf('--ledger');
const LEDGER =
  at >= 0
    ? argv[at + 1]
    : path.join(HERE, '..', '..', '.pf');

const read = (p) => JSON.parse(fs.readFileSync(path.join(LEDGER, p), 'utf8'));
const state = read('state.json');
const ideas = read('ideas.json').nodes;
const raw = read(path.join('issues', 'issues.json')).issues;

// ---- the line the pool is measured against --------------------------------
// A policy, not a constant: it is written on the cycle that owns the pool.
const limits = state.cycles
  .map((c) => c.policies && c.policies.issue_pool_weight_limit)
  .filter((n) => typeof n === 'number');
if (!limits.length) throw new Error('no cycle policy carries issue_pool_weight_limit');
const LINE = limits[0];

// ---- the weight map -------------------------------------------------------
// Stated verbatim in the spec the maintenance channel generated for the pool.
let WEIGHTS = null;
for (const n of Object.values(ideas)) {
  const m = `${n.title || ''} ${n.description || ''}`.match(
    /P3\s*\/\s*P2\s*\/\s*P1\s*\/\s*P0\s*=\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/
  );
  if (m) {
    WEIGHTS = { P3: +m[1], P2: +m[2], P1: +m[3], P0: +m[4] };
    break;
  }
}
if (!WEIGHTS) throw new Error('nothing in the ledger states the pool weight map');

// ---- the cases ------------------------------------------------------------
const rows = Object.values(raw)
  .map((i) => [
    i.id,
    i.title || '',
    i.severity || null,
    i.status || 'open',
    i.module || '',
    i.source || null,
    i.decision === undefined ? null : i.decision,
    i.discovered || null,
    i.updated_at || null,
    typeof i.check_count === 'number' ? i.check_count : null,
    i.files || [],
    i.description || null,
    i.suggestion || null,
    i.reason || null,
    i.plan_path === undefined ? null : i.plan_path
  ])
  // Filing order: a register is read oldest first, and every panel sorts for
  // itself (data.js groups it by what the reader has to act on).
  .sort((a, b) => String(a[7] || '').localeCompare(String(b[7] || '')));

// ---- the readings ---------------------------------------------------------
// Each closing beat may report the metric; when it does, that reading is a fact
// with a time and a node attached. Nothing is interpolated between them.
const readings = [];
const maint = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p);
      continue;
    }
    if (!e.name.endsWith('.json')) continue;
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    const v = s.outputs && s.outputs.reading ? s.outputs.reading.issue_pool_weight : undefined;
    if (typeof v !== 'number') continue;
    const n = ideas[s.node] || {};
    readings.push([s.timestamp || null, v, s.cycle || null, s.node || null, n.title || '']);
  }
})(path.join(LEDGER, 'signals'));
readings.sort((a, b) => String(a[0]).localeCompare(String(b[0])));

// A maintenance run is a node the pipeline inserted because the measure had
// crossed the line: the tool tags what it generates, and the two hand-called
// runs name the pool in their own title.
for (const [id, n] of Object.entries(ideas)) {
  const tagged = (n.tags || []).some((t) => String(t) === 'maint:issue_pool_weight');
  const named = /issue 池/.test(n.title || '');
  if (!tagged && !named) continue;
  maint.push([id, n.title || '', n.created_at || null, n.completed_at || null, n.status || null]);
}
maint.sort((a, b) => String(a[2]).localeCompare(String(b[2])));

// ---- what the source contains, so a drift shows up as a number -----------
const tally = (k) => rows.reduce((m, r) => ((m[r[k]] = (m[r[k]] || 0) + 1), m), {});
const W = (sev) => WEIGHTS[sev] || 0;
const standing = rows.filter((r) => r[3] === 'open' || r[3] === 'acknowledged');
const weight = standing.reduce((s, r) => s + W(r[2]), 0);
const seen = new Set(rows.map((r) => r[0]));
const dup = rows.length - seen.size;

const body = [];
body.push('/* GENERATED by tools/gen-issues.mjs -- do not edit by hand.');
body.push(' *');
body.push(' * Verbatim from a real .pf ledger: the issue register, the policy line the');
body.push(' * pool is measured against, the weight map the ledger states for its levels,');
body.push(' * every reading the pipeline took of that measure, and the maintenance runs');
body.push(' * that answered a crossing. Nothing in this file is invented.');
body.push(' *');
body.push(` *   source     ${LEDGER}`);
body.push(` *   cases      ${rows.length}`);
body.push(` *   line       ${LINE}            (cycle policy issue_pool_weight_limit)`);
body.push(` *   weights    ${JSON.stringify(WEIGHTS)}`);
body.push(` *   readings   ${readings.length}`);
body.push(` *   maint runs ${maint.length}`);
body.push(' *');
body.push(' * issues[k] = [id, title, severity, status, module, source, decision,');
body.push(' *              discovered, updated_at, check_count, files[], description,');
body.push(' *              suggestion, reason, plan_path]');
body.push(' *   status   open | acknowledged | resolved | rejected   (as the record stands)');
body.push(' * readings[j] = [at, value, cycle, node, title]');
body.push(' * maint[m] = [id, title, created, completed, status]');
body.push(' */');
body.push('window.PF_ISSUES = {');
body.push(`  source: ${JSON.stringify(LEDGER)},`);
body.push(`  line: ${LINE},`);
body.push(`  weights: ${JSON.stringify(WEIGHTS)},`);
body.push('  issues: [');
rows.forEach((r) => body.push(`    [${r.map((v) => JSON.stringify(v)).join(',')}],`));
body.push('  ],');
body.push('  readings: [');
readings.forEach((r) => body.push(`    [${r.map((v) => JSON.stringify(v)).join(',')}],`));
body.push('  ],');
body.push('  maint: [');
maint.forEach((r) => body.push(`    [${r.map((v) => JSON.stringify(v)).join(',')}],`));
body.push('  ]');
body.push('};');
body.push('');

fs.writeFileSync(OUT, body.join('\n'), 'utf8');

console.log(`wrote ${OUT} (${fs.statSync(OUT).size} bytes)`);
console.log(`cases ${rows.length}  status=${JSON.stringify(tally(3))}  severity=${JSON.stringify(tally(2))}`);
console.log(`source=${JSON.stringify(tally(5))}  decision=${JSON.stringify(tally(6))}  module kinds=${new Set(rows.map((r) => r[4])).size}`);
console.log(`standing (open+acknowledged) ${standing.length}  weighted ${weight}  line ${LINE}`);
console.log(`standing by severity ${JSON.stringify(standing.reduce((m, r) => ((m[r[2]] = (m[r[2]] || 0) + 1), m), {}))}`);
if (dup) console.log(`duplicate ids: ${dup}`);
const noTime = rows.filter((r) => !r[7]).length;
console.log(`cases with no discovered moment: ${noTime}`);
console.log(`readings ${readings.length}  span ${readings.length ? readings[0][0] : '-'} .. ${readings.length ? readings[readings.length - 1][0] : '-'}`);
const over = readings.filter((r) => r[1] >= LINE);
console.log(`readings at or over the line: ${over.length}${over.length ? ' ' + JSON.stringify(over.map((r) => [r[0].slice(0, 16), r[1]])) : ''}`);
console.log(`readings spread ${JSON.stringify(readings.reduce((m, r) => ((m[r[1]] = (m[r[1]] || 0) + 1), m), {}))}`);
maint.forEach((m) => console.log(`  maint ${m[0].slice(0, 8)}  created=${m[2]}  completed=${m[3]}  ${m[1]}`));