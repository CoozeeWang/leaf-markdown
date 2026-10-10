; Compile-only synthetic fixture. Hook functions are intentionally never called.
; Validates the real include order used by Tauri without installing Leaf.
Unicode true
Name "Leaf synthetic NSIS compilation check"
OutFile "${__FILEDIR__}\..\test-results\windows-i18n-hooks.exe"
!include MUI2.nsh
!include LogicLib.nsh
!define MAINBINARYNAME "leaf"
!include "${__FILEDIR__}\..\src-tauri\windows-hooks.nsh"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "TradChinese"
Function CheckPostInstallSyntax
  !insertmacro NSIS_HOOK_POSTINSTALL
FunctionEnd
Function CheckPreUninstallSyntax
  !insertmacro NSIS_HOOK_PREUNINSTALL
FunctionEnd
Section
  ; No installation, file writes or registry changes.
SectionEnd
