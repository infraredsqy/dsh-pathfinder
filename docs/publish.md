# 发布与安装

> 位置：`docs/publish.md`。这页只写**做法**与**已知限制**：这个包怎么发出去、别人怎么装进来、
> 装完怎么核。包名与仓名都是 `dsh-pathfinder`，界面上那一节叫「调度中心」。

## 交付形态：预构建产物随包走

用户端不跑构建。三份产物在本仓构建一次：

```sh
npm install
npm run types          # lib/types/**（宿主入口的类型）
npm run bundle         # lib/host/index.js（宿主半身）
npm run bundle:client  # lib/client.js（浏览器半身）
```

这三条绑在 `prepack` 上：`npm pack` 与 `npm publish` 会自己把它们跑一遍，所以「发出去的包里有没有
产物」不再取决于发版的人记不记得先构建。

`package.json` 的 `files` 只收这几样 —— `lib/**/*.js`、`lib/types/**/*.d.ts`、`cordis.patch.yml`，
于是 `npm pack` 出的那一个 `.tgz` 就是分发件本身（`lib/client-body.js` 是浏览器那一步的中间件，
构建脚本用完当场删掉，不进包）。包里两个口子：

| 口子 | 落点 | 谁用 |
|---|---|---|
| `.`（`main`） | `lib/host/index.js` | 宿主半身：装成 `ctx.pathfinderRecords`，那几手端点经网关交出去 |
| `./client` | `lib/client.js` | 浏览器半身：`dsh.client.platform` 是 `web`，外壳按启动名册去拉这一份 |

`dsh.bundle.patch` 指着 `./cordis.patch.yml`（一条 `insert`，行 id `pathfinder`）。装进一个 profile 时
`dsh plugin add` 会把这一层并进那个 profile 的 `dsh.profile.bundles`，profile 自己的
`cordis.patch.yml` 照旧可以按 id 把这一行关掉。

`./client` 那一条还带一行加载依赖：

```json
"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-connection"] } }
```

外壳照启动名册里这一行先把 `connection` 那条客户端插件送达，再应用本包的面板 —— 浏览器半身那条
取数口子就靠这个次序才接得上（见「已知限制」）。

`engines.dsh` 是 `>=0.2.1-rc.2 <0.2.2`：装的时候与 profile 起的时候，DSH 版本落在范围外就拒。
本机 `dsh --version` ＝ `0.2.1-rc.2`，实测装得上、起得来。口径收在 0.2.1 这条线上，是因为宿主半身
有一处**运行时的**外部依赖 `@deepseek-ai/dsh-typert-protocol`（与 DSH 本体锁步同版本发布），0.2.x
里换一个 rc 它就可能动；要放到更宽的那条线，得先在那个 DSH 上重量一遍再改这一行。

包面那几条前提由 `tests/package-surface.test.mjs` 看着（`npm test` 跑）：`package.json` 里没有
`private`、`version` 是真版本号（现在是 `0.1.0`，`.tgz` 的文件名跟着它）、两个入口都被 `files` 盖住、
`dsh.bundle.patch` 与 `dsh.client.platform` 在、`dsh.client.inject` 非空且含
`@deepseek-ai/dsh-client-connection`、`engines.dsh` 非空。改包面之后跑一遍。

## 打一个包

```sh
npm pack --pack-destination .tmp/pack
```

`npm pack` 不需要登录、不改仓；`.tmp/` 不进版本库。产物清单从 `.tgz` 自己列 —— Windows 上有两套 tar
（本机实测：系统自带的是 bsdtar 3.8.9，落在 `C:\Windows\System32\tar.exe`；PATH 上那个是 Git 自带的
GNU tar 1.35），跑的是哪一套，照抄哪一条：

```sh
tar -tzf .tmp/pack/dsh-pathfinder-0.1.0.tgz                # bsdtar
tar --force-local -tzf .tmp/pack/dsh-pathfinder-0.1.0.tgz  # GNU tar
```

- **bsdtar**：`-tzf <路径>` 直接可用，绝对路径写正斜杠或反斜杠都认。它**不支持** `--force-local`：
  排在 `-tzf` 前面印 `Option --force-local is not supported`、exit 1，排在后面被当成成员名、也 exit 1。
- **GNU tar**：绝对路径不配 `--force-local` 会去解析盘符（`Cannot connect to C: resolve failed`、
  exit 2）；配了还要排在短选项**前面** —— `-tzf --force-local <路径>` 同样 exit 2。
- 在 `.tmp/pack` 里用叶子名也行：`tar -tzf dsh-pathfinder-0.1.0.tgz`，两套都认。

本机实测：**22 个条目**（收窄之前是 23 —— 那时多一份 `lib/client-body.js`），其中
`package/lib/host/index.js`（宿主入口）与 `package/lib/client.js`（浏览器那半身）都在；包
119.1 kB、解开 382.7 kB。同一份内容打出来的 `.tgz`，sha256 是稳定的：本机拿现在这份源码连打三次
都是 `f776c36d…`（`npm pack` 把归档里每个成员的 mtime 归一，所以产物可复现）；内容改了哈希才变 ——
加 `prepack` 与收窄 `files` 之前那一份是 `90e39b2f…`。要核对手上那份 `.tgz` 出自哪份源码，跑
`Get-FileHash -Algorithm SHA256 <那份 .tgz>`，拿它与构建那一份记下的哈希比。

## 三条安装路子

三条都走 DSH 自己那一条入口 `dsh plugin --profile <名字> add <目标>`（它自己跑 pnpm）。

### 1. 从 npm 装（给所有人装的那一条）

作者侧：

```sh
npm publish            # 要已登录、且 registry 可写（见「已知限制」）
```

用户侧：

```sh
dsh plugin --profile <名字> add dsh-pathfinder
```

### 2. 从 GitHub Release 的 `.tgz` 装（兜底的那一条）

作者侧：把 `npm pack` 出的那一个 `.tgz` 传成 Release 的附件（名字照旧，如
`dsh-pathfinder-0.1.0.tgz`）。

用户侧：下载附件，然后

```sh
dsh plugin --profile <名字> add ./dsh-pathfinder-0.1.0.tgz
```

这条路与 npm 那一条装的是同一份预构建产物，不跑任何构建脚本。

### 3. 从 git 装（开发者自用）

```sh
dsh plugin --profile <名字> add github:<owner>/<repo>
```

拿到的是**源码**：构建产物不在里面。pnpm ≥10 拒绝跑依赖包的构建脚本，第一次 `add` 会失败并印出要授权的那把
键；照它印的写进那个 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-pathfinder: true
```

再装一次。那条授权等于允许这个包在装的时候在你机器上执行代码 —— 只对可信来源这么做，并钉一个 commit。
本仓现在有的是 `prepack`（`npm pack`／`npm publish` 之前跑），它管不到这条路：pnpm 为 git 依赖跑的是
`prepare`，而构建脚本还要用户先放行。所以这条路要先把产物构建好，或者补一条自足的 `prepare`。

## 装完怎么核

```sh
dsh --profile <名字> --dump-config                     # 打印合成后的配置树，不起服务
dsh plugin --profile <名字> remove dsh-pathfinder      # 撤销：依赖与那一层一起摘掉
```

在 `--dump-config` 的输出里找 `# == dsh-pathfinder` 那一节，它下面的头一个顶层行就是这一行
（`- id: pathfinder`）；行里的 `name:` 指的就是这个包，宿主入口与浏览器半身两份都得在盘上。

层顺序（后一层按行 id 覆盖前一层；一条 patch 落到目标行上时，那一行的整个 `config` 一起换掉，
逐键合并的写法在这里读不到）：

1. profile 的 `dsh.profile.bundles` 里每个 bundle 的 patch，按清单次序（`@deepseek-ai/dsh-base` 起头）；
2. profile 自己的 `cordis.patch.yml`；
3. `$DSH_HOME/cordis.patch.yml`（这台机器上所有 profile 共享的那一层）；
4. 命令行上每个 `--patch <路径>`，按 argv 次序。

## 已知限制

- **发布那一发不在本机做**：本机 `npm whoami` 报 `ENEEDAUTH`（没有登录），
  `npm config get registry` 是只读镜像 `https://registry.npmmirror.com`。npm 那条腿要在有凭据、能写
  registry 的机器上执行；**本仓不产出「已发布」读数**，上面那三段就是做法本身。
- **GitHub Release 那条腿要先有远端**：本仓 `git remote -v` 是空的，先加远端、再建一个 release 放附件。
- **`engines.dsh` 只对 `0.2.1-rc.2` 实测过**：范围收在 `>=0.2.1-rc.2 <0.2.2`，换一个 DSH 版本要重量
  一遍再改这一行，否则用户会在装的时候被范围挡下；挡下是预期行为（DSH 报 `incompatible-version`，
  并印出 `allow-version` 那条命令，豁免记在 profile 的 `compatibility.json` 里，插件升版与 DSH 升版
  都不继承）。
- **git 那条路要用户在 profile 里授权跑构建脚本**（就是让这个包在装的时候执行代码）；预构建产物
  （npm 与 `.tgz` 两条）绕开这件事，所以那两条是主路径。
- **浏览器半身那条取数口子靠包面上的一行声明**：`package.json` 的 `dsh.client.inject` 声明了
  `["@deepseek-ai/dsh-client-connection"]`，外壳照它先把 `connection` 那条客户端插件送达，面板才应用 ——
  调度中心那两处（侧栏那一项、中央栏那一格）因此都画得出，中央栏那一格的正文里就是记录里的数。别把这一行摘掉：
  摘掉之后面板应用得早、那条口子接不上，中央栏那一格正文里没有记录的数，摆的是
  「该部署未连接寻路记录服务，无法读取记录。」（宿主那一侧的端点
  `/api/pathfinderRecords/read` 照旧是好的）。