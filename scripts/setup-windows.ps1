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
$packageManager = (Get-Content -Raw -LiteralPath (Join-Path $ControllerRoot 'package.json') | ConvertFrom-Json).packageManager
if ($packageManager -notmatch '^pnpm@\d+\.\d+\.\d+$') {
  throw "package.json must pin packageManager to an exact pnpm version; got '$packageManager'"
}
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
  Write-Information ("{0,-4} {1,-22} {2}" -f $label, $Name, $Detail) -InformationAction Continue
  if (-not $Passed) { $script:Failures++ }
}

function Get-ExternalCommand {
  param([string]$Name)

  return Get-Command $Name -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandType -in 'Application', 'ExternalScript' } |
    Select-Object -First 1
}

function Test-NodeVersion {
  $node = Get-ExternalCommand 'node'
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

function Sync-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $allPaths = @($env:Path, $machinePath, $userPath) |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    ForEach-Object { $_ -split ';' } |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    Select-Object -Unique
  $env:Path = $allPaths -join ';'
}

function Install-WingetPackageIfNeeded {
  param(
    [string]$Name,
    [string]$Command,
    [string]$Id,
    [switch]$RequireSearch,
    [int]$MinimumNodeMajor = 0
  )

  $existing = Get-ExternalCommand $Command
  $nodeIsSupported = $true
  if ($MinimumNodeMajor -gt 0 -and $null -ne $existing) {
    $nodeIsSupported = (Test-NodeVersion).Available
  }
  if ($null -ne $existing -and $nodeIsSupported) {
    Write-CheckResult $Name $true $existing.Source
    return $true
  }
  if (-not $Install) {
    $detail = if ($null -eq $existing) {
      "missing; rerun with -Install to install $Id"
    } else {
      "Node is below v$MinimumNodeMajor; rerun with -Install to update $Id"
    }
    Write-CheckResult $Name $false $detail
    return $false
  }

  $winget = Get-ExternalCommand 'winget'
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

  Write-Information "Installing $Name with winget ($Id)..." -InformationAction Continue
  & $winget.Source install --id $Id --exact --accept-package-agreements --accept-source-agreements | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-CheckResult $Name $false "winget install failed for $Id"
    return $false
  }
  Sync-ProcessPath
  $installed = Get-ExternalCommand $Command
  if ($null -eq $installed) {
    Write-CheckResult $Name $false "winget installed $Id, but it is unavailable in this process; open a new terminal and rerun this command"
    return $false
  }
  if ($MinimumNodeMajor -gt 0 -and -not (Test-NodeVersion).Available) {
    Write-CheckResult $Name $false "winget completed, but Node is still below v$MinimumNodeMajor; update Node.js LTS, open a new terminal, and rerun this command"
    return $false
  }
  Write-CheckResult $Name $true "installed $Id at $($installed.Source)"
  return $true
}

function Test-EnvKey {
  param([string]$Key)

  if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($Key))) { return $true }
  $envFile = Join-Path $ControllerRoot '.env'
  if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { return $false }
  return [bool](Select-String -LiteralPath $envFile -Pattern ("^\s*{0}\s*=\s*[^\s#]" -f [regex]::Escape($Key)) -Quiet)
}

