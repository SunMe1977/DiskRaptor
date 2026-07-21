Unicode true
ManifestDPIAware true

!define PRODUCT_NAME "DiskRaptor"
!define PRODUCT_VERSION "0.0.2"
!define PRODUCT_PUBLISHER "DiskRaptor"
!define PRODUCT_WEB_SITE "https://github.com/SunMe1977/DiskRaptor"

!include "MUI2.nsh"

Name "${PRODUCT_NAME} ${PRODUCT_VERSION}"
OutFile "DiskRaptor_${PRODUCT_VERSION}_Setup.exe"
InstallDir "$PROGRAMFILES64\${PRODUCT_NAME}"
InstallDirRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "InstallLocation"
RequestExecutionLevel admin

Var StartMenuFolder

!define MUI_ABORTWARNING
!define MUI_WELCOMEFINISHPAGE_BITMAP "${NSISDIR}\Contrib\Graphics\Wizard\win.bmp"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "${NSISDIR}\Contrib\Graphics\Header\win.bmp"
!define MUI_HEADERIMAGE_RIGHT

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\..\license.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_STARTMENU Application $StartMenuFolder
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\DiskRaptor.exe"
!define MUI_FINISHPAGE_RUN_TEXT "$(^RunText)"
!define MUI_FINISHPAGE_RUN_NOTCHECKED

!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "German"
!insertmacro MUI_LANGUAGE "French"

LangString ^RunText ${LANG_ENGLISH} "Run DiskRaptor"
LangString ^RunText ${LANG_GERMAN} "DiskRaptor starten"
LangString ^RunText ${LANG_FRENCH} "Lancer DiskRaptor"

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "..\..\dist\DiskRaptor.exe"
  File /r "..\..\dist\*.dll"
  File /r "..\..\dist\QtWebEngineProcess.exe"
  File /r "..\..\dist\frontend\"
  File /r "..\..\dist\images\"
  File /r "..\..\dist\platforms\"
  File /r "..\..\dist\styles\"
  File /r "..\..\dist\imageformats\"
  File /r "..\..\dist\iconengines\"
  File /r "..\..\dist\generic\"
  File /r "..\..\dist\networkinformation\"
  File /r "..\..\dist\tls\"
  File /r "..\..\dist\position\"
  File /r "..\..\dist\resources\"
  File /r "..\..\dist\translations\"

  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\DiskRaptor.exe"

  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    CreateDirectory "$SMPROGRAMS\$StartMenuFolder"
    CreateShortCut "$SMPROGRAMS\$StartMenuFolder\${PRODUCT_NAME}.lnk" "$INSTDIR\DiskRaptor.exe"
    CreateShortCut "$SMPROGRAMS\$StartMenuFolder\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  !insertmacro MUI_STARTMENU_WRITE_END

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "DisplayName" "${PRODUCT_NAME} ${PRODUCT_VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "DisplayIcon" "$INSTDIR\DiskRaptor.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegDWord HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "NoModify" 1
  WriteRegDWord HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  RMDir /r "$INSTDIR"
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  !insertmacro MUI_STARTMENU_GETFOLDER Application $StartMenuFolder
  RMDir /r "$SMPROGRAMS\$StartMenuFolder"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"
SectionEnd
