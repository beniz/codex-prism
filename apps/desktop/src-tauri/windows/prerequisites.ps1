# Windows PowerShell 5.1. WinGet verifies manifest hashes for MiKTeX/Codex;
# Ghostscript is pinned and verified explicitly before execution.
[CmdletBinding()]
param([switch]$CheckOnly, [switch]$SkipGhostscript)
$ErrorActionPreference = 'Stop'

function Update-ToolPath {
    $paths = @($env:PATH, [Environment]::GetEnvironmentVariable('Path', 'User'),
        [Environment]::GetEnvironmentVariable('Path', 'Machine'),
        "$env:LOCALAPPDATA\Programs\MiKTeX\miktex\bin\x64",
        "$env:LOCALAPPDATA\Microsoft\WinGet\Links",
        "$env:ProgramFiles\MiKTeX\miktex\bin\x64")
    $paths += @(Get-ChildItem "$env:ProgramFiles\gs\*\bin" -Directory -ErrorAction SilentlyContinue | Sort-Object FullName | ForEach-Object FullName)
    $paths += @(Get-ChildItem "${env:ProgramFiles(x86)}\gs\*\bin" -Directory -ErrorAction SilentlyContinue | Sort-Object FullName | ForEach-Object FullName)
    $paths += @(Get-ChildItem 'C:\texlive\*\bin\windows' -Directory -ErrorAction SilentlyContinue | Sort-Object FullName | ForEach-Object FullName)
    $env:PATH = ($paths | Where-Object { $_ }) -join ';'
}

function Find-Tool([string]$Name) {
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
}

function Test-TexEngine([string]$Name) {
    $path = Find-Tool $Name
    if (!$path) { return $false }
    $process = New-Object Diagnostics.Process
    $process.StartInfo.FileName = $path
    $process.StartInfo.Arguments = '--version'
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit(10000)) { $process.Kill(); return $false }
        return $process.ExitCode -eq 0
    } catch { return $false }
    finally { $process.Dispose() }
}

function Get-UsableTexEngines {
    $script:TexDirectory = $null
    foreach ($directory in ($env:PATH -split ';' | Where-Object { $_ } | Select-Object -Unique)) {
        $directory = $directory.Trim('"')
        $engines = @(@('pdflatex.exe', 'xelatex.exe', 'lualatex.exe') | Where-Object {
            Test-TexEngine (Join-Path $directory $_)
        })
        if ($engines.Count -gt 0) {
            $script:TexDirectory = $directory
            return $engines
        }
    }
}

function Find-TexTool([string]$Name) {
    if ($script:TexDirectory) { Find-Tool (Join-Path $script:TexDirectory $Name) }
}

function Find-Ghostscript {
    foreach ($name in @('gswin64c.exe', 'gswin32c.exe', 'gs.exe')) {
        $path = Find-Tool $name
        if ($path) { return $path }
    }
}

function Get-DownloadSha256([string]$Path) {
    # Use .NET directly: installer-launched Windows PowerShell may not expose
    # the Get-FileHash function through its inherited module search path.
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    if (!$Program) { throw 'A required prerequisite executable was not found.' }
    # Windows PowerShell treats native stderr as ErrorRecord objects. Preserve
    # diagnostic output and judge native programs by their exit code.
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $Program @Arguments 2>&1 | ForEach-Object { Write-Host "$_" }
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($exitCode -ne 0) { throw "$Program failed with exit code $exitCode" }
}

function Install-WinGetPackage([string]$Id) {
    $winget = Find-Tool 'winget.exe'
    if (!$winget) { throw 'Windows App Installer (winget) is required for prerequisite downloads. Install App Installer from Microsoft, then rerun setup.' }
    Write-Host "Installing $Id..."
    Invoke-Checked $winget @('install', '--id', $Id, '--exact', '--source', 'winget',
        '--scope', 'user', '--silent', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity')
    Update-ToolPath
}

function Install-Prerequisites {
    Update-ToolPath
    $engines = @(Get-UsableTexEngines)
    $codex = Find-Tool 'codex.exe'
    if (!$codex) { $codex = Find-Tool 'codex.cmd' }
    $ghostscript = Find-Ghostscript
    if ($codex) { Write-Host "Codex: FOUND - $codex" }
    else { Write-Host 'Codex: NOT FOUND' }
    if ($engines.Count -gt 0) { Write-Host "LaTeX: FOUND - $($engines -join ', ') in $script:TexDirectory" }
    else { Write-Host 'LaTeX: NOT FOUND - no usable compiler detected.' }
    if ($ghostscript) { Write-Host "PDF tools (Ghostscript): FOUND - $ghostscript" }
    elseif ($CheckOnly -or $SkipGhostscript) { Write-Host 'PDF tools (Ghostscript): NOT FOUND - optional setup skipped; Original PDF export is available.' }
    else { Write-Host 'PDF tools (Ghostscript): NOT FOUND - setup will offer the optional Ghostscript wizard.' }
    if (!$CheckOnly) {
        if ($engines.Count -eq 0) {
            Install-WinGetPackage 'MiKTeX.MiKTeX'
            $miktex = Find-Tool 'miktex.exe'
            if (!$miktex) { throw 'MiKTeX installation did not provide miktex.exe.' }
            # Only configure the MiKTeX installation just created by this setup.
            Invoke-Checked (Find-Tool 'initexmf.exe') @('--set-config-value=[MPM]AutoInstall=1')
            Invoke-Checked $miktex @('packages', 'update-package-database')
            # The basic installer already includes some of these. `install`
            # rejects installed packages; `require` installs only missing ones.
            Invoke-Checked $miktex @('packages', 'require', 'biber-windows-x64', 'biblatex', 'latexmk',
                'pgf', 'booktabs', 'hyperref', 'fontspec', 'amsmath', 'geometry', 'xcolor', 'lm')
            $engines = @(Get-UsableTexEngines)
        }
        if (!(Find-Tool 'codex.exe') -and !(Find-Tool 'codex.cmd')) {
            Install-WinGetPackage 'OpenAI.Codex'
        }
        if (!(Find-Ghostscript) -and !$SkipGhostscript) {
            $download = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString() + '.exe')
            try {
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                Write-Host 'Downloading Ghostscript 10.08.0 for PDF export...'
                Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs10080/gs10080w64.exe' -OutFile $download
                if ((Get-DownloadSha256 $download) -ne '52a91b8bf09298788d7a57b9206127026c23eacd75405f0a131e26dc381dce50') {
                    throw 'Ghostscript checksum verification failed.'
                }
                # Artifex explicitly disables silent mode. Show its license/setup
                # wizard and wait for completion; hiding it would hang setup.
                Write-Host 'Complete the Ghostscript setup wizard to continue.'
                $process = Start-Process -FilePath $download -PassThru -Wait
                if ($process.ExitCode -notin @(0, 3010)) { throw "Ghostscript setup failed: $($process.ExitCode)" }
            } catch {
                Write-Warning "Optional Ghostscript setup was not completed: $_. Original PDF export remains available. Rerun setup interactively to retry optimized export setup."
            } finally {
                Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
            }
            Update-ToolPath
        }
    }
    if ($engines.Count -eq 0) { throw 'No usable LaTeX compiler found. Repair your TeX installation or rerun setup to install MiKTeX.' }
    Write-Host "LaTeX: READY - $($engines -join ', ') in $script:TexDirectory"
    $missing = @(@('pdflatex.exe', 'xelatex.exe', 'lualatex.exe') | Where-Object { $engines -notcontains $_ })
    $missing += @('bibtex.exe', 'biber.exe') |
        Where-Object { !(Find-TexTool $_) }
    if ($missing) { Write-Warning "Some LaTeX tools are unavailable: $($missing -join ', '). Documents that use them require completing your existing TeX installation. Documents use pdflatex by default; select an available alternative with a % !TEX program comment." }
    $codex = Find-Tool 'codex.exe'
    if (!$codex) { $codex = Find-Tool 'codex.cmd' }
    if (!$codex) { throw 'Codex CLI is missing.' }
    Write-Host "Codex: READY - $codex"
    $ghostscript = Find-Ghostscript
    if ($ghostscript) { Write-Host "PDF tools (Ghostscript): READY - $ghostscript" }
    else { Write-Warning 'PDF tools (Ghostscript): UNAVAILABLE - Original PDF export works; rerun setup interactively to enable optimized PDF export.' }
}

if ($MyInvocation.InvocationName -ne '.') {
    $logDir = Join-Path $env:LOCALAPPDATA 'codex-prism'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    Start-Transcript -Path (Join-Path $logDir 'installer.log') -Append | Out-Null
    try { Install-Prerequisites; exit 0 }
    catch { Write-Host "ERROR: $_"; exit 1 }
    finally { Stop-Transcript | Out-Null }
}
