// DiskRaptor — IPC Bridge between C++ backend and JavaScript frontend
// Uses Rust scanner DLL (diskraptor_scanner.dll) instead of C++ scanner.
#pragma once

#include <QObject>
#include <QString>
#include <QVariantMap>
#include <QJsonArray>
#include <QJsonObject>
#include <QSettings>

#ifdef Q_OS_WIN
#include <windows.h>
#endif

class IpcBridge : public QObject
{
    Q_OBJECT

public:
    explicit IpcBridge(QObject *parent = nullptr);
    ~IpcBridge() override;

    // These methods are callable from JavaScript via QWebChannel
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
    Q_INVOKABLE QString checkAdminNeeded(const QString &path);
    Q_INVOKABLE QString restartAsAdmin();
    Q_INVOKABLE QString saveSettings(const QVariantMap &settings);
    Q_INVOKABLE QString loadSettings();

signals:
    void eventEmitted(const QString &event, const QVariant &payload);

private:
    int m_scanId = 0;
    QString m_chunksJson;
    QStringList m_driveLetters();

    QString resultToJson(bool success, const QVariant &data = QVariant(),
                         const QString &error = QString());

    // ── Rust scanner DLL handles ───────────────────────────
#ifdef Q_OS_WIN
    HMODULE m_rustLib = nullptr;

    // Function pointer types matching the Rust CDYLIB exports
    using FnStartScan = char* (__stdcall*)(const char* path);
    using FnGetProgress = char* (__stdcall*)();
    using FnGetResult = char* (__stdcall*)();
    using FnGetChunk = char* (__stdcall*)(uint32_t chunk_id);
    using FnCancelScan = bool (__stdcall*)();
    using FnIsRunning = bool (__stdcall*)();
    using FnFreeString = void (__stdcall*)(char* s);

    FnStartScan m_drStartScan = nullptr;
    FnGetProgress m_drGetProgress = nullptr;
    FnGetResult m_drGetResult = nullptr;
    FnGetChunk m_drGetChunk = nullptr;
    FnCancelScan m_drCancelScan = nullptr;
    FnIsRunning m_drIsRunning = nullptr;
    FnFreeString m_drFreeString = nullptr;

    bool loadRustLibrary();
    void unloadRustLibrary();
#endif
};
