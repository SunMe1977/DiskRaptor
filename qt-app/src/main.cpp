// DiskRaptor Qt 6 + QtWebEngine
// Main entry point — no GTK, no WebKitGTK, no GLib

#include <QApplication>
#include <QtWebEngineWidgets/qtwebenginewidgetsglobal.h>
#include <QWebEngineSettings>
#include <QWebEngineProfile>
#include <QDir>
#include <QStandardPaths>
#include <QMessageBox>
#include <QDebug>

#include "webviewwindow.h"
#include "ipcbridge.h"

int main(int argc, char *argv[])
{
    // Initialize Qt WebEngine (must be called before QApplication)
    // This initializes the Chromium sandbox and GPU process
    QtWebEngine::initialize();

    QApplication app(argc, argv);
    app.setApplicationName("DiskRaptor");
    app.setApplicationVersion("0.2.6");
    app.setOrganizationName("DiskRaptor");

    // ── WebEngine configuration ──────────────────────────────
    // Enable GPU acceleration (disabled for software rendering fallback)
    auto *globalSettings = QWebEngineSettings::globalSettings();
    globalSettings->setAttribute(QWebEngineSettings::WebGLEnabled, true);
    globalSettings->setAttribute(QWebEngineSettings::Accelerated2dCanvasEnabled, true);
    globalSettings->setAttribute(QWebEngineSettings::LocalContentCanAccessRemoteUrls, true);
    globalSettings->setAttribute(QWebEngineSettings::ErrorPageEnabled, false);
    globalSettings->setAttribute(QWebEngineSettings::PluginsEnabled, false);
    globalSettings->setAttribute(QWebEngineSettings::JavascriptEnabled, true);
    globalSettings->setAttribute(QWebEngineSettings::JavascriptCanOpenWindows, false);
    globalSettings->setAttribute(QWebEngineSettings::LocalStorageEnabled, true);

    // Custom profile for persistent storage
    auto *profile = QWebEngineProfile::defaultProfile();
    profile->setHttpCacheType(QWebEngineProfile::MemoryHttpCache);
    profile->setPersistentStoragePath(
        QStandardPaths::writableLocation(QStandardPaths::AppDataLocation) + "/webengine");

    // ── Find frontend directory ──────────────────────────────
    QString frontendPath;
    QStringList searchPaths = {
        QDir::currentPath() + "/frontend",                    // Running from build dir
        QApplication::applicationDirPath() + "/frontend",      // Running from install dir
        QDir::currentPath() + "/../frontend",                  // Development layout
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

    // ── Create main window ───────────────────────────────────
    MainWindow window(frontendPath);
    window.setWindowTitle("DiskRaptor " + app.applicationVersion());
    window.resize(1280, 860);
    window.showMaximized();

    qDebug() << "[DiskRaptor] Started successfully (Qt" << Qt6_VERSION << ")";

    return app.exec();
}
