# Run only on a disposable CI runner: dependency fixtures test the packaged
# NSIS install/uninstall path, not real MiKTeX or Codex provisioning.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This smoke test requires a disposable GitHub Actions runner.' }
$fixtureRoot = Join-Path $env:RUNNER_TEMP 'prism-installer-tools'
$installRoot = Join-Path $env:RUNNER_TEMP 'prism-installed-app'
if (Test-Path $installRoot) { throw 'Smoke-test install directory already exists.' }
New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
Add-Type -TypeDefinition 'public class ToolFixture { public static int Main(string[] args) { System.Console.WriteLine("CI tool fixture"); return 0; } }' -Language CSharp -OutputAssembly "$fixtureRoot\pdflatex.exe" -OutputType ConsoleApplication
Copy-Item "$fixtureRoot\pdflatex.exe" "$fixtureRoot\codex.exe"
$env:PATH = "$fixtureRoot;$env:PATH"
$installer = Get-ChildItem "$PSScriptRoot\..\apps\desktop\src-tauri\target\release\bundle\nsis\*-setup.exe" | Select-Object -First 1
if (!$installer) { throw 'Built installer is missing.' }
# NSIS requires /D last and unquoted, including when the directory has spaces.
$setup = Start-Process -FilePath $installer.FullName -ArgumentList "/S /D=$installRoot" -Wait -PassThru
if ($setup.ExitCode -ne 0) { throw "Packaged setup failed: $($setup.ExitCode)" }
if (!(Test-Path "$installRoot\codex-prism.exe")) { throw 'Installed app executable missing.' }
$uninstaller = Get-ChildItem "$installRoot\*uninstall*.exe" | Select-Object -First 1
if (!$uninstaller) { throw 'Uninstaller missing.' }
$remove = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru
if ($remove.ExitCode -ne 0) { throw "Uninstall failed: $($remove.ExitCode)" }
for ($attempt = 0; $attempt -lt 30 -and (Test-Path "$installRoot\codex-prism.exe"); $attempt++) { Start-Sleep -Seconds 1 }
if (Test-Path "$installRoot\codex-prism.exe") { throw 'Uninstall left the app executable behind.' }
Write-Host 'PASS: packaged silent install and uninstall (dependency fixtures; optional Ghostscript wizard skipped)'
