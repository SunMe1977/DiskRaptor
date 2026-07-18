; DiskRaptor NSIS Installer
; Run with: makensis DiskRaptor.nsi

Unicode true
ManifestDPIAware true

!define PRODUCT_NAME "DiskRaptor"
!define PRODUCT_VERSION "0.0.1"
!define PRODUCT_PUBLISHER "DiskRaptor"
!define PRODUCT_WEB_SITE "https://github.com/SunMe1977/DiskRaptor"

Name "${PRODUCT_NAME} ${PRODUCT_VERSION}"
OutFile "DiskRaptor_${PRODUCT_VERSION}_Setup.exe"
InstallDir "$PROGRAMFILES64\${PRODUCT_NAME}"
RequestExecutionLevel admin

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "..\..\dist\*.*"
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\DiskRaptor.exe" ""
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\DiskRaptor.exe" ""
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Uninstall.lnk" "$INSTDIR\Uninstall.exe" ""
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "DisplayName" "${PRODUCT_NAME} ${PRODUCT_VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "UninstallString" "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  RMDir /r "$INSTDIR"
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${PRODUCT_NAME}"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"
SectionEnd
