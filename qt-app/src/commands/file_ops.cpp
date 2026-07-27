// DiskRaptor — File operations handler implementation
#include "file_ops.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QProcess>
#include <QStandardPaths>
#include <QJsonDocument>
#include <QJsonObject>

#ifdef Q_OS_WIN
#include <windows.h>
#include <shellapi.h>
#endif

FileOpsHandler::FileOpsHandler(QObject *parent)
    : QObject(parent)
{
}

QString FileOpsHandler::deletePath(const QString &path)
{
#ifdef Q_OS_MACOS
    QString posixPath = QDir::fromNativeSeparators(path);
    QString escaped = QString(posixPath).replace("\\", "\\\\").replace("\"", "\\\"");
    QProcess proc;
    proc.start("osascript", {"-e", "tell app \"Finder\" to delete POSIX file \"" + escaped + "\""});
    proc.waitForFinished(10000);
    if (proc.exitCode() != 0) {
        QString err = QString::fromUtf8(proc.readAllStandardError()).trimmed();
        return resultToJson(false, QVariant(), "Failed to move to Trash: " + path + " (" + err + ")");
    }
    return resultToJson(true);
#else
    QDir dir(path);
    bool ok = false;
    if (QFileInfo(path).isDir()) {
        ok = dir.removeRecursively();
    } else {
        ok = QFile::remove(path);
    }
    if (!ok) {
        return resultToJson(false, QVariant(), "Failed to delete: " + path);
    }
    return resultToJson(true);
#endif
}

QString FileOpsHandler::openExplorer(const QString &path)
{
#ifdef Q_OS_WIN
    ShellExecuteW(0, L"open", L"explorer.exe",
                  (L"/select,\"" + path.toStdWString() + L"\"").c_str(), 0, SW_SHOW);
#elif defined(Q_OS_MACOS)
    QProcess::startDetached("open", {"-R", path});
#elif defined(Q_OS_LINUX)
    QProcess::startDetached("xdg-open", {QFileInfo(path).dir().absolutePath()});
#endif
    return resultToJson(true);
}

QString FileOpsHandler::openTerminal(const QString &path)
{
    QString dir = QFileInfo(path).isDir() ? path : QFileInfo(path).dir().absolutePath();
#ifdef Q_OS_WIN
    QProcess::startDetached("cmd.exe", {"/k", "cd", "/d", dir});
#elif defined(Q_OS_MACOS)
    QProcess::startDetached("open", {"-a", "Terminal", dir});
#elif defined(Q_OS_LINUX)
    bool started = false;
    auto tryStart = [&](const QString &program, const QStringList &args, bool useWorkingDir = false) -> bool {
        if (QStandardPaths::findExecutable(program).isEmpty()) {
            return false;
        }
        if (useWorkingDir) {
            return QProcess::startDetached(program, args, dir);
        }
        return QProcess::startDetached(program, args);
    };

    started = started || tryStart("x-terminal-emulator", {}, true);
    started = started || tryStart("gnome-terminal", {"--working-directory=" + dir});
    started = started || tryStart("konsole", {"--workdir", dir});
    started = started || tryStart("xfce4-terminal", {"--working-directory", dir});
    started = started || tryStart("mate-terminal", {"--working-directory", dir});
    started = started || tryStart("alacritty", {"--working-directory", dir});
    started = started || tryStart("kitty", {"--directory", dir});
    started = started || tryStart("xterm", {"-e", "sh", "-lc", "cd \"" + dir + "\" && exec ${SHELL:-/bin/sh}"});

    if (!started) {
        return resultToJson(false, QVariant(), "No terminal emulator found on Linux");
    }
#endif
    return resultToJson(true);
}

QString FileOpsHandler::openProperties(const QString &path)
{
#ifdef Q_OS_WIN
    ShellExecuteW(0, L"properties", path.toStdWString().c_str(), 0, 0, SW_SHOW);
#else
    Q_UNUSED(path)
#endif
    return resultToJson(true);
}

QString FileOpsHandler::getIcon(const QString &path, bool isDir)
{
    Q_UNUSED(path)
    Q_UNUSED(isDir)
    return resultToJson(true, isDir ? QLatin1String(":folder:") : QLatin1String(":file:"));
}

QString FileOpsHandler::deletePermanent(const QString &path)
{
    QFileInfo fi(path);
    bool ok = false;
    if (fi.isDir()) {
        QDir dir(path);
        ok = dir.removeRecursively();
    } else {
        ok = QFile::remove(path);
    }
    if (!ok) {
        return resultToJson(false, QVariant(), "Failed to delete: " + path);
    }
    return resultToJson(true);
}

QString FileOpsHandler::resultToJson(bool success, const QVariant &data, const QString &error)
{
    QJsonObject obj;
    obj["success"] = success;
    if (data.isValid()) {
        if (data.typeId() == QMetaType::QString) {
            obj["data"] = data.toString();
        } else {
            obj["data"] = QJsonValue::fromVariant(data);
        }
    }
    if (!error.isEmpty()) {
        obj["error"] = error;
    }
    return QString::fromUtf8(QJsonDocument(obj).toJson(QJsonDocument::Compact));
}
