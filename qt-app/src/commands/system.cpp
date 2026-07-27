// DiskRaptor — System operations handler implementation
#include "system.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QProcess>
#include <QStandardPaths>
#include <QStorageInfo>
#include <QApplication>
#include <QJsonArray>
#include <QFileDialog>
#include <QTimer>
#include <QCoreApplication>
#include <QDirIterator>
#include <QDateTime>
#include <QDesktopServices>

#ifdef Q_OS_LINUX
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

SystemHandler::SystemHandler(QObject *parent)
    : QObject(parent)
{
}

QString SystemHandler::getHomeDir()
{
    return resultToJson(true, QDir::homePath());
}

QString SystemHandler::getMemoryInfo()
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
    int mib[2] = {CTL_HW, HW_MEMSIZE};
    quint64 total = 0;
    size_t len = sizeof(total);
    if (sysctl(mib, 2, &total, &len, nullptr, 0) == 0) {
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

QString SystemHandler::getProcessMemory()
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

QString SystemHandler::pickDirectory()
{
    QWidget *parent = QApplication::activeWindow();
    QString dir = QFileDialog::getExistingDirectory(
        parent, "Select Directory to Scan", QDir::homePath(),
        QFileDialog::ShowDirsOnly | QFileDialog::DontResolveSymlinks);
    if (dir.isEmpty()) {
        return resultToJson(true, QVariant());
    }
    return resultToJson(true, QDir::toNativeSeparators(dir));
}

QString SystemHandler::requestPermissions()
{
#ifdef Q_OS_MACOS
    QStringList dirs = {
        QDir::homePath(),
        QDir::homePath() + "/Desktop",
        QDir::homePath() + "/Downloads",
        QDir::homePath() + "/Documents",
    };
    QStringList results;
    for (const QString &dir : dirs) {
        QDir d(dir);
        bool ok = d.exists();
        if (ok) {
            QDirIterator it(dir, QDir::Files | QDir::Dirs | QDir::NoDotAndDotDot);
            ok = it.hasNext();
        }
        results << (ok ? "granted" : "denied");
    }
    return resultToJson(true, QVariantMap{{"permissions", results.join(",")}});
#else
    return resultToJson(true, QVariantMap{{"permissions", "not_needed"}});
#endif
}

QString SystemHandler::emptyTrash()
{
#ifdef Q_OS_MACOS
    QProcess::startDetached("osascript", {"-e", "tell app \"Finder\" to empty trash"});
    return resultToJson(true, QVariantMap{{"status", "emptying"}});
#elif defined(Q_OS_LINUX)
    int ret = QProcess::execute("gio", {"trash", "--empty"});
    if (ret != 0) {
        QDir trashDir(QDir::homePath() + "/.local/share/Trash/expunged");
        if (trashDir.exists()) {
            trashDir.removeRecursively();
        }
        QDir trashFiles(QDir::homePath() + "/.local/share/Trash/files");
        if (trashFiles.exists()) {
            trashFiles.removeRecursively();
        }
        QDir trashInfo(QDir::homePath() + "/.local/share/Trash/info");
        if (trashInfo.exists()) {
            trashInfo.removeRecursively();
        }
    }
    return resultToJson(true, QVariantMap{{"status", "emptied"}});
#elif defined(Q_OS_WIN)
    QProcess::startDetached("cmd", {"/c", "rd /s /q \"%TEMP%\\..\\..\\Recycle.Bin\""});
    return resultToJson(true, QVariantMap{{"status", "emptying"}});
#else
    return resultToJson(true, QVariantMap{{"status", "unsupported"}});
#endif
}

QString SystemHandler::listTrash()
{
    QJsonArray items;
    QString trashPath = QDir::homePath() + "/.Trash";
    QDir trashDir(trashPath);
    if (!trashDir.exists()) {
        return resultToJson(true, QJsonDocument(items).toJson(QJsonDocument::Compact));
    }
    QHash<QString, QString> origPaths;
    QProcess mdls;
    mdls.start("bash", {"-c", "mdls -name kMDItemFSLabel -name kMDItemFSCreationDate -name kMDItemWhereFroms " + trashPath + "/* 2>/dev/null | grep -B1 \"kMDItemWhereFroms\" | grep -v \"kMDItemWhereFroms\" | grep -v \"^--$\" | sed 's/.*\\\\/([^/]*)\\\\):.*/\\\\1/' || true"});
    mdls.waitForFinished(3000);
    QString mdlsOut = QString::fromUtf8(mdls.readAllStandardOutput());

    for (const QFileInfo &fi : trashDir.entryInfoList(QDir::Files | QDir::Dirs | QDir::NoDotAndDotDot, QDir::Name)) {
        QJsonObject item;
        item["name"] = fi.fileName();
        item["path"] = fi.absoluteFilePath();
        item["size"] = static_cast<qint64>(fi.size());
        item["size_human"] = fi.isDir() ? "-" : (fi.size() < 1024 ? QString::number(fi.size()) + " B" :
            fi.size() < 1048576 ? QString::number(fi.size() / 1024.0, 'f', 1) + " KB" :
            QString::number(fi.size() / 1048576.0, 'f', 1) + " MB");
        item["is_dir"] = fi.isDir();
        item["deleted_at"] = fi.lastModified().toString(Qt::ISODate);
        item["original_path"] = "";
        items.append(item);
    }
    return resultToJson(true, QJsonDocument(items).toJson(QJsonDocument::Compact));
}

QString SystemHandler::restoreTrash(const QString &trashPath)
{
    QFileInfo fi(trashPath);
    if (!fi.exists()) {
        return resultToJson(false, QVariant(), "File not found: " + trashPath);
    }
    QString destDir = QDir::homePath();
    QString destPath = destDir + "/" + fi.fileName();
    if (QFile::exists(destPath)) {
        QString base = fi.completeBaseName();
        QString ext = fi.suffix();
        destPath = destDir + "/" + base + "_restored_" + QString::number(QDateTime::currentSecsSinceEpoch()) + (ext.isEmpty() ? "" : "." + ext);
    }
    if (QFile::copy(trashPath, destPath)) {
        QFile::remove(trashPath);
        return resultToJson(true, QVariantMap{{"restored_to", destPath}});
    }
    return resultToJson(false, QVariant(), "Failed to restore: " + trashPath);
}

QString SystemHandler::checkAdminNeeded(const QString &path)
{
    Q_UNUSED(path)
    return resultToJson(true, false);
}

QString SystemHandler::restartAsAdmin()
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

QString SystemHandler::listDrives()
{
    QJsonArray drives;
    for (const auto &storage : QStorageInfo::mountedVolumes()) {
        if (!storage.isValid()) continue;
        QString path = storage.rootPath();
#ifdef Q_OS_MACOS
        if (storage.isReadOnly() && path != "/" && !path.startsWith("/System/Volumes/Data")) continue;
        if (path.startsWith("/System/Volumes/") && path != "/System/Volumes/Data") continue;
        if (path.startsWith("/private/")) continue;
        if (path.startsWith("/Volumes/") && storage.bytesTotal() == 0) continue;
#else
        if (storage.isReadOnly()) continue;
#endif
        if (storage.bytesTotal() == 0) continue;
        QString driveType = "local";
        if (path.startsWith("A:") || path.startsWith("B:")) driveType = "floppy";
        else if (storage.fileSystemType().contains("FAT") || storage.fileSystemType().contains("NTFS")) {
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

QString SystemHandler::getVolumeStats()
{
    QJsonArray volumes;
    for (const auto &storage : QStorageInfo::mountedVolumes()) {
        if (!storage.isValid()) continue;
        QString path = storage.rootPath();
#ifdef Q_OS_MACOS
        if (storage.isReadOnly() && path != "/" && !path.startsWith("/System/Volumes/Data")) continue;
        if (path.startsWith("/System/Volumes/") && path != "/System/Volumes/Data") continue;
        if (path.startsWith("/private/")) continue;
        if (path.startsWith("/Volumes/") && storage.bytesTotal() == 0) continue;
#else
        if (storage.isReadOnly()) continue;
#endif
        if (storage.bytesTotal() == 0) continue;
        QJsonObject vol;
        vol["path"] = path;
        vol["name"] = storage.displayName();
        vol["total_bytes"] = static_cast<qint64>(storage.bytesTotal());
        vol["free_bytes"] = static_cast<qint64>(storage.bytesFree());
        vol["used_bytes"] = static_cast<qint64>(storage.bytesTotal() - storage.bytesFree());
        auto fmt = [](quint64 b) -> QString {
            if (b == 0) return "0 B";
            const char *u[] = {"B","KB","MB","GB","TB"};
            int i = 0;
            double v = static_cast<double>(b);
            while (v >= 1024.0 && i < 4) { v /= 1024.0; i++; }
            return QString::number(v, 'f', i > 0 ? 1 : 0) + " " + u[i];
        };
        vol["total_human"] = fmt(storage.bytesTotal());
        vol["free_human"] = fmt(storage.bytesFree());
        vol["used_human"] = fmt(storage.bytesTotal() - storage.bytesFree());
        vol["usage_pct"] = storage.bytesTotal() > 0
            ? static_cast<double>(storage.bytesTotal() - storage.bytesFree()) / storage.bytesTotal() * 100.0
            : 0.0;
        volumes.append(vol);
    }
    return resultToJson(true, QJsonDocument(volumes).toJson(QJsonDocument::Compact));
}

QString SystemHandler::checkForUpdates()
{
    return resultToJson(true, "v0.5.0");
}

QString SystemHandler::resultToJson(bool success, const QVariant &data, const QString &error)
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
