# testbed.ps1 —— 测试床入口：一条命令，三个动作。
#
#   pwsh -File tools/testbed/testbed.ps1 -Action up      起测试床实例（隔离 home + 独立 profile + 合成工作区
#                                                        + 本仓这一条面板装进那个 profile），留在那儿给人看
#   pwsh -File tools/testbed/testbed.ps1 -Action check   跑完 spec「完成判定」1~5 全部五条，逐条印读数，失败时非零退出
#   pwsh -File tools/testbed/testbed.ps1 -Action down    只收自己记下来的那个 PID（先核对命令行，不按进程名杀）
#
# 运行实体一律落在 -Root 底下（默认 %LOCALAPPDATA%\dsh-pathfinder-testbed），不进版本库、不碰主 home。
# 合成记录全部自撰；这个脚本只描述做了什么、限制是什么。
#
# 参数化：-Workspace 换工作区名，-SessionCount 造第二条会话，-EmptyWorkspace 造一份没有会话的工作区，
# -Plugin 换要装进 profile 的那一条插件（默认就是本仓，相对路径按调用时的当前目录归一）。默认那一趟
# 只造一份工作区、一条会话。

#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('up', 'check', 'down')][string]$Action,
  [string]$Root = '',
  [string]$Profile = 'pf-testbed',
  [string]$Workspace = 'workspace-alpha',
  [int]$SessionCount = 1,
  [string]$EmptyWorkspace = '',
  [string]$MainHome = '',
  [int]$ReadyTimeoutSeconds = 30,
  [string]$DshCmd = 'dsh',
  [string]$NodeExe = 'node',
  [string]$Plugin = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'testbed-lib.ps1')

if ($Root.Length -eq 0) { $Root = Join-Path $env:LOCALAPPDATA 'dsh-pathfinder-testbed' }
if ($MainHome.Length -eq 0) { $MainHome = Join-Path $env:USERPROFILE '.dsh' }
# 默认装的就是本仓这一条插件：`tools\testbed\` 往上两层就是项目根。
if ($Plugin.Length -eq 0) { $Plugin = Join-Path $PSScriptRoot '..\..' }
# 入口处就归一成绝对路径：产物预检与交给 `dsh plugin --profile … add` 的必须是同一个值。
# 否则两处各按各的基准解相对路径——预检按调用者的当前目录（于是过了），dsh 按 profile 目录
# （于是去装一个不存在的目录），报错还把人指到 profile 目录那边去。
$Plugin = [System.IO.Path]::GetFullPath($Plugin)

# 起进程用 Application 形态：Start-Process 不猜扩展名，也不去碰 npm 目录里那个没有扩展名的 POSIX 壳。
$DshCmd = Resolve-ApplicationExecutable -Name $DshCmd
$NodeExe = Resolve-ApplicationExecutable -Name $NodeExe

# 读数文件里只留摘要：逐文件清单太长，原始读数在 check-report.txt 与 logs\raw 里。
function Get-FingerprintSummary {
  param([Parameter(Mandatory = $true)]$Fingerprint)
  return [ordered]@{
    path = $Fingerprint.path
    exists = $Fingerprint.exists
    kind = $Fingerprint.kind
    fileCount = $Fingerprint.fileCount
    totalBytes = $Fingerprint.totalBytes
    contentDigest = $Fingerprint.contentDigest
    entryDigest = $Fingerprint.entryDigest
  }
}

# 完成判定第 4 条的三个反证面：主 home 的会话库、工作区记录、凭据。
function Get-MainHomeAreas {
  param([Parameter(Mandatory = $true)][string]$MainHome)
  return @(
    [ordered]@{ name = 'sessions'; path = (Join-Path $MainHome 'sessions') },
    [ordered]@{ name = 'workspace-records'; path = (Join-Path $MainHome 'storages\workspace.json') },
    [ordered]@{ name = 'credentials'; path = (Join-Path $MainHome '.credentials.yaml') }
  )
}

function Get-MainHomeFingerprint {
  param([Parameter(Mandatory = $true)][string]$MainHome)
  $areas = [ordered]@{}
  foreach ($area in (Get-MainHomeAreas -MainHome $MainHome)) {
    $areas[$area.name] = Get-AreaFingerprint -Path $area.path
  }
  return $areas
}

# 见证集用的轻量观测：只取「相对路径 -> 长度|mtime」，不读内容（读数与全量指纹同构，判据真读的是后者）。
function Get-MainHomeMetaScan {
  param([Parameter(Mandatory = $true)][string]$MainHome)
  $areas = [ordered]@{}
  foreach ($area in (Get-MainHomeAreas -MainHome $MainHome)) {
    $areas[$area.name] = Get-AreaMetaScan -Path $area.path
  }
  return $areas
}

# 印「一条命令把清单打出来」。只印 pwsh 这一种写法并写明是哪种；命令后面紧跟"什么样才算过"。
function Get-TestbedListCommandLines {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$Token,
    [AllowEmptyCollection()][string[]]$SessionIds = @()
  )
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add('one command that prints the session list — pwsh only, this entry runs under pwsh; paste this single line as-is:')
  $lines.Add((Format-TestbedListCommand -Port $Port -Token $Token))
  $lines.Add('it passed when the reply has "ok":true and its items contain: ' + (@($SessionIds) -join ', ') + ' — read that reply, and leave the shell exit code out of it: -f makes curl itself exit 22 on a 4xx/5xx, while the shell that runs this one line still exits 0')
  return @($lines.ToArray())
}

# 删测试床根目录前的护栏：不许是盘根、不许在项目树里、不许和主 home 互相包含。
function Assert-SafeRoot {
  param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$MainHome)
  $full = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
  $driveRoot = [System.IO.Path]::GetPathRoot($full).TrimEnd('\')
  if ($full.Length -eq 0 -or $full -eq $driveRoot) { throw "refusing a drive root as the testbed root: '$full'" }
  if (($full.Split('\')).Count -lt 3) { throw "refusing a shallow testbed root: '$full'" }
  $projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
  if ($full -eq $projectRoot -or $full.StartsWith($projectRoot + '\')) {
    throw "refusing a testbed root inside the project tree: '$full'"
  }
  $main = [System.IO.Path]::GetFullPath($MainHome).TrimEnd('\')
  if ($full -eq $main -or $full.StartsWith($main + '\') -or $main.StartsWith($full + '\')) {
    throw "refusing a testbed root that overlaps the main home: '$full'"
  }
  return $full
}

# 整份删掉再重建：就地幂等，上一轮留下的 home 不当成干净的。
function Invoke-TestbedProvision {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Profile,
    [Parameter(Mandatory = $true)][string]$Workspace,
    [Parameter(Mandatory = $true)][int]$SessionCount,
    [string]$EmptyWorkspace = '',
    [Parameter(Mandatory = $true)][string]$DshCmd,
    [Parameter(Mandatory = $true)][string]$NodeExe
  )
  # 重建前先收掉还在跑的那一个：它的 stdout/stderr 文件被自己持着，不收就删不掉。
  $null = Stop-TestbedInstance -Root $Root -Profile $Profile
  if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
  New-Item -ItemType Directory -Force -Path (Join-Path $Root 'logs') | Out-Null
  $testbedHome = Join-Path $Root 'home'
  New-Item -ItemType Directory -Force -Path $testbedHome | Out-Null

  $profileDir = New-TestbedProfile -TestbedHome $testbedHome -Profile $Profile -DshCmd $DshCmd
  $manifest = New-TestbedFixture -Root $Root -Profile $Profile -WorkspaceName $Workspace `
    -SessionCount $SessionCount -EmptyWorkspaceName $EmptyWorkspace -NodeExe $NodeExe

  # 先验头部，再看清单：头部不合法时那一条会话会静默消失，所以这里必须当场拦下。
  foreach ($session in $manifest.sessions) {
    $problems = Test-TestbedSessionFixture -Session $session
    if ($problems.Count -gt 0) { throw ("synthetic session header check failed: " + ($problems -join '; ')) }
  }

  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("root=$Root")
  $lines.Add("home=$testbedHome")
  $lines.Add("profileDir=$profileDir")
  foreach ($ws in $manifest.workspaces) {
    $lines.Add("workspace=$($ws.workspaceId) name=$($ws.name) sessions=$(@($ws.sessionIds).Count) path=$($ws.path)")
  }
  foreach ($session in $manifest.sessions) {
    $lines.Add("session=$($session.sessionId) log=$($session.logPath)")
  }
  Write-TextFile -Path (Join-Path $Root 'logs\provision-summary.txt') -Text (($lines -join "`n") + "`n")
  return $manifest
}

# 一个实例周期里的读数：完成判定 1、2、5 都从这里取。
function Invoke-TestbedRun {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)]$Manifest,
    [Parameter(Mandatory = $true)]$Ready
  )
  $rawDir = Join-Path $Root 'logs\raw'
  if (-not (Test-Path -LiteralPath $rawDir)) { New-Item -ItemType Directory -Force -Path $rawDir | Out-Null }
  $browser = Connect-TestbedBrowser -Url $Ready.url
  $list = Invoke-TestbedApi -Port $Ready.port -WebSession $browser -Endpoint 'session/list' `
    -Arguments ([ordered]@{ _request = [ordered]@{} }) `
    -EvidencePath (Join-Path $rawDir 'session-list')

  $rows = New-Object System.Collections.Generic.List[object]
  foreach ($session in $Manifest.sessions) {
    $row = @($list.items | Where-Object { [string]$_.sessionId -eq [string]$session.sessionId })
    $page = Invoke-TestbedApi -Port $Ready.port -WebSession $browser -Endpoint 'session/page' -Arguments ([ordered]@{
        request = [ordered]@{
          address = [ordered]@{ kind = 'session'; sessionId = [string]$session.sessionId }
          throughSeq = -1
        }
      }) -EvidencePath (Join-Path $rawDir ('session-page-' + $session.sessionId))
    $projections = Invoke-TestbedApi -Port $Ready.port -WebSession $browser -Endpoint 'session/projections' `
      -Arguments ([ordered]@{ request = [ordered]@{ sessionId = [string]$session.sessionId } }) `
      -EvidencePath (Join-Path $rawDir ('session-projections-' + $session.sessionId))
    $workspace = Invoke-TestbedApi -Port $Ready.port -WebSession $browser -Endpoint 'workspace/create' `
      -Arguments ([ordered]@{ request = [ordered]@{ path = [string]$session.workspacePath } }) `
      -EvidencePath (Join-Path $rawDir ('workspace-create-' + $session.sessionId))

    $listed = $row.Count -gt 0
    $accounted = @($workspace.workspace.sessionIds) -contains [string]$session.sessionId
    $cwdMatches = ($listed -and ([string]$row[0].cwd -eq [string]$session.workspacePath))
    $rows.Add([ordered]@{
      sessionId = $session.sessionId
      listed = $listed
      listRow = $(if ($listed) { $row[0] } else { $null })
      listItemCount = @($list.items).Count
      listAllIds = @($list.items | ForEach-Object { [string]$_.sessionId })
      pageRecordCount = @($page.records).Count
      pageHasMore = $page.hasMore
      pageOpened = ($null -ne $page)
      projectionsAsOfSeq = $projections.asOfSeq
      projectionsOpened = ($null -ne $projections)
      workspaceCreatedByThisCall = [bool]$workspace.created
      workspaceId = [string]$workspace.workspace.workspaceId
      workspacePath = [string]$workspace.workspace.path
      workspaceSessionIds = @($workspace.workspace.sessionIds)
      accounted = $accounted
      cwdMatches = $cwdMatches
    })
  }

  # 空工作区（可选）也读一遍：它应当能被解析到、成员表为空。
  $emptyReadings = New-Object System.Collections.Generic.List[object]
  foreach ($ws in $Manifest.workspaces) {
    if (-not $ws.empty) { continue }
    $resolved = Invoke-TestbedApi -Port $Ready.port -WebSession $browser -Endpoint 'workspace/create' `
      -Arguments ([ordered]@{ request = [ordered]@{ path = [string]$ws.path } }) `
      -EvidencePath (Join-Path $rawDir ('workspace-create-' + $ws.workspaceId))
    $emptyReadings.Add([ordered]@{
      name = $ws.name
      workspaceId = [string]$resolved.workspace.workspaceId
      createdByThisCall = [bool]$resolved.created
      sessionIds = @($resolved.workspace.sessionIds)
    })
  }

  return [ordered]@{
    url = $Ready.url
    port = $Ready.port
    token = $Ready.token
    itemCount = @($list.items).Count
    sessions = @($rows.ToArray())
    emptyWorkspaces = @($emptyReadings.ToArray())
  }
}

function Format-RunReadings {
  param([Parameter(Mandatory = $true)]$Run)
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("url=http://127.0.0.1:$($Run.port)/?token=<redacted>")
  $lines.Add("session.list items=$($Run.itemCount) ids=$((@($Run.sessions | ForEach-Object { $_.listAllIds }) | Select-Object -First 1) -join ',')")
  foreach ($row in $Run.sessions) {
    $lines.Add("  session $($row.sessionId): listed=$($row.listed) cwdMatches=$($row.cwdMatches) blank=$($row.listRow.blank) running=$($row.listRow.running) agentAvailable=$($row.listRow.agentAvailable)")
    $lines.Add("  session.page records=$($row.pageRecordCount) hasMore=$($row.pageHasMore) (ok result, no error)")
    $lines.Add("  session.projections opened=$($row.projectionsOpened) asOfSeq=$($row.projectionsAsOfSeq) (ok result, no error)")
    $lines.Add("  workspace $($row.workspaceId) path=$($row.workspacePath) createdByThisCall=$($row.workspaceCreatedByThisCall) sessionIds=$($row.workspaceSessionIds -join ',') accounted=$($row.accounted)")
  }
  foreach ($empty in $Run.emptyWorkspaces) {
    $lines.Add("  empty workspace $($empty.workspaceId) createdByThisCall=$($empty.createdByThisCall) sessionIds=$(@($empty.sessionIds).Count)")
  }
  return @($lines.ToArray())
}

function Test-RunCriteria {
  param([Parameter(Mandatory = $true)]$Run)
  $ok = $true
  foreach ($row in $Run.sessions) {
    # 列表里在、归在工作区下（成员的两种读法都要求）、open 那两步都返回了 ok 结果。
    # 页里记录数为 0 是正常的：合成会话按范围只造"能被列出、能被打开"，正文里没有消息事件。
    if (-not $row.listed) { $ok = $false }
    if (-not $row.cwdMatches) { $ok = $false }
    if (-not $row.accounted) { $ok = $false }
    if ($row.workspaceCreatedByThisCall) { $ok = $false }
    if (-not $row.pageOpened) { $ok = $false }
    if (-not $row.projectionsOpened) { $ok = $false }
  }
  return $ok
}

# ---------------------------------------------------------------------------
# 动作：down
# ---------------------------------------------------------------------------
if ($Action -eq 'down') {
  $safeRoot = Assert-SafeRoot -Root $Root -MainHome $MainHome
  $stopped = Stop-TestbedInstance -Root $safeRoot -Profile $Profile
  Write-Host "testbed root : $safeRoot"
  Write-Host "stopped      : $stopped"
  exit 0
}

# ---------------------------------------------------------------------------
# 动作：up
# ---------------------------------------------------------------------------
if ($Action -eq 'up') {
  $safeRoot = Assert-SafeRoot -Root $Root -MainHome $MainHome
  $manifest = Invoke-TestbedProvision -Root $safeRoot -Profile $Profile -Workspace $Workspace `
    -SessionCount $SessionCount -EmptyWorkspace $EmptyWorkspace -DshCmd $DshCmd -NodeExe $NodeExe
  $testbedHome = [string]$manifest.home
  # 面板装进隔离 profile：这一格要交的那「一条命令」里，「面板已装、指着合成工作区」这一半
  # 就落在这一步上。装不上就当场停，不起一条没有面板的实例。
  $pluginReading = Install-TestbedPlugin -Root $safeRoot -TestbedHome $testbedHome -Profile $Profile `
    -PluginPath $Plugin -DshCmd $DshCmd
  $instancePid = Start-TestbedInstance -Root $safeRoot -TestbedHome $testbedHome -Profile $Profile -DshCmd $DshCmd -NodeExe $NodeExe
  $ready = Wait-TestbedReady -Root $safeRoot -ProcessId $instancePid -TimeoutSeconds $ReadyTimeoutSeconds
  # 装上了要看得见：问那个正在跑的实例要两处读数（设置命名空间名册 + 交给浏览器的启动名册）。
  $rawDir = Join-Path $safeRoot 'logs\raw'
  if (-not (Test-Path -LiteralPath $rawDir)) { New-Item -ItemType Directory -Force -Path $rawDir | Out-Null }
  $mountReading = Get-TestbedPanelMount -Port $ready.port -Url $ready.url -PluginName $pluginReading.plugin `
    -PluginId $pluginReading.pluginId -EvidenceDir $rawDir

  Write-Host "testbed root : $safeRoot"
  Write-Host "isolated home: $testbedHome"
  foreach ($ws in $manifest.workspaces) {
    Write-Host "workspace    : $($ws.workspaceId) '$($ws.name)' sessions=$(@($ws.sessionIds).Count) path=$($ws.path)"
  }
  foreach ($session in $manifest.sessions) {
    Write-Host "session      : $($session.sessionId) -> $($session.logPath)"
  }
  Write-Host "pid          : $instancePid"
  Write-Host "url          : $($ready.url)"
  Write-Host ''
  Write-Host "panel        : $($pluginReading.plugin) <- $($pluginReading.recordedSpec)"
  Write-Host "panel row    : $($pluginReading.composedRow)"
  Write-Host "panel mount  : settings namespace '$($mountReading.namespace)' is served by the live instance (namespaces=$($mountReading.namespaceCount)) ｜ boot manifest lists $($mountReading.clientBundleRef) (page $($mountReading.pageBytes) chars)"
  Write-Host "panel builds : $(@($pluginReading.artifacts | ForEach-Object { "$($_.relative) $($_.bytes)B" }) -join ', ')"
  Write-Host ''
  foreach ($line in (Get-TestbedListCommandLines -Port $ready.port -Token $ready.token -SessionIds @($manifest.sessions | ForEach-Object { [string]$_.sessionId }))) {
    Write-Host $line
  }
  exit 0
}

# ---------------------------------------------------------------------------
# 动作：check —— 逐条跑完成判定 1~5
# ---------------------------------------------------------------------------
$safeRoot = Assert-SafeRoot -Root $Root -MainHome $MainHome
$startedAt = Get-Date
$report = New-Object System.Collections.Generic.List[string]
$readings = [ordered]@{ startedAt = $startedAt.ToString('o'); root = $safeRoot; mainHome = $MainHome; criteria = @() }
$failures = New-Object System.Collections.Generic.List[string]

function Add-Report {
  param([string]$Text)
  $report.Add($Text)
  Write-Host $Text
}

function Add-Criterion {
  param([string]$Id, [string]$Title, [bool]$Passed, [AllowEmptyCollection()][string[]]$Lines)
  $readings.criteria += [ordered]@{ id = $Id; title = $Title; passed = $Passed; readings = @($Lines) }
  Add-Report ("[{0}] {1} : {2}" -f $(if ($Passed) { 'PASS' } else { 'FAIL' }), $Id, $Title)
  foreach ($line in $Lines) { Add-Report ("      " + $line) }
  if (-not $Passed) { $failures.Add($Id) }
}

Add-Report "testbed root : $safeRoot"
Add-Report "isolated home: $(Join-Path $safeRoot 'home')"
Add-Report "main home    : $MainHome"
Add-Report ''

# 主 home 的反证读数（判据 4 的口径）：
#   * 见证集只在「测试床实例没在跑」的观测窗里取：先收掉自己的实例，取一枚轻量观测（只看长度与 mtime）
#     再取一枚全量指纹，两枚之间动过的路径就是见证集；跑完（含重启那一趟）、实例收干净之后，
#     再取一枚轻量观测和一枚全量指纹，同样得到一个观测窗。这是"确实有别的 live 会话在这台机器上写"
#     的正面证据——测试床在这两段里没有进程在跑。
#   * 跑完那枚全量指纹与跑前那枚比对：每条变化都要有正面归属证据才豁免，两条证据取并集——
#     S1 结构性（project key 与本格派生的键都不同 + 编码后缀是本 profile 写不出的那一种，两条都要成立）、
#     S2 见证集（「实例没在跑」的观测窗里确实动过的路径）。两条都没有的变化一律判失败；
#     删除、带本格名字的路径、两处静区的任何变化是硬失败面，不参与豁免。豁免了几条、凭哪一条，读数里逐条印。
$null = Stop-TestbedInstance -Root $safeRoot -Profile $Profile
$metaBeforeRun = Get-MainHomeMetaScan -MainHome $MainHome
$fingerprintStart = Get-Date
$pass2 = Get-MainHomeFingerprint -MainHome $MainHome
$fingerprintPassSeconds = [math]::Round(((Get-Date) - $fingerprintStart).TotalSeconds, 2)

$witnessBeforeRun = [ordered]@{}
$liveWitness = New-Object System.Collections.Generic.HashSet[string]
foreach ($name in $pass2.Keys) {
  $areaWitness = New-Object System.Collections.Generic.List[string]
  foreach ($rel in (Get-TouchedPaths -MetaBefore $metaBeforeRun[$name] -FingerprintAfter $pass2[$name])) {
    $areaWitness.Add($rel)
    $null = $liveWitness.Add("$name/$rel")
  }
  $witnessBeforeRun[$name] = @($areaWitness.ToArray())
}

try {
  $manifest = Invoke-TestbedProvision -Root $safeRoot -Profile $Profile -Workspace $Workspace `
    -SessionCount $SessionCount -EmptyWorkspace $EmptyWorkspace -DshCmd $DshCmd -NodeExe $NodeExe
  $testbedHome = [string]$manifest.home

  # 完成判定 5 的读数一：起实例之前，隔离 home 里没有任何凭据。
  $credentialsBeforeStart = Test-Path -LiteralPath (Join-Path $testbedHome '.credentials.yaml')

  $instancePid = Start-TestbedInstance -Root $safeRoot -TestbedHome $testbedHome -Profile $Profile -DshCmd $DshCmd -NodeExe $NodeExe
  $ready1 = Wait-TestbedReady -Root $safeRoot -ProcessId $instancePid -TimeoutSeconds $ReadyTimeoutSeconds
  $urlLine1 = (Select-String -LiteralPath (Join-Path $safeRoot 'logs\instance.out.log') -Pattern 'dsh web:' | Select-Object -First 1).Line
  $run1 = Invoke-TestbedRun -Root $safeRoot -Manifest $manifest -Ready $ready1
  $credentialsAfterStart = ''
  $credentialsPath = Join-Path $testbedHome '.credentials.yaml'
  if (Test-Path -LiteralPath $credentialsPath) { $credentialsAfterStart = (Get-Content -LiteralPath $credentialsPath -Raw) }
  Write-TextFile -Path (Join-Path $safeRoot 'logs\raw\credentials-after-first-start.txt') -Text $credentialsAfterStart
  $null = Stop-TestbedInstance -Root $safeRoot -Profile $Profile

  # 完成判定 3：重启第二个实例，前两条仍成立。
  $instancePid2 = Start-TestbedInstance -Root $safeRoot -TestbedHome $testbedHome -Profile $Profile -DshCmd $DshCmd -NodeExe $NodeExe
  $ready2 = Wait-TestbedReady -Root $safeRoot -ProcessId $instancePid2 -TimeoutSeconds $ReadyTimeoutSeconds
  $run2 = Invoke-TestbedRun -Root $safeRoot -Manifest $manifest -Ready $ready2
  $null = Stop-TestbedInstance -Root $safeRoot -Profile $Profile

  # 实例收干净之后再开第二个观测窗（同样"没有测试床实例在跑"），见证集取两窗的并集。
  $metaAfterRun = Get-MainHomeMetaScan -MainHome $MainHome
  $fingerprintEnd = Get-MainHomeFingerprint -MainHome $MainHome
  $witnessAfterRun = [ordered]@{}
  foreach ($name in $fingerprintEnd.Keys) {
    $areaWitness = New-Object System.Collections.Generic.List[string]
    foreach ($rel in (Get-TouchedPaths -MetaBefore $metaAfterRun[$name] -FingerprintAfter $fingerprintEnd[$name])) {
      $areaWitness.Add($rel)
      $null = $liveWitness.Add("$name/$rel")
    }
    $witnessAfterRun[$name] = @($areaWitness.ToArray())
  }

  # ---- 判据 1：一条命令把会话列表打出来；清单里有那条合成会话；打开它不报错 ----
  $lines1 = New-Object System.Collections.Generic.List[string]
  foreach ($line in (Format-RunReadings -Run $run1)) { $lines1.Add($line) }
  $lines1.Add('command used (one command, prints the session list):')
  foreach ($line in (Get-TestbedListCommandLines -Port $run1.port -Token $run1.token -SessionIds @($run1.sessions | ForEach-Object { [string]$_.sessionId }))) { $lines1.Add($line) }
  Add-Criterion -Id '1' -Title 'session list contains the synthetic session and opening it returns a page' `
    -Passed (Test-RunCriteria -Run $run1) -Lines @($lines1.ToArray())

  # ---- 判据 2：那条会话归在合成工作区下，不在未分组里 ----
  $lines2 = New-Object System.Collections.Generic.List[string]
  foreach ($row in $run1.sessions) {
    $lines2.Add("session $($row.sessionId) accounted by workspace.sessionIds: $($row.accounted)")
    $lines2.Add("session.list row cwd == workspace path: $($row.cwdMatches) ($($row.listRow.cwd))")
    $lines2.Add("workspace.create resolved an existing registration: createdByThisCall=$($row.workspaceCreatedByThisCall) workspaceId=$($row.workspaceId)")
    $lines2.Add("grouping input is workspace.sessionIds; this session is in it, so it is grouped, not ungrouped")
  }
  Add-Criterion -Id '2' -Title 'the session is grouped under the synthetic workspace, not ungrouped' `
    -Passed (Test-RunCriteria -Run $run1) -Lines @($lines2.ToArray())

  # ---- 判据 3：重启第二个实例后，上面两条仍成立 ----
  $lines3 = New-Object System.Collections.Generic.List[string]
  $lines3.Add("restarted instance: port=$($run2.port) pid=$instancePid2")
  foreach ($line in (Format-RunReadings -Run $run2)) { $lines3.Add($line) }
  Add-Criterion -Id '3' -Title 'after restarting the instance, criteria 1 and 2 still hold' `
    -Passed (Test-RunCriteria -Run $run2) -Lines @($lines3.ToArray())

  # ---- 判据 4：主 home 三处的文件计数与哈希，跑前跑后一致 ----
  # 判定交给库里的 Get-MainHomeAreaVerdict：每条差异都要有正面归属证据（S1 结构性 / S2 见证集，
  # 两条取并集），删除、带本格名字的路径与两处静区的任何变化一律失败。这里只把判定真读的读数逐条印出来。
  # 四档（豁免／删除／带本格名字／未归属）互斥：每条变化只落一档、只印一行，入口另印一条自查读数，跟明细行逐条对得上。
  $lines4 = New-Object System.Collections.Generic.List[string]
  $pass4 = $true
  # 泄漏签名：测试床自己造出来的名字。签名一律取「能在相对路径里连续出现的片段」——判定拿相对路径去比对，
  # 一整条绝对路径（例如工作区路径）在里面连不成一片，那样的条目一条也认不出来，故由库里的
  # Get-TestbedLeakSignatures 统一算：合成会话 id + 合成工作区目录名 + 测试床根目录叶子名。
  $leakSignatures = @(Get-TestbedLeakSignatures -Root $safeRoot -Sessions @($manifest.sessions) -Workspaces @($manifest.workspaces))
  # S1 的基准面：本格自己派生的 project key（合成工作区路径算出来的那几把）＋ 这套 profile 写得出的编码。
  # 某个别的 project key 下多出一个明文 .jsonl，照样进不了 S1 —— 这条堵的是「名字不认识就放过」的退路。
  $fixtureProjectKeys = New-Object System.Collections.Generic.List[string]
  foreach ($ws in $manifest.workspaces) {
    $key = Get-ProjectKey -Cwd ([string]$ws.path)
    if (-not $fixtureProjectKeys.Contains($key)) { $fixtureProjectKeys.Add($key) }
  }
  $fixtureEncodings = @('.jsonl')
  $lines4.Add("hard-fail signature set — these names are what this testbed makes (a changed path carrying one of them is never exempt; $($leakSignatures.Count) entries): $($leakSignatures -join ' | ')")
  $lines4.Add("S1 baseline — project keys this fixture derives: $($fixtureProjectKeys -join ', ')")
  $lines4.Add("S1 baseline — encodings this profile writes: $($fixtureEncodings -join ', ') (the profile pins compression: none, so this home only ever writes plaintext)")

  foreach ($name in $pass2.Keys) {
    $before = $pass2[$name]
    $after = $fingerprintEnd[$name]
    # 会话库那一处本来就有别的 live harness 会话在追加（见证集里那些路径），工作区记录与凭据那两处没有别的写者，
    # 所以静区只要动一下就算硬失败；会话库里则按"变了的那条路径归谁"分别判。
    $quietArea = ($name -ne 'sessions')
    $verdict = Get-MainHomeAreaVerdict -Name $name -Before $before -After $after -QuietArea $quietArea `
      -LiveWitness @($liveWitness) -LeakSignatures $leakSignatures `
      -FixtureProjectKeys @($fixtureProjectKeys.ToArray()) -FixtureEncodings $fixtureEncodings
    $countIdentical = ($before.fileCount -eq $after.fileCount)
    $wholeIdentical = $countIdentical -and ($before.contentDigest -eq $after.contentDigest)
    $lines4.Add("$name : before files=$($before.fileCount) bytes=$($before.totalBytes) sha256=$($before.contentDigest.Substring(0,16))... | after files=$($after.fileCount) bytes=$($after.totalBytes) sha256=$($after.contentDigest.Substring(0,16))...")
    $lines4.Add("$name : path=$($before.path) kind=$($before.kind)")
    $areaNote = $(if ($quietArea) { 'quiet area: no other writer here, so any change fails' } else { 'shared area: every changed path needs its own positive ownership evidence' })
    $lines4.Add("$name : raw whole-area reading (context only; $areaNote): fileCount identical=$countIdentical wholeAreaCountAndHashIdentical=$wholeIdentical")
    $lines4.Add("$name : changed paths=$($verdict.changed.Count), prefixes kept (+ new / ~ rewritten / - deleted)")
    $lines4.Add("$name : four buckets, mutually exclusive — every changed path is filed in exactly one, in this order: deletion -> a testbed-made name -> a quiet area -> exempt or unattributed | exempt=$($verdict.exempt.Count) (S1 structural=$($verdict.exemptStructural.Count), S2 witnessed live write=$($verdict.exemptWitnessed.Count)) | deletions (hard fail, never exempt)=$($verdict.deletions.Count) | carrying a testbed-made name (hard fail, never exempt)=$($verdict.leaks.Count) | unattributed (no positive evidence)=$($verdict.unattributed.Count)")
    $lines4.Add("$name : bucket self-check: changed=$($verdict.changed.Count) filed=$($verdict.filedCount) distinct=$($verdict.filedDistinctCount) partitionConsistent=$($verdict.partitionConsistent) (each changed path shows up in exactly one detail line below)")
    if (-not $verdict.partitionConsistent) { $pass4 = $false }
    # 逐条明细全印：计数是全集，明细也只印全集（本轮量级小），PASS/FAIL 的每一条依据都看得见。
    foreach ($item in $verdict.exempt) { $lines4.Add("$name : exempt -> $item") }
    foreach ($item in $verdict.exempt) { $lines4.Add("$name :    why: $($verdict.exemptReasons[$item])") }
    foreach ($item in $verdict.deletions) { $lines4.Add("$name : DELETION, hard fail (never exempt) -> $item") }
    foreach ($item in $verdict.unattributed) { $lines4.Add("$name : UNATTRIBUTED change, no positive evidence -> $item") }
    foreach ($item in $verdict.leaks) { $lines4.Add("$name : LEAK SIGNATURE, hard fail (never exempt) -> $item") }
    # 子集比对是支撑读数：它把被豁免的那几条从两侧各摘一遍，三项计数为 0 时它必然成立，当不了独立证据
    # （判定的依据是上面那四个计数，外加 partitionConsistent 那条自查——读数与明细行相抵时这里当场红）。
    # 豁免集为空时它才等于 spec 那句「三处的文件计数与哈希完全一致」的
    # 字面读数；豁免集非空时它只是支撑；空面与空子集一律不印相等——空集合上没有东西可比。
    if ($before.fileCount -eq 0) { $lines4.Add("$name : this area holds no files (empty set: before=$($before.fileCount) after=$($after.fileCount)); its digest is the fixed empty-set sha256, so there is nothing to compare here") }
    elseif ($verdict.exempt.Count -eq 0) { $lines4.Add("$name : nothing was exempted here, so the whole-area reading above is the spec's literal one (no subset was carved out of it)") }
    elseif ($verdict.subsetBefore.fileCount -eq 0) { $lines4.Add("$name : support reading only, and it has nothing to compare: excluding exactly the $($verdict.exempt.Count) exempt path(s) leaves no file in the remainder (empty subset), so no equality is claimed") }
    else { $lines4.Add("$name : support reading only (implied by the counts above, so it is no independent evidence): excluding exactly the $($verdict.exempt.Count) exempt path(s) leaves files=$($verdict.subsetBefore.fileCount) sha256=$($verdict.subsetBefore.digest.Substring(0,16))... countAndHashIdentical=$($verdict.subsetIdentical)") }
    if (-not $verdict.passed) { $pass4 = $false }
  }
  $lines4.Add("live-write witness (paths that changed during an observation window opened while no testbed instance was running): $($liveWitness.Count)")
  $lines4.Add("  window 1 before the run (lightweight scan -> full fingerprint): $(@($witnessBeforeRun.Values | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum) path(s)")
  $lines4.Add("  window 2 after the run (lightweight scan -> full fingerprint, instance already stopped): $(@($witnessAfterRun.Values | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum) path(s)")
  foreach ($item in (@($liveWitness) | Sort-Object)) { $lines4.Add("live witness -> $item") }
  # 收尾后不该再有本测试床的监听者或进程：这条立起来，上面"外来变化"的说法才站得住。
  # 残留进程按**身份**收：本格写下的启动器路径，或本次运行记下的实例 pid 的后代；
  # 调用者自身与它的祖先链排除在外（跑 check 的 shell 与宿主，命令行里提过运行根也不影响读数）。
  $strayProcesses = Get-StrayTestbedProcess -Root $safeRoot -Profile $Profile -InstancePids @($instancePid, $instancePid2)
  $listenerAlive = Test-TcpListener -Port $run2.port
  $lines4.Add("stray listener on the last instance port after the final stop: $listenerAlive")
  $lines4.Add("stray scan identity: this testbed's own launcher path '$(Join-Path $safeRoot ('logs\start-' + $Profile + '.cmd'))' and the instance pid tree @($instancePid, $instancePid2); the caller's own process (pid=$PID) and its ancestors are excluded from the scan")
  $lines4.Add("stray node/cmd process carrying that identity: $($strayProcesses.Count)")
  foreach ($item in $strayProcesses) { $lines4.Add("stray process -> $item") }
  if ($listenerAlive) { $pass4 = $false }
  if ($strayProcesses.Count -gt 0) { $pass4 = $false }
  Add-Criterion -Id '4' -Title 'main home: every changed path carries its own positive ownership evidence (S1 structural or S2 witness; deletions, testbed-made names and quiet-area changes never exempt), and this testbed left no listener and no process of its own identity behind' -Passed $pass4 -Lines @($lines4.ToArray())

  # ---- 判据 5：隔离环境在没有凭据的情况下能起来 ----
  # 起实例之前隔离 home 里没有任何凭据；起完之后只允许出现 web 应用自己签发的那一条浏览器会话记录。
  $recordKeys = New-Object System.Collections.Generic.List[string]
  $inRecords = $false
  foreach ($line in ($credentialsAfterStart -split "`n")) {
    if ($line -match '^records:\s*$') { $inRecords = $true; continue }
    if (-not $inRecords) { continue }
    if ($line -match '^  ([^\s:]+):\s*$') { $recordKeys.Add($Matches[1]); continue }
    if ($line -match '^\S') { $inRecords = $false }
  }
  $unexpectedKeys = @($recordKeys | Where-Object { $_ -ne 'client-connection/browser-session' })
  $lines5 = New-Object System.Collections.Generic.List[string]
  $lines5.Add("credentials file present before the first start: $credentialsBeforeStart")
  $lines5.Add("isolated home: $testbedHome")
  $lines5.Add("first start printed: $urlLine1")
  $lines5.Add("credential record keys after the first start: $($recordKeys -join ', ') (expected: the web app's own client-connection/browser-session grant only)")
  $lines5.Add("unexpected credential keys: $($unexpectedKeys.Count)")
  $lines5.Add("model credentials supplied by the provisioner: none; no fake model service was mounted")
  Add-Criterion -Id '5' -Title 'the isolated instance starts with no credentials supplied (no fake model service needed)' `
    -Passed ((-not $credentialsBeforeStart) -and ($urlLine1 -match 'dsh web:') -and ($unexpectedKeys.Count -eq 0)) -Lines @($lines5.ToArray())

  $readings['firstRun'] = $run1
  $readings['secondRun'] = $run2
  $readings['credentialsPresentBeforeFirstStart'] = $credentialsBeforeStart
  $readings['credentialsAfterFirstStart'] = $credentialsAfterStart
  $readings['mainHomeBefore'] = [ordered]@{}
  $readings['mainHomeAfter'] = [ordered]@{}
  foreach ($name in $pass2.Keys) {
    $readings['mainHomeBefore'][$name] = Get-FingerprintSummary -Fingerprint $pass2[$name]
    $readings['mainHomeAfter'][$name] = Get-FingerprintSummary -Fingerprint $fingerprintEnd[$name]
  }
  $readings['liveWriteWitness'] = @($liveWitness)
  $readings['witnessWindow1BeforeRun'] = $witnessBeforeRun
  $readings['witnessWindow2AfterRun'] = $witnessAfterRun
}
catch {
  Add-Report ("[FAIL] check aborted: " + $_.Exception.Message)
  Add-Report ($_.ScriptStackTrace)
  $failures.Add('aborted')
}
finally {
  $null = Stop-TestbedInstance -Root $safeRoot -Profile $Profile
}

$elapsed = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
$readings['elapsedSeconds'] = $elapsed
$readings['fingerprintPassSeconds'] = $fingerprintPassSeconds
Add-Report ''
Add-Report "elapsed: $elapsed s (two full main-home fingerprints at ~$fingerprintPassSeconds s each, plus two lightweight metadata scans)"
Add-Report "failed criteria: $(if ($failures.Count -eq 0) { 'none' } else { ($failures -join ', ') })"

Write-TextFile -Path (Join-Path $safeRoot 'logs\check-report.txt') -Text (($report -join "`n") + "`n")
Write-TextFile -Path (Join-Path $safeRoot 'logs\readings.json') -Text (($readings | ConvertTo-Json -Depth 20) + "`n")

if ($failures.Count -gt 0) { exit 1 }
exit 0