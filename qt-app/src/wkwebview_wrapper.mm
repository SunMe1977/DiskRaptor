#import "wkwebview_wrapper.h"

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

#include <QJsonObject>
#include <QJsonDocument>
#include <QMetaType>
#include <QDebug>

// ── Message handler that forwards WKScriptMessage to C++ wrapper ─
@interface DRMessageHandler : NSObject <WKScriptMessageHandler>
@property (nonatomic, assign) WKWebViewWrapper *wrapper;
@end

@implementation DRMessageHandler
- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message
{
    if (!self.wrapper) return;
    NSDictionary *body = (NSDictionary *)message.body;
    if (![body isKindOfClass:[NSDictionary class]]) return;

    NSString *msgId = body[@"id"];
    NSString *cmd = body[@"cmd"];
    NSDictionary *argsDict = body[@"args"];

    if (![cmd isKindOfClass:[NSString class]]) return;

    QVariantMap args;
    if ([argsDict isKindOfClass:[NSDictionary class]]) {
        for (NSString *key in argsDict) {
            id val = argsDict[key];
            if ([val isKindOfClass:[NSString class]])
                args[QString::fromNSString(key)] = QString::fromNSString((NSString *)val);
            else if ([val isKindOfClass:[NSNumber class]])
                args[QString::fromNSString(key)] = QVariant([(NSNumber *)val doubleValue]);
            else if ([val isKindOfClass:[NSDictionary class]])
                args[QString::fromNSString(key)] = QVariant(); // skip nested dicts
        }
    }

    self.wrapper->handleMessage(
        msgId ? QString::fromNSString(msgId) : QString(),
        QString::fromNSString(cmd),
        args);
}
@end

// ── Navigation delegate ──────────────────────────────────────────
@interface DRNavigationDelegate : NSObject <WKNavigationDelegate>
@property (nonatomic, assign) WKWebViewWrapper *wrapper;
@end

@implementation DRNavigationDelegate
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation
{
    if (self.wrapper)
        emit self.wrapper->loadFinished(true);
}
- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation
        withError:(NSError *)error
{
    if (self.wrapper)
        emit self.wrapper->loadFinished(false);
}
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation
        withError:(NSError *)error
{
    if (self.wrapper)
        emit self.wrapper->loadFinished(false);
}
@end

// ── WKWebViewWrapper implementation ──────────────────────────────
WKWebViewWrapper::WKWebViewWrapper(QWidget *parent)
    : QWidget(parent)
{
    setAttribute(Qt::WA_NativeWindow, true);

    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    WKUserContentController *ctrl = [[WKUserContentController alloc] init];
    config.userContentController = ctrl;

    NSRect frame = NSMakeRect(0, 0, width(), height());
    WKWebView *webView = [[WKWebView alloc] initWithFrame:frame configuration:config];
    webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

    DRMessageHandler *handler = [[DRMessageHandler alloc] init];
    handler.wrapper = this;
    [ctrl addScriptMessageHandler:handler name:@"bridge"];

    DRNavigationDelegate *navDel = [[DRNavigationDelegate alloc] init];
    navDel.wrapper = this;
    webView.navigationDelegate = navDel;

    NSView *parentView = (__bridge NSView *)reinterpret_cast<void *>(winId());
    [parentView addSubview:webView];

    m_webView = (void *)CFBridgingRetain(webView);
    m_controller = (void *)CFBridgingRetain(ctrl);
}

WKWebViewWrapper::~WKWebViewWrapper()
{
    WKWebView *webView = (__bridge WKWebView *)m_webView;
    WKUserContentController *ctrl = (__bridge WKUserContentController *)m_controller;

    [ctrl removeScriptMessageHandlerForName:@"bridge"];
    [webView removeFromSuperview];

    CFBridgingRelease(m_webView);
    CFBridgingRelease(m_controller);
    m_webView = nullptr;
    m_controller = nullptr;
}

void WKWebViewWrapper::loadURL(const QUrl &url)
{
    WKWebView *webView = (__bridge WKWebView *)m_webView;
    NSURL *nsUrl = url.toNSURL();
    if (!nsUrl) return;

    if ([nsUrl isFileURL]) {
        NSURL *dirUrl = [nsUrl URLByDeletingLastPathComponent];
        [webView loadFileURL:nsUrl allowingReadAccessToURL:dirUrl];
    } else {
        NSURLRequest *req = [NSURLRequest requestWithURL:nsUrl];
        [webView loadRequest:req];
    }
}

void WKWebViewWrapper::evaluateJS(const QString &js)
{
    WKWebView *webView = (__bridge WKWebView *)m_webView;
    NSString *jsStr = js.toNSString();
    [webView evaluateJavaScript:jsStr completionHandler:nil];
}

void WKWebViewWrapper::evaluateJSWithCallback(const QString &js, std::function<void(const QString &)> callback)
{
    WKWebView *webView = (__bridge WKWebView *)m_webView;
    NSString *jsStr = js.toNSString();
    int callId = ++m_jsCallbackId;
    m_jsCallbacks[callId] = std::move(callback);
    [webView evaluateJavaScript:jsStr completionHandler:^(id result, NSError *error) {
        Q_UNUSED(error);
        NSString *str = nil;
        if ([result isKindOfClass:[NSString class]]) {
            str = (NSString *)result;
        } else if ([result isKindOfClass:[NSNumber class]]) {
            // Properly serialize booleans as JSON true/false, numbers as strings
            CFNumberType numType = CFNumberGetType((CFNumberRef)result);
            if (numType == kCFNumberCharType) {
                str = [result boolValue] ? @"true" : @"false";
            } else {
                str = [(NSNumber *)result stringValue];
            }
        } else if ([result isKindOfClass:[NSNull class]]) {
            str = @"null";
        } else if ([result isKindOfClass:[NSDictionary class]] || [result isKindOfClass:[NSArray class]]) {
            NSError *jsonErr = nil;
            NSData *jsonData = [NSJSONSerialization dataWithJSONObject:result options:0 error:&jsonErr];
            if (jsonData) str = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
        }
        QString qResult = str ? QString::fromNSString(str) : QString();
        if (auto cb = m_jsCallbacks.take(callId)) {
            cb(qResult);
        }
    }];
}

void WKWebViewWrapper::postEvent(const QString &event, const QVariant &payload)
{
    QJsonObject obj;
    if (payload.typeId() == QMetaType::QString) {
        obj["payload"] = payload.toString();
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

void WKWebViewWrapper::handleMessage(const QString &id, const QString &cmd,
                                      const QVariantMap &args)
{
    if (!m_invokeHandler) return;

    QString result = m_invokeHandler(cmd, args);
    // Escape for JS string
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

void WKWebViewWrapper::evaluateJSWithCallback(const QString &js, int cdpId, std::function<void(const QString &)> callback)
{
    Q_UNUSED(cdpId);
    evaluateJSWithCallback(js, std::move(callback));
}

void WKWebViewWrapper::onEvalResult(int cdpId, const QString &value, bool error)
{
    Q_UNUSED(cdpId);
    Q_UNUSED(value);
    Q_UNUSED(error);
}

void WKWebViewWrapper::resizeEvent(QResizeEvent *event)
{
    QWidget::resizeEvent(event);
    WKWebView *webView = (__bridge WKWebView *)m_webView;
    webView.frame = NSMakeRect(0, 0, width(), height());
}

// ── Native macOS Trash via NSFileManager (more reliable than AppleScript) ──
extern "C" bool macosMoveToTrash(const char *path)
{
    @autoreleasepool {
        NSString *nsPath = [NSString stringWithUTF8String:path];
        if (!nsPath) return false;
        NSURL *url = [NSURL fileURLWithPath:nsPath];
        if (!url) return false;
        NSURL *resultURL = nil;
        NSError *error = nil;
        BOOL ok = [[NSFileManager defaultManager] trashItemAtURL:url
                                                resultingItemURL:&resultURL
                                                           error:&error];
        if (!ok && error) {
            qWarning() << "[Trash] NSFileManager failed:" << QString::fromNSString(error.localizedDescription);
        }
        return (bool)ok;
    }
}
