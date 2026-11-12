# Disposable CI tools, used only for the initial installer prerequisite detection.
param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Requires a disposable GitHub Actions runner' }
$tools = Join-Path $Root 'tools'
New-Item -ItemType Directory -Path $tools -Force | Out-Null
Add-Type -TypeDefinition 'public class ToolFixture { public static int Main(string[] args) { System.Console.WriteLine("CI tool fixture"); return 0; } }' -Language CSharp -OutputAssembly "$tools\pdflatex.exe" -OutputType ConsoleApplication
Copy-Item "$tools\pdflatex.exe" "$tools\codex.exe"
