[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RepositoryPath,

  [Parameter(Mandatory = $true)]
  [string]$PnpmPath,

  [Parameter(Mandatory = $true)]
  [string]$OrcaPath,

  [ValidateRange(5, 3600)]
  [int]$RestartDelaySeconds = 15,

  [ValidateRange(15, 600)]
  [int]$OrcaCheckSeconds = 30
)

$ErrorActionPreference = 'Stop'

$repository = (Resolve-Path -LiteralPath $RepositoryPath).Path
if (-not (Test-Path -LiteralPath $PnpmPath -PathType Leaf)) {
  throw "pnpm.cmd was not found at '$PnpmPath'."
}
if (-not (Test-Path -LiteralPath $OrcaPath -PathType Leaf)) {
  throw "Orca CLI was not found at '$OrcaPath'."
}

$dataDirectory = Join-Path $repository 'data'
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
$supervisorLog = Join-Path $dataDirectory 'controller-supervisor.log'

function Test-OrcaRuntime {
  try {
    $raw = & $OrcaPath status --json 2>$null | Out-String
    $status = $raw | ConvertFrom-Json -ErrorAction Stop
    return $status.ok -eq $true -and $status.result.runtime.reachable -eq $true
  }
  catch {
    return $false
  }
}

function Invoke-OrcaRuntimeRecovery {
  if (Test-OrcaRuntime) {
    return
  }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdout = Join-Path $dataDirectory "orca-open-$stamp.stdout.log"
  $stderr = Join-Path $dataDirectory "orca-open-$stamp.stderr.log"
  Add-Content -LiteralPath $supervisorLog -Value "$(Get-Date -Format o) Orca unreachable; starting runtime"
  try {
    $open = Start-Process `
      -FilePath $OrcaPath `
      -ArgumentList @('open', '--json') `
      -WorkingDirectory $repository `
      -RedirectStandardOutput $stdout `
      -RedirectStandardError $stderr `
      -WindowStyle Hidden `
      -PassThru
    if (-not $open.WaitForExit(30000)) {
      Add-Content -LiteralPath $supervisorLog -Value "$(Get-Date -Format o) Orca open still running after 30s; health check will retry"
    }
  }
  catch {
    Add-Content -LiteralPath $supervisorLog -Value "$(Get-Date -Format o) Orca launch failure: $($_.Exception.Message)"
  }
}

# A scheduled-task retry can overlap a process that is still shutting down.
# Keep exactly one supervisor per repository without depending on a PID file.
$pathBytes = [Text.Encoding]::UTF8.GetBytes($repository.ToLowerInvariant())
$hashBytes = [Security.Cryptography.SHA256]::HashData($pathBytes)
$suffix = [Convert]::ToHexString($hashBytes).Substring(0, 16)
$mutexName = "Local\AiDevControllerSupervisor-$suffix"
$created = $false
$mutex = [Threading.Mutex]::new($true, $mutexName, [ref]$created)

if (-not $created) {
  Add-Content -LiteralPath $supervisorLog -Value "$(Get-Date -Format o) duplicate supervisor refused ($mutexName)"
  $mutex.Dispose()
  exit 0
}

try {
  Add-Content -LiteralPath $supervisorLog -Value "$(Get-Date -Format o) supervisor started pid=$PID repository=$repository"

  while ($true) {
    Invoke-OrcaRuntimeRecovery
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $controllerStdout = Join-Path $dataDirectory "controller-supervised-$stamp.stdout.log"
    $controllerStderr = Join-Path $dataDirectory "controller-supervised-$stamp.stderr.log"

    $exitCode = 1
    try {
      # Keep controller pipes outside the supervisor console. A killed child or
      # conhost must not poison the next CreateProcess call.
      $child = Start-Process `
        -FilePath $PnpmPath `
        -ArgumentList @('cli', 'run') `
        -WorkingDirectory $repository `
        -RedirectStandardOutput $controllerStdout `
        -RedirectStandardError $controllerStderr `
        -WindowStyle Hidden `
        -PassThru
      Add-Content -LiteralPath $supervisorLog -Value "$(Get-Date -Format o) started controller pid=$($child.Id)"
      while (-not $child.WaitForExit($OrcaCheckSeconds * 1000)) {
        Invoke-OrcaRuntimeRecovery
      }
      $exitCode = $child.ExitCode
    }
    catch {
      Add-Content -LiteralPath $supervisorLog -Value "$(Get-Date -Format o) launch/wait failure: $($_.Exception.Message)"
    }

    Add-Content -LiteralPath $supervisorLog -Value "$(Get-Date -Format o) controller exited code=$exitCode; restarting in ${RestartDelaySeconds}s"
    Start-Sleep -Seconds $RestartDelaySeconds
  }
}
finally {
  if ($created) {
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
}
