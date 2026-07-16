// DiskRaptor — IPC Bridge between C++ backend and JavaScript frontend
// Replaces Tauri's invoke/event system with Qt WebChannel
#pragma once

#include <QObject>
#include <QString>
#include <QVariantMap>
#include <QJsonArray>
#include <QJsonObject>
#include <functional>

#include "scanner.h"

class Scanner;

class IpcBridge : public QObject
{
    Q_OBJECT

public:
    explicit IpcBridge(Scanner *scanner, QObject *parent = nullptr);

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

signals:
    void eventEmitted(const QString &event, const QVariant &payload);

private:
    Scanner *m_scanner;
    ScanResult m_lastResult;
    int m_scanId = 0;
    QStringList m_driveLetters();

    QString resultToJson(bool success, const QVariant &data = QVariant(),
                         const QString &error = QString());
};
