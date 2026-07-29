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

#ifdef __cplusplus
extern "C" bool macosMoveToTrash(const char *path);
#endif

FileOpsHandler::FileOpsHandler(QObject *parent)
    : QObject(parent)
{
}

QString FileOpsHandler::deletePath(const QString &path)
{
    QString nativePath = QDir::toNativeSeparators(path);
#ifdef Q_OS_WIN
    // Use SHFileOperationW to move to Recycle Bin
    SHFILEOPSTRUCTW op = {};
    std::wstring wPath = nativePath.toStdWString();
    // SHFileOperation requires double-null-terminated string
    std::vector<wchar_t> buf(wPath.begin(), wPath.end());
    buf.push_back(L'\0');
    buf.push_back(L'\0');
    op.hwnd = nullptr;
    op.wFunc = FO_DELETE;
    op.pFrom = buf.data();
    op.pTo = nullptr;
    op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI;
    int result = SHFileOperationW(&op);
    if (result != 0 || op.fAnyOperationsAborted) {
        return resultToJson(false, QVariant(), "Failed to move to Trash: " + path + " (error: " + QString::number(result) + ")");
    }
    return resultToJson(true);
#elif defined(Q_OS_MACOS)
    if (macosMoveToTrash(QDir::fromNativeSeparators(path).toUtf8().constData()))
        return resultToJson(true);
    // Fallback: try AppleScript
    QString escaped = QString(path).replace("\\", "\\\\").replace("\"", "\\\"");
    QProcess proc;
    proc.start("osascript", {"-e", "tell app \"Finder\" to delete POSIX file \"" + escaped + "\""});
    proc.waitForFinished(10000);
    if (proc.exitCode() == 0)
        return resultToJson(true);
    QString err = QString::fromUtf8(proc.readAllStandardError()).trimmed();
    return resultToJson(false, QVariant(), "Failed to move to Trash: " + path + " (" + err + ")");
#else
    // Linux: try gio trash first, fallback to permanent delete
    QProcess proc;
    proc.start("gio", {"trash", path});
    proc.waitForFinished(5000);
    if (proc.exitCode() == 0)
        return resultToJson(true);
    QDir dir(path);
    bool ok = false;
    if (QFileInfo(path).isDir()) {
        ok = dir.removeRecursively();
    } else {
        ok = QFile::remove(path);
    }
    if (!ok) {
        return resultToJson(false, QVariant(), "Failed to move to Trash: " + path);
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
