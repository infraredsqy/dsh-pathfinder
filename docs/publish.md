# 发布与安装

> 这页只写**做法**与**已知限制**：这个包怎么发出去、别人怎么装进来、装完怎么核。
> 它写的是**通用口径**，每次发版本都适用；某一次发布里的临时问题、清理残留的事项不进这页。
> 包名与仓名都是 `dsh-pathfinder`，侧栏那一格叫「寻路中心」，DSH 设置里那一节叫「寻路配置」。

## 交付形态：预构建产物随包走

用户端不跑构建。三份产物在本仓构建一次：

```sh
pnpm install --frozen-lockfile
npm run types          # lib/types/**（宿主入口的类型）
npm run bundle         # lib/host/index.js（宿主半身）
npm run bundle:client  # lib/client.js（浏览器半身）
```

这三条绑在 `prepack` 上，`npm pack` 与 `npm publish` 会自己跑一遍。

`package.json` 的 `files` 只收两个运行时入口、`lib/types/**/*.d.ts`、`locale/*.json`、
`cordis.patch.yml`，于是 `npm pack` 出的那一个 `.tgz` 就是分发件本身（`lib/client-body.js` 是浏览器
那一步的中间件，构建脚本用完当场删掉，不进包）。三个口子：

| 口子 | 落点 | 谁用 |
|---|---|---|
| `.`（`main`） | `lib/host/index.js` | 宿主半身：装成 `ctx.pathfinderRecords`，那几手端点经网关交出去 |
| `./client` | `lib/client.js` | 浏览器半身：`dsh.client.platform` 是 `web`，外壳按启动名册去拉这一份 |
| `./locale/*.json` | `locale/{zh,en}.json` | DSH 的插件清单读它来印这一行的名字与说明；与面板自己的对照表是两处（那份在浏览器包里，说面板上的词） |

`dsh.bundle.patch` 指着 `./cordis.patch.yml`（一条 `insert`，行 id `pathfinder`）。装进一个 profile 时
`dsh plugin add` 会把这一层并进那个 profile 的 `dsh.profile.bundles`，profile 自己的
`cordis.patch.yml` 照旧可以按 id 把这一行关掉。

`./client` 那一条还带两行加载依赖：

```json
"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-locale"] } }
```

**这两行都不能摘**：外壳照启动名册先送达 `connection` 那条客户端插件，再应用本包的面板，浏览器半身
那条取数口子才接得上。摘掉之后面板应用得早，中央栏那一格正文里没有记录的数，摆的是「该部署未连接
寻路记录服务，无法读取记录。」（宿主那一侧的端点 `/api/pathfinderRecords/read` 照旧是好的）。
`locale` 那条管的是语言：不声明它，面板照样画得出来（语言端口会退回包里那份中文对照表），但跟随 DSH
设置切换语言这一条就接不上了。

`engines.dsh` 那段范围收得很窄，出处是 `package.json`：宿主半身有一处**运行时的**外部依赖
`@deepseek-ai/dsh-typert-protocol`（与 DSH 本体锁步同版本发布），0.2.x 里换一个 rc 它就可能动；要放宽
得先在那个 DSH 上重量一遍。

包面那几条前提由 `tests/package-surface.test.mjs` 看着（`npm test` 跑）。改包面之后跑一遍。

## 打一个包

```sh
npm pack --pack-destination .tmp/pack
```

`npm pack` 不需要登录、不改仓；`.tmp/` 不进版本库。产物清单从 `.tgz` 自己列：`tar -tzf <路径>` 就
够（在 `.tmp/pack` 里用叶子名也行）——Windows 上若跑的是 Git 带的那套 GNU tar，绝对路径要写成
`tar --force-local -tzf <路径>`，且 `--force-local` 必须排在短选项前面。

同一份内容打出来的 `.tgz`，sha256 是稳定的（`npm pack` 把归档里每个成员的 mtime 归一，产物因此
可复现）；要核对手上那份出自哪份源码，跑 `Get-FileHash -Algorithm SHA256 <那份 .tgz>`，拿它与源码
那一侧打出来的那份比。

## 三条安装路子

三条都走 DSH 自己那一条入口 `dsh plugin --profile <名字> add <目标>`（它自己跑 pnpm）。

### 1. 从 npm 装（给所有人装的那一条）

```sh
npm publish                                         # 作者侧：要已登录、且 registry 可写
dsh plugin --profile <名字> add dsh-pathfinder      # 用户侧
```

`package.json` 的 `publishConfig.tag` 写着 `latest`：这个号是预发布（`-rc.`），npm 11 对预发布号不带
`--tag` 会直接拒发，声明了这一条才算显式指定。用户侧那条裸名解析的就是 `latest`，所以这一条在，上面
那行命令才成立。将来发正式的 `0.1.0`，`latest` 会自己移过去。

### 2. 从 GitHub Release 的 `.tgz` 装（兜底的那一条）

作者侧把 `npm pack` 出的那一个 `.tgz` 传成 Release 的附件；用户侧下载附件，然后

```sh
dsh plugin --profile <名字> add ./dsh-pathfinder-<版本>.tgz
```

这条路与 npm 那一条装的是同一份预构建产物，不跑任何构建脚本。

### 3. 从 git 装（开发者自用）

```sh
dsh plugin --profile <名字> add github:<owner>/<repo>
```

拿到的是**源码**：构建产物不在里面，而 pnpm ≥10 拒绝跑依赖包的构建脚本——第一次 `add` 会失败并印出
要授权的那把键，照它印的写进那个 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-pathfinder: true
```

再装一次。那条授权等于允许这个包在装的时候在你机器上执行代码 —— 只对可信来源这么做，并钉一个
commit。本仓有的是 `prepack`，它管不到这条路（pnpm 为 git 依赖跑的是 `prepare`，而构建脚本还要
用户先放行）：这条路要先把产物构建好，或者补一条自足的 `prepare`。

## 装完怎么核

```sh
dsh --profile <名字> --dump-config                     # 打印合成后的配置树，不起服务
dsh plugin --profile <名字> remove dsh-pathfinder      # 撤销：依赖与那一层一起摘掉
```

在 `--dump-config` 的输出里找 `# == dsh-pathfinder` 那一节，它下面的头一个顶层行就是这一行
（`- id: pathfinder`）；行里的 `name:` 指的就是这个包，宿主入口与浏览器半身两份都得在盘上。

层顺序是 profile 的 `dsh.profile.bundles`（按清单次序）→ profile 自己的 `cordis.patch.yml` →
`$DSH_HOME/cordis.patch.yml` → 命令行上每个 `--patch`，后一层按行 id 覆盖前一层；一条 patch 落到
目标行上时，那一行的整个 `config` 一起换掉，逐键合并的写法在这里读不到。

## 发版前走一遍

自动的那三样，各跑一次：

- `npm test` —— 模型层、宿主半身、构建出来的浏览器半身；最后那块把 `lib/client.js` 挂到一份**四份来源都
  有内容**的内存记录上、逐格画一遍，控制台里出现一条 error 就算失败。面板**说什么**故意不在这里量。
- `node tools/css-check.mjs` —— 样式层的规矩。
- `tools/testbed/testbed.ps1 up|check|down` —— 真实例：这一行装得上、启动清单里列了它、宿主半身答得上话。

**验的是打包出来的那一份。** `npm pack --pack-destination .tmp/pack` 打出 `.tgz`，再用
`tools/testbed/testbed.ps1 up -Plugin <.tgz>` 装它：`prepack` 会把两份产物现构建一次，装到的才是发出去的
内容。隔离实例不带 `-Plugin` 时装的是本仓目录（pnpm 的 `link:`），读到的是盘上现成的那两份——而 `npm test`
只重建浏览器半身，宿主半身那份可能是旧的。

下面这些只有手动看。合成的隔离工作区里没有 `.pf`，正好是「没有记录」那一态；要看真记录下的读数，就把这一
行装进你自己那个 profile，在一个有 `.pf` 的工作区里开面板——本仓自己就有一份：

- 一份真记录：五格都画得出来——地图上的卡与线、问题池的读数、指令那一栏的三种作用域；
- 一个没有 `.pf` 的工作区：面板说这个工作区没有记录，五格不画；
- 一个 `.pf` 在、四份文件读不动的工作区：面板说记录读不动；
- 只有问题池、或只有管线的工作区：相应那两格各退化成一行话；
- 手上的动作：拖明细分隔条、切五个标签、切语言、加一条指令再归档再删掉、改一个配置值看它落盘。

没有记录、四份文件读不动、四个读数都空这几态在宿主层与模型层各有用例；**画出来那一层没有**——文案与布局
改得勤，钉进测试就是每次改词交两份代码，所以留在这里当单子。

## 已知限制

- **发布那一发不在本机做**：要在能写官方 registry、有凭据的机器上执行——本机 `~/.npmrc` 的 `registry`
  指向一个镜像站，镜像站只收下载、不收发布，所以登录与发布两处都得显式带
  `--registry=https://registry.npmjs.org`。
- **GitHub Release 那条腿多一步手工**：把 `npm pack` 出的那一个 `.tgz` 传成 Release 的附件；远端与那个
  release 都得先有。
- **`engines.dsh` 只对 `0.2.1-rc.2` 实测过**：换一个 DSH 版本要重量一遍再改这一行。被范围挡下是预期
  行为——DSH 报 `incompatible-version` 并印出 `allow-version` 那条命令，豁免记在 profile 的
  `compatibility.json` 里，插件升版与 DSH 升版都不继承。
- **git 那条路要用户在 profile 里授权跑构建脚本**（就是让这个包在装的时候执行代码）；预构建产物
  （npm 与 `.tgz` 两条）绕开这件事，所以那两条是主路径。