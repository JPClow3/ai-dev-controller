$ErrorActionPreference = "Continue"
Get-Content -Raw 'H:\Code\ai-dev-controller\data\workers\00602fec-a3bb-42d4-b496-996b8b549c82\ink-affordability\prompt.txt' | codex exec --profile gpt-luna-high --sandbox workspace-write --add-dir 'H:/Code/Pessoais/Lorebound/.git' --skip-git-repo-check --output-last-message 'H:\Code\ai-dev-controller\data\workers\00602fec-a3bb-42d4-b496-996b8b549c82\ink-affordability\result.txt' -
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }
Set-Content -Path 'H:\Code\ai-dev-controller\data\workers\00602fec-a3bb-42d4-b496-996b8b549c82\ink-affordability\exit.txt' -Value $code -Encoding ascii
Write-Host "ai-dev worker finished with exit $code"
