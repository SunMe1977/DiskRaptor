// DiskRaptor — System operations handler
#pragma once

#include <QObject>
#include <QString>
#include <QVariant>
#include <QVariantMap>
#include <QJsonObject>
#include <QJsonDocument>

class SystemHandler : public QObject
{
    Q_OBJECT

public:
    explicit SystemHandler(QObject *parent = nullptr);

    QString getHomeDir();
    QString pickDirectory();
    QString listDrives();
    QString getVolumeStats();
    QString requestPermissions();
    QString emptyTrash();
    QString listTrash();
    QString restoreTrash(const QString &trashPath);
    QString checkAdminNeeded(const QString &path);
    QString restartAsAdmin();
    QString getMemoryInfo();
    QString getProcessMemory();
    QString checkForUpdates();

private:
    QString resultToJson(bool success, const QVariant &data = QVariant(),
                         const QString &error = QString());
};
