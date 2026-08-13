[CmdletBinding()]
param(
  [ValidateSet('install', 'status', 'uninstall')]
  [string]$Action = 'status',

  [string]$TaskName = 'AI Dev Controller',

  [string]$RepositoryPath = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

function Close-ControllerProcess([string]$Repository) {
  $runtimeLock = Join-Path $Repository 'data\.controller-runtime.lock'
  $legacyLock = Join-Path $Repository 'data\controller.lock'
  $lockPath = if (Test-Path -LiteralPath $runtimeLock -PathType Leaf) { $runtimeLock } else { $legacyLock }
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { return }
  $controllerPid = 0
  if (-not [int]::TryParse((Get-Content -Raw -LiteralPath $lockPath).Trim(), [ref]$controllerPid)) {
    return
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $controllerPid" -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    return
  }
  if ($process.Name -ne 'node.exe' -or $process.CommandLine -notmatch 'src[/\\]cli[/\\]main\.ts.*run') {
    throw "Refusing to stop PID $controllerPid because it is not this repository's controller: $($process.CommandLine)"
  }
  Stop-Process -Id $controllerPid -Force
  Start-Sleep -Seconds 2
}

if ($Action -eq 'status') {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    Write-Output "not-installed: $TaskName"
    exit 1
  }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  $healthy = $task.State -eq 'Running'
  $diagnosis = if ($healthy) {
    'supervisor is running'
  } elseif ($task.State -eq 'Ready') {
    'installed but not running; run `pnpm supervisor:install` to restart it'
  } else {
    "scheduled task state is $($task.State)"
  }
  [pscustomobject]@{
    TaskName = $TaskName
    State = $task.State
    Healthy = $healthy
    Diagnosis = $diagnosis
    LastRunTime = $info.LastRunTime
    LastTaskResult = $info.LastTaskResult
    NextRunTime = $info.NextRunTime
  } | Format-List
  if (-not $healthy) { exit 1 }
  exit 0
}

if ($Action -eq 'uninstall') {
  $repository = (Resolve-Path -LiteralPath $RepositoryPath).Path
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    Write-Output "already absent: $TaskName"
    exit 0
  }
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Close-ControllerProcess $repository
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "uninstalled: $TaskName"
  exit 0
}

$repository = (Resolve-Path -LiteralPath $RepositoryPath).Path
$supervisor = Join-Path $repository 'scripts\controller-supervisor.ps1'
if (-not (Test-Path -LiteralPath $supervisor -PathType Leaf)) {
  throw "Supervisor script is missing: $supervisor"
}

$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
$orca = (Get-Command orca -ErrorAction Stop).Source
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name

function ConvertTo-TaskArgument([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

$arguments = @(
  '-NoLogo'
  '-NoProfile'
  '-NonInteractive'
  '-ExecutionPolicy Bypass'
  '-WindowStyle Hidden'
  '-File ' + (ConvertTo-TaskArgument $supervisor)
  '-RepositoryPath ' + (ConvertTo-TaskArgument $repository)
  '-PnpmPath ' + (ConvertTo-TaskArgument $pnpm)
  '-OrcaPath ' + (ConvertTo-TaskArgument $orca)
) -join ' '

$taskAction = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

$task = New-ScheduledTask `
  -Action $taskAction `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description 'Keeps the Codex-only Linear-to-draft-PR controller alive independently of the ChatGPT desktop app.'

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existing -and $existing.State -eq 'Running') {
  Stop-ScheduledTask -TaskName $TaskName
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running' -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
}
Close-ControllerProcess $repository
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output "installed-and-started: $TaskName"
Write-Output "repository: $repository"
Write-Output "supervisor: $supervisor"
