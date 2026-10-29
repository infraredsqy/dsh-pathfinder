# dsh-pathfinder

English | [中文](README.zh.md)

`dsh-pathfinder` is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin
that renders an [agent-pathfinder](https://github.com/infraredsqy/agent-pathfinder) record as a
panel in the DSH Web UI.

The host half reads the record (`.pf/`) of the current session's workspace and serves it behind a
gateway; the browser half draws it as the **Pathfinder Center** panel in the sidebar. Everything on screen —
instructions, node details, the map of who owes whom, the issue pool — comes from that record, and
writes from the panel go back to the same place.

## Status

Early, and tied to the DSH developer preview. The manifest declares an `engines.dsh` range, and DSH
refuses to install or boot the plugin outside that range (`incompatible-version`, with an opt-in
exemption command). The range moves as DSH does.

The record it draws comes from [agent-pathfinder](https://github.com/infraredsqy/agent-pathfinder),
which is early and moving fast too: expect breaking changes on that side.

## Install

Prerequisites: a DSH install with a profile to install into, and a workspace that holds an
agent-pathfinder record (`.pf/`, with `pf` on your `PATH`). The panel reads the workspace of the
session you have selected; with no session selected it says so.

```sh
dsh plugin --profile <name> add dsh-pathfinder
```

The package ships prebuilt — installing runs no build steps. pnpm may print a few `missing peer`
warnings: those packages are provided by DSH itself and resolve at runtime, so the warnings can be
ignored. The other two routes (a GitHub Release `.tgz`, or git) and the version policy live in
[docs/publish.md](docs/publish.md).

## What you get

- a **Pathfinder Center** entry in the Web UI sidebar: views over the record — the map, details,
  instructions, the issue pool, and the panel's own settings
- a **Pathfinder Settings** section in the DSH settings: whether archived instructions show,
  whether closed issues show
- to verify an install: `dsh --profile <name> --dump-config`, and look for the
  `# == dsh-pathfinder` section

## Development

```sh
pnpm install --frozen-lockfile
npm test                  # unit tests; builds lib/client.js first, then mounts it in jsdom
node tools/css-check.mjs  # the style-layer rules
npm pack                  # the distributable
```

`npm test` covers the model layer, the host half and the built browser half — the last one mounts
`lib/client.js` over an in-memory record, walks every pane, and fails on any `console.error`. What it
cannot reach (the readings over a real `.pf`, the copy, the layout) is on the hand pass in
[docs/publish.md](docs/publish.md); `tools/testbed/` boots an isolated DSH instance to walk it.

The repository map and ground rules live in [AGENTS.md](AGENTS.md). Read
[docs/design-principles.md](docs/design-principles.md) before touching the UI, and
[docs/publish.md](docs/publish.md) before shipping a version.

## License

[MIT](LICENSE)
