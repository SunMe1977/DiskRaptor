// DiskRaptor — Platform-specific utilities implementation
#include "platform_utils.h"

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
