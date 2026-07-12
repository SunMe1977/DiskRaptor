; DiskRaptor Core Installer (WebEngine on-demand)
Unicode true
ManifestDPIAware true
RequestExecutionLevel admin

!define PRODUCT_NAME "DiskRaptor"
!define PRODUCT_VERSION "0.2.7"

Name "${PRODUCT_NAME} ${PRODUCT_VERSION}"
OutFile "DiskRaptor_${PRODUCT_VERSION}_x64_Setup.exe"
InstallDir "$PROGRAMFILES64\${PRODUCT_NAME}"

!include "MUI2.nsh"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "English"

Section "Core" SEC_CORE
  SetOutPath "$INSTDIR"

  ; ── Main executable ──
  File "install\bin\DiskRaptor.exe"

  ; ── Launcher (runtime downloader) ──
  File "install\bin\DiskRaptorLauncher.exe"

  ; ── Core Qt DLLs (NO WebEngine) ──
  File "install\bin\Qt6Core.dll"
  File "install\bin\Qt6Gui.dll"
  File "install\bin\Qt6Widgets.dll"
  File "install\bin\Qt6Network.dll"
  File "install\bin\Qt6WebChannel.dll"
  File /nonfatal "install\bin\d3dcompiler_47.dll"

  ; ── Qt plugins ──
  File /nonfatal /r "install\bin\platforms\*.dll"
  File /nonfatal /r "install\bin\imageformats\*.dll"
  File /nonfatal /r "install\bin\styles\*.dll"
  File /nonfatal /r "install\bin\tls\*.dll"
  File /nonfatal /r "install\bin\iconengines\*.dll"
  File /nonfatal /r "install\bin\generic\*.dll"
  File /nonfatal /r "install\bin\networkinformation\*.dll"

  ; ── Module Pro ──
  File /nonfatal "modulesPro\duplicateScan.dll"

  ; ── Frontend ──
  File /nonfatal /r "install\share\DiskRaptor\frontend\*.*"

  ; ── Shortcuts ──
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\DiskRaptorLauncher.exe"
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\DiskRaptorLauncher.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; ── Registry for uninstall ──
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "DisplayName" "${PRODUCT_NAME} ${PRODUCT_VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "DisplayIcon" "$INSTDIR\DiskRaptor.exe"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "NoRepair" 1
SectionEnd

Section "Uninstall"
  RMDir /r "$INSTDIR"
  RMDir /r "$SMPROGRAMS\${PRODUCT_NAME}"
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"
SectionEnd
