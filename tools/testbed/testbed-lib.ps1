# testbed-lib.ps1 —— testbed shared implementation: path and on-disk format conversions, synthetic
# record fixtures, instance start/stop, HTTP calls, main-home fingerprints.
#
# Called only by tools/testbed/testbed.ps1. Everything it creates (isolated home / profile /
# synthetic workspaces / synthetic sessions) lands under the caller's -Root; this file assumes no concrete paths.
#
# Design notes (written from measured behavior on this machine, not copied from elsewhere):
#   * Session root layout: session logs land at <home>\sessions\<projectKey(cwd)>\<encodeSegment(id)>\session.v4.jsonl.
#     When reading logs the instance cross-checks "the path recomputed from the header's id + cwd" against the on-disk
#     path; a wrongly computed path gets the session dropped.
#   * A session's physical encoding is exclusive across the whole root: mixing another suffix into the same root makes
#     the entire session list throw. The testbed home is rebuilt each time and its profile pins compression to none,
#     so the whole root is plaintext .jsonl.
#   * An invalid session header field name/type raises no error; that session silently vanishes from the list.
#     Hence validate the header first, then look at the list.
#   * The workspace registry (<home>\storages\workspace.json) is read once at instance start; it must be written while the instance is stopped.
#   * The main home is multi-tenant: other projects have live sessions appending to it. Criterion 4 demands
#     **positive ownership evidence for every difference**, unioning two kinds:
#     S1 structural (project key differs from every key this fixture derives + the encoding suffix is one this profile cannot write) and
#     S2 witnessed (paths really touched in a "no instance running" observation window). Deletions, paths carrying a
#     testbed-made name, and any change in the two quiet areas fail outright.

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# ---------------------------------------------------------------------------
# Path and on-disk format conversions
# ---------------------------------------------------------------------------

# Convert a cwd into the "project directory" level under the session root (same algorithm as the
# product side: separators fold to '-', other unsafe chars become ~XXXX).
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

# Turn a session id into a single safe path segment.
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

# Canonical path via Node's fs.realpathSync: the product side judges workspace-path uniqueness by this same canon.
function Get-CanonicalPath {
  param([Parameter(Mandatory=$true)][string]$Path, [string]$NodeExe = 'node')
  $out = & $NodeExe -e "process.stdout.write(require('fs').realpathSync(process.argv[1]))" $Path
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrEmpty($out)) { throw "realpath failed for '$Path'" }
  return [string]$out
}

# Resolve a directly-CreateProcess-able executable: want the .cmd/.bat/.exe one, not the extensionless POSIX shim in the npm directory.
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

# Write text: no BOM by default (JSON / JSONL parsers treat a BOM as corrupt data); line endings exactly as the caller's text.
function Write-TextFile {
  param([Parameter(Mandatory=$true)][string]$Path, [Parameter(Mandatory=$true)][string]$Text)
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, $script:Utf8NoBom)
}

# JSON string literal (escaping left to ConvertTo-Json, which gets Windows backslashes right).
function ConvertTo-JsonString {
  param([Parameter(Mandatory=$true)][string]$Value)
  return (ConvertTo-Json -InputObject $Value -Compress)
}

# ---------------------------------------------------------------------------
# Main home fingerprints (the counter-evidence readings for completion criterion 4)
# ---------------------------------------------------------------------------

# Fingerprint one path. kind tree recurses; kind file is a single file.
#   contentDigest —— composed only of "relative path + byte count + content SHA256": the literal "counts and hashes" reading;
#   entryDigest   —— the above plus mtime, used outside the criteria to show exactly which files moved;
#   entries       —— relative path -> "length|mtime|content hash", for per-path comparison.
function Get-AreaFingerprint {
  param([Parameter(Mandatory=$true)][string]$Path)
  # Even an empty set must have a definite digest: when a directory holds no file (or the area is
  # absent entirely) the fixed empty-string sha256 is taken, so both sides have something to compare
  # and the caller never trips over a "parameter is null" binding error.
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

# Text digest of one path's entries. Empty sets (a file-less area, an empty subset) are accepted; the digest is the fixed empty-string sha256.
function Get-TextDigest {
  param([AllowEmptyCollection()][AllowNull()][string[]]$Lines = @())
  if ($null -eq $Lines) { $Lines = @() }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($Lines -join "`n"))
    return [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
}

# Per-path comparison of two fingerprints, returning the change set (a difference in mtime, length, or content hash counts as changed).
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

# Strip the change-set prefix, leaving the plain relative path. Returns an empty array when nothing changed (callers need not distinguish $null).
function Get-ChangedPaths {
  param([AllowEmptyCollection()][string[]]$Changed = @())
  if ($null -eq $Changed) { return @() }
  return @($Changed | ForEach-Object { $_.Substring(1) })
}

# Lightweight scan: only "relative path -> length|mtime tick", never reads file content (the main
# home's session store is 1.5 GB; reading content is reserved for the two full fingerprints the
# criteria actually compare). For "did it move" this is enough.
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

# Relative paths touched between two observations (added / rewritten / vanished all count).
# Before is a lightweight scan (length|mtime), After a full fingerprint (length|content hash|mtime); only length and mtime are compared.
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

# File count and content digest of one fingerprint "excluding certain relative paths".
# Purpose: the foreign write paths picked out by the witness set are carved off first, and the
# criteria's counts and hashes are taken over the remainder, which is what makes the equality
# meaningful (and which paths were carved off is printed line by line in the readings).
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

# S1 (structural exemption): a path proves "this fixture cannot have written it" by where it sits
# (which project key) plus its physical encoding suffix. Both must hold: (1) the project key differs
# from every key this fixture derives; (2) the encoding suffix is one this profile cannot write
# (this profile pins compression to none, so the whole root can only be plaintext .jsonl). Missing
# either means no exemption — this exists precisely to close the "unknown name, let it pass" escape
# hatch: a plaintext .jsonl under some other project key still fails.
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

# Criterion 4's leak-signature set: names this testbed itself makes. The verdict matches them
# against relative paths with `-like "*signature*"` (see Get-MainHomeAreaVerdict), and relative
# paths are assembled segment by segment — a single Windows directory segment contains neither ':'
# nor '\', so a whole absolute path (like
# %LOCALAPPDATA%\dsh-pathfinder-testbed\workspaces\workspace-alpha) is never contiguous
# inside a relative path, and such entries would never be recognized. Signatures are therefore
# always fragments that can appear contiguously inside a relative path:
#   * the synthetic session ids (each is itself a single path segment);
#   * the synthetic workspaces' directory names (sessions are grouped by cwd, so the name is folded
#     into the project-key segment by Get-ProjectKey);
#   * the testbed root's leaf name (every key this fixture derives contains it; this is the safety net).
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

# The verdict for one main-home area: split the "before baseline vs after" change set by ownership
# and decide whether this area passes. Criterion 4's terms: **every difference must carry positive
# evidence it was not written by this fixture**, unioning two kinds:
#   * S1 structural: the project key differs from every key this fixture derives, and the encoding
#     suffix is one this profile cannot write (both required);
#   * S2 witnessed: the path really moved during a "no testbed instance running" observation window;
#   a change satisfying neither fails. Prefixes kept: + new / ~ rewritten / - deleted.
# Hard-failure faces join no exemption: paths carrying a testbed-made name (leak signatures), any
# change in the two quiet areas, and **any deletion** (- prefix).
# The four buckets (exempt / deletions / leaks / unattributed) are **mutually exclusive**: each
# change lands in exactly one, and the four buckets together cover every change — no more, no less.
# partitionConsistent records whether this self-check held (the entry point prints it as an
# assertion; the criteria still read only the three counts).
# passed is decided by the three counts alone (deletions / unattributed / leaks all 0); exempt* /
# exemptReasons / subset* / partitionConsistent are printed readings, of which subset* is a support
# reading: it is implied by those three counts and is no independent evidence.
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
    # The four buckets are **mutually exclusive**: each change lands in exactly one and then
    # continues (so each change prints one detail line, and the four counts in the readings must sum
    # to the number of changes — the same invariant computed in this lib serves as the assertion).
    # Order: deletion -> testbed-made name -> quiet area -> exempt/unattributed.
    #   Deletions come first: a deleted path carrying a testbed-made name is still recorded once, as
    #   a deletion, and never also into the named bucket — otherwise the readings would say "0
    #   deletions" while listing a real deletion, or the reverse with "0 testbed-made names" beside
    #   an obviously named path. Both buckets are hard failures; the verdict is unaffected by this filing.
    if ($change.StartsWith('-')) { $deletions.Add($change); continue }
    if ($named) { $leaks.Add($change); continue }
    if ($QuietArea) { $unattributed.Add($change); continue }
    # Union the two positive kinds of evidence: structural first, then the witness set.
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
  # Subset comparison after carving off the exempt paths: it removes the exempt entries from both
  # sides, so as long as deletions / unattributed / leaks are all 0 (i.e. every change was exempted)
  # the two subsets are necessarily identical entry by entry — it restates those three counts and
  # gives no independent evidence, hence it does **not enter $passed**: the verdict rests on those
  # three counts alone. It is still computed, printed as a support reading.
  $subsetBefore = Get-FingerprintSubset -Fingerprint $Before -Exclude $exemptPaths
  $subsetAfter = Get-FingerprintSubset -Fingerprint $After -Exclude $exemptPaths
  $subsetIdentical = ($subsetBefore.fileCount -eq $subsetAfter.fileCount) -and ($subsetBefore.digest -eq $subsetAfter.digest)
  $passed = ($deletions.Count -eq 0) -and ($unattributed.Count -eq 0) -and ($leaks.Count -eq 0)
  # Four-bucket exclusivity self-check: pool the four buckets' entries; the pool's count must equal
  # the change count (nothing missing) and its deduplicated count must equal it too (nothing
  # doubled). The entry point prints this as an assertion: a mismatch between readings and detail
  # lines shows up right here.
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
# Synthetic record fixtures
# ---------------------------------------------------------------------------

# Create a synthetic workspace directory (with a small countable record) and its session logs, and
# write the manifest to <Root>\logs\fixture.json.
# Parameters: -WorkspaceName / -SessionCount add a second workspace and session; -EmptyWorkspaceName adds a session-less workspace.
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

  # Main workspace: a real directory + a small countable record.
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

    # The first line is the session header: field names and types must fall in the set the product
    # side allows; one extra key and the whole session is dropped.
    $header = '{"type":"session","version":4,"id":' + (ConvertTo-JsonString $sid) +
      ',"createdAt":' + $createdMs +
      ',"cwd":' + (ConvertTo-JsonString $wsPath) +
      ',"isSeeded":false,"delegationDepth":0}'
    # Session body: one minimal pair of turn/start + turn/end. seq must match line order (from 0, no gaps).
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

  # Workspace registry: read once, no watcher, so it is written wholesale while the instance is stopped.
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

# The header's count-typed fields (version / createdAt / delegationDepth) must be numbers:
# the product layer (dsh-session-format's header validation) demands non-negative integers, and a
# string-typed value raises no error — that session simply vanishes from the list. Caught by type here.
function Test-HeaderInteger {
  param($Value)
  if ($Value -is [bool]) { return $false }
  if ($Value -is [int] -or $Value -is [long] -or $Value -is [short] -or $Value -is [byte]) { return ([double]$Value -ge 0) }
  if ($Value -is [double] -or $Value -is [decimal] -or $Value -is [single]) {
    return (([double]$Value -ge 0) -and ([double]$Value -eq [math]::Floor([double]$Value)))
  }
  return $false
}

# Validate a synthetic session's header and on-disk location: header first, then the list (an
# invalid header silently drops one entry from the list). Field set, field types (string / number /
# boolean), id-vs-disk-location cross-check, and event seq density — all four are validated.
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
    # Without a usable cwd the on-disk location cannot be computed, and the last two checks
    # (location cross-check, event seq) could not run either: report this one and stop.
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
# The npm pack tarball: list entries, extract a few members
# ---------------------------------------------------------------------------

# Windows ships two tars: the GNU tar bundled with Git (the MSYS2 one) and the system bsdtar. This
# layer smooths over both:
#   * every path handed to tar is converted to forward slashes. MSYS2 re-decodes backslash escapes
#     in arguments received from native processes, so a fragment like `logs\tarball` gets eaten into
#     a tab and the path stops matching (measured: `…\logs\x1` passes, `…\logs\tarball` and `…\logs\bb` fail).
#   * GNU tar reads the colon in `C:...` as a remote host; `--force-local` makes it read locally.
#     Implementations without that flag fall back to "cd into the archive's directory, hand over the leaf name only".
# Read-only: list entries and extract named members to a directory; never modifies the archive or anything else.
function Invoke-Tar {
  param(
    [Parameter(Mandatory=$true)][string]$Archive,
    [Parameter(Mandatory=$true)][AllowEmptyCollection()][string[]]$BeforeArchive,
    [AllowEmptyCollection()][string[]]$AfterArchive = @(),
    [string]$TarExe = 'tar'
  )
  $full = [System.IO.Path]::GetFullPath($Archive)
  if (-not (Test-Path -LiteralPath $full)) { throw "archive is missing: $full" }
  $fullArg = $full -replace '\\', '/'
  $afterArg = @($AfterArchive | ForEach-Object { ([string]$_) -replace '\\', '/' })
  # `--force-local` must precede `-xzf`/`-tzf`: the f in those short options eats the next word as the archive name.
  $out = @(& $TarExe '--force-local' @BeforeArchive $fullArg @afterArg 2>&1)
  if ($LASTEXITCODE -eq 0) { return @($out | ForEach-Object { [string]$_ }) }
  $firstTry = ($out -join ' ')
  $dir = Split-Path -Parent $full
  $leaf = Split-Path -Leaf $full
  Push-Location $dir
  try {
    $out = @(& $TarExe @BeforeArchive $leaf @afterArg 2>&1)
    if ($LASTEXITCODE -ne 0) {
      throw "tar failed for '$full' (--force-local: $firstTry | relative archive name: $($out -join ' '))"
    }
    return @($out | ForEach-Object { [string]$_ })
  } finally { Pop-Location }
}

function Invoke-TarList {
  param([Parameter(Mandatory=$true)][string]$Archive, [string]$TarExe = 'tar')
  return @(Invoke-Tar -Archive $Archive -BeforeArchive @('-tzf') -TarExe $TarExe)
}

function Expand-TarMember {
  param(
    [Parameter(Mandatory=$true)][string]$Archive,
    [Parameter(Mandatory=$true)][string]$Destination,
    [Parameter(Mandatory=$true)][AllowEmptyCollection()][string[]]$Members,
    [string]$TarExe = 'tar'
  )
  $dest = [System.IO.Path]::GetFullPath($Destination)
  if (-not (Test-Path -LiteralPath $dest)) { New-Item -ItemType Directory -Force -Path $dest | Out-Null }
  $null = Invoke-Tar -Archive $Archive -BeforeArchive @('-xzf') -AfterArchive (@('-C', $dest) + @($Members)) -TarExe $TarExe
}

# Drop a real record into a synthetic workspace: copy the pointed-to records directory as the
# workspace's `.pf`. The panel reads exactly that hidden directory in the workspace; synthetic
# workspaces lack it by default, so the instance would only ever draw the "no records" screen.
# Acts only when the caller (the up action) asks for it; otherwise no workspace is touched.
function Add-TestbedRecords {
  param(
    [Parameter(Mandatory=$true)]$Manifest,
    [Parameter(Mandatory=$true)][string]$RecordsPath
  )
  $source = [System.IO.Path]::GetFullPath($RecordsPath).TrimEnd('\')
  if (-not (Test-Path -LiteralPath $source)) { throw "records directory is missing: $source" }
  if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "records path is not a directory: $source" }
  $readings = New-Object System.Collections.Generic.List[object]
  foreach ($ws in $Manifest.workspaces) {
    if ($ws.empty) { continue }
    $target = Join-Path ([string]$ws.path) '.pf'
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
    $files = @(Get-ChildItem -LiteralPath $target -Recurse -File -Force)
    $readings.Add([ordered]@{
      workspaceId = [string]$ws.workspaceId
      workspacePath = [string]$ws.path
      recordsPath = $target
      fileCount = $files.Count
      totalBytes = [long](($files | Measure-Object -Property Length -Sum).Sum)
    })
  }
  return @($readings.ToArray())
}

# ---------------------------------------------------------------------------
# Profile and instance
# ---------------------------------------------------------------------------

# Build the isolated profile from the web template, pinning session compression to none (the
# profile's cordis.patch.yml). The profile is created with --dump-config: it writes the profile,
# prints the composed tree, and exits — it never starts a service.
function New-TestbedProfile {
  param([Parameter(Mandatory=$true)][string]$TestbedHome, [Parameter(Mandatory=$true)][string]$Profile, [string]$DshCmd = 'dsh')
  $profileDir = Join-Path $TestbedHome ('profiles\' + $Profile)
  $previous = $env:DSH_HOME
  try {
    $env:DSH_HOME = $TestbedHome
    $dump = & $DshCmd $Profile --from-default-profile web --dump-config 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "profile creation failed: $dump" }
    if (-not (Test-Path -LiteralPath $profileDir)) { throw "profile directory was not created: $profileDir" }
    # The user layer is an id-targeted patch: config is replaced wholesale rather than merged key by
    # key, so root must be written back along with it.
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

# Whether the entries a config row points at exist on disk: resolve the package named by the row's
# `name:` from the profile's own resolution location (the package.json in the profile directory),
# plus the browser half's hand (`exports["./client"]`). Parsing only — no importing of plugin code,
# no service started; the resolved paths are then verified on disk once more (require.resolve walks
# real paths; symlinks are already resolved). The small generated .cjs is written into the testbed's
# own root, touching nothing else.
function Resolve-PluginEntryFiles {
  param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$ProfileDir,
    [Parameter(Mandatory=$true)][string]$PluginName,
    [string]$NodeExe = 'node'
  )
  $manifestPath = Join-Path $ProfileDir 'package.json'
  $script = @'
const { createRequire } = require('module')
const require_ = createRequire(process.argv[2])
for (const spec of process.argv.slice(3)) {
  try { process.stdout.write(JSON.stringify({ spec, path: require_.resolve(spec) }) + '\n') }
  catch (error) { process.stdout.write(JSON.stringify({ spec, path: null, error: String((error && error.code) || error) }) + '\n') }
}
'@
  $scriptPath = Join-Path $Root 'logs\resolve-plugin-entry.cjs'
  Write-TextFile -Path $scriptPath -Text ($script + "`n")
  $specs = @($PluginName, ($PluginName + '/client'))
  $out = @(& $NodeExe $scriptPath $manifestPath @specs 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "resolving the plugin entries failed (exit $LASTEXITCODE): $($out -join ' ')" }
  $rows = New-Object System.Collections.Generic.List[object]
  foreach ($line in $out) {
    $text = ([string]$line).Trim()
    if ($text.Length -eq 0 -or -not $text.StartsWith('{')) { continue }
    $parsed = $text | ConvertFrom-Json
    $resolved = [string]$parsed.path
    $exists = ($resolved.Length -gt 0) -and (Test-Path -LiteralPath $resolved)
    $bytes = 0
    if ($exists) { $bytes = (Get-Item -LiteralPath $resolved).Length }
    $rows.Add([ordered]@{
      spec = [string]$parsed.spec
      path = $resolved
      exists = $exists
      bytes = $bytes
      error = [string]$parsed.error
    })
  }
  return @($rows.ToArray())
}

# Install the pointed-to plugin into the isolated profile, turning "installed" into reproducible
# readings on the spot.
#
# Both delivery forms are accepted:
#   * a package directory (`-Plugin <this repo>`, the developer's own form) — pnpm records it as `link:`;
#   * an npm pack tarball (`-Plugin <…>.tgz`, the form handed to strangers) — pnpm unpacks the
#     package into the profile and the user side runs no build scripts. Both legs go through DSH's
#     own entry `dsh plugin --profile <name> add <target>`.
#
# Neither the package name nor the row id is hardcoded; both are read from the pointed-to package
# itself: the name from its `package.json` `name` (the same word is the dependency key pnpm records,
# the bundle list's entry, and the boot manifest handed to the browser); the row id from the first
# top-level row under the package's own section (`# == <package name>`) in the composed config tree.
# After installing, verify for real: the profile manifest records the package name, the bundle list
# selects it, and the row exists in the config tree and is not disabled — all read, or it is not installed.
function Install-TestbedPlugin {
  param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$TestbedHome,
    [Parameter(Mandatory=$true)][string]$Profile,
    [Parameter(Mandatory=$true)][string]$PluginPath,
    [string]$DshCmd = 'dsh'
  )
  $profileDir = Join-Path $TestbedHome ('profiles\' + $Profile)
  if (-not (Test-Path -LiteralPath $profileDir)) { throw "profile directory is missing: $profileDir" }
  $PluginPath = [System.IO.Path]::GetFullPath($PluginPath)
  if (-not (Test-Path -LiteralPath $PluginPath)) { throw "plugin source is missing: $PluginPath" }

  # What is installed is the **build output**: both the host half and the browser half must be
  # present, otherwise what gets installed is a line that cannot start. Directory form is checked on
  # disk directly; tarball form lists the entries in the archive first, then extracts these four
  # (package.json included).
  $artifactRels = @('lib\host\index.js', 'lib\client.js')
  $packageForm = 'directory'
  $tarballSha256 = ''
  $artifactBase = $PluginPath
  if ([System.IO.Path]::GetExtension($PluginPath).ToLowerInvariant() -eq '.tgz') {
    $packageForm = 'tarball'
    $tarballSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $PluginPath).Hash.ToLowerInvariant()
    $members = @('package/package.json') + @($artifactRels | ForEach-Object { 'package/' + ($_ -replace '\\', '/') })
    $entries = @(Invoke-TarList -Archive $PluginPath)
    foreach ($member in $members) {
      if (-not ($entries -contains $member)) {
        throw "plugin build output is missing from the tarball: $member (entries: $($entries.Count)) — run 'npm run types', 'npm run bundle', 'npm run bundle:client' and 'npm pack' first"
      }
    }
    $stage = Join-Path $Root 'logs\tarball'
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Expand-TarMember -Archive $PluginPath -Destination $stage -Members $members
    $artifactBase = Join-Path $stage 'package'
  } else {
    foreach ($rel in $artifactRels) {
      if (-not (Test-Path -LiteralPath (Join-Path $PluginPath $rel))) {
        throw "plugin build output is missing: $(Join-Path $PluginPath $rel) — run 'npm run types' and 'npm run bundle' and 'npm run bundle:client' in $PluginPath first"
      }
    }
  }
  $manifestPath = Join-Path $artifactBase 'package.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { throw "not a plugin package (no package.json): $manifestPath" }
  $package = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $PluginName = [string]$package.name
  if ($PluginName.Length -eq 0) { throw "the plugin package does not declare a name: $manifestPath" }
  $PluginId = ''

  $previous = $env:DSH_HOME
  $started = Get-Date
  try {
    $env:DSH_HOME = $TestbedHome
    $install = & $DshCmd plugin --profile $Profile add $PluginPath 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "plugin install failed (exit $LASTEXITCODE): $install" }

    $manifest = Get-Content -LiteralPath (Join-Path $profileDir 'package.json') -Raw | ConvertFrom-Json
    $recorded = [string]$manifest.dependencies.$PluginName
    if ($recorded.Length -eq 0) { throw "profile manifest does not record $PluginName after the install: $install" }
    $bundles = @($manifest.dsh.profile.bundles)
    if (-not ($bundles -contains $PluginName)) {
      throw "profile bundle list does not select $PluginName after the install (bundles: $($bundles -join ', ')): $install"
    }

    # The composed config tree: the first top-level row under this package's own section
    # (`# == <package name>`) is its row. Both id and name are read from the dump; no hardcoded
    # names are matched. `--dump-config` only prints; it never starts a service.
    $composed = & $DshCmd $Profile --dump-config 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "dump-config failed after the install (exit $LASTEXITCODE): $composed" }
    $composedLines = $composed -split "`r?`n"
    $sectionHeader = '# == ' + $PluginName
    $rowIndex = -1
    for ($i = 0; $i -lt $composedLines.Length; $i++) {
      if ($composedLines[$i].Trim() -ne $sectionHeader) { continue }
      for ($j = $i + 1; $j -lt $composedLines.Length; $j++) {
        if ($composedLines[$j] -match '^\s*#') { break }
        $idMatch = [regex]::Match($composedLines[$j], '^-\s+id:\s+(\S+)\s*$')
        if ($idMatch.Success) { $PluginId = $idMatch.Groups[1].Value; $rowIndex = $j; break }
      }
      break
    }
    if ($PluginId.Length -eq 0) {
      throw "the composed config tree has no row under the '$PluginName' bundle layer after the install: $composed"
    }
    $rows = New-Object System.Collections.Generic.List[string]
    for ($j = $rowIndex; $j -lt $composedLines.Length; $j++) {
      if ($j -gt $rowIndex) {
        if ($composedLines[$j].Trim().Length -eq 0) { break }
        if ($composedLines[$j] -match '^\s*-') { break }
        if ($composedLines[$j] -match '^\s*#') { break }
      }
      $rows.Add($composedLines[$j].TrimEnd())
    }
    $rowText = ($rows -join ' | ').Trim()
    if ($rowText -match 'disabled:') { throw "the composed row for '$PluginId' is disabled: $rowText" }
    # Every entry the row points at must be on disk: the host hand (`.`) and the browser hand (`./client`).
    $entries = @(Resolve-PluginEntryFiles -Root $Root -ProfileDir $profileDir -PluginName $PluginName -NodeExe $NodeExe)
    foreach ($entry in $entries) {
      if (-not $entry.exists) {
        throw "the config row names '$PluginName' but its entry '$($entry.spec)' does not resolve to a file on disk (path='$($entry.path)' error='$($entry.error)')"
      }
    }
  } finally { $env:DSH_HOME = $previous }
  $elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds, 2)

  $reading = [ordered]@{
    plugin = $PluginName
    pluginId = $PluginId
    packageForm = $packageForm
    pluginSource = $PluginPath
    tarballSha256 = $tarballSha256
    recordedSpec = $recorded
    profileBundles = $bundles
    composedRow = $rowText
    entries = @($entries)
    artifacts = @($artifactRels | ForEach-Object { [ordered]@{
      relative = $_
      bytes = (Get-Item -LiteralPath (Join-Path $artifactBase $_)).Length
    } })
    elapsedSeconds = $elapsed
  }
  Write-TextFile -Path (Join-Path $Root 'logs\plugin-install.json') -Text (($reading | ConvertTo-Json -Depth 8) + "`n")
  return $reading
}

# Start a detached instance: returns immediately, PID recorded in <Root>\logs\instance.pid.
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

  # The launcher is a .cmd on disk: it sets DSH_HOME itself and points all three streams at
  # files/NUL. That way the long-lived cmd.exe / node never inherits the caller's (harness's) pipe
  # handles, which is what lets the caller return immediately.
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

# Readiness probe: read the URL line from the instance's own output (with backoff and a cap); an
# early process exit errors out immediately.
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
    # A child started by Start-Process offers only a log file, nothing to hang an event on; poll that
    # file with backoff, capped at TimeoutSeconds.
    Start-Sleep -Milliseconds $backoffMs
    if ($backoffMs -lt 500) { $backoffMs = $backoffMs * 2 }
  }
  throw "instance $ProcessId printed no URL within $TimeoutSeconds s"
}

# One testbed instance's processes: the launcher .cmd path is written by this cell alone, so its
# presence in a command line is enough to confirm identity.
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

# Stop only the PID we recorded: verify the command line really is this profile first, then kill it
# together with its children. When the pid file is missing (or the process is gone), fall back to
# "command line carries this fixture's launcher path", verified the same way before killing.
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
    # Waiting for exit uses Wait-Process (the process-exit event), not polling.
    Wait-Process -Id $proc.ProcessId -Timeout 15 -ErrorAction SilentlyContinue
    if ($null -ne (Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue)) {
      throw "instance $($proc.ProcessId) is still alive after taskkill"
    }
  }
  if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force }
  return $true
}

# Is anyone still listening on the port (proof the teardown was clean; one connection attempt, no polling).
function Test-TcpListener {
  param([Parameter(Mandatory=$true)][int]$Port, [int]$TimeoutMs = 1500)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync('127.0.0.1', $Port)
    if (-not $task.Wait($TimeoutMs)) { return $false }
    return $client.Connected
  } catch { return $false } finally { $client.Close() }
}

# A process's ancestor chain (up from the parent, at most 64 levels): used to exclude the caller itself from the teardown assertion.
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

# Teardown assertion: any node/cmd process still running that **belongs to this testbed**. Identity
# is what this fixture itself has written down:
#   (1) the command line carries the launcher path this fixture wrote (<Root>\logs\start-<profile>.cmd);
#   (2) the process is a descendant of "instance pids this fixture wrote down" — the pid in the pid
#       file plus the ones the caller passed in for this run. The instance's own node command line
#       does not carry the launcher path, so only the pid tree identifies it; orphans whose father
#       already died count too, recovered via their own remembered ParentProcessId from the identity pids.
# The caller itself and its ancestor chain are explicitly excluded: if the caller mentions the run
# root in its command line (passing -Root explicitly is the most direct example), the old substring
# check would read the caller itself as "testbed leftover" — same deliverable, same on-disk state,
# a different invocation style would flip the exit code. A real leftover process can never be the
# caller's ancestor, so excluding it does not weaken this check.
function Get-StrayTestbedProcess {
  param(
    [Parameter(Mandatory=$true)][string]$Root,
    # The default is the profile name this entry point uses: the shipped entry always passes
    # -Profile explicitly; this default is for callers elsewhere (the earlier probe rounds did pass
    # only -Root), so that changing the criteria here does not break their invocation style.
    [string]$Profile = 'pf-testbed',
    [AllowEmptyCollection()][int[]]$InstancePids = @()
  )
  $launcher = Join-Path $Root ('logs\start-' + $Profile + '.cmd')
  $table = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  # Exclusion set = the caller itself (the pwsh running this cell) + its ancestor chain (its host processes).
  $excluded = New-Object System.Collections.Generic.HashSet[int]
  $null = $excluded.Add([int]$PID)
  foreach ($ancestor in (Get-ProcessAncestorIds -ProcessId $PID -ProcessTable $table)) { $null = $excluded.Add([int]$ancestor) }
  # Identity core: the instance pids this fixture wrote down.
  $identityPids = New-Object System.Collections.Generic.HashSet[int]
  $pidFile = Join-Path $Root 'logs\instance.pid'
  if (Test-Path -LiteralPath $pidFile) {
    $instancePid = 0
    if ([int]::TryParse(((Get-Content -LiteralPath $pidFile -Raw).Trim()), [ref]$instancePid)) { $null = $identityPids.Add($instancePid) }
  }
  foreach ($id in @($InstancePids)) { $null = $identityPids.Add([int]$id) }
  # Collect descendants level by level from the identity pids (orphans whose parent edge is broken are found too).
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
# HTTP calls (the instance's own /api surface)
# ---------------------------------------------------------------------------

# Trade the instance's boot token for a browser cookie: a GET on the URL 303s to ./ and plants the cookie in the session.
function Connect-TestbedBrowser {
  param([Parameter(Mandatory=$true)][string]$Url)
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $null = Invoke-WebRequest -Uri $Url -WebSession $session -MaximumRedirection 5 -TimeoutSec 20 -UseBasicParsing
  return $session
}

# Two positive readings, on the running instance itself, that "the panel is really installed"
# (neither reads the config tree off disk):
#   * settings namespace: the line's id shows up in the `settings/describe` roster (a plugin line's
#     id is the name of its settings namespace, and the `Config` the host half exposes hangs under it);
#   * browser half: the boot manifest the instance hands the browser lists `<package name>/client.js` —
#     the bundle the shell is to fetch.
# Both must read back; missing either throws: installed but not serving is as broken as not installed.
function Get-TestbedPanelMount {
  param(
    [Parameter(Mandatory=$true)][int]$Port,
    [Parameter(Mandatory=$true)][string]$Url,
    [Parameter(Mandatory=$true)][string]$PluginName,
    [Parameter(Mandatory=$true)][string]$PluginId,
    [Parameter(Mandatory=$true)][string]$EvidenceDir
  )
  $browser = Connect-TestbedBrowser -Url $Url
  $describe = Invoke-TestbedApi -Port $Port -WebSession $browser -Endpoint 'settings/describe' `
    -Arguments ([ordered]@{}) -EvidencePath (Join-Path $EvidenceDir 'settings-describe')
  $namespaces = @($describe.namespaces | ForEach-Object { [string]$_.ns })
  if (-not ($namespaces -contains $PluginId)) {
    throw "the live instance does not expose the '$PluginId' settings namespace (namespaces: $($namespaces -join ', '))"
  }

  $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -WebSession $browser -TimeoutSec 20 -UseBasicParsing
  $page = $response.Content
  if ($page -isnot [string]) { $page = [System.Text.Encoding]::UTF8.GetString($page) }
  Write-TextFile -Path (Join-Path $EvidenceDir 'boot-page.html') -Text ($page + "`n")
  $bundleRef = "$PluginName/client.js"
  if (-not $page.Contains($bundleRef)) {
    throw "the live instance's boot manifest does not list '$bundleRef' (page $($page.Length) chars)"
  }
  return [ordered]@{
    namespace = $PluginId
    namespacePresent = $true
    namespaceCount = $namespaces.Count
    namespaces = $namespaces
    clientBundleRef = $bundleRef
    clientBundleListed = $true
    pageBytes = $page.Length
  }
}

# One /api/<namespace>/<method> call: the request envelope is exactly { type, rpcId, method, payload:{ args } },
# the response is { result:{ ok, value } }. The endpoint spelling is <namespace>/<method> (the
# instance only accepts two-segment paths) and the envelope's method matches it verbatim; args key
# names follow the method signature: session/list takes _request; session/page, session/projections
# and workspace/create take request.
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

# Completion criterion 1's "one command that prints the session list".
#   * Only one shell is printed: the shell the entry point itself runs under (pwsh). The two shells
#     quote differently (in cmd, single quotes are plain characters and %TEMP% expands; in pwsh the
#     JSON inside single quotes goes out verbatim and $env:TEMP expands) — printing both side by
#     side only invites pasting the wrong line.
#   * What is printed is one line: paste it into pwsh as-is and hit enter, and the list prints
#     (first segment takes the cookie, second prints the list).
#   * curl carries -f: a non-zero exit code on HTTP 4xx/5xx, so "it was rejected but curl exited 0"
#     cannot read as success.
function Format-TestbedListCommand {
  param([Parameter(Mandatory=$true)][int]$Port, [Parameter(Mandatory=$true)][string]$Token)
  $body = '{"type":"client-request","rpcId":"list-1","method":"session/list","payload":{"args":{"_request":{}}}}'
  $cookieJar = '"$env:TEMP\pf-testbed-cookies.txt"'
  $line1 = 'curl.exe -s -f -c ' + $cookieJar + ' "http://127.0.0.1:' + $Port + '/?token=' + $Token + '" -o NUL'
  $line2 = 'curl.exe -s -f -b ' + $cookieJar + ' -H "content-type: application/json" -d ''' + $body + ''' http://127.0.0.1:' + $Port + '/api/session/list'
  # One line; do not join array elements with + (comma and + precedence glues the segments wrong).
  return ($line1 + '; ' + $line2)
}