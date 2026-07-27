// DiskRaptor — Scanner handler (Rust + C++ fallback)
#pragma once

#include <QObject>
#include <QString>
#include <QVariant>
#include <QVariantMap>
#include <QJsonObject>
#include <QJsonDocument>
#include <QLibrary>
#include <QMutex>
#include <QHash>
#include <QVector>
#include <QPair>
#include <QThread>
#include <QAtomicInteger>

class ScannerHandler : public QObject
{
    Q_OBJECT

public:
    explicit ScannerHandler(QObject *parent = nullptr);
    ~ScannerHandler() override;

    QString startScan(const QVariantMap &args);
    QString getScanProgress();
    QString getScanResult();
    QString getChunk(const QVariantMap &args);
    QString getStats();
    QString releaseScan();
    QString cancelScan();
    QString findDuplicates(const QString &path);

signals:
    void eventEmitted(const QString &event, const QVariant &payload);

private:
    // Scan state
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
};
