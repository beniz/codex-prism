# Portable preflight: run with pwsh on Linux/macOS or PowerShell on Windows.
# Parse all Windows scripts and compile the launcher's embedded C# without
# calling any Windows API, modifying the desktop, or starting an installation.
$ErrorActionPreference = 'Stop'
foreach ($file in Get-ChildItem -Path (Join-Path $PSScriptRoot 'windows-*.ps1')) {
    $tokens = $null
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
    if ($file.Name -eq 'windows-updater-launch.ps1') {
        $sources = @($ast.FindAll({ param($node)
            $node -is [Management.Automation.Language.StringConstantExpressionAst] -and
            $node.Value.Contains('public static class UpdaterTestLauncher')
        }, $true))
        if ($sources.Count -ne 1) { throw 'Expected exactly one launcher C# definition' }
        Add-Type -TypeDefinition $sources[0].Value
        # The nested self-test probe is also a script, not just an arbitrary string.
        foreach ($text in $ast.FindAll({ param($node)
            $node -is [Management.Automation.Language.StringConstantExpressionAst] -and
            $node.Value.StartsWith("`$ErrorActionPreference")
        }, $true)) {
            $null = [Management.Automation.Language.Parser]::ParseInput($text.Value, [ref]$tokens, [ref]$parseErrors)
            if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
        }
    }
}
Write-Host 'PASS: Windows scripts parse; launcher C# compiles (native Windows execution not tested)'
