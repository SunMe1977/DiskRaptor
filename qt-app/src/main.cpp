// DiskRaptor Qt 6 + QtWebEngine
// Main entry point â€” no GTK, no WebKitGTK, no GLib

#include <QApplication>
#include <QtWebEngineWidgets/qtwebenginewidgetsglobal.h>
#include <QWebEngineSettings>
#include <QWebEngineProfile>
#include <QDir>
#include <QStandardPaths>
#include <QMessageBox>
#include <QIcon>
#include <QDebug>

#ifdef Q_OS_WIN
#include <windows.h>
#include <shellapi.h>
#endif

#include "webviewwindow.h"
#include "ipcbridge.h"
#include "platform_utils.h"

// ── Admin check at startup ──────────────────────────────────
// Logs admin status but lets the app start regardless.
// Users can right-click → If not running as admin, ask the user whether to elevate.
// Passes DISKraptor_CDP_PORT as command-line argument to preserve it.
static bool EnsureAdmin(int argc, char *argv[])
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

    if (isAdmin) {
        qDebug() << "[DiskRaptor] Running as Administrator";
    } else {
        qDebug() << "[DiskRaptor] NOT running as Administrator (some paths may be inaccessible)";
    }
    return true; // Always continue, no elevation prompt
#else
    return true;
#endif
}

int main(int argc, char *argv[])
{
    // Qt WebEngine is initialized automatically when QApplication is created
    // No manual QtWebEngine::initialize() needed in Qt 6.5+

    // Enable remote debugging for Playwright tests via env var or --cdp-port arg
    QByteArray cdpPort = qgetenv("DISKraptor_CDP_PORT");
    for (int i = 1; i < argc; i++) {
        QString arg = QString::fromLocal8Bit(argv[i]);
        if (arg.startsWith("--cdp-port=")) {
            cdpPort = arg.mid(QString("--cdp-port=").length()).toUtf8();
            break;
        }
    }
    bool isTestMode = !cdpPort.isEmpty();

    // Ask user if they want to run as Administrator (skip in CDP/test mode)
    if (!isTestMode && !EnsureAdmin(argc, argv)) {
        return 0; // User chose to restart as admin; exit this instance
    }

    if (!cdpPort.isEmpty()) {
        qputenv("QTWEBENGINE_REMOTE_DEBUGGING", cdpPort);
    }

    QApplication app(argc, argv);

    // Set up runtime environment — needs QApplication initialized
    PlatformUtils::setupRuntimeEnvironment();
    app.setApplicationName("DiskRaptor");
    app.setApplicationVersion("0.0.7");
    app.setOrganizationName("DiskRaptor");
#ifdef Q_OS_LINUX
    app.setDesktopFileName("diskraptor");
#endif

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
        QApplication::applicationDirPath() + "/../Resources/frontend",
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
    QIcon appIcon;
    // Try loading from filesystem first (works on all platforms)
    // Icon file is always named 128x128@2x.png on all platforms for simplicity
    QString iconFile = "128x128@2x.png";
    QStringList iconPaths = {
        QApplication::applicationDirPath() + "/images/" + iconFile,
        QApplication::applicationDirPath() + "/images/icon.ico",
        QApplication::applicationDirPath() + "/../images/" + iconFile,
        QApplication::applicationDirPath() + "/../images/icon.ico",
        QApplication::applicationDirPath() + "/../Resources/images/" + iconFile,
        QApplication::applicationDirPath() + "/../share/icons/hicolor/128x128/apps/diskraptor.png",
        QDir::currentPath() + "/images/" + iconFile,
        frontendPath + "/../images/" + iconFile,
#ifdef Q_OS_LINUX
        // Flatpak / Snap paths
        "/app/share/icons/hicolor/128x128/apps/diskraptor.png",
        "/usr/local/share/icons/hicolor/128x128/apps/diskraptor.png",
        "/usr/share/icons/hicolor/128x128/apps/diskraptor.png",
#endif
        ":/app.png",
        ":/app.ico",
    };
    for (const auto &p : iconPaths) {
        appIcon = QIcon(p);
        if (!appIcon.isNull()) {
            qDebug() << "[DiskRaptor] Loaded icon from:" << p;
            break;
        }
    }
#ifdef Q_OS_LINUX
    if (appIcon.isNull()) {
        appIcon = QIcon::fromTheme("diskraptor");
        if (!appIcon.isNull()) {
            qDebug() << "[DiskRaptor] Loaded icon from theme: diskraptor";
        }
    }
#endif
    if (!appIcon.isNull()) {
        window.setWindowIcon(appIcon);
        app.setWindowIcon(appIcon);
    }
    window.resize(1280, 860);
    window.showMaximized();

    qDebug() << "[DiskRaptor] Started successfully";

    return app.exec();
}
