// DiskRaptor — IPC Bridge implementation
#include "ipcbridge.h"

#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QProcess>
#include <QStandardPaths>
#include <QStorageInfo>
#include <QDebug>
#include <QFileDialog>
#include <QApplication>
#include <QTimer>

#ifdef Q_OS_WIN
#include <windows.h>
#include <shellapi.h>
#endif

IpcBridge::IpcBridge(Scanner *scanner, QObject *parent)
    : QObject(parent), m_scanner(scanner)
{
}

QString IpcBridge::invoke(const QString &command, const QVariantMap &args)
{
    qDebug() << "[IPC] invoke:" << command << args;

    if (command == "get_home_dir") return getHomeDir();
    if (command == "pick_directory") return pickDirectory();
    if (command == "delete_path") return deletePath(args.value("path").toString());
    if (command == "open_explorer") return openExplorer(args.value("path").toString());
    if (command == "open_terminal") return openTerminal(args.value("path").toString());
    if (command == "open_properties") return openProperties(args.value("path").toString());
    if (command == "get_icon") return getIcon(args.value("path").toString(), args.value("isDir").toBool());
    if (command == "get_scan_progress") return getScanProgress();
    if (command == "get_scan_result") return getScanResult();
    if (command == "list_drives") return listDrives();
    if (command == "check_for_updates") return checkForUpdates();
    if (command == "find_duplicates") return findDuplicates(args.value("path").toString());

    if (command == "check_admin_needed") return checkAdminNeeded(args.value("path").toString());
    if (command == "restart_as_admin") return restartAsAdmin();

    // Frontend chunk/scan commands — stubs until full streaming is wired
    if (command == "get_chunk") {
        return resultToJson(true, QVariantMap{{"nodes", QJsonArray()}, {"index", 0}});
    }
    if (command == "get_children") {
        return resultToJson(true, QVariantMap{{"children", QJsonArray()}});
    }
    if (command == "release_scan") {
        return resultToJson(true, QVariantMap{{"status", "released"}});
    }
    if (command == "get_stats") {
        return resultToJson(true, QVariantMap{});
    }

    if (command == "start_scan") {
        QString path = args.value("path").toString();
        if (!path.isEmpty()) {
            m_scanId++;
            m_scanner->startScan(path);
            return resultToJson(true, QVariantMap{{"status", "started"}, {"scan_id", m_scanId}});
        }
        return resultToJson(false, QVariant(), "No path provided");
    }

    return resultToJson(false, QVariant(), "Unknown command: " + command);
}

QString IpcBridge::getHomeDir()
{
    return resultToJson(true, QDir::homePath());
}

QString IpcBridge::pickDirectory()
{
    QString dir = QFileDialog::getExistingDirectory(
        nullptr, "Select Directory to Scan", QDir::homePath());
    return resultToJson(true, dir);
}

QString IpcBridge::deletePath(const QString &path)
{
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
}

QString IpcBridge::openExplorer(const QString &path)
{
#ifdef Q_OS_WIN
    ShellExecuteW(0, L"open", L"explorer.exe",
                  (L"/select,\"" + path.toStdWString() + L"\"").c_str(), 0, SW_SHOW);
#elif defined(Q_OS_LINUX)
    QProcess::startDetached("xdg-open", {QFileInfo(path).dir().absolutePath()});
#endif
    return resultToJson(true);
}

QString IpcBridge::openTerminal(const QString &path)
{
    QString dir = QFileInfo(path).isDir() ? path : QFileInfo(path).dir().absolutePath();
#ifdef Q_OS_WIN
    QProcess::startDetached("cmd.exe", {"/k", "cd", "/d", dir});
#elif defined(Q_OS_LINUX)
    QProcess::startDetached("x-terminal-emulator", {"--working-directory", dir});
#endif
    return resultToJson(true);
}

QString IpcBridge::openProperties(const QString &path)
{
#ifdef Q_OS_WIN
    ShellExecuteW(0, L"properties", path.toStdWString().c_str(), 0, 0, SW_SHOW);
#else
    Q_UNUSED(path)
#endif
    return resultToJson(true);
}

QString IpcBridge::getIcon(const QString &path, bool isDir)
{
    Q_UNUSED(path)
    Q_UNUSED(isDir)
    // Return placeholder emoji icons
    return resultToJson(true, isDir ? "📁" : "📄");
}

QString IpcBridge::getScanProgress()
{
    auto progress = m_scanner->currentProgress();
    QJsonObject obj;
    // Snake_case keys matching frontend expectations
    obj["files_found"] = static_cast<qint64>(progress.filesFound);
    obj["dirs_found"] = static_cast<qint64>(progress.dirsFound);
    obj["is_running"] = progress.isRunning;
    obj["current_dir"] = progress.currentDir;
    obj["elapsed_secs"] = static_cast<qint64>(progress.elapsedSecs);
    // Phase: 0=scanning, 1=building tree, 2=chunking, 3=done
    obj["phase"] = progress.isRunning ? 0 : 3;
    return resultToJson(true, QJsonDocument(obj).toJson(QJsonDocument::Compact));
}

