Unicode true
ManifestDPIAware true

!define PRODUCT_NAME      "DiskRaptor"
!ifndef PRODUCT_VERSION
   !define PRODUCT_VERSION "1.0.25"
!endif
!define PRODUCT_PUBLISHER "Hansjoerg Hofer"
!define PRODUCT_WEB_SITE  "https://github.com/SunMe1977/DiskRaptor"

!define /date CURRENT_YEAR "%Y"

!define COPYRIGHT_TEXT   "(c) 2025-${CURRENT_YEAR} ${PRODUCT_PUBLISHER}"


!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

Name "${PRODUCT_NAME}"
Caption               "$(^CaptionText)"
BrandingText          "$(^CreatedBy)"
OutFile               "DiskRaptor-${PRODUCT_VERSION}-windows-x64.exe"
InstallDir            "$PROGRAMFILES64\${PRODUCT_NAME}"
InstallDirRegKey      HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "InstallLocation"
RequestExecutionLevel admin

; ── EXE file properties (right-click → Properties → Details) ──
VIAddVersionKey "ProductName"        "${PRODUCT_NAME}"
VIAddVersionKey "ProductVersion"     "${PRODUCT_VERSION}"
VIAddVersionKey "Comments"           "${PRODUCT_NAME} Installer"
VIAddVersionKey "CompanyName"        "${PRODUCT_PUBLISHER}"
VIAddVersionKey "LegalCopyright"     "${COPYRIGHT_TEXT}"
VIAddVersionKey "FileDescription"    "${PRODUCT_NAME} Installer"
VIAddVersionKey "FileVersion"        "${PRODUCT_VERSION}"
VIAddVersionKey "InternalName"       "${PRODUCT_NAME}"

VIProductVersion "${PRODUCT_VERSION}.0"

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
!define      MUI_FINISHPAGE_RUN "$INSTDIR\DiskRaptor.exe"
!define      MUI_FINISHPAGE_RUN_TEXT "$(^RunText)"
!define      MUI_FINISHPAGE_RUN_NOTCHECKED

!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; Include file with language list and Custom messages
!include "DiskRaptor_languages.nsi"

Section "Install"
  SetOutPath "$INSTDIR"
    File /r "..\..\dist\DiskRaptor.exe"

  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\DiskRaptor.exe"

  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    CreateDirectory "$SMPROGRAMS\$StartMenuFolder"
    CreateShortCut "$SMPROGRAMS\$StartMenuFolder\${PRODUCT_NAME}.lnk" "$INSTDIR\DiskRaptor.exe"
    CreateShortCut "$SMPROGRAMS\$StartMenuFolder\$(^UninstPrg).lnk" "$INSTDIR\Uninstall.exe"
  !insertmacro MUI_STARTMENU_WRITE_END

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr   HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "DisplayName"     "${PRODUCT_NAME}"
  WriteRegStr   HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr   HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "DisplayIcon"     "$INSTDIR\DiskRaptor.exe"
  WriteRegStr   HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "DisplayVersion"  "${PRODUCT_VERSION}"
  WriteRegStr   HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "Publisher"       "${PRODUCT_PUBLISHER}"
  WriteRegDWord HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "NoModify" 1
  WriteRegDWord HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "NoRepair" 1
  
  ; Calculate program size
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "EstimatedSize" "$0"
  
SectionEnd

Section "Uninstall"
  RMDir /r "$INSTDIR"
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  !insertmacro MUI_STARTMENU_GETFOLDER Application $StartMenuFolder
  RMDir /r "$SMPROGRAMS\$StartMenuFolder"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"
SectionEnd

Function .onInit
    !define      MUI_LANGDLL_WINDOWTITLE $(^LangTitle)
    !define      MUI_LANGDLL_INFO        $(^LangText)
    !insertmacro MUI_LANGDLL_DISPLAY
FunctionEnd

