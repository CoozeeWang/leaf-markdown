; The standard Tauri APP_ASSOCIATE macro overwrites its backup on every
; install, including a reinstall where the current class is Leaf itself.
; Keep the previous class per extension; never edit Explorer UserChoice.
Var LeafPreviousMd
Var LeafPreviousMarkdown
Var LeafPreviousMdown

!macro LeafCaptureAssociation EXT DEST
  ReadRegStr ${DEST} HKCU "Software\Classes\.${EXT}" ""
  ${If} ${DEST} == "Markdown document"
    ReadRegStr ${DEST} HKCU "Software\Classes\.${EXT}" "Markdown document_backup"
    ; A backup already overwritten by an older installer cannot be recovered.
    ${If} ${DEST} == "Markdown document"
      StrCpy ${DEST} ""
    ${EndIf}
  ${EndIf}
!macroend

!macro LeafCaptureAssociations
  !insertmacro LeafCaptureAssociation "md" $LeafPreviousMd
  !insertmacro LeafCaptureAssociation "markdown" $LeafPreviousMarkdown
  !insertmacro LeafCaptureAssociation "mdown" $LeafPreviousMdown
!macroend

!macro LeafRestoreAssociationBackups
  WriteRegStr HKCU "Software\Classes\.md" "Markdown document_backup" "$LeafPreviousMd"
  WriteRegStr HKCU "Software\Classes\.markdown" "Markdown document_backup" "$LeafPreviousMarkdown"
  WriteRegStr HKCU "Software\Classes\.mdown" "Markdown document_backup" "$LeafPreviousMdown"
!macroend
