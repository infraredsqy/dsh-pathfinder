# 读数清单 · 面板证明面（一键起 + 七行读数）

> 位置：`tools/testbed/CHECKLIST.md`。这张单子把「整条路是通的」变成**一条命令 + 七行读数**：
> 每行＝命令 + 期望 + 实际读数，命令都能在干净环境里原样重跑，不依赖浏览器、不依赖手点过的状态。
> 本格的「干净环境」口径＝**这份工作副本减去一切过程物**（`.tmp/`、`lib/` 之类跑出来的东西，
> 建它不用手点，见下面前置）。量的是这份工作副本自己——它带着一份 `.pf` 记录目录（本地档，
> 不进版本库），前置里写明了这一点。
>
> 三条在仓里跑：`npm test`、`npm run check:panel`、`node tools/css-check.mjs`；
> 一条起实例：`pwsh -File tools/testbed/testbed.ps1 -Action up`（测试床在项目树之外，
> 默认 `%LOCALAPPDATA%\dsh-pathfinder-testbed`，不碰主 home）。

## 前置（干净环境先来这一遍）

```powershell
cd <项目根>
npm install
npm run types           # 出 lib/types —— `tsc -b tsconfig.host.json`，下一步捆的输入（新克隆里没有 lib/）
npm run bundle          # 出 lib/host/index.js —— 宿主半身（`tsdown` 的入口是 lib/types/host/index.js）
npm run bundle:client   # 出 lib/client.js —— 浏览器半身（`npm run check:panel` 里也会跑一遍）
```

`-Action up` 装的是**产物**：上面两份不在盘上时，它会当场停下并指名该跑哪一条命令，不会起一条没有面板的实例。

本工作副本须含 `.pf` 记录目录（**本地档、不进版本库**）：下面第 **1~4、6、7** 行的读数就是这份
记录库的读数（`npm run check:panel` 把它原样复制成夹具输入，缺了它那几行当场跑不出来）；第 5 行
另行读 `mock/`，与它无关。

Node：本机实测 `node -v` ＝ **v26.9.0**。`npm run check:panel` 的夹具直接 `import` 仓里的 `.ts`
（`src/host/index.ts`、`src/model/index.ts`），靠 Node 原生的 TS 剥离；更低的版本**没量过**，
这里不给下限。

---

## 第 0 行 · 一条命令：实例起来、面板已装、指着合成工作区

**命令**

```powershell
pwsh -File tools/testbed/testbed.ps1 -Action up
```

**期望**

- 退出码 0；印出 `testbed root` / `isolated home` / 一条 `workspace`（合成工作区）/ 一条 `session` / `pid` / `url`。
- `panel` 那一行是 pnpm 记下本仓的本地路径依赖（`link:`），`panel row` 是 compose 之后配置树里 `id: pathfinder` 那一行。
- `panel source` 印这一趟装的是什么形态、从哪来（`form=directory` 是本仓的本地路径，`form=tarball`
  是从 `.tgz` 装的、那时另带 `sha256=`）；`panel entries` 是那一行 `name:` 指向的两手入口落在盘上的
  路径与字节数 —— 宿主入口与浏览器那半身两份都要 `exists=True`。
- `panel mount` 两处正面读数都在：**正在跑的那个实例**把 `pathfinder` 当设置命名空间服务出去，
  且它交给浏览器的启动名册里列着 `dsh-pathfinder/client.js`（那一条另带 `dsh.client.inject`
  声明，面板取数那条口子就靠它排在 `connection` 之后应用，见「已知偏差」）。
- 不给 `-SeedRecords` 时合成工作区里没有 `.pf`，也就没有 `records` 那一行；给了就多一行
  `records : .pf seeded into … (files=… bytes=…)`（见「已知偏差」）。
- 末两行印出「一条命令把会话清单打出来」的那一行 curl（含本次实例的端口与 token）。

**实际读数**（本次实测，`up` 墙钟 **5.4 s**）

