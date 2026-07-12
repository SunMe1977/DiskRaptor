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
    // Qt WebEngine is initialized automatically when QApplication is created
    // No manual QtWebEngine::initialize() needed in Qt 6.5+

    QApplication app(argc, argv);
    app.setApplicationName("DiskRaptor");
    app.setApplicationVersion("0.2.6");
    app.setOrganizationName("DiskRaptor");

    // ── WebEngine configuration ──────────────────────────────
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

    // ── Find frontend directory ──────────────────────────────
    QString frontendPath;
    QStringList searchPaths = {
        QDir::currentPath() + "/frontend",
        QApplication::applicationDirPath() + "/frontend",
        QDir::currentPath() + "/../frontend",
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

    qDebug() << "[DiskRaptor] Started successfully";

    return app.exec();
}
