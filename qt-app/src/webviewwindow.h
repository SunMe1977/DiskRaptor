#pragma once

#include <QMainWindow>
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
#include "wkwebview_wrapper.h"

class MainWindow : public QMainWindow
{
    Q_OBJECT

public:
    explicit MainWindow(const QString &frontendPath, QWidget *parent = nullptr);
    ~MainWindow() override;

    WKWebViewWrapper *webView() const { return m_webView; }

private slots:
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
    void setupWebView(const QString &frontendPath);
    void runJS(const QString &js);
    void setupTrayIcon();
    QString handleInvoke(const QString &cmd, const QVariantMap &args);

    WKWebViewWrapper *m_webView = nullptr;
    IpcBridge *m_ipcBridge = nullptr;

    QLabel *m_statusLabel = nullptr;
    QProgressBar *m_progressBar = nullptr;

    QSystemTrayIcon *m_trayIcon = nullptr;
    QMenu *m_trayMenu = nullptr;

    QMenu *m_viewMenu = nullptr;
    QAction *m_viewPieAction = nullptr;
    QAction *m_viewGalaxyAction = nullptr;
    QAction *m_viewTreemapAction = nullptr;

    QString m_frontendPath;
};
