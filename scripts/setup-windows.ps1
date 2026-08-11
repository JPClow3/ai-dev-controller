<#
.SYNOPSIS
Audits or installs the Windows prerequisites for ai-dev-controller.

.DESCRIPTION
Run with no arguments to audit a notebook without changing it.  Pass -Install
to install missing command-line prerequisites and provision local controller
files.  Pass -InstallSupervisor separately to register the optional
current-user supervisor task.

.EXAMPLE
.\scripts\setup-windows.ps1

.EXAMPLE
.\scripts\setup-windows.ps1 -Install -RepositoryRoot C:\Code

.EXAMPLE
.\scripts\setup-windows.ps1 -Install -RepositoryRoot C:\Code -InstallSupervisor
#>
[CmdletBinding()]
param(
  [switch]$Install,
  [string]$RepositoryRoot,
  [switch]$InstallSupervisor,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$script:Failures = 0
$ControllerRoot = Split-Path -Parent $PSScriptRoot
$RequiredPackages = @(
  @{ Name = 'Node.js LTS'; Command = 'node'; Id = 'OpenJS.NodeJS.LTS' },
  @{ Name = 'Git'; Command = 'git'; Id = 'Git.Git' },
  @{ Name = 'GitHub CLI'; Command = 'gh'; Id = 'GitHub.cli' },
  @{ Name = 'Codex CLI'; Command = 'codex'; Id = 'OpenAI.Codex' }
)
$OrcaWingetId = 'Orca.Orca'

function Write-CheckResult {
  param(
    [string]$Name,
    [bool]$Passed,
    [string]$Detail
  )

  $label = if ($Passed) { 'PASS' } else { 'FAIL' }
  $color = if ($Passed) { 'Green' } else { 'Red' }
  Write-Host ("{0,-4} {1,-22} {2}" -f $label, $Name, $Detail) -ForegroundColor $color
  if (-not $Passed) { $script:Failures++ }
}

function Find-Command {
  param([string]$Name)

  return Get-Command $Name -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandType -in 'Application', 'ExternalScript' } |
    Select-Object -First 1
}

function Test-NodeVersion {
  $node = Find-Command 'node'
  if ($null -eq $node) {
    return @{ Available = $false; Detail = 'node is not on PATH' }
  }

  try {
    $versionText = (& $node.Source --version).Trim()
    $version = [version]($versionText.TrimStart('v'))
    if ($version.Major -ge 24) {
      return @{ Available = $true; Detail = "$versionText (requires >= v24)" }
    }
    return @{ Available = $false; Detail = "$versionText is too old; requires >= v24" }
  } catch {
    return @{ Available = $false; Detail = "could not determine Node version: $($_.Exception.Message)" }
  }
}

function Ensure-WingetPackage {
  param(
    [string]$Name,
    [string]$Command,
    [string]$Id,
  [switch]$RequireSearch
  )

  $existing = Find-Command $Command
  if ($null -ne $existing) {
    Write-CheckResult $Name $true $existing.Source
    return $true
  }
  if (-not $Install) {
    Write-CheckResult $Name $false "missing; rerun with -Install to install $Id"
    return $false
  }

  $winget = Find-Command 'winget'
  if ($null -eq $winget) {
    Write-CheckResult $Name $false 'missing and winget is unavailable'
    return $false
  }

  if ($RequireSearch) {
    & $winget.Source search --id $Id --exact | Out-Host
    if ($LASTEXITCODE -ne 0) {
      Write-CheckResult $Name $false "winget package is unavailable: $Id"
      return $false
    }
  }

  Write-Host "Installing $Name with winget ($Id)..."
  & $winget.Source install --id $Id --exact --accept-package-agreements --accept-source-agreements | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-CheckResult $Name $false "winget install failed for $Id"
    return $false
  }
  Write-CheckResult $Name $true "installed $Id; open a new terminal if it is not yet on PATH"
  return $true
}

function Test-EnvKey {
  param([string]$Key)

  if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($Key))) { return $true }
  $envFile = Join-Path $ControllerRoot '.env'
  if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { return $false }
  return [bool](Select-String -LiteralPath $envFile -Pattern ("^\s*{0}\s*=\s*[^\s#]" -f [regex]::Escape($Key)) -Quiet)
}

function Get-RegistryPaths {
  param([string]$RegistryPath)

  $paths = @{}
  $projectId = $null
  foreach ($line in Get-Content -LiteralPath $RegistryPath) {
    if ($line -match '^  ([A-Za-z0-9-]+):\s*$') {
      $projectId = $Matches[1]
      continue
    }
    if ($null -ne $projectId -and $line -match '^      path:\s*(.+?)\s*$') {
      $paths[$projectId] = $Matches[1].Trim('"', "'")
    }
  }
  return $paths
}

