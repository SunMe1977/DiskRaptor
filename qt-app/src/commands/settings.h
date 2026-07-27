// DiskRaptor — Settings handler
#pragma once

#include <QObject>
#include <QString>
#include <QVariantMap>
#include <QJsonObject>
#include <QJsonDocument>

class SettingsHandler : public QObject
{
    Q_OBJECT

public:
    explicit SettingsHandler(QObject *parent = nullptr);

    QString saveSettings(const QVariantMap &settings);
    QString loadSettings();

private:
    QString resultToJson(bool success, const QVariant &data = QVariant(),
                         const QString &error = QString());
};
