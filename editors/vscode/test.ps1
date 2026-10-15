param(
  [string]$CodePath = (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'),
  [string]$ExtensionPath = '',
  [string]$TestHostPath = ''
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $CodePath)) { throw 'VS Code is required. Supply its Code.exe path with -CodePath.' }

$extensionRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$testExtensionRoot = if ($ExtensionPath) { [System.IO.Path]::GetFullPath($ExtensionPath) } else { $extensionRoot }
$testHost = if ($TestHostPath) { [System.IO.Path]::GetFullPath($TestHostPath) } else { Join-Path $testExtensionRoot 'dist\test-host.cjs' }
$packageRoot = [System.IO.Path]::GetFullPath((Join-Path $extensionRoot '..\..'))
$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$testRoot = Join-Path $temporaryBase ('hesperia-vscode-' + [guid]::NewGuid().ToString('N'))
$testRoot = [System.IO.Path]::GetFullPath($testRoot)

if (-not $testRoot.StartsWith($temporaryBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid test workspace path.' }

$coverageEnabled = -not [string]::IsNullOrWhiteSpace($env:HESPERIA_EDITOR_COVERAGE_CONFIG)
$coverageOutput = $env:HESPERIA_EDITOR_COVERAGE_OUTPUT_DIR
$processEvents = [System.Collections.Generic.List[object]]::new()
$ownedProcessIds = @{}
$creationTimeToleranceTicks = 10
$observerStartedAt = [DateTime]::UtcNow.ToString('o')
$codeLaunchPid = 0
$forcedCleanup = $false
$cleanupFailures = [System.Collections.Generic.List[object]]::new()
$observerCleanupErrors = [System.Collections.Generic.List[string]]::new()
$ownerAdmissionDiagnostics = [System.Collections.Generic.List[object]]::new()
$ownerAdmissionFailures = [System.Collections.Generic.List[object]]::new()
$treeSweepDiagnostics = [System.Collections.Generic.List[object]]::new()
$ownerAdmissionKeys = @{}
$ownerReceiptParseFailures = 0
$ownerReceiptConfig = $null
$nextTreeSweepAt = [DateTime]::MinValue
$treeSweepIntervalMilliseconds = 500
$observerReceiveCalls = 0
$treeSweepsDeferredUntilOwners = 0
$treeSweepsDeferredUntilLauncherExit = 0
$treeSweepPerformedAfterLauncherExit = $false
$testBudgetSeconds = if ($coverageEnabled) { 120 } else { 45 }
$nativeLanguageServerAckWritten = $false
$nativeLanguageServerAckErrors = [System.Collections.Generic.List[string]]::new()
$fixtureProcessScopeEvidence = $null
$testFailureMessage = ''
$verificationControl = ''

if ($coverageEnabled) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class HesperiaNativeProcess {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  public static bool HasExited(IntPtr handle) {
    uint result = WaitForSingleObject(handle, 0);
    if (result == 0) return true;
    if (result == 258) return false;
    throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  public static DateTime CreationTime(IntPtr handle) {
    long creation, exit, kernel, user;
    if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    if (creation <= 0) throw new InvalidOperationException("Kernel process creation time is invalid.");
    return DateTime.FromFileTimeUtc(creation);
  }
  public static DateTime ExitTime(IntPtr handle) {
    if (!HasExited(handle)) throw new InvalidOperationException("Kernel process has not exited.");
    long creation, exit, kernel, user;
    if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    if (exit <= 0 || exit < creation) throw new InvalidOperationException("Kernel process exit time is invalid.");
    return DateTime.FromFileTimeUtc(exit);
  }
  public static int ExitCode(IntPtr handle) {
    if (!HasExited(handle)) throw new InvalidOperationException("Kernel process has not exited.");
    uint code;
    if (!GetExitCodeProcess(handle, out code)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return unchecked((int)code);
  }
}
'@

  $ownerReceiptConfig = Get-Content -LiteralPath $env:HESPERIA_EDITOR_COVERAGE_CONFIG -Raw | ConvertFrom-Json

  if (
    $ownerReceiptConfig.format -ne 'hesperia-editor-coverage-config' -or
    $ownerReceiptConfig.version -ne 1 -or
    [string]::IsNullOrWhiteSpace([string]$ownerReceiptConfig.runId) -or
    [string]::IsNullOrWhiteSpace([string]$ownerReceiptConfig.populationFingerprint)
  ) { throw 'Editor coverage configuration is invalid for native owner observation.' }

  if ($null -ne $ownerReceiptConfig.verificationControl) {
    if ([string]$ownerReceiptConfig.verificationControl -notin @('kill-extension-host', 'kill-language-server')) {
      throw 'Editor native verification control is invalid.'
    }

    $verificationControl = [string]$ownerReceiptConfig.verificationControl
  }
}

function Test-SameNativeCreationTime([datetime]$Left, [datetime]$Right) {
  return [Math]::Abs(($Left.ToUniversalTime() - $Right.ToUniversalTime()).Ticks) -le $script:creationTimeToleranceTicks
}

function Test-RetainedHandleGeneration([object]$Record) {
  if (-not $Record.attached -or $null -eq $Record.processHandle) { return $false }

  try {
    if ([HesperiaNativeProcess]::HasExited($Record.nativeHandle)) { return $false }

    return Test-SameNativeCreationTime ([HesperiaNativeProcess]::CreationTime($Record.nativeHandle)) ([datetime]$Record.creationTime)
  } catch { return $false }
}

function Get-LiveRetainedProcessSnapshot([object]$Record, [hashtable]$SnapshotByPid) {
  if (-not $Record.attached -or $null -eq $Record.processHandle) { return $null }

  try {
    $Record.processHandle.Refresh()

    if ([HesperiaNativeProcess]::HasExited($Record.nativeHandle)) { return $null }

    $handleCreationTime = [HesperiaNativeProcess]::CreationTime($Record.nativeHandle)

    if (-not (Test-SameNativeCreationTime $handleCreationTime ([datetime]$Record.creationTime))) {
      throw ('Retained process handle creation identity changed for PID ' + $Record.pid)
    }

    $snapshot = if ($null -ne $SnapshotByPid) {
      $SnapshotByPid[[string]$Record.pid]
    } else {
      Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($Record.pid)" -ErrorAction Stop
    }

    if ($null -eq $snapshot) { return $null }

    $snapshotCreationTime = ([datetime]$snapshot.CreationDate).ToUniversalTime()

    $mismatchFields = @()

    if (-not (Test-SameNativeCreationTime $handleCreationTime $snapshotCreationTime)) { $mismatchFields += 'creationTime' }

    if ([int]$snapshot.ParentProcessId -ne [int]$Record.parentPid) { $mismatchFields += 'parentPid' }

    if ([string]::Compare([string]$snapshot.Name, [string]$Record.processName, $true) -ne 0) { $mismatchFields += 'name' }

    if ($snapshot.ExecutablePath -and [string]::Compare([string]$snapshot.ExecutablePath, [string]$Record.executablePath, $true) -ne 0) { $mismatchFields += 'executablePath' }

    if ($snapshot.CommandLine -and [string]$snapshot.CommandLine -cne [string]$Record.commandLine) { $mismatchFields += 'commandLine' }

    if ($mismatchFields.Count -gt 0) {
      throw ('Current process snapshot does not match the retained handle for PID ' + $Record.pid + ' (' + ($mismatchFields -join ', ') + ')')
    }

    if (-not $snapshot.ExecutablePath -or -not $snapshot.CommandLine) { return $null }

    $Record.processHandle.Refresh()

    if ([HesperiaNativeProcess]::HasExited($Record.nativeHandle)) { return $null }

    return $snapshot
  } catch {
    try {
      $Record.processHandle.Refresh()

      if ([HesperiaNativeProcess]::HasExited($Record.nativeHandle)) { return $null }
    } catch { }

    throw ('Could not verify retained process identity ' + $Record.pid + ': ' + $_.Exception.Message)
  }
}

function Get-AttachedChildRecord([object]$Parent, [object]$ProcessInfo, [datetime]$ParentCreationTime, [hashtable]$SnapshotByPid) {
  $processId = [int]$ProcessInfo.ProcessId
  $processHandle = $null
  $currentChild = $null
  $handleCreationTime = $null

  try {
    $processHandle = [System.Diagnostics.Process]::GetProcessById($processId)
    $null = $processHandle.Handle

    $processHandle.Refresh()

    if ([HesperiaNativeProcess]::HasExited($processHandle.Handle)) {
      $processHandle.Dispose();

      return $null
    }

    $handleCreationTime = [HesperiaNativeProcess]::CreationTime($processHandle.Handle)

    if (
      -not (Test-SameNativeCreationTime $handleCreationTime ([datetime]$ProcessInfo.CreationDate).ToUniversalTime()) -or
      $handleCreationTime.AddTicks($script:creationTimeToleranceTicks) -lt $ParentCreationTime
    ) {
      $processHandle.Dispose()

      return $null
    }

    $currentChild = if ($null -ne $SnapshotByPid) {
      $SnapshotByPid[[string]$processId]
    } else {
      Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
    }

    if (
      $null -eq $currentChild -or
      [int]$currentChild.ParentProcessId -ne [int]$Parent.pid -or
      -not (Test-SameNativeCreationTime $handleCreationTime ([datetime]$currentChild.CreationDate).ToUniversalTime()) -or
      [string]::IsNullOrWhiteSpace([string]$currentChild.ExecutablePath) -or
      [string]::IsNullOrWhiteSpace([string]$currentChild.CommandLine)
    ) {
      $processHandle.Dispose()

      return $null
    }
  } catch {
    if ($null -ne $processHandle) { $processHandle.Dispose() }

    return $null
  }

  if ($null -eq (Get-LiveRetainedProcessSnapshot $Parent $SnapshotByPid)) {
    $processHandle.Dispose()

    return $null
  }

  $processHandle.Refresh()

  if ([HesperiaNativeProcess]::HasExited($processHandle.Handle)) {
    $processHandle.Dispose()

    return $null
  }

  return [pscustomobject]@{
    pid = $processId
    parentPid = [int]$currentChild.ParentProcessId
    processName = [string]$currentChild.Name
    executablePath = [string]$currentChild.ExecutablePath
    commandLine = [string]$currentChild.CommandLine
    creationTime = $handleCreationTime.ToString('o')
    attached = $true
    attachedAt = [DateTime]::UtcNow.ToString('o')
    exitObserved = $false
    exitObservedAt = ''
    processExitTime = ''
    exitCode = $null
    processHandle = $processHandle
    nativeHandle = $processHandle.Handle
  }
}

function Get-ProcessEventByPid([int]$ProcessId) {
  $matches = @($processEvents | Where-Object { [int]$_.pid -eq $ProcessId })

  if ($matches.Count -gt 1) { throw ('Native process observer has duplicate records for PID ' + $ProcessId) }

  if ($matches.Count -eq 1) { return $matches[0] }

  return $null
}

function Get-OrAttachOwnedProcess([int]$ProcessId, [int[]]$VisitedPids) {
  if ($ProcessId -le 0) { throw ('Native owner ancestry contains invalid PID ' + $ProcessId) }

  if ($ProcessId -in $VisitedPids) { throw ('Native owner ancestry contains a cycle at PID ' + $ProcessId) }

  $existing = Get-ProcessEventByPid $ProcessId

  if ($null -ne $existing) { return $existing }

  $root = Get-ProcessEventByPid $codeLaunchPid

  if ($null -eq $root -or -not $root.attached -or $null -eq $root.processHandle) {
    throw 'Native owner ancestry cannot be attached without the retained isolated VS Code launcher.'
  }

  $processInfo = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop

  if ($null -eq $processInfo) { throw ('Receipt hinted PID is no longer present for live native attachment: ' + $ProcessId) }

  $creationTime = ([datetime]$processInfo.CreationDate).ToUniversalTime()

  if ($creationTime.AddTicks($creationTimeToleranceTicks) -lt [datetime]$root.creationTime) {
    throw ('Receipt hinted PID predates the retained VS Code launcher generation: ' + $ProcessId)
  }

  $parentPid = [int]$processInfo.ParentProcessId

  if ($parentPid -le 0) { throw ('Receipt hinted PID has no usable native parent: ' + $ProcessId) }

  $parent = Get-ProcessEventByPid $parentPid

  if ($null -eq $parent) {
    $parent = Get-OrAttachOwnedProcess $parentPid (@($VisitedPids) + @($ProcessId))
  }

  if ($null -eq (Get-LiveRetainedProcessSnapshot $parent)) {
    throw ('Required native parent was not independently retained alive for PID ' + $ProcessId)
  }

  $record = Get-AttachedChildRecord $parent $processInfo ([datetime]$parent.creationTime)

  if ($null -eq $record) {
    throw ('Required receipt-hinted process could not be attached while alive: ' + $ProcessId)
  }

  $ownedProcessIds[[string]$ProcessId] = $true

  $processEvents.Add($record)

  return $record
}

function Read-AvailableOwnerReceipt([string]$Role) {
  $path = Join-Path $coverageOutput ($Role + '-start.json')

  if (-not (Test-Path -LiteralPath $path)) { return $null }

  try {
    $receipt = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    $script:ownerReceiptParseFailures++
    return $null
  }

  $startedAt = [DateTimeOffset]::MinValue
  $startedAtValid = [DateTimeOffset]::TryParse([string]$receipt.startedAt, [ref]$startedAt)

  if (
    $receipt.format -ne 'hesperia-editor-owner-start' -or
    $receipt.version -ne 1 -or
    $receipt.runId -ne $ownerReceiptConfig.runId -or
    $receipt.populationFingerprint -ne $ownerReceiptConfig.populationFingerprint -or
    $receipt.role -ne $Role -or
    $receipt.ownerId -ne ('vscode-' + $Role + '-' + $ownerReceiptConfig.runId) -or
    $receipt.pid -isnot [int] -or $receipt.pid -le 0 -or
    $receipt.ppid -isnot [int] -or $receipt.ppid -le 0 -or
    [string]::IsNullOrWhiteSpace([string]$receipt.execPath) -or
    $receipt.argv -isnot [array] -or $receipt.argv.Count -eq 0 -or
    -not $startedAtValid -or
    [string]$receipt.startedAt -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$'
  ) {
    throw ('Current-run ' + $Role + ' start receipt has an invalid owner identity or schema.')
  }

  return $receipt
}

function Test-NativeHostCandidate([object]$Record) {
  $expectedUserData = Join-Path $testRoot 'user-data'
  $userDataPattern = '(?i)--user-data-dir(?:=|\s+)\"?' + [regex]::Escape($expectedUserData)

  if (
    [string]::Compare([string]$Record.executablePath, [string]$CodePath, $true) -ne 0 -or
    [string]$Record.commandLine -notmatch $userDataPattern -or
    [string]$Record.commandLine -notmatch '(?i)--type=utility' -or
    [string]$Record.commandLine -notmatch '(?i)--utility-sub-type=node\.mojom\.NodeService'
  ) {
    throw ('Native Extension Host ancestry does not match this isolated VS Code NodeService process: ' + $Record.pid)
  }
}

function Test-OwnerNativeCandidate([object]$Owner, [object]$Record) {
  if (
    [int]$Record.pid -ne [int]$Owner.pid -or
    [int]$Record.parentPid -ne [int]$Owner.ppid -or
    [string]::Compare([string]$Record.executablePath, [string]$Owner.execPath, $true) -ne 0
  ) {
    throw ('Native process identity does not match the process-owned ' + $Owner.role + ' receipt.')
  }

  $ownerStartedAt = [DateTimeOffset]::Parse([string]$Owner.startedAt).UtcDateTime
  $nativeCreatedAt = [datetime]$Record.creationTime

  if ($ownerStartedAt -lt $nativeCreatedAt.AddTicks(-$creationTimeToleranceTicks)) {
    throw ('Process-owned ' + $Owner.role + ' start precedes its native process creation.')
  }

  if ($Owner.role -eq 'extension-host') {
    Test-NativeHostCandidate $Record
  } else {
    $cliPath = [System.IO.Path]::GetFullPath((Join-Path $packageRoot 'packages\language-server\dist\cli.js'))
    $nativeCommand = ([string]$Record.commandLine).Replace('/', '\')

    if ($nativeCommand.IndexOf($cliPath.Replace('/', '\'), [StringComparison]::OrdinalIgnoreCase) -lt 0) {
      throw 'Native Bun process command line does not identify the original compiled language-server CLI.'
    }

    $hostRecord = Get-ProcessEventByPid ([int]$Owner.ppid)

    if ($null -eq $hostRecord) { throw 'Native language-server parent is missing from the retained owner ancestry.' }

    Test-NativeHostCandidate $hostRecord
  }
}

function Receive-OwnerStartCandidates {
  foreach ($role in @('language-server', 'extension-host')) {
    $receiptObservedAt = [DateTime]::UtcNow
    $owner = Read-AvailableOwnerReceipt $role

    if ($null -eq $owner) { continue }

    try {
      $record = Get-OrAttachOwnedProcess ([int]$owner.pid) @()

      Test-OwnerNativeCandidate $owner $record
    } catch {
      $ownerAdmissionFailures.Add([pscustomobject]@{
        role = $role
        pid = [int]$owner.pid
        parentPid = [int]$owner.ppid
        receiptStartedAt = [string]$owner.startedAt
        receiptObservedAt = $receiptObservedAt.ToString('o')
        error = $_.Exception.Message
      })

      throw
    }

    if ($ownerAdmissionKeys.ContainsKey($role) -and [int]$ownerAdmissionKeys[$role] -ne [int]$owner.pid) {
      throw ('Current-run ' + $role + ' receipt changed its owner PID.')
    }

    if (-not $ownerAdmissionKeys.ContainsKey($role)) {
      $ownerAdmissionKeys[$role] = [int]$owner.pid

      $ownerAdmissionDiagnostics.Add([pscustomobject]@{
        role = $role
        pid = [int]$owner.pid
        parentPid = [int]$owner.ppid
        receiptStartedAt = [string]$owner.startedAt
        receiptObservedAt = $receiptObservedAt.ToString('o')
        nativeAttachedAt = [string]$record.attachedAt
        receiptToObservationMilliseconds = [Math]::Round(($receiptObservedAt - [DateTimeOffset]::Parse([string]$owner.startedAt).UtcDateTime).TotalMilliseconds, 3)
        observationToAttachmentMilliseconds = [Math]::Round(([DateTime]::Parse([string]$record.attachedAt).ToUniversalTime() - $receiptObservedAt).TotalMilliseconds, 3)
      })
    }
  }
}

function Try-WriteNativeOwnerAdmission {
  $destination = Join-Path $coverageOutput 'owner-native-admission.json'

  if (Test-Path -LiteralPath $destination) { return }

  if (-not $ownerAdmissionKeys.ContainsKey('extension-host') -or -not $ownerAdmissionKeys.ContainsKey('language-server')) { return }

  $hostOwner = Read-AvailableOwnerReceipt 'extension-host'
  $serverOwner = Read-AvailableOwnerReceipt 'language-server'
  $hostRecord = Get-ProcessEventByPid ([int]$ownerAdmissionKeys['extension-host'])
  $serverRecord = Get-ProcessEventByPid ([int]$ownerAdmissionKeys['language-server'])

  if ($null -eq $hostOwner -or $null -eq $serverOwner -or $null -eq $hostRecord -or $null -eq $serverRecord) { return }

  Test-OwnerNativeCandidate $hostOwner $hostRecord

  Test-OwnerNativeCandidate $serverOwner $serverRecord

  if (-not (Test-RetainedHandleGeneration $hostRecord) -or -not (Test-RetainedHandleGeneration $serverRecord)) {
    throw 'Required native owners exited before their live admission acknowledgement.'
  }

  $admission = [pscustomobject]@{
    format = 'hesperia-editor-native-owner-admission'
    version = 1
    runId = $ownerReceiptConfig.runId
    populationFingerprint = $ownerReceiptConfig.populationFingerprint
    extensionHostPid = $hostRecord.pid
    languageServerPid = $serverRecord.pid
    languageServerParentPid = $serverRecord.parentPid
    admittedAt = [DateTime]::UtcNow.ToString('o')
  }

  [System.IO.File]::WriteAllText($destination, ($admission | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
}

function Receive-ProcessStarts([switch]$IncludeUnrelated, [switch]$ForceTreeSweep) {
  $script:observerReceiveCalls++

  if ($IncludeUnrelated) {
    try { Receive-OwnerStartCandidates } catch { Write-Output ('Owner receipt attachment during cleanup: ' + $_.Exception.Message) }
  } else {
    Receive-OwnerStartCandidates
  }

  Observe-RetainedProcessExits

  if (-not $IncludeUnrelated) { Try-WriteNativeOwnerAdmission }

  if (-not $IncludeUnrelated -and $verificationControl) { Try-RunOwnerKillControl }

  Try-WriteLanguageServerExitAcknowledgement

  $requiredOwnerKeys = @(
    'language-server'
    'extension-host'
  )

  if (-not $IncludeUnrelated -and @($requiredOwnerKeys | Where-Object { -not $ownerAdmissionKeys.ContainsKey($_) }).Count -gt 0) {
    $script:treeSweepsDeferredUntilOwners++
    return
  }

  $launcher = Get-ProcessEventByPid $codeLaunchPid

  if (-not $IncludeUnrelated -and ($null -eq $launcher -or -not $launcher.exitObserved)) {
    $script:treeSweepsDeferredUntilLauncherExit++
    return
  }

  if (-not $IncludeUnrelated -and $treeSweepPerformedAfterLauncherExit) {
    return
  }

  if (-not $IncludeUnrelated) { $script:treeSweepPerformedAfterLauncherExit = $true }

  $now = [DateTime]::UtcNow

  if (-not $ForceTreeSweep -and $now -lt $script:nextTreeSweepAt) { return }

  $sweepStartedAt = $now
  $script:nextTreeSweepAt = $now.AddMilliseconds($script:treeSweepIntervalMilliseconds)
  $beforeCount = $processEvents.Count
  $parents = @($processEvents)
  $snapshotsByPid = $null

  if ($ForceTreeSweep) {
    $liveParents = [System.Collections.Generic.List[object]]::new()

    foreach ($parent in $parents) {
      if (-not $parent.attached -or $null -eq $parent.processHandle) { continue }

      if ([HesperiaNativeProcess]::HasExited($parent.nativeHandle)) { continue }

      if (-not (Test-RetainedHandleGeneration $parent)) {
        if ([HesperiaNativeProcess]::HasExited($parent.nativeHandle)) { continue }

        throw ('Live parent kernel creation identity changed before tree observation: ' + $parent.pid)
      }

      $liveParents.Add($parent)
    }

    $parents = @($liveParents)
    $snapshotsByPid = @{}

    if ($parents.Count -gt 0) {
      foreach ($snapshot in @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)) {
        $snapshotId = [string][int]$snapshot.ProcessId

        if ($snapshotsByPid.ContainsKey($snapshotId)) {
          throw ('Native process snapshot contains duplicate PID: ' + $snapshotId)
        }

        $snapshotsByPid[$snapshotId] = $snapshot
      }
    }
  }

  foreach ($parent in $parents) {
    if ($null -eq (Get-LiveRetainedProcessSnapshot $parent $snapshotsByPid)) { continue }

    $children = if ($null -ne $snapshotsByPid) {
      @($snapshotsByPid.Values | Where-Object { [int]$_.ParentProcessId -eq [int]$parent.pid })
    } else {
      Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId = $($parent.pid)" -ErrorAction Stop
    }

    if ($null -eq (Get-LiveRetainedProcessSnapshot $parent $snapshotsByPid)) { continue }

    $parentCreationTime = [datetime]$parent.creationTime

    foreach ($processInfo in @($children)) {
      if ([int]$processInfo.ParentProcessId -ne [int]$parent.pid) { continue }

      $processId = [int]$processInfo.ProcessId
      $snapshotCreationTime = ([datetime]$processInfo.CreationDate).ToUniversalTime()

      if ($snapshotCreationTime.AddTicks($script:creationTimeToleranceTicks) -lt $parentCreationTime) { continue }

      if ($ownedProcessIds.ContainsKey([string]$processId)) {
        $existing = @($processEvents | Where-Object { $_.pid -eq $processId })

        if (
          $existing.Count -ne 1 -or
          [string]::IsNullOrWhiteSpace($existing[0].creationTime) -or
          -not (Test-SameNativeCreationTime $snapshotCreationTime ([datetime]$existing[0].creationTime))
        ) {
          throw ('Owned process ID was reused during the editor run: ' + $processId)
        }

        continue
      }

      if ($null -eq (Get-LiveRetainedProcessSnapshot $parent $snapshotsByPid)) { continue }

      $record = Get-AttachedChildRecord $parent $processInfo $parentCreationTime $snapshotsByPid

      if ($null -eq $record) { continue }

      $ownedProcessIds[[string]$processId] = $true

      $processEvents.Add($record)
    }
  }

  $sweepFinishedAt = [DateTime]::UtcNow

  $treeSweepDiagnostics.Add([pscustomobject]@{
    startedAt = $sweepStartedAt.ToString('o')
    finishedAt = $sweepFinishedAt.ToString('o')
    durationMilliseconds = [Math]::Round(($sweepFinishedAt - $sweepStartedAt).TotalMilliseconds, 3)
    parentCount = $processEvents.Count
    newlyAttachedCount = $processEvents.Count - $beforeCount
  })
}

function Receive-OwnedProcessTree {
  for ($sweep = 0; $sweep -lt 16; $sweep++) {
    $beforeCount = $processEvents.Count

    Receive-ProcessStarts -IncludeUnrelated -ForceTreeSweep

    if ($processEvents.Count -eq $beforeCount) { return }
  }

  throw 'Owned process discovery did not reach a stable tree before termination.'
}

function Observe-RetainedProcessExits {
  foreach ($record in @($processEvents)) {
    if (-not $record.attached -or $null -eq $record.processHandle) { continue }

    try {
      if ([HesperiaNativeProcess]::HasExited($record.nativeHandle) -and -not $record.exitObserved) {
        if (-not (Test-SameNativeCreationTime ([HesperiaNativeProcess]::CreationTime($record.nativeHandle)) ([datetime]$record.creationTime))) {
          throw 'Retained kernel process creation identity changed.'
        }

        $record.exitCode = [HesperiaNativeProcess]::ExitCode($record.nativeHandle)
        $record.processExitTime = [HesperiaNativeProcess]::ExitTime($record.nativeHandle).ToString('o')
        $record.exitObservedAt = [DateTime]::UtcNow.ToString('o')
        $record.exitObserved = $true
      }
    } catch {
      throw ('Could not observe owned process exit for PID ' + $record.pid + ': ' + $_.Exception.Message)
    }
  }
}

function Try-ReadCoverageJson([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }

  try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -ErrorAction Stop } catch { return $null }
}

function Try-RunOwnerKillControl {
  $ready = Try-ReadCoverageJson (Join-Path $coverageOutput 'owner-kill-ready.json')

  if ($null -eq $ready) { return }

  $expectedReadyKeys = @('format', 'version', 'runId', 'populationFingerprint', 'mode', 'extensionHostPid', 'assertionsCompletedAt')
  $assertionsCompletedAt = [DateTimeOffset]::MinValue

  if (
    @($ready.PSObject.Properties.Name).Count -ne $expectedReadyKeys.Count -or
    @($ready.PSObject.Properties.Name | Where-Object { $_ -notin $expectedReadyKeys }).Count -gt 0 -or
    $ready.format -ne 'hesperia-editor-owner-kill-ready' -or $ready.version -ne 1 -or
    $ready.runId -ne $ownerReceiptConfig.runId -or
    $ready.populationFingerprint -ne $ownerReceiptConfig.populationFingerprint -or
    $ready.mode -ne $verificationControl -or
    $ready.extensionHostPid -isnot [int] -or $ready.extensionHostPid -le 0 -or
    -not [DateTimeOffset]::TryParse([string]$ready.assertionsCompletedAt, [ref]$assertionsCompletedAt) -or
    $assertionsCompletedAt.UtcDateTime -gt [DateTime]::UtcNow
  ) { throw 'Private owner kill barrier has an invalid current-run identity.' }

  if (-not $ownerAdmissionKeys.ContainsKey('extension-host') -or -not $ownerAdmissionKeys.ContainsKey('language-server')) {
    return
  }

  $report = Get-Content -LiteralPath (Join-Path $testRoot 'editor-result.json') -Raw | ConvertFrom-Json

  if (-not $report.passed -or @($report.checks).Count -ne 19) {
    throw 'Private owner kill control requires the genuine original nineteen-check report.'
  }

  Copy-Item -LiteralPath (Join-Path $testRoot 'editor-result.json') -Destination (Join-Path $coverageOutput 'editor-result.json')

  Receive-OwnedProcessTree

  $hostRecord = Get-ProcessEventByPid ([int]$ownerAdmissionKeys['extension-host'])
  $serverRecord = Get-ProcessEventByPid ([int]$ownerAdmissionKeys['language-server'])
  $launcher = Get-ProcessEventByPid $codeLaunchPid

  if ([int]$ready.extensionHostPid -ne [int]$hostRecord.pid -or [int]$serverRecord.parentPid -ne [int]$hostRecord.pid) {
    throw 'Private owner kill barrier does not match the admitted native owner chain.'
  }

  $role = if ($verificationControl -eq 'kill-extension-host') { 'extension-host' } else { 'language-server' }
  $target = if ($role -eq 'extension-host') { $hostRecord } else { $serverRecord }
  $owner = Read-AvailableOwnerReceipt $role

  if ($null -eq $owner) { throw 'Private owner kill control lost the actual owner start receipt.' }

  Test-OwnerNativeCandidate $owner $target

  $ancestry = [System.Collections.Generic.List[object]]::new()
  $cursor = $target

  while ($null -ne $cursor) {
    if ($null -eq (Get-LiveRetainedProcessSnapshot $cursor)) {
      throw 'Private owner kill control could not verify the retained live native ancestry.'
    }

    $ancestry.Add([pscustomobject]@{
      pid = $cursor.pid
      parentPid = $cursor.parentPid
      executablePath = $cursor.executablePath
      commandLine = $cursor.commandLine
      creationTime = $cursor.creationTime
      verifiedAliveAt = [DateTime]::UtcNow.ToString('o')
    })

    if ([int]$cursor.pid -eq $codeLaunchPid) { break }

    $cursor = Get-ProcessEventByPid ([int]$cursor.parentPid)
  }

  if ($ancestry.Count -lt 2 -or [int]$ancestry[$ancestry.Count - 1].pid -ne $codeLaunchPid) {
    throw 'Private owner kill control did not reach the retained isolated GUI launcher.'
  }

  if (-not (Test-RetainedHandleGeneration $target)) { throw 'Private kill target generation is no longer alive.' }

  $terminatedAt = [DateTime]::UtcNow.ToString('o')

  $target.processHandle.Kill()

  $target.processHandle.WaitForExit(5000) | Out-Null

  Observe-RetainedProcessExits

  if (-not $target.exitObserved -or $target.exitCode -eq 0) {
    throw 'Private owner termination did not produce an actual nonzero retained kernel exit.'
  }

  $control = [pscustomobject]@{
    format = 'hesperia-editor-native-owner-kill-control'
    version = 1
    runId = $ownerReceiptConfig.runId
    populationFingerprint = $ownerReceiptConfig.populationFingerprint
    mode = $verificationControl
    role = $role
    pid = $target.pid
    parentPid = $target.parentPid
    executablePath = $target.executablePath
    commandLine = $target.commandLine
    creationTime = $target.creationTime
    attachedAt = $target.attachedAt
    assertionsCompletedAt = $ready.assertionsCompletedAt
    terminatedAt = $terminatedAt
    processExitTime = $target.processExitTime
    exitObservedAt = $target.exitObservedAt
    exitCode = $target.exitCode
    ancestry = @($ancestry)
  }

  [System.IO.File]::WriteAllText((Join-Path $coverageOutput 'owner-kill-control.json'), ($control | ConvertTo-Json -Depth 6 -Compress), [System.Text.UTF8Encoding]::new($false))

  throw ('Private native owner kill control terminated ' + $role + ' PID ' + $target.pid)
}

function Try-WriteLanguageServerExitAcknowledgement {
  if ($nativeLanguageServerAckWritten) { return }

  $lifecyclePath = Join-Path $coverageOutput 'extension-host-deactivate-start.json'
  $lifecycle = Try-ReadCoverageJson $lifecyclePath

  if ($null -eq $lifecycle) { return }

  if (
    $lifecycle.format -ne 'hesperia-editor-deactivate-start' -or
    $lifecycle.version -ne 1 -or
    $lifecycle.runId -ne $ownerReceiptConfig.runId -or
    $lifecycle.populationFingerprint -ne $ownerReceiptConfig.populationFingerprint -or
    $lifecycle.extensionHostOwnerId -ne ('vscode-extension-host-' + $ownerReceiptConfig.runId) -or
    $lifecycle.extensionHostPid -le 0
  ) {
    throw 'Extension Host deactivation signal does not belong to the current capture run.'
  }

  $hostRecord = Get-ProcessEventByPid ([int]$lifecycle.extensionHostPid)
  $launcher = Get-ProcessEventByPid $codeLaunchPid
  $serverStart = Try-ReadCoverageJson (Join-Path $coverageOutput 'language-server-start.json')
  $serverExit = Try-ReadCoverageJson (Join-Path $coverageOutput 'language-server-exit.json')
  $serverRawPresent = Test-Path -LiteralPath (Join-Path $coverageOutput 'language-server-coverage.json')
  $server = if ($null -ne $serverStart) { Get-ProcessEventByPid ([int]$serverStart.pid) } else { $null }

  if (
    $null -eq $hostRecord -or $null -eq $launcher -or $null -eq $server -or
    $null -eq $serverStart -or $null -eq $serverExit -or -not $serverRawPresent -or
    -not $server.exitObserved -or [string]::IsNullOrWhiteSpace([string]$server.processExitTime)
  ) { return }

  if (
    $serverStart.format -ne 'hesperia-editor-owner-start' -or
    $serverStart.version -ne 1 -or
    $serverStart.runId -ne $ownerReceiptConfig.runId -or
    $serverStart.populationFingerprint -ne $ownerReceiptConfig.populationFingerprint -or
    $serverStart.ownerId -ne ('vscode-language-server-' + $ownerReceiptConfig.runId) -or
    $serverStart.role -ne 'language-server' -or
    [int]$serverStart.pid -ne [int]$server.pid -or
    [int]$serverStart.ppid -ne [int]$hostRecord.pid -or
    [string]::Compare([string]$serverStart.execPath, [string]$server.executablePath, $true) -ne 0 -or
    [int]$server.parentPid -ne [int]$hostRecord.pid -or
    $serverExit.format -ne 'hesperia-editor-owner-exit' -or
    $serverExit.version -ne 1 -or
    $serverExit.runId -ne $ownerReceiptConfig.runId -or
    $serverExit.populationFingerprint -ne $ownerReceiptConfig.populationFingerprint -or
    $serverExit.ownerId -ne $serverStart.ownerId -or
    [int]$serverExit.pid -ne [int]$server.pid -or
    [int]$serverExit.ppid -ne [int]$hostRecord.pid -or
    $serverExit.exitCode -ne [int]$server.exitCode
  ) {
    $script:nativeLanguageServerAckErrors.Add('Language-server process-owned start/exit receipts disagree with the retained kernel process.')

    return
  }

  if (-not (Test-RetainedHandleGeneration $hostRecord) -or -not (Test-RetainedHandleGeneration $launcher)) {
    $script:nativeLanguageServerAckErrors.Add('Host or isolated VS Code launcher was no longer alive when language-server exit was observed.')

    return
  }

  $acknowledgedAt = [DateTime]::UtcNow.ToString('o')
  $ack = [pscustomobject]@{
    format = 'hesperia-editor-native-language-server-exit-ack'
    version = 1
    runId = $ownerReceiptConfig.runId
    populationFingerprint = $ownerReceiptConfig.populationFingerprint
    languageServerOwnerId = $serverStart.ownerId
    languageServerPid = [int]$server.pid
    languageServerParentPid = [int]$server.parentPid
    languageServerExecutablePath = [string]$server.executablePath
    languageServerCommandLine = [string]$server.commandLine
    languageServerCreationTime = [string]$server.creationTime
    languageServerProcessExitTime = [string]$server.processExitTime
    languageServerExitObservedAt = [string]$server.exitObservedAt
    languageServerExitCode = [int]$server.exitCode
    extensionHostPid = [int]$hostRecord.pid
    extensionHostExecutablePath = [string]$hostRecord.executablePath
    extensionHostCreationTime = [string]$hostRecord.creationTime
    extensionHostAliveObservedAt = $acknowledgedAt
    codeLaunchPid = [int]$launcher.pid
    codeLaunchExecutablePath = [string]$launcher.executablePath
    codeLaunchCreationTime = [string]$launcher.creationTime
    codeLaunchAliveObservedAt = $acknowledgedAt
    acknowledgedAt = $acknowledgedAt
  }
  $destination = Join-Path $coverageOutput 'language-server-native-exit-ack.json'

  [System.IO.File]::WriteAllText($destination, ($ack | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))

  $script:nativeLanguageServerAckWritten = $true
}

function Assert-IsolatedFixtureProcessScopeClear {
  $userDataPath = [System.IO.Path]::GetFullPath((Join-Path $testRoot 'user-data'))
  $extensionsPath = [System.IO.Path]::GetFullPath((Join-Path $testRoot 'extensions'))
  $processScopeMatches = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object {
    $commandLine = [string]$_.CommandLine
    $commandLine.IndexOf($userDataPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
    $commandLine.IndexOf($extensionsPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  $script:fixtureProcessScopeEvidence = [pscustomobject]@{
    checkedAt = [DateTime]::UtcNow.ToString('o')
    userDataPath = $userDataPath
    extensionsPath = $extensionsPath
    activeProcessIds = @($processScopeMatches | ForEach-Object { [int]$_.ProcessId })
  }

  if ($processScopeMatches.Count -gt 0) {
    throw ('Isolated VS Code fixture processes remain active after required-owner shutdown: ' + (@($processScopeMatches | ForEach-Object { [int]$_.ProcessId }) -join ', '))
  }
}

function Read-OwnerReceipt([string]$Path) {
  for ($attempt = 0; $attempt -lt 80; $attempt++) {
    if (Test-Path -LiteralPath $Path) {
      try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -ErrorAction Stop } catch { }
    }

    Start-Sleep -Milliseconds 25
  }

  throw ('Timed out reading process-owned editor receipt: ' + $Path)
}

function Write-NativeObservation([object[]]$Owners) {
  if (-not $coverageEnabled) { return }

  if (-not $nativeLanguageServerAckWritten) {
    throw 'Native language-server exit acknowledgement was not recorded before final process observation.'
  }

  foreach ($owner in $Owners) {
    $matches = @($processEvents | Where-Object { $_.pid -eq [int]$owner.pid })

    if ($matches.Count -ne 1 -or -not $matches[0].attached -or $null -eq $matches[0].processHandle) {
      throw ('Native process observer did not attach while owner was alive: ' + $owner.role)
    }
  }

  $launcherRecords = @($processEvents | Where-Object { $_.pid -eq $codeLaunchPid })

  if ($launcherRecords.Count -ne 1 -or -not $launcherRecords[0].attached) {
    throw 'Native process observer did not retain the owned VS Code launcher handle.'
  }

  $launcher = $launcherRecords[0]
  $deadline = [DateTime]::UtcNow.AddSeconds(15)

  while ([DateTime]::UtcNow -lt $deadline) {
    Receive-ProcessStarts

    $activePids = @()

    foreach ($record in $processEvents) {
      if (-not $record.attached -or $null -eq $record.processHandle) { continue }

      if (-not $record.exitObserved) { $activePids += [int]$record.pid }
    }

    if ($activePids.Count -eq 0) { break }

    Start-Sleep -Milliseconds 20
  }

  foreach ($record in $processEvents) {
    if (-not $record.attached -or $null -eq $record.processHandle) { continue }

    try {
      if (-not [HesperiaNativeProcess]::HasExited($record.nativeHandle)) {
        throw ('Owned VS Code descendant remains active after the shared exit deadline: ' + $record.pid)
      }

      if (-not $record.exitObserved -or [string]::IsNullOrWhiteSpace($record.exitObservedAt)) {
        throw ('Owned process has no valid retained kernel exit observation: ' + $record.pid)
      }
    } catch {
      throw ('Could not observe owned process exit for PID ' + $record.pid + ': ' + $_.Exception.Message)
    }
  }

  Assert-IsolatedFixtureProcessScopeClear

  $publicEvents = @($processEvents | ForEach-Object {
    [pscustomobject]@{
      pid = $_.pid
      parentPid = $_.parentPid
      processName = $_.processName
      executablePath = $_.executablePath
      commandLine = $_.commandLine
      creationTime = $_.creationTime
      attached = $_.attached
      attachedAt = $_.attachedAt
      exitObserved = $_.exitObserved
      exitObservedAt = $_.exitObservedAt
      processExitTime = $_.processExitTime
      exitCode = $_.exitCode
    }
  })
  $observation = [pscustomobject]@{
    format = 'hesperia-editor-native-process-observation'
    version = 1
    runId = (Get-Content -LiteralPath $env:HESPERIA_EDITOR_COVERAGE_CONFIG -Raw | ConvertFrom-Json).runId
    observerStartedAt = $observerStartedAt
    codeLaunchPid = $codeLaunchPid
    observedAt = [DateTime]::UtcNow.ToString('o')
    events = $publicEvents
    observerDiagnostics = [pscustomobject]@{
      receiveCalls = $observerReceiveCalls
      ownerReceiptParseFailures = $ownerReceiptParseFailures
      treeSweepsDeferredUntilOwners = $treeSweepsDeferredUntilOwners
      treeSweepsDeferredUntilLauncherExit = $treeSweepsDeferredUntilLauncherExit
      treeSweepPerformedAfterLauncherExit = $treeSweepPerformedAfterLauncherExit
      testBudgetSeconds = $testBudgetSeconds
      treeSweepIntervalMilliseconds = $treeSweepIntervalMilliseconds
      nativeLanguageServerAckWritten = $nativeLanguageServerAckWritten
      nativeLanguageServerAckErrors = @($nativeLanguageServerAckErrors)
      fixtureProcessScope = $fixtureProcessScopeEvidence
      ownerAdmissions = @($ownerAdmissionDiagnostics)
      ownerAdmissionFailures = @($ownerAdmissionFailures)
      treeSweeps = @($treeSweepDiagnostics)
    }
  }
  $destination = Join-Path $coverageOutput 'native-process-observation.json'

  [System.IO.File]::WriteAllText($destination, ($observation | ConvertTo-Json -Depth 8 -Compress), [System.Text.UTF8Encoding]::new($false))

  $script:nativeObservationWritten = $true
}

$passed = $false
$testProcess = $null

try {
  if ($coverageEnabled) {
    if (-not (Test-Path -LiteralPath $coverageOutput)) { throw 'Editor coverage output directory is missing.' }
  }

  New-Item -ItemType Directory -Path (Join-Path $testRoot 'src'), (Join-Path $testRoot 'node_modules') | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $testRoot 'node_modules\@hesperia') | Out-Null
  New-Item -ItemType Junction -Path (Join-Path $testRoot 'node_modules\hesperia') -Target (Join-Path $packageRoot 'packages\hesperia') | Out-Null
  New-Item -ItemType Junction -Path (Join-Path $testRoot 'node_modules\@hesperia\language-server') -Target (Join-Path $packageRoot 'packages\language-server') | Out-Null

  Set-Content -LiteralPath (Join-Path $testRoot 'package.json') -Encoding UTF8 -Value '{"name":"hesperia-editor-test","private":true,"type":"module"}'

  [System.IO.File]::WriteAllText((Join-Path $testRoot 'hesperia.config.json'), '')

  Set-Content -LiteralPath (Join-Path $testRoot 'tsconfig.json') -Encoding UTF8 -Value '{"compilerOptions":{"strict":true,"skipLibCheck":true,"lib":["ESNext","DOM"],"target":"ESNext","module":"ESNext","moduleResolution":"Bundler","types":[]}}'

  $cat = [char]::ConvertFromUtf32(0x1F408)
  $apiSource = 'export const message = "ready";'
  $shellSource = 'import { message } from "./api";' + "`r`n" + 'export default function App(){ return <html><head><title>Shell</title></head><body><main>{message}</main></body></html>; }'
  $source = 'import { message } from "../api"; export function App(){' + "`r`n" + ' const emoji = "' + $cat + '"; const field = <input />;' + "`r`n" + ' return <div title={field.value}>{message}{field.missing()}</div>;' + "`r`n" + '}'

  Set-Content -LiteralPath (Join-Path $testRoot 'api.ts') -Encoding UTF8 -Value $apiSource

  Set-Content -LiteralPath (Join-Path $testRoot 'app.tsx') -Encoding UTF8 -Value $shellSource

  Set-Content -LiteralPath (Join-Path $testRoot 'src\App.tsx') -Encoding UTF8 -Value $source

  $arguments = @(
    ('--extensionDevelopmentPath="' + $testExtensionRoot + '"'),
    ('--extensionTestsPath="' + $testHost + '"'),
    ('--user-data-dir="' + (Join-Path $testRoot 'user-data') + '"'),
    ('--extensions-dir="' + (Join-Path $testRoot 'extensions') + '"'),
    '--disable-workspace-trust', '--disable-gpu', '--skip-welcome', '--skip-release-notes', '--new-window',
    ('"' + $testRoot + '"')
  )

  if ($coverageEnabled) {
    $observerStartedAt = [DateTime]::UtcNow.ToString('o')
    $deadline = [DateTime]::UtcNow.AddSeconds($testBudgetSeconds)
    $env:HESPERIA_EDITOR_COVERAGE_ADMISSION_DEADLINE = ([DateTimeOffset]$deadline).ToUnixTimeMilliseconds().ToString([Globalization.CultureInfo]::InvariantCulture)
  }

  $testProcess = Start-Process -FilePath $CodePath -ArgumentList $arguments -WindowStyle Hidden -PassThru
  $codeLaunchPid = $testProcess.Id
  $null = $testProcess.Handle

  if ($coverageEnabled) {
    $launchCreationTime = [HesperiaNativeProcess]::CreationTime($testProcess.Handle)
    $launchInfo = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $codeLaunchPid" -ErrorAction Stop

    if ($null -eq $launchInfo) { throw 'VS Code launcher disappeared before native attachment.' }

    $snapshotCreationTime = ([datetime]$launchInfo.CreationDate).ToUniversalTime()

    $testProcess.Refresh()

    if ([HesperiaNativeProcess]::HasExited($testProcess.Handle)) { throw 'VS Code launcher exited before native attachment.' }

    $launchRecord = [pscustomobject]@{
      pid = $codeLaunchPid
      parentPid = [int]$launchInfo.ParentProcessId
      processName = [string]$launchInfo.Name
      executablePath = [string]$launchInfo.ExecutablePath
      commandLine = [string]$launchInfo.CommandLine
      creationTime = $launchCreationTime.ToString('o')
      attached = $true
      attachedAt = [DateTime]::UtcNow.ToString('o')
      exitObserved = $false
      exitObservedAt = ''
      processExitTime = ''
      exitCode = $null
      processHandle = $testProcess
      nativeHandle = $testProcess.Handle
    }
    $ownedProcessIds[[string]$codeLaunchPid] = $true

    $processEvents.Add($launchRecord)

    if (
      -not (Test-SameNativeCreationTime $launchCreationTime $snapshotCreationTime) -or
      $launchRecord.parentPid -le 0 -or
      [string]::IsNullOrWhiteSpace($launchRecord.executablePath) -or
      [string]::IsNullOrWhiteSpace($launchRecord.commandLine) -or
      [string]::Compare([System.IO.Path]::GetFullPath($launchRecord.executablePath), [System.IO.Path]::GetFullPath($CodePath), $true) -ne 0
    ) {
      throw 'VS Code launcher process snapshot does not match its retained kernel process identity.'
    }
  }

  if (-not $coverageEnabled) { $deadline = [DateTime]::UtcNow.AddSeconds($testBudgetSeconds) }

  if ($coverageEnabled) {
    while (-not [HesperiaNativeProcess]::HasExited($launchRecord.nativeHandle) -and [DateTime]::UtcNow -lt $deadline) {
      Receive-ProcessStarts

      Start-Sleep -Milliseconds 20
    }

    if (-not [HesperiaNativeProcess]::HasExited($launchRecord.nativeHandle)) {
      throw ('VS Code instrumented extension tests exceeded ' + $testBudgetSeconds + ' seconds.')
    }
  } else {
    while (-not $testProcess.HasExited -and [DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 20

      $testProcess.Refresh()
    }

    if (-not $testProcess.HasExited) { throw 'VS Code extension tests exceeded 45 seconds.' }
  }

  if ($coverageEnabled) { Receive-ProcessStarts }

  $resultPath = Join-Path $testRoot 'editor-result.json'

  if (-not (Test-Path -LiteralPath $resultPath)) {
    throw ('VS Code exited without the existing editor result report (exit ' + $testProcess.ExitCode + '); isolated logs remain under ' + (Join-Path $testRoot 'user-data\logs'))
  }

  $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json

  if (-not $result.passed) { throw $result.error }

  if ($coverageEnabled) {
    Copy-Item -LiteralPath (Join-Path $testRoot 'editor-result.json') -Destination (Join-Path $coverageOutput 'editor-result.json')

    $hostStart = Read-OwnerReceipt (Join-Path $coverageOutput 'extension-host-start.json')
    $serverStart = Read-OwnerReceipt (Join-Path $coverageOutput 'language-server-start.json')

    Receive-ProcessStarts

    Write-NativeObservation @($hostStart, $serverStart)

    $logRoot = Join-Path $testRoot 'user-data\logs'

    if (Test-Path -LiteralPath $logRoot) {
      $buildDirectory = Split-Path -Parent $testExtensionRoot
      $evidenceDirectory = Join-Path $buildDirectory 'editor-evidence'
      New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null

      Copy-Item -LiteralPath $logRoot -Destination $evidenceDirectory -Recurse

      Write-Output ('VS Code isolated logs preserved under ' + (Join-Path $evidenceDirectory 'logs'))
    }
  }

  $passed = $true

  Write-Output ('VS Code extension checks passed: ' + ($result.checks -join ', '))
} catch {
  $testFailureMessage = $_.Exception.Message
  throw
} finally {
  if ($coverageEnabled) {
    try {
      if ($passed) {
        Receive-ProcessStarts
      } else {
        Receive-OwnedProcessTree
      }
    } catch {
      $observerCleanupErrors.Add($_.Exception.Message)

      Write-Output ('Process observer cleanup: ' + $_.Exception.Message)
    }

    if (-not $passed) {
      $forcedPids = @()

      $cleanupRecords = @($processEvents)
      [array]::Reverse($cleanupRecords)

      foreach ($record in $cleanupRecords) {
        if ($record.attached -and $null -ne $record.processHandle) {
          $canTerminate = $false
          $handleOnlyVerification = $false

          try {
            $currentSnapshot = Get-LiveRetainedProcessSnapshot $record
            $canTerminate = $null -ne $currentSnapshot

            if (-not $canTerminate -and (Test-RetainedHandleGeneration $record)) {
              $canTerminate = $true
              $handleOnlyVerification = $true
            }
          } catch {
            if (Test-RetainedHandleGeneration $record) {
              $canTerminate = $true
              $handleOnlyVerification = $true
            } else {
              $record.processHandle.Refresh()

              if (-not [HesperiaNativeProcess]::HasExited($record.nativeHandle)) {
                $cleanupFailures.Add([pscustomobject]@{
                  pid = $record.pid
                  parentPid = $record.parentPid
                  processName = $record.processName
                  executablePath = $record.executablePath
                  creationTime = $record.creationTime
                  commandLine = $record.commandLine
                  identityVerifiedByRetainedHandle = $false
                  stillLive = $true
                  error = $_.Exception.Message
                })
              }
            }
          }

          if ($canTerminate) {
            $terminationWaitPending = $false

            try {
              $record.processHandle.Refresh()

              if (-not [HesperiaNativeProcess]::HasExited($record.nativeHandle)) {
                if ($handleOnlyVerification -and -not (Test-RetainedHandleGeneration $record)) {
                  throw 'Retained kernel handle no longer matches its recorded process creation identity.'
                }

                $terminationWaitPending = $true

                $record.processHandle.Kill()

                $terminationWaitPending = $false

                $record.processHandle.WaitForExit(5000) | Out-Null

                $record.processHandle.Refresh()

                if (-not [HesperiaNativeProcess]::HasExited($record.nativeHandle)) {
                  throw 'Owned process remained live after termination through its retained handle.'
                }

                $forcedPids += [int]$record.pid
                $forcedCleanup = $true
              }
            } catch {
              $cleanupError = $_.Exception.Message

              try { $record.processHandle.Refresh() } catch { }

              $stillLive = $true
              $sameGeneration = $false

              try {
                if ($terminationWaitPending) { $record.processHandle.WaitForExit(5000) | Out-Null }

                $stillLive = -not [HesperiaNativeProcess]::HasExited($record.nativeHandle)
                $sameGeneration = Test-SameNativeCreationTime ([HesperiaNativeProcess]::CreationTime($record.nativeHandle)) ([datetime]$record.creationTime)
              } catch {
                $cleanupError += '; Could not reconcile retained process handle: ' + $_.Exception.Message
              }

              if ($stillLive -or -not $sameGeneration) {
                $cleanupFailures.Add([pscustomobject]@{
                  pid = $record.pid
                  parentPid = $record.parentPid
                  processName = $record.processName
                  executablePath = $record.executablePath
                  creationTime = $record.creationTime
                  commandLine = $record.commandLine
                  identityVerifiedByRetainedHandle = $sameGeneration
                  stillLive = $stillLive
                  error = $cleanupError
                })

                if ($stillLive) { $forcedCleanup = $true }
              }
            }
          }
        }
      }

      if (($forcedCleanup -or $cleanupFailures.Count -gt 0) -and (Test-Path -LiteralPath $coverageOutput)) {
        $cleanup = [pscustomobject]@{
          format = 'hesperia-editor-forced-cleanup'
          runId = (Get-Content -LiteralPath $env:HESPERIA_EDITOR_COVERAGE_CONFIG -Raw | ConvertFrom-Json).runId
          pids = $forcedPids
          failures = @($cleanupFailures)
        }

        [System.IO.File]::WriteAllText((Join-Path $coverageOutput 'forced-cleanup.json'), ($cleanup | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
      }

      if ($verificationControl) {
        try { Assert-IsolatedFixtureProcessScopeClear } catch {
          $observerCleanupErrors.Add($_.Exception.Message)

          Write-Output ('Private kill control fixture cleanup: ' + $_.Exception.Message)
        }
      }
    }

    if (-not $passed -and (Test-Path -LiteralPath $coverageOutput)) {
      $diagnosticEvents = @($processEvents | ForEach-Object {
        $stillLive = $false

        if ($null -ne $_.processHandle) {
          try {
            $stillLive = -not [HesperiaNativeProcess]::HasExited($_.nativeHandle)

            if (-not $stillLive -and -not $_.exitObserved) {
              $_.exitCode = [HesperiaNativeProcess]::ExitCode($_.nativeHandle)
              $_.exitObservedAt = [DateTime]::UtcNow.ToString('o')
              $_.processExitTime = [HesperiaNativeProcess]::ExitTime($_.nativeHandle).ToString('o')
              $_.exitObserved = $true
            }
          } catch { $observerCleanupErrors.Add('PID ' + $_.pid + ': ' + $_.Exception.Message) }
        }

        [pscustomobject]@{
          pid = $_.pid
          parentPid = $_.parentPid
          processName = $_.processName
          executablePath = $_.executablePath
          commandLine = $_.commandLine
          creationTime = $_.creationTime
          attached = $_.attached
          attachedAt = $_.attachedAt
          exitObserved = $_.exitObserved
          exitObservedAt = $_.exitObservedAt
          processExitTime = $_.processExitTime
          exitCode = $_.exitCode
          stillLive = $stillLive
        }
      })

      try {
        $diagnostic = [pscustomobject]@{
          format = 'hesperia-editor-native-process-failure'
          version = 1
          runId = (Get-Content -LiteralPath $env:HESPERIA_EDITOR_COVERAGE_CONFIG -Raw | ConvertFrom-Json).runId
          observerStartedAt = $observerStartedAt
          codeLaunchPid = $codeLaunchPid
          observedAt = [DateTime]::UtcNow.ToString('o')
          failure = $testFailureMessage
          observerErrors = @($observerCleanupErrors)
          forcedPids = @($forcedPids)
          cleanupFailures = @($cleanupFailures)
          events = $diagnosticEvents
          observerDiagnostics = [pscustomobject]@{
            receiveCalls = $observerReceiveCalls
            ownerReceiptParseFailures = $ownerReceiptParseFailures
            treeSweepsDeferredUntilOwners = $treeSweepsDeferredUntilOwners
            treeSweepsDeferredUntilLauncherExit = $treeSweepsDeferredUntilLauncherExit
            treeSweepPerformedAfterLauncherExit = $treeSweepPerformedAfterLauncherExit
            testBudgetSeconds = $testBudgetSeconds
            treeSweepIntervalMilliseconds = $treeSweepIntervalMilliseconds
            nativeLanguageServerAckWritten = $nativeLanguageServerAckWritten
            nativeLanguageServerAckErrors = @($nativeLanguageServerAckErrors)
            fixtureProcessScope = $fixtureProcessScopeEvidence
            ownerAdmissions = @($ownerAdmissionDiagnostics)
            ownerAdmissionFailures = @($ownerAdmissionFailures)
            treeSweeps = @($treeSweepDiagnostics)
          }
        }

        [System.IO.File]::WriteAllText((Join-Path $coverageOutput 'native-process-failure.json'), ($diagnostic | ConvertTo-Json -Depth 8 -Compress), [System.Text.UTF8Encoding]::new($false))
      } catch { Write-Output ('Could not write native process failure diagnostics: ' + $_.Exception.Message) }
    }

    $cleanupFailurePids = @($cleanupFailures | Where-Object { $_.stillLive } | ForEach-Object { [int]$_.pid })

    foreach ($record in $processEvents) {
      if ($null -ne $record.processHandle -and $record.pid -notin $cleanupFailurePids) { $record.processHandle.Dispose() }
    }

    if ($forcedCleanup) { Write-Output 'Editor capture rejected after forced owned-process cleanup or an owned process cleanup failure.' }

    foreach ($failure in $cleanupFailures) {
      if ($failure.stillLive) {
        Write-Output ('Owned process remains live and requires reconciliation: PID ' + $failure.pid + ', creation ' + $failure.creationTime + ', executable ' + $failure.executablePath + '; ' + $failure.error)
      }
    }
  }

  $junction = Join-Path $testRoot 'node_modules\hesperia'

  if (Test-Path -LiteralPath $junction) { (Get-Item -LiteralPath $junction).Delete() }

  $languageServerJunction = Join-Path $testRoot 'node_modules\@hesperia\language-server'

  if (Test-Path -LiteralPath $languageServerJunction) { (Get-Item -LiteralPath $languageServerJunction).Delete() }

  if ($passed) {
    if (-not $testRoot.StartsWith($temporaryBase, [StringComparison]::OrdinalIgnoreCase) -or -not ([System.IO.Path]::GetFileName($testRoot)).StartsWith('hesperia-vscode-')) { throw 'Refusing invalid cleanup path.' }

    $cleanupError = $null

    for ($attempt = 1; $attempt -le 8; $attempt++) {
      try {
        Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction Stop

        $cleanupError = $null
        break
      } catch {
        $cleanupError = $_
        $sharingViolation = $false
        $exception = $_.Exception

        while ($null -ne $exception) {
          if ($exception -is [System.IO.IOException] -and ($exception.HResult -band 0xffff) -in @(32, 33)) {
            $sharingViolation = $true
            break
          }

          $exception = $exception.InnerException
        }

        if (-not $sharingViolation -or $attempt -eq 8) { break }

        Start-Sleep -Milliseconds ([Math]::Min(1000, 100 * [Math]::Pow(2, $attempt - 1)))
      }
    }

    if ($null -ne $cleanupError) {
      $lockedFileError =
        $cleanupError.FullyQualifiedErrorId -like 'RemoveFileSystemItemIOError*' -and
        $cleanupError.Exception.Message -match '(?i)(não pode acessar o arquivo|usado por outro processo|used by another process|being used by another process)'

      if (
        $coverageEnabled -and
        $null -ne $fixtureProcessScopeEvidence -and
        @($fixtureProcessScopeEvidence.activeProcessIds).Count -eq 0 -and
        $lockedFileError
      ) {
        Write-Output ('Isolated test workspace retained because its log is still locked; copied logs are under ' + (Join-Path (Split-Path -Parent $testExtensionRoot) 'editor-evidence\logs') + '; fixture path: ' + $testRoot)
      } else {
        throw $cleanupError
      }
    }
  } else { Write-Output ('Test evidence retained in ' + $testRoot) }
}
