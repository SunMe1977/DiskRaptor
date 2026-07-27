// DiskRaptor — File operations handler
#pragma once

#include <QObject>
#include <QString>
#include <QVariant>
#include <QJsonObject>
#include <QJsonDocument>

class FileOpsHandler : public QObject
{
    Q_OBJECT

public:
    explicit FileOpsHandler(QObject *parent = nullptr);

    QString deletePath(const QString &path);
    QString openExplorer(const QString &path);
    QString openTerminal(const QString &path);
    QString openProperties(const QString &path);
    QString getIcon(const QString &path, bool isDir);
    QString deletePermanent(const QString &path);

private:
    QString resultToJson(bool success, const QVariant &data = QVariant(),
                         const QString &error = QString());
};
