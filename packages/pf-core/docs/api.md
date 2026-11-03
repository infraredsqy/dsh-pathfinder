# pf-core 接口面

这份文件是本包接口面的唯一参照。名字与签名已经冻结，不另行改名；改动要先过指挥者。

- `open(root, options?)` 交回一个 `pf` 句柄，里面是 `ledger` / `conductor` / `config` /
  `sessions` 四个命名空间；`options` 的形状是 `PfOpenOptions`。
- `PfOpenOptions { executor?: Executor }` —— 执行的唯一注入点；不传执行者时，`conductor.dispatch`
  直接抛错，记录一个字节都不动。git 不走这里：`ledger.init`、`ledger.register` 与 `conductor.doctor`
  每次调用自带一个 `git`（形状就是 `src/git.ts` 里的 `GitRunner`），句柄上不存 git；哪一次调用不传，
  那一次问 git 的部分就不问（doctor 的合并驱动一格只说没问，不判红）。
- `Pf { root: string; ledger; conductor; config; sessions }` —— `root` 是打开时给的项目根，原样保存。
- `pf.ledger.dag` 十四动词、`pf.ledger.cycles` 十一动词、`pf.ledger.instructions` 五动词、
  `pf.config` 四动词、`ledger.init` / `ledger.register`、`pf.sessions` 两动词与
  `conductor.next` / `conductor.close` / `conductor.dispatch` / `conductor.doctor` /
  `conductor.handoff` 都在句柄上，全是真实现；没有一个桩。
- 动作路径即 API 路径：`ledger.dag.add` 这样的动作路径，同时就是将来 API 的命名空间路径——
  按这个拼写找方法，从句柄一路点下去就能到。

## 运行时导出

```text
SimulatedExecutor
open
```

运行时出口就这两条。包另有一个进程入口 `pf-merge-ledger`（`package.json` 的 `bin` 里只有这一条，
产物是 `dist/merge-ledger.mjs`）：git 的合并驱动只能靠进程叫，它是边界上唯一那个例外，做的是
argv 与退出码的搬运，一条合并规则都不在它里面。

## pf.ledger

记录目录（`.pf/`）的读写入口。

| 动作 | 签名 | 一句话语义 |
| --- | --- | --- |
| `ledger.init` | `init(options?)` | 为项目立起 `.pf/` 记录目录，交回这一次做了什么的读数 |
| `ledger.register` | `register(options?)` | 把合并驱动的两个 git config 键写进本项目（`[merge "pf"]` 一节）；不是 git checkout、或没给 git 时静默跳过 |

### pf.ledger.init 与 pf.ledger.register

`init(options?)` 的选项是 `LedgerInitOptions { force?; layout?; git? }`。

**两档布局，只有两档。** `layout` 缺省 `'own-repo'`：`.pf` 不在项目仓库里，项目仓库的
`info/exclude` 里有一行把它挡在外面；`'in-repo'`：`.pf` 随项目仓库走，那一行被抽掉。引擎不建
也不删 `.pf` 自己的仓库——`git init .pf` 是人的动作；`.pf/.git` 在场时它只报读数（切到 in-repo
时点名「历史不会随项目走」）。两档各自幂等，来回切也幂等。

**底线先落，附加件后做。** 四份布局文件（`.gitignore`、`.gitattributes`、`AGENTS.md`、
`config.json`；`config.json` 只在缺席或 `force` 时写）在任何环境里都落——没有 git、不是
checkout，都一样；字节不同就从常量重写，一样就一个字节不碰。自有仓库的读数、`info/exclude`
那一行、合并驱动的两个键是三件附加件：做不成就往 `warnings` 里点名，不抛、不回滚。

**交回 `InitReport`**，字段与取值就是下面这些：

| 字段 | 取值 |
| --- | --- |
| `layout` | `'own-repo' \| 'in-repo'` |
| `written` | 这次真写了的布局文件名 |
| `ownRepo` | `'present' \| 'skipped' \| 'skipped-no-git'` |
| `exclude` | `'written' \| 'removed' \| 'skipped-not-a-checkout' \| 'skipped-not-own-repo' \| 'failed'` |
| `mergeDriver` | `'written' \| 'skipped-no-config'` |
| `warnings` | 每一件没做成的附加件一条人话：没做什么、为什么、`.pf` 现在是什么状态 |

