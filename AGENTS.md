# dsh-pathfinder —— 把 agent-pathfinder 的管线搬进 DSH，做成一个用户看得见的工作面板

> 本文件是路牌，上限 30 行：只写这一层有什么、什么时候看。

现在这个仓里是**界面原型**（不打包的静态 mock），选型之后再谈插件接线。

**改界面之前先读 [`docs/design-principles.md`](docs/design-principles.md)** —— 那是这个仓的法，
加内容需要 user 批准。

- `README.md` —— 现状正本：怎么打开、数据从哪来、面板上的读数怎么读（先看这个）
- `mock/` —— 原型。改版面前看
- `tools/` —— 从一份真实 `.pf` 生成 `mock/ledger.js` 那份记录。改数据来源时看
- `docs/` —— `design-principles.md`，动手前必读的法
- `.tmp/` —— 过程物，gitignored：截图、探针、当轮笔记，随手写随手扔