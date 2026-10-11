!include "${__FILEDIR__}\windows-locales.nsh"

# Keep the previous per-user file class across repeated installations. Tauri's
# APP_ASSOCIATE writes a new backup every time, including Leaf itself on reinstall.
Var LeafPreviousMd
Var LeafPreviousMarkdown
Var LeafPreviousMdown
!macro LEAF_CAPTURE_ASSOCIATION EXT VAR
  ReadRegStr ${VAR} HKCU "Software\Classes\.${EXT}" ""
  ${If} ${VAR} == "Markdown document"
    ReadRegStr ${VAR} HKCU "Software\Classes\.${EXT}" "Markdown document_backup"
    ; An older reinstall may already have replaced its backup with Leaf itself.
    ${If} ${VAR} == "Markdown document"
      StrCpy ${VAR} ""
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro LEAF_CAPTURE_ASSOCIATION "md" $LeafPreviousMd
  !insertmacro LEAF_CAPTURE_ASSOCIATION "markdown" $LeafPreviousMarkdown
  !insertmacro LEAF_CAPTURE_ASSOCIATION "mdown" $LeafPreviousMdown
!macroend

; Per-user folder context actions. Do not modify Windows' UserChoice keys.
!macro NSIS_HOOK_POSTINSTALL
  ; Restore the saved previous class after Tauri registers Leaf's file class.
  WriteRegStr HKCU "Software\Classes\.md" "Markdown document_backup" "$LeafPreviousMd"
  WriteRegStr HKCU "Software\Classes\.markdown" "Markdown document_backup" "$LeafPreviousMarkdown"
  WriteRegStr HKCU "Software\Classes\.mdown" "Markdown document_backup" "$LeafPreviousMdown"
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
  ReadRegStr $R0 HKCU "Software\Classes\Directory\shell\Leaf.NewMarkdown\command" ""
  ${If} $R0 == '"$INSTDIR\${MAINBINARYNAME}.exe" --new-in "%1\."'
    DeleteRegKey HKCU "Software\Classes\Directory\shell\Leaf.NewMarkdown"
  ${EndIf}
  ReadRegStr $R0 HKCU "Software\Classes\Directory\Background\shell\Leaf.NewMarkdown\command" ""
  ${If} $R0 == '"$INSTDIR\${MAINBINARYNAME}.exe" --new-in "%V\."'
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Leaf.NewMarkdown"
  ${EndIf}
!macroend