`exclude` 的落点问 git 要：`git rev-parse --git-path info/exclude`（引擎不自己拼 git 的目录布局）；
行本身是 `/<项目根相对仓库根的路径>/.pf/`，那个前缀从 `git rev-parse --show-prefix` 来，所以同一个
仓库里的几份 `.pf` 各写各的行，别家的行一个字节都不动。

`register(options?)` 只做那两个键：`merge.pf.name`（git 给驱动看的标签）与 `merge.pf.driver`，
都经 `git config --local` 写（config 文件的锁与原子性归 git）。命令串在写的时候现算；不是
checkout、没给 `git` 或者 git 拒绝时静默跳过，不抛。

### pf.ledger.dag

图：节点与边的读写，十四个动词。

| 动作 | 签名 | 一句话语义 |
| --- | --- | --- |
| `ledger.dag.add` | `add(input)` | 登记一个节点：标题必填，依赖、标签、模式、重量可选 |
| `ledger.dag.remove` | `remove(id, options?)` | 把节点取下图，它的会话档一并删掉；还有依赖者时拒绝，除非 `force` |
| `ledger.dag.update` | `update(id, patch)` | 改节点的标题 / 描述 / 模式 / 标签 / 重量 |
| `ledger.dag.link` | `link(id, dependsOn)` | 加一条依赖边；自查环，成环即拒绝 |
| `ledger.dag.unlink` | `unlink(id, dependency)` | 摘一条依赖边 |
| `ledger.dag.setStatus` | `setStatus(id, status)` | 改状态；落 completed 时写完成时刻，离开即摘除 |
| `ledger.dag.approve` | `approve(id, at?)` | 记人对本次交付的认可；时刻不得早于完成时刻 |
| `ledger.dag.revive` | `revive(id)` | 把 shelved 的节点放回 todo |
| `ledger.dag.get` | `get(id)` | 读一个节点的记录；不在图上时为 `null` |
| `ledger.dag.context` | `context(id)` | 读上下游传递闭包 |
| `ledger.dag.search` | `search(query, options?)` | 按正则搜标题与描述，标题命中排前 |
| `ledger.dag.list` | `list(filter?)` | 按状态 / 就绪 / 标签列出，重要与紧急排序 |
| `ledger.dag.specPath` | `specPath(id)` | 节点 spec.md 的落点路径 |
| `ledger.dag.validate` | `validate()` | 查环、悬空引用与重复边；孤立点点名不翻红 |

### pf.ledger.cycles

线：一条工作线的立、跑、停、收，十一个动词。

| 动作 | 签名 | 一句话语义 |
| --- | --- | --- |
| `ledger.cycles.create` | `create(input)` | 立一条线；拾取范围（`tags`）必须声明 |
| `ledger.cycles.start` | `start(input)` | 立线并按规则钉住开线的节点 |
| `ledger.cycles.rename` | `rename(id, title)` | 改线的标题 |
| `ledger.cycles.setStatus` | `setStatus(id, status)` | `active` 该往前推 / `inactive` 不推 |
| `ledger.cycles.setPolicy` | `setPolicy(id, key, value)` | 写线自己的策略，交回整个有效集 |
| `ledger.cycles.list` | `list()` | 全部的线 |
| `ledger.cycles.current` | `current()` | 现在该干活的线；多条在服务时拒绝点名；没有时为 `null` |
| `ledger.cycles.show` | `show(id)` | 一条线的完整记录 |
| `ledger.cycles.hold` | `hold(id, node)` | 认领一个节点进这条线的在册名单 |
| `ledger.cycles.close` | `close(id, input)` | 结算一步：判决进 path，认领放下 |
| `ledger.cycles.retry` | `retry(id, node?, options?)` | 撤旧票、改写 pending，线册不动；`{ drop: true }` 连认领一起摘掉，会话已经死掉时重来要的是这一档 |

线自己的策略键：`when_shelved`（节点没交付被放下时停线还是继续）、`parallel`
（同时认领几个节点，缺省 1）、`spawner`（用哪个宿主开会话，只写词）；其余是插件声明的旋钮。

### pf.ledger.instructions

指令：用户指令通道，五个动词。

| 动作 | 签名 | 一句话语义 |
| --- | --- | --- |
| `ledger.instructions.add` | `add(input)` | 登记一条指令；正文与范围必填，绑定随范围走 |
| `ledger.instructions.list` | `list(filter?)` | 生效中的指令；可放宽到连已归档的也一起给 |
| `ledger.instructions.resolve` | `resolve(id)` | 结清一条指令（落结清时刻） |
| `ledger.instructions.revive` | `revive(id)` | 把已归档的指令重新生效 |
| `ledger.instructions.remove` | `remove(id)` | 把指令摘走，留 id 与时刻的痕迹 |

## pf.config

设置：一条解析链上的读写，四个动词。链上窄的盖宽的：node（`<root>/.pf/nodes/<节点>/config.json`）
→ cycle（线记录的 `policies` 槽）→ project（`.pf/config.json`）→ global（`<home>/.pf/config.json`），
最底下是旋钮声明里的出厂缺省。

`ConfigLayer` 一次点一层，四种拼法：`{ project: true }`、`{ global: true }`、`{ cycle: '<线 id>' }`、
`{ node: '<节点 id>' }`。`set` / `unset` 必须点名那一层——没有缺省层（一次点名零层或两层当场
`TypeError`）；点名的线 / 节点不在记录上也当场拒绝，绝不为调用方造层。

| 动作 | 签名 | 一句话语义 |
| --- | --- | --- |
| `config.get` | `get(key, at?, dir?)` | 读一个设置项、到点名那一层为止的生效值 |
| `config.set` | `set(key, value, at, dir?)` | 往点名的那一层写一个设置项 |
| `config.unset` | `unset(key, at, dir?)` | 撤掉点名那一层的设置项，露出下一层 |
| `config.list` | `list(at?, dir?)` | 到点名那一层为止的全部设置，每一项都是 `{ value, source }` |

`get` 与 `list` 都交回 `ConfigReading { value: ConfigValue | null; source: ConfigSource }`；
`source` 是五个词之一：`node` / `cycle` / `project` / `global`，或 `builtin`——链上没人说话，
生效的是声明里的出厂缺省。`get` 交回一条读数，`list` 交回 `Record<string, ConfigReading>`；
`get` 没有值可交时 `value` 是 `null`（只有插件声明的旋钮可能这样），`source` 照样说清是哪一层。
不点名 `at` 时读两层宽层（global → project）。`list` 没有键可拒，就照那一层往上给：旋钮不收那一层的，
读数来自它下面那层。

四个动词都带一个可选目录 `dir`：缺席时用句柄自己的项目根。无论哪种，那个目录都得自己有一份
`.pf`——没有就是 `not_a_project`，不会往上找更宽的目录。句柄自己的根也不豁免：fork 档的节点在
自己的 worktree 里干活；own-repo 档下那份 worktree 里没有 `.pf`，在那里问设置得到的是「这不是
pf 项目」，主树的设置一个字都漏不出来（in-repo 档记录随检出走，问的是那个 worktree 自己的记录）。
相对路径按进程当前目录解。

值的种类四种：`number`（正的数值）、`integer`（正整数）、`word`（词汇表里的词）、`switch`（`on` / `off`
两个词），读写两侧过同一道校验门。写侧不合种类当场拒绝（`invalid_value`），什么都没写；线层骑在线
记录上，认不出的值当没说。

旋钮名得在清单上，否则 `unknown_key`（拒绝里把可配的名全列出来）。核心内置四个：

- `max_agents`（`integer`，缺省 3）：一个会话同时在飞的子代理上限。
- `test_tier`（`word`，`full` / `minimal`，缺省 `full`）：验证档位——full 跑全套，minimal 只跑点名的检查。
- `worktree_mode`（`word`，`off` / `fork` / `reuse`，缺省按项目算：git 项目 `fork`，其余 `off`）：
  节点要不要自己的 worktree。`reuse` 在词汇表里，但这台引擎只在 `off` / `fork` 两档里干活，
  按模式读它、读到 `reuse` 就拒绝（`worktree_mode_unsupported`）。
- `session_host_override`（`switch`，缺省 `off`）：打开时所有会话条目都按 `dsh` 读，写下的宿主不看。

前三个只收 project / global 两层（`layer_not_allowed` 的拒绝里点名它收哪几层）；`session_host_override`
只收 global 一层——这个开关是关于整台机器的决定，跟着那台机器走。其余旋钮由插件声明，顺着整条链收。

出厂缺省的规矩，只管引擎自己的声明：每一项都带一个缺省（字面量，或按项目根现算的函数）——缺了它、
写成 `null`、或字面量与自己的种类不合，合并清单的那一刻就拒绝并点名那一项（那是声明问题，抛
`TypeError`），所以核心设置不会读到「没配」，那个缺省的 `source` 就是 `builtin`。插件声明的格子不走这道门，
但 `default` 一样必填：写 `null` 才是「没有出厂值」，字段缺席是声明问题。

读侧被拦住的就是这几处，再没有别的：那个目录自己没有 `.pf`（`not_a_project`，四个动词都先查
它）、`get` 点了一个不在清单上的名（`unknown_key`）、旋钮不收那一层（`layer_not_allowed`）、
点名的线不在 `state.json` 里（`cycle_not_found`）、点名的节点不在图上（`node_not_found`）、一个节点
被两条线同时认领（`ambiguous_holder`），以及一层文件读不动或解析不了（`invalid_utf8` /
`parse_failure` / `invalid_config_file`）。其余关于文件的情形一律沉默，因为它们不改变任何读数：文件
里出现认不得的名字（插件被摘掉了、键改过名）、名字落在不收它的层里、值不合种类，三者都跳过——
生效的是下一层，或声明的出厂缺省。这些错写侧才是逮它们的地方：`set` 当场拒绝收不下的层、不认识的
名、不合种类的值。点名层本身写错（零层、两层）不属于上面这些，是 `TypeError`。

节点层的读数落在那条认领该节点的线上：没有线认领就跳过线层，两条线同时认领就是 `ambiguous_holder`
（一个节点一次只归一条线，不猜是哪条）。写节点层前会再查一次节点还在不在图上：检查与落盘之间夹着
一次 `dag.remove` 时，不会把那个目录又造回来。

## pf.sessions

会话档的只读入口，两个动词。

| 动作 | 签名 | 一句话语义 |
| --- | --- | --- |
| `sessions.list` | `list()` | 全部会话档，按节点给 |
| `sessions.show` | `show(node)` | 一个节点的会话档；没写过时两个名单都是空的 |

会话档住 `.pf/meta/sessions/<节点>.json`（会话 id 是本机的东西，不进记录）。读侧一律容忍：
文件缺席、读不动、版本认不得，三者都读作「没写过」，两个名单都是空表；条目里没有会话 id 的
丢掉，时刻认不得就是 `null`。宿主按写下来的那个词认：写下的宿主被信任，缺席读作 `dsh`，认得的
只有 `dsh` 与 `zcode` 两个词，任何别的词当场停下这一档的读（`unknown_session_host`）并点名那个
词——不拿会话 id 的形状去猜。`session_host_override` 打开时写下的宿主根本不读，每条都按 `dsh`
读（那个开关只收 global 一层，缺省 `off`）。`list` 只给说得出一句的档（两个名单都空的不进清单），
按节点 id 排；读宿主用的那条解析链对整份清单只走一次，写了一个不认得的宿主的档只丢它自己——
别的条目照常给出（`show` 到那个节点还是当场拒绝并点出那个词）。
`show` 认全 id 与唯一前缀：前缀认出多个节点、或一个都认不出，都当场拒绝，不替调用方猜。

## pf.conductor

流水线：推线走的一组动作，五个动词。

| 动作 | 签名 | 一句话语义 |
| --- | --- | --- |
| `conductor.next` | `next(input?)` | 读一份只读规划：下一步该干什么，不执行、不写记录 |
| `conductor.dispatch` | `dispatch(input?)` | 把节点交给一个会话，交回收据 `DispatchReceipt { action; cycle; node_id; node_title; prompt; prompt_text; session? }`；`action` 只有 `opened` / `already_open` 两个词 |
| `conductor.handoff` | `handoff(input)` | 写一张交接单，落在 signals 下的「线 id / 节点 id」 |
| `conductor.close` | `close(input?)` | 收线结算 |
| `conductor.doctor` | `doctor(options?)` | 体检：记录齐全、引用不悬空、没有成环 |

五个动词的口径：`next` 是只读规划；`dispatch` 是整段派发——先读这一格（线、节点）的
`started` 记号：它已经在盘上就直接答 `already_open`（不碰执行者、不写一个字节；`session`
缺席，那张收据属于当初开出它的那次调用），否则先过插件的拦下缝（任何一家拦就是拦，错误码
`dispatch_blocked`，理由逐条列在错误文案里），再做派发准备（提示词落盘、运行稿立在节点目录、
交接单模板随材料交回；线配了 `source: ticket` 的读数且门上有生效值时，模板多带一格 `reading`），
绿灯才把请求交给注入的执行者。交回的只是收据：`opened` 带 `session`，说的是会话已经开着；
节点的收场由 worker 写交接单、再由 `close` 结算。记号随之落盘，规划从此把这一格算作在飞，
不再派第二遍；执行者缺席或抛出时，记号不落、记录一个字节都不动。记号写不下去当场抛出：
会话已经出去了而盘上没有凭证，文案带会话 id，并说清再派一次会开出第二个会话；凭证落盘
之后才回成功。`handoff` 把交接单落盘：线要在册、节点要在认领名单里（否则 `not_holding`，
什么都没写就拒绝），判决词只收 `completed` / `failed` / `stopped`（`pending` 是重跑的记号），
票据落在 `signals/<线>/<节点>.json`，同一节点的第二张票整文件顶上。`close` 收线结算：节点不在
认领名单（`not_holding`）、交接单缺席或还是 `pending`（`nothing_to_settle`）都是红灯，一个字节
都不动；结算判据与规划共用同一份——判决进 path、认领放下、节点落 `completed` / `shelved`，
补槽的一格一钉，决定停的把线转 `inactive`（线不在服务中时只记录，线的状态一个字不写）；结算的记录写入全程持锁：
插件那一半（扫描、载入、逐个询问）在拿锁之前走完，基于同一份现场（线、交接单、图快照），
插件答多久都不占着锁；进锁后线与交接单各重读一次，结算按重读的这份算，
动过的记录先留字节快照，中途失败按快照放回去；收尾插入缝在结算之后跑。
`doctor` 两半都接：插件面是严格面——装上的插件先逐插件列一条（名字、摘要、旋钮、标签、
方法、来源与命令，全从声明读出），再逐条列坏点；记录面四格——`init` 的四份布局
齐不齐、图有没有环与悬空引用、线手里的节点还在不在图上，以及合并驱动的两个键在不在本项目
的 git 配置里（这一格要一台 git：`doctor(options?)` 的 `options` 是
`ConductorDoctorOptions { git?: GitRunner }`，与 `ledger.init` / `ledger.register` 一个形状；
这一次调用没给 git、或这里不是 checkout，那一格只说没问、不判红；丢给 git 的每一问都带一个
上限，到点没答这一格判红——问的是哪条 git 命令、上限多少、实等多久都点出来，没读到的注册
不当作在场，下一步该怎么办也一并说清，其余格子照常算完，不被这一格拖住）。
没有 `.pf/` 的新项目不算红，那一格只说该跑一次 `ledger.init`。

### 只读规划（`conductor.next`）

`next` 读图、线、指令、交接单与派发记号，算出「下一步该干什么」，一个字节都不写：它不持锁、
不认领、不写 prompt、不碰执行者。要把下一步做出去，路是 `conductor.dispatch`——`next` 这条
路上没有执行的岔口。回答本身就是一份计划：挑中谁、为什么是它、被谁挡在外面、这一步之后停
在哪儿。

动作是六个词之一：`dispatch`（节点与它的 prompt 落点都齐了，交给执行者）、`open_node`（线手
上还没有节点、或收尾空出了槽，该把排序挑出来的那几个钉下来）、`stop_pipeline`（没得做了 /
有人叫停 / 这条线不在服务中）、`wait`（时候没到：交接单还没结果或还是 `pending`、会话已经
开出去了）、`ask_user`（状态自己说不清）、`no_cycle`（一条线都还没有，开线是人的意思）。

- **ready 与 running 是读出来的标签**：ready = 自己是 todo、依赖都交付（悬空依赖视同交付）、
  且没有别的线拿着；running = 某条线此刻拿着的 todo。盘上只有三态与线的 `holding`，两个标签
  互斥、读的时候算，谁也不解释谁。
- **挑点只有一份排序**：紧急乘重要的全量次序从 `ledger.dag.list` 拿，规划只按就绪、这条线
  自己的选材范围（`tags`）与别的线的持有删行；一条线一次挑到 `parallel` 所容的槽位，被挡在
  外面的分开说明原因（标签藏了 / 别的线拿着），并列按图上已有的稳定次序。
- **停手只有一处**：停手位由节点自己的 `mode` 定（`checkpoint` 收尾即停、`manual` 的闸在会话
  里、`auto` 收尾就开下一个），边界指令的 `stop_after_nodes` 只能把停的规则收紧、不能放宽；
  线自己的 `when_shelved` 决定节点没交付之后这条线走不走。
- **计划交动作，不交写侧的命令**：收节点、落 prompt、钉下一个这些机械步留在动作身后，计划
  只把「还没跑」这件事说成 `settling`。

问法（`NextQuery` 的可选字段，都可不给）：`cycle` 点名一条线；`plan` 明写「只读这一档」，只
收 `true`——写 `false` 当场拒绝，因为执行归 `conductor.dispatch`；`after` 点名一个已经交回
交接单的节点，问「按它收，这条线会走到哪」（收尾预演，只算不写）；`decision` / `note` /
`node` 是收尾那一步的答案：继续或停下、一句理由、改点名哪个节点。

## 插件

插件让引擎在固定的时机做固定的事；引擎不实现任何具体插件。一个插件是插件目录（缺省
`<root>/plugins`，一个插件一个文件夹）里的一个文件夹：一份纯数据的声明 `plugin.json`、一个
实现入口 `impl.mjs`，自带技能（`skills/<语言>/<方法>/SKILL.md`）也住在文件夹里、随插件装与
卸。装载只读声明、绝不执行它，时机的门才调用实现；实现装进本进程，插件命令也在本进程内
跑，不联网、不启动外部进程。

- **闭集校验**：声明的顶层键与每格的键都过闭集，未知键拒绝；声明可以列旋钮、读数、度量、
  来源、文件与命令。旋钮格必带 `kind` 与 `default`：`default` 写 `null` 表示这一格没有出厂值，
  写具体值就按它当出厂值（种类不合同样是声明问题）；字段缺席也是声明问题，整个插件不可用——
  不只是这一格落空。时机只有两个（close 收尾 / dispatch 派发），与动作（insert 插入 /
  block 拦下）合成一格才算数——close 只能插入，dispatch 只能拦下，声明出表外的格子、
  或只写时机不写动作，都是声明问题。
- **两道门**：收尾插入——插件交一份 offer（节点标题、标签、正文），经核心机制落图，
  节点、spec.md、依赖边都成为图的一部分；派发拦下——各家各交一句理由，任何一家拦就是拦
  （错误码 `dispatch_blocked`，理由逐条列在错误文案里）。插入只发生在收尾这一步：`next`
  是只读规划，不写记录、不插节点。
- **运行时容忍、doctor 严格**：坏插件在运行时折成一句 WARNING、这一轮不出力，主流程照常；
  doctor 把坏点逐条列出——声明、实现装载、自带技能、认领的来源，外加对着替身项目把实现
  真实问一遍（声明配了门而实现缺入口、答非所问都算坏点）——另报两张撞名表：插件旋钮撞
  内置设置名、插件命令撞核心动词，都是核心赢并报告。
- **宿主上下文**：插件在一个时机看到的是调用方已读好的现场（线记录、手里的节点、交接单、
  图快照）加几样能力：按名字取旋钮（走 `pf.config` 的整条解析链，插件声明的旋钮并入同一张
  清单）、取读数、按标签取节点、在本进程内跑一个插件命令（交回它是否真的跑起来了：词没人
  认领、实现没有入口、命令抛错都是没跑起来；跑完而没答文本仍算跑起来了）、节点 spec.md
  的落点。插件可用 `enable_knob` 挂自己的开关，开关解析出 off 就整轮跳过。
- **出口**：插件契约的类型经 `src/index.ts` 按类型出口。

## 执行者接缝

- `interface Executor { dispatch(request: DispatchRequest): Promise<OpenedSession> }` ——
  引擎之外的执行只从这里交进来；接口上没有拉起进程、打开会话的入口。派发把节点交给一个会话，
  promise 在会话**开着**的那一刻结束：节点的结果由 worker 写成交接单、再由 `close` 结算。
- `class SimulatedExecutor implements Executor` —— 模拟开出一个会话：按次序交回 `sess-1` /
  `sess-2` …，并把收到的每次派发请求记在 `dispatched` 里；脚本是 `'open'`（缺省）、`'throw'`
  （开不出会话就抛）或 `'hang'`（永不落定），给函数就按请求与序号逐次现算。
- `DispatchRequest { cycle?; node?; role?; prompt }`，`OpenedSession { sessionId?; host? }`。

## 可判定错误码

错误码就是契约，文案由调用方自己写。`PfError` 带 `code`（下面这些词）、`path`（出错时面对的那份
记录或那把锁）与 `message`；`isPfError(value, code?)` 只读 `code`，不碰文案。

| 层 | 错误码 | 什么时候 |
| --- | --- | --- |
| 底座 | `invalid_utf8` | 读到的字节不是 UTF-8 |
| 底座 | `parse_failure` | 字节是 UTF-8，但 JSON 解不动 |
| 底座 | `lock_timeout` | 等锁到上限都没拿到，什么都没改 |
| 设置 | `unknown_key` | 旋钮名不在清单上（拒绝里把可配的名全列出来） |
| 设置 | `invalid_value` | 值不合种类：写侧拒绝，什么都没写 |
| 设置 | `layer_not_allowed` | 这个旋钮不收要写 / 要读到的那一层（拒绝里点名它收哪几层） |
| 设置 | `cycle_not_found` | 点名的线不在这个 `state.json` 里 |
| 设置 | `node_not_found` | 点名的节点不在图上，或它的拼法当不成一个节点目录名（分隔符、`.` / `..` 都当不成路径）；空 id 不归这个码——它在更早的层参数校验里就是 `TypeError` |
| 设置 | `ambiguous_holder` | 一个节点被两条线同时认领，节点读数落不到线层：不猜是哪条，线层不读 |
| 设置 | `not_a_project` | 交给设置动词的那个目录自己没有 `.pf`（不往上猜） |
| 设置 | `invalid_config_file` | 那一层文件的 JSON 顶层得是一个对象（键 -> 值），别的形状报这个码 |
| 设置 | `worktree_mode_unsupported` | 按模式读 `worktree_mode` 读到的不是 `off` / `fork`（`reuse` 一读到就拒绝）；模式原样交回，什么都没改 |
| 会话档 | `unknown_session_host` | 会话条目写了两个词以外的宿主；点名那个词，不拿 id 形状去猜 |
| 流水线 | `dispatch_blocked` | 派发被插件的门拦下（理由逐条在文案里，什么都没改） |
| 流水线 | `nothing_to_settle` | 收线结算被拒：这个节点的交接单缺席或还是 `pending`，没有判决可结算 |
| 流水线 | `not_holding` | 点名的节点不在这条线的认领名单上：票没处写、这条线没东西可结算 |

其它磁盘失败（权限、路径越界……）按 Node 自己的错误抛：那些本来就带可判定的 `code`，底座不再
叠一层词汇。

## 冻结的记录类型

六种记录的形状（类型、键名、取值词汇）在 `src/types.ts`，落点如下：

| 记录 | 落点 |
| --- | --- |
| 节点 | ideas.json 的 `nodes` 表值 |
| 线 | state.json 的 `cycles` 表项 |
| 指令 | instructions.json 的 `instructions` 表项 |
| 问题 | issues.json 的 `issues` 表值 |
| 交接单 | signals/&lt;线&gt;/&lt;节点&gt;.json（整个文件就是一条记录） |
| 会话档 | meta/sessions/&lt;节点&gt;.json |

时刻有两种拼写，都是 UTC 加字面 `Z`：微秒形用于节点与问题的时刻；秒形用于线、交接单、
指令与会话档。
