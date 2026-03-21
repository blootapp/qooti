!macro NSIS_HOOK_POSTINSTALL
  ; Bind .qooti to a dedicated ProgID and explicit file icon.
  ; SHCTX writes to HKLM (all-users install) or HKCU (current-user install) automatically.
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.qooti\UserChoice"

  WriteRegStr SHCTX "Software\Classes\.qooti" "" "QootiPackFile"
  WriteRegStr SHCTX "Software\Classes\.qooti\OpenWithProgids" "QootiPackFile" ""
  WriteRegStr SHCTX "Software\Classes\QootiPackFile" "" "Qooti Pack"
  ; Tauri installs ../assets/* to $INSTDIR\_up_\assets\ (path from bundler)
  WriteRegStr SHCTX "Software\Classes\QootiPackFile\DefaultIcon" "" '"$INSTDIR\_up_\assets\qooti-pack-icon.ico",0'
  WriteRegStr SHCTX "Software\Classes\QootiPackFile\shell" "" "open"
  WriteRegStr SHCTX "Software\Classes\QootiPackFile\shell\open" "" "Open with Qooti"
  WriteRegStr SHCTX "Software\Classes\QootiPackFile\shell\open\command" "" '"$INSTDIR\qooti.exe" "%1"'

  ; Refresh Explorer association/icon cache.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x0000, p 0, p 0)'
  System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x0000, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.qooti\UserChoice"
  DeleteRegKey SHCTX "Software\Classes\.qooti"
  DeleteRegKey SHCTX "Software\Classes\QootiPackFile"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x0000, p 0, p 0)'
  System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x0000, p 0, p 0)'
!macroend
