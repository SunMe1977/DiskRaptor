// DiskRaptor -- IPC Bridge implementation
// Uses Rust scanner DLL (diskraptor_scanner.dll) for all scan operations.

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
#include <QCoreApplication>

#ifdef Q_OS_WIN
#include <windows.h>
#include <shellapi.h>
#endif

IpcBridge::IpcBridge(QObject *parent)
    : QObject(parent)
{
    if (!loadRustLibrary()) {
        qWarning() << "[DiskRaptor] Failed to load Rust scanner library --"
                    << "scan functionality will be unavailable.";
    }
}

IpcBridge::~IpcBridge()
{
    unloadRustLibrary();
}

QString IpcBridge::invoke(const QString &command, const QVariantMap &args)
{
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
    if (command == "save_settings") return saveSettings(args);
    if (command == "load_settings") return loadSettings();

    if (command == "get_chunk") {
        if (!m_drGetChunk) {
            return resultToJson(false, QVariant(), "Rust scanner not loaded");
        }
        uint32_t chunkIndex = static_cast<uint32_t>(args.value("chunkIndex", 0).toUInt());
        char* cjson = m_drGetChunk(chunkIndex);
        if (!cjson) {
            return resultToJson(false, QVariant(), "null chunk");
        }
        QString jsonStr = QString::fromUtf8(cjson);
        m_drFreeString(cjson);
        QJsonDocument doc = QJsonDocument::fromJson(jsonStr.toUtf8());
        if (!doc.isNull() && doc.isObject()) {
            return resultToJson(true, doc.object());
        }
        // Rust returned empty chunk — check if scan is done
        bool isRunning = m_drIsRunning ? m_drIsRunning() : false;
        if (!isRunning && chunkIndex == 0) {
            // Return synthetic root chunk
            QJsonObject rootNode;
            rootNode["name"] = m_lastScanPath.isEmpty() ? QStringLiteral("/") : m_lastScanPath;
            rootNode["size"] = 0;
            rootNode["file_count"] = 0;
            rootNode["node_type"] = "Directory";
            const qint64 u32max = static_cast<qint64>(4294967295u);
            rootNode["parent"] = u32max;
            rootNode["first_child"] = u32max;
            rootNode["next_sibling"] = u32max;
            rootNode["depth"] = 0;
            rootNode["chunk_id"] = 0;
            QJsonArray nodes;
            nodes.append(rootNode);
            QJsonObject chunk;
            chunk["chunk_id"] = 0;
            chunk["total_chunks"] = 1;
            chunk["total_nodes"] = 1;
            chunk["nodes"] = nodes;
            return resultToJson(true, chunk);
        }
        return resultToJson(false, QVariant(), "invalid chunk JSON");
    }
    if (command == "get_children") {
        return resultToJson(true, QVariantMap{{"children", QJsonArray()}});
    }
    if (command == "release_scan") {
        m_chunksJson.clear();
        return resultToJson(true, QVariantMap{{"status", "released"}});
    }
    if (command == "get_stats") {
        if (!m_chunksJson.isEmpty()) {
            QJsonDocument doc = QJsonDocument::fromJson(m_chunksJson.toUtf8());
            if (!doc.isNull() && doc.isObject()) {
                QJsonObject obj = doc.object();
                if (obj.contains("stats")) {
                    return resultToJson(true, obj["stats"].toObject());
                }
            }
        }
        return resultToJson(true, QVariantMap{});
    }

    if (command == "start_scan") {
        QString path = QDir::toNativeSeparators(args.value("path").toString());
        if (!path.isEmpty()) {
            m_scanId++;
            m_lastScanPath = path;
            if (!m_drStartScan) {
                return resultToJson(false, QVariant(), "Rust scanner not loaded");
            }
            QByteArray pathUtf8 = path.toUtf8();
            char* result = m_drStartScan(pathUtf8.constData());
            QString jsonResult;
            if (result) {
                jsonResult = QString::fromUtf8(result);
                m_drFreeString(result);
            }
            QJsonDocument doc = QJsonDocument::fromJson(jsonResult.toUtf8());
            int rustScanId = m_scanId;
            if (!doc.isNull() && doc.isObject()) {
                QJsonObject obj = doc.object();
                if (obj.contains("scan_id")) {
                    rustScanId = obj["scan_id"].toInt();
                }
                if (obj.contains("success") && !obj["success"].toBool()) {
                    QString err = obj["error"].toString();
                    return resultToJson(false, QVariant(), err);
                }
            }
            return resultToJson(true, QVariantMap{{"status", "started"}, {"scan_id", rustScanId}});
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
    return resultToJson(true, isDir ? QLatin1String(":folder:") : QLatin1String(":file:"));
}

QString IpcBridge::getScanProgress()
{
    if (!m_drGetProgress) {
        return resultToJson(false, QVariant(), "Rust scanner not loaded");
    }

    char* cjson = m_drGetProgress();
    if (!cjson) {
        return resultToJson(false, QVariant(), "null progress");
    }

    QString jsonStr = QString::fromUtf8(cjson);
    m_drFreeString(cjson);

    return "{\"success\":true,\"data\":" + jsonStr + "}";
}

QString IpcBridge::getScanResult()
{
    if (!m_drGetResult) {
        return resultToJson(false, QVariant(), "Rust scanner not loaded");
    }

    char* cjson = m_drGetResult();
    if (!cjson) {
        return resultToJson(false, QVariant(), "null result");
    }

    QString jsonStr = QString::fromUtf8(cjson);
    m_drFreeString(cjson);

    QJsonDocument doc = QJsonDocument::fromJson(jsonStr.toUtf8());

    // If result is ready, return it
    if (!doc.isNull() && doc.isObject()) {
        QJsonObject obj = doc.object();
        if (!obj.isEmpty() && obj.contains("stats")) {
            QJsonObject resultObj;
            resultObj["stats"] = obj["stats"];
            if (obj.contains("root_info")) {
                resultObj["root_info"] = obj["root_info"];
            }
            resultObj["scan_id"] = m_scanId;
            m_chunksJson = jsonStr;
            QJsonObject wrapper;
            wrapper["success"] = true;
            wrapper["data"] = resultObj;
            return QString::fromUtf8(QJsonDocument(wrapper).toJson(QJsonDocument::Compact));
        }
    }

    // Rust result not ready — check if scan thread exited (crash/panic)
    bool isRunning = m_drIsRunning ? m_drIsRunning() : false;
    if (!isRunning) {
        // Scan thread exited without setting result — use last progress data
        QString progressJson = getScanProgress();
        QJsonDocument pdoc = QJsonDocument::fromJson(progressJson.toUtf8());
        if (!pdoc.isNull() && pdoc.isObject()) {
            QJsonObject pobj = pdoc.object();
            if (pobj.contains("data")) {
                QJsonObject data = pobj["data"].toObject();
                qint64 files = static_cast<qint64>(data["files_found"].toDouble());
                qint64 dirs = static_cast<qint64>(data["dirs_found"].toDouble());
                qint64 elapsed = static_cast<qint64>(data["elapsed_secs"].toDouble());
                QJsonObject stats;
                stats["total_files"] = files;
                stats["total_dirs"] = dirs;
                stats["total_size"] = 0;
                stats["scan_time_ms"] = elapsed * 1000;
                stats["top_files"] = QJsonArray();
                stats["file_type_breakdown"] = QJsonArray();
                stats["size_human"] = "0 B";
                stats["time_human"] = QString::number(elapsed) + "s";
                QJsonObject ri;
                ri["root_index"] = 0;
                ri["total_nodes"] = files + dirs;
                ri["total_chunks"] = 1;
                QJsonObject resultObj;
                resultObj["stats"] = stats;
                resultObj["root_info"] = ri;
                resultObj["scan_id"] = m_scanId;
                QJsonObject wrapper;
                wrapper["success"] = true;
                wrapper["data"] = resultObj;
                return QString::fromUtf8(QJsonDocument(wrapper).toJson(QJsonDocument::Compact));
            }
        }
    }

    return resultToJson(false, QVariant(), "result not ready yet");
}

QString IpcBridge::listDrives()
{
    QJsonArray drives;
    for (const auto &storage : QStorageInfo::mountedVolumes()) {
        if (!storage.isValid() || storage.isReadOnly()) continue;
        QString path = storage.rootPath();
        // Determine drive type for icon
        QString driveType = "local";
        if (path.startsWith("A:") || path.startsWith("B:")) driveType = "floppy";
        else if (storage.fileSystemType().contains("FAT") || storage.fileSystemType().contains("NTFS")) {
            // Check if removable
            #ifdef Q_OS_WIN
            UINT type = GetDriveTypeW((LPCWSTR)path.toStdWString().c_str());
            if (type == DRIVE_REMOVABLE) driveType = "usb";
            else if (type == DRIVE_CDROM) driveType = "dvd";
            else if (type == DRIVE_RAMDISK) driveType = "ram";
            else if (type == DRIVE_FIXED && path.startsWith("C:")) driveType = "system";
            #endif
        }
        QJsonObject drive;
        drive["path"] = path;
        drive["name"] = storage.name().isEmpty() ? path.left(2) : storage.name();
        drive["type"] = driveType;
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
    return resultToJson(true, "v0.5.0");
}

QString IpcBridge::findDuplicates(const QString &path)
{
    Q_UNUSED(path)
    return resultToJson(true, "[]");
}

QString IpcBridge::checkAdminNeeded(const QString &path)
{
    Q_UNUSED(path)
    return resultToJson(true, false);
}

QString IpcBridge::restartAsAdmin()
{
#ifdef Q_OS_WIN
    QString exePath = QApplication::applicationFilePath();
    HINSTANCE hResult = ShellExecuteW(nullptr, L"runas", exePath.toStdWString().c_str(),
                                      nullptr, nullptr, SW_SHOW);
    INT_PTR ret = reinterpret_cast<INT_PTR>(hResult);
    if (ret <= 32) {
        qWarning() << "[DiskRaptor] ShellExecuteW(runas) failed, code:" << ret;
        return resultToJson(false, QVariant(),
            "Failed to elevate privileges. Try running DiskRaptor as Administrator manually.");
    }
    QTimer::singleShot(0, qApp, &QApplication::quit);
    return resultToJson(true, QVariantMap{{"restarting", true}});
#else
    return resultToJson(false, QVariant(), "Not supported on this platform");
#endif
}

// -- Rust scanner loading (cross-platform via QLibrary) -------

bool IpcBridge::loadRustLibrary()
{
    QStringList searchPaths;
    searchPaths << QCoreApplication::applicationDirPath()
                << ".";

    // Different names on different platforms
    QStringList libNames;
#ifdef Q_OS_WIN
    libNames << "diskraptor_scanner.dll" << "diskraptor_scanner";
#elif defined(Q_OS_MACOS)
    libNames << "libdiskraptor_scanner.dylib" << "diskraptor_scanner";
#else
    libNames << "libdiskraptor_scanner.so" << "diskraptor_scanner";
#endif

    for (const QString &dir : searchPaths) {
        for (const QString &name : libNames) {
            QString fullPath = dir + "/" + name;
            if (QFile::exists(fullPath)) {
                m_rustLib = new QLibrary(fullPath);
                if (m_rustLib->load()) {
                    qDebug() << "[DiskRaptor] Loaded Rust scanner from:" << fullPath;
                    break;
                } else {
                    delete m_rustLib;
                    m_rustLib = nullptr;
                }
            }
        }
        if (m_rustLib && m_rustLib->isLoaded()) break;
    }

    if (!m_rustLib || !m_rustLib->isLoaded()) {
        // Try loading by name only (system library path)
        m_rustLib = new QLibrary("diskraptor_scanner");
        if (!m_rustLib->load()) {
            qWarning() << "[DiskRaptor] Failed to load Rust scanner library:" << m_rustLib->errorString();
            delete m_rustLib;
            m_rustLib = nullptr;
            return false;
        }
    }

    m_drStartScan   = reinterpret_cast<FnStartScan>(m_rustLib->resolve("dr_start_scan"));
    m_drGetProgress = reinterpret_cast<FnGetProgress>(m_rustLib->resolve("dr_get_progress"));
    m_drGetResult   = reinterpret_cast<FnGetResult>(m_rustLib->resolve("dr_get_result"));
    m_drGetChunk    = reinterpret_cast<FnGetChunk>(m_rustLib->resolve("dr_get_chunk"));
    m_drCancelScan  = reinterpret_cast<FnCancelScan>(m_rustLib->resolve("dr_cancel_scan"));
    m_drIsRunning   = reinterpret_cast<FnIsRunning>(m_rustLib->resolve("dr_is_running"));
    m_drFreeString  = reinterpret_cast<FnFreeString>(m_rustLib->resolve("dr_free_string"));

    int missing = 0;
    if (!m_drStartScan)   { qWarning() << "[DiskRaptor] Missing dr_start_scan";   missing++; }
    if (!m_drGetProgress) { qWarning() << "[DiskRaptor] Missing dr_get_progress"; missing++; }
    if (!m_drGetResult)   { qWarning() << "[DiskRaptor] Missing dr_get_result";   missing++; }
    if (!m_drGetChunk)    { qWarning() << "[DiskRaptor] Missing dr_get_chunk";    missing++; }
    if (!m_drCancelScan)  { qWarning() << "[DiskRaptor] Missing dr_cancel_scan";  missing++; }
    if (!m_drIsRunning)   { qWarning() << "[DiskRaptor] Missing dr_is_running";   missing++; }
    if (!m_drFreeString)  { qWarning() << "[DiskRaptor] Missing dr_free_string";  missing++; }

    if (missing > 0) {
        qWarning() << "[DiskRaptor] Rust scanner loaded but" << missing << "symbols missing";
        m_rustLib->unload();
        delete m_rustLib;
        m_rustLib = nullptr;
        return false;
    }

    qDebug() << "[DiskRaptor] Rust scanner loaded successfully with all symbols.";
    return true;
}

void IpcBridge::unloadRustLibrary()
{
    if (m_rustLib) {
        m_rustLib->unload();
        delete m_rustLib;
        m_rustLib = nullptr;
        m_drStartScan = nullptr;
        m_drGetProgress = nullptr;
        m_drGetResult = nullptr;
        m_drGetChunk = nullptr;
        m_drCancelScan = nullptr;
        m_drIsRunning = nullptr;
        m_drFreeString = nullptr;
    }
}

QString IpcBridge::saveSettings(const QVariantMap &settings)
{
    QSettings ini("DiskRaptor", "DiskRaptor");
    for (auto it = settings.begin(); it != settings.end(); ++it) {
        ini.setValue(it.key(), it.value());
    }
    ini.sync();
    return resultToJson(true, QVariantMap{{"saved", true}});
}

QString IpcBridge::loadSettings()
{
    QSettings ini("DiskRaptor", "DiskRaptor");
    QVariantMap all;
    for (const auto &key : ini.allKeys()) {
        all[key] = ini.value(key);
    }
    return resultToJson(true, all);
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
