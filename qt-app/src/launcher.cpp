// DiskRaptor Launcher — Win32, no Qt dependency
// Downloads Qt WebEngine runtime if missing, then launches main app
// Link with: kernel32.lib user32.lib shell32.lib wininet.lib

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <wininet.h>
#include <shlobj.h>
#include <shlguid.h>
#include <shldisp.h>
#include <strsafe.h>
#include <stdio.h>

#pragma comment(lib, "kernel32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "wininet.lib")
#pragma comment(lib, "ole32.lib")

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

// ── Extract ZIP using Shell.Application COM (Windows 10+ built-in) ────
BOOL ExtractZip(LPCWSTR zipPath, LPCWSTR destDir) {
    // Create destination directory if it doesn't exist
    if (!CreateDirectoryW(destDir, NULL)) {
        if (GetLastError() != ERROR_ALREADY_EXISTS)
            return FALSE;
    }

    // Initialize COM for this thread
    HRESULT hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    if (FAILED(hr))
        return FALSE;

    BOOL success = FALSE;
    IShellDispatch *pShell = NULL;
    Folder *pZipFolder = NULL;
    Folder *pDestFolder = NULL;
    FolderItems *pItems = NULL;

    do {
        // 1. Create Shell.Application object
        hr = CoCreateInstance(CLSID_Shell, NULL, CLSCTX_INPROC_SERVER,
                              IID_IShellDispatch, (void**)&pShell);
        if (FAILED(hr) || !pShell)
            break;

        // 2. Get the ZIP file as a folder namespace (treat ZIP as directory)
        VARIANT zipV;
        VariantInit(&zipV);
        zipV.vt = VT_BSTR;
        zipV.bstrVal = SysAllocString(zipPath);
        hr = pShell->NameSpace(zipV, &pZipFolder);
        SysFreeString(zipV.bstrVal);
        if (FAILED(hr) || !pZipFolder)
            break;

        // 3. Count items in ZIP to detect empty archives early
        LONG itemCount = 0;
        {
            FolderItems *pCountItems = NULL;
            if (SUCCEEDED(pZipFolder->Items(&pCountItems)) && pCountItems) {
                pCountItems->Count(&itemCount);
                pCountItems->Release();
            }
        }

        // Empty ZIP is valid — nothing to extract
        if (itemCount == 0) {
            success = TRUE;
            break;
        }

        // 4. Get the destination folder namespace
        VARIANT destV;
        VariantInit(&destV);
        destV.vt = VT_BSTR;
        destV.bstrVal = SysAllocString(destDir);
        hr = pShell->NameSpace(destV, &pDestFolder);
        SysFreeString(destV.bstrVal);
        if (FAILED(hr) || !pDestFolder)
            break;

        // 5. Get the items (files) from the ZIP
        hr = pZipFolder->Items(&pItems);
        if (FAILED(hr) || !pItems)
            break;

        // 6. Call CopyHere to extract with progress dialog visible to user
        //    Options: 0x10c = FOF_NO_CONFIRMMKDIR | FOF_SIMPLEPROGRESS
        //    - FOF_NO_CONFIRMMKDIR  (0x100): auto-create missing dirs
        //    - FOF_SIMPLEPROGRESS    (0x010): show a progress dialog
        //    - Combined: 0x110 (256 + 16)... actually let me be precise:
        //      FOF_NO_CONFIRMMKDIR = 0x0100 (256)
        //      FOF_SIMPLEPROGRESS  = 0x0010 (16)
        //      FOF_NOERRORUI       = 0x0400 (1024) - suppress error dialogs
        //      Total = 0x0510 (1296)
        VARIANT itemV, optV;
        VariantInit(&itemV);
        VariantInit(&optV);

        itemV.vt = VT_DISPATCH;
        itemV.pdispVal = pItems;  // FolderItems implements IDispatch

        optV.vt = VT_I4;
        optV.lVal = 0x510;  // FOF_NO_CONFIRMMKDIR | FOF_SIMPLEPROGRESS | FOF_NOERRORUI

        hr = pDestFolder->CopyHere(itemV, optV);
        VariantClear(&itemV);
        VariantClear(&optV);

        // CopyHere returns S_OK immediately (operation is async).
        // 7. Wait for extraction to finish by polling the destination for files.
        int maxWaits = 90;  // ~90 second timeout (generous for large runtimes)
        while (maxWaits-- > 0) {
            Sleep(1000);

            WIN32_FIND_DATAW ffd;
            WCHAR searchPath[MAX_PATH];
            StringCchCopyW(searchPath, MAX_PATH, destDir);
            StringCchCatW(searchPath, MAX_PATH, L"\\*");

            HANDLE hFind = FindFirstFileW(searchPath, &ffd);
            if (hFind != INVALID_HANDLE_VALUE) {
                BOOL hasEntries = FALSE;
                do {
                    if (wcscmp(ffd.cFileName, L".") != 0 &&
                        wcscmp(ffd.cFileName, L"..") != 0) {
                        hasEntries = TRUE;
                        break;
                    }
                } while (FindNextFileW(hFind, &ffd));
                FindClose(hFind);

                if (hasEntries)
                    break;  // Extraction produced at least one file/directory
            }
        }

        // 8. Verify extraction really succeeded (final check)
        {
            WIN32_FIND_DATAW vfd;
            WCHAR verifyPath[MAX_PATH];
            StringCchCopyW(verifyPath, MAX_PATH, destDir);
            StringCchCatW(verifyPath, MAX_PATH, L"\\*");

            HANDLE hVerify = FindFirstFileW(verifyPath, &vfd);
            if (hVerify != INVALID_HANDLE_VALUE) {
                do {
                    if (wcscmp(vfd.cFileName, L".") != 0 &&
                        wcscmp(vfd.cFileName, L"..") != 0) {
                        success = TRUE;
                        break;
                    }
                } while (FindNextFileW(hVerify, &vfd));
                FindClose(hVerify);
            }
        }

    } while (0);

    // Cleanup COM interfaces
    if (pItems)      pItems->Release();
    if (pDestFolder) pDestFolder->Release();
    if (pZipFolder)  pZipFolder->Release();
    if (pShell)      pShell->Release();

    CoUninitialize();
    return success;
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

        // Extract into runtime directory (shows progress dialog to user)
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