QString IpcBridge::getScanResult()
{
    auto scanResult = m_scanner->lastResult();

    // Build result in the format the frontend expects:
    // { "stats": { "total_files": N, "total_dirs": N, "total_size": N, "top_files": [...], ... }, "root_info": {...} }
    QJsonObject stats;
    stats["total_files"] = static_cast<qint64>(scanResult.totalFiles);
    stats["total_dirs"] = static_cast<qint64>(scanResult.totalDirs);
    stats["total_size"] = static_cast<qint64>(scanResult.totalSize);
    stats["scan_time_ms"] = scanResult.scanTimeMs;
    stats["scan_path"] = scanResult.scanPath;
    stats["size_human"] = formatBytes(scanResult.totalSize);
    stats["time_human"] = QString::number(scanResult.scanTimeMs / 1000.0, 'f', 2) + "s";

    // Top 50 files
    QJsonArray topFiles;
    int count = 0;
    for (const auto &entry : scanResult.topFiles) {
        if (count >= 50) break;
        QStringList parts = entry.split('|');
        if (parts.size() >= 2) {
            QJsonObject file;
            file["path"] = parts[0];
            qint64 size = parts[1].toLongLong();
            file["size"] = size;
            file["size_human"] = formatBytes(size);
            topFiles.append(file);
        }
        count++;
    }
    stats["top_files"] = topFiles;

    QJsonObject resultObj;
    resultObj["stats"] = stats;
    resultObj["scan_id"] = m_scanId;

    // Dummy root_info so tree loading works
    QJsonObject rootInfo;
    rootInfo["total_nodes"] = 0;
    rootInfo["total_chunks"] = 0;
    resultObj["root_info"] = rootInfo;

    return resultToJson(true, QJsonDocument(resultObj).toJson(QJsonDocument::Compact));
}

QString IpcBridge::listDrives()
{
    QJsonArray drives;
    for (const auto &storage : QStorageInfo::mountedVolumes()) {
        if (!storage.isValid() || storage.isReadOnly()) continue;
#ifdef Q_OS_WIN
        // Only show fixed drives and network drives on Windows
        QString path = storage.rootPath();
        if (!path.startsWith("C:") && !path.startsWith("D:") &&
            !path.startsWith("E:") && !path.startsWith("F:")) continue;
#endif
        QJsonObject drive;
        drive["path"] = storage.rootPath();
        drive["totalBytes"] = static_cast<qint64>(storage.bytesTotal());
        drive["freeBytes"] = static_cast<qint64>(storage.bytesAvailable());
        qint64 used = storage.bytesTotal() - storage.bytesAvailable();
        drive["usedBytes"] = static_cast<qint64>(used);
        drive["percentFull"] = storage.bytesTotal() > 0
            ? static_cast<double>(used) / storage.bytesTotal() * 100.0 : 0.0;
        drives.append(drive);
    }
    return resultToJson(true, QJsonDocument(drives).toJson(QJsonDocument::Compact));
}

QString IpcBridge::checkForUpdates()
{
    // Simple version check — in production, query GitHub releases API
    return resultToJson(true, "v0.5.0");
}

QString IpcBridge::findDuplicates(const QString &path)
{
    Q_UNUSED(path)
    // Placeholder: In production, implement file hash comparison
    return resultToJson(true, "[]");
}

QString IpcBridge::checkAdminNeeded(const QString &path)
{
    Q_UNUSED(path)
    // Admin prompt is handled at startup only — never prompt at scan time.
    return resultToJson(true, false);
}

QString IpcBridge::restartAsAdmin()
{
#ifdef Q_OS_WIN
    // On Windows, relaunch with ShellExecuteW using runas verb, then exit
    QString exePath = QApplication::applicationFilePath();
    HINSTANCE hResult = ShellExecuteW(nullptr, L"runas", exePath.toStdWString().c_str(),
                                      nullptr, nullptr, SW_SHOW);

    // ShellExecuteW returns a value > 32 on success, or an error code <= 32 on failure.
    INT_PTR ret = reinterpret_cast<INT_PTR>(hResult);
    if (ret <= 32) {
        // Elevation failed (user cancelled UAC or an error occurred)
        qWarning() << "[DiskRaptor] ShellExecuteW(runas) failed, code:" << ret;
        return resultToJson(false, QVariant(),
            "Failed to elevate privileges. Try running DiskRaptor as Administrator manually.");
    }

    // Use deferred quit so the QWebChannel IPC response is delivered to JavaScript
    // BEFORE the event loop exits. Direct QApplication::quit() inside the IPC
    // handler can prevent the response from reaching the frontend, leaving the
    // scan handler in an inconsistent state.
    QTimer::singleShot(0, qApp, &QApplication::quit);

    return resultToJson(true, QVariantMap{{"restarting", true}});
#else
    return resultToJson(false, QVariant(), "Not supported on this platform");
#endif
}

QString IpcBridge::resultToJson(bool success, const QVariant &data, const QString &error)
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
