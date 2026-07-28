#include "cdp_server.h"
#include "wkwebview_wrapper.h"

#include <QJsonDocument>
#include <QJsonArray>
#include <QUrl>
#include <QCryptographicHash>
#include <QTimer>
#include <QDebug>
#include <QMap>

enum WS_OPCODE { WS_TEXT = 0x1, WS_CLOSE = 0x8, WS_PING = 0x9, WS_PONG = 0xA };

static void wsSendText(QTcpSocket *socket, const QByteArray &payload)
{
    QByteArray frame;
    frame.append(0x81);
    if (payload.size() < 126) {
        frame.append(char(payload.size()));
    } else if (payload.size() < 65536) {
        frame.append(126);
        frame.append((payload.size() >> 8) & 0xFF);
        frame.append(payload.size() & 0xFF);
    } else {
        frame.append(127);
        for (int i = 7; i >= 0; i--)
            frame.append(char((payload.size() >> (i * 8)) & 0xFF));
    }
    frame.append(payload);
    socket->write(frame);
    socket->flush();
}

CdpServer::CdpServer(WKWebViewWrapper *webView, quint16 port, const QString &frontendPath, QObject *parent)
    : QObject(parent), m_webView(webView), m_frontendPath(frontendPath)
{
    m_server = new QTcpServer(this);
    connect(m_server, &QTcpServer::newConnection, this, &CdpServer::onNewConnection);

    if (m_server->listen(QHostAddress::LocalHost, port)) {
        m_wsUrl = QString("ws://127.0.0.1:%1/devtools/page/1").arg(port);
        qDebug() << "[CDP] Server listening on port" << port;
    } else {
        qWarning() << "[CDP] Failed to listen on port" << port;
    }
}

CdpServer::~CdpServer()
{
    for (auto *s : m_webSockets) {
        s->flush();
        s->disconnectFromHost();
    }
    m_server->close();
}

void CdpServer::onNewConnection()
{
    QTcpSocket *socket = m_server->nextPendingConnection();
    if (!socket) return;
    connect(socket, &QTcpSocket::readyRead, this, &CdpServer::onReadyRead);
    connect(socket, &QTcpSocket::disconnected, socket, [socket, this]() {
        m_webSockets.removeOne(socket);
        socket->deleteLater();
    });
}

static QMap<QTcpSocket*, QByteArray> s_wsBufs;

void CdpServer::onReadyRead()
{
    QTcpSocket *socket = qobject_cast<QTcpSocket *>(sender());
    if (!socket) return;

    // WebSocket mode (already upgraded)
    if (m_webSockets.contains(socket)) {
        s_wsBufs[socket].append(socket->readAll());
        QByteArray &buf = s_wsBufs[socket];
        while (buf.size() >= 2) {
            uchar first = buf[0];
            uchar second = buf[1];
            uchar opcode = first & 0x0F;
            bool masked = (second & 0x80) != 0;
            quint64 payloadLen = second & 0x7F;
            int offset = 2;
            if (payloadLen == 126) {
                if (buf.size() < 4) break;
                payloadLen = (uchar(buf[2]) << 8) | uchar(buf[3]);
                offset = 4;
            } else if (payloadLen == 127) {
                if (buf.size() < 10) break;
                payloadLen = 0;
                for (int i = 0; i < 8; i++)
                    payloadLen = (payloadLen << 8) | uchar(buf[2 + i]);
                offset = 10;
            }
            QByteArray maskKey;
            if (masked) {
                if (buf.size() < offset + 4) break;
                maskKey = buf.mid(offset, 4);
                offset += 4;
            }
            if (buf.size() < offset + int(payloadLen)) break;

            QByteArray payload = buf.mid(offset, payloadLen);
            buf = buf.mid(offset + payloadLen);
            if (masked) {
                for (int i = 0; i < int(payloadLen); i++)
                    payload[i] = payload[i] ^ maskKey[i % 4];
            }
            if (opcode == WS_CLOSE) {
                socket->disconnectFromHost();
                m_webSockets.removeOne(socket);
                s_wsBufs.remove(socket);
                return;
            }
            if (opcode == WS_PING) {
                QByteArray pong;
                pong.append(0x8A);
                pong.append(char(payload.size()));
                pong.append(payload);
                socket->write(pong);
                socket->flush();
                continue;
            }
            if (opcode == WS_TEXT) {
                QJsonDocument doc = QJsonDocument::fromJson(payload);
                if (doc.isObject())
                    handleCdpMessage(socket, doc.object());
            }
        }
        return;
    }

    // HTTP mode
    QByteArray data = socket->readAll();
    int headerEnd = data.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;

    QString req = QString::fromUtf8(data.left(headerEnd));

    if (req.startsWith("GET /json")) {
        handleHttpGet(socket, "/json");
        return;
    }

    if (req.startsWith("GET /devtools/")) {
        QStringList lines = req.split("\r\n");
        QString wsKey;
        for (const auto &line : lines) {
            if (line.startsWith("Sec-WebSocket-Key:", Qt::CaseInsensitive)) {
                wsKey = line.mid(18).trimmed();
                break;
            }
        }
        if (wsKey.isEmpty()) {
            socket->write("HTTP/1.1 400 Bad Request\r\n\r\n");
            socket->disconnectFromHost();
            return;
        }

        qDebug() << "[CDP] WS key:" << wsKey;
        QByteArray rawKey = wsKey.toLatin1();
        QByteArray acceptRaw = QCryptographicHash::hash(
            rawKey + QByteArray("258EAFA5-E914-47DA-95CA-C5AB0DC85B11"),
            QCryptographicHash::Sha1).toBase64();
        QString acceptKey = QString::fromUtf8(acceptRaw);
        QByteArray response = QString(
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Accept: %1\r\n"
            "\r\n").arg(acceptKey).toUtf8();
        socket->write(response);
        socket->flush();

        m_webSockets.append(socket);
        return;
    }

    socket->write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket->disconnectFromHost();
}

void CdpServer::handleHttpGet(QTcpSocket *socket, const QString &path)
{
    Q_UNUSED(path);
    QJsonArray targets;
    QJsonObject target;
    target["id"] = "1";
    target["title"] = "DiskRaptor";
    target["url"] = "qrc:///index.html";
    target["webSocketDebuggerUrl"] = m_wsUrl;
    target["type"] = "page";
    targets.append(target);

    QByteArray body = QJsonDocument(targets).toJson();
    QByteArray response = QString(
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: %1\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Connection: close\r\n"
        "\r\n").arg(body.size()).toUtf8() + body;
    socket->write(response);
    socket->disconnectFromHost();
}

void CdpServer::handleCdpMessage(QTcpSocket *socket, const QJsonObject &msg)
{
    int id = msg["id"].toInt(-1);
    QString method = msg["method"].toString();

    if (method == "Runtime.evaluate") {
        QJsonObject params = msg["params"].toObject();
        QString expression = params["expression"].toString();
        bool awaitPromise = params["awaitPromise"].toBool(false);

        if (!m_webView) {
            sendCdpError(socket, id, "No webview");
            return;
        }

        if (!awaitPromise) {
            m_webView->evaluateJS(expression);
            QJsonObject result;
            result["result"] = QJsonValue::Null;
            sendCdpResponse(socket, id, result);
        } else {
            m_webView->evaluateJSWithCallback(expression, [this, socket, id](const QString &value) {
                QJsonObject innerResult;
                if (value == "true" || value == "false") {
                    innerResult["type"] = "boolean";
                    innerResult["value"] = (value == "true");
                } else if (value == "null") {
                    innerResult["type"] = "object";
                    innerResult["value"] = QJsonValue::Null;
                } else {
                    QJsonDocument doc = QJsonDocument::fromJson(value.toUtf8());
                    if (!doc.isNull()) {
                        if (doc.isObject()) {
                            innerResult["type"] = "object";
                            innerResult["value"] = doc.object();
                        } else if (doc.isArray()) {
                            innerResult["type"] = "object";
                            innerResult["value"] = doc.array();
                        } else {
                            QJsonValue jv = doc.toVariant().toJsonValue();
                            if (jv.isDouble())
                                innerResult["type"] = "number";
                            else if (jv.isBool())
                                innerResult["type"] = "boolean";
                            else if (jv.isString())
                                innerResult["type"] = "string";
                            else
                                innerResult["type"] = "string";
                            innerResult["value"] = jv;
                        }
                    } else {
                        innerResult["type"] = "string";
                        innerResult["value"] = value;
                    }
                }
                QJsonObject resultObj;
                resultObj["result"] = innerResult;
                sendCdpResponse(socket, id, resultObj);
            });
        }
        return;
    }

    if (method == "Runtime.awaitPromise") {
        QJsonObject result;
        result["result"] = QJsonValue::Null;
        sendCdpResponse(socket, id, result);
        return;
    }

    if (method == "Page.enable") {
        sendCdpResponse(socket, id, QJsonObject());
        return;
    }

    if (method == "Page.navigate") {
        QJsonObject params = msg["params"].toObject();
        QString url = params["url"].toString();
        if (url.startsWith("qrc:///") && !m_frontendPath.isEmpty()) {
            // Redirect Qt resource URL to actual frontend file
            QString relativePath = url.mid(QString("qrc:///").length());
            url = QUrl::fromLocalFile(m_frontendPath + "/" + relativePath).toString();
        }
        if (m_webView)
            m_webView->loadURL(QUrl(url));
        sendCdpResponse(socket, id, QJsonObject{{"frameId", "1"}});
        return;
    }

    if (method == "Input.dispatchKeyEvent") {
        QJsonObject params = msg["params"].toObject();
        QString type = params["type"].toString();
        QString key = params["key"].toString();
        QString js = QString(
            "(function(){"
            "  var e = new KeyboardEvent('%1', {key: '%2', bubbles: true, cancelable: true});"
            "  document.dispatchEvent(e);"
            "})()"
        ).arg(type, key);
        if (m_webView)
            m_webView->evaluateJS(js);
        sendCdpResponse(socket, id, QJsonObject());
        return;
    }

    if (method == "Page.bringToFront") {
        sendCdpResponse(socket, id, QJsonObject());
        return;
    }

    if (method == "Target.setAutoAttach" || method == "Target.attachToTarget" ||
        method == "Target.getTargets" || method == "Runtime.runIfWaitingForDebugger" ||
        method == "Network.enable" || method == "DOM.enable" ||
        method == "CSS.enable" || method == "Overlay.enable" ||
        method == "Page.getResourceTree" || method == "Page.getFrameTree" ||
        method == "Page.setLifecycleEventsEnabled" || method == "Fetch.enable" ||
        method == "Network.setCacheDisabled" || method == "Emulation.setDeviceMetricsOverride" ||
        method == "Emulation.setTouchEmulationEnabled" || method == "Target.setDiscoverTargets") {
        sendCdpResponse(socket, id, QJsonObject());
        return;
    }

    qDebug() << "[CDP] Unhandled method:" << method;
    sendCdpResponse(socket, id, QJsonObject());
}

void CdpServer::sendCdpResponse(QTcpSocket *socket, int id, const QJsonObject &result)
{
    QJsonObject msg;
    msg["id"] = id;
    msg["result"] = result;
    wsSendText(socket, QJsonDocument(msg).toJson(QJsonDocument::Compact));
}

void CdpServer::sendCdpError(QTcpSocket *socket, int id, const QString &msg)
{
    QJsonObject error;
    error["code"] = -32000;
    error["message"] = msg;
    QJsonObject response;
    response["id"] = id;
    response["error"] = error;
    wsSendText(socket, QJsonDocument(response).toJson(QJsonDocument::Compact));
}
