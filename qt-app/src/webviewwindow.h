// DiskRaptor — Main Window with QtWebEngine
// Scanner operations are handled via Rust DLL through IpcBridge.
#pragma once

#include <QMainWindow>
#include <QWebEngineView>
#include <QWebEnginePage>
#include <QWebChannel>
#include <QLabel>
#include <QMenuBar>
#include <QMenu>
#include <QAction>
#include <QVBoxLayout>
#include <QStatusBar>
#include <QProgressBar>
#include <QSystemTrayIcon>
#include <QCloseEvent>
#include <QUrl>
#include <QDir>
#include <QDebug>
#include <QTimer>
#include <QDesktopServices>

#include "ipcbridge.h"

// WebView that opens target=_blank and new-window links in the system browser
class WebView : public QWebEngineView
{
    Q_OBJECT
public:
    using QWebEngineView::QWebEngineView;
protected:
    QWebEngineView *createWindow(QWebEnginePage::WebWindowType type) override
    {
        auto *dummy = new QWebEngineView();
        connect(dummy, &QWebEngineView::urlChanged, this, [](const QUrl &url) {
            QDesktopServices::openUrl(url);
        });
        QTimer::singleShot(0, dummy, &QObject::deleteLater);
        return dummy;
    }
};

class MainWindow : public QMainWindow
{
    Q_OBJECT

public:
    explicit MainWindow(const QString &frontendPath, QWidget *parent = nullptr);
    ~MainWindow() override;

private slots:
    // Menu action slots
    void onViewPie();
    void onViewGalaxy();
    void onViewTreemap();
    void onFindDuplicates();
    void onCheckUpdates();
    void onAbout();
    void onThemeChanged(const QString &theme);
    void onLanguageChanged(const QString &code);
    void onTrayActivated(QSystemTrayIcon::ActivationReason reason);

protected:
    void closeEvent(QCloseEvent *event) override;

private:
    void setupUI();
    void setupMenuBar();
    void setupWebEngine(const QString &frontendPath);

    // Helper: run JS in the webview
    void runJS(const QString &js);
    void setupTrayIcon();

    // UI elements
    WebView *m_webView = nullptr;
    QWebChannel *m_webChannel = nullptr;
    IpcBridge *m_ipcBridge = nullptr;

    QLabel *m_statusLabel = nullptr;
    QProgressBar *m_progressBar = nullptr;

    // System tray
    QSystemTrayIcon *m_trayIcon = nullptr;
    QMenu *m_trayMenu = nullptr;

    // Menu items
    QMenu *m_viewMenu = nullptr;
    QAction *m_viewPieAction = nullptr;
    QAction *m_viewGalaxyAction = nullptr;
    QAction *m_viewTreemapAction = nullptr;

    QString m_frontendPath;
};
