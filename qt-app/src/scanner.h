// DiskRaptor — Directory Scanner (C++17, no GTK/GLib)
#pragma once

#include <QObject>
#include <QString>
#include <QStringList>
#include <QAtomicInt>
#include <QElapsedTimer>
#include <QMutex>
#include <QThread>
#include <functional>
#include <vector>
#include <atomic>

struct ScanProgress {
    quint64 filesFound = 0;
    quint64 dirsFound = 0;
    quint64 totalSize = 0;
    bool isRunning = false;
    QString currentDir;
    qint64 elapsedSecs = 0;

    QString toJson() const;
};

struct ScanResult {
    quint64 totalFiles = 0;
    quint64 totalDirs = 0;
    quint64 totalSize = 0;
    qint64 scanTimeMs = 0;
    QStringList topFiles;
    QString scanPath;

    QString toJson() const;
};

class Scanner : public QObject
{
    Q_OBJECT

public:
    explicit Scanner(QObject *parent = nullptr);
    ~Scanner() override;

    void startScan(const QString &rootPath);
    void cancel();
    bool isRunning() const { return m_running.load(); }
    ScanProgress currentProgress() const;
    ScanResult lastResult() const { return m_lastResult; }

signals:
    void progressUpdated(const ScanProgress &progress);
    void scanComplete(const ScanResult &result);
    void scanError(const QString &error);

private:
    void scanDirectory(const QString &dirPath, ScanProgress &progress, ScanResult &result);

    std::atomic<bool> m_running{false};
    std::atomic<bool> m_cancelled{false};
    QElapsedTimer m_timer;
    mutable QMutex m_mutex;
    ScanProgress m_currentProgress;
    ScanResult m_lastResult;
    QThread *m_workerThread = nullptr;
};

// ── Inline helper ────────────────────────────────────────────
inline QString formatBytes(quint64 bytes)
{
    const char *units[] = {"B", "KB", "MB", "GB", "TB"};
    int unit = 0;
    double size = static_cast<double>(bytes);
    while (size >= 1024.0 && unit < 4) {
        size /= 1024.0;
        unit++;
    }
    return QString::number(size, 'f', unit == 0 ? 0 : 2) + " " + units[unit];
}
