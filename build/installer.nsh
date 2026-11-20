; Shortcuts left by earlier builds: "CLAUDE OPS" points to an exe that no longer exists, and
; "Fleet Bridge" (no 舰桥) duplicates the current one with the same AppUserModelID and no icon: the
; taskbar took it and showed a blank icon. Remove them so Windows stops matching them, from the Start
; menu installed into and also from the user's own one: installed for all users, $SMPROGRAMS is
; ProgramData's and the per-user leftover used to stay.
!macro customInstall
  Delete "$SMPROGRAMS\CLAUDE OPS.lnk"
  Delete "$DESKTOP\CLAUDE OPS.lnk"
  Delete "$SMPROGRAMS\Fleet Bridge.lnk"
  ReadEnvStr $0 APPDATA
  ${If} $0 != ""
    Delete "$0\Microsoft\Windows\Start Menu\Programs\Fleet Bridge.lnk"
    Delete "$0\Microsoft\Windows\Start Menu\Programs\CLAUDE OPS.lnk"
  ${EndIf}
  ReadEnvStr $0 USERPROFILE
  ${If} $0 != ""
    Delete "$0\Desktop\CLAUDE OPS.lnk"
  ${EndIf}
  ; SHCNE_ASSOCCHANGED: Windows reloads the icons
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
