$ErrorActionPreference = "Continue"
Write-Host "ai-dev worker: npm ci"
npm ci

Get-Content -Raw 'H:\Code\ai-dev-controller\data\workers\ac6c3c42-c3a9-4d81-87c7-9419c94ef9f5\ink-affordability\prompt.txt' | codex exec --profile gpt-luna-high --sandbox workspace-write -c 'windows.sandbox="unelevated"' --skip-git-repo-check --output-last-message 'H:\Code\ai-dev-controller\data\workers\ac6c3c42-c3a9-4d81-87c7-9419c94ef9f5\ink-affordability\result.txt' -
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }
Set-Content -Path 'H:\Code\ai-dev-controller\data\workers\ac6c3c42-c3a9-4d81-87c7-9419c94ef9f5\ink-affordability\exit.txt' -Value $code -Encoding ascii
Write-Host "ai-dev worker finished with exit $code"
