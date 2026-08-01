#include <QApplication>
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
#include "platform_utils.h"
#include "cdp_server.h"

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
    return true;
#else
    return true;
#endif
}

int main(int argc, char *argv[])
{
    if (!EnsureAdmin(argc, argv)) {
        return 0;
    }

    QApplication app(argc, argv);

    PlatformUtils::setupRuntimeEnvironment();
    app.setApplicationName("DiskRaptor");
    app.setApplicationVersion("1.0.8");
    app.setOrganizationName("DiskRaptor");
#ifdef Q_OS_LINUX
    app.setDesktopFileName("diskraptor");
#endif

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
        QApplication::applicationDirPath() + "/../share/diskraptor/frontend",
        "/usr/share/DiskRaptor/frontend",
        "/usr/share/diskraptor/frontend",
        "/usr/local/share/DiskRaptor/frontend",
        "/usr/local/share/diskraptor/frontend",
        "/opt/DiskRaptor/frontend",
        "/opt/diskraptor/frontend",
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

    MainWindow window(frontendPath);
    window.setWindowTitle("DiskRaptor " + app.applicationVersion());
    QIcon appIcon;
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
    window.setMinimumSize(1024, 600);
    window.resize(1280, 860);
    window.showMaximized();

    qDebug() << "[DiskRaptor] Started successfully";

    // Start CDP server for Playwright tests (if DISKraptor_CDP_PORT is set)
    QByteArray cdpPortEnv = qgetenv("DISKraptor_CDP_PORT");
    CdpServer *cdpServer = nullptr;
    if (!cdpPortEnv.isEmpty()) {
        bool ok = false;
        quint16 port = cdpPortEnv.toUShort(&ok);
        if (ok && port > 0) {
            cdpServer = new CdpServer(window.webView(), port, frontendPath, &app);
        }
    }

    return app.exec();
}