```
testbed root : %LOCALAPPDATA%\dsh-pathfinder-testbed
isolated home: %LOCALAPPDATA%\dsh-pathfinder-testbed\home
workspace    : 0b6ea288-… 'workspace-alpha' sessions=1 path=…\dsh-pathfinder-testbed\workspaces\workspace-alpha
session      : 5b53f59e-… -> …\home\sessions\--C-Users-PC-AppData-Local-dsh-pathfinder-testbed-workspaces-workspace-alpha--\5b53f59e-…\session.v4.jsonl
pid          : 32348
url          : http://127.0.0.1:5974/?token=…

panel        : dsh-pathfinder <- link:C:/Users/PC/dsh-pathfinder
panel row    : - id: pathfinder |   name: dsh-pathfinder
panel source : form=directory path=%USERPROFILE%\dsh-pathfinder
panel entries: dsh-pathfinder -> %USERPROFILE%\dsh-pathfinder\lib\host\index.js (exists=True 32415B) ｜ dsh-pathfinder/client -> %USERPROFILE%\dsh-pathfinder\lib\client.js (exists=True 271154B)
panel mount  : settings namespace 'pathfinder' is served by the live instance (namespaces=22) ｜ boot manifest lists dsh-pathfinder/client.js (page 37668 chars)
panel builds : lib\host\index.js 32415B, lib\client.js 271154B
```

从 `.tgz` 装的那一趟（`-Plugin <…>.tgz`）另有 `panel <- file:…`、`panel source : form=tarball … sha256=…`，
`panel entries` 指向的是那个 profile 里装好的 `node_modules\dsh-pathfinder\…`（本机实测同样两份 `exists=True`）。
同一份内容打出来的 `sha256` 是稳定的（`npm pack` 把归档里每个成员的 mtime 归一）：拿现在这份源码
连打三次都是 `a7262be6…`；补上 `dsh.client.inject` 那一行之前那一份是 `184362e0…` —— 内容变了它才
变。要核对落点上那份 `.tgz` 出自哪份源码，就跑 `Get-FileHash -Algorithm SHA256 <那份 .tgz>`；这一份
是 **23 个条目**、`sha256=a7262be6…`。

（工作区名、会话 id、pid、端口、token 每趟新造；其余逐字稳定。）

**收尾**（别在盘上留游离实例；`down` 只收自己 pid 文件记下的那一个）

```powershell
pwsh -File tools/testbed/testbed.ps1 -Action down     # → stopped : True
```

---

## 第 1 行 · 逐个看法打开：渲染成功、控制台零 error

**命令**：`npm run check:panel`
**期望**：面板有几处看法就逐个打开几处（spec 原文举了四个，面板实际**六处**，按超集做），
每处 `pane-*` 渲染出来且 `hidden=false`；整趟跑完控制台 0 条 error。

**实际读数**（墙钟 7.8 s，147 passed / 2 failed —— 这一行要的那几条逐条都过；那两条失败落在
「依赖那一格的前置读数」与「第二份记录里挑得出一个能搁出去的格」上，属于记录当前状态的事，见「已知偏差」）

```
ok    六个标签都在  当前/明细/指令/依赖/问题/设置
ok    看法「当前」渲染出内容  pane-pane-now
ok    看法「明细」渲染出内容  pane-pane-detail
ok    看法「指令」渲染出内容  pane-pane-notes
ok    看法「依赖」渲染出内容  pane-pane-wires
ok    看法「问题」渲染出内容  pane-pane-issue
ok    看法「设置」渲染出内容  pane-pane-config
ok    控制台没有 error  0 条
```

---

## 第 2 行 · 与记录逐项核对：面板读数与磁盘上的源文件一致

**命令**：`npm run check:panel`
**期望**：夹具每次现读磁盘上的 `.pf`、用真宿主半身＋模型层算一遍，再与面板上量到的逐项比；
胶囊/三列卡数、依赖的记号与连线数、明细组头、指令分组、问题池行数都要逐项相等。

**实际读数**（几个数跟着记录当前状态走：这一趟记录里 11 个已交付 / 1 个进行中 / 0 个未开始）

```
ok    看板上的数从记录里来：胶囊与三列卡片数逐项对上  记录现算 胶囊=[["已交付",11],["进行中",1],["未开始",0]] 三列=[1,3,0] ｜ 面板上 胶囊=[["已交付",11],["进行中",1],["未开始",0]] 三列=[1,3,0] 总卡=4
ok    依赖那一格：记号、连线、顶栏那三个数与记录现算的逐项对上  记录现算 10 列 · 12 节点 · 17 边 ｜ 面板上 10 列 · 12 节点 · 17 边，记号 12，连线 17
ok    明细的组头按记录长出来  进行中(1)/已交付(11)
ok    指令那一格按范围分组：组头与组内那几条逐项等于记录现算的  （两侧 JSON 逐项相等；原文见 run 输出）
ok    问题那一格：开在未解决上，登记簿的行就是记录里未解决的那几条  记录里未解决 5 条 ｜ 面板上 5 行
ok    设置那一格：四行的值与层签逐行与真工具印的那份对上  工具那边：worktree_mode=off(本项目) test_tier=full(本项目) max_agents=1(本项目) issue_repair=on(默认) ｜ 面板这边：同左
```

