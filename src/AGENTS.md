# src/ —— 宿主半身、模型层与浏览器半身：记录读进来、读数算出来、面板画出来

> 本文件是路牌，上限 30 行：只写这一层有什么、什么时候看。

- 这一层有三半：**宿主半身**装在 DSH 宿主上把记录读进来（读面经工作区文件口子，写面经 `pf` 那条命令）；**模型层**把 mock 的读数逻辑搬成纯函数；**浏览器半身**把读数画成主面板。改取数、改边界形状、改界面时看这里
- `host/index.ts` —— 插件入口：装上 `ctx.pathfinderRecords`，一条服务把记录与笔记那几手端点交出去，另交出设置 schema `Config`（住在 `host/config.ts`）。插件名 `pathfinder-records`；`workspaceFiles`／`sessions`／`sandboxPolicy` 三样到齐才 `apply`；起进程的口子不在这三样里，写面现取
- `host/gateway.ts` —— 那条服务本身，也是远端口：每个方法各挂一枚 `Remote` 记号，命名空间就是服务键；会话笔记那一手（`readSessions`）与四份记录走同一条只读口子。**参数表不能带默认值、末尾不能留逗号**——网关按方法源码切参数，两种写法都会让它判成「签名说不清」（`tests/host-gateway.test.mjs` 守着这一条）
- `host/project-config.ts` —— 这个工作区自己的项目设置：`pf config list` 印的那几行读成「值 + 它住哪一层」（出厂默认 / 全局 / 项目），写面认得的那几个键也在这一份里。这一层不判一个值合不合法，那是工具那一侧的判据
- `host/write.ts` —— 写面：一律把 `pf` 那条命令递出去，不碰 `.pf` 下的文件。参数先过一道字符闸；Windows 上经 `cmd.exe` 起 `pf.cmd`，那条命令行里的路径**不能加引号**（Node 会把它拼成 `\"`）
- 工作区根由调用方点名：面板顶上那枚工作区选择器挑中哪个，那个绝对路径就从参数里进来（`rootFor`）；空字符串是「没挑」，那时候才按会话身份解析——次序固定：活着的会话头 → 落盘的会话头 → 沙箱策略记的那个根；有活着的会话头就不再问落盘那份。两种情况都每次调用现算、不缓存
- `host/records.ts` —— 取数：只走工作区文件口子的 `list` 与 `read` 两个动作，对工作区只读；四份来源是节点与线路、线路走过的步、指令、问题池，相对位置写在 `contract.ts` 的 `RECORD_SOURCES` 里
- 记录住在工作区里那层隐藏目录（`.pf`）。一份文件一页一页取全：口子对一页有字节上限、对请求的行数另有一档，这一页被拒就把行数减半重取，只减不增；收到一行也过不去才算真读不动
- 每份来源各报结局：`read`／`missing`／`unusable`。取不到就给空集合、读数照常返回
- `host/sessions.ts` —— 会话身份那条读数：一格最近开在哪条会话上，读的是记录库里按节点分的小份笔记（位置就是 `contract.ts` 的 `RECORD_SESSIONS`）；走与四份记录同一条只读口子，那一层目录不在就交回空清单——换台机器、新克隆一份记录都长成那样。面板拿它比对那条会话此刻在不在本机上。改卡片去哪时看
- `host/contract.ts` —— 边界形状：记录里原有字段的直通副本，另写着会话笔记那一层目录的位置（`RECORD_SESSIONS`：会话身份是这台机器自己的事，它不住在记录本体上）。字段一个都不改名、不换算、不折算时刻
- `model/` —— 模型层：四份记录原形＋一个时刻 → 那一刻的读数（项目、依赖场、指令、问题池各一份，分别在 `project.ts`／`graph.ts`／`instructions.ts`／`pool.ts`）；不取数、不碰 DOM。旧一版记录把会话写在节点自己身上（`dsh_session`），照 `NodeReading.session` 原样带出来——新一版把它挪进笔记，所以面板两处都认（笔记优先）。类型检查 `npm run types:model`
- `host/config.ts`、`host/settings-fields.ts`、`cordis.patch.yml` —— 设置面：这一行插件就是一个设置命名空间（命名空间＝`cordis.patch.yml` 那条 `- insert:` 的 id `pathfinder`，浏览器半身写着同一个字，两边没有第二处校验）；字段名、出厂默认与取值集合只写在字段表里；`Config` 五个字段全标 volatile（设置服务只投影 volatile 字段），`@deepseek-ai/schemastery` 由宿主提供、取不到时 `Config` 是 `undefined`——这一行照旧装得上，只是没有设置表单。改偏好字段或加一行时看
- `client/` —— 浏览器半身：面板本体（`panel.tsx`：壳＋六格标签；那个工作区里没有这份记录、或者四份来源一份也读不出来时，标签与右上那排计数一起收走，正文只留一句话（`.pf-none`）；当前 / 明细 / 指令三格在里面，依赖与问题两格各自的看法住在 `field.tsx` 与 `pool.tsx`，设置那一格是这个工作区自己的项目设置，画在 `config.tsx`（四行那张表与那一列的宽窄住在 `config-rows.ts`），读写都经工具那条命令）、与宿主说话那条口子（`data.ts`）、面板自己的偏好（`prefs.ts`：设置文档这一节与面板读数之间的映射，经设置表单读写，面板自己的键不再写本地存储、接上设置表单时把旧版那四个键扫掉）、设置里那一节（`settings.tsx`：`settings.section` 上的一条幂等注册，既是导航行也是它打开的那一页）、面板那几张样式表（`styles.ts`，正文由构建期从 `mock/` 取进来）、入口 `index.ts`（类型检查 `npm run types:client`）。它交出的 `ctx.pathfinderPanel` 是 id＋title＋`Panel`＋`port`＋`prefs`（面板与设置页读同一份表单）
- `client/workspaces.ts`、`client/panel.tsx` 顶上那枚选择器 —— 调度中心是独立于左侧工作区栏的一处地方：所有工作区对它都是可以打开的对象，只是某个工作区里有没有这套记录得读一遍才知道。`workspacesAt` 取 DSH 那份清单（`ctx.workspaces.list` 的 `getSnapshot` ＋ `subscribe`），`bucketOf` 认「这条会话落在哪个桶里」；`panel.tsx` 顶上那枚 `.pf-pick` 列出各工作区的标题＋末尾一档「未分组」，默认停在会话落的那个桶，挑中的那一个只活在这一屏上，递给宿主的是它的绝对路径（未分组递空字符串）。改这枚控件或改「读哪个工作区」时看
- `client/data.ts` 的 `readSessions`、`client/panel.tsx` 的卡片两档 —— 面板那条口子多一手「这个工作区里每一格的会话笔记」（远程 / 载体 / 没接上三档都补齐）；看板卡片分两档：记录里那条会话此刻在这台机器上，卡才点得动（点下去切到那一格），不在、或哪儿都没写会话，卡片是 `.pf-card.is-inert`，安安静静地摆着。改卡片去哪、改会话身份怎么认时看
- `client/mount.ts` —— 调度中心在 DSH 自己那两处位置上的挂载点：侧栏一项（`sidebar.panellist`，order 1，名字「调度中心」）、中央栏那一格（`main`，key 与侧栏同一个 id）；`knownSessionsOf` 从同一份 `useSessions` 快照算出「这台机器上此刻有哪些会话」的名册，`createSessionNav` 是 DSH 那条导航口子（`ctx.uiWorkspace.openSession`）的薄壳——它只管切，去处有没有由面板拿名册自己对，中央栏那一格的注入面因此多一手 `openSession`；`createWorkspaceNav` 同路把那份工作区清单交出去（那一手 `workspaces`）。两条注册与两张样式标签的摘除都挂在同一条 `effect` 上。两处一律走 `slots.inject('<槽位>', …)`，不等插件次序。`client/style-tags.ts` 管两张表的记号与挂/摘
- 单测在 `tests/`（宿主＋模型＋浏览器半身的数据面 / 会话面 / 写面 / 项目设置面 / 偏好面 / 工作区面 / 两处挂载点），`npm test` 一条命令跑全；面板那一块的自证夹具是 `npm run check:panel`