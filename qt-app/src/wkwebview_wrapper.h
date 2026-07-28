#pragma once

#include <QWidget>
#include <QUrl>
#include <QString>
#include <QVariantMap>
#include <QMap>
#include <functional>

class WKWebViewWrapper : public QWidget
{
    Q_OBJECT
public:
    using InvokeHandler = std::function<QString(const QString &cmd, const QVariantMap &args)>;

    explicit WKWebViewWrapper(QWidget *parent = nullptr);
    ~WKWebViewWrapper() override;

    void loadURL(const QUrl &url);
    void evaluateJS(const QString &js);
    void evaluateJSWithCallback(const QString &js, std::function<void(const QString &)> callback);
    void postEvent(const QString &event, const QVariant &payload);

    void setInvokeHandler(InvokeHandler handler);
    void handleMessage(const QString &id, const QString &cmd, const QVariantMap &args);

signals:
    void loadFinished(bool ok);

protected:
    void resizeEvent(QResizeEvent *event) override;

private:
    QMap<int, std::function<void(const QString &)>> m_jsCallbacks;
    int m_jsCallbackId = 0;
    void *m_webView = nullptr;
    void *m_controller = nullptr;
    InvokeHandler m_invokeHandler;
};
