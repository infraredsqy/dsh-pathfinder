# dsh-pathfinder —— 把 agent-pathfinder 的管线搬进 DSH，做成一个用户看得见的工作面板

> 本文件是路牌，上限 30 行：只写这一层有什么、什么时候看。

这个仓现在是一个插件包（`dsh-pathfinder`，`type: module`）：**宿主半身**已经在跑——按当前会话
所在的工作区把那份记录读进来，装成 `ctx.pathfinderRecords`；界面还是 `mock/` 里那份不打包的静态原型。

**改界面之前先读 [`docs/design-principles.md`](docs/design-principles.md)** —— 那是这个仓的法，
加内容需要 user 批准。

- 现状正本在三处（先看这个）—— `mock/f-main.html`：打开就是这一屏；`src/`：记录怎么读进来；`tools/`：记录从哪来、怎么重跑
- `src/` —— 宿主半身：那一半的记录读取与边界形状。改取数、改它对外那条接口时看，怎么起见 `src/AGENTS.md`
- `src/model/` —— 模型层：把 mock 的读数逻辑搬成带类型的纯函数，输入＝四份记录原形＋一个时刻、输出＝那一刻的读数。改读数怎么算时看
- `tests/` —— 两半的单元测试（宿主＋模型），`npm test` 一条命令跑全
- `package.json`、`tsconfig.json`、`tsconfig.host.json`、`tsdown.config.ts` —— 包面与构建面：`npm run types` 把类型出到 `lib/types`，`npm run bundle` 出包入口 `lib/host/index.js`。改发布面时看
- `mock/` —— 原型：主面板 `f-main.html` 和它内嵌的两格，另有一页面板还没引用的 `h-settings.html`。样式分三层，四页都按这个
  次序 `<link>`：`theme.css`（DSH 主题值的替身，全仓只有它写颜色）→ `tokens.css`（共同地面：reset、记号、共用构件）→
  `styles/<这一页的模块>.css`（八份模块，互不 `@import`）；这套分法的规矩由 `node tools/css-check.mjs` 看着。改版面前看
- `tools/` —— 从一份真实 `.pf` 生成 `mock/ledger.js` 与 `mock/issues.js`（这两个文件不进库，新克隆里跑一遍才有数据）；`testbed/` 一条命令起一个与主环境隔离的 DSH 测试床（`up`／`check`／`down`）。改数据来源、要亲手复现面板读数时看，怎么起见 `tools/AGENTS.md`
- `docs/` —— 这个仓的法：动手改界面之前看
- `.tmp/` —— 过程物，gitignored：截图、探针、当轮笔记，随手写随手扔