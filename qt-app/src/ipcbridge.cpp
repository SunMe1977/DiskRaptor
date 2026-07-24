// DiskRaptor -- IPC Bridge implementation
// Uses Rust scanner DLL (diskraptor_scanner.dll) for all scan operations.

#include "ipcbridge.h"

#include <QDir>
#include <QFile>
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
#include <QDirIterator>
#include <QThread>
#include <QMutex>
#include <QDateTime>
#include <QAtomicInteger>
#include <atomic>

#ifdef Q_OS_LINUX
#include <QFile>
#include <QTextStream>
#endif

#ifdef Q_OS_WIN
#include <windows.h>
#include <shellapi.h>
#include <psapi.h>
#endif

#ifdef Q_OS_MACOS
#include <sys/sysctl.h>
#include <mach/mach.h>
#include <mach/vm_statistics.h>
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
    cppCancelDupScan();
    cppCancelScan();
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
    if (command == "get_dup_stats") return getDupStats();
    if (command == "get_dup_result") return getDupResult();
    if (command == "cancel_dup_scan") { cppCancelDupScan(); return resultToJson(true, QVariantMap{{"status", "cancelled"}}); }
    if (command == "check_admin_needed") return checkAdminNeeded(args.value("path").toString());
    if (command == "restart_as_admin") return restartAsAdmin();
    if (command == "save_settings") return saveSettings(args);
    if (command == "load_settings") return loadSettings();
    if (command == "get_memory_info") return getMemoryInfo();
    if (command == "get_process_memory") return getProcessMemory();
    if (command == "cancel_scan") {
        if (m_drCancelScan) {
            m_drCancelScan();
            return resultToJson(true, QVariantMap{{"status", "cancelled"}});
        }
        cppCancelScan();
        return resultToJson(true, QVariantMap{{"status", "cancelled"}});
    }

    if (command == "get_chunk") {
        uint32_t chunkIndex = static_cast<uint32_t>(args.value("chunkIndex", 0).toUInt());

        // Try Rust scanner first
        if (m_drGetChunk) {
            char* cjson = m_drGetChunk(chunkIndex);
            if (cjson) {
                QString jsonStr = QString::fromUtf8(cjson);
                m_drFreeString(cjson);
                QJsonDocument doc = QJsonDocument::fromJson(jsonStr.toUtf8());
                if (!doc.isNull() && doc.isObject()) {
                    return resultToJson(true, doc.object());
                }

                // Fallback: decode chunk from cached Rust result payload.
                if (!m_chunksJson.isEmpty()) {
                    QJsonDocument fullDoc = QJsonDocument::fromJson(m_chunksJson.toUtf8());
                    if (!fullDoc.isNull() && fullDoc.isObject()) {
                        QJsonObject fullObj = fullDoc.object();
                        if (fullObj.contains("chunks")) {
                            QString chunksRaw;
                            if (fullObj.value("chunks").isString()) {
                                chunksRaw = fullObj.value("chunks").toString();
                            } else if (fullObj.value("chunks").isArray()) {
                                chunksRaw = QString::fromUtf8(
                                    QJsonDocument(fullObj.value("chunks").toArray()).toJson(QJsonDocument::Compact));
                            }
                            if (!chunksRaw.isEmpty()) {
                                QJsonDocument chunksDoc = QJsonDocument::fromJson(chunksRaw.toUtf8());
                                if (!chunksDoc.isNull() && chunksDoc.isArray()) {
                                    QJsonArray chunks = chunksDoc.array();
                                    if (chunkIndex < static_cast<uint32_t>(chunks.size()) && chunks[static_cast<int>(chunkIndex)].isObject()) {
                                        return resultToJson(true, chunks[static_cast<int>(chunkIndex)].toObject());
                                    }
                                }
                            }
                        }
                    }
                }

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
            }
        }

        // C++ fallback: return flat root chunk with stats but no tree
        if (chunkIndex == 0) {
            QMutexLocker lock(&m_cppMutex);
            QJsonArray nodes;

            QJsonObject rootNode;
            rootNode["name"] = m_cppScanPath.isEmpty() ? (m_lastScanPath.isEmpty() ? QStringLiteral("/") : m_lastScanPath) : m_cppScanPath;
            rootNode["size"] = static_cast<qint64>(m_cppBytesFound);
            rootNode["file_count"] = static_cast<qint64>(m_cppFilesFound);
            rootNode["dir_count"] = static_cast<qint64>(m_cppDirsFound);
            rootNode["node_type"] = 0;
            rootNode["parent"] = static_cast<qint64>(4294967295u);
            rootNode["first_child"] = static_cast<qint64>(4294967295u);
            rootNode["next_sibling"] = static_cast<qint64>(4294967295u);
            rootNode["depth"] = 0;
            rootNode["chunk_id"] = 0;
            nodes.append(rootNode);

            QJsonObject chunk;
            chunk["chunk_id"] = 0;
            chunk["total_chunks"] = 1;
            chunk["total_nodes"] = 1;
            chunk["nodes"] = nodes;
            return resultToJson(true, chunk);
        }
        return resultToJson(false, QVariant(), "invalid chunk");
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
        bool followLinks = args.value("follow_symlinks", false).toBool();
        quint64 timeoutSecs = args.value("timeout_secs", 0).toULongLong();
        if (!path.isEmpty()) {
            m_scanId++;
            m_lastScanPath = path;
            if (m_drStartScan) {
                // Pass options as JSON config string
                QJsonObject config;
                config["path"] = path;
                config["follow_symlinks"] = followLinks;
                config["timeout_secs"] = static_cast<qint64>(timeoutSecs);
                QByteArray configUtf8 = QString::fromUtf8(
                    QJsonDocument(config).toJson(QJsonDocument::Compact)).toUtf8();
                char* result = m_drStartScan(configUtf8.constData());
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
            } else {
                // Fallback to C++ scanner
                qDebug() << "[DiskRaptor] Using C++ fallback scanner for:" << path;
                cppStartScan(path);
                return resultToJson(true, QVariantMap{{"status", "started"}, {"scan_id", m_cppScanId}});
            }
        }
        return resultToJson(false, QVariant(), "No path provided");
    }

    return resultToJson(false, QVariant(), "Unknown command: " + command);
}

QString IpcBridge::getHomeDir()
{
    return resultToJson(true, QDir::homePath());
}

QString IpcBridge::getMemoryInfo()
{
#ifdef Q_OS_WIN
    MEMORYSTATUSEX mem;
    mem.dwLength = sizeof(mem);
    if (GlobalMemoryStatusEx(&mem)) {
        quint64 total = static_cast<quint64>(mem.ullTotalPhys);
        quint64 avail = static_cast<quint64>(mem.ullAvailPhys);
        quint64 used = total - avail;
        return resultToJson(true, QVariantMap{
            {"total_bytes", static_cast<qint64>(total)},
            {"used_bytes", static_cast<qint64>(used)},
            {"avail_bytes", static_cast<qint64>(avail)},
            {"percent_used", static_cast<double>(used) / total * 100.0},
        });
    }
#elif defined(Q_OS_MACOS)
    // macOS: use sysctl
    int mib[2] = {CTL_HW, HW_MEMSIZE};
    quint64 total = 0;
    size_t len = sizeof(total);
    if (sysctl(mib, 2, &total, &len, nullptr, 0) == 0) {
        // Get used memory via vm_statistics
        vm_statistics64_data_t vm_stat;
        mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
        mach_port_t host = mach_host_self();
        if (host_statistics64(host, HOST_VM_INFO64, (host_info64_t)&vm_stat, &count) == KERN_SUCCESS) {
            quint64 pageSize = static_cast<quint64>(vm_page_size);
            quint64 freeMem = static_cast<quint64>(vm_stat.free_count + vm_stat.inactive_count) * pageSize;
            quint64 used = total - freeMem;
            return resultToJson(true, QVariantMap{
                {"total_bytes", static_cast<qint64>(total)},
                {"used_bytes", static_cast<qint64>(used)},
                {"avail_bytes", static_cast<qint64>(freeMem)},
                {"percent_used", static_cast<double>(used) / total * 100.0},
            });
        }
    }
#else
    // Linux: read /proc/meminfo
    QFile f("/proc/meminfo");
    if (f.open(QIODevice::ReadOnly)) {
        QTextStream in(&f);
        quint64 total = 0, avail = 0;
        while (!in.atEnd()) {
            QString line = in.readLine();
            if (line.startsWith("MemTotal:"))
                total = line.section(' ', -2, -2).toULongLong() * 1024;
            else if (line.startsWith("MemAvailable:"))
                avail = line.section(' ', -2, -2).toULongLong() * 1024;
        }
        if (total > 0) {
            quint64 used = total - avail;
            return resultToJson(true, QVariantMap{
                {"total_bytes", static_cast<qint64>(total)},
                {"used_bytes", static_cast<qint64>(used)},
                {"avail_bytes", static_cast<qint64>(avail)},
                {"percent_used", static_cast<double>(used) / total * 100.0},
            });
        }
    }
#endif
    return resultToJson(true, QVariantMap{
        {"total_bytes", 0}, {"used_bytes", 0}, {"avail_bytes", 0}, {"percent_used", 0},
    });
}

QString IpcBridge::getProcessMemory()
{
#ifdef Q_OS_WIN
    PROCESS_MEMORY_COUNTERS pmc;
    if (GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc))) {
        return resultToJson(true, QVariantMap{
            {"resident_bytes", static_cast<qint64>(pmc.WorkingSetSize)},
            {"private_bytes", static_cast<qint64>(pmc.PagefileUsage)},
            {"virtual_bytes", static_cast<qint64>(pmc.PagefileUsage)},
        });
    }
#elif defined(Q_OS_MACOS)
    struct mach_task_basic_info info;
    mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
    if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO, (task_info_t)&info, &count) == KERN_SUCCESS) {
        return resultToJson(true, QVariantMap{
            {"resident_bytes", static_cast<qint64>(info.resident_size)},
            {"private_bytes", static_cast<qint64>(info.resident_size)},
        });
    }
#else
    QFile f("/proc/self/status");
    if (f.open(QIODevice::ReadOnly)) {
        QTextStream in(&f);
        quint64 vmRSS = 0;
        while (!in.atEnd()) {
            QString line = in.readLine();
            if (line.startsWith("VmRSS:")) {
                vmRSS = line.section(' ', -2, -2).toULongLong() * 1024;
                break;
            }
        }
        if (vmRSS > 0) {
            return resultToJson(true, QVariantMap{
                {"resident_bytes", static_cast<qint64>(vmRSS)},
                {"private_bytes", static_cast<qint64>(vmRSS)},
            });
        }
    }
#endif
    return resultToJson(true, QVariantMap{{"resident_bytes", 0}, {"private_bytes", 0}});
}

QString IpcBridge::pickDirectory()
{
    // Use active window as parent for proper dialog modality on all platforms
    QWidget *parent = QApplication::activeWindow();
    QString dir = QFileDialog::getExistingDirectory(
        parent, "Select Directory to Scan", QDir::homePath(),
        QFileDialog::ShowDirsOnly | QFileDialog::DontResolveSymlinks);
    if (dir.isEmpty()) {
        // User cancelled - return empty result
        return resultToJson(true, QVariant());
    }
    return resultToJson(true, QDir::toNativeSeparators(dir));
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
#elif defined(Q_OS_MACOS)
    QProcess::startDetached("open", {"-R", path});
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
    if (m_drGetProgress) {
        char* cjson = m_drGetProgress();
        if (!cjson) {
            return resultToJson(false, QVariant(), "null progress");
        }
        QString jsonStr = QString::fromUtf8(cjson);
        m_drFreeString(cjson);
        return "{\"success\":true,\"data\":" + jsonStr + "}";
    }
    // C++ fallback
    return cppGetProgressJson();
}

