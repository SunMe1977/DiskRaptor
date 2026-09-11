Unicode true
ManifestDPIAware true

!define PRODUCT_NAME "DiskRaptor"
!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "1.0.32"
!endif
!define PRODUCT_PUBLISHER     "Hansjoerg Hofer"
!define PRODUCT_WEB_SITE      "https://github.com/SunMe1977/DiskRaptor"
!define PRODUCT_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"
!ifndef PAYLOAD_DIR
  !define PAYLOAD_DIR "..\..\src-tauri\target\release"
!endif
!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
!define /date CURRENT_YEAR "%Y"

!define COPYRIGHT_TEXT   "(c) 2025-${CURRENT_YEAR} ${PRODUCT_PUBLISHER}"


!include "FileFunc.nsh"
!include "LogicLib.nsh"

Name                  "${PRODUCT_NAME}"
Caption               "$(^CaptionText)"
BrandingText          "$(^CreatedBy)"
OutFile               "..\..\release-assets\DiskRaptor-${PRODUCT_VERSION}-windows-x64-silent.exe"
InstallDir            "$PROGRAMFILES64\${PRODUCT_NAME}"
InstallDirRegKey      HKLM "${PRODUCT_UNINSTALL_KEY}" "InstallLocation"
RequestExecutionLevel admin
SetCompressor /SOLID lzma

VIAddVersionKey "ProductName"        "${PRODUCT_NAME}"
VIAddVersionKey "ProductVersion"     "${PRODUCT_VERSION}"
VIAddVersionKey "Comments"           "${PRODUCT_NAME} Silent Installer"
VIAddVersionKey "CompanyName"        "${PRODUCT_PUBLISHER}"
VIAddVersionKey "LegalCopyright"     "${COPYRIGHT_TEXT}"
VIAddVersionKey "FileDescription"    "${PRODUCT_NAME} Silent Installer"
VIAddVersionKey "FileVersion"        "${PRODUCT_VERSION}"
VIAddVersionKey "InternalName"       "${PRODUCT_NAME}"

VIProductVersion "${PRODUCT_VERSION}.0"

# Fully silent by default - no pages, no dialogs. The Store runs this EXE
# without any interaction and the install completes headlessly.
SilentInstall silent
SilentUnInstall silent

Section "Install"
  SetOutPath "$INSTDIR"
  File "${PAYLOAD_DIR}\diskraptor.exe"
  ; The scanner cdylib is only present when the legacy ffi feature was built
  ; (the Tauri binary links the lib statically), so it must be optional.
  File /nonfatal "${PAYLOAD_DIR}\diskraptor_scanner.dll"
  SetOutPath "$INSTDIR\_up_"
  File /r "${PAYLOAD_DIR}\_up_\*"

  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\diskraptor.exe"

  WriteRegStr   HKLM "${PRODUCT_UNINSTALL_KEY}" "DisplayName"          "${PRODUCT_NAME}"
  WriteRegStr   HKLM "${PRODUCT_UNINSTALL_KEY}" "UninstallString"      '"$INSTDIR\Uninstall.exe"'
  WriteRegStr   HKLM "${PRODUCT_UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegStr   HKLM "${PRODUCT_UNINSTALL_KEY}" "InstallLocation"      "$INSTDIR"
  WriteRegStr   HKLM "${PRODUCT_UNINSTALL_KEY}" "DisplayIcon"          "$INSTDIR\diskraptor.exe"
  WriteRegStr   HKLM "${PRODUCT_UNINSTALL_KEY}" "DisplayVersion"       "${PRODUCT_VERSION}"
  WriteRegStr   HKLM "${PRODUCT_UNINSTALL_KEY}" "Publisher"            "${PRODUCT_PUBLISHER}"
  WriteRegStr   HKLM "${PRODUCT_UNINSTALL_KEY}" "URLInfoAbout"         "${PRODUCT_WEB_SITE}"
  WriteRegDWord HKLM "${PRODUCT_UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWord HKLM "${PRODUCT_UNINSTALL_KEY}" "NoRepair" 1

; Calculate program size
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "EstimatedSize" "$0"

  Call EnsureWebView2
SectionEnd

Section "Uninstall"
  Delete   "$INSTDIR\Uninstall.exe"
  Delete   "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk"
  RMDir    "$SMPROGRAMS\${PRODUCT_NAME}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "${PRODUCT_UNINSTALL_KEY}"
  DeleteRegKey HKCU "Software\${PRODUCT_PUBLISHER}\${PRODUCT_NAME}"
SectionEnd

# Fallback: the WebView2 runtime is normally already present (bundled with
# Windows 10+ / Windows 11), so nothing is shipped inside this installer. Only
# when it is missing do we download Microsoft's small Evergreen bootstrapper and
# run it silently. Best-effort: a failed download never blocks the install.
Function EnsureWebView2
  ClearErrors
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  IfErrors 0 wv2_done
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  IfErrors 0 wv2_done
  ReadRegStr $0 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  IfErrors 0 wv2_done

  DetailPrint "WebView2 runtime missing - downloading bootstrapper..."
  Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
  NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
  Pop $0
  StrCmp $0 "success" 0 wv2_failed

  DetailPrint "Installing WebView2 runtime..."
  ExecWait '"$TEMP\MicrosoftEdgeWebview2Setup.exe" /silent /install' $1
  Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
  StrCmp $1 0 wv2_done

wv2_failed:
  DetailPrint "WebView2 runtime could not be installed automatically; continuing."
wv2_done:
FunctionEnd