---

## 第 3 行 · 会话跳转：点一张卡能切到那一条会话

**命令**：`npm run check:panel`
**期望**：卡片按记录指出会话；点下去（或回车）把活动会话切到那条、DSH 的导航口子收到同一个身份；
记录里那条会话不在这台机器上、或哪儿都没写会话时，卡片是 `.pf-card.is-inert`、点下去什么都不发生。

**实际读数**

```
ok    点一张卡：活动会话切到记录里指出的那一条  那一格写的是=session-5a23fd49-db72-419d-a5bc-3ede124c6f4a ｜ 活动会话=session-5a23fd49-db72-419d-a5bc-3ede124c6f4a ｜ 口子收过的=session-5a23fd49-db72-419d-a5bc-3ede124c6f4a
ok    回车也算数：切回原来那一条会话  活动会话=session-5d8c5a4c-551c-45fb-b27b-e81ba5671e84（要的是 session-5d8c5a4c-551c-45fb-b27b-e81ba5671e84）
ok    那条会话不在这台机器上：卡片安安静静地摆着，不给按钮那一身  2aee86f8@session-3b00c9ed-d ｜ role=null tabindex=null class=pf-card is-done is-inert
ok    这一格还没有会话（笔记与记录本体两处都没写）：卡片同样没有去处  <本趟新加的格 id> ｜ 笔记里=undefined ｜ 记录本体上=undefined ｜ role=null class=pf-card is-next is-inert
ok    没有去处的卡片点下去什么都不发生：会话没换，导航口子没被叫到  会话=panel-check-session ｜ 口子收过 0 次
```

（`<本趟新加的格 id>` 是夹具每次现造的一个 uuid，逐趟不同。）

---

## 第 4 行 · 卸载与热更新：四个清场点逐处清干净

**命令**：`npm run check:panel`
**期望**：四个清场点＝**侧栏项 / 页脚徽标 / 浮层 / 两张注入的样式标签**，每处都要有正面读数，
并且走全一趟 **装 → 卸 → 再装**（热更新）：卸干净之后三处座席既不在名册上、屏上也画不出来，
两张标签从文档里摘掉；再装回来四处各回原样、名册仍是五条、没有重复。

**实际读数**

```
ok    热更新·装：四处清场点各就各位（三处座席在册且画得出来 ＋ 两张注入的标签在文档里）  名册 5 条 ｜ 侧栏项=在册·屏上有 页脚徽标=在册·屏上有 浮层=在册·屏上有 ｜ 面板那一张=dsh-pathfinder-panel-style 设置那一张=dsh-pathfinder-settings-style
ok    热更新·卸：四处清场点各自清干净（三处座席不在册且屏上没了 ＋ 两张注入的标签都摘掉）  名册 0 条 ｜ 侧栏项=不在册·屏上无 页脚徽标=不在册·屏上无 浮层=不在册·屏上无 ｜ 面板那一张=null 设置那一张=null
ok    热更新·再装：同一本名册上四处清场点各回到原样，仍是五条、没有重复  名册 5 条 ｜ 侧栏项=在册·屏上有 页脚徽标=在册·屏上有 浮层=在册·屏上有 ｜ 面板那一张=dsh-pathfinder-panel-style 设置那一张=dsh-pathfinder-settings-style
ok    卸载那一趟：五条都登记上了  名册=settings.section:pathfinder, sidebar.panellist:pathfinder, main:pathfinder, sidebar.footer.action:pathfinder.ready-badge, shell.overlay:pathfinder.pending-notice
ok    卸载之后：名册清空，四处都没有残留  名册=（空）
ok    卸载之后：两张注入的样式标签都摘干净了  面板那一张=null 设置那一张=null
```

「三处座席画得出来」那一条走的是一个最小渲染器：它只做真渲染器做的那一件事——**照名册当下有什么就画什么**，
所以「注册撤了、屏上就没了」这件事有屏上读数，不只是名册读数。

---

## 第 5 行 · 明暗两套主题：那组记号的前景/背景对比度全部过线

**命令**：`node tools/css-check.mjs`
**期望**：全 0 违例、退出码 0；**这一行量的就是第 8 组那组记号**——明暗两套主题各 24 个记号，
前景/背景对比度逐个与自己的下限比（自解析的记号 ≥ 3:1，按密度读的 ≥ 1.5:1）。

**实际读数**（墙钟 0.09 s）

```
8  marks           rows 24, under floor 0
floors, read from --pf-mark-floor / --pf-mark-floor-dense in mock/tokens.css:
  a mark the reader resolves on its own >= 3:1 · one read as density >= 1.5:1
mark inks with a floor — all of these pass:
计数胶囊方记号 · 已交付                           --pf-ink-2bg-base   5.80:1 #61666B        12.11:1 #CFD3D6       3:1
计数胶囊方记号 · 未开始                           --pf-ink-3bg-base   3.71:1 #81858C        8.54:1 #ADB2B8        3:1
分层场记号 · 已交付                             --pf-ink-1bg-base   18.90:1 #0F1115       17.45:1 #F9FAFB       3:1
重量档 · 最轻一档（P3，密排那一档）                    --pf-ink-4bg-base   1.78:1 #C0C2C6        3.05:1 #616468        1.5:1
…（24 行全过；原文见 run 输出）
PASS — 9 panel sheets, 24 marks in 2 palettes, 0 failures
```

---

## 第 6 行 · 空工作区：没有记录时面板什么都不画，也没有报错

**命令**：`npm run check:panel`
**期望**：`.pf` 都没有的空工作区上，取数成功、四份来源全 `missing`；页脚徽标与浮层各出现一次
（徽标印「可开工 0」，浮层印「这个工作区里没有记录。」）。另有一档「记录在、读不动」：
徽标不画那枚编出来的数，浮层印另一句原因。两档都不许有控制台 error。

**实际读数**

```
ok    空记录的工作区：页脚徽标与浮层各出现一次——徽标印 可开工 0，浮层印「这个工作区里没有记录」  工作区=.\.tmp\panel-check\empty（没有 .pf） ｜ 徽标上="可开工 0" ｜ 浮层上="这个工作区里没有记录。"
ok    记录读不动的工作区：徽标不画那枚数，浮层印「读不动」——不是上面那一档的「没有记录」  工作区=.\.tmp\panel-check\broken（.pf 在、四份读不动） ｜ 徽标上=（不画） ｜ 浮层上="这个工作区里的记录读不动。"
ok    控制台没有 error  0 条
```

---

## 第 7 行 · 边界样本：只有一个出局等人的节点、先失败后成功那一格

**命令**：`npm test`（边界读数在 `tests/model-project.test.mjs` 等模型层用例里）
＋ `npm run check:panel`（面板上那一档「等待处理」）
**期望**：`npm test` 全绿；「只有一个出局等人的节点」读成等待处理正好一条、别处都空；
「同一节点先失败后成功」读成已交付、不读出局等人；面板上换到那条线路时「等待处理」排最前、
浮层印「等待处理 1」。

**实际读数**（`npm test` 墙钟 0.73 s，145 pass / 0 fail）

```
✔ 只有一个出局等人的节点：等待处理那一栏正好一条，别处都空着 (0.112ms)
✔ 同一节点先失败后成功：读成已交付，不读出局等人 (0.1717ms)
✔ 同一节点先失败、重跑那一步以 completed 落停、这一格还没有交付时刻：读作未开始 (0.1219ms)
ℹ tests 145 ｜ pass 145 ｜ fail 0
```

面板那一档（第二份记录里造一个出局等人的格、换到那条线上看「等待处理」）眼下跑不到：记录当前
状态下夹具挑不出能搁出去的格（`blocked=0`），那一条 FAIL、`tools/panel-check.mjs` 里那个 guard
整段跟着跳过——跳掉的是那一整段（**12 条读数**），不只是头三条。同一趟里这两条照旧印：

```
ok    这一份记录有记录、也没有出局等人的格：浮层不画，屏上只剩徽标那一枚数  记录里的出局等人=0 ｜ 徽标上="可开工 0" ｜ 浮层上=（不画）
ok    不含出局等人的那份记录里不出现「等待处理」  记录里的出局等人=0 组头=进行中/已交付 行数=12
```

它与包面无关：这两条断言的判据就是这份记录里的格数与 `blocked` 列，`tools/panel-check.mjs` 也不读
`package.json`。

---

## 怎么重跑

```powershell
cd <项目根>
npm test                                   # 期望：145 pass / 0 fail
npm run check:panel                        # 期望：147 passed / 2 failed（含第 1、2、3、4、6、7 行；那两条见「已知偏差」）
node tools/css-check.mjs                   # 期望：PASS — 9 panel sheets, 24 marks in 2 palettes, 0 failures
pwsh -File tools/testbed/testbed.ps1 -Action up     # 期望：退出码 0，panel / panel row / panel source / panel entries / panel mount 五行都在
pwsh -File tools/testbed/testbed.ps1 -Action check  # 期望：退出码 0，[PASS] 1..5，failed criteria: none
pwsh -File tools/testbed/testbed.ps1 -Action down   # 收尾：stopped : True，不留游离实例
```

