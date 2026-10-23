; An external, authenticated supervisor creates the backup before starting NSIS.
; Ordinary manual installations do not enter the transaction protocol.
!include "FileFunc.nsh"
Var LeafInstallTransaction

!macro LeafUpdateBegin
  StrCpy $LeafInstallTransaction ""
  ${GetOptions} $CMDLINE "/LEAFTRANSACTION=" $LeafInstallTransaction
  ${If} $LeafInstallTransaction != ""
    IfFileExists "$LeafInstallTransaction\backup-ready" +3 0
      SetErrorLevel 42
      Quit
    IfFileExists "$LeafInstallTransaction\commit-authorized" +3 0
      SetErrorLevel 42
      Quit
    ClearErrors
    FileOpen $R0 "$LeafInstallTransaction\installer-mutating" w
    FileWrite $R0 "payload-and-registration"
    FileClose $R0
    ${If} ${Errors}
      SetErrorLevel 42
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro LeafUpdateComplete
  ${If} $LeafInstallTransaction != ""
    ClearErrors
    FileOpen $R0 "$LeafInstallTransaction\transaction-id" r
    FileRead $R0 $R1
    FileClose $R0
    FileOpen $R0 "$LeafInstallTransaction\installer-complete" w
    FileWrite $R0 $R1
    FileClose $R0
    ${If} ${Errors}
      SetErrorLevel 43
      Quit
    ${EndIf}
  ${EndIf}
!macroend

; Only the disposable test installer defines this symbol. Release NSIS packages
; cannot be fault-injected through an environment variable or command line.
!macro LeafUpdateFault POINT
  !ifdef LEAF_UPDATE_FAULT_FIXTURE
    ${If} $LeafInstallTransaction != ""
      ReadEnvStr $R9 "LEAF_UPDATE_FIXTURE_FAULT"
      ${If} $R9 == "${POINT}"
        SetErrorLevel 44
        Quit
      ${EndIf}
    ${EndIf}
  !endif
!macroend
