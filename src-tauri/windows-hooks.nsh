!include "${__FILEDIR__}\windows-locales.nsh"
!include "${__FILEDIR__}\windows-adapter-upgrade.nsh"
!include "${__FILEDIR__}\windows-update-recovery.nsh"

!macro NSIS_HOOK_PREINSTALL
  !insertmacro LeafUpdateBegin
  !insertmacro LeafPrepareAdapterUpgrade ""
!macroend

; Per-user folder context actions. Do not modify Windows' UserChoice keys.
!macro NSIS_HOOK_POSTINSTALL
  ; Preserve an unambiguous executable path even when the install directory or
  ; user name contains spaces. Older Tauri NSIS associations omitted quotes.
  WriteRegStr HKCU "Software\Classes\Markdown document\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  ; Tauri has already registered Leaf's Markdown class. Replace only its icon.
  WriteRegStr HKCU "Software\Classes\Markdown document\DefaultIcon" "" '"$INSTDIR\document-icon.ico",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\Leaf.NewMarkdown" "" "$(LeafNewMarkdown)"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Leaf.NewMarkdown" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\Leaf.NewMarkdown\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" --new-in "%1\."'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Leaf.NewMarkdown" "" "$(LeafNewMarkdown)"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Leaf.NewMarkdown" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Leaf.NewMarkdown\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" --new-in "%V\."'
  !insertmacro LeafUpdateComplete
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro LeafPrepareAdapterUpgrade "un."
  ReadRegStr $R0 HKCU "Software\Classes\Directory\shell\Leaf.NewMarkdown\command" ""
  ${If} $R0 == '"$INSTDIR\${MAINBINARYNAME}.exe" --new-in "%1\."'
    DeleteRegKey HKCU "Software\Classes\Directory\shell\Leaf.NewMarkdown"
  ${EndIf}
  ReadRegStr $R0 HKCU "Software\Classes\Directory\Background\shell\Leaf.NewMarkdown\command" ""
  ${If} $R0 == '"$INSTDIR\${MAINBINARYNAME}.exe" --new-in "%V\."'
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Leaf.NewMarkdown"
  ${EndIf}
!macroend
