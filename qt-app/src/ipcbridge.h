// DiskRaptor — IPC Bridge between C++ backend and JavaScript frontend
#pragma once

#include <QObject>
#include <QString>
#include <QVariantMap>
#include <QJsonArray>
#include <QJsonObject>
#include <QJsonDocument>
#include <QVariant>

class FileOpsHandler;
class SystemHandler;
class SettingsHandler;
class ScannerHandler;

class IpcBridge : public QObject
{
    Q_OBJECT

public:
    explicit IpcBridge(QObject *parent = nullptr);
    ~IpcBridge() override;

    Q_INVOKABLE QString invoke(const QString &command, const QVariantMap &args);

signals:
    void eventEmitted(const QString &event, const QVariant &payload);

private:
    QString resultToJson(bool success, const QVariant &data = QVariant(),
                         const QString &error = QString());

    FileOpsHandler *m_fileOps = nullptr;
    SystemHandler *m_system = nullptr;
    SettingsHandler *m_settings = nullptr;
    ScannerHandler *m_scanner = nullptr;
};