function Get-RegistryPathMap {
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
  param([string]$Root, [switch]$Overwrite)

  $registryPath = Join-Path $ControllerRoot 'projects\registry.yaml'
  $localPath = Join-Path $ControllerRoot 'projects\registry.local.yaml'
  if (Test-Path -LiteralPath $localPath -PathType Leaf -and -not $Overwrite) {
    Write-CheckResult 'local registry' $false 'already exists; pass -Force to replace it'
    return
  }

  $sourceRoot = 'H:/Code/'
  $entries = [System.Collections.Generic.List[string]]::new()
  foreach ($project in (Get-RegistryPathMap $registryPath).GetEnumerator() | Sort-Object Key) {
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

  $pnpm = Get-ExternalCommand 'pnpm'
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

Write-Information "Controller root: $ControllerRoot" -InformationAction Continue
$modeText = if ($Install) { 'Mode: install and audit' } else { 'Mode: audit only (no changes)' }
Write-Information $modeText -InformationAction Continue

foreach ($package in $RequiredPackages) {
  $minimumNodeMajor = if ($package.Command -eq 'node') { 24 } else { 0 }
  [void](Install-WingetPackageIfNeeded -Name $package.Name -Command $package.Command -Id $package.Id -MinimumNodeMajor $minimumNodeMajor)
}
$nodeVersion = Test-NodeVersion
Write-CheckResult 'Node.js version' $nodeVersion.Available $nodeVersion.Detail

if ($null -eq (Get-ExternalCommand 'orca')) {
  [void](Install-WingetPackageIfNeeded -Name 'Orca CLI' -Command 'orca' -Id $OrcaWingetId -RequireSearch)
} else {
  Write-CheckResult 'Orca CLI' $true 'available on PATH'
}

if ($nodeVersion.Available) {
  $corepack = Get-ExternalCommand 'corepack'
  if ($Install -and $null -ne $corepack) {
    & $corepack.Source enable | Out-Host
    $corepackEnable = $LASTEXITCODE -eq 0
    if ($corepackEnable) {
      # Keep workstation bootstrap on the same pnpm release as package.json
      # and CI; "latest" makes a frozen lockfile gate depend on install day.
      & $corepack.Source prepare $packageManager --activate | Out-Host
      $corepackEnable = $LASTEXITCODE -eq 0
    }
    $corepackDetail = if ($corepackEnable) { "enabled $packageManager" } else { 'failed to activate pnpm' }
    Write-CheckResult 'Corepack pnpm' $corepackEnable $corepackDetail
  } elseif ($null -eq $corepack) {
    Write-CheckResult 'Corepack' $false 'missing; reinstall Node.js LTS'
  }
}

$pnpm = Get-ExternalCommand 'pnpm'
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
    Write-LocalRegistry ([IO.Path]::GetFullPath($RepositoryRoot)) -Overwrite:$Force
  }

  if ($nodeVersion.Available -and $null -ne (Get-ExternalCommand 'pnpm')) {
    [void](Invoke-ControllerCheck 'pnpm install' @('install'))
    [void](Invoke-ControllerCheck 'pnpm cli migrate' @('cli', 'migrate'))
  } else {
    Write-CheckResult 'pnpm install' $false 'requires Node.js >= v24 and pnpm on PATH; rerun after completing the prerequisite install'
    Write-CheckResult 'pnpm cli migrate' $false 'requires Node.js >= v24 and pnpm on PATH; rerun after completing the prerequisite install'
  }
}

Write-CheckResult 'LINEAR_API_KEY' (Test-EnvKey 'LINEAR_API_KEY') 'required; set it in .env or the environment'

$gh = Get-ExternalCommand 'gh'
if ($null -eq $gh) {
  Write-CheckResult 'GitHub login' $false 'gh is missing; run gh auth login after installation'
} else {
  & $gh.Source auth status 2>&1 | Out-Host
  Write-CheckResult 'GitHub login' ($LASTEXITCODE -eq 0) 'run gh auth login if this check fails'
}

$codex = Get-ExternalCommand 'codex'
if ($null -eq $codex) {
  Write-CheckResult 'Codex login' $false 'codex is missing; run codex login after installation'
} else {
  & $codex.Source login status 2>&1 | Out-Host
  Write-CheckResult 'Codex login' ($LASTEXITCODE -eq 0) 'run codex login if this check fails'
}

if ($nodeVersion.Available -and $null -ne (Get-ExternalCommand 'pnpm')) {
  [void](Invoke-ControllerCheck 'pnpm cli config' @('cli', 'config'))
  [void](Invoke-ControllerCheck 'pnpm cli doctor' @('cli', 'doctor'))
} elseif ($null -ne (Get-ExternalCommand 'pnpm')) {
  Write-CheckResult 'pnpm cli config' $false 'requires Node.js >= v24'
  Write-CheckResult 'pnpm cli doctor' $false 'requires Node.js >= v24'
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
  Write-Information "Readiness audit failed with $script:Failures finding(s)." -InformationAction Continue
  exit 1
}
Write-Information 'Readiness audit passed.' -InformationAction Continue
