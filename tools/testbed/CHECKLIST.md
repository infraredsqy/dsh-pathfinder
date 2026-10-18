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
- `panel mount` 两处正面读数都在：**正在跑的那个实例**把 `pathfinder` 当设置命名空间服务出去，
  且它交给浏览器的启动名册里列着 `dsh-pathfinder/client.js`。
- 末两行印出「一条命令把会话清单打出来」的那一行 curl（含本次实例的端口与 token）。

**实际读数**（本次实测，`up` 墙钟 **4.2 s**）

```
testbed root : %LOCALAPPDATA%\dsh-pathfinder-testbed
isolated home: %LOCALAPPDATA%\dsh-pathfinder-testbed\home
workspace    : 764d5f73-… 'workspace-alpha' sessions=1 path=…\dsh-pathfinder-testbed\workspaces\workspace-alpha
session      : 8483895b-… -> …\home\sessions\--C-Users-PC-AppData-Local-dsh-pathfinder-testbed-workspaces-workspace-alpha--\8483895b-…\session.v4.jsonl
pid          : 32432
url          : http://127.0.0.1:6329/?token=…

panel        : dsh-pathfinder <- link:C:/Users/PC/dsh-pathfinder
panel row    : - id: pathfinder |   name: dsh-pathfinder
panel mount  : settings namespace 'pathfinder' is served by the live instance (namespaces=22) ｜ boot manifest lists dsh-pathfinder/client.js (page 37620 chars)
panel builds : lib\host\index.js 32415B, lib\client.js 271154B
```

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

**实际读数**（墙钟 7.0 s，161 passed / 0 failed）

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

**实际读数**

```
ok    看板上的数从记录里来：胶囊与三列卡片数逐项对上  记录现算 胶囊=[["已交付",10],["进行中",1],["未开始",1]] 三列=[1,3,0] ｜ 面板上 胶囊=[["已交付",10],["进行中",1],["未开始",1]] 三列=[1,3,0] 总卡=4
ok    依赖那一格：记号、连线、顶栏那三个数与记录现算的逐项对上  记录现算 10 列 · 12 节点 · 17 边 ｜ 面板上 10 列 · 12 节点 · 17 边，记号 12，连线 17
ok    明细的组头按记录长出来  进行中(1)/已交付(10)
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

**实际读数**（`npm test` 墙钟 0.73 s，140 pass / 0 fail）

```
✔ 只有一个出局等人的节点：等待处理那一栏正好一条，别处都空着 (0.1061ms)
✔ 同一节点先失败后成功：读成已交付，不读出局等人 (0.1673ms)
✔ 同一节点先失败、重跑那一步以 completed 落停、这一格还没有交付时刻：读作未开始 (0.1236ms)
ℹ tests 140 ｜ pass 140 ｜ fail 0
```

```
ok    第二份记录里那个格确实出局等人、且挂在这条线上  出局等人=6009423d@lab-line 线数=2
ok    换到这条线上，「等待处理」露面、排最前、行就是那个格  组头=等待处理(1) 行=6009423d-a8c5-4115-acc4-84b567142110
ok    浮层那一句：有出局等人的时候印「等待处理 N」，数就是记录里出局等人的格数  记录里的出局等人=1 ｜ 浮层上="等待处理 1"
```

---

## 怎么重跑

```powershell
cd <项目根>
npm test                                   # 期望：140 pass / 0 fail
npm run check:panel                        # 期望：161 passed / 0 failed（含第 1、2、3、4、6、7 行）
node tools/css-check.mjs                   # 期望：PASS — 9 panel sheets, 24 marks in 2 palettes, 0 failures
pwsh -File tools/testbed/testbed.ps1 -Action up     # 期望：退出码 0，panel / panel row / panel mount 三行都在
pwsh -File tools/testbed/testbed.ps1 -Action down   # 收尾：stopped : True，不留游离实例
```

`npm run check:panel` 自己重建过程目录（`.tmp/panel-check`）；`npm test` 与 `node tools/css-check.mjs`
都不建过程目录，三条仓内命令也都不读任何手点过的状态；
测试床那一趟整份重建运行实体（项目树之外的 `%LOCALAPPDATA%\dsh-pathfinder-testbed`），主 home 只读。

**不在清单里的**：观感、手感（配色好不好看、点起来跟不跟手）。那一档跑不出读数，归 user 自己看；
这一格的产物是为了让那一步只花眼睛。

## 已知偏差（读数之外的实话）

- 合成工作区里**没有** `.pf`：测试床那份工作区按上游设计只造目录、一条会话，外加一份**面板不读**的
  `panel-records.json`（约 873 B：3 节点／2 边／2 问题的样本；由 `tools/testbed/testbed-lib.ps1` 造）。
  面板读的是 `.pf`，这份工作区里没有它——所以实例里打开面板看到的是空记录那一屏：面板确实装着、
  在工作、三处座席都在，只是没有可画的记录（那一档就是上面第 6 行的「这个工作区里没有记录」）。
  拿清单去验收的人打开那份工作区会看见这个 records 文件——它不参与任何读数。
  要看见有记录的那一屏，得先往那份工作区里放一份 `.pf`
  （本格没做：spec 只要求「指着合成工作区」，改上游夹具会动到 `check` 那五条判据的地界）。