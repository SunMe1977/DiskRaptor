// DiskRaptor — IPC Bridge implementation
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
    // Load the Rust scanner DLL on construction
    if (!loadRustLibrary()) {
        qWarning() << "[DiskRaptor] Failed to load diskraptor_scanner.dll —"
                    << "scan functionality will be unavailable.";
    }
}

IpcBridge::~IpcBridge()
{
    unloadRustLibrary();
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

            // Call Rust scanner via FFI
            if (!m_drStartScan) {
                return resultToJson(false, QVariant(), "Rust scanner DLL not loaded");
            }

            QByteArray pathUtf8 = path.toUtf8();
            char* result = m_drStartScan(pathUtf8.constData());
            QString jsonResult;
            if (result) {
                jsonResult = QString::fromUtf8(result);
                m_drFreeString(result);
            }

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
    if (!m_drGetProgress) {
        return resultToJson(false, QVariant(), "Rust scanner DLL not loaded");
    }

    char* cjson = m_drGetProgress();
    if (!cjson) {
        return resultToJson(false, QVariant(), "null progress");
    }

    QString jsonStr = QString::fromUtf8(cjson);
    m_drFreeString(cjson);

    // The Rust scanner returns snake_case keys which match frontend expectations
    return resultToJson(true, jsonStr);
}

QString IpcBridge::getScanResult()
{
    if (!m_drGetResult) {
        return resultToJson(false, QVariant(), "Rust scanner DLL not loaded");
    }

    char* cjson = m_drGetResult();
    if (!cjson) {
        return resultToJson(false, QVariant(), "null result");
    }

    QString jsonStr = QString::fromUtf8(cjson);
    m_drFreeString(cjson);

    // Parse the result JSON to build the expected response format
    QJsonDocument doc = QJsonDocument::fromJson(jsonStr.toUtf8());
    if (doc.isNull() || !doc.isObject()) {
        return resultToJson(true, jsonStr);
    }

    QJsonObject obj = doc.object();

    // The Rust scanner returns { "stats": {...}, "root_info": {...}, "scan_id": N }
    // Pass through with "stats" at top level as the frontend expects
    QJsonObject resultObj;
    if (obj.contains("stats")) {
        resultObj["stats"] = obj["stats"];
    }
    if (obj.contains("root_info")) {
        resultObj["root_info"] = obj["root_info"];
    }
    resultObj["scan_id"] = m_scanId;

    return resultToJson(true, QJsonDocument(resultObj).toJson(QJsonDocument::Compact));
}

QString IpcBridge::listDrives()
{
    QJsonArray drives;
    for (const auto &storage : QStorageInfo::mountedVolumes()) {
        if (!storage.isValid() || storage.isReadOnly()) continue;
#ifdef Q_OS_WIN
        // Only show fixed drives on Windows
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

// ── Rust DLL loading ─────────────────────────────────────────────

#ifdef Q_OS_WIN
bool IpcBridge::loadRustLibrary()
{
    // Search paths: first alongside the app executable, then in PATH
    QStringList searchPaths;
    searchPaths << QCoreApplication::applicationDirPath()
                << "."
                << ".";

    for (const QString &dir : searchPaths) {
        QString dllPath = dir + "/diskraptor_scanner.dll";
        m_rustLib = LoadLibraryW(dllPath.toStdWString().c_str());
        if (m_rustLib) {
            qDebug() << "[DiskRaptor] Loaded Rust scanner DLL from:" << dllPath;
            break;
        }
    }

    if (!m_rustLib) {
        // Try without path (relies on PATH / app dir)
        m_rustLib = LoadLibraryW(L"diskraptor_scanner.dll");
    }

    if (!m_rustLib) {
        DWORD err = GetLastError();
        qWarning() << "[DiskRaptor] Failed to load diskraptor_scanner.dll, error:" << err;
        return false;
    }

    // Resolve function pointers
    m_drStartScan  = reinterpret_cast<FnStartScan>(GetProcAddress(m_rustLib, "dr_start_scan"));
    m_drGetProgress = reinterpret_cast<FnGetProgress>(GetProcAddress(m_rustLib, "dr_get_progress"));
    m_drGetResult   = reinterpret_cast<FnGetResult>(GetProcAddress(m_rustLib, "dr_get_result"));
    m_drCancelScan  = reinterpret_cast<FnCancelScan>(GetProcAddress(m_rustLib, "dr_cancel_scan"));
    m_drIsRunning   = reinterpret_cast<FnIsRunning>(GetProcAddress(m_rustLib, "dr_is_running"));
    m_drFreeString  = reinterpret_cast<FnFreeString>(GetProcAddress(m_rustLib, "dr_free_string"));

    // Verify all symbols were found
    int missing = 0;
    if (!m_drStartScan)  { qWarning() << "[DiskRaptor] Missing dr_start_scan";  missing++; }
    if (!m_drGetProgress){ qWarning() << "[DiskRaptor] Missing dr_get_progress";missing++; }
    if (!m_drGetResult)  { qWarning() << "[DiskRaptor] Missing dr_get_result";  missing++; }
    if (!m_drCancelScan) { qWarning() << "[DiskRaptor] Missing dr_cancel_scan"; missing++; }
    if (!m_drIsRunning)  { qWarning() << "[DiskRaptor] Missing dr_is_running";  missing++; }
    if (!m_drFreeString) { qWarning() << "[DiskRaptor] Missing dr_free_string"; missing++; }

    if (missing > 0) {
        qWarning() << "[DiskRaptor] Rust scanner DLL loaded but" << missing << "symbols missing";
        FreeLibrary(m_rustLib);
        m_rustLib = nullptr;
        return false;
    }

    qDebug() << "[DiskRaptor] Rust scanner DLL loaded successfully with all symbols.";
    return true;
}

void IpcBridge::unloadRustLibrary()
{
    if (m_rustLib) {
        FreeLibrary(m_rustLib);
        m_rustLib = nullptr;
        m_drStartScan = nullptr;
        m_drGetProgress = nullptr;
        m_drGetResult = nullptr;
        m_drCancelScan = nullptr;
        m_drIsRunning = nullptr;
        m_drFreeString = nullptr;
    }
}
#endif

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
