$ErrorActionPreference = "Continue"
$heartbeatPath = 'H:\Code\ai-dev-controller\data\workers\fcd354be-457e-47ad-9c7d-ce888ba5dd7e\ink-shortfall-helper\heartbeat.txt'
Set-Content -Path $heartbeatPath -Value ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) -Encoding ascii
$heartbeatJob = Start-Job -ScriptBlock {
  param($path)
  while ($true) {
    Set-Content -Path $path -Value ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) -Encoding ascii
    Start-Sleep -Seconds 10
  }
} -ArgumentList $heartbeatPath
Write-Host "ai-dev worker: npm ci"
npm ci

Get-Content -Raw 'H:\Code\ai-dev-controller\data\workers\fcd354be-457e-47ad-9c7d-ce888ba5dd7e\ink-shortfall-helper\prompt.txt' | codex exec --profile gpt-luna-high --sandbox workspace-write -c 'windows.sandbox="unelevated"' --skip-git-repo-check --output-last-message 'H:\Code\ai-dev-controller\data\workers\fcd354be-457e-47ad-9c7d-ce888ba5dd7e\ink-shortfall-helper\result.txt' -
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }
Stop-Job -Job $heartbeatJob -ErrorAction SilentlyContinue
Remove-Job -Job $heartbeatJob -Force -ErrorAction SilentlyContinue
Set-Content -Path 'H:\Code\ai-dev-controller\data\workers\fcd354be-457e-47ad-9c7d-ce888ba5dd7e\ink-shortfall-helper\exit.txt' -Value $code -Encoding ascii
Write-Host "ai-dev worker finished with exit $code"