QString IpcBridge::getScanResult()
{
    if (m_drGetResult) {
        char* cjson = m_drGetResult();
        if (!cjson) {
            return resultToJson(false, QVariant(), "null result");
        }
        QString jsonStr = QString::fromUtf8(cjson);
        m_drFreeString(cjson);
        QJsonDocument doc = QJsonDocument::fromJson(jsonStr.toUtf8());
        if (!doc.isNull() && doc.isObject()) {
            QJsonObject obj = doc.object();
            if (!obj.isEmpty() && obj.contains("stats")) {
                QJsonObject resultObj;
                resultObj["stats"] = obj["stats"];
                if (obj.contains("root_info")) {
                    resultObj["root_info"] = obj["root_info"];
                }
                if (obj.contains("chunks")) {
                    resultObj["chunks"] = obj["chunks"];
                }
                resultObj["scan_id"] = m_scanId;
                m_chunksJson = jsonStr;
                QJsonObject wrapper;
                wrapper["success"] = true;
                wrapper["data"] = resultObj;
                return QString::fromUtf8(QJsonDocument(wrapper).toJson(QJsonDocument::Compact));
            }
        }
        // Rust result fallback...
        bool isRunning = m_drIsRunning ? m_drIsRunning() : false;
        if (!isRunning) {
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
                    ri["root_index"] = 0; ri["total_nodes"] = files + dirs; ri["total_chunks"] = 1;
                    QJsonObject resultObj;
                    resultObj["stats"] = stats; resultObj["root_info"] = ri; resultObj["scan_id"] = m_scanId;
                    QJsonObject wrapper;
                    wrapper["success"] = true; wrapper["data"] = resultObj;
                    return QString::fromUtf8(QJsonDocument(wrapper).toJson(QJsonDocument::Compact));
                }
            }
        }
        return resultToJson(false, QVariant(), "result not ready yet");
    }
    // C++ fallback
    return cppGetResultJson();
}

QString IpcBridge::listDrives()
{
    QJsonArray drives;
    for (const auto &storage : QStorageInfo::mountedVolumes()) {
        if (!storage.isValid()) continue;
        // Skip ephemeral/synthetic volumes but keep root and system data volumes
        QString path = storage.rootPath();
#ifdef Q_OS_MACOS
        if (storage.isReadOnly() && path != "/" && !path.startsWith("/System/Volumes/Data")) continue;
#else
        if (storage.isReadOnly()) continue;
#endif
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
    if (m_dupRunning) {
        return resultToJson(false, QVariant(), "Duplicate scan already running");
    }
    cppStartDupScan(path);
    return resultToJson(true, QVariantMap{{"status", "started"}});
}

QString IpcBridge::getDupStats()
{
    return cppGetDupStatsJson();
}

QString IpcBridge::getDupResult()
{
    QMutexLocker lock(&m_dupMutex);
    if (m_dupRunning) {
        return resultToJson(false, QVariant(), "Scan still in progress");
    }
    if (m_dupResultJson.isEmpty()) {
        return resultToJson(false, QVariant(), "No result available");
    }
    return resultToJson(true, m_dupResultJson);
}

QString IpcBridge::cppGetDupStatsJson()
{
    QMutexLocker lock(&m_dupMutex);
    QJsonObject obj;
    obj["filesScanned"] = static_cast<qint64>(m_dupFilesScanned);
    obj["groups"] = static_cast<qint64>(m_dupGroups);
    obj["wastedBytes"] = static_cast<qint64>(m_dupWastedBytes);
    obj["currentFile"] = m_dupCurrentFile;
    obj["phase"] = m_dupRunning ? 1 : (m_dupPhase);
    return resultToJson(true, obj);
}

static QString formatSize(quint64 b);
static quint64 quickHashFile(const QString &path);

void IpcBridge::cppStartDupScan(const QString &path)
{
    cppCancelDupScan();
    int scanId;
    {
        QMutexLocker lock(&m_dupMutex);
        scanId = ++m_dupScanId;
        m_dupRunning = true;
        m_dupCancelled = false;
        m_dupFilesScanned = 0;
        m_dupGroups = 0;
        m_dupWastedBytes = 0;
        m_dupCurrentFile.clear();
        m_dupPhase = 1;
        m_dupResultJson.clear();
    }

    m_dupThread = QThread::create([this, path, scanId]() {
        quint64 total = 0;

        // Phase 1: walk files, group by size
        QHash<quint64, QVector<QString>> sizeGroups;
        QDirIterator it(path, QDir::Files | QDir::NoDotAndDotDot, QDirIterator::Subdirectories);
        while (it.hasNext()) {
            if (m_dupCancelled) break;
            QString fp = it.next();
            QFileInfo fi = it.fileInfo();
            quint64 sz = static_cast<quint64>(fi.size());
            total++;
            {
                QMutexLocker lock(&m_dupMutex);
                m_dupFilesScanned = total;
                m_dupCurrentFile = fp;
            }
            sizeGroups[sz].append(fp);
        }

        if (m_dupCancelled) {
            QMutexLocker lock(&m_dupMutex);
            if (m_dupScanId == scanId) {
                m_dupPhase = 0;
                m_dupRunning = false;
            }
            return;
        }

        // Phase 2: hash same-size groups
        {
            QMutexLocker lock(&m_dupMutex);
            if (m_dupScanId == scanId) m_dupPhase = 2;
        }
        QJsonArray dupGroups;
        quint64 wastedTotal = 0;
        for (auto it = sizeGroups.begin(); it != sizeGroups.end(); ++it) {
            if (m_dupCancelled) break;
            auto &files = it.value();
            quint64 size = it.key();
            if (files.size() < 2) continue;

            QHash<quint64, QVector<QString>> hashGroups;
            for (const auto &fp : files) {
                if (m_dupCancelled) break;
                {
                    QMutexLocker lock(&m_dupMutex);
                    m_dupCurrentFile = fp;
                }
                quint64 h = quickHashFile(fp);
                hashGroups[h].append(fp);
            }

            for (auto hit = hashGroups.begin(); hit != hashGroups.end(); ++hit) {
                if (hit.value().size() < 2) continue;
                quint64 wasted = size * (static_cast<quint64>(hit.value().size()) - 1);
                wastedTotal += wasted;
                QJsonArray filesArr;
                for (const auto &fp : hit.value()) {
                    filesArr.append(fp);
                }
                QJsonObject g;
                g["size"] = static_cast<qint64>(size);
                g["sizeHuman"] = formatSize(size);
                g["count"] = static_cast<int>(hit.value().size());
                g["wasted"] = static_cast<qint64>(wasted);
                g["wastedHuman"] = formatSize(wasted);
                g["files"] = filesArr;
                dupGroups.append(g);
            }

            {
                QMutexLocker lock(&m_dupMutex);
                if (m_dupScanId == scanId) {
                    m_dupGroups = static_cast<quint64>(dupGroups.size());
                    m_dupWastedBytes = wastedTotal;
                }
            }
        }

        QJsonObject result;
        result["groups"] = dupGroups;
        result["totalFilesScanned"] = static_cast<qint64>(total);
        result["totalGroups"] = static_cast<int>(dupGroups.size());
        result["totalDuplicates"] = static_cast<qint64>(dupGroups.size());
        result["wastedBytes"] = static_cast<qint64>(wastedTotal);
        result["wastedHuman"] = formatSize(wastedTotal);

        {
            QMutexLocker lock(&m_dupMutex);
            if (m_dupScanId == scanId) {
                m_dupResultJson = QString::fromUtf8(QJsonDocument(result).toJson(QJsonDocument::Compact));
                m_dupPhase = 3;
                m_dupRunning = false;
            }
        }
    });
    connect(m_dupThread, &QThread::finished, m_dupThread, &QObject::deleteLater);
    m_dupThread->start();
}

void IpcBridge::cppCancelDupScan()
{
    m_dupCancelled = true;
    if (m_dupThread) {
        m_dupThread->disconnect();
        m_dupThread->wait(500);
        if (m_dupThread->isFinished()) delete m_dupThread;
    }
    m_dupThread = nullptr;
    {
        QMutexLocker lock(&m_dupMutex);
        m_dupPhase = 0;
        m_dupRunning = false;
    }
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
                << "."
                << QDir::currentPath()
                << QCoreApplication::applicationDirPath() + "/.."
                << QCoreApplication::applicationDirPath() + "/../.."
                << QCoreApplication::applicationDirPath() + "/../../src-tauri/target/release"
                << QCoreApplication::applicationDirPath() + "/../../../src-tauri/target/release"
                << QDir::currentPath() + "/src-tauri/target/release"
                << QDir::currentPath() + "/../src-tauri/target/release"
                << QDir::currentPath() + "/../../src-tauri/target/release"
                // qt-app/build/ or qt-app/build/Release when running from Qt Creator
                << QCoreApplication::applicationDirPath() + "/../../src-tauri/target/release"
                << QDir::currentPath() + "/../../../src-tauri/target/release";

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
            qDebug() << "[DiskRaptor] Looking for scanner at:" << fullPath << "exists:" << QFile::exists(fullPath);
            if (QFile::exists(fullPath)) {
                m_rustLib = new QLibrary(fullPath);
                if (m_rustLib->load()) {
                    qDebug() << "[DiskRaptor] Loaded Rust scanner from:" << fullPath;
                    break;
                } else {
                    qWarning() << "[DiskRaptor] Found but FAILED to load:" << fullPath << "error:" << m_rustLib->errorString();
                    delete m_rustLib;
                    m_rustLib = nullptr;
                }
            }
        }
        if (m_rustLib && m_rustLib->isLoaded()) break;
    }

    if (!m_rustLib || !m_rustLib->isLoaded()) {
        // Try current directory and parent of app dir (Linux project root)
        QStringList fallbackPaths = {".", QCoreApplication::applicationDirPath() + "/.."};
        for (const QString &dir : fallbackPaths) {
            QString fullPath = dir + "/libdiskraptor_scanner.so";
            qDebug() << "[DiskRaptor] Fallback trying:" << fullPath << "exists:" << QFile::exists(fullPath);
            if (QFile::exists(fullPath)) {
                m_rustLib = new QLibrary(fullPath);
                if (m_rustLib->load()) {
                    qDebug() << "[DiskRaptor] Loaded from fallback:" << fullPath;
                    break;
                } else {
                    qWarning() << "[DiskRaptor] Fallback failed:" << m_rustLib->errorString();
                    delete m_rustLib;
                    m_rustLib = nullptr;
                }
            }
        }
    }

    if (!m_rustLib || !m_rustLib->isLoaded()) {
        // Try loading by name only (system library path)
        qDebug() << "[DiskRaptor] Trying QLibrary by name: diskraptor_scanner";
        m_rustLib = new QLibrary("diskraptor_scanner");
        if (!m_rustLib->load()) {
            qWarning() << "[DiskRaptor] Failed to load Rust scanner library:" << m_rustLib->errorString();
            delete m_rustLib;
            m_rustLib = nullptr;
            qWarning() << "[DiskRaptor] Scanner unavailable - check that libdiskraptor_scanner.so is in:" << QCoreApplication::applicationDirPath();
            return false;
        }
    }

    m_drStartScan       = reinterpret_cast<FnStartScan>(m_rustLib->resolve("dr_start_scan"));
    m_drGetProgress     = reinterpret_cast<FnGetProgress>(m_rustLib->resolve("dr_get_progress"));
    m_drGetResult       = reinterpret_cast<FnGetResult>(m_rustLib->resolve("dr_get_result"));
    m_drFindDuplicates  = reinterpret_cast<FnFindDuplicates>(m_rustLib->resolve("dr_find_duplicates"));
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

// ── C++ fallback scanner (used when Rust scanner not available) ──

void IpcBridge::cppStartScan(const QString &path)
{
    cppCancelScan();
    m_cppScanId = ++m_scanId;
    m_cppScanPath = path;
    m_cppFilesFound = 0;
    m_cppDirsFound = 0;
    m_cppBytesFound = 0;
    m_cppCurrentDir = path;
    m_cppStartTimeMs = QDateTime::currentMSecsSinceEpoch();
    m_cppScanRunning = true;

    m_cppScanThread = QThread::create([this, path]() {
        QDirIterator it(path, QDir::Files | QDir::Dirs | QDir::NoDotAndDotDot,
                        QDirIterator::Subdirectories);
        quint64 files = 0, dirs = 0, bytes = 0;
        qint64 lastProgress = 0;
        QHash<QString, quint64> typeMap;
        QHash<QString, quint64> typeBytes;
        QVector<QPair<quint64, QString>> topFiles;

        while (it.hasNext()) {
            if (!m_cppScanRunning) break;
            QString fullPath = it.next();
            QFileInfo fi = it.fileInfo();

            if (fi.isDir()) {
                dirs++;
            } else if (fi.isFile()) {
                files++;
                qint64 sz = fi.size();
                bytes += sz;
                QString ext = fi.suffix().isEmpty() ? "(none)" : fi.suffix().toLower();
                typeMap[ext]++;
                typeBytes[ext] += sz;
                if (sz > 0) {
                    topFiles.append({static_cast<quint64>(sz), fullPath});
                    std::sort(topFiles.begin(), topFiles.end(),
                        [](const auto &a, const auto &b) { return a.first > b.first; });
                    if (topFiles.size() > 100) topFiles.resize(100);
                }
            }

            qint64 now = QDateTime::currentMSecsSinceEpoch();
            if (now - lastProgress > 50) {
                QMutexLocker lock(&m_cppMutex);
                m_cppFilesFound = files;
                m_cppDirsFound = dirs;
                m_cppBytesFound = bytes;
                m_cppCurrentDir = fullPath;
                m_cppTypeMap = typeMap;
                m_cppTypeBytes = typeBytes;
                m_cppTopFiles = topFiles;
                lastProgress = now;
            }
        }

        QMutexLocker lock(&m_cppMutex);
        m_cppFilesFound = files;
        m_cppDirsFound = dirs;
        m_cppBytesFound = bytes;
        m_cppTypeMap = typeMap;
        m_cppTypeBytes = typeBytes;
        m_cppTopFiles = topFiles;
        m_cppScanRunning = false;
        qDebug() << "[DiskRaptor] C++ scan complete:" << files << "files," << dirs << "dirs";
    });
    connect(m_cppScanThread, &QThread::finished, m_cppScanThread, &QObject::deleteLater);
    m_cppScanThread->start();
}

void IpcBridge::cppCancelScan()
{
    m_cppScanRunning = false;
    if (m_cppScanThread && m_cppScanThread->isRunning()) {
        m_cppScanThread->quit();
        m_cppScanThread->wait(2000);
    }
    m_cppScanThread = nullptr;
}

QString IpcBridge::cppGetProgressJson()
{
    QMutexLocker lock(&m_cppMutex);
    qint64 elapsed = (QDateTime::currentMSecsSinceEpoch() - m_cppStartTimeMs) / 1000;
    QJsonObject obj;
    obj["files_found"] = static_cast<qint64>(m_cppFilesFound);
    obj["dirs_found"] = static_cast<qint64>(m_cppDirsFound);
    obj["bytes_found"] = static_cast<qint64>(m_cppBytesFound);
    obj["is_running"] = m_cppScanRunning;
    obj["current_dir"] = m_cppCurrentDir;
    obj["elapsed_secs"] = elapsed;
    obj["phase"] = m_cppScanRunning ? 0 : 3;
    return "{\"success\":true,\"data\":" + QString::fromUtf8(QJsonDocument(obj).toJson(QJsonDocument::Compact)) + "}";
}

QString IpcBridge::cppGetResultJson()
{
    QMutexLocker lock(&m_cppMutex);
    if (m_cppScanRunning) {
        return resultToJson(false, QVariant(), "scan still running");
    }
    qint64 elapsed = QDateTime::currentMSecsSinceEpoch() - m_cppStartTimeMs;

    // Build top_files array
    QJsonArray topFilesArr;
    int topCount = 0;
    for (const auto &pair : m_cppTopFiles) {
        if (topCount++ >= 50) break;
        QJsonObject tf;
        tf["path"] = pair.second;
        tf["size"] = static_cast<qint64>(pair.first);
        tf["size_human"] = "-";
        topFilesArr.append(tf);
    }

    // Build file_type_breakdown array
    QJsonArray typeBreakdown;
    QStringList exts = m_cppTypeMap.keys();
    std::sort(exts.begin(), exts.end(), [this](const QString &a, const QString &b) {
        return m_cppTypeBytes.value(a, 0) > m_cppTypeBytes.value(b, 0);
    });
    for (const QString &ext : exts) {
        QJsonObject ft;
        ft["extension"] = ext;
        ft["count"] = static_cast<qint64>(m_cppTypeMap.value(ext));
        ft["total_size"] = static_cast<qint64>(m_cppTypeBytes.value(ext));
        ft["size_human"] = "-";
        typeBreakdown.append(ft);
    }

    QJsonObject stats;
    stats["total_files"] = static_cast<qint64>(m_cppFilesFound);
    stats["total_dirs"] = static_cast<qint64>(m_cppDirsFound);
    stats["total_size"] = static_cast<qint64>(m_cppBytesFound);
    stats["scan_time_ms"] = elapsed;
    stats["top_files"] = topFilesArr;
    stats["file_type_breakdown"] = typeBreakdown;
    stats["size_human"] = "-";
    stats["time_human"] = QString::number(elapsed / 1000) + "s";

    QJsonObject ri;
    ri["root_index"] = 0;
    ri["total_nodes"] = 1;
    ri["total_chunks"] = 1;

    QJsonObject resultObj;
    resultObj["stats"] = stats;
    resultObj["root_info"] = ri;
    resultObj["scan_id"] = m_cppScanId;

    QJsonObject wrapper;
    wrapper["success"] = true;
    wrapper["data"] = resultObj;
    return QString::fromUtf8(QJsonDocument(wrapper).toJson(QJsonDocument::Compact));
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

static QString formatSize(quint64 b)
{
    const char *units[] = {"B", "KB", "MB", "GB", "TB", "PB"};
    if (b == 0) return "0 B";
    int i = 0;
    quint64 v = b;
    while (v >= 1024 && i < 5) { v /= 1024; i++; }
    double d = static_cast<double>(b);
    for (int j = 0; j < i; j++) d /= 1024.0;
    return (i == 0 ? QString::number(b) : QString::number(d, 'f', 1)) + " " + units[i];
}

static quint64 quickHashFile(const QString &path)
{
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) return 0;
    quint64 h = 0;
    char buf[8192];
    qint64 n;
    while ((n = f.read(buf, sizeof(buf))) > 0) {
        for (qint64 i = 0; i < n; i++) {
            h += static_cast<unsigned char>(buf[i]);
            h *= 0x9E3779B97F4A7C15ULL;
            h ^= h >> 31;
        }
    }
    return h;
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
