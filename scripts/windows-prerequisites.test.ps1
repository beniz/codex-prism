# Isolated prerequisite decision tests; never download or install real tools.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\apps\desktop\src-tauri\windows\prerequisites.ps1"
function Assert($Condition, $Message) { if (!$Condition) { throw $Message } }
$engineProbe = ${function:Test-TexEngine}
# Exercise actual directory selection before mocking installation decisions.
function Test-TexEngine([string]$Name) { return $Name -eq 'C:\fixture first\xelatex.exe' -or $Name -eq 'C:\fixture second\pdflatex.exe' }
$originalPath = $env:PATH
try {
    $env:PATH = 'C:\fixture broken;"C:\fixture first";C:\fixture second'
    $selected = @(Get-UsableTexEngines)
    Assert ($script:TexDirectory -eq 'C:\fixture first') 'Select the first usable directory, skipping broken tools and handling quoted paths'
    Assert (($selected -join ',') -eq 'xelatex.exe') 'Do not mix engines from different installations'
} finally {
    $env:PATH = $originalPath
    ${function:Test-TexEngine} = $engineProbe
}
$hashFixture = [IO.Path]::GetTempFileName()
try {
    [IO.File]::WriteAllBytes($hashFixture, [Text.Encoding]::ASCII.GetBytes('abc'))
    Assert ((Get-DownloadSha256 $hashFixture) -eq 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') 'SHA-256 must work without Get-FileHash'
} finally { Remove-Item -LiteralPath $hashFixture -Force }
Invoke-Checked $env:ComSpec @('/d', '/c', 'echo benign diagnostic 1>&2')
$failed = $false
try { Invoke-Checked $env:ComSpec @('/d', '/c', 'exit 7') } catch { $failed = $_ -match 'exit code 7' }
Assert $failed 'Native command failures must be checked independently of stderr'
function Update-ToolPath { }
function Find-Tool([string]$Name) { if ($script:available -contains $Name) { return $Name } }
function Test-TexEngine([string]$Name) { return ($script:available -contains $Name -and $script:unusable -notcontains $Name) }
function Get-UsableTexEngines { @('pdflatex.exe', 'xelatex.exe', 'lualatex.exe') | Where-Object { Test-TexEngine $_ } }
function Find-TexTool([string]$Name) { Find-Tool $Name }
function Install-WinGetPackage([string]$Id) {
    $script:installed += $Id
    if ($script:failInstall) { throw 'Fixture download failure' }
    if ($Id -eq 'MiKTeX.MiKTeX') { $script:available += $script:tex + @('miktex.exe', 'initexmf.exe') }
    if ($Id -eq 'OpenAI.Codex') { $script:available += 'codex.exe' }
}
function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    $script:configured += $Program
    # Match MiKTeX's real response after basic setup: Biber is already present.
    if ($Program -eq 'miktex.exe' -and $Arguments[0] -eq 'packages' -and $Arguments[1] -eq 'install') {
        throw 'biber-windows-x64: package is already installed'
    }
}
$script:tex = @('pdflatex.exe', 'xelatex.exe', 'lualatex.exe', 'bibtex.exe', 'biber.exe')
$script:available = $script:tex + @('codex.cmd', 'gswin64c.exe')
$script:installed = @(); $script:configured = @(); $script:failInstall = $false
$script:unusable = @()
Install-Prerequisites
Assert ($script:installed.Count -eq 0 -and $script:configured.Count -eq 0) 'Existing tools must remain unchanged'

$script:available = @('gswin64c.exe')
Install-Prerequisites
Assert (($script:installed -join ',') -eq 'MiKTeX.MiKTeX,OpenAI.Codex') 'Missing LaTeX and Codex must be installed'
Assert ($script:configured -contains 'initexmf.exe') 'New MiKTeX must enable missing package downloads'

$script:available = @('gswin64c.exe'); $script:installed = @(); $script:failInstall = $true
$failed = $false
try { Install-Prerequisites } catch { $failed = $_ -match 'Fixture download failure' }
Assert $failed 'Failed installation must propagate to NSIS'
Assert ($script:installed.Count -eq 1) 'Stop at the first failed prerequisite'

$script:available = @('pdflatex.exe', 'codex.exe', 'gswin64c.exe'); $script:installed = @(); $script:failInstall = $false
$missingWarnings = @(Install-Prerequisites 3>&1)
Assert ($missingWarnings -match 'Some LaTeX tools are unavailable') 'Missing optional tools must be reported without blocking setup'
Assert ($script:installed.Count -eq 0) 'Do not silently install a competing TeX distribution'

foreach ($engine in @('xelatex.exe', 'lualatex.exe')) {
    $script:available = @($engine, 'codex.exe', 'gswin64c.exe'); $script:installed = @(); $script:configured = @()
    Install-Prerequisites
    Assert ($script:installed.Count -eq 0 -and $script:configured.Count -eq 0) "Reuse $engine even without pdflatex or bibliography tools"
}
$script:available = @('pdflatex.exe', 'codex.exe', 'gswin64c.exe'); $script:installed = @()
$script:unusable = @('pdflatex.exe'); $script:failInstall = $true
$failed = $false
try { Install-Prerequisites } catch { $failed = $_ -match 'Fixture download failure' }
Assert ($failed -and $script:installed -contains 'MiKTeX.MiKTeX') 'A broken compiler must not prevent fallback installation'
$script:unusable = @(); $script:failInstall = $false

$CheckOnly = $true; $script:available = @(); $script:installed = @()
$failed = $false
try { Install-Prerequisites } catch { $failed = $true }
Assert ($failed -and $script:installed.Count -eq 0) 'CheckOnly must never install anything'
$CheckOnly = $false; $script:available = $script:tex + 'codex.exe'; $script:started = $false
function Invoke-WebRequest { }
function Get-DownloadSha256 { return $script:hash }
function Start-Process {
    $script:started = $true
    $script:available += 'gswin64c.exe'
    [pscustomobject]@{ ExitCode = 0 }
}
$script:hash = 'invalid-download'
$warnings = @(Install-Prerequisites 3>&1)
Assert (($warnings -match 'checksum verification failed') -and !$script:started) 'Never execute an unverified optional Ghostscript download'

$script:hash = '52a91b8bf09298788d7a57b9206127026c23eacd75405f0a131e26dc381dce50'
Install-Prerequisites
Assert $script:started 'Verified Ghostscript download must launch the vendor wizard'

$script:available = $script:tex + @('codex.exe', 'gswin32c.exe'); $script:started = $false
Install-Prerequisites
Assert (!$script:started) 'Reuse existing 32-bit Ghostscript'

$script:available = $script:tex + 'codex.exe'; $SkipGhostscript = $true
Install-Prerequisites
Assert (!$script:started) 'Unattended setup must not launch the Ghostscript wizard'
$SkipGhostscript = $false
function Start-Process { throw 'The operation was canceled by the user' }
$warnings = @(Install-Prerequisites 3>&1)
Assert ($warnings -match 'Optional Ghostscript setup was not completed') 'Canceling optional Ghostscript must not abort app setup'
Write-Host 'PASS: 13 prerequisite scenarios and native exit-code handling'
