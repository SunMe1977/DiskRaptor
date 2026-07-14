// DiskRaptor — Main Window with QtWebEngine
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
#include <QUrl>
#include <QDir>
#include <QDebug>

#include "ipcbridge.h"
#include "scanner.h"

class MainWindow : public QMainWindow
{
    Q_OBJECT

public:
    explicit MainWindow(const QString &frontendPath, QWidget *parent = nullptr);
    ~MainWindow() override;

private slots:
    void onScanProgress(const ScanProgress &progress);
    void onScanComplete(const ScanResult &result);
    void onScanError(const QString &error);

    // Menu action slots
    void onViewPie();
    void onViewGalaxy();
    void onViewTreemap();
    void onFindDuplicates();
    void onCheckUpdates();
    void onAbout();
    void onLanguageChanged(const QString &code);

private:
    void setupUI();
    void setupMenuBar();
    void setupWebEngine(const QString &frontendPath);
    void setupConnections();

    // Helper: run JS in the webview
    void runJS(const QString &js);

    // UI elements
    QWebEngineView *m_webView = nullptr;
    QWebChannel *m_webChannel = nullptr;
    IpcBridge *m_ipcBridge = nullptr;
    Scanner *m_scanner = nullptr;

    QLabel *m_statusLabel = nullptr;
    QProgressBar *m_progressBar = nullptr;

    // Menu items
    QMenu *m_viewMenu = nullptr;
    QAction *m_viewPieAction = nullptr;
    QAction *m_viewGalaxyAction = nullptr;
    QAction *m_viewTreemapAction = nullptr;

    QString m_frontendPath;
};
