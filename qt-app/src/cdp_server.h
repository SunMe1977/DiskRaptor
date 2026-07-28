#pragma once

#include <QObject>
#include <QTcpServer>
#include <QTcpSocket>
#include <QJsonObject>
#include <QList>
#include <QString>

class WKWebViewWrapper;

class CdpServer : public QObject
{
    Q_OBJECT
public:
    CdpServer(WKWebViewWrapper *webView, quint16 port, const QString &frontendPath = QString(), QObject *parent = nullptr);
    ~CdpServer() override;

private slots:
    void onNewConnection();
    void onReadyRead();

private:
    void handleHttpGet(QTcpSocket *socket, const QString &path);
    void handleCdpMessage(QTcpSocket *ws, const QJsonObject &msg);
    void sendCdpResponse(QTcpSocket *ws, int id, const QJsonObject &result);
    void sendCdpError(QTcpSocket *ws, int id, const QString &msg);

    WKWebViewWrapper *m_webView;
    QTcpServer *m_server;
    QList<QTcpSocket *> m_webSockets;
    QString m_wsUrl;
    QString m_frontendPath;
};
