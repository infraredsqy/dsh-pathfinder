# dsh-pathfinder — Port the agent-pathfinder pipeline into DSH as a work panel the user can see

> This file is a signpost, capped at 15 lines: one line per entry — only what this layer holds and when to read it.

**Read [docs/design-principles.md](docs/design-principles.md) before changing the UI** — that is this repo's law.

- `mock/` — Prototype blueprint: the main panel and its two embedded tiles, plus a separate settings page. Read before changing the layout
- `src/` — Host half, model layer, and browser half: how records are read in, how readings are computed, how the panel is drawn (see `src/AGENTS.md`). Read when changing data fetching or the UI
- `tests/` — Unit tests; `npm test` runs them all in one command
- `tools/` — Where records come from, how artifacts are built, how the panel self-verifies, how the testbed starts (see `tools/AGENTS.md`)
- `docs/` — This repo's law (read before touching the UI) and publishing practice (see `docs/AGENTS.md`)
- Package and build surface — `package.json`, `tsconfig.json`, `tsconfig.host.json`, `tsdown.config.ts`, `cordis.patch.yml`: how the two entries are emitted, how this line gets hooked into the profile, what the git install route needs authorized. Read when changing the publishing surface
- `.tmp/` — Process artifacts, gitignored: screenshots, probes, per-round notes; jot and toss
