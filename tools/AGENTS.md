# tools/ —— 记录从哪来，测试床怎么起

> 本文件是路牌，上限 30 行：只写这一层有什么、什么时候看。

- `gen-ledger.mjs`、`gen-issues.mjs` —— 从一份真实 `.pf` 生成 `mock/ledger.js` 与 `mock/issues.js`（这两个文件不进库）。改数据来源时看
- `testbed/` —— 与主环境完全隔离的 DSH 测试床：自己的 home、自己的 profile、自撰的合成工作区与合成会话。要亲手复现面板读到的东西、或验一条改动没碰主环境时看
- `testbed/testbed.ps1` —— 入口，一条命令三个动作：`up` 幂等重建测试床并起实例、留在那儿；`check` 跑完成判定、逐条印读数、失败非零退出；`down` 只收自己记下的那个实例（先核对命令行）
- `testbed/testbed-lib.ps1` —— 上面那个入口的实现，不单独调用
- 运行实体一律落在项目树之外（默认 `%LOCALAPPDATA%\dsh-pathfinder-testbed`）；默认造一份工作区加一条会话，参数口子：`-Workspace` 换工作区名、`-SessionCount` 造第二条会话、`-EmptyWorkspace` 造一份空工作区
- 两个脚本是 UTF-8 with BOM 的 PowerShell；写入只发生在测试床自己的根目录里，主 home 与本仓的 `.pf` 只读