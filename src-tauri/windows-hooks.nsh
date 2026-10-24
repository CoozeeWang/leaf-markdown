!include "${__FILEDIR__}\windows-locales.nsh"
!include "${__FILEDIR__}\windows-adapter-upgrade.nsh"

LangString LeafLegacyUpdaterBusy 1033 "Cannot remove the previous Leaf update helper. Quit Leaf normally and retry. Only the registered installation folder can be cleaned; documents and settings are kept."
LangString LeafLegacyUpdaterBusy 2052 "无法移除旧版 Leaf 更新助手。请正常退出 Leaf 后重试。只清理已登记的安装目录，文档和设置会保留。"
LangString LeafLegacyUpdaterBusy 1028 "無法移除舊版 Leaf 更新助手。請正常結束 Leaf 後重試。只清理已登記的安裝目錄，文件與設定會保留。"

!macro NSIS_HOOK_PREINSTALL
  Push $0
  Push $1
  ; Tauri upgrades leave files no longer listed as sidecars. Remove only this
  ; retired product file in the exact registered per-user installation, and
  ; fail before payload replacement if it is occupied or the owner differs.
  IfFileExists "$INSTDIR\leaf-update-helper.exe" 0 leaf_legacy_done
  ReadRegStr $0 HKCU "Software\leaf\Leaf" ""
  StrCmp $0 "" leaf_legacy_failed
  GetFullPathName $0 "$0"
  GetFullPathName $1 "$INSTDIR"
  StrCmp $0 $1 0 leaf_legacy_failed
  ClearErrors
  Delete "$INSTDIR\leaf-update-helper.exe"
  IfErrors leaf_legacy_failed
  IfFileExists "$INSTDIR\leaf-update-helper.exe" leaf_legacy_failed leaf_legacy_done
  leaf_legacy_failed:
    Pop $1
    Pop $0
    IfSilent +2
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(LeafLegacyUpdaterBusy)"
    Abort
  leaf_legacy_done:
  Pop $1
  Pop $0
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
