// DiskRaptor Launcher — Win32, no Qt dependency
// Downloads Qt WebEngine runtime if missing, then launches main app
// Link with: kernel32.lib user32.lib shell32.lib wininet.lib

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commctrl.h>
#include <shellapi.h>
#include <wininet.h>
#include <shlobj.h>
#include <shlguid.h>
#include <shldisp.h>
#include <strsafe.h>
#include <stdio.h>
#include <stdint.h>

#pragma comment(lib, "kernel32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "wininet.lib")
#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "version.lib")

#define RUNTIME_DIR L"runtime"
#define RUNTIME_ZIP  L"qtwebengine_runtime.zip"
#define RUNTIME_MARKER L"runtime\\runtime_ready.marker"
#define RELEASE_URL_LATEST L"https://github.com/SunMe1977/DiskRaptor/releases/latest/download/qtwebengine_runtime.zip"
#define APP_EXE     L"DiskRaptor.exe"

#define IDC_DL_STATUS   1001
#define IDC_DL_PROGRESS 1002

struct DownloadUiState {
    HWND hwnd = NULL;
    HWND status = NULL;
    HWND progress = NULL;
    BOOL connected = FALSE;
    BOOL marquee = TRUE;
};

LRESULT CALLBACK DownloadUiWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (msg == WM_NCCREATE) {
        const CREATESTRUCTW *cs = reinterpret_cast<const CREATESTRUCTW*>(lParam);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
        return TRUE;
    }

    DownloadUiState *ui = reinterpret_cast<DownloadUiState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    switch (msg) {
    case WM_CLOSE:
        // Prevent accidental close while runtime setup is in progress.
        return 0;
    case WM_CTLCOLORSTATIC:
        if (ui && reinterpret_cast<HWND>(lParam) == ui->status) {
            HDC hdc = reinterpret_cast<HDC>(wParam);
            SetBkMode(hdc, TRANSPARENT);
            if (ui->connected) {
                SetTextColor(hdc, RGB(0, 128, 0));
            } else {
                SetTextColor(hdc, RGB(60, 60, 60));
            }
            return reinterpret_cast<LRESULT>(GetSysColorBrush(COLOR_WINDOW));
        }
        break;
    default:
        break;
    }

    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

void PumpDownloadUiMessages() {
    MSG msg;
    while (PeekMessageW(&msg, NULL, 0, 0, PM_REMOVE)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
}

BOOL InitDownloadUi(DownloadUiState &ui) {
    INITCOMMONCONTROLSEX icex = { sizeof(INITCOMMONCONTROLSEX), ICC_PROGRESS_CLASS };
    InitCommonControlsEx(&icex);

    static const wchar_t *kClassName = L"DiskRaptorDownloadUiWindow";
    static BOOL classRegistered = FALSE;
    if (!classRegistered) {
        WNDCLASSW wc = {};
        wc.lpfnWndProc = DownloadUiWndProc;
        wc.hInstance = GetModuleHandleW(NULL);
        wc.hCursor = LoadCursor(NULL, IDC_ARROW);
        wc.hIcon = LoadIcon(NULL, IDI_INFORMATION);
        wc.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
        wc.lpszClassName = kClassName;
        if (!RegisterClassW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
            return FALSE;
        }
        classRegistered = TRUE;
    }

    ui.hwnd = CreateWindowExW(
        WS_EX_DLGMODALFRAME,
        kClassName,
        L"DiskRaptor - Runtime Download",
        WS_CAPTION | WS_SYSMENU,
        CW_USEDEFAULT,
        CW_USEDEFAULT,
        520,
        180,
        NULL,
        NULL,
        GetModuleHandleW(NULL),
        &ui);
    if (!ui.hwnd) {
        return FALSE;
    }

    CreateWindowExW(
        0,
        L"STATIC",
        L"Preparing runtime setup...",
        WS_CHILD | WS_VISIBLE,
        20,
        20,
        470,
        24,
        ui.hwnd,
        NULL,
        GetModuleHandleW(NULL),
        NULL);

    ui.status = CreateWindowExW(
        0,
        L"STATIC",
        L"Connecting to server...",
        WS_CHILD | WS_VISIBLE,
        20,
        52,
        470,
        24,
        ui.hwnd,
        reinterpret_cast<HMENU>(IDC_DL_STATUS),
        GetModuleHandleW(NULL),
        NULL);

    ui.progress = CreateWindowExW(
        0,
        PROGRESS_CLASSW,
        NULL,
        WS_CHILD | WS_VISIBLE | PBS_SMOOTH | PBS_MARQUEE,
        20,
        92,
        470,
        26,
        ui.hwnd,
        reinterpret_cast<HMENU>(IDC_DL_PROGRESS),
        GetModuleHandleW(NULL),
        NULL);

    SendMessageW(ui.progress, PBM_SETMARQUEE, TRUE, 35);
    ShowWindow(ui.hwnd, SW_SHOW);
    UpdateWindow(ui.hwnd);
    PumpDownloadUiMessages();
    return TRUE;
}

void UpdateDownloadUiMessage(DownloadUiState *ui, LPCWSTR text) {
    if (!ui || !ui->status) return;
    SetWindowTextW(ui->status, text);
    InvalidateRect(ui->status, NULL, TRUE);
    UpdateWindow(ui->status);
    PumpDownloadUiMessages();
}

void UpdateDownloadUiConnected(DownloadUiState *ui, BOOL connected) {
    if (!ui) return;
    ui->connected = connected;
    if (ui->status) {
        InvalidateRect(ui->status, NULL, TRUE);
        UpdateWindow(ui->status);
    }
    PumpDownloadUiMessages();
}

void UpdateDownloadUiProgress(DownloadUiState *ui, ULONGLONG downloaded, ULONGLONG total) {
    if (!ui || !ui->progress) return;

    if (total > 0) {
        if (ui->marquee) {
            SendMessageW(ui->progress, PBM_SETMARQUEE, FALSE, 0);
            ui->marquee = FALSE;
            SendMessageW(ui->progress, PBM_SETRANGE32, 0, 1000);
            SendMessageW(ui->progress, PBM_SETSTATE, PBST_NORMAL, 0);
        }

        ULONGLONG scaled = (downloaded * 1000ULL) / total;
        if (scaled > 1000ULL) scaled = 1000ULL;
        SendMessageW(ui->progress, PBM_SETPOS, static_cast<WPARAM>(scaled), 0);

        wchar_t status[256];
        int pct = static_cast<int>((downloaded * 100ULL) / total);
        StringCchPrintfW(status, 256, L"Connected. Downloading runtime... %d%%", pct);
        UpdateDownloadUiMessage(ui, status);
        UpdateDownloadUiConnected(ui, TRUE);
    } else {
        if (!ui->marquee) {
            SendMessageW(ui->progress, PBM_SETMARQUEE, TRUE, 35);
            ui->marquee = TRUE;
        }
        UpdateDownloadUiMessage(ui, L"Connected. Downloading runtime...");
        UpdateDownloadUiConnected(ui, TRUE);
    }
}

void CloseDownloadUi(DownloadUiState *ui) {
    if (ui && ui->hwnd) {
        DestroyWindow(ui->hwnd);
        ui->hwnd = NULL;
        ui->status = NULL;
        ui->progress = NULL;
    }
}

// ── Download file via HTTPS ──────────────────────────────────
BOOL DownloadFile(LPCWSTR url, LPCWSTR destPath, DownloadUiState *ui) {
    HINTERNET hNet = InternetOpenW(L"DiskRaptorLauncher", INTERNET_OPEN_TYPE_PRECONFIG, NULL, NULL, 0);
    if (!hNet) return FALSE;

    if (ui) {
        UpdateDownloadUiMessage(ui, L"Connecting to server...");
        UpdateDownloadUiConnected(ui, FALSE);
    }

    HINTERNET hUrl = InternetOpenUrlW(hNet, url, NULL, 0, INTERNET_FLAG_RELOAD | INTERNET_FLAG_NO_CACHE_WRITE, 0);
    if (!hUrl) { InternetCloseHandle(hNet); return FALSE; }

    DWORD contentLength = 0;
    DWORD lenSize = sizeof(contentLength);
    BOOL hasContentLength = HttpQueryInfoW(
        hUrl,
        HTTP_QUERY_CONTENT_LENGTH | HTTP_QUERY_FLAG_NUMBER,
        &contentLength,
        &lenSize,
        NULL);

    HANDLE hFile = CreateFileW(destPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) { InternetCloseHandle(hUrl); InternetCloseHandle(hNet); return FALSE; }

    BYTE buf[65536];
    DWORD read;
    ULONGLONG downloaded = 0;
    BOOL ok = TRUE;
    while (InternetReadFile(hUrl, buf, sizeof(buf), &read) && read > 0) {
        DWORD written;
        ok = WriteFile(hFile, buf, read, &written, NULL);
        if (!ok) break;

        downloaded += written;
        if (ui) {
            UpdateDownloadUiProgress(
                ui,
                downloaded,
                (hasContentLength && contentLength > 0) ? static_cast<ULONGLONG>(contentLength) : 0ULL);
        }
        PumpDownloadUiMessages();
    }

    CloseHandle(hFile);
    InternetCloseHandle(hUrl);
    InternetCloseHandle(hNet);

    if (ok && ui) {
        UpdateDownloadUiProgress(ui, 1, 1);
        UpdateDownloadUiMessage(ui, L"Download complete. Preparing extraction...");
    }

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
                pCountItems->get_Count(&itemCount);
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

    // Require both WebEngine and OpenGL runtime DLLs
    WCHAR dllPath[MAX_PATH];
    StringCchCopyW(dllPath, MAX_PATH, runtimePath);
    StringCchCatW(dllPath, MAX_PATH, L"\\Qt6WebEngineCore.dll");
    if (GetFileAttributesW(dllPath) == INVALID_FILE_ATTRIBUTES)
        return FALSE;

    StringCchCopyW(dllPath, MAX_PATH, runtimePath);
    StringCchCatW(dllPath, MAX_PATH, L"\\Qt6OpenGL.dll");
    if (GetFileAttributesW(dllPath) == INVALID_FILE_ATTRIBUTES)
        return FALSE;

    return TRUE;
}

BOOL RuntimeMarkerExists(LPCWSTR baseDir) {
    WCHAR markerPath[MAX_PATH];
    StringCchCopyW(markerPath, MAX_PATH, baseDir);
    StringCchCatW(markerPath, MAX_PATH, L"\\");
    StringCchCatW(markerPath, MAX_PATH, RUNTIME_MARKER);
    return (GetFileAttributesW(markerPath) != INVALID_FILE_ATTRIBUTES);
}

BOOL GetFileVersionU64(LPCWSTR filePath, ULONGLONG *outVersion) {
    if (!outVersion) return FALSE;

    DWORD handle = 0;
    DWORD size = GetFileVersionInfoSizeW(filePath, &handle);
    if (size == 0) return FALSE;

    BYTE *buf = (BYTE*)HeapAlloc(GetProcessHeap(), 0, size);
    if (!buf) return FALSE;

    BOOL ok = FALSE;
    VS_FIXEDFILEINFO *ffi = NULL;
    UINT ffiLen = 0;

    if (GetFileVersionInfoW(filePath, 0, size, buf) &&
        VerQueryValueW(buf, L"\\", (LPVOID*)&ffi, &ffiLen) &&
        ffi && ffiLen >= sizeof(VS_FIXEDFILEINFO)) {
        *outVersion = ((ULONGLONG)ffi->dwFileVersionMS << 32) | ffi->dwFileVersionLS;
        ok = TRUE;
    }

    HeapFree(GetProcessHeap(), 0, buf);
    return ok;
}

BOOL RuntimeVersionMatches(LPCWSTR baseDir) {
    WCHAR coreQtPath[MAX_PATH];
    WCHAR runtimeWebEnginePath[MAX_PATH];

    StringCchCopyW(coreQtPath, MAX_PATH, baseDir);
    StringCchCatW(coreQtPath, MAX_PATH, L"\\Qt6Core.dll");

    StringCchCopyW(runtimeWebEnginePath, MAX_PATH, baseDir);
    StringCchCatW(runtimeWebEnginePath, MAX_PATH, L"\\");
    StringCchCatW(runtimeWebEnginePath, MAX_PATH, RUNTIME_DIR);
    StringCchCatW(runtimeWebEnginePath, MAX_PATH, L"\\Qt6WebEngineCore.dll");

    ULONGLONG coreVer = 0;
    ULONGLONG runtimeVer = 0;
    if (!GetFileVersionU64(coreQtPath, &coreVer)) return FALSE;
    if (!GetFileVersionU64(runtimeWebEnginePath, &runtimeVer)) return FALSE;

    return coreVer == runtimeVer;
}

void DeleteRuntimeDirectory(LPCWSTR baseDir) {
    WCHAR runtimePath[MAX_PATH];
    StringCchCopyW(runtimePath, MAX_PATH, baseDir);
    StringCchCatW(runtimePath, MAX_PATH, L"\\");
    StringCchCatW(runtimePath, MAX_PATH, RUNTIME_DIR);

    if (GetFileAttributesW(runtimePath) == INVALID_FILE_ATTRIBUTES)
        return;

    WCHAR from[MAX_PATH + 2];
    ZeroMemory(from, sizeof(from));
    StringCchCopyW(from, MAX_PATH + 2, runtimePath);
    size_t len = 0;
    StringCchLengthW(from, MAX_PATH + 2, &len);
    from[len + 1] = L'\0';

    SHFILEOPSTRUCTW op = {0};
    op.wFunc = FO_DELETE;
    op.pFrom = from;
    op.fFlags = FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT;
    SHFileOperationW(&op);
}

void WriteRuntimeMarker(LPCWSTR baseDir) {
    WCHAR markerPath[MAX_PATH];
    StringCchCopyW(markerPath, MAX_PATH, baseDir);
    StringCchCatW(markerPath, MAX_PATH, L"\\");
    StringCchCatW(markerPath, MAX_PATH, RUNTIME_MARKER);

    HANDLE h = CreateFileW(markerPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h != INVALID_HANDLE_VALUE) {
        const char *msg = "runtime_ready\r\n";
        DWORD written = 0;
        WriteFile(h, msg, (DWORD)strlen(msg), &written, NULL);
        CloseHandle(h);
    }
}

// ── Get our own directory ────────────────────────────────────
void GetAppDir(LPWSTR buf, DWORD size) {
    GetModuleFileNameW(NULL, buf, size);
    WCHAR *p = wcsrchr(buf, L'\\');
    if (p) *p = 0;
}

// Configure environment so DiskRaptor.exe can resolve DLLs from the runtime directory.
BOOL ConfigureRuntimeEnvironment(LPCWSTR appDir) {
    WCHAR runtimeDir[MAX_PATH];
    StringCchCopyW(runtimeDir, MAX_PATH, appDir);
    StringCchCatW(runtimeDir, MAX_PATH, L"\\");
    StringCchCatW(runtimeDir, MAX_PATH, RUNTIME_DIR);

    if (!RuntimeExists(appDir))
        return FALSE;

    WCHAR oldPath[32767] = {0};
    DWORD oldLen = GetEnvironmentVariableW(L"PATH", oldPath, 32767);
    if (oldLen >= 32767)
        oldPath[0] = 0;

    WCHAR newPath[32767] = {0};
    StringCchCopyW(newPath, 32767, runtimeDir);
    StringCchCatW(newPath, 32767, L";");
    StringCchCatW(newPath, 32767, appDir);
    if (oldPath[0] != 0) {
        StringCchCatW(newPath, 32767, L";");
        StringCchCatW(newPath, 32767, oldPath);
    }
    SetEnvironmentVariableW(L"PATH", newPath);

    WCHAR webEngineProcessPath[MAX_PATH];
    StringCchCopyW(webEngineProcessPath, MAX_PATH, runtimeDir);
    StringCchCatW(webEngineProcessPath, MAX_PATH, L"\\QtWebEngineProcess.exe");
    SetEnvironmentVariableW(L"QTWEBENGINEPROCESS_PATH", webEngineProcessPath);

    WCHAR qmlPath[MAX_PATH];
    StringCchCopyW(qmlPath, MAX_PATH, runtimeDir);
    StringCchCatW(qmlPath, MAX_PATH, L"\\qml");
    SetEnvironmentVariableW(L"QML2_IMPORT_PATH", qmlPath);

    return TRUE;
}

// ── Entry point ──────────────────────────────────────────────
int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int) {
    WCHAR appDir[MAX_PATH];
    GetAppDir(appDir, MAX_PATH);

    BOOL runtimePresent = RuntimeExists(appDir);
    BOOL markerPresent = RuntimeMarkerExists(appDir);
    BOOL runtimeVersionOk = runtimePresent ? RuntimeVersionMatches(appDir) : FALSE;
    BOOL needRuntimeSetup = (!runtimePresent) || (!markerPresent) || (!runtimeVersionOk);

    // Check if runtime setup is needed
    if (needRuntimeSetup) {
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
        DeleteRuntimeDirectory(appDir);
        CreateDirectoryW(runtimeDir, NULL);

        // Always fetch runtime ZIP externally so the package remains out-of-band.
        WCHAR zipPath[MAX_PATH];
        StringCchCopyW(zipPath, MAX_PATH, appDir);
        StringCchCatW(zipPath, MAX_PATH, L"\\");
        StringCchCatW(zipPath, MAX_PATH, RUNTIME_ZIP);

        DownloadUiState downloadUi = {};
        InitDownloadUi(downloadUi);

        DeleteFileW(zipPath);
        BOOL downloaded = DownloadFile(RELEASE_URL_LATEST, zipPath, &downloadUi);

        CloseDownloadUi(&downloadUi);

        if (!downloaded) {
            MessageBoxW(NULL,
                L"Failed to get the WebEngine runtime package.\n"
                L"Please check your internet connection and try again.",
                L"DiskRaptor — Runtime Package Missing", MB_ICONERROR);
            return 1;
        }

        // Extract into runtime directory (shows progress dialog to user)
        if (!ExtractZip(zipPath, runtimeDir)) {
            MessageBoxW(NULL, L"Failed to extract the runtime package.", L"DiskRaptor", MB_ICONERROR);
            return 1;
        }

        if (!RuntimeVersionMatches(appDir)) {
            MessageBoxW(NULL,
                L"The downloaded WebEngine runtime version does not match this installer.\n"
                L"Please install the latest DiskRaptor build and try again.",
                L"DiskRaptor — Runtime Version Mismatch", MB_ICONERROR);
            return 1;
        }

        WriteRuntimeMarker(appDir);

        // Keep bundled/downloaded ZIP for future repairs.
    }

    ConfigureRuntimeEnvironment(appDir);

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
