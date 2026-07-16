; DiskRaptor Core Installer (WebEngine on-demand)
; Features: solid LZMA compression, UPX pre-compressed, upgrade support,
;           runtime check, error handling, logging, quiet uninstall

Unicode true
ManifestDPIAware true
RequestExecutionLevel admin
SetCompressor /SOLID lzma
SetCompressorDictSize 64
ShowInstDetails show

; ÔöÇÔöÇ Product metadata ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
!define PRODUCT_NAME "DiskRaptor"
!define PRODUCT_PUBLISHER "DiskRaptor Team"
!define PRODUCT_URL "https://github.com/SunMe1977/DiskRaptor"
!define PRODUCT_HELP_URL "https://github.com/SunMe1977/DiskRaptor/issues"

!define PRODUCT_VERSION "0.3.19"
!ifdef VERSION
  !undef PRODUCT_VERSION
  !define PRODUCT_VERSION "${VERSION}"
!endif

Name "${PRODUCT_NAME} ${PRODUCT_VERSION}"
OutFile "DiskRaptor_${PRODUCT_VERSION}_x64_Setup.exe"
InstallDir "$PROGRAMFILES64\${PRODUCT_NAME}"
InstallDirRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "InstallLocation"

; ÔöÇÔöÇ Icons & branding ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
!ifndef MUI_ICON
  !define MUI_ICON "..\..\images\icon.ico"
!endif
!ifndef MUI_UNICON
  !define MUI_UNICON "..\..\images\icon.ico"
!endif

!define MUI_FINISHPAGE_RUN "$INSTDIR\DiskRaptorLauncher.exe"
!define MUI_FINISHPAGE_RUN_CHECKED
!define MUI_FINISHPAGE_RUN_TEXT "Start ${PRODUCT_NAME} now"
!define MUI_ABORTWARNING
!define MUI_COMPONENTSPAGE_SMALLDESC

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

; Allow INSTALL_DIR to be overridden, defaults to "install" (relative to script)
!ifndef INSTALL_DIR
  !define INSTALL_DIR "install"
!endif
; Also define FRONTEND_DIR relative to script
!define FRONTEND_SRC "${INSTALL_DIR}\share\DiskRaptor\frontend"

; ÔöÇÔöÇ Pages ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Create &desktop shortcut"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateDesktopShortcut
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "German"

; ÔöÇÔöÇ Reserve files (faster start) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
; ÔöÇÔöÇ Installer details ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
BrandingText "${PRODUCT_NAME} ${PRODUCT_VERSION}"

; ÔöÇÔöÇ Variables ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
Var INSTALL_LOG
Var PREVIOUS_INSTDIR

; ÔöÇÔöÇ Functions ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

; Check if the app is currently running (uses only built-in Windows tools)
Function IsAppRunning
  Push $0
  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /NH /FI "IMAGENAME eq DiskRaptor.exe" 2>nul'
  Pop $0
  Pop $0
  StrLen $0 $0
  ${If} $0 < 10
    Push 0
  ${Else}
    Push 1
  ${EndIf}
  Exch $0
FunctionEnd

; Detect and silently remove old installation
Function CheckAndRemovePrevious
  ReadRegStr $PREVIOUS_INSTDIR HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "InstallLocation"
  IfErrors done

  StrCmp $PREVIOUS_INSTDIR "" done

  ; Check if old version installed in different path
  ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "DisplayVersion"
  DetailPrint "Previous installation found: $R0 in $PREVIOUS_INSTDIR"

  ; Run uninstaller silently
  ExecWait '"$PREVIOUS_INSTDIR\Uninstall.exe" /S _?=$PREVIOUS_INSTDIR' $R0

  ; Clean up stale registry key if uninstaller left it
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"

  ; Wait a moment for file handles to close
  Sleep 500

  done:
FunctionEnd

; Create desktop shortcut (called from finish page)
Function CreateDesktopShortcut
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\DiskRaptorLauncher.exe" "" "$INSTDIR\DiskRaptor.exe" 0
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "DesktopShortcutCreated" 1
FunctionEnd

; Log a message to the install log
Function LogMessage
  Pop $R0
  FileWrite $INSTALL_LOG "$R0$\r$\n"
  Push $R0
FunctionEnd

; ÔöÇÔöÇ Sections ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

Section "-Prerequisites" SEC_PREREQ
  ; Open install log
  StrCpy $INSTALL_LOG "$INSTDIR\install.log"
  FileOpen $INSTALL_LOG "$INSTDIR\install.log" w
  DetailPrint "Installation started: ${PRODUCT_NAME} ${PRODUCT_VERSION}"
  Push "Installation started: ${PRODUCT_NAME} ${PRODUCT_VERSION}"
  Call LogMessage

  ; Check if app is running
  Call IsAppRunning
  Pop $R0
  ${If} $R0 = 1
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION \
      "${PRODUCT_NAME} is currently running.$\r$\nPlease close it before installing a new version." \
      /SD IDOK IDOK wait_close IDCANCEL abort_install
    wait_close:
      Sleep 1000
      Call IsAppRunning
      Pop $R0
      ${If} $R0 = 1
        DetailPrint "Warning: ${PRODUCT_NAME} is still running ÔÇö continuing anyway (files in use may need reboot)"
        Push "WARNING: ${PRODUCT_NAME} was still running during install"
        Call LogMessage
      ${EndIf}
      Goto after_process_check
    abort_install:
      Push "Aborted by user ÔÇö ${PRODUCT_NAME} was running"
      Call LogMessage
      FileClose $INSTALL_LOG
      Abort
  ${EndIf}
  after_process_check:

  ; Detect and remove old version
  Call CheckAndRemovePrevious

  ; Create install directory
  CreateDirectory "$INSTDIR"

  ; Clean up leftover files from previous installations
  ; These survive if the old uninstaller couldn't delete locked files
  ; Stray root-level plugin DLLs (belong in subdirectories, not root)
  Delete "$INSTDIR\qwindows.dll"
  Delete "$INSTDIR\qgif.dll"
  Delete "$INSTDIR\qico.dll"
  Delete "$INSTDIR\qjpeg.dll"
  Delete "$INSTDIR\qsvg.dll"
  Delete "$INSTDIR\qsvgicon.dll"
  Delete "$INSTDIR\qmodernwindowsstyle.dll"
  Delete "$INSTDIR\qstylekitstyle.dll"
  Delete "$INSTDIR\qtuiotouchplugin.dll"
  Delete "$INSTDIR\qnetworklistmanager.dll"
  Delete "$INSTDIR\qcertonlybackend.dll"
  Delete "$INSTDIR\qschannelbackend.dll"
  ; Delete old runtime ÔÇö forces launcher to download fresh on next launch
  RMDir /r "$INSTDIR\runtime"

  ; Check free space
  ${GetFileAttributes} "$INSTDIR" "DIRECTORY" $R0
  ${DriveSpace} "$INSTDIR" "/D=F /S=G" $R0
  DetailPrint "Available disk space: $R0 GB"
  ${If} $R0 < 0.05  ; 50 MB minimum
    MessageBox MB_OKCANCEL|MB_ICONSTOP \
      "Less than 50 MB of free space available.$\r$\nInstallation may fail due to insufficient disk space." \
      /SD IDOK IDOK continue_anyway IDCANCEL abort_space
    abort_space:
      Push "Aborted ÔÇö insufficient disk space ($R0 GB)"
      Call LogMessage
      FileClose $INSTALL_LOG
      Abort
    continue_anyway:
  ${EndIf}

  Push "Prerequisites check passed"
  Call LogMessage
SectionEnd

Section "${PRODUCT_NAME} Core" SEC_CORE
  SectionIn RO
  SetOutPath "$INSTDIR"

  DetailPrint "Copying DiskRaptor.exe..."
  File "install\bin\DiskRaptor.exe"
  ${If} ${FileExists} "$INSTDIR\DiskRaptor.exe"
    Push "OK ÔÇö DiskRaptor.exe"
    Call LogMessage
  ${Else}
    Push "ERROR ÔÇö DiskRaptor.exe not copied"
    Call LogMessage
    Abort "Failed to copy DiskRaptor.exe"
  ${EndIf}

  DetailPrint "Copying DiskRaptorLauncher.exe..."
  File "install\bin\DiskRaptorLauncher.exe"
  ${If} ${FileExists} "$INSTDIR\DiskRaptorLauncher.exe"
    Push "OK ÔÇö DiskRaptorLauncher.exe"
    Call LogMessage
  ${Else}
    Push "ERROR ÔÇö DiskRaptorLauncher.exe not copied"
    Call LogMessage
    Abort "Failed to copy DiskRaptorLauncher.exe"
  ${EndIf}

  ; ÔùÅ Core Qt DLLs (NO WebEngine) ÔùÅ
  DetailPrint "Copying Qt6 core DLLs..."
  File "install\bin\Qt6Core.dll"
  File "install\bin\Qt6Gui.dll"
  File "install\bin\Qt6Widgets.dll"
  File "install\bin\Qt6Network.dll"
  File "install\bin\Qt6Positioning.dll"
  File "install\bin\Qt6PrintSupport.dll"
  File "install\bin\Qt6WebChannel.dll"
  File /nonfatal "install\bin\d3dcompiler_47.dll"
  File /nonfatal "install\bin\opengl32sw.dll"
  File /nonfatal "install\bin\dxcompiler.dll"
  File /nonfatal "install\bin\dxil.dll"

  ; ÔùÅ Qt plugins ÔùÅ
  DetailPrint "Copying Qt plugins..."
  SetOutPath "$INSTDIR\platforms"
  File /nonfatal "install\bin\platforms\*.dll"
  SetOutPath "$INSTDIR\imageformats"
  File /nonfatal "install\bin\imageformats\*.dll"
  SetOutPath "$INSTDIR\styles"
  File /nonfatal "install\bin\styles\*.dll"
  SetOutPath "$INSTDIR\tls"
  File /nonfatal "install\bin\tls\*.dll"
  SetOutPath "$INSTDIR\iconengines"
  File /nonfatal "install\bin\iconengines\*.dll"
  SetOutPath "$INSTDIR\generic"
  File /nonfatal "install\bin\generic\*.dll"
  SetOutPath "$INSTDIR\networkinformation"
  File /nonfatal "install\bin\networkinformation\*.dll"
  SetOutPath "$INSTDIR"

  ; ÔùÅ Essential WebEngine resources needed at app root ÔùÅ
  DetailPrint "Copying WebEngine resource files..."
  File /nonfatal "install\bin\resources\icudtl.dat"
  File /nonfatal "install\bin\resources\v8_context_snapshot.bin"
  File /nonfatal "install\bin\resources\qtwebengine_*.pak"
  SetOutPath "$INSTDIR\translations\qtwebengine_locales"
  File /nonfatal "install\bin\translations\qtwebengine_locales\*.pak"
  SetOutPath "$INSTDIR"

  ; ÔùÅ Module Pro ÔùÅ
  DetailPrint "Copying modules..."
  File /nonfatal "modulesPro\duplicateScan.dll"

  ; ÔùÅ Frontend ÔùÅ
  DetailPrint "Copying frontend files..."
  !ifndef FRONTEND_DIR
    !define FRONTEND_DIR "install\share\DiskRaptor\frontend"
  !endif
  SetOutPath "$INSTDIR\share\DiskRaptor\frontend"
  File "${FRONTEND_DIR}\index.html"
  File "${FRONTEND_DIR}\style.css"
  File "${FRONTEND_DIR}\qt-bridge.js"
  File "${FRONTEND_DIR}\app.js"
  File "${FRONTEND_DIR}\chunkloader.js"
  File "${FRONTEND_DIR}\diagrams.js"
  File "${FRONTEND_DIR}\galaxyview.js"
  File "${FRONTEND_DIR}\i18n.js"
  File "${FRONTEND_DIR}\iconcache.js"
  File "${FRONTEND_DIR}\splitter.js"
  File "${FRONTEND_DIR}\stats.js"
  File "${FRONTEND_DIR}\topfiles.js"
  File "${FRONTEND_DIR}\treeview.js"
  File "${FRONTEND_DIR}\virtualscroll.js"
  File "${FRONTEND_DIR}\diagnostic.html"
  File /r "${FRONTEND_DIR}\galaxyview\*.js"
  File /r "${FRONTEND_DIR}\modules\*.js"

  Push "OK ÔÇö all core files copied"
  Call LogMessage
SectionEnd

Section "Start Menu Shortcuts" SEC_SHORTCUTS
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  SetOutPath "$INSTDIR"

  Delete "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" \
    "$INSTDIR\DiskRaptorLauncher.exe" "" "$INSTDIR\DiskRaptor.exe" 0

  WriteINIStr "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME} Website.url" \
    "InternetShortcut" "URL" "${PRODUCT_URL}"

  Push "OK ÔÇö Start Menu shortcuts created"
  Call LogMessage
SectionEnd

Section "-Finalize" SEC_FINAL
  ; ÔùÅ Uninstaller ÔùÅ
  DetailPrint "Creating uninstaller..."
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  ${If} ${FileExists} "$INSTDIR\Uninstall.exe"
    Push "OK ÔÇö Uninstaller created"
    Call LogMessage
  ${Else}
    Push "ERROR ÔÇö Failed to create uninstaller"
    Call LogMessage
    Abort "Failed to create uninstaller"
  ${EndIf}

  ; ÔùÅ Registry for Programs & Features ÔùÅ
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "URLInfoAbout" "${PRODUCT_URL}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "HelpLink" "${PRODUCT_HELP_URL}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "DisplayIcon" "$INSTDIR\DiskRaptor.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "InstallDate" ""
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "NoRepair" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "EstimatedSize" 15360  ; ~15 MB in KB

  ; ÔùÅ Write install date ÔùÅ
  ${GetTime} "" "L" $R0 $R1 $R2 $R3 $R4 $R5 $R6
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" \
    "InstallDate" "$R2$R1$R0"

  Push "OK ÔÇö Registry entries created"
  Call LogMessage

  ; ÔùÅ Close log ÔùÅ
  Push "Installation completed successfully"
  Call LogMessage
  FileClose $INSTALL_LOG
SectionEnd

; ÔöÇÔöÇ Section descriptions ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ-
LangString DESC_SEC_CORE ${LANG_ENGLISH} "DiskRaptor application files, Qt6 core DLLs, and frontend (required)"
LangString DESC_SEC_SHORTCUTS ${LANG_ENGLISH} "Start Menu shortcuts (recommended)"
LangString DESC_SEC_CORE ${LANG_GERMAN} "DiskRaptor-Anwendungsdateien, Qt6-Kernbibliotheken und Frontend (erforderlich)"
LangString DESC_SEC_SHORTCUTS ${LANG_GERMAN} "Startmen├╝-Verkn├╝pfungen (empfohlen)"

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_CORE} $(DESC_SEC_CORE)
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_SHORTCUTS} $(DESC_SEC_SHORTCUTS)
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
;  UNINSTALLER
; ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

Section "Uninstall"
  DetailPrint "Removing ${PRODUCT_NAME}..."

  ; Check if app is running (using built-in Windows tools)
  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /NH /FI "IMAGENAME eq DiskRaptor.exe" 2>nul'
  Pop $R0
  Pop $R0
  StrLen $R0 $R0
  ${If} $R0 > 10
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION \
      "${PRODUCT_NAME} is still running.$\r$\nPlease close it first." \
      /SD IDOK IDOK kill_proc IDCANCEL abort_un
    kill_proc:
      nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /IM "DiskRaptor.exe" 2>nul'
    abort_un:
      Abort
  ${EndIf}

  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /NH /FI "IMAGENAME eq DiskRaptorLauncher.exe" 2>nul'
  Pop $R0
  Pop $R0
  StrLen $R0 $R0
  ${If} $R0 > 10
    nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /IM "DiskRaptorLauncher.exe" 2>nul'
  ${EndIf}

  ; Remove installed files
  RMDir /r "$INSTDIR"
  DetailPrint "Removed: $INSTDIR"

  ; Remove shortcuts
  RMDir /r "$SMPROGRAMS\${PRODUCT_NAME}"

  ; Remove desktop shortcut if we created one
  ReadRegDWORD $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "DesktopShortcutCreated"
  ${If} $R0 = 1
    Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  ${EndIf}

  ; Remove registry keys
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"

  DetailPrint "${PRODUCT_NAME} uninstalled successfully."
SectionEnd
