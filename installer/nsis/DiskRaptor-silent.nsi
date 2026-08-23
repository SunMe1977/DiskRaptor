Unicode true
ManifestDPIAware true

!define PRODUCT_NAME "DiskRaptor"
!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "1.0.22"
!endif
!define PRODUCT_PUBLISHER "Hansjoerg Hofer"
!define PRODUCT_WEB_SITE "https://github.com/SunMe1977/DiskRaptor"
!define PRODUCT_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"
!ifndef PAYLOAD_DIR
  !define PAYLOAD_DIR "..\..\src-tauri\target\release"
!endif
!define WEBVIEW2_INSTALLER "..\webview2\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
!define WEBVIEW2_CLIENT_GUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

Name "${PRODUCT_NAME} ${PRODUCT_VERSION}"
OutFile "..\..\release-assets\DiskRaptor-${PRODUCT_VERSION}-windows-x64-silent.exe"
InstallDir "$PROGRAMFILES64\${PRODUCT_NAME}"
InstallDirRegKey HKLM "${PRODUCT_UNINSTALL_KEY}" "InstallLocation"
RequestExecutionLevel admin
SetCompressor /SOLID lzma

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

  # Embed the WebView2 Evergreen Runtime so the install works fully offline.
  SetOutPath "$PLUGINSDIR"
  File "${WEBVIEW2_INSTALLER}"

  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\diskraptor.exe"

  WriteRegStr HKLM "${PRODUCT_UNINSTALL_KEY}" "DisplayName" "${PRODUCT_NAME} ${PRODUCT_VERSION}"
  WriteRegStr HKLM "${PRODUCT_UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "${PRODUCT_UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegStr HKLM "${PRODUCT_UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${PRODUCT_UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\diskraptor.exe"
  WriteRegStr HKLM "${PRODUCT_UNINSTALL_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKLM "${PRODUCT_UNINSTALL_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKLM "${PRODUCT_UNINSTALL_KEY}" "URLInfoAbout" "${PRODUCT_WEB_SITE}"
  WriteRegDWord HKLM "${PRODUCT_UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWord HKLM "${PRODUCT_UNINSTALL_KEY}" "NoRepair" 1

  Call EnsureWebView2
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\Uninstall.exe"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT_NAME}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "${PRODUCT_UNINSTALL_KEY}"
  DeleteRegKey HKCU "Software\${PRODUCT_PUBLISHER}\${PRODUCT_NAME}"
SectionEnd

# Install the bundled Evergreen WebView2 Runtime silently, but only if it is
# missing. The runtime ships inside this installer, so no network is needed.
Function EnsureWebView2
  ClearErrors
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_CLIENT_GUID}" "pv"
  IfErrors 0 wv2_ok
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_CLIENT_GUID}" "pv"
  IfErrors 0 wv2_ok
  ReadRegStr $0 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_CLIENT_GUID}" "pv"
  IfErrors 0 wv2_ok
  ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebView2RuntimeInstallerX64.exe" /install'
wv2_ok:
FunctionEnd