function Write-LocalRegistry {
  param([string]$Root)

  $registryPath = Join-Path $ControllerRoot 'projects\registry.yaml'
  $localPath = Join-Path $ControllerRoot 'projects\registry.local.yaml'
  if (Test-Path -LiteralPath $localPath -PathType Leaf -and -not $Force) {
    Write-CheckResult 'local registry' $false 'already exists; pass -Force to replace it'
    return
  }

  $sourceRoot = 'H:/Code/'
  $entries = [System.Collections.Generic.List[string]]::new()
  foreach ($project in (Get-RegistryPaths $registryPath).GetEnumerator() | Sort-Object Key) {
    $sourcePath = ($project.Value -replace '\\', '/')
    if (-not $sourcePath.StartsWith($sourceRoot, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    $suffix = $sourcePath.Substring($sourceRoot.Length).Replace('/', [IO.Path]::DirectorySeparatorChar)
    $candidate = Join-Path $Root $suffix
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { continue }
    $path = ([IO.Path]::GetFullPath($candidate)).Replace('\\', '/')
    $entries.Add("  $($project.Key):")
    $entries.Add('    repository:')
    $entries.Add("      path: $path")
  }

  if ($entries.Count -eq 0) {
    Write-CheckResult 'local registry' $false "no registered repositories exist under $Root"
    return
  }
  @('projects:') + $entries | Set-Content -LiteralPath $localPath -Encoding utf8
  Write-CheckResult 'local registry' $true "wrote $($entries.Count / 3) path-only override(s)"
}

function Invoke-ControllerCheck {
  param([string]$Name, [string[]]$Arguments)

  $pnpm = Find-Command 'pnpm'
  if ($null -eq $pnpm) {
    Write-CheckResult $Name $false 'pnpm is not on PATH'
    return $false
  }
  Push-Location $ControllerRoot
  try {
    & $pnpm.Source @Arguments | Out-Host
    $passed = $LASTEXITCODE -eq 0
    $detail = if ($passed) { 'completed' } else { "exit $LASTEXITCODE" }
    Write-CheckResult $Name $passed $detail
    return $passed
  } finally {
    Pop-Location
  }
}

if ($RepositoryRoot -and -not $Install) {
  Write-CheckResult 'RepositoryRoot' $false 'requires -Install; audit mode never writes local files'
}
if ($InstallSupervisor -and -not $Install) {
  Write-CheckResult 'InstallSupervisor' $false 'requires -Install'
}

Write-Host "Controller root: $ControllerRoot"
$modeText = if ($Install) { 'Mode: install and audit' } else { 'Mode: audit only (no changes)' }
Write-Host $modeText

foreach ($package in $RequiredPackages) {
  [void](Ensure-WingetPackage -Name $package.Name -Command $package.Command -Id $package.Id)
}
$nodeVersion = Test-NodeVersion
Write-CheckResult 'Node.js version' $nodeVersion.Available $nodeVersion.Detail

if ($null -eq (Find-Command 'orca')) {
  [void](Ensure-WingetPackage -Name 'Orca CLI' -Command 'orca' -Id $OrcaWingetId -RequireSearch)
} else {
  Write-CheckResult 'Orca CLI' $true 'available on PATH'
}

if ($nodeVersion.Available) {
  $corepack = Find-Command 'corepack'
  if ($Install -and $null -ne $corepack) {
    & $corepack.Source enable | Out-Host
    $corepackEnable = $LASTEXITCODE -eq 0
    if ($corepackEnable) {
      & $corepack.Source prepare pnpm@latest --activate | Out-Host
      $corepackEnable = $LASTEXITCODE -eq 0
    }
    Write-CheckResult 'Corepack pnpm' $corepackEnable (if ($corepackEnable) { 'enabled pnpm@latest' } else { 'failed to activate pnpm' })
  } elseif ($null -eq $corepack) {
    Write-CheckResult 'Corepack' $false 'missing; reinstall Node.js LTS'
  }
}

$pnpm = Find-Command 'pnpm'
$pnpmDetail = if ($null -ne $pnpm) { $pnpm.Source } else { 'missing; use -Install to activate it through Corepack' }
Write-CheckResult 'pnpm' ($null -ne $pnpm) $pnpmDetail

if ($Install) {
  $envExample = Join-Path $ControllerRoot '.env.example'
  $envFile = Join-Path $ControllerRoot '.env'
  if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    Copy-Item -LiteralPath $envExample -Destination $envFile
    Write-CheckResult '.env' $true 'created from .env.example; add credentials manually'
  } else {
    Write-CheckResult '.env' $true 'existing file preserved'
  }
  if ($RepositoryRoot) {
    Write-LocalRegistry ([IO.Path]::GetFullPath($RepositoryRoot))
  }

  if ($null -ne (Find-Command 'pnpm')) {
    [void](Invoke-ControllerCheck 'pnpm install' @('install'))
    [void](Invoke-ControllerCheck 'pnpm cli migrate' @('cli', 'migrate'))
  }
}

Write-CheckResult 'LINEAR_API_KEY' (Test-EnvKey 'LINEAR_API_KEY') 'required; set it in .env or the environment'

$gh = Find-Command 'gh'
if ($null -eq $gh) {
  Write-CheckResult 'GitHub login' $false 'gh is missing; run gh auth login after installation'
} else {
  & $gh.Source auth status 2>&1 | Out-Host
  Write-CheckResult 'GitHub login' ($LASTEXITCODE -eq 0) 'run gh auth login if this check fails'
}

$codex = Find-Command 'codex'
if ($null -eq $codex) {
  Write-CheckResult 'Codex login' $false 'codex is missing; run codex login after installation'
} else {
  & $codex.Source login status 2>&1 | Out-Host
  Write-CheckResult 'Codex login' ($LASTEXITCODE -eq 0) 'run codex login if this check fails'
}

if ($null -ne (Find-Command 'pnpm')) {
  [void](Invoke-ControllerCheck 'pnpm cli config' @('cli', 'config'))
  [void](Invoke-ControllerCheck 'pnpm cli doctor' @('cli', 'doctor'))
}

if ($InstallSupervisor) {
  if ($script:Failures -eq 0) {
    [void](Invoke-ControllerCheck 'pnpm supervisor:install' @('supervisor:install'))
    [void](Invoke-ControllerCheck 'pnpm supervisor:status' @('supervisor:status'))
  } else {
    Write-CheckResult 'supervisor' $false 'not installed because prerequisite checks failed'
  }
}

if ($script:Failures -gt 0) {
  Write-Host "Readiness audit failed with $script:Failures finding(s)." -ForegroundColor Red
  exit 1
}
Write-Host 'Readiness audit passed.' -ForegroundColor Green
