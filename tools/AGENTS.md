# tools/ —— 记录从哪来、产物怎么构建、面板怎么自证、测试床怎么起

> 本文件是路牌，上限 15 行：一行一条，只写这一层有什么、什么时候看。

- `gen-ledger.mjs`、`gen-issues.mjs` —— 从一份真实 `.pf` 生成 `mock/ledger.js` 与 `mock/issues.js`（这两个文件不进库，新克隆里跑一遍才有数据）。改数据来源时看
- `css-check.mjs` —— 样式层自查（`node tools/css-check.mjs`，`--root` 换根、`--quiet` 只印违例）：颜色只走别名一类的规矩，全 0 违例 exit 0。改样式之后跑它
- `build-client.mjs` —— 浏览器半身的构建口：把面板要的样式表按蓝本取出来、收拢选择器，再捆成 `lib/client.js`（`npm run bundle:client`）。改产物形状、改样式进包的方式时看
- `panel-check.mjs` —— 面板的自证夹具（`npm run check:panel`）：真记录 → 真宿主半身 → 真面板，逐格点开印读数，控制台出现 error 就是失败。要亲手验一遍面板时看
- `testbed/` —— 与主环境完全隔离的 DSH 测试床：自己的 home、自己的 profile、自撰的合成工作区与合成会话；`testbed.ps1` 一条命令三个动作（`up` 起实例并把本仓这一条面板装进 profile／`check` 印读数／`down` 收场），参数口子写在它自己的文件头里。要亲手复现面板读到的东西时看