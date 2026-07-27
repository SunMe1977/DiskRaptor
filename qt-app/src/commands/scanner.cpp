// DiskRaptor — Scanner handler implementation (Rust scanner + C++ fallback)
#include "scanner.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QDirIterator>
#include <QDateTime>
#include <QCoreApplication>
#include <QDebug>

#include <QJsonArray>
#include <QJsonObject>

ScannerHandler::ScannerHandler(QObject *parent)
    : QObject(parent)
{
    if (!loadRustLibrary()) {
        qWarning() << "[DiskRaptor] Failed to load Rust scanner library --"
                    << "scan functionality will be unavailable.";
    }
}

ScannerHandler::~ScannerHandler()
{
    if (m_progressTimer) m_progressTimer->stop();
    cppCancelScan();
    unloadRustLibrary();
}

QString ScannerHandler::startScan(const QVariantMap &args)
{
    QString path = QDir::toNativeSeparators(args.value("path").toString());
    bool followLinks = args.value("follow_symlinks", false).toBool();
    quint64 timeoutSecs = args.value("timeout_secs", 0).toULongLong();
    if (!path.isEmpty()) {
        m_scanId++;
        m_lastScanPath = path;
        if (m_drStartScan) {
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
            if (!m_progressTimer) {
                m_progressTimer = new QTimer(this);
                connect(m_progressTimer, &QTimer::timeout, this, &ScannerHandler::onProgressTick);
            }
            m_progressTimer->start(500);
            return resultToJson(true, QVariantMap{{"status", "started"}, {"scan_id", rustScanId}});
        } else {
            qDebug() << "[DiskRaptor] Using C++ fallback scanner for:" << path;
            cppStartScan(path);
            if (!m_progressTimer) {
                m_progressTimer = new QTimer(this);
                connect(m_progressTimer, &QTimer::timeout, this, &ScannerHandler::onProgressTick);
            }
            m_progressTimer->start(500);
            return resultToJson(true, QVariantMap{{"status", "started"}, {"scan_id", m_cppScanId}});
        }
    }
    return resultToJson(false, QVariant(), "No path provided");
}

QString ScannerHandler::getScanProgress()
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
    return cppGetProgressJson();
}

void ScannerHandler::onProgressTick()
{
    QString raw = getScanProgress();
    QJsonDocument doc = QJsonDocument::fromJson(raw.toUtf8());
    if (doc.isNull() || !doc.isObject()) return;
    QJsonObject obj = doc.object();
    QJsonValue dataVal = obj.value("data");
    QVariant payload;
    if (!dataVal.isUndefined()) {
        payload = dataVal.toVariant();
    } else {
        payload = obj.toVariantMap();
    }
    emit eventEmitted("scan:progress", payload);
    bool isRunning = false;
    if (m_drIsRunning) {
        isRunning = m_drIsRunning();
    } else {
        QVariantMap pm = payload.toMap();
        isRunning = pm.value("is_running", false).toBool();
    }
    if (!isRunning && m_progressTimer) {
        m_progressTimer->stop();
    }
}

QString ScannerHandler::getScanResult()
{
    if (m_drGetResult) {
        char* cjson = m_drGetResult();
        if (!cjson) {
            qWarning() << "[DiskRaptor] getScanResult: dr_get_result returned null";
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
                qDebug() << "[DiskRaptor] getScanResult: Rust result OK, files:" << obj["stats"].toObject()["total_files"].toDouble();
                return QString::fromUtf8(QJsonDocument(wrapper).toJson(QJsonDocument::Compact));
            }
            qWarning() << "[DiskRaptor] getScanResult: Rust result missing stats, obj keys:" << obj.keys();
        } else {
            qWarning() << "[DiskRaptor] getScanResult: Rust result not valid JSON, raw:" << jsonStr.left(200);
        }
        bool isRunning = m_drIsRunning ? m_drIsRunning() : false;
        qDebug() << "[DiskRaptor] getScanResult: fallback path, isRunning:" << isRunning;
        if (!isRunning) {
            QString progressJson = getScanProgress();
            QJsonDocument pdoc = QJsonDocument::fromJson(progressJson.toUtf8());
            if (!pdoc.isNull() && pdoc.isObject()) {
                QJsonObject pobj = pdoc.object();
                if (pobj.contains("data")) {
                    QJsonObject data = pobj["data"].toObject();
                    qint64 files = static_cast<qint64>(data["files_found"].toDouble());
                    qint64 dirs = static_cast<qint64>(data["dirs_found"].toDouble());
                    qint64 bytes = static_cast<qint64>(data["bytes_found"].toDouble());
                    qint64 elapsed = static_cast<qint64>(data["elapsed_secs"].toDouble());
                    qDebug() << "[DiskRaptor] getScanResult: fallback stats from progress - files:" << files << "dirs:" << dirs << "bytes:" << bytes;
                    QJsonObject stats;
                    stats["total_files"] = files;
                    stats["total_dirs"] = dirs;
                    stats["total_size"] = bytes;
                    stats["scan_time_ms"] = elapsed * 1000;
                    stats["top_files"] = QJsonArray();
                    stats["file_type_breakdown"] = QJsonArray();
                    stats["size_human"] = bytes > 0 ? "-" : "0 B";
                    stats["time_human"] = QString::number(elapsed) + "s";
                    QJsonObject ri;
                    ri["root_index"] = 0; ri["total_nodes"] = (files + dirs > 0) ? (files + dirs) : 1; ri["total_chunks"] = 1;
                    QJsonObject resultObj;
                    resultObj["stats"] = stats; resultObj["root_info"] = ri; resultObj["scan_id"] = m_scanId;
                    QJsonObject wrapper;
                    wrapper["success"] = true; wrapper["data"] = resultObj;
                    return QString::fromUtf8(QJsonDocument(wrapper).toJson(QJsonDocument::Compact));
                }
            }
        }
        qWarning() << "[DiskRaptor] getScanResult: result not ready yet";
        return resultToJson(false, QVariant(), "result not ready yet");
    }
    qDebug() << "[DiskRaptor] getScanResult: using C++ fallback";
    return cppGetResultJson();
}

QString ScannerHandler::getChunk(const QVariantMap &args)
{
    uint32_t chunkIndex = static_cast<uint32_t>(args.value("chunkIndex", 0).toUInt());

    if (m_drGetChunk) {
        char* cjson = m_drGetChunk(chunkIndex);
        if (cjson) {
            QString jsonStr = QString::fromUtf8(cjson);
            m_drFreeString(cjson);
            QJsonDocument doc = QJsonDocument::fromJson(jsonStr.toUtf8());
            if (!doc.isNull() && doc.isObject()) {
                return resultToJson(true, doc.object());
            }

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

QString ScannerHandler::getStats()
{
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

QString ScannerHandler::releaseScan()
{
    m_chunksJson.clear();
    return resultToJson(true, QVariantMap{{"status", "released"}});
}

QString ScannerHandler::cancelScan()
{
    if (m_progressTimer) m_progressTimer->stop();
    if (m_drCancelScan) {
        m_drCancelScan();
        return resultToJson(true, QVariantMap{{"status", "cancelled"}});
    }
    cppCancelScan();
    return resultToJson(true, QVariantMap{{"status", "cancelled"}});
}

QString ScannerHandler::findDuplicates(const QString &path)
{
    if (!m_drFindDuplicates) {
        return resultToJson(false, QVariant(), "Rust scanner library not loaded -- duplicates require Rust scanner");
    }
    QByteArray pathUtf8 = QDir::toNativeSeparators(path).toUtf8();
    char* result = m_drFindDuplicates(pathUtf8.constData());
    QString resultStr;
    if (result) {
        resultStr = QString::fromUtf8(result);
        m_drFreeString(result);
    }
    QJsonDocument doc = QJsonDocument::fromJson(resultStr.toUtf8());
    if (doc.isNull() || !doc.isObject()) {
        return resultToJson(false, QVariant(), "Invalid result from Rust scanner");
    }
    QJsonObject obj = doc.object();
    QJsonObject wrapper;
    wrapper["success"] = true;
    wrapper["data"] = obj;
    return QString::fromUtf8(QJsonDocument(wrapper).toJson(QJsonDocument::Compact));
}

// ── Rust scanner loading ───────────────────────────────────────

bool ScannerHandler::loadRustLibrary()
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
                << QCoreApplication::applicationDirPath() + "/../../src-tauri/target/release"
                << QDir::currentPath() + "/../../../src-tauri/target/release"
                << QCoreApplication::applicationDirPath() + "/../lib/diskraptor"
                << QCoreApplication::applicationDirPath() + "/../lib64/diskraptor"
                << "/usr/lib/diskraptor"
                << "/usr/lib/x86_64-linux-gnu/diskraptor";

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

void ScannerHandler::unloadRustLibrary()
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

// ── C++ fallback scanner ──────────────────────────────────────

void ScannerHandler::cppStartScan(const QString &path)
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

void ScannerHandler::cppCancelScan()
{
    m_cppScanRunning = false;
    if (m_cppScanThread && m_cppScanThread->isRunning()) {
        m_cppScanThread->quit();
        m_cppScanThread->wait(2000);
    }
    m_cppScanThread = nullptr;
}

QString ScannerHandler::cppGetProgressJson()
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

QString ScannerHandler::cppGetResultJson()
{
    QMutexLocker lock(&m_cppMutex);
    qDebug() << "[DiskRaptor] cppGetResultJson: running:" << m_cppScanRunning << "files:" << m_cppFilesFound << "dirs:" << m_cppDirsFound;
    if (m_cppScanRunning) {
        return resultToJson(false, QVariant(), "scan still running");
    }
    qint64 elapsed = QDateTime::currentMSecsSinceEpoch() - m_cppStartTimeMs;

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

QString ScannerHandler::resultToJson(bool success, const QVariant &data, const QString &error)
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
