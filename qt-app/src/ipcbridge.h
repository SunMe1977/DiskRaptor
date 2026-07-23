// DiskRaptor — IPC Bridge between C++ backend and JavaScript frontend
// Uses Rust scanner DLL (.dll / .dylib) cross‑platform via QLibrary.
// Falls back to C++ scanner when Rust library is not available.
#pragma once

#include <QObject>
#include <QString>
#include <QVariantMap>
#include <QJsonArray>
#include <QJsonObject>
#include <QSettings>
#include <QLibrary>
#include <QMutex>
#include <QAtomicInt>
#include <QHash>
#include <QSet>
#include <QVector>
#include <QPair>

class IpcBridge : public QObject
{
    Q_OBJECT

public:
    explicit IpcBridge(QObject *parent = nullptr);
    ~IpcBridge() override;

    Q_INVOKABLE QString invoke(const QString &command, const QVariantMap &args);
    Q_INVOKABLE QString getHomeDir();
    Q_INVOKABLE QString pickDirectory();
    Q_INVOKABLE QString deletePath(const QString &path);
    Q_INVOKABLE QString openExplorer(const QString &path);
    Q_INVOKABLE QString openTerminal(const QString &path);
    Q_INVOKABLE QString openProperties(const QString &path);
    Q_INVOKABLE QString getIcon(const QString &path, bool isDir);
    Q_INVOKABLE QString getScanProgress();
    Q_INVOKABLE QString getScanResult();
    Q_INVOKABLE QString listDrives();
    Q_INVOKABLE QString checkForUpdates();
    Q_INVOKABLE QString findDuplicates(const QString &path);
    Q_INVOKABLE QString getDupStats();
    Q_INVOKABLE QString getDupResult();
    Q_INVOKABLE QString checkAdminNeeded(const QString &path);
    Q_INVOKABLE QString restartAsAdmin();
    Q_INVOKABLE QString saveSettings(const QVariantMap &settings);
    Q_INVOKABLE QString loadSettings();
    Q_INVOKABLE QString getMemoryInfo();
    Q_INVOKABLE QString getProcessMemory();

signals:
    void eventEmitted(const QString &event, const QVariant &payload);

private:
    int m_scanId = 0;
    QString m_chunksJson;
    QString m_lastScanPath;

    QString resultToJson(bool success, const QVariant &data = QVariant(),
                         const QString &error = QString());

    // ── Rust scanner cross‑platform via QLibrary ─────────────────
    QLibrary *m_rustLib = nullptr;

    using FnStartScan       = char* (*)(const char* path);
    using FnGetProgress     = char* (*)();
    using FnGetResult       = char* (*)();
    using FnGetChunk        = char* (*)(uint32_t chunk_id);
    using FnCancelScan      = bool   (*)();
    using FnIsRunning       = bool   (*)();
    using FnFreeString      = void   (*)(char* s);
    using FnFindDuplicates  = char* (*)(const char* path);

    FnStartScan       m_drStartScan       = nullptr;
    FnGetProgress     m_drGetProgress     = nullptr;
    FnGetResult       m_drGetResult       = nullptr;
    FnGetChunk        m_drGetChunk        = nullptr;
    FnCancelScan      m_drCancelScan      = nullptr;
    FnIsRunning       m_drIsRunning       = nullptr;
    FnFindDuplicates  m_drFindDuplicates  = nullptr;
    FnFreeString  m_drFreeString  = nullptr;

    bool loadRustLibrary();
    void unloadRustLibrary();

    // ── C++ fallback scanner (when Rust .so not available) ─────
    QThread *m_cppScanThread = nullptr;
    QMutex m_cppMutex;
    bool m_cppScanRunning = false;
    quint64 m_cppFilesFound = 0;
    quint64 m_cppDirsFound = 0;
    quint64 m_cppBytesFound = 0;
    QString m_cppCurrentDir;
    qint64 m_cppStartTimeMs = 0;
    QString m_cppScanPath;
    int m_cppScanId = 0;
    QHash<QString, quint64> m_cppTypeMap;
    QHash<QString, quint64> m_cppTypeBytes;
    QVector<QPair<quint64, QString>> m_cppTopFiles;

    void cppStartScan(const QString &path);
    void cppCancelScan();
    QString cppGetProgressJson();
    QString cppGetResultJson();

    // ── C++ duplicate scanner (background thread) ──────────────
    QThread *m_dupThread = nullptr;
    QMutex m_dupMutex;
    bool m_dupRunning = false;
    bool m_dupCancelled = false;
    int m_dupScanId = 0;
    quint64 m_dupFilesScanned = 0;
    quint64 m_dupGroups = 0;
    quint64 m_dupWastedBytes = 0;
    QString m_dupCurrentFile;
    int m_dupPhase = 0; // 0=idle, 1=hashing, 2=processing, 3=done
    QString m_dupResultJson;

    void cppStartDupScan(const QString &path);
    void cppCancelDupScan();
    QString cppGetDupStatsJson();
};
