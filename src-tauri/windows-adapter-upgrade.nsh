; The MCP host owns this console process, so closing leaf.exe does not release
; its executable. Scope shutdown to the exact installation path, never a name.
LangString LeafAdapterBusy 1033 "Leaf's connection program is still in use. Close Claude and WorkBuddy, then choose Retry. Your documents and connection settings will be kept."
LangString LeafAdapterBusy 2052 "Leaf 连接程序仍被占用。请退出 Claude 和 WorkBuddy，然后点重试。文档和连接配置会保留。"
LangString LeafAdapterBusy 1028 "Leaf 連線程式仍被佔用。請結束 Claude 和 WorkBuddy，然後按重試。文件和連線設定會保留。"

Var LeafAdapterShutdownFailed

!macro LeafAdapterShutdownFunction Prefix
Function ${Prefix}LeafStopInstalledAdapter
  System::Store "s"
  StrCpy $LeafAdapterShutdownFailed 0
  GetFullPathName $9 "$INSTDIR\leaf-mcp-adapter.exe"
  IfFileExists "$9" 0 done
  System::Alloc 65536
  Pop $0
  StrCmp $0 0 failed
  System::Call 'kernel32::K32EnumProcesses(p r0, i 65536, *i .r1) i .r2'
  ${If} $2 == 0
  ${OrIf} $1 >= 65536
    System::Free $0
    Goto failed
  ${EndIf}
  StrCpy $3 0
  loop:
    IntCmp $3 $1 finished 0 finished
    IntOp $4 $0 + $3
    System::Call '*$4(i .r5)'
    IntOp $3 $3 + 4
    ; QUERY_LIMITED_INFORMATION | SYNCHRONIZE | TERMINATE. Keep this same
    ; handle for identity, shutdown and wait, avoiding PID reuse races.
    System::Call 'kernel32::OpenProcess(i 0x101001, i 0, i r5) p .r6'
    StrCmp $6 0 loop
    System::Call 'kernel32::QueryFullProcessImageNameW(p r6, i 0, w .r7, *i ${NSIS_MAX_STRLEN}) i .r8'
    ${If} $8 != 0
    ${AndIf} $7 == $9
      System::Call 'kernel32::TerminateProcess(p r6, i 0)'
      System::Call 'kernel32::WaitForSingleObject(p r6, i 5000)'
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r6)'
    Goto loop
  finished:
  System::Free $0
  ; A host may restart its helper, or another program may hold the file.
  ; Check write access before Tauri replaces ANY payload, rather than ignore
  ; a failed copy and leave a mixture of old and new executables.
  Sleep 250
  System::Call 'kernel32::CreateFileW(w r9, i 0x40000000, i 7, p 0, i 3, i 0, p 0) p .r6'
  StrCmp $6 -1 failed
  System::Call 'kernel32::CloseHandle(p r6)'
  Goto done
  failed:
    StrCpy $LeafAdapterShutdownFailed 1
  done:
  System::Store "l"
FunctionEnd
!macroend

!insertmacro LeafAdapterShutdownFunction ""
!insertmacro LeafAdapterShutdownFunction "un."

!macro LeafPrepareAdapterUpgrade Prefix
  leaf_adapter_retry:
  Call ${Prefix}LeafStopInstalledAdapter
  ${If} $LeafAdapterShutdownFailed != 0
    IfSilent leaf_adapter_abort
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(LeafAdapterBusy)" IDRETRY leaf_adapter_retry
    leaf_adapter_abort:
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend
