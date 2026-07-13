// DiskRaptor — Main Window with QtWebEngine
#pragma once

#include <QMainWindow>
#include <QWebEngineView>
#include <QWebChannel>
#include <QLabel>
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

private:
    void setupUI();
    void setupWebEngine(const QString &frontendPath);
    void setupConnections();

    // UI elements
    QWebEngineView *m_webView = nullptr;
    QWebChannel *m_webChannel = nullptr;
    IpcBridge *m_ipcBridge = nullptr;
    Scanner *m_scanner = nullptr;

    QLabel *m_statusLabel = nullptr;
    QProgressBar *m_progressBar = nullptr;

    QString m_frontendPath;
};
