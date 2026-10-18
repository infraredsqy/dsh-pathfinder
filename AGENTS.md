# dsh-pathfinder —— 把 agent-pathfinder 的管线搬进 DSH，做成一个用户看得见的工作面板

> 本文件是路牌，上限 30 行：只写这一层有什么、什么时候看。

这个仓现在是一个插件包（`dsh-pathfinder`，`type: module`）：**宿主半身**已经在跑——按当前会话
所在的工作区把那份记录读进来，装成 `ctx.pathfinderRecords`，七条端点经 DSH 的网关交给浏览器半身；
**浏览器半身**是 `src/client/` 那份主面板（六格标签、当前 / 明细 / 指令 / 依赖 / 问题五格接真记录，设置那一格读这个工作区自己的项目设置——四行值取自 `pf config list`，改一处经 `pf config set` 写回本项目那一层、写完重读；写面都经 `pf` 落笔）。
面板自己的偏好（侧栏宽度 / 默认信息量 / 默认标签页 / 指令里显示已归档的 / 问题池里显示未解决之外的）住 DSH 的设置：宿主半身照
`cordis.patch.yml` 那条行 id `pathfinder` 交出 `Config`，浏览器半身在设置里注册一节（`src/client/settings.tsx`），本地存储里不留键。
`mock/` 里那份静态原型是蓝本，不再是唯一的一份界面。

**改界面之前先读 [`docs/design-principles.md`](docs/design-principles.md)** —— 那是这个仓的法，
加内容需要 user 批准。

- 现状正本在三处（先看这个）—— `mock/f-main.html`：蓝本，打开就是这一屏；`src/`：记录怎么读进来、界面怎么长；`tools/`：记录从哪来、怎么重跑
- `src/` —— 宿主半身与浏览器半身，怎么起见 `src/AGENTS.md`
- `src/model/` —— 模型层：把 mock 的读数逻辑搬成带类型的纯函数，输入＝四份记录原形＋一个时刻、输出＝那一刻的读数。改读数怎么算时看
- `src/client/` —— 浏览器半身：主面板的壳与六个看法（当前 / 明细 / 指令三格住在 `panel.tsx` 里，依赖与问题两格各自的看法住在 `field.tsx` 与 `pool.tsx`，设置那一格是这个工作区自己的项目设置，住在 `config.tsx`／`config-rows.ts`）、与宿主说话的那条口子（`data.ts`）、面板自己的偏好（`prefs.ts`：设置文档这一节与面板读数之间的映射，面板自己的键不再写本地存储，接上设置表单时把旧版那四个键扫掉）、设置里那一节（`settings.tsx`）、面板那几张样式表、调度中心在 DSH 自己那几处位置上的挂载点（`mount.ts`：侧栏一项「调度中心」、中央栏那一格、页脚一枚「可开工 N」的徽标、浮层一句提示；两张注入样式表的记号在 `style-tags.ts`）。改界面时看
- `tests/` —— 单测（宿主＋模型＋浏览器半身的数据面 / 写面 / 项目设置面 / 偏好面 / 四处挂载点），`npm test` 一条命令跑全
- `package.json`、`tsconfig.json`、`tsconfig.host.json`、`tsdown.config.ts`、`cordis.patch.yml` —— 包面与构建面：`npm run types` 把类型出到 `lib/types`（另两半各跑 `npm run types:model`／`types:client`），`npm run bundle` 出包入口 `lib/host/index.js`，`npm run bundle:client` 出浏览器半身 `lib/client.js`；包面因此有两个口子——`.` 与 `exports["./client"]`，后者配套 `dsh.client.platform: web`；`cordis.patch.yml` 是这一行在 profile 里的挂载点（行 id `pathfinder` 同时是设置命名空间，`dsh.bundle.patch` 指着它，`@deepseek-ai/schemastery` 由宿主提供、留在包外）。改发布面时看
- `mock/` —— 原型：主面板 `f-main.html` 和它内嵌的两格，另有一页 `h-settings.html`（设置那一节的蓝本，主面板没引用它）。样式分三层，四页都按这个
  次序 `<link>`：`theme.css`（DSH 主题值的替身，全仓只有它写颜色）→ `tokens.css`（共同地面：reset、记号、共用构件）→
  `styles/<这一页的模块>.css`（八份模块，互不 `@import`）；这套分法的规矩由 `node tools/css-check.mjs` 看着。改版面前看
- `tools/` —— 从一份真实 `.pf` 生成 `mock/ledger.js` 与 `mock/issues.js`（这两个文件不进库，新克隆里跑一遍才有数据）；`testbed/` 一条命令起一个与主环境隔离的 DSH 测试床（`up`／`check`／`down`）。改数据来源、要亲手复现面板读数时看，怎么起见 `tools/AGENTS.md`
- `tools/build-client.mjs`、`tools/panel-check.mjs` —— 浏览器半身的构建口，与那块面板的自证夹具（真记录 → 真宿主半身 → 真面板，`npm run check:panel`；夹具另把调度中心那四处照真形状挂一遍、空记录与读不动两份工作区各量一遍，再走一遍设置那一节：五条注册的名册、翻四行、同一份存储再挂一次、扫本地存储；第六格（设置那一格）另对着真工具走一趟：四行的值与层签逐行比、四行各改一次、两种非法值不落笔、那一列的两枚把手、重开一份面板照同一条会话读）。改产物形状或要亲手验一遍面板时看
- `docs/` —— 这个仓的法：动手改界面之前看
- `.tmp/` —— 过程物，gitignored：截图、探针、当轮笔记，随手写随手扔