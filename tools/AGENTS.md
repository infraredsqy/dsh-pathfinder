# tools/ — Where records come from, how artifacts are built, how the testbed starts

> This file is a signpost, capped at 15 lines: one line per entry — only what this layer holds and when to read it.

- `css-check.mjs` — Style-layer self-check (`node tools/css-check.mjs`; `--root` switches the root, `--quiet` prints only violations): rules such as colors only through aliases, exit 0 with zero violations. Run it after changing styles; its theme input (the palettes and the contrast floors) is `tools/theme.css`
- `build-client.mjs` — Build entry for the browser half: joins the sheets in `src/client/styles/` in cascade order, checks that no selector escaped its layer, then bundles them into `lib/client.js` (`npm run bundle:client`). Read when changing the artifact shape or how styles get packaged
- `testbed/` — A DSH testbed fully isolated from the main environment: its own home, its own profile, self-authored synthetic workspaces and sessions; one command, three actions (`up` starts an instance and installs this repo's panel line into the profile / `check` prints readings / `down` tears it down), argument knobs documented in its own file header. Read when you need to hand-reproduce what the panel reads
