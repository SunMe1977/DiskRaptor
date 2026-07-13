// DiskRaptor — Main Window implementation
#include "webviewwindow.h"
#include <QMessageBox>
#include <QTimer>
#include <QFile>
#include <QTextStream>

MainWindow::MainWindow(const QString &frontendPath, QWidget *parent)
    : QMainWindow(parent), m_frontendPath(frontendPath)
{
    setupUI();
    setupWebEngine(frontendPath);
    setupConnections();

    m_statusLabel = new QLabel("Ready");
    statusBar()->addWidget(m_statusLabel, 1);

    m_progressBar = new QProgressBar();
    m_progressBar->setRange(0, 0);
    m_progressBar->setFixedWidth(150);
    m_progressBar->hide();
    statusBar()->addPermanentWidget(m_progressBar);

    qDebug() << "[DiskRaptor] Window initialized";
}

MainWindow::~MainWindow()
{
    if (m_scanner) {
        m_scanner->cancel();
    }
    qDebug() << "[DiskRaptor] Shutdown";
}

void MainWindow::setupUI()
{
    auto *centralWidget = new QWidget(this);
    auto *mainLayout = new QVBoxLayout(centralWidget);
    mainLayout->setContentsMargins(0, 0, 0, 0);
    mainLayout->setSpacing(0);

    // WebView fills the entire window (frontend handles its own toolbar)
    m_webView = new QWebEngineView();
    m_webView->setMinimumSize(800, 400);
    mainLayout->addWidget(m_webView, 1);

    setCentralWidget(centralWidget);
}

void MainWindow::setupWebEngine(const QString &frontendPath)
{
    m_scanner = new Scanner(this);
    m_ipcBridge = new IpcBridge(m_scanner, this);

    m_webChannel = new QWebChannel(this);
    m_webChannel->registerObject("bridge", m_ipcBridge);
    m_webView->page()->setWebChannel(m_webChannel);

    QString indexPath = QDir(frontendPath).filePath("index.html");
    QString url = QUrl::fromLocalFile(indexPath).toString();
    qDebug() << "[DiskRaptor] Loading:" << url;
    m_webView->load(QUrl(url));

    connect(m_webView, &QWebEngineView::loadFinished, this, [this](bool ok) {
        if (ok) {
            qDebug() << "[DiskRaptor] Frontend loaded successfully";
            m_statusLabel->setText("Frontend loaded");
        } else {
            qWarning() << "[DiskRaptor] Frontend load FAILED";
            m_statusLabel->setText("Frontend load failed!");
        }
    });

    m_webView->page()->setBackgroundColor(QColor("#0d1117"));
}

void MainWindow::setupConnections()
{
    connect(m_scanner, &Scanner::progressUpdated, this, &MainWindow::onScanProgress);
    connect(m_scanner, &Scanner::scanComplete, this, &MainWindow::onScanComplete);
    connect(m_scanner, &Scanner::scanError, this, &MainWindow::onScanError);
}

void MainWindow::onScanProgress(const ScanProgress &progress)
{
    QString js = QString(
        "if (window.__TAURI__ && window.__TAURI__.events) {"
        "  window.__TAURI__.events.dispatchEvent(new CustomEvent('scan-progress', "
        "    { detail: { filesFound: %1, dirsFound: %2, currentDir: '%3', "
        "               elapsedSecs: %4 } }));"
        "}"
    ).arg(progress.filesFound)
     .arg(progress.dirsFound)
     .arg(progress.currentDir)
     .arg(progress.elapsedSecs);

    m_webView->page()->runJavaScript(js);
    m_statusLabel->setText(
        QString("Scanning… %1 files, %2 dirs")
            .arg(progress.filesFound).arg(progress.dirsFound));
}

void MainWindow::onScanComplete(const ScanResult &result)
{
    m_statusLabel->setText(
        QString("Complete — %1 files, %2 dirs, %3")
            .arg(result.totalFiles)
            .arg(result.totalDirs)
            .arg(formatBytes(result.totalSize)));

    QString json = result.toJson();
    QString js = QString(
        "if (window.__TAURI__ && window.__TAURI__.events) {"
        "  window.__TAURI__.events.dispatchEvent(new CustomEvent('scan-complete', "
        "    { detail: %1 }));"
        "}"
    ).arg(json);

    m_webView->page()->runJavaScript(js);

    // Also update progress bar to "done" state briefly
    m_progressBar->setRange(0, 100);
    m_progressBar->setValue(100);
    QTimer::singleShot(2000, this, [this]() {
        m_progressBar->hide();
        m_progressBar->setRange(0, 0);
    });

    qDebug() << "[DiskRaptor] Scan complete:" << result.totalFiles << "files";
}

void MainWindow::onScanError(const QString &error)
{
    m_statusLabel->setText("Error: " + error);
    m_progressBar->hide();

    QString escaped = QString(error).replace("'", "\\'");
    QString js = QString(
        "if (window.__TAURI__ && window.__TAURI__.events) {"
        "  window.__TAURI__.events.dispatchEvent(new CustomEvent('scan-error', "
        "    { detail: { error: '%1' } }));"
        "}"
    ).arg(escaped);

    m_webView->page()->runJavaScript(js);
    qWarning() << "[DiskRaptor] Scan error:" << error;
}
