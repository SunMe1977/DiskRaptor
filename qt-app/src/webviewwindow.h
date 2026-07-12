// DiskRaptor — Main Window with QtWebEngine
#pragma once

#include <QMainWindow>
#include <QWebEngineView>
#include <QWebChannel>
#include <QLineEdit>
#include <QPushButton>
#include <QLabel>
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QStatusBar>
#include <QProgressBar>
#include <QSplitter>
#include <QTreeWidget>
#include <QFileDialog>
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
    void onScanClicked();
    void onBrowseClicked();
    void onCancelClicked();
    void onScanProgress(const ScanProgress &progress);
    void onScanComplete(const ScanResult &result);
    void onScanError(const QString &error);

private:
    void setupUI();
    void setupWebEngine(const QString &frontendPath);
    void setupConnections();
    QString readFile(const QString &path);

    // UI elements
    QWebEngineView *m_webView = nullptr;
    QWebChannel *m_webChannel = nullptr;
    IpcBridge *m_ipcBridge = nullptr;
    Scanner *m_scanner = nullptr;

    // Toolbar
    QLineEdit *m_pathInput = nullptr;
    QPushButton *m_btnBrowse = nullptr;
    QPushButton *m_btnScan = nullptr;
    QPushButton *m_btnCancel = nullptr;

    QLabel *m_statusLabel = nullptr;
    QProgressBar *m_progressBar = nullptr;

    QString m_frontendPath;
    bool m_isScanning = false;
};
