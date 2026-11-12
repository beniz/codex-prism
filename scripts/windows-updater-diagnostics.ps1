# Allowlisted diagnostics only: never export the environment or signing keys.
param([Parameter(Mandatory=$true)][string]$State, [Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Requires a disposable GitHub Actions runner' }
$binary = Get-Item -LiteralPath $Executable -ErrorAction SilentlyContinue
$processes = @(Get-Process | Where-Object { $_.ProcessName -match 'codex-prism|nsis|explorer|powershell' } | Select-Object Id, ProcessName, SessionId)
@{
    installedVersion = if ($binary) { $binary.VersionInfo.ProductVersion } else { $null }
    processes = $processes
    installing = Test-Path (Join-Path $State 'installing')
} | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $State 'windows-diagnostics.json')
$prerequisites = Join-Path $env:LOCALAPPDATA 'codex-prism/installer.log'
if (Test-Path $prerequisites) { Copy-Item -LiteralPath $prerequisites -Destination (Join-Path $State 'installer.log') }