按包形态装（发出去的那一份）并让那份工作区里有记录：

```powershell
npm run types; npm run bundle; npm run bundle:client
npm pack --pack-destination .tmp\pack
pwsh -File tools/testbed/testbed.ps1 -Action up -Plugin .tmp\pack\dsh-pathfinder-0.1.0.tgz -SeedRecords .pf
```

第一条 `-Plugin` 换成 `.tgz` 后 `panel` 那一行读作 `<- file:…`；第二条把本仓这份 `.pf` 复制成合成工作区里
的 `.pf`，`up` 另印一行 `records`。（`-SeedRecords` 只在 `up` 里生效，`check` 那一趟不带它。）

`npm run check:panel` 自己重建过程目录（`.tmp/panel-check`）；`npm test` 与 `node tools/css-check.mjs`
都不建过程目录，三条仓内命令也都不读任何手点过的状态；
测试床那一趟整份重建运行实体（项目树之外的 `%LOCALAPPDATA%\dsh-pathfinder-testbed`），主 home 只读。

**不在清单里的**：观感、手感（配色好不好看、点起来跟不跟手）。那一档跑不出读数，归 user 自己看；
这一格的产物是为了让那一步只花眼睛。

## 已知偏差（读数之外的实话）

- 单子里跟着记录当前状态走的那几个读数（会话 id、卡片与胶囊计数、第二份记录里那几条）是写下时那一趟的
  快照；重跑要复现的是每条断言的**标题与判据**，那几个具体数字会随记录往前走。第 0、1、2、7 行与
  「怎么重跑」已按现在的记录核过一遍。

- 合成工作区里默认**没有** `.pf`：测试床那份工作区按上游设计只造目录、一条会话，外加一份**面板不读**的
  `panel-records.json`（约 873 B：3 节点／2 边／2 问题的样本；由 `tools/testbed/testbed-lib.ps1` 造）。
  面板读的是 `.pf`，所以默认那一趟在实例里打开面板是空记录那一屏（上面第 6 行的「这个工作区里没有记录」）。
  要它画出记录，给 `up` 加一个 `-SeedRecords <记录目录>`：它把那一层复制成工作区下的 `.pf`，实例上
  那几手端点当场读得到（实测四份来源全 `read`：12 节点 / 1 条线 / 2 条指令 / 5 个问题）。`check` 不经过
  这个开关（它自己那份 provision 不带 `-SeedRecords`），上游那五条判据的默认那一趟照旧。
- 真实例上的四处座席：装完打开面板，四处都量得到（无头浏览器，控制台 0 条 error）：侧栏那一项、
  中央栏那一格（打开后 `.pf-page` 正文里是记录里的数）、页脚徽标
  `[data-pathfinder="pathfinder.ready-badge"]`（在屏上、印 `可开工 N`，N 就是记录里可开工的格数）、
  浮层 `[data-pathfinder="pathfinder.pending-notice"]`（还没有选中会话时印「还没有选中会话，
  读不出这是哪个工作区。」）。这条取数口子能接上，靠的是包面自己的一行声明
  `dsh.client.inject: ["@deepseek-ai/dsh-client-connection"]`：外壳照它先把 `connection` 那一条
  客户端插件送达，面板才应用。摘掉那行声明，面板应用得早、口子接不上——页脚徽标不画、正文里没有
  记录的数、浮层改印「这个部署上没接上寻路记录的远程端，读数取不回来。」。宿主那一侧的端点
  `/api/pathfinderRecords/read` 照旧是好的（用同一个浏览器 cookie 调它，实测四份来源全 `read`）。
  上面第 1、2、3、4、6、7 行那些面板读数走的是 jsdom 夹具（`npm run check:panel`），不经过浏览器。
- `npm run check:panel` 眼下是 **147 passed / 2 failed**，两条都读这份记录当前的状态：
  「依赖那一格的前置读数」要记录里存在可开工／欠前置的格（现在除进行中那一格以外全部已交付，
  该带那一行的是 0 格）；「第二份记录里挑得出一个能搁出去的格」同样挑不到这样的格（`blocked=0`）。
  这两条与包面无关：判据就是记录里的格数与 `blocked` 列，`tools/panel-check.mjs` 也不读
  `package.json`。这份单子写的时候记录是另一副状态（161 passed / 0 failed），记录往前走了，
  这两条读数就跟着变。