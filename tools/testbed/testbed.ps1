# testbed.ps1 —— testbed entry: one command, three actions.
#
#   pwsh -File tools/testbed/testbed.ps1 -Action up      start the testbed instance (isolated home + its own profile + synthetic
#                                                        workspaces + this repo's panel installed into that profile), left running to inspect
#   pwsh -File tools/testbed/testbed.ps1 -Action check   run all five spec completion criteria 1-5, printing each reading; non-zero exit on failure
#   pwsh -File tools/testbed/testbed.ps1 -Action down    stop only the PID this script recorded (verify the command line first, never kill by process name)
#
# Everything it creates lives under -Root (default %LOCALAPPDATA%\dsh-pathfinder-testbed): not in the repo, never touches the main home.
# Synthetic records are authored here; this script only describes what it does and what its limits are.
#
# Parameters: -Workspace renames the workspace, -SessionCount adds a second session, -EmptyWorkspace adds a session-less workspace,
# -Plugin swaps the plugin installed into the profile (default is this repo; relative paths are resolved against the caller's current
# directory; a `.tgz` from npm pack installs in package form), -SeedRecords drops a real record into a synthetic workspace (copied as `.pf`,
# effective on the up action only; without it the workspace is untouched — the default run creates one workspace and one session.

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
  [string]$Plugin = '',
  [string]$SeedRecords = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'testbed-lib.ps1')

if ($Root.Length -eq 0) { $Root = Join-Path $env:LOCALAPPDATA 'dsh-pathfinder-testbed' }
if ($MainHome.Length -eq 0) { $MainHome = Join-Path $env:USERPROFILE '.dsh' }
# The default plugin is this repo: two levels up from `tools\testbed\` is the project root.
if ($Plugin.Length -eq 0) { $Plugin = Join-Path $PSScriptRoot '..\..' }
# Normalize to an absolute path at the entry: the artifact pre-check and what goes to
# `dsh plugin --profile … add` must be the same value. Otherwise each resolves the relative path
# against its own base — the pre-check against the caller's current directory (so it passes), dsh
# against the profile directory (so it installs a nonexistent directory), and the error then points
# at the profile directory.
$Plugin = [System.IO.Path]::GetFullPath($Plugin)

# Spawn in Application form: Start-Process does not guess extensions and never touches the extensionless POSIX shim in the npm directory.
$DshCmd = Resolve-ApplicationExecutable -Name $DshCmd
$NodeExe = Resolve-ApplicationExecutable -Name $NodeExe

# Keep only summaries in the readings file: per-file lists are too long; raw readings live in check-report.txt and logs\raw.
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

# The three counter-evidence areas for completion criterion 4: the main home's session store, workspace records, credentials.
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

# Lightweight scan for the witness set: takes only "relative path -> length|mtime", never reads
# content (same shape as the full fingerprint's readings; the criteria read the full one).
function Get-MainHomeMetaScan {
  param([Parameter(Mandatory = $true)][string]$MainHome)
  $areas = [ordered]@{}
  foreach ($area in (Get-MainHomeAreas -MainHome $MainHome)) {
    $areas[$area.name] = Get-AreaMetaScan -Path $area.path
  }
  return $areas
}

# Print "one command that prints the session list". Only the pwsh form is printed, labeled as such;
# the command is immediately followed by "what counts as passing".
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

# Guard before deleting the testbed root: never a drive root, never inside the project tree, never overlapping the main home in either direction.
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

# Delete wholesale and rebuild: idempotent in place; a home left over from the previous round is not treated as clean.
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
  # Stop the still-running instance before rebuilding: it holds its own stdout/stderr files open, and they cannot be deleted otherwise.
  $null = Stop-TestbedInstance -Root $Root -Profile $Profile
  if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
  New-Item -ItemType Directory -Force -Path (Join-Path $Root 'logs') | Out-Null
  $testbedHome = Join-Path $Root 'home'
  New-Item -ItemType Directory -Force -Path $testbedHome | Out-Null

  $profileDir = New-TestbedProfile -TestbedHome $testbedHome -Profile $Profile -DshCmd $DshCmd
  $manifest = New-TestbedFixture -Root $Root -Profile $Profile -WorkspaceName $Workspace `
    -SessionCount $SessionCount -EmptyWorkspaceName $EmptyWorkspace -NodeExe $NodeExe

  # Validate the header first, then the manifest: an invalid header makes that session vanish silently, so it must be caught here.
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

# Readings from one instance cycle: completion criteria 1, 2 and 5 all draw from here.
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

  # The optional empty workspace is read too: it should resolve, with an empty member list.
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
    # Listed, grouped under the workspace (both readings of membership require it), and both open
    # steps returned ok results. Zero records in the page is normal: the synthetic session is built
    # to be listable and openable only — its body carries no message events.
    if (-not $row.listed) { $ok = $false }
    if (-not $row.cwdMatches) { $ok = $false }
    if (-not $row.accounted) { $ok = $false }
    if ($row.workspaceCreatedByThisCall) { $ok = $false }
    if (-not $row.pageOpened) { $ok = $false }
    if (-not $row.projectionsOpened) { $ok = $false }
  }
  return $ok
}

# Criterion 2's own verdict: the session is grouped under the workspace, not ungrouped. It reads
# only its own two terms — the session accounted in workspace.sessionIds, and the session.list
# row's cwd equal to the workspace path — so it can turn red on its own while criterion 1 stays
# green; it is not a share of criterion 1's full predicate.
function Test-GroupingCriteria {
  param([Parameter(Mandatory = $true)]$Run)
  $ok = $true
  foreach ($row in $Run.sessions) {
    if (-not $row.accounted) { $ok = $false }
    if (-not $row.cwdMatches) { $ok = $false }
  }
  return $ok
}

# ---------------------------------------------------------------------------
# Action: down
# ---------------------------------------------------------------------------
if ($Action -eq 'down') {
  $safeRoot = Assert-SafeRoot -Root $Root -MainHome $MainHome
  $stopped = Stop-TestbedInstance -Root $safeRoot -Profile $Profile
  Write-Host "testbed root : $safeRoot"
  Write-Host "stopped      : $stopped"
  exit 0
}

# ---------------------------------------------------------------------------
# Action: up
# ---------------------------------------------------------------------------
if ($Action -eq 'up') {
  $safeRoot = Assert-SafeRoot -Root $Root -MainHome $MainHome
  $manifest = Invoke-TestbedProvision -Root $safeRoot -Profile $Profile -Workspace $Workspace `
    -SessionCount $SessionCount -EmptyWorkspace $EmptyWorkspace -DshCmd $DshCmd -NodeExe $NodeExe
  $testbedHome = [string]$manifest.home
  # Optional: drop a real record into a synthetic workspace (the panel reads the workspace-level
  # `.pf`). Without it the workspace is untouched — the default run and check's five criteria never
  # pass through here.
  $recordsReading = @()
  if ($SeedRecords.Length -gt 0) {
    $recordsReading = @(Add-TestbedRecords -Manifest $manifest -RecordsPath $SeedRecords)
  }
  # Install the panel into the isolated profile: of the "one command" this cell must hand over, the
  # "panel installed and pointing at the synthetic workspace" half lands on this step. A failed
  # install stops right here — never start an instance without the panel.
  $pluginReading = Install-TestbedPlugin -Root $safeRoot -TestbedHome $testbedHome -Profile $Profile `
    -PluginPath $Plugin -DshCmd $DshCmd
  $instancePid = Start-TestbedInstance -Root $safeRoot -TestbedHome $testbedHome -Profile $Profile -DshCmd $DshCmd -NodeExe $NodeExe
  $ready = Wait-TestbedReady -Root $safeRoot -ProcessId $instancePid -TimeoutSeconds $ReadyTimeoutSeconds
  # The install must be visible: ask the running instance for two readings (the settings namespace
  # roster + the boot manifest handed to the browser).
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
  Write-Host "panel source : form=$($pluginReading.packageForm) path=$($pluginReading.pluginSource)$(if ($pluginReading.tarballSha256.Length -gt 0) { " sha256=$($pluginReading.tarballSha256)" } else { '' })"
  Write-Host "panel entries: $(@($pluginReading.entries | ForEach-Object { "$($_.spec) -> $($_.path) (exists=$($_.exists) $($_.bytes)B)" }) -join ' ｜ ')"
  Write-Host "panel mount  : settings namespace '$($mountReading.namespace)' is served by the live instance (namespaces=$($mountReading.namespaceCount)) ｜ boot manifest lists $($mountReading.clientBundleRef) (page $($mountReading.pageBytes) chars)"
  Write-Host "panel builds : $(@($pluginReading.artifacts | ForEach-Object { "$($_.relative) $($_.bytes)B" }) -join ', ')"
  foreach ($reading in $recordsReading) {
    Write-Host "records      : .pf seeded into $($reading.workspacePath) (files=$($reading.fileCount) bytes=$($reading.totalBytes))"
  }
  Write-Host ''
  foreach ($line in (Get-TestbedListCommandLines -Port $ready.port -Token $ready.token -SessionIds @($manifest.sessions | ForEach-Object { [string]$_.sessionId }))) {
    Write-Host $line
  }
  exit 0
}

# ---------------------------------------------------------------------------
# Action: check —— run completion criteria 1-5 one by one
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

# Counter-evidence readings for the main home (criterion 4's terms):
#   * The witness set is taken only in observation windows when no testbed instance is running:
#     stop our own instance first, take a lightweight scan (length and mtime only), then a full
#     fingerprint; paths touched between the two are the witness set. After the run (including the
#     restart pass), with the instance fully stopped, take another lightweight scan and another full
#     fingerprint for a second window. This is positive evidence that "other live sessions really do
#     write on this machine" — the testbed has no process running during either window.
#   * The post-run full fingerprint is compared with the pre-run one: every change needs positive
#     ownership evidence to be exempted, and the two kinds of evidence are unioned —
#     S1 structural (project key differs from every key this fixture derives + the encoding suffix
#     is one this profile cannot write; both must hold) and
#     S2 witnessed (paths really touched in a "no instance running" window). Changes with neither
#     kind fail outright; deletions, paths carrying a testbed-made name, and any change in the two
#     quiet areas are hard failures and never exempt. How many were exempted and on what grounds is
#     printed line by line in the readings.
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

  # Completion criterion 5, reading one: before the instance starts, the isolated home holds no credentials.
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

  # Completion criterion 3: restart a second instance; the first two criteria still hold.
  $instancePid2 = Start-TestbedInstance -Root $safeRoot -TestbedHome $testbedHome -Profile $Profile -DshCmd $DshCmd -NodeExe $NodeExe
  $ready2 = Wait-TestbedReady -Root $safeRoot -ProcessId $instancePid2 -TimeoutSeconds $ReadyTimeoutSeconds
  $run2 = Invoke-TestbedRun -Root $safeRoot -Manifest $manifest -Ready $ready2
  $null = Stop-TestbedInstance -Root $safeRoot -Profile $Profile

  # Open the second observation window only after the instance is fully stopped (again "no testbed
  # instance running"); the witness set is the union of both windows.
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

  # ---- Criterion 1: one command prints the session list; the synthetic session is in it; opening it raises no error ----
  $lines1 = New-Object System.Collections.Generic.List[string]
  foreach ($line in (Format-RunReadings -Run $run1)) { $lines1.Add($line) }
  $lines1.Add('command used (one command, prints the session list):')
  foreach ($line in (Get-TestbedListCommandLines -Port $run1.port -Token $run1.token -SessionIds @($run1.sessions | ForEach-Object { [string]$_.sessionId }))) { $lines1.Add($line) }
  Add-Criterion -Id '1' -Title 'session list contains the synthetic session and opening it returns a page' `
    -Passed (Test-RunCriteria -Run $run1) -Lines @($lines1.ToArray())

  # ---- Criterion 2: the session is grouped under the synthetic workspace, not ungrouped ----
  $lines2 = New-Object System.Collections.Generic.List[string]
  foreach ($row in $run1.sessions) {
    $lines2.Add("session $($row.sessionId) accounted by workspace.sessionIds: $($row.accounted)")
    $lines2.Add("session.list row cwd == workspace path: $($row.cwdMatches) ($($row.listRow.cwd))")
    $lines2.Add("workspace.create resolved an existing registration: createdByThisCall=$($row.workspaceCreatedByThisCall) workspaceId=$($row.workspaceId)")
    $lines2.Add("grouping input is workspace.sessionIds; this session is in it, so it is grouped, not ungrouped")
  }
  Add-Criterion -Id '2' -Title 'the session is grouped under the synthetic workspace, not ungrouped' `
    -Passed (Test-GroupingCriteria -Run $run1) -Lines @($lines2.ToArray())

  # ---- Criterion 3: after restarting a second instance, the two criteria above still hold ----
  $lines3 = New-Object System.Collections.Generic.List[string]
  $lines3.Add("restarted instance: port=$($run2.port) pid=$instancePid2")
  foreach ($line in (Format-RunReadings -Run $run2)) { $lines3.Add($line) }
  Add-Criterion -Id '3' -Title 'after restarting the instance, criteria 1 and 2 still hold' `
    -Passed (Test-RunCriteria -Run $run2) -Lines @($lines3.ToArray())

  # ---- Criterion 4: file counts and hashes in the main home's three areas identical before and after ----
  # The verdict is delegated to the library's Get-MainHomeAreaVerdict: every difference needs
  # positive ownership evidence (S1 structural / S2 witnessed, unioned); deletions, paths carrying
  # a testbed-made name and any change in the two quiet areas fail outright. This section only
  # prints, line by line, the readings the verdict actually reads.
  # The four buckets (exempt / deletion / testbed-made name / unattributed) are mutually exclusive:
  # each change lands in exactly one and prints one line, and an entry-point self-check line
  # reconciles against the detail lines one by one.
  $lines4 = New-Object System.Collections.Generic.List[string]
  $pass4 = $true
  # Leak signatures: names this testbed itself makes. Signatures are always fragments that can
  # appear contiguously inside a relative path — the verdict matches against relative paths, where
  # a whole absolute path (e.g. the workspace path) is never contiguous and such entries would not
  # be recognized; the library's Get-TestbedLeakSignatures therefore computes them uniformly:
  # synthetic session ids + synthetic workspace directory names + the testbed root's leaf name.
  $leakSignatures = @(Get-TestbedLeakSignatures -Root $safeRoot -Sessions @($manifest.sessions) -Workspaces @($manifest.workspaces))
  # S1's baseline: the project keys this fixture itself derives (computed from the synthetic
  # workspace paths) + the encodings this profile can write. A plaintext .jsonl appearing under some
  # other project key still fails S1 — this closes the "unknown name, let it pass" escape hatch.
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
    # The session store already has other live harness sessions appending to it (the witness-set
    # paths); the workspace records and credentials areas have no other writer, so any touch there
    # is a hard failure; in the session store, each changed path is judged by who owns it.
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
    # Every detail line is printed: the counts cover the full set, so the details print the full set
    # too (small scale this round); every basis for PASS/FAIL stays visible.
    foreach ($item in $verdict.exempt) { $lines4.Add("$name : exempt -> $item") }
    foreach ($item in $verdict.exempt) { $lines4.Add("$name :    why: $($verdict.exemptReasons[$item])") }
    foreach ($item in $verdict.deletions) { $lines4.Add("$name : DELETION, hard fail (never exempt) -> $item") }
    foreach ($item in $verdict.unattributed) { $lines4.Add("$name : UNATTRIBUTED change, no positive evidence -> $item") }
    foreach ($item in $verdict.leaks) { $lines4.Add("$name : LEAK SIGNATURE, hard fail (never exempt) -> $item") }
    # The subset comparison is a support reading: it carves the exempt paths out of both sides, and
    # holds trivially when the three counts are 0, so it is no independent evidence (the verdict
    # rests on the four counts above plus the partitionConsistent self-check — a mismatch between
    # reading and detail lines turns red right here).
    # Only with an empty exempt set does it equal the spec's literal wording "file counts and hashes
    # of the three areas fully identical"; a non-empty exempt set demotes it to support; empty areas
    # and empty subsets never claim equality — there is nothing to compare on an empty set.
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
  # After the final stop there must be no listener or process of this testbed left: this check is
  # what makes the "foreign changes" claim above hold.
  # Stray processes are collected by **identity**: this fixture's own launcher path, or descendants
  # of the instance pids recorded this run; the caller itself and its ancestor chain are excluded
  # (the shell and host running check are fine even if their command lines mention the run root).
  $strayProcesses = Get-StrayTestbedProcess -Root $safeRoot -Profile $Profile -InstancePids @($instancePid, $instancePid2)
  $listenerAlive = Test-TcpListener -Port $run2.port
  $lines4.Add("stray listener on the last instance port after the final stop: $listenerAlive")
  $lines4.Add("stray scan identity: this testbed's own launcher path '$(Join-Path $safeRoot ('logs\start-' + $Profile + '.cmd'))' and the instance pid tree @($instancePid, $instancePid2); the caller's own process (pid=$PID) and its ancestors are excluded from the scan")
  $lines4.Add("stray node/cmd process carrying that identity: $($strayProcesses.Count)")
  foreach ($item in $strayProcesses) { $lines4.Add("stray process -> $item") }
  if ($listenerAlive) { $pass4 = $false }
  if ($strayProcesses.Count -gt 0) { $pass4 = $false }
  Add-Criterion -Id '4' -Title 'main home: every changed path carries its own positive ownership evidence (S1 structural or S2 witness; deletions, testbed-made names and quiet-area changes never exempt), and this testbed left no listener and no process of its own identity behind' -Passed $pass4 -Lines @($lines4.ToArray())

  # ---- Criterion 5: the isolated environment starts without credentials ----
  # Before the instance starts, the isolated home holds no credentials; after it starts, only the
  # browser-session record the web app issues itself may appear.
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