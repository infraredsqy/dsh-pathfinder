# dsh-pathfinder

[English](README.md) | 中文

`dsh-pathfinder` 是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：把
[agent-pathfinder](https://github.com/infraredsqy/agent-pathfinder) 的那份记录画成 DSH Web UI 里的一块面板。

宿主半身按当前会话的工作区读那份记录（`.pf/`），经网关交出去；浏览器半身把它画成侧栏里的「寻路中心」。
屏上的一切——指令、节点明细、谁欠谁的那张地图、问题池——都从那份记录上来，面板里的写回也进同一条路。

## 状态

早期，跟着 DSH 的开发者预览走。包面用 `engines.dsh` 声明了一段兼容范围，落在范围外时 DSH 会拒装、拒起
（报 `incompatible-version`，并给出豁免的命令）。DSH 动，这段范围跟着动。

## 安装

前提：装了 `dsh`，手里有一个装得进插件的 profile；要看的工作区里有一份 agent-pathfinder 的记录
（`.pf/`，`pf` 命令在 PATH 上）。面板按「当前选中的会话」定工作区——没选中会话时它自己会说明。

```sh
dsh plugin --profile <名字> add dsh-pathfinder
```

包里是预构建产物，装的时候不跑任何构建。装完 pnpm 若列出几条 `missing peer` 警告：那几个包由 DSH
本体提供、运行时解析得到，警告可以无视。另外两条路子（GitHub Release 的 `.tgz`、git）与版本兼容的
口径见 [docs/publish.md](docs/publish.md)。

## 装完有什么

- 侧栏多出「寻路中心」一项：地图、明细、指令、问题池，以及面板自己的设置
- DSH 设置里多出「寻路配置」一节：默认标签页、指令里显不显已归档、问题池里显不显未解决之外的
- 核一下装没装上：`dsh --profile <名字> --dump-config`，找 `# == dsh-pathfinder` 那一节

## 开发

```sh
npm install
npm test                  # 单测；先把 lib/client.js 构建出来，再把它挂进 jsdom
node tools/css-check.mjs  # 样式层的规矩
npm pack                  # 打出分发件
```

`npm test` 管到三块：模型层、宿主半身、构建出来的浏览器半身——最后那块把 `lib/client.js` 挂到一份内存里
的记录上、逐格走一遍，控制台里出现一条 error 就算失败。它管不到的那些（真记录下的读数、文案、布局）在
[docs/publish.md](docs/publish.md) 有一张手动单子；`tools/testbed/` 能起一个隔离的 DSH 实例来走它。

仓库的路牌与规矩在 [AGENTS.md](AGENTS.md)。改界面前先读
[docs/design-principles.md](docs/design-principles.md)，发一版前看
[docs/publish.md](docs/publish.md)。

## License

[MIT](LICENSE)
