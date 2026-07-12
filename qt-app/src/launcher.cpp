// DiskRaptor Launcher — Win32, no Qt dependency
// Downloads Qt WebEngine runtime if missing, then launches main app
// Link with: kernel32.lib user32.lib shell32.lib wininet.lib

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <wininet.h>
#include <shlobj.h>
#include <strsafe.h>
#include <stdio.h>

#pragma comment(lib, "kernel32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "wininet.lib")

#define RUNTIME_DIR L"runtime"
#define RUNTIME_ZIP  L"qtwebengine_runtime.zip"
#define RELEASE_URL L"https://github.com/SunMe1977/DiskRaptor/releases/latest/download/"
#define APP_EXE     L"DiskRaptor.exe"

// ── Download file via HTTPS ──────────────────────────────────
BOOL DownloadFile(LPCWSTR url, LPCWSTR destPath) {
    HINTERNET hNet = InternetOpenW(L"DiskRaptorLauncher", INTERNET_OPEN_TYPE_PRECONFIG, NULL, NULL, 0);
    if (!hNet) return FALSE;

    HINTERNET hUrl = InternetOpenUrlW(hNet, url, NULL, 0, INTERNET_FLAG_RELOAD | INTERNET_FLAG_NO_CACHE_WRITE, 0);
    if (!hUrl) { InternetCloseHandle(hNet); return FALSE; }

    HANDLE hFile = CreateFileW(destPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) { InternetCloseHandle(hUrl); InternetCloseHandle(hNet); return FALSE; }

    BYTE buf[65536];
    DWORD read;
    BOOL ok = TRUE;
    while (InternetReadFile(hUrl, buf, sizeof(buf), &read) && read > 0) {
        DWORD written;
        ok = WriteFile(hFile, buf, read, &written, NULL);
        if (!ok) break;
    }

    CloseHandle(hFile);
    InternetCloseHandle(hUrl);
    InternetCloseHandle(hNet);
    return ok;
}

// ── Extract ZIP using Shell API (Windows 10+ built-in) ──────
BOOL ExtractZip(LPCWSTR zipPath, LPCWSTR destDir) {
    // Create destination directory
    CreateDirectoryW(destDir, NULL);

    // Use Shell32 to copy the zip contents
    WCHAR destDirDouble[1024];
    StringCchCopyW(destDirDouble, 1024, destDir);
    StringCchCatW(destDirDouble, 1024, L"\\");

    SHFILEOPSTRUCTW op = {0};
    WCHAR from[MAX_PATH];
    StringCchCopyW(from, MAX_PATH, zipPath);
    from[wcslen(from)+1] = 0; // double null terminate

    op.wFunc = FO_COPY;
    op.pFrom = from;
    op.pTo = destDirDouble;
    op.fFlags = FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT | FOF_NO_UI;

    int ret = SHFileOperationW(&op);
    return (ret == 0);
}

// ── Check if runtime directory exists and has DLLs ──────────
BOOL RuntimeExists(LPCWSTR baseDir) {
    WCHAR runtimePath[MAX_PATH];
    StringCchCopyW(runtimePath, MAX_PATH, baseDir);
    StringCchCatW(runtimePath, MAX_PATH, L"\\");
    StringCchCatW(runtimePath, MAX_PATH, RUNTIME_DIR);

    DWORD attr = GetFileAttributesW(runtimePath);
    if (attr == INVALID_FILE_ATTRIBUTES || !(attr & FILE_ATTRIBUTE_DIRECTORY))
        return FALSE;

    // Check for a key DLL
    WCHAR dllPath[MAX_PATH];
    StringCchCopyW(dllPath, MAX_PATH, runtimePath);
    StringCchCatW(dllPath, MAX_PATH, L"\\Qt6WebEngineCore.dll");
    return (GetFileAttributesW(dllPath) != INVALID_FILE_ATTRIBUTES);
}

// ── Get our own directory ────────────────────────────────────
void GetAppDir(LPWSTR buf, DWORD size) {
    GetModuleFileNameW(NULL, buf, size);
    WCHAR *p = wcsrchr(buf, L'\\');
    if (p) *p = 0;
}

// ── Entry point ──────────────────────────────────────────────
int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int) {
    WCHAR appDir[MAX_PATH];
    GetAppDir(appDir, MAX_PATH);

    // Check if runtime exists
    if (!RuntimeExists(appDir)) {
        // Show download dialog
        int ret = MessageBoxW(NULL,
            L"DiskRaptor needs the Qt WebEngine runtime (~80 MB) for the first launch.\n\n"
            L"Download and install it now?",
            L"DiskRaptor — Runtime Required",
            MB_ICONQUESTION | MB_YESNO | MB_SETFOREGROUND);

        if (ret != IDYES) {
            MessageBoxW(NULL, L"DiskRaptor needs the WebEngine runtime to run.", L"DiskRaptor", MB_ICONINFORMATION);
            return 0;
        }

        // Create runtime directory
        WCHAR runtimeDir[MAX_PATH];
        StringCchCopyW(runtimeDir, MAX_PATH, appDir);
        StringCchCatW(runtimeDir, MAX_PATH, L"\\");
        StringCchCatW(runtimeDir, MAX_PATH, RUNTIME_DIR);
        CreateDirectoryW(runtimeDir, NULL);

        // Download
        WCHAR zipPath[MAX_PATH];
        StringCchCopyW(zipPath, MAX_PATH, appDir);
        StringCchCatW(zipPath, MAX_PATH, L"\\");
        StringCchCatW(zipPath, MAX_PATH, RUNTIME_ZIP);

        WCHAR url[MAX_PATH];
        StringCchCopyW(url, MAX_PATH, RELEASE_URL);
        StringCchCatW(url, MAX_PATH, RUNTIME_ZIP);

        // Show downloading message
        HWND hwnd = CreateWindowExW(0, L"STATIC",
            L"Downloading Qt WebEngine runtime...\nThis may take a minute.",
            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
            CW_USEDEFAULT, CW_USEDEFAULT, 400, 120,
            NULL, NULL, GetModuleHandleW(NULL), NULL);
        if (hwnd) {
            ShowWindow(hwnd, SW_SHOW);
            UpdateWindow(hwnd);
        }

        BOOL downloaded = DownloadFile(url, zipPath);

        if (hwnd) DestroyWindow(hwnd);

        if (!downloaded) {
            MessageBoxW(NULL,
                L"Failed to download the WebEngine runtime.\n"
                L"Please check your internet connection and try again.",
                L"DiskRaptor — Download Failed", MB_ICONERROR);
            return 1;
        }

        // Extract into runtime directory
        if (!ExtractZip(zipPath, runtimeDir)) {
            MessageBoxW(NULL, L"Failed to extract the runtime package.", L"DiskRaptor", MB_ICONERROR);
            return 1;
        }

        // Clean up zip
        DeleteFileW(zipPath);
    }

    // Launch the real app
    WCHAR exePath[MAX_PATH];
    StringCchCopyW(exePath, MAX_PATH, appDir);
    StringCchCatW(exePath, MAX_PATH, L"\\");
    StringCchCatW(exePath, MAX_PATH, APP_EXE);

    SHELLEXECUTEINFOW sei = { sizeof(sei) };
    sei.lpFile = exePath;
    sei.lpDirectory = appDir;
    sei.nShow = SW_SHOWNORMAL;
    sei.fMask = SEE_MASK_NOASYNC | SEE_MASK_NOCLOSEPROCESS;

    if (!ShellExecuteExW(&sei)) {
        MessageBoxW(NULL, L"Failed to launch DiskRaptor.exe", L"DiskRaptor", MB_ICONERROR);
        return 1;
    }

    // Wait for the app to close
    if (sei.hProcess) {
        WaitForSingleObject(sei.hProcess, INFINITE);
        CloseHandle(sei.hProcess);
    }

    return 0;
}
