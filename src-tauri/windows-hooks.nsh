; Per-user folder context actions. Do not modify Windows' UserChoice keys.
!macro NSIS_HOOK_POSTINSTALL
  ; Tauri has already registered Leaf's Markdown class. Replace only its icon.
  WriteRegStr HKCU "Software\Classes\Markdown document\DefaultIcon" "" '"$INSTDIR\document-icon.ico",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\Leaf.NewMarkdown" "" "使用 Leaf 新建 Markdown 文档"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Leaf.NewMarkdown" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\Leaf.NewMarkdown\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" --new-in "%1\."'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Leaf.NewMarkdown" "" "使用 Leaf 新建 Markdown 文档"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Leaf.NewMarkdown" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Leaf.NewMarkdown\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" --new-in "%V\."'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ReadRegStr $R0 HKCU "Software\Classes\Directory\shell\Leaf.NewMarkdown\command" ""
  ${If} $R0 == '"$INSTDIR\${MAINBINARYNAME}.exe" --new-in "%1\."'
    DeleteRegKey HKCU "Software\Classes\Directory\shell\Leaf.NewMarkdown"
  ${EndIf}
  ReadRegStr $R0 HKCU "Software\Classes\Directory\Background\shell\Leaf.NewMarkdown\command" ""
  ${If} $R0 == '"$INSTDIR\${MAINBINARYNAME}.exe" --new-in "%V\."'
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Leaf.NewMarkdown"
  ${EndIf}
!macroend
