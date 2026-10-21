# tools/ — Where records come from, how artifacts are built, how the panel self-verifies, how the testbed starts

> This file is a signpost, capped at 15 lines: one line per entry — only what this layer holds and when to read it.

- `gen-ledger.mjs`, `gen-issues.mjs` — Generate `mock/ledger.js` and `mock/issues.js` from a real `.pf` (those two files are not committed; run this once in a fresh clone to get data). Read when changing the data source
- `css-check.mjs` — Style-layer self-check (`node tools/css-check.mjs`; `--root` switches the root, `--quiet` prints only violations): rules such as colors only through aliases, exit 0 with zero violations. Run it after changing styles
- `build-client.mjs` — Build entry for the browser half: pulls the stylesheets the panel needs from the blueprint, collects selectors, then bundles them into `lib/client.js` (`npm run bundle:client`). Read when changing the artifact shape or how styles get packaged
- `panel-check.mjs` — The panel's self-verification fixture (`npm run check:panel`): real records → real host half → real panel, opens each tile and prints readings; any error in the console means failure. Read when you want to hand-verify the panel
- `testbed/` — A DSH testbed fully isolated from the main environment: its own home, its own profile, self-authored synthetic workspaces and sessions; one command, three actions (`up` starts an instance and installs this repo's panel line into the profile / `check` prints readings / `down` tears it down), argument knobs documented in its own file header. Read when you need to hand-reproduce what the panel reads
