; Install prerequisites before copying the app. A failed dependency must not be
; reported as a successful installation. Run as the installing user, not SYSTEM.
!define PRISM_PREREQUISITES "${__FILEDIR__}\prerequisites.ps1"
!macro NSIS_HOOK_PREINSTALL
  InitPluginsDir
  File /oname=$PLUGINSDIR\prerequisites.ps1 "${PRISM_PREREQUISITES}"
  DetailPrint "Checking Codex, LaTeX and PDF tools (downloads may take several minutes)..."
  StrCpy $1 ""
  ${If} ${Silent}
    StrCpy $1 "-SkipGhostscript"
  ${EndIf}
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\prerequisites.ps1" $1'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Prerequisite setup failed. See the installer details and %LOCALAPPDATA%\codex-prism\installer.log. Check your Internet connection and rerun setup." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend
