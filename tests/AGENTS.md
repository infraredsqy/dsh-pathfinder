# tests/ — The unit suite: what a test may pin, and what is walked by hand

> This file is a signpost, capped at 15 lines: one line per entry — only what this layer holds and when to read it.

**Pin the artifact, leave the wording alone.** What this suite keeps is behaviour and identity: the built browser half boots and draws without an error, registration and unmount land where they should, the model computes what it computes. The copy, the layout and the readings that need a real record move too often to pin — a test holding them costs an edit every time a word or a pixel moves. Those readings live on the hand pass in [../docs/publish.md](../docs/publish.md).

- `client-render.test.mjs` — The built `lib/client.js` over the in-memory port: the shell gets its spec, the panel mounts, every pane its tabs point at opens, the console stays clean. Skips itself with the reason when the bundle is not built; `npm test` builds it first
- `client-mount.test.mjs` — The two seats and the settings section: registration, the label function, unmount discipline, the language port
- `host-*.test.mjs` — The host half: the four sources, paging refusals, the writes' command lines, the package's plugin line
- `model-*.test.mjs` — The model layer: readings computed from the four records, one instant at a time, pure functions
- `helpers/` — The stand-ins the files share: the workspace-files port, the settings document, the locale service, the slot roster. One copy each; a file needing a narrower face builds it on top
- `package-surface.test.mjs` — The package face (`files`, exports, `engines`, the patch line) that publishing depends on