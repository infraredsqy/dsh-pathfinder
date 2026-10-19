# dsh-pathfinder —— 把 agent-pathfinder 的管线搬进 DSH，做成一个用户看得见的工作面板

> 本文件是路牌，上限 15 行：一行一条，只写这一层有什么、什么时候看。

**改界面之前先读 [docs/design-principles.md](docs/design-principles.md)** —— 那是这个仓的法。

- `mock/` —— 原型蓝本：主面板与它内嵌的两格，另有一页设置页。改版面前看
- `src/` —— 宿主半身、模型层与浏览器半身：记录怎么读进来、读数怎么算、面板怎么画（见 `src/AGENTS.md`）。改取数、改界面时看
- `tests/` —— 单测，`npm test` 一条命令跑全
- `tools/` —— 记录从哪来、产物怎么构建、面板怎么自证、测试床怎么起（见 `tools/AGENTS.md`）
- `docs/` —— 这个仓的法（动手改界面前看）与发布做法（见 `docs/AGENTS.md`）
- 包面与构建面 —— `package.json`、`tsconfig.json`、`tsconfig.host.json`、`tsdown.config.ts`、`cordis.patch.yml`：两个入口怎么出、这一行怎么挂进 profile、git 那条安装路子要授权什么。改发布面时看
- `.tmp/` —— 过程物，gitignored：截图、探针、当轮笔记，随手写随手扔