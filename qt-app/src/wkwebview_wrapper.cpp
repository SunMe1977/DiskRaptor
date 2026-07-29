#include "wkwebview_wrapper.h"

#include <QWebEngineView>
#include <QWebEnginePage>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QVBoxLayout>
#include <QResizeEvent>
#include <QMetaType>

class BridgePage : public QWebEnginePage
{
    Q_OBJECT
public:
    BridgePage(WKWebViewWrapper *wrapper, QObject *parent = nullptr)
        : QWebEnginePage(parent), m_wrapper(wrapper) {}

protected:
    void javaScriptConsoleMessage(JavaScriptConsoleMessageLevel level, const QString &msg, int line, const QString &source) override
    {
        QWebEnginePage::javaScriptConsoleMessage(level, msg, line, source);
        if (!m_wrapper) return;
        if (msg.startsWith(QLatin1String("__bridge__:"))) {
            QByteArray json = msg.mid(11).toUtf8();
            QJsonDocument doc = QJsonDocument::fromJson(json);
            if (doc.isObject()) {
                QJsonObject obj = doc.object();
                m_wrapper->handleMessage(obj[QStringLiteral("id")].toString(),
                                          obj[QStringLiteral("cmd")].toString(),
                                          obj[QStringLiteral("args")].toObject().toVariantMap());
            }
        } else if (msg.startsWith(QLatin1String("__eval_ok__:"))) {
            QString rest = msg.mid(12);
            int colon = rest.indexOf(':');
            if (colon > 0) {
                int cdpId = rest.left(colon).toInt();
                QString val = rest.mid(colon + 1);
                m_wrapper->onEvalResult(cdpId, val, false);
            }
        } else if (msg.startsWith(QLatin1String("__eval_err__:"))) {
            QString rest = msg.mid(13);
            int colon = rest.indexOf(':');
            if (colon > 0) {
                int cdpId = rest.left(colon).toInt();
                QString val = rest.mid(colon + 1);
                m_wrapper->onEvalResult(cdpId, val, true);
            }
        }
    }

private:
    WKWebViewWrapper *m_wrapper;
};

WKWebViewWrapper::WKWebViewWrapper(QWidget *parent)
    : QWidget(parent)
{
    auto *layout = new QVBoxLayout(this);
    layout->setContentsMargins(0, 0, 0, 0);

    auto *webView = new QWebEngineView(this);
    m_webView = webView;
    layout->addWidget(webView);

    auto *page = new BridgePage(this, webView);
    webView->setPage(page);

    connect(page, &QWebEnginePage::loadFinished, this, [this, webView](bool ok) {
        if (ok) {
            webView->page()->runJavaScript(QStringLiteral(
                "(function(){"
                "  if(window.__qtBridgeReady)return;"
                "  var _c={},_i=0;"
                "  window.__TAURI__=window.__TAURI__||{};"
                "  window.__TAURI__.invoke=function(cmd,args){"
                "    return new Promise(function(resolve){"
                "      var id='i'+(++_i);_c[id]=resolve;"
                "      console.log('__bridge__:'+JSON.stringify({id:id,cmd:cmd,args:args||{}}));"
                "    });"
                "  };"
                "  window.__TAURI__._resolve=function(id,data){"
                "    var cb=_c[id];if(cb){delete _c[id];"
                "      try{var p=JSON.parse(data);"
                "        cb(p&&typeof p==='object'&&p.data!==undefined?p.data:data);"
                "      }catch(e){cb(data);}"
                "    }"
                "  };"
                "  window.__TAURI__.__qtBridgeReady=true;"
                "  window.dispatchEvent(new CustomEvent('tauri-bridge-ready'));"
                "})();"
            ));
        }
        emit loadFinished(ok);
    });
}

WKWebViewWrapper::~WKWebViewWrapper()
{
}

void WKWebViewWrapper::loadURL(const QUrl &url)
{
    auto *webView = static_cast<QWebEngineView *>(m_webView);
    webView->load(url);
}

void WKWebViewWrapper::evaluateJS(const QString &js)
{
    auto *webView = static_cast<QWebEngineView *>(m_webView);
    webView->page()->runJavaScript(js);
}

void WKWebViewWrapper::evaluateJSWithCallback(const QString &js, std::function<void(const QString &)> callback)
{
    auto *webView = static_cast<QWebEngineView *>(m_webView);
    webView->page()->runJavaScript(js, [cb = std::move(callback)](const QVariant &result) mutable {
        QString str;
        if (result.isNull())
            str = QStringLiteral("null");
        else if (result.typeId() == QMetaType::QString)
            str = result.toString();
        else if (result.typeId() == QMetaType::Bool)
            str = result.toBool() ? QStringLiteral("true") : QStringLiteral("false");
        else if (result.typeId() == QMetaType::Double || result.typeId() == QMetaType::Int)
            str = result.toString();
        else if (result.typeId() == QMetaType::QVariantMap || result.typeId() == QMetaType::QVariantHash)
            str = QString::fromUtf8(QJsonDocument(QJsonObject::fromVariantMap(result.toMap())).toJson(QJsonDocument::Compact));
        else if (result.typeId() == QMetaType::QVariantList || result.typeId() == QMetaType::QStringList)
            str = QString::fromUtf8(QJsonDocument(QJsonArray::fromVariantList(result.toList())).toJson(QJsonDocument::Compact));
        else
            str = result.toString();
        cb(str);
    });
}

void WKWebViewWrapper::evaluateJSWithCallback(const QString &js, int cdpId, std::function<void(const QString &)> callback)
{
    m_pendingEval[cdpId] = std::move(callback);
    QString wrapped = QStringLiteral(
        "(function(){"
        "  var __r=%1;"
        "  if(__r&&typeof __r.then==='function'){"
        "    __r.then(function(v){console.log('__eval_ok__:%2:'+JSON.stringify(v));},"
        "             function(e){console.log('__eval_err__:%2:'+JSON.stringify(String(e)));});"
        "  }else{"
        "    console.log('__eval_ok__:%2:'+JSON.stringify(__r));"
        "  }"
        "})();"
    ).arg(js, QString::number(cdpId));
    auto *webView = static_cast<QWebEngineView *>(m_webView);
    webView->page()->runJavaScript(wrapped);
}

void WKWebViewWrapper::onEvalResult(int cdpId, const QString &value, bool error)
{
    Q_UNUSED(error);
    if (auto cb = m_pendingEval.take(cdpId))
        cb(value);
}

void WKWebViewWrapper::postEvent(const QString &event, const QVariant &payload)
{
    QJsonObject obj;
    if (payload.typeId() == QMetaType::QString) {
        obj[QStringLiteral("payload")] = payload.toString();
    } else if (payload.typeId() == QMetaType::QVariantMap) {
        obj = QJsonObject::fromVariantMap(payload.toMap());
    }
    QJsonDocument doc(obj);
    QString json = QString::fromUtf8(doc.toJson(QJsonDocument::Compact));
    json.replace("'", "\\'");
    json.replace("\n", "\\n");
    evaluateJS(QString(
        "(function(){var e=new CustomEvent('tauri-event',{detail:{type:'%1',payload:%2}});"
        "window.dispatchEvent(e);"
        "if(window.__TAURI__&&window.__TAURI__.event)"
        "  window.__TAURI__.event.emit('%1',%2);})()"
    ).arg(event, json));
}

void WKWebViewWrapper::setInvokeHandler(InvokeHandler handler)
{
    m_invokeHandler = std::move(handler);
}

void WKWebViewWrapper::handleMessage(const QString &id, const QString &cmd, const QVariantMap &args)
{
    if (!m_invokeHandler) return;

    QString result = m_invokeHandler(cmd, args);
    QString escaped = result;
    escaped.replace("\\", "\\\\");
    escaped.replace("'", "\\'");
    escaped.replace("\n", "\\n");

    evaluateJS(QString(
        "(function(){"
        "  var id='%1';"
        "  var result='%2';"
        "  if(window.__TAURI__&&window.__TAURI__._resolve)"
        "    window.__TAURI__._resolve(id,result);"
        "})()"
    ).arg(id, escaped));
}

QString WKWebViewWrapper::invokeSync(const QString &cmd, const QVariantMap &args)
{
    if (!m_invokeHandler)
        return QStringLiteral("{\"success\":false,\"error\":\"No handler\"}");
    return m_invokeHandler(cmd, args);
}

void WKWebViewWrapper::resizeEvent(QResizeEvent *event)
{
    QWidget::resizeEvent(event);
}

#include "wkwebview_wrapper.moc"
