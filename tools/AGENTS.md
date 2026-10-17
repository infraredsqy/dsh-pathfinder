# tools/ —— 记录从哪来，测试床怎么起

> 本文件是路牌，上限 30 行：只写这一层有什么、什么时候看。

- `gen-ledger.mjs`、`gen-issues.mjs` —— 从一份真实 `.pf` 生成 `mock/ledger.js` 与 `mock/issues.js`（这两个文件不进库）。改数据来源时看
- `css-check.mjs` —— 样式层自查：`node tools/css-check.mjs`（`--root` 换根、`--quiet` 只印违例），对着 `mock/` 那十张表问 12
  组问题——颜色只走别名、圆角配 `corner-shape`、elevation 与中性描边、菜单材质、链接别名、两套主题都定义面板读到的别名
  （第 7 组另有一问：面板表的 `--pf-*` 有没有人声明）、记号对比度（明暗各一遍、24 行）、含义不同的同名类、模块挂接与
  href 断链、卡面悬停、令牌声明位置；全 0 违例 exit 0。改样式之后跑它
- `testbed/` —— 与主环境完全隔离的 DSH 测试床：自己的 home、自己的 profile、自撰的合成工作区与合成会话。要亲手复现面板读到的东西、或验一条改动没碰主环境时看
- `testbed/testbed.ps1` —— 入口，一条命令三个动作：`up` 幂等重建测试床并起实例、留在那儿；`check` 跑完成判定、逐条印读数、失败非零退出；`down` 只收自己记下的那个实例（先核对命令行）
- `testbed/testbed-lib.ps1` —— 上面那个入口的实现，不单独调用
- 运行实体一律落在项目树之外（默认 `%LOCALAPPDATA%\dsh-pathfinder-testbed`）；默认造一份工作区加一条会话，参数口子：`-Workspace` 换工作区名、`-SessionCount` 造第二条会话、`-EmptyWorkspace` 造一份空工作区
- 两个脚本是 UTF-8 with BOM 的 PowerShell；写入只发生在测试床自己的根目录里，主 home 与本仓的 `.pf` 只读