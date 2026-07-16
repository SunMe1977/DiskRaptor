// DiskRaptor Qt 6 + QtWebEngine
// Main entry point â€” no GTK, no WebKitGTK, no GLib

#include <QApplication>
#include <QtWebEngineWidgets/qtwebenginewidgetsglobal.h>
#include <QWebEngineSettings>
#include <QWebEngineProfile>
#include <QDir>
#include <QStandardPaths>
#include <QMessageBox>
#include <QDebug>

#ifdef Q_OS_WIN
#include <windows.h>
#include <shellapi.h>
#endif

#include "webviewwindow.h"
#include "ipcbridge.h"
#include "platform_utils.h"

// ── Admin check at startup ──────────────────────────────────
// Pure Win32 check: if not running as admin, relaunch with runas verb, then exit.
// This handles direct DiskRaptor.exe launches (without the launcher).
static bool EnsureAdmin()
{
#ifdef Q_OS_WIN
    BOOL isAdmin = FALSE;
    HANDLE hToken = NULL;
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &hToken)) {
        TOKEN_ELEVATION elevation;
        DWORD size = sizeof(TOKEN_ELEVATION);
        if (GetTokenInformation(hToken, TokenElevation, &elevation, size, &size)) {
            isAdmin = elevation.TokenIsElevated;
        }
        CloseHandle(hToken);
    }

    if (isAdmin)
        return true;

    // Relaunch with runas verb
    WCHAR exePath[MAX_PATH];
    GetModuleFileNameW(NULL, exePath, MAX_PATH);

    SHELLEXECUTEINFOW sei = { sizeof(sei) };
    sei.lpVerb = L"runas";
    sei.lpFile = exePath;
    sei.nShow = SW_SHOWNORMAL;
    sei.fMask = SEE_MASK_NOASYNC | SEE_MASK_NOCLOSEPROCESS;

    if (ShellExecuteExW(&sei)) {
        if (sei.hProcess) {
            WaitForSingleObject(sei.hProcess, INFINITE);
            CloseHandle(sei.hProcess);
        }
    }
    return false;
#else
    return true;
#endif
}

int main(int argc, char *argv[])
{
    // Qt WebEngine is initialized automatically when QApplication is created
    // No manual QtWebEngine::initialize() needed in Qt 6.5+

    // Enable remote debugging for Playwright tests via env var
    // Set DISKraptor_CDP_PORT=9222 before launching to enable
    // Qt WebEngine DevTools on that port.
    qputenv("QTWEBENGINE_REMOTE_DEBUGGING", qgetenv("DISKraptor_CDP_PORT"));

    // Set up runtime environment (PATH, WebEngine vars) — required before QApplication
    // so Qt DLLs and WebEngine process resolve correctly without the launcher.
    PlatformUtils::setupRuntimeEnvironment();

    // Admin check: if not running as admin, relaunch with runas verb, then exit.
    // This handles direct DiskRaptor.exe launches (without the launcher).
    if (!EnsureAdmin()) {
        return 0;
    }

    QApplication app(argc, argv);
    app.setApplicationName("DiskRaptor");
    app.setApplicationVersion("0.0.7");
    app.setOrganizationName("DiskRaptor");

    // â”€â”€ WebEngine configuration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    auto *profile = QWebEngineProfile::defaultProfile();
    auto *settings = profile->settings();
    settings->setAttribute(QWebEngineSettings::WebGLEnabled, true);
    settings->setAttribute(QWebEngineSettings::Accelerated2dCanvasEnabled, true);
    settings->setAttribute(QWebEngineSettings::LocalContentCanAccessRemoteUrls, true);
    settings->setAttribute(QWebEngineSettings::ErrorPageEnabled, false);
    settings->setAttribute(QWebEngineSettings::JavascriptEnabled, true);
    settings->setAttribute(QWebEngineSettings::JavascriptCanOpenWindows, false);
    settings->setAttribute(QWebEngineSettings::LocalStorageEnabled, true);

    profile->setHttpCacheType(QWebEngineProfile::MemoryHttpCache);
    profile->setPersistentStoragePath(
        QStandardPaths::writableLocation(QStandardPaths::AppDataLocation) + "/webengine");

    // â”€â”€ Find frontend directory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    QString frontendPath;
    QStringList searchPaths = {
        QDir::currentPath(),
        QDir::currentPath() + "/frontend",
        QApplication::applicationDirPath(),
        QApplication::applicationDirPath() + "/frontend",
        QDir::currentPath() + "/../frontend",
        QApplication::applicationDirPath() + "/share/DiskRaptor/frontend",
        QApplication::applicationDirPath() + "/../share/DiskRaptor/frontend",
        QDir::currentPath() + "/share/DiskRaptor/frontend",
        QDir::currentPath() + "/../share/DiskRaptor/frontend",
    };

    for (const auto &path : searchPaths) {
        if (QDir(path).exists("index.html")) {
            frontendPath = QDir(path).absolutePath();
            break;
        }
    }

    if (frontendPath.isEmpty()) {
        QMessageBox::critical(nullptr, "DiskRaptor",
            "Frontend not found!\n\n"
            "Expected 'index.html' in one of:\n" +
            searchPaths.join("\n"));
        return 1;
    }

    qDebug() << "[DiskRaptor] Frontend:" << frontendPath;

    // â”€â”€ Create main window â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    MainWindow window(frontendPath);
    window.setWindowTitle("DiskRaptor " + app.applicationVersion());
    window.resize(1280, 860);
    window.showMaximized();

    qDebug() << "[DiskRaptor] Started successfully";

    return app.exec();
}
