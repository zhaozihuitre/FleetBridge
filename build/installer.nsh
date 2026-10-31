; Shortcuts left by earlier builds: "CLAUDE OPS" points to an exe that no longer exists, and
; "Fleet Bridge" (no 舰桥) duplicates the current one. Remove them so Windows stops matching them.
!macro customInstall
  Delete "$SMPROGRAMS\CLAUDE OPS.lnk"
  Delete "$DESKTOP\CLAUDE OPS.lnk"
  Delete "$SMPROGRAMS\Fleet Bridge.lnk"
!macroend
