// DiskRaptor -- IPC Bridge implementation
#include "ipcbridge.h"
#include "commands/file_ops.h"
#include "commands/system.h"
#include "commands/settings.h"
#include "commands/scanner.h"

#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QDesktopServices>
#include <QUrl>

IpcBridge::IpcBridge(QObject *parent)
    : QObject(parent)
{
    m_fileOps = new FileOpsHandler(this);
    m_system = new SystemHandler(this);
    m_settings = new SettingsHandler(this);
    m_scanner = new ScannerHandler(this);
}

IpcBridge::~IpcBridge()
{
}

QString IpcBridge::invoke(const QString &command, const QVariantMap &args)
{
    if (command == "get_home_dir") return m_system->getHomeDir();
    if (command == "pick_directory") return m_system->pickDirectory();
    if (command == "get_volume_stats") return m_system->getVolumeStats();
    if (command == "open_url") {
        QString url = args.value("url").toString();
        if (!url.isEmpty()) QDesktopServices::openUrl(QUrl(url));
        return resultToJson(true);
    }
    if (command == "request_permissions") return m_system->requestPermissions();
    if (command == "empty_trash") return m_system->emptyTrash();
    if (command == "list_trash") return m_system->listTrash();
    if (command == "restore_trash") return m_system->restoreTrash(args.value("path").toString());
    if (command == "delete_permanent") return m_fileOps->deletePermanent(args.value("path").toString());
    if (command == "delete_path") return m_fileOps->deletePath(args.value("path").toString());
    if (command == "open_explorer") return m_fileOps->openExplorer(args.value("path").toString());
    if (command == "open_terminal") return m_fileOps->openTerminal(args.value("path").toString());
    if (command == "open_properties") return m_fileOps->openProperties(args.value("path").toString());
    if (command == "get_icon") return m_fileOps->getIcon(args.value("path").toString(), args.value("isDir").toBool());
    if (command == "get_scan_progress") return m_scanner->getScanProgress();
    if (command == "get_scan_result") return m_scanner->getScanResult();
    if (command == "list_drives") return m_system->listDrives();
    if (command == "check_for_updates") return m_system->checkForUpdates();
    if (command == "find_duplicates") return m_scanner->findDuplicates(args.value("path").toString());
    if (command == "check_admin_needed") return m_system->checkAdminNeeded(args.value("path").toString());
    if (command == "restart_as_admin") return m_system->restartAsAdmin();
    if (command == "save_settings") return m_settings->saveSettings(args);
    if (command == "load_settings") return m_settings->loadSettings();
    if (command == "get_memory_info") return m_system->getMemoryInfo();
    if (command == "get_process_memory") return m_system->getProcessMemory();
    if (command == "cancel_scan") return m_scanner->cancelScan();

    if (command == "get_chunk") return m_scanner->getChunk(args);
    if (command == "get_children") {
        return resultToJson(true, QVariantMap{{"children", QJsonArray()}});
    }
    if (command == "release_scan") return m_scanner->releaseScan();
    if (command == "get_stats") return m_scanner->getStats();

    if (command == "start_scan") return m_scanner->startScan(args);

    return resultToJson(false, QVariant(), "Unknown command: " + command);
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
