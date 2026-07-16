// DiskRaptor — Platform-specific utilities implementation
#include "platform_utils.h"

#include <QCoreApplication>
#include <QDir>
#include <QFileInfo>
#include <QProcess>
#include <QStandardPaths>
#include <QThread>
#include <QDebug>
#include <QStorageInfo>

#ifdef Q_OS_WIN
#include <windows.h>
#include <shellapi.h>
#endif

QString PlatformUtils::appDataPath()
{
    return QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
}

QStringList PlatformUtils::listDrives()
{
    QStringList drives;
    for (const auto &storage : QStorageInfo::mountedVolumes()) {
        if (storage.isValid()) {
            drives.append(storage.rootPath());
        }
    }
    return drives;
}

bool PlatformUtils::showInExplorer(const QString &path)
{
#ifdef Q_OS_WIN
    HINSTANCE result = ShellExecuteW(nullptr, L"open", L"explorer.exe",
        (L"/select,\"" + path.toStdWString() + L"\"").c_str(),
        nullptr, SW_SHOWNORMAL);
    return reinterpret_cast<INT_PTR>(result) > 32;
#else
    QString dir = QFileInfo(path).isDir() ? path : QFileInfo(path).absolutePath();
    return QProcess::startDetached("xdg-open", {dir});
#endif
}

bool PlatformUtils::openTerminal(const QString &dir)
{
#ifdef Q_OS_WIN
    return QProcess::startDetached("cmd.exe", {"/k", "cd", "/d", dir});
#else
    return QProcess::startDetached("x-terminal-emulator",
        {"--working-directory", dir});
#endif
}

bool PlatformUtils::showProperties(const QString &path)
{
#ifdef Q_OS_WIN
    HINSTANCE result = ShellExecuteW(nullptr, L"properties",
        path.toStdWString().c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    return reinterpret_cast<INT_PTR>(result) > 32;
#else
    Q_UNUSED(path)
    return false;
#endif
}

QString PlatformUtils::homeDir()
{
    return QDir::homePath();
}

int PlatformUtils::cpuThreadCount()
{
    return QThread::idealThreadCount();
}

QString PlatformUtils::platformName()
{
#ifdef Q_OS_WIN
    return "Windows";
#elif defined(Q_OS_LINUX)
    return "Linux";
#elif defined(Q_OS_MACOS)
    return "macOS";
#else
    return "Unknown";
#endif
}

// Find the runtime directory: look for runtime\Qt6WebEngineCore.dll relative to the exe.
static QString findRuntimeDir()
{
    QString appDir = QCoreApplication::applicationDirPath();
    QStringList candidates = {
        appDir + "/runtime",
        QDir::currentPath() + "/runtime",
    };
    for (const auto &dir : candidates) {
        if (QFileInfo::exists(dir + "/Qt6WebEngineCore.dll")) {
            return QDir(dir).absolutePath();
        }
    }
    return QString();
}

bool PlatformUtils::setupRuntimeEnvironment()
{
    QString appDir = QCoreApplication::applicationDirPath();
    QString runtimeDir = findRuntimeDir();

    if (runtimeDir.isEmpty()) {
        qDebug() << "[DiskRaptor] Runtime directory not found (no runtime/Qt6WebEngineCore.dll)";
        return false;
    }

    qDebug() << "[DiskRaptor] Runtime dir:" << runtimeDir;

    // 1. PATH: prepend runtimeDir and appDir so DLLs resolve
    QString oldPath = QString::fromLocal8Bit(qgetenv("PATH"));
    QString newPath = runtimeDir + ";" + appDir;
    if (!oldPath.isEmpty())
        newPath += ";" + oldPath;
    qputenv("PATH", newPath.toLocal8Bit());

    // 2. QTWEBENGINEPROCESS_PATH
    QString webEngineProc = runtimeDir + "/QtWebEngineProcess.exe";
    if (QFileInfo::exists(webEngineProc)) {
        qputenv("QTWEBENGINEPROCESS_PATH", webEngineProc.toLocal8Bit());
    }

    // 3. QML2_IMPORT_PATH — prefer runtime/qml, fallback appDir/qml
    QString qmlPath = runtimeDir + "/qml";
    if (QFileInfo::exists(qmlPath)) {
        qputenv("QML2_IMPORT_PATH", qmlPath.toLocal8Bit());
    } else {
        QString appQmlPath = appDir + "/qml";
        if (QFileInfo::exists(appQmlPath)) {
            qputenv("QML2_IMPORT_PATH", appQmlPath.toLocal8Bit());
        }
    }

    // 4. QTWEBENGINE_RESOURCES_PATH — runtime/resources
    QString resourcesPath = runtimeDir + "/resources";
    if (QFileInfo::exists(resourcesPath)) {
        qputenv("QTWEBENGINE_RESOURCES_PATH", resourcesPath.toLocal8Bit());
    }

    // 5. QTWEBENGINE_LOCALES_PATH — runtime/qtwebengine_locales, fallback appDir/translations/qtwebengine_locales
    QString localesPath = runtimeDir + "/qtwebengine_locales";
    if (QFileInfo::exists(localesPath)) {
        qputenv("QTWEBENGINE_LOCALES_PATH", localesPath.toLocal8Bit());
    } else {
        QString fallbackPath = appDir + "/translations/qtwebengine_locales";
        if (QFileInfo::exists(fallbackPath)) {
            qputenv("QTWEBENGINE_LOCALES_PATH", fallbackPath.toLocal8Bit());
        }
    }

    qDebug() << "[DiskRaptor] Runtime environment configured";
    return true;
}
