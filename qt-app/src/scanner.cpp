// DiskRaptor — Directory Scanner implementation
// Uses C++17 std::filesystem for cross-platform file traversal
// No GTK, no GLib, no Win32 API dependencies

#include "scanner.h"

#include <QDirIterator>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QDebug>
#include <QDateTime>

#include <filesystem>
#include <vector>
#include <algorithm>
namespace fs = std::filesystem;

Scanner::Scanner(QObject *parent)
    : QObject(parent)
{
}

Scanner::~Scanner()
{
    cancel();
    if (m_workerThread && m_workerThread->isRunning()) {
        m_workerThread->quit();
        m_workerThread->wait(5000);
    }
}

void Scanner::startScan(const QString &rootPath)
{
    if (m_running.exchange(true)) return;
    m_cancelled.store(false);
    m_timer.start();

    m_currentProgress = ScanProgress{};
    m_currentProgress.isRunning = true;
    m_currentProgress.currentDir = rootPath;
    m_lastResult = ScanResult{};
    m_lastResult.scanPath = rootPath;

    // Run scan in a worker thread
    m_workerThread = QThread::create([this, rootPath]() {
        ScanProgress progress;
        ScanResult result;
        result.scanPath = rootPath;

        progress.isRunning = true;
        progress.currentDir = rootPath;

        // Use C++17 std::filesystem for maximum performance
        try {
            scanDirectory(rootPath, progress, result);
        } catch (const std::exception &e) {
            emit scanError(QString::fromStdString(e.what()));
            m_running.store(false);
            return;
        }

        result.scanTimeMs = m_timer.elapsed();
        progress.isRunning = false;

        // Store result
        {
            QMutexLocker lock(&m_mutex);
            m_currentProgress = progress;
            m_lastResult = result;
        }

        emit progressUpdated(progress);
        emit scanComplete(result);
        m_running.store(false);
    });

    connect(m_workerThread, &QThread::finished, m_workerThread, &QObject::deleteLater);
    m_workerThread->start();
}

void Scanner::cancel()
{
    m_cancelled.store(true);
}

ScanProgress Scanner::currentProgress() const
{
    QMutexLocker lock(&m_mutex);
    auto p = m_currentProgress;
    if (p.isRunning) {
        p.elapsedSecs = m_timer.elapsed() / 1000;
    }
    return p;
}

void Scanner::scanDirectory(const QString &dirPath, ScanProgress &progress, ScanResult &result)
{
    if (m_cancelled.load()) return;

    try {
        for (const auto &entry : fs::directory_iterator(
                 dirPath.toStdString(),
                 fs::directory_options::skip_permission_denied))
        {
            if (m_cancelled.load()) return;

            const auto &path = entry.path();
            QString qPath = QString::fromStdString(path.string());

            try {
                if (entry.is_directory()) {
                    progress.dirsFound++;
                    progress.currentDir = qPath;

                    // Emit progress periodically
                    if (progress.dirsFound % 100 == 0) {
                        progress.elapsedSecs = m_timer.elapsed() / 1000;
                        emit progressUpdated(progress);
                    }

                    // Recurse into subdirectory
                    scanDirectory(qPath, progress, result);

                } else if (entry.is_regular_file()) {
                    progress.filesFound++;
                    auto fileSize = entry.file_size();
                    progress.totalSize += fileSize;

                    // Track top 100 files by size
                    result.topFiles.append(qPath + "|" + QString::number(fileSize));

                    // Emit progress periodically
                    if (progress.filesFound % 500 == 0) {
                        progress.elapsedSecs = m_timer.elapsed() / 1000;
                        emit progressUpdated(progress);
                    }
                }
            } catch (const fs::filesystem_error &) {
                // Skip files/dirs we can't access
                continue;
            }
        }
    } catch (const fs::filesystem_error &) {
        // Skip directories we can't list
    }

    result.totalFiles = progress.filesFound;
    result.totalDirs = progress.dirsFound;
    result.totalSize = progress.totalSize;

    // Sort top files by size (descending) and keep top 100
    std::sort(result.topFiles.begin(), result.topFiles.end(),
        [](const QString &a, const QString &b) {
            qint64 sizeA = a.section('|', -1).toLongLong();
            qint64 sizeB = b.section('|', -1).toLongLong();
            return sizeA > sizeB;
        });
    while (result.topFiles.size() > 100) {
        result.topFiles.removeLast();
    }
}

// ── JSON serialization ───────────────────────────────────────

QString ScanProgress::toJson() const
{
    QJsonObject obj;
    obj["filesFound"] = static_cast<qint64>(filesFound);
    obj["dirsFound"] = static_cast<qint64>(dirsFound);
    obj["totalSize"] = static_cast<qint64>(totalSize);
    obj["isRunning"] = isRunning;
    obj["currentDir"] = currentDir;
    obj["elapsedSecs"] = elapsedSecs;
    return QJsonDocument(obj).toJson(QJsonDocument::Compact);
}

QString ScanResult::toJson() const
{
    QJsonObject obj;
    obj["totalFiles"] = static_cast<qint64>(totalFiles);
    obj["totalDirs"] = static_cast<qint64>(totalDirs);
    obj["totalSize"] = static_cast<qint64>(totalSize);
    obj["scanTimeMs"] = scanTimeMs;
    obj["scanPath"] = scanPath;
    obj["sizeHuman"] = formatBytes(totalSize);
    obj["timeHuman"] = QString::number(scanTimeMs / 1000.0, 'f', 2) + "s";

    // Top 50 files
    QJsonArray top50;
    int count = 0;
    for (const auto &entry : topFiles) {
        if (count >= 50) break;
        QStringList parts = entry.split('|');
        if (parts.size() >= 2) {
            QJsonObject file;
            file["path"] = parts[0];
            qint64 size = parts[1].toLongLong();
            file["size"] = size;
            file["sizeHuman"] = formatBytes(size);
            top50.append(file);
        }
        count++;
    }
    obj["topFiles"] = top50;

    return QJsonDocument(obj).toJson(QJsonDocument::Compact);
}
