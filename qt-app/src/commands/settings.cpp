// DiskRaptor — Settings handler implementation
#include "settings.h"

#include <QSettings>
#include <QJsonDocument>
#include <QJsonObject>

SettingsHandler::SettingsHandler(QObject *parent)
    : QObject(parent)
{
}

QString SettingsHandler::saveSettings(const QVariantMap &settings)
{
    QSettings ini("DiskRaptor", "DiskRaptor");
    for (auto it = settings.begin(); it != settings.end(); ++it) {
        ini.setValue(it.key(), it.value());
    }
    ini.sync();
    return resultToJson(true, QVariantMap{{"saved", true}});
}

QString SettingsHandler::loadSettings()
{
    QSettings ini("DiskRaptor", "DiskRaptor");
    QVariantMap all;
    for (const auto &key : ini.allKeys()) {
        all[key] = ini.value(key);
    }
    return resultToJson(true, all);
}

QString SettingsHandler::resultToJson(bool success, const QVariant &data, const QString &error)
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
