# testbed-lib.ps1 —— 测试床公共实现：路径与磁盘格式换算、合成记录落盘、实例起停、HTTP 调用、主 home 指纹。
#
# 只被 tools/testbed/testbed.ps1 调用。运行实体（隔离 home / profile / 合成工作区 / 合成会话）
# 全部落在调用方传入的 -Root 目录下，本文件不假设任何具体路径。
#
# 设计要点（照本机实测行为写，不照抄别处）：
#   * 会话根目录键：会话日志落在 <home>\sessions\<projectKey(cwd)>\<encodeSegment(id)>\session.v4.jsonl。
#     实例读日志时会核对「header 的 id + cwd 反算出来的路径」与磁盘路径是否同一个文件，路径算错就会被丢弃。
#   * 会话物理编码在整根上排他：同一个根里混了另一种后缀，整个会话列表会抛错。
#     测试床的 home 每次重建，profile 里把压缩固定成 none，于是全根都是明文 .jsonl。
#   * 会话 header 字段名/类型不合法不会报错，那一条会话会从清单里静默消失。故先验 header，再看清单。
#   * 工作区记录（<home>\storages\workspace.json）只在实例启动时读一次，必须在实例停着的时候写。
#   * 主 home 是多租户的：别的项目有 live 会话在往里追加。判据 4 要求**每一处差异都印得出正面归属证据**，
#     两条证据取并集：S1 结构性（project key 与本格派生的键都不同 + 编码后缀是本 profile 写不出的那一种）、
#     S2 见证集（「实例没在跑」的观测窗里确实动过的路径）。删除、带本格名字的路径、两处静区的任何变化一律失败。

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# ---------------------------------------------------------------------------
# 路径与磁盘格式换算
# ---------------------------------------------------------------------------

# 把 cwd 换成会话根目录下那一层「项目目录」名（与产品侧同算法：分隔符折叠成 '-'，其余非安全字符转 ~XXXX）。
function Get-ProjectKey {
  param([Parameter(Mandatory=$true)][string]$Cwd)
  if ($Cwd.Length -eq 0) { throw 'project key: cwd must not be empty' }
  $readable = ''
  $separatorRun = $false
  foreach ($ch in $Cwd.ToCharArray()) {
    if ($ch -eq '\' -or $ch -eq '/' -or $ch -eq ':') {
      if (-not $separatorRun) { $readable += '-' }
      $separatorRun = $true
    } elseif ($ch -ne '~' -and $ch -match '^[A-Za-z0-9._-]$') {
      $readable += $ch
      $separatorRun = $false
    } else {
      $readable += '~' + ([int]$ch).ToString('X4')
      $separatorRun = $false
    }
  }
  $slug = $readable -replace '^-+', ''
  if ($slug.Length -eq 0) { $slug = 'root' }
  if ($slug.Length -gt 251) { $slug = $slug.Substring(0, 251) }
  return '--' + $slug + '--'
}

# 会话 id 变成单个安全路径段。
function Get-EncodedSegment {
  param([Parameter(Mandatory=$true)][string]$Raw)
  if ($Raw.Length -eq 0) { throw 'encoded segment: value must not be empty' }
  if ($Raw -eq '.') { return '~002E' }
  if ($Raw -eq '..') { return '~002E~002E' }
  $out = ''
  foreach ($ch in $Raw.ToCharArray()) {
    if ($ch -ne '~' -and $ch -match '^[A-Za-z0-9._-]$') { $out += $ch }
    else { $out += '~' + ([int]$ch).ToString('X4') }
  }
  return $out
}

# 用 Node 的 fs.realpathSync 求规范路径：产品侧的工作区路径唯一性判定用的就是这个 canon。
function Get-CanonicalPath {
  param([Parameter(Mandatory=$true)][string]$Path, [string]$NodeExe = 'node')
  $out = & $NodeExe -e "process.stdout.write(require('fs').realpathSync(process.argv[1]))" $Path
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrEmpty($out)) { throw "realpath failed for '$Path'" }
  return [string]$out
}

# 解析出可直接 CreateProcess 的可执行体：要 .cmd/.bat/.exe 那一份，不要 npm 目录里那个没有扩展名的 POSIX 壳。
function Resolve-ApplicationExecutable {
  param([Parameter(Mandatory=$true)][string]$Name)
  $candidates = @(Get-Command -Name $Name -All -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandType -eq 'Application' -and $_.Name -match '\.(cmd|bat|exe)$' })
  if ($candidates.Count -gt 0) { return $candidates[0].Source }
  foreach ($dir in ($env:PATH -split ';')) {
    foreach ($extension in @('.cmd', '.bat', '.exe')) {
      $candidate = Join-Path $dir ($Name + $extension)
      if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
  }
  throw "cannot resolve an executable launcher named '$Name'"
}

# 写文本：默认不带 BOM（JSON / JSONL 解析器碰到 BOM 会当坏数据），行尾按调用方给的原文。
function Write-TextFile {
  param([Parameter(Mandatory=$true)][string]$Path, [Parameter(Mandatory=$true)][string]$Text)
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, $script:Utf8NoBom)
}

# JSON 字符串字面量（转义交给 ConvertTo-Json，保证 Windows 反斜杠写对）。
function ConvertTo-JsonString {
  param([Parameter(Mandatory=$true)][string]$Value)
  return (ConvertTo-Json -InputObject $Value -Compress)
}

# ---------------------------------------------------------------------------
# 主 home 指纹（完成判定第 4 条的反证读数）
# ---------------------------------------------------------------------------

# 取一处路径的指纹。tree 递归，file 单文件。
#   contentDigest —— 只由「相对路径 + 字节数 + 内容 SHA256」组成，这是「计数与哈希」的字面读数；
#   entryDigest   —— 上面再加 mtime，用来在判据之外指出到底哪些文件动过；
#   entries       —— 相对路径 -> "长度|mtime|内容哈希"，用于逐路径比对。
function Get-AreaFingerprint {
  param([Parameter(Mandatory=$true)][string]$Path)
  # 空集合也必须有确定的摘要：目录里一个文件都没有（或这一面根本不在）时取固定空串的 sha256，
  # 两边才有得比，调用方也不会撞上「参数为 null」的绑定错。
  $emptyDigest = Get-TextDigest -Lines @()
  $result = [ordered]@{
    path = $Path; exists = $false; kind = 'missing'
    fileCount = 0; totalBytes = 0; contentDigest = $emptyDigest; entryDigest = $emptyDigest; entries = @{}
  }
  if (-not (Test-Path -LiteralPath $Path)) { return $result }
  $item = Get-Item -LiteralPath $Path -Force
  $result.exists = $true
  if ($item.PSIsContainer) {
    $result.kind = 'tree'
    $base = $item.FullName.TrimEnd('\')
    $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force)
  } else {
    $result.kind = 'file'
    $base = (Split-Path -Parent $item.FullName)
    $files = @($item)
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $contentLines = New-Object System.Collections.Generic.List[string]
  $entryLines = New-Object System.Collections.Generic.List[string]
  try {
    foreach ($f in $files) {
      $rel = $f.FullName.Substring($base.Length).TrimStart('\')
      $stream = [System.IO.File]::OpenRead($f.FullName)
      try {
        $hash = [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
      } finally { $stream.Dispose() }
      $content = "$($f.Length)|$hash"
      $entry = "$content|$($f.LastWriteTimeUtc.Ticks)"
      $result.entries[$rel] = $entry
      $contentLines.Add("$rel`t$content")
      $entryLines.Add("$rel`t$entry")
      $result.fileCount = $result.fileCount + 1
      $result.totalBytes = $result.totalBytes + $f.Length
    }
  } finally { $sha.Dispose() }
  $result.contentDigest = Get-TextDigest -Lines @((@($contentLines.ToArray()) | Sort-Object))
  $result.entryDigest = Get-TextDigest -Lines @((@($entryLines.ToArray()) | Sort-Object))
  return $result
}

# 一处路径的文本摘要。空集合（没有文件的那一面、空子集）收下，摘要取固定空串的 sha256。
function Get-TextDigest {
  param([AllowEmptyCollection()][AllowNull()][string[]]$Lines = @())
  if ($null -eq $Lines) { $Lines = @() }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($Lines -join "`n"))
    return [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
}

# 逐路径比对两枚指纹，返回变化集（按 mtime/长度/内容哈希任一项不同即算变化）。
function Compare-AreaFingerprint {
  param([Parameter(Mandatory=$true)]$Before, [Parameter(Mandatory=$true)]$After)
  $changed = New-Object System.Collections.Generic.List[string]
  foreach ($rel in $After.entries.Keys) {
    if (-not $Before.entries.ContainsKey($rel)) { $changed.Add("+$rel") ; continue }
    if ($Before.entries[$rel] -ne $After.entries[$rel]) { $changed.Add("~$rel") }
  }
  foreach ($rel in $Before.entries.Keys) {
    if (-not $After.entries.ContainsKey($rel)) { $changed.Add("-$rel") }
  }
  return @($changed | Sort-Object)
}

# 去掉变化集条目前缀，得到纯相对路径。没有变化时返回空数组（调用方不必区分 $null）。
function Get-ChangedPaths {
  param([AllowEmptyCollection()][string[]]$Changed = @())
  if ($null -eq $Changed) { return @() }
  return @($Changed | ForEach-Object { $_.Substring(1) })
}

# 轻量观测：只有「相对路径 -> 长度|mtime 刻度」，不读文件内容（主 home 会话库 1.5 GB，
# 读内容那一趟留着给判据真正要比对的前后两份全量指纹）。观测"动没动"用它就够。
function Get-AreaMetaScan {
  param([Parameter(Mandatory=$true)][string]$Path)
  $result = [ordered]@{ path = $Path; exists = $false; kind = 'missing'; fileCount = 0; entries = @{} }
  if (-not (Test-Path -LiteralPath $Path)) { return $result }
  $item = Get-Item -LiteralPath $Path -Force
  $result.exists = $true
  if ($item.PSIsContainer) {
    $result.kind = 'tree'
    $base = $item.FullName.TrimEnd('\')
    $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force)
  } else {
    $result.kind = 'file'
    $base = (Split-Path -Parent $item.FullName)
    $files = @($item)
  }
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($base.Length).TrimStart('\')
    $result.entries[$rel] = "$($f.Length)|$($f.LastWriteTimeUtc.Ticks)"
    $result.fileCount = $result.fileCount + 1
  }
  return $result
}

# 两次观测之间动过的相对路径（新增 / 改写 / 消失都算）。
# Before 是轻量观测（长度|mtime），After 是全量指纹（长度|内容哈希|mtime），只比长度与 mtime。
function Get-TouchedPaths {
  param([Parameter(Mandatory=$true)]$MetaBefore, [Parameter(Mandatory=$true)]$FingerprintAfter)
  $touched = New-Object System.Collections.Generic.List[string]
  foreach ($rel in $FingerprintAfter.entries.Keys) {
    $parts = ([string]$FingerprintAfter.entries[$rel]) -split '\|'
    $afterMeta = "$($parts[0])|$($parts[2])"
    if (-not $MetaBefore.entries.ContainsKey($rel)) { $touched.Add([string]$rel) ; continue }
    if ([string]$MetaBefore.entries[$rel] -ne $afterMeta) { $touched.Add([string]$rel) }
  }
  foreach ($rel in $MetaBefore.entries.Keys) {
    if (-not $FingerprintAfter.entries.ContainsKey($rel)) { $touched.Add([string]$rel) }
  }
  return @($touched | Sort-Object -Unique)
}

# 一枚指纹里「排除若干条相对路径之后」的文件数与内容摘要。
# 用途：见证集挑出来的那些外来写入路径先被摘掉，判据的计数与哈希就在剩下的这份集合上取，
# 等式才有意义（而且摘掉的是哪几条，读数里逐条印出来）。
function Get-FingerprintSubset {
  param(
    [Parameter(Mandatory=$true)]$Fingerprint,
    [AllowEmptyCollection()][string[]]$Exclude = @()
  )
  $skip = New-Object System.Collections.Generic.HashSet[string]
  foreach ($rel in @($Exclude)) { if ($null -ne $rel) { $null = $skip.Add([string]$rel) } }
  $lines = New-Object System.Collections.Generic.List[string]
  $count = 0
  $bytes = 0
  foreach ($rel in $Fingerprint.entries.Keys) {
    if ($skip.Contains([string]$rel)) { continue }
    $entry = [string]$Fingerprint.entries[$rel]
    $length = [long](($entry -split '\|')[0])
    $lines.Add("$rel`t$entry")
    $count = $count + 1
    $bytes = $bytes + $length
  }
  return [ordered]@{
    fileCount = $count
    totalBytes = $bytes
    digest = Get-TextDigest -Lines @((@($lines.ToArray()) | Sort-Object))
    excluded = $skip.Count
  }
}

# S1（结构性豁免）：这条路径凭「落在哪个 project key 下 + 物理编码后缀」就能证明本格写不出来。
# 两条同时成立才算：① project key 与本格派生的所有 key 都不同；② 编码后缀是本 profile 写不出的那一种
# （本 profile 把压缩固定成 none，整根只能是明文 .jsonl）。缺一条就不豁免——这一条正是为了堵住
# 「名字不认识就放过」那条退路：别的 project key 下多出一个明文 .jsonl，照样判失败。
function Test-StructuralExemption {
  param(
    [Parameter(Mandatory=$true)][string]$RelativePath,
    [AllowEmptyCollection()][string[]]$FixtureProjectKeys = @(),
    [AllowEmptyCollection()][string[]]$FixtureEncodings = @('.jsonl')
  )
  $segments = @($RelativePath -split '\\')
  if ($segments.Count -lt 2) {
    return [ordered]@{
      exempt = $false; projectKey = ''; leaf = [string]$RelativePath
      reason = 'S1 structural not met: the path sits directly in the area root, so it carries no project key to read'
    }
  }
  $key = [string]$segments[0]
  $leaf = [string]$segments[$segments.Count - 1]
  $keyIsForeign = $true
  foreach ($candidate in @($FixtureProjectKeys)) {
    if ([string]::IsNullOrEmpty([string]$candidate)) { continue }
    if ($key -eq [string]$candidate) { $keyIsForeign = $false; break }
  }
  $encodingIsForeign = $true
  foreach ($candidate in @($FixtureEncodings)) {
    if ([string]::IsNullOrEmpty([string]$candidate)) { continue }
    if ($leaf.ToLowerInvariant().EndsWith(([string]$candidate).ToLowerInvariant())) { $encodingIsForeign = $false; break }
  }
  $exempt = $keyIsForeign -and $encodingIsForeign
  $reason = ''
  if (-not $keyIsForeign) {
    $reason = "S1 structural not met: project key '$key' is one this fixture derives"
  } elseif (-not $encodingIsForeign) {
    $reason = "S1 structural not met: '$leaf' carries an encoding this profile writes ($(@($FixtureEncodings) -join ', '))"
  } else {
    $reason = "S1 structural: project key '$key' is not one this fixture derives, and '$leaf' is not the plaintext encoding this profile writes ($(@($FixtureEncodings) -join ', '))"
  }
  return [ordered]@{ exempt = $exempt; projectKey = $key; leaf = $leaf; reason = $reason }
}

# 判据 4 的泄漏签名集：测试床自己造出来的名字。判定拿相对路径去 `-like "*签名*"`（见 Get-MainHomeAreaVerdict），
# 而相对路径是逐段拼出来的——Windows 的单段目录名里既没有 ':' 也没有 '\'，所以一整条绝对路径（形如
# %LOCALAPPDATA%\dsh-pathfinder-testbed\workspaces\workspace-alpha）在相对路径里连不成一片，
# 那样的条目一条也认不出来。签名一律取「能在相对路径里连续出现的片段」：
#   * 合成会话 id（它本身就是单个路径段）；
#   * 合成工作区的目录名（会话按 cwd 归目录，这个名字会被 Get-ProjectKey 编进 project key 那一段）；
#   * 测试床根目录的叶子名（本格派生的 key 全都含它，这条是兜底的那一张网）。
function Get-TestbedLeakSignatures {
  param(
    [Parameter(Mandatory=$true)][string]$Root,
    [AllowEmptyCollection()]$Sessions = @(),
    [AllowEmptyCollection()]$Workspaces = @()
  )
  $signatures = New-Object System.Collections.Generic.List[string]
  foreach ($session in @($Sessions)) {
    if ($null -eq $session) { continue }
    $id = [string]$session.sessionId
    if ($id.Length -gt 0 -and -not $signatures.Contains($id)) { $signatures.Add($id) }
  }
  foreach ($ws in @($Workspaces)) {
    if ($null -eq $ws) { continue }
    $name = Split-Path -Leaf ([string]$ws.path)
    if ($name.Length -gt 0 -and -not $signatures.Contains($name)) { $signatures.Add($name) }
  }
  $rootLeaf = Split-Path -Leaf ([System.IO.Path]::GetFullPath($Root).TrimEnd('\'))
  if ($rootLeaf.Length -gt 0 -and -not $signatures.Contains($rootLeaf)) { $signatures.Add($rootLeaf) }
  return @($signatures.ToArray())
}

# 一处主 home 面的判定：把「跑前基准 vs 跑后」的变化集按归属切开，给出这一面算不算过。
# 判据 4 的口径（见 report.md 的偏差一节）：**每条差异都要能被正面证明不是本格写的**，两条正面证据取并集：
#   * S1 结构性：project key 与本格派生的所有 key 都不同，且编码后缀是本 profile 写不出的那一种（两条都要）；
#   * S2 见证集：「测试床实例没在跑」的观测窗里确实动过的路径；
#   两条都不满足的变化一律失败。前缀保留：+ 新建 / ~ 改写 / - 删除。
# 硬失败面不参与任何豁免：带本格造出来的名字的路径（泄漏签名）、两处静区的任何变化、**任何删除**（- 前缀）。
# 四档（exempt / deletions / leaks / unattributed）**互斥**：每条变化只落一档，四档的条目合起来正好盖住全部变化，
# 一条不多、一条不少。partitionConsistent 记录这个自查成没成（入口把它当断言印出来；判据仍旧只看那三项计数）。
# passed 只由三项计数决定（deletions / unattributed / leaks 全为 0）；exempt* / exemptReasons / subset* /
# partitionConsistent 是印出来的读数，其中 subset* 是支撑读数：它由那三项计数蕴含，当不了独立证据。
function Get-MainHomeAreaVerdict {
  param(
    [Parameter(Mandatory=$true)][string]$Name,
    [Parameter(Mandatory=$true)]$Before,
    [Parameter(Mandatory=$true)]$After,
    [Parameter(Mandatory=$true)][bool]$QuietArea,
    [AllowEmptyCollection()][string[]]$LiveWitness = @(),
    [AllowEmptyCollection()][string[]]$LeakSignatures = @(),
    [AllowEmptyCollection()][string[]]$FixtureProjectKeys = @(),
    [AllowEmptyCollection()][string[]]$FixtureEncodings = @('.jsonl')
  )
  $witnessKeys = New-Object System.Collections.Generic.HashSet[string]
  foreach ($key in @($LiveWitness)) { if ($null -ne $key) { $null = $witnessKeys.Add([string]$key) } }
  $changed = @(Compare-AreaFingerprint -Before $Before -After $After)
  $exempt = New-Object System.Collections.Generic.List[string]
  $exemptStructural = New-Object System.Collections.Generic.List[string]
  $exemptWitnessed = New-Object System.Collections.Generic.List[string]
  $exemptReasons = [ordered]@{}
  $deletions = New-Object System.Collections.Generic.List[string]
  $leaks = New-Object System.Collections.Generic.List[string]
  $unattributed = New-Object System.Collections.Generic.List[string]
  foreach ($change in $changed) {
    $rel = $change.Substring(1)
    $named = $false
    foreach ($signature in @($LeakSignatures)) {
      if ([string]::IsNullOrEmpty([string]$signature)) { continue }
      if ($rel -like "*$signature*") { $named = $true; break }
    }
    # 四档**互斥**：每条变化只落一档，落到就 continue（于是每条变化在明细里只印一行，
    # 读数里那四个计数相加必然等于 changed 的条数——同一格在 lib 里算出来当断言用）。
    # 顺序：删除 -> 带本格名字 -> 静区 -> 豁免／未归属。
    #   删除排在最前：一条被删掉的路径即便带着本格名字，也按「删除」记一次，不再同时落进命名档
    #   —— 否则读数会在「删除 0 条」的同时列出一条真的删除，或者反过来在「带本格名字 0 条」
    #   的同时列出一条显然带名字的路径。两档都是硬失败，判定结果不受这个归属影响。
    if ($change.StartsWith('-')) { $deletions.Add($change); continue }
    if ($named) { $leaks.Add($change); continue }
    if ($QuietArea) { $unattributed.Add($change); continue }
    # 两条正面证据取并集：先看结构性那一条，再看见证集那一条。
    $structural = Test-StructuralExemption -RelativePath $rel -FixtureProjectKeys $FixtureProjectKeys -FixtureEncodings $FixtureEncodings
    $witnessed = $witnessKeys.Contains("$Name/$rel")
    if ($structural.exempt) {
      $exempt.Add($change)
      $exemptStructural.Add($change)
      $reason = $structural.reason
      if ($witnessed) { $reason = $reason + ' (this path is also in the live-write witness set)' }
      $exemptReasons[$change] = $reason
      continue
    }
    if ($witnessed) {
      $exempt.Add($change)
      $exemptWitnessed.Add($change)
      $exemptReasons[$change] = 'S2 witness: this path changed during an observation window opened while no testbed instance was running; ' + $structural.reason
      continue
    }
    $unattributed.Add($change)
  }
  $exemptPaths = @($exempt | ForEach-Object { $_.Substring(1) })
  # 摘掉豁免路径之后的子集比对：它把「被豁免的那几条」从两侧各摘一遍，于是只要 deletions / unattributed /
  # leaks 三项为 0（＝每条变化都进了豁免），两侧子集必然逐条相同——它是那三项计数的复述，给不出独立证据，
  # 因此**不进 $passed**：判定的依据就是那三项计数。仍旧算出来，作为支撑读数印给人看。
  $subsetBefore = Get-FingerprintSubset -Fingerprint $Before -Exclude $exemptPaths
  $subsetAfter = Get-FingerprintSubset -Fingerprint $After -Exclude $exemptPaths
  $subsetIdentical = ($subsetBefore.fileCount -eq $subsetAfter.fileCount) -and ($subsetBefore.digest -eq $subsetAfter.digest)
  $passed = ($deletions.Count -eq 0) -and ($unattributed.Count -eq 0) -and ($leaks.Count -eq 0)
  # 四档互斥的自查：把四档的条目收成一堆，条数要等于变化条数（一条不漏），去重后的条数也要等于变化条数
  # （一条不重）。入口把它当断言印出来：读数与明细行相抵时，这里当场露。
  $filed = New-Object System.Collections.Generic.List[string]
  foreach ($entry in @($exempt)) { $filed.Add([string]$entry) }
  foreach ($entry in @($deletions)) { $filed.Add([string]$entry) }
  foreach ($entry in @($leaks)) { $filed.Add([string]$entry) }
  foreach ($entry in @($unattributed)) { $filed.Add([string]$entry) }
  $filedDistinct = @($filed | Sort-Object -Unique)
  $partitionConsistent = ($filed.Count -eq $changed.Count) -and ($filedDistinct.Count -eq $changed.Count)
  return [ordered]@{
    name = $Name
    quietArea = $QuietArea
    changed = $changed
    exempt = @($exempt.ToArray())
    exemptStructural = @($exemptStructural.ToArray())
    exemptWitnessed = @($exemptWitnessed.ToArray())
    exemptReasons = $exemptReasons
    exemptPaths = @($exemptPaths)
    deletions = @($deletions.ToArray())
    leaks = @($leaks.ToArray())
    unattributed = @($unattributed.ToArray())
    subsetBefore = $subsetBefore
    subsetAfter = $subsetAfter
    subsetIdentical = $subsetIdentical
    filedCount = $filed.Count
    filedDistinctCount = $filedDistinct.Count
    partitionConsistent = $partitionConsistent
    passed = $passed
  }
}

# ---------------------------------------------------------------------------
# 合成记录落盘
# ---------------------------------------------------------------------------

# 造一份合成工作区目录（含一小份可数的记录）与会话日志，并把清单写进 <Root>\logs\fixture.json。
# 参数化：-WorkspaceName / -SessionCount 造第二份工作区、第二条会话；-EmptyWorkspaceName 造一份没有会话的工作区。
function New-TestbedFixture {
  param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$Profile,
    [string]$WorkspaceName = 'workspace-alpha',
    [int]$SessionCount = 1,
    [string]$EmptyWorkspaceName = '',
    [string]$NodeExe = 'node'
  )
  $testbedHome = Join-Path $Root 'home'
  $logs = Join-Path $Root 'logs'
  $storages = Join-Path $testbedHome 'storages'
  $sessions = Join-Path $testbedHome 'sessions'
  foreach ($d in @($testbedHome, $logs, $storages, $sessions)) {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
  }

  $now = [DateTime]::UtcNow
  $iso = $now.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  $epochMs = [long]([DateTimeOffset]$now).ToUnixTimeMilliseconds()

  # 主工作区：一个真实存在的目录 + 一份小的可数记录。
  $wsDir = Join-Path $Root ('workspaces\' + $WorkspaceName)
  if (-not (Test-Path -LiteralPath $wsDir)) { New-Item -ItemType Directory -Force -Path $wsDir | Out-Null }
  $wsPath = Get-CanonicalPath -Path $wsDir -NodeExe $NodeExe

  $records = [ordered]@{
    kind = 'panel-records'
    note = 'hand-authored sample for the isolated testbed; counts are the point, not the volume'
    nodes = @(
      [ordered]@{ id = 'node-1'; title = 'collect panel readings'; state = 'done' },
      [ordered]@{ id = 'node-2'; title = 'render the ledger column'; state = 'active' },
      [ordered]@{ id = 'node-3'; title = 'verify grouping'; state = 'pending' }
    )
    dependencyEdges = @(
      [ordered]@{ from = 'node-1'; to = 'node-2' },
      [ordered]@{ from = 'node-2'; to = 'node-3' }
    )
    issues = @(
      [ordered]@{ id = 'issue-1'; title = 'column widths drift on a narrow window'; status = 'open' },
      [ordered]@{ id = 'issue-2'; title = 'empty workspace has no placeholder row'; status = 'open' }
    )
  }
  Write-TextFile -Path (Join-Path $wsDir 'panel-records.json') -Text (($records | ConvertTo-Json -Depth 10) + "`n")

  $workspaces = New-Object System.Collections.Generic.List[object]
  $sessionRows = New-Object System.Collections.Generic.List[object]

  $wsId = [guid]::NewGuid().ToString()
  $wsSessionIds = New-Object System.Collections.Generic.List[string]

  for ($i = 1; $i -le $SessionCount; $i++) {
    $sid = [guid]::NewGuid().ToString()
    $projectKey = Get-ProjectKey -Cwd $wsPath
    $sessionDir = Join-Path (Join-Path $sessions $projectKey) (Get-EncodedSegment -Raw $sid)
    $logPath = Join-Path $sessionDir 'session.v4.jsonl'
    $createdMs = $epochMs + $i

    # 第一行是会话 header：字段名与类型必须落在产品侧允许的那一组里，多一个键就会被整条丢弃。
    $header = '{"type":"session","version":4,"id":' + (ConvertTo-JsonString $sid) +
      ',"createdAt":' + $createdMs +
      ',"cwd":' + (ConvertTo-JsonString $wsPath) +
      ',"isSeeded":false,"delegationDepth":0}'
    # 会话正文：一对最小的 turn/start + turn/end。seq 必须与行序一致（从 0 起、不跳号）。
    $event0 = '{"type":"turn/start","seq":0,"time":' + ($createdMs + 1) + ',"data":{"turn":1}}'
    $event1 = '{"type":"turn/end","seq":1,"time":' + ($createdMs + 2) + ',"data":{"turn":1}}'
    Write-TextFile -Path $logPath -Text ($header + "`n" + $event0 + "`n" + $event1 + "`n")

    $wsSessionIds.Add($sid)
    $sessionRows.Add([ordered]@{
      sessionId = $sid
      workspaceId = $wsId
      workspacePath = $wsPath
      logPath = $logPath
      projectDir = $projectKey
      eventCount = 2
    })
  }

  $workspaces.Add([ordered]@{
    workspaceId = $wsId
    name = $WorkspaceName
    path = $wsPath
    title = 'Synthetic Workspace Alpha'
    sessionIds = @($wsSessionIds.ToArray())
    empty = $false
    recordsPath = (Join-Path $wsDir 'panel-records.json')
  })

  if ($EmptyWorkspaceName.Length -gt 0) {
    $emptyDir = Join-Path $Root ('workspaces\' + $EmptyWorkspaceName)
    if (-not (Test-Path -LiteralPath $emptyDir)) { New-Item -ItemType Directory -Force -Path $emptyDir | Out-Null }
    $emptyPath = Get-CanonicalPath -Path $emptyDir -NodeExe $NodeExe
    $workspaces.Add([ordered]@{
      workspaceId = [guid]::NewGuid().ToString()
      name = $EmptyWorkspaceName
      path = $emptyPath
      title = 'Synthetic Workspace Empty'
      sessionIds = @()
      empty = $true
      recordsPath = ''
    })
  }

  # 工作区注册表：只读一次、没有 watcher，所以在实例停着的时候整份写下来。
  $ids = @($workspaces | ForEach-Object { $_.workspaceId })
  $table = [ordered]@{}
  $order = [ordered]@{
    initialized = $true
    workspaceIds = $ids
    archivedSessionIds = @()
    pinnedSessionIds = @()
  }
  foreach ($w in $workspaces) {
    $table[$w.workspaceId] = [ordered]@{
      path = $w.path
      title = $w.title
      sessionIds = @($w.sessionIds)
      createdAt = $iso
      updatedAt = $iso
    }
  }
  $document = [ordered]@{
    unit = [ordered]@{ name = 'workspace'; version = 2 }
    global = $order
    tables = [ordered]@{ workspaces = $table }
  }
  Write-TextFile -Path (Join-Path $storages 'workspace.json') -Text (($document | ConvertTo-Json -Depth 12) + "`n")

  $manifest = [ordered]@{
    kind = 'dsh-pathfinder-testbed-fixture'
    createdAt = $iso
    root = $Root
    home = $testbedHome
    profile = $Profile
    workspaces = @($workspaces.ToArray())
    sessions = @($sessionRows.ToArray())
  }
  Write-TextFile -Path (Join-Path $logs 'fixture.json') -Text (($manifest | ConvertTo-Json -Depth 12) + "`n")
  return $manifest
}

# header 里的计数型字段（version / createdAt / delegationDepth）必须是数值：
# 产品侧那一层（dsh-session-format 的 header 校验）要求非负整数，写成字符串的那种
# 不会被当成错——那一条会话直接从清单里消失。这里按类型拦下来。
function Test-HeaderInteger {
  param($Value)
  if ($Value -is [bool]) { return $false }
  if ($Value -is [int] -or $Value -is [long] -or $Value -is [short] -or $Value -is [byte]) { return ([double]$Value -ge 0) }
  if ($Value -is [double] -or $Value -is [decimal] -or $Value -is [single]) {
    return (([double]$Value -ge 0) -and ([double]$Value -eq [math]::Floor([double]$Value)))
  }
  return $false
}

# 校验一条合成会话的 header 与磁盘落点：先验头部，再看清单（头部不合法时清单里会静默少一条）。
# 字段集合、字段类型（字符串 / 数值 / 布尔）、id 与磁盘落点互认、事件 seq 致密，四样都验。
function Test-TestbedSessionFixture {
  param([Parameter(Mandatory=$true)]$Session)
  $problems = New-Object System.Collections.Generic.List[string]
  $logPath = [string]$Session.logPath
  if (-not (Test-Path -LiteralPath $logPath)) {
    $problems.Add("session log missing: $logPath")
    return @($problems)
  }
  $lines = [System.IO.File]::ReadAllLines($logPath)
  if ($lines.Length -lt 1) { $problems.Add('session log is empty'); return @($problems) }
  $header = $null
  try { $header = $lines[0] | ConvertFrom-Json } catch { $problems.Add("header is not JSON: $($lines[0])") ; return @($problems) }
  $required = @('type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth')
  $optional = @('cwd', 'parentSession', 'origin', 'agentPreset')
  foreach ($key in $required) {
    if (-not ($header.PSObject.Properties.Name -contains $key)) { $problems.Add("header lacks required field '$key'") }
  }
  foreach ($key in $header.PSObject.Properties.Name) {
    if (-not ($required -contains $key) -and -not ($optional -contains $key)) { $problems.Add("header has field outside the allowed set: '$key'") }
  }
  if ($header.type -isnot [string]) { $problems.Add("header type is not a string: '$($header.type)'") }
  elseif ($header.type -ne 'session') { $problems.Add("header type is '$($header.type)'") }
  if (-not (Test-HeaderInteger -Value $header.version)) { $problems.Add("header version is not a non-negative integer: '$($header.version)'") }
  elseif ($header.version -ne 4) { $problems.Add("header version is '$($header.version)'; this fixture writes v4") }
  if ($header.id -isnot [string]) { $problems.Add("header id is not a string: '$($header.id)'") }
  elseif ([string]$header.id -ne [string]$Session.sessionId) { $problems.Add('header id does not match the requested session id') }
  if (-not (Test-HeaderInteger -Value $header.createdAt)) { $problems.Add("header createdAt is not a non-negative integer: '$($header.createdAt)'") }
  if ($header.cwd -isnot [string] -or [string]::IsNullOrEmpty([string]$header.cwd)) {
    # 没有可用的 cwd 就算不出磁盘落点，后面两条（落点互认、事件 seq）也没法验：先报这一条再收。
    $problems.Add("header cwd is not a usable string: '$($header.cwd)'")
    return @($problems)
  }
  if ($header.cwd -ne [string]$Session.workspacePath) { $problems.Add('header cwd does not match the workspace path') }
  if ($header.isSeeded -isnot [bool]) { $problems.Add("header isSeeded is not a boolean: '$($header.isSeeded)'") }
  elseif ($header.isSeeded -ne $false) { $problems.Add('header isSeeded is not false') }
  if (-not (Test-HeaderInteger -Value $header.delegationDepth)) { $problems.Add("header delegationDepth is not a non-negative integer: '$($header.delegationDepth)'") }
  $expectedPath = Join-Path (Join-Path (Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $logPath))) (Get-ProjectKey -Cwd ([string]$header.cwd))) (Get-EncodedSegment -Raw ([string]$header.id))) 'session.v4.jsonl'
  if ($expectedPath -ne $logPath) { $problems.Add("header id + cwd identify '$expectedPath' but the log sits at '$logPath'") }
  for ($i = 1; $i -lt $lines.Length; $i++) {
    if ($lines[$i].Trim().Length -eq 0) { continue }
    $event = $null
    try { $event = $lines[$i] | ConvertFrom-Json } catch { $problems.Add("event line $i is not JSON") ; continue }
    if ($event.seq -ne ($i - 1)) { $problems.Add("event line $i carries seq $($event.seq), expected $($i - 1)") }
  }
  return @($problems)
}

# ---------------------------------------------------------------------------
# profile 与实例
# ---------------------------------------------------------------------------

# 从 web 模板造出隔离 profile，并把会话压缩那一档固定成 none（profile 的 cordis.patch.yml）。
# 用 --dump-config 造 profile：它会写下 profile 再打印合成后的树并退出，不会起服务。
function New-TestbedProfile {
  param([Parameter(Mandatory=$true)][string]$TestbedHome, [Parameter(Mandatory=$true)][string]$Profile, [string]$DshCmd = 'dsh')
  $profileDir = Join-Path $TestbedHome ('profiles\' + $Profile)
  $previous = $env:DSH_HOME
  try {
    $env:DSH_HOME = $TestbedHome
    $dump = & $DshCmd $Profile --from-default-profile web --dump-config 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "profile creation failed: $dump" }
    if (-not (Test-Path -LiteralPath $profileDir)) { throw "profile directory was not created: $profileDir" }
    # 用户层是 id 定向的补丁：config 是整块替换而不是逐键合并，故 root 必须一起写回去。
    $patch = @(
      '# pf testbed profile layer.',
      '# Sessions in this home are stored as plaintext JSONL: the physical encoding is exclusive',
      '# across one session root, and this home is rebuilt from scratch on every provision.',
      '- id: session-persistence-jsonl',
      '  config:',
      "    root: !!js dshHomePath('sessions')",
      '    compression: none'
    ) -join "`n"
    Write-TextFile -Path (Join-Path $profileDir 'cordis.patch.yml') -Text ($patch + "`n")
    $after = & $DshCmd $Profile --dump-config 2>&1 | Out-String
    if ($after -notmatch 'compression: none') { throw 'profile patch did not compose compression: none' }
    if ($after -notmatch "root: !!js dshHomePath\('sessions'\)") { throw 'profile patch dropped the session root' }
    return $profileDir
  } finally { $env:DSH_HOME = $previous }
}

# 起一个脱离当前进程的实例：立刻返回，PID 记进 <Root>\logs\instance.pid。
function Start-TestbedInstance {
  param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$TestbedHome,
    [Parameter(Mandatory=$true)][string]$Profile,
    [string]$DshCmd = 'dsh',
    [string]$NodeExe = 'node'
  )
  $out = Join-Path $Root 'logs\instance.out.log'
  $err = Join-Path $Root 'logs\instance.err.log'
  foreach ($f in @($out, $err)) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force } }
  $dshArgs = @($Profile)
  if (-not (Test-Path -LiteralPath (Join-Path $TestbedHome ('profiles\' + $Profile)))) {
    $dshArgs += @('--from-default-profile', 'web')
  }
  $dshArgs += @('--port', '0', '--no-open')

  # 启动器是落在盘上的 .cmd：它自己设 DSH_HOME，并且把三路流都指到文件/NUL。
  # 这样常驻的 cmd.exe / node 不会继承调用方（harness）的管道句柄，调用方才能立刻返回。
  $nodeApplication = Resolve-ApplicationExecutable -Name $NodeExe
  $entry = Join-Path (Split-Path -Parent $DshCmd) 'node_modules\@deepseek-ai\dsh\lib\bin.js'
  if (Test-Path -LiteralPath $entry) {
    $command = '"' + $nodeApplication + '" "' + $entry + '" ' + ($dshArgs -join ' ')
  } else {
    $command = '"' + $DshCmd + '" ' + ($dshArgs -join ' ')
  }
  $launcherPath = Join-Path $Root ('logs\start-' + $Profile + '.cmd')
  $launcher = @(
    'rem Launcher written by the testbed provisioner.',
    'rem It pins the isolated home and gives all three streams a file or NUL, so a long-lived',
    'rem instance never holds a handle that belongs to whoever started it.',
    '@echo off',
    ('set "DSH_HOME=' + $TestbedHome + '"'),
    ($command + ' > "' + $out + '" 2> "' + $err + '" < NUL')
  ) -join "`n"
  Write-TextFile -Path $launcherPath -Text ($launcher + "`n")

  $proc = Start-Process -FilePath $launcherPath -WindowStyle Hidden -PassThru
  Write-TextFile -Path (Join-Path $Root 'logs\instance.pid') -Text ($proc.Id.ToString() + "`n")
  Write-TextFile -Path (Join-Path $Root 'logs\instance-launch.txt') -Text (
    "startedAt=$([DateTime]::UtcNow.ToString('o'))`nlauncherPid=$($proc.Id)`nlauncher=$launcherPath`nDSH_HOME=$TestbedHome`ncommand=$command`n")
  return $proc.Id
}

# 就绪探测：读实例自己的输出里那一行 URL（带退避与上限），进程提前退出就立刻报错。
function Wait-TestbedReady {
  param([Parameter(Mandatory=$true)][string]$Root, [Parameter(Mandatory=$true)][int]$ProcessId, [int]$TimeoutSeconds = 30)
  $log = Join-Path $Root 'logs\instance.out.log'
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $backoffMs = 50
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $log) {
      $text = Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue
      if ($text -match 'dsh web:\s*(http://\S+)') {
        $url = $Matches[1]
        $portMatch = [regex]::Match($url, ':(\d+)/')
        $tokenMatch = [regex]::Match($url, 'token=([^&\s]+)')
        if (-not $portMatch.Success) { throw "cannot read the port out of '$url'" }
        return [ordered]@{
          url = $url
          port = [int]$portMatch.Groups[1].Value
          token = $(if ($tokenMatch.Success) { $tokenMatch.Groups[1].Value } else { '' })
        }
      }
    }
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
      $errText = ''
      $errPath = Join-Path $Root 'logs\instance.err.log'
      if (Test-Path -LiteralPath $errPath) { $errText = (Get-Content -LiteralPath $errPath -Raw) }
      throw "instance $ProcessId exited before printing its URL. stderr: $errText"
    }
    # Start-Process 起的子进程只给出一个日志文件，没有可挂的事件；这里按退避轮询该文件，上限 TimeoutSeconds。
    Start-Sleep -Milliseconds $backoffMs
    if ($backoffMs -lt 500) { $backoffMs = $backoffMs * 2 }
  }
  throw "instance $ProcessId printed no URL within $TimeoutSeconds s"
}

# 一个测试床实例的进程：启动器 .cmd 的路径只由这一格写出来，命令行里带着它就足以确认身份。
function Get-TestbedInstanceProcesses {
  param([Parameter(Mandatory=$true)][string]$Root, [Parameter(Mandatory=$true)][string]$Profile)
  $launcher = Join-Path $Root ('logs\start-' + $Profile + '.cmd')
  $found = New-Object System.Collections.Generic.List[object]
  foreach ($proc in (Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" -ErrorAction SilentlyContinue)) {
    $cmdline = [string]$proc.CommandLine
    if ($cmdline.Length -gt 0 -and $cmdline -like "*$launcher*") { $found.Add($proc) }
  }
  return @($found.ToArray())
}

# 只收自己记下来的那个 PID：先核对命令行里确实是这个 profile，再连同子进程一起收掉。
# pid 文件不在（或那个进程已经没了）时，退回到"命令行里带着本格启动器路径"的那一份，一样先核对再收。
function Stop-TestbedInstance {
  param([Parameter(Mandatory=$true)][string]$Root, [Parameter(Mandatory=$true)][string]$Profile)
  $pidFile = Join-Path $Root 'logs\instance.pid'
  $targets = New-Object System.Collections.Generic.List[object]
  if (Test-Path -LiteralPath $pidFile) {
    $text = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    $instancePid = 0
    if (-not [int]::TryParse($text, [ref]$instancePid)) { throw "pid file does not hold a number: $text" }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $instancePid" -ErrorAction SilentlyContinue
    if ($null -ne $proc) {
      $cmdline = [string]$proc.CommandLine
      if (($cmdline -notlike "*$Profile*") -or ($cmdline -notlike '*dsh*')) {
        throw "refusing to kill pid $instancePid : command line is not this testbed instance ('$cmdline')"
      }
      $targets.Add($proc)
    }
  }
  if ($targets.Count -eq 0) {
    foreach ($proc in (Get-TestbedInstanceProcesses -Root $Root -Profile $Profile)) {
      if ($proc.Name -eq 'cmd.exe') { $targets.Add($proc) }
    }
  }
  if ($targets.Count -eq 0) {
    if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force }
    return $false
  }
  foreach ($proc in $targets) {
    & taskkill.exe /PID $proc.ProcessId /T /F 2>&1 | Out-Null
    # 等退出用 Wait-Process（进程退出事件），不轮询。
    Wait-Process -Id $proc.ProcessId -Timeout 15 -ErrorAction SilentlyContinue
    if ($null -ne (Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue)) {
      throw "instance $($proc.ProcessId) is still alive after taskkill"
    }
  }
  if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force }
  return $true
}

# 端口上还有人监听吗（用来证明收尾干净；一次连接尝试，不轮询）。
function Test-TcpListener {
  param([Parameter(Mandatory=$true)][int]$Port, [int]$TimeoutMs = 1500)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync('127.0.0.1', $Port)
    if (-not $task.Wait($TimeoutMs)) { return $false }
    return $client.Connected
  } catch { return $false } finally { $client.Close() }
}

# 一个进程的祖先链（从父进程往上，最多 64 层）：用来把调用者自身从收尾断言里排除出去。
function Get-ProcessAncestorIds {
  param([Parameter(Mandatory=$true)][int]$ProcessId, [AllowEmptyCollection()]$ProcessTable = $null)
  $table = $(if ($null -ne $ProcessTable) { @($ProcessTable) } else { @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) })
  $parentOf = @{}
  foreach ($proc in $table) { $parentOf[[int]$proc.ProcessId] = [int]$proc.ParentProcessId }
  $chain = New-Object System.Collections.Generic.List[int]
  $current = $ProcessId
  for ($step = 0; $step -lt 64; $step++) {
    if (-not $parentOf.ContainsKey($current)) { break }
    $parent = [int]$parentOf[$current]
    if ($parent -le 0 -or $chain.Contains($parent)) { break }
    $chain.Add($parent)
    $current = $parent
  }
  return @($chain.ToArray())
}

# 收尾断言：还有没有**属于本测试床**的 node/cmd 进程在跑。认的是本格自己写下过的那份身份：
#   ① 命令行里带着本格自己写下的那份启动器路径（<Root>\logs\start-<profile>.cmd）；
#   ② 是「本格写下过的实例 pid」的后代——pid 文件里的那个 pid，加上调用方传进来的本次运行自己起的那几个。
#      实例那条 node 的命令行里不含启动器路径，只有按 pid 树才认得出来；父亲已经死掉的孤儿也算，
#      靠它自己记着的 ParentProcessId 从身份 pid 那一边找回来。
# 并显式排除调用者自身与它的祖先链：跑 check 的那个 shell 及其宿主的命令行里，只要调用方提过运行根
# （显式传 -Root 就是最直接的例子），旧的子串判据就会把调用者自己读成「测试床残留」——于是同一份交付物、
# 同一个盘上状态，换个调用写法就换一个退出码。真正的残留进程永远不可能是调用者的祖先，排除它不影响这一条。
function Get-StrayTestbedProcess {
  param(
    [Parameter(Mandatory=$true)][string]$Root,
    # 默认值就是本入口用的那个 profile 名：交付的入口每次显式传 -Profile，这一层默认值留给别处的调用
    # （前两轮的探针里就有只传 -Root 的），免得这次换判据把它们的调用方式一起弄断。
    [string]$Profile = 'pf-testbed',
    [AllowEmptyCollection()][int[]]$InstancePids = @()
  )
  $launcher = Join-Path $Root ('logs\start-' + $Profile + '.cmd')
  $table = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  # 排除集＝调用者自身（跑这一格的那个 pwsh）＋它的祖先链（它的宿主进程们）。
  $excluded = New-Object System.Collections.Generic.HashSet[int]
  $null = $excluded.Add([int]$PID)
  foreach ($ancestor in (Get-ProcessAncestorIds -ProcessId $PID -ProcessTable $table)) { $null = $excluded.Add([int]$ancestor) }
  # 身份本体：本格写下过的实例 pid。
  $identityPids = New-Object System.Collections.Generic.HashSet[int]
  $pidFile = Join-Path $Root 'logs\instance.pid'
  if (Test-Path -LiteralPath $pidFile) {
    $instancePid = 0
    if ([int]::TryParse(((Get-Content -LiteralPath $pidFile -Raw).Trim()), [ref]$instancePid)) { $null = $identityPids.Add($instancePid) }
  }
  foreach ($id in @($InstancePids)) { $null = $identityPids.Add([int]$id) }
  # 从身份 pid 出发逐层收后代（父亲那条边已断的孤儿也收得到）。
  $descendants = New-Object System.Collections.Generic.HashSet[int]
  foreach ($id in $identityPids) { $null = $descendants.Add([int]$id) }
  $grew = $true
  while ($grew) {
    $grew = $false
    foreach ($proc in $table) {
      $procId = [int]$proc.ProcessId
      if ($descendants.Contains($procId)) { continue }
      if ($descendants.Contains([int]$proc.ParentProcessId)) { $null = $descendants.Add($procId); $grew = $true }
    }
  }
  $found = New-Object System.Collections.Generic.List[string]
  foreach ($proc in $table) {
    if ($proc.Name -ne 'node.exe' -and $proc.Name -ne 'cmd.exe') { continue }
    $procId = [int]$proc.ProcessId
    if ($excluded.Contains($procId)) { continue }
    $cmdline = [string]$proc.CommandLine
    $byLauncher = ($cmdline.Length -gt 0 -and $cmdline -like "*$launcher*")
    $byTree = $descendants.Contains($procId)
    if (-not ($byLauncher -or $byTree)) { continue }
    $how = $(if ($byLauncher -and $byTree) { 'launcher path + instance pid tree' } elseif ($byLauncher) { 'launcher path' } else { 'instance pid tree' })
    $found.Add("$procId $($proc.Name) [$how]: $cmdline")
  }
  return @($found.ToArray())
}

# ---------------------------------------------------------------------------
# HTTP 调用（实例自己的 /api 接口）
# ---------------------------------------------------------------------------

# 拿实例的启动 token 换一个浏览器 cookie：GET URL 会 303 到 ./ 并把 cookie 种进会话。
function Connect-TestbedBrowser {
  param([Parameter(Mandatory=$true)][string]$Url)
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $null = Invoke-WebRequest -Uri $Url -WebSession $session -MaximumRedirection 5 -TimeoutSec 20 -UseBasicParsing
  return $session
}

# 一次 /api/<namespace>/<method> 调用：请求信封恰好是 { type, rpcId, method, payload:{ args } }，响应是 { result:{ ok, value } }。
# 端点拼写是 <namespace>/<method>（实例只认两段式路径），信封里的 method 与之逐字相同；
# args 的键名由方法签名决定：session/list 是 _request，session/page、session/projections、workspace/create 是 request。
function Invoke-TestbedApi {
  param(
    [Parameter(Mandatory=$true)][int]$Port,
    [Parameter(Mandatory=$true)]$WebSession,
    [Parameter(Mandatory=$true)][string]$Endpoint,
    $Arguments = @{},
    [string]$EvidencePath = ''
  )
  $envelope = [ordered]@{
    type = 'client-request'
    rpcId = [guid]::NewGuid().ToString('n')
    method = $Endpoint
    payload = [ordered]@{ args = $Arguments }
  }
  $body = $envelope | ConvertTo-Json -Depth 20 -Compress
  $base = "http://127.0.0.1:$Port"
  $response = Invoke-WebRequest -Uri "$base/api/$Endpoint" -Method Post -WebSession $WebSession `
    -ContentType 'application/json' -Body $body -TimeoutSec 30 -UseBasicParsing
  $text = [string]$response.Content
  if ($EvidencePath.Length -gt 0) {
    Write-TextFile -Path ($EvidencePath + '.request.json') -Text $body
    Write-TextFile -Path ($EvidencePath + '.response.json') -Text $text
  }
  $parsed = $text | ConvertFrom-Json
  if ($parsed.result.ok -ne $true) {
    $code = $parsed.result.error.code
    $message = $parsed.result.error.message
    throw "endpoint $Endpoint returned an error result: ${code}: $message"
  }
  return $parsed.result.value
}

# 完成判定第 1 条要的「一条命令把会话列表打出来」。
#   * 只印一种 shell：入口自己跑的那个 shell（pwsh）。两种 shell 的引法不一样（cmd 里单引号是普通字符、
#     %TEMP% 才展开；pwsh 里单引号里的 JSON 原样送出、$env:TEMP 才展开），并排印两行只会让人拿错那一行。
#   * 印出来的就是一行：原样粘进 pwsh 回车，就把清单打出来（第一段取 cookie，第二段打清单）。
#   * curl 带 -f：HTTP 4xx/5xx 时退出码非零，免得"被拒了但 curl 退 0"读成成功。
function Format-TestbedListCommand {
  param([Parameter(Mandatory=$true)][int]$Port, [Parameter(Mandatory=$true)][string]$Token)
  $body = '{"type":"client-request","rpcId":"list-1","method":"session/list","payload":{"args":{"_request":{}}}}'
  $cookieJar = '"$env:TEMP\pf-testbed-cookies.txt"'
  $line1 = 'curl.exe -s -f -c ' + $cookieJar + ' "http://127.0.0.1:' + $Port + '/?token=' + $Token + '" -o NUL'
  $line2 = 'curl.exe -s -f -b ' + $cookieJar + ' -H "content-type: application/json" -d ''' + $body + ''' http://127.0.0.1:' + $Port + '/api/session/list'
  # 一行；不要用带 + 的数组元素去 join（逗号与 + 的优先级会把两段粘错）。
  return ($line1 + '; ' + $line2)
}