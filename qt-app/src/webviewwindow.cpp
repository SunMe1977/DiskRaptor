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

    m_pathInput->setText(QDir::homePath());
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

    // Toolbar
    auto *toolbar = new QWidget();
    auto *toolbarLayout = new QHBoxLayout(toolbar);
    toolbarLayout->setContentsMargins(8, 6, 8, 6);

    auto *logo = new QLabel("🦅 DiskRaptor");
    logo->setStyleSheet("font-size: 16px; font-weight: 700; margin-right: 12px;");

    m_pathInput = new QLineEdit();
    m_pathInput->setPlaceholderText("Select or enter a directory path…");
    m_pathInput->setMinimumWidth(300);

    m_btnBrowse = new QPushButton("📂 Browse");
    m_btnScan = new QPushButton("⚡ Scan");
    m_btnScan->setStyleSheet(
        "QPushButton { background: #0078d4; color: white; padding: 6px 20px;"
        "  border-radius: 6px; font-weight: 600; }"
        "QPushButton:hover { background: #106ebe; }"
        "QPushButton:disabled { background: #555; }");
    m_btnCancel = new QPushButton("✕ Cancel");
    m_btnCancel->setEnabled(false);

    toolbarLayout->addWidget(logo);
    toolbarLayout->addWidget(m_pathInput, 1);
    toolbarLayout->addWidget(m_btnBrowse);
    toolbarLayout->addWidget(m_btnScan);
    toolbarLayout->addWidget(m_btnCancel);

    mainLayout->addWidget(toolbar);

    // WebView
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
    connect(m_btnScan, &QPushButton::clicked, this, &MainWindow::onScanClicked);
    connect(m_btnBrowse, &QPushButton::clicked, this, &MainWindow::onBrowseClicked);
    connect(m_btnCancel, &QPushButton::clicked, this, &MainWindow::onCancelClicked);

    connect(m_scanner, &Scanner::progressUpdated, this, &MainWindow::onScanProgress);
    connect(m_scanner, &Scanner::scanComplete, this, &MainWindow::onScanComplete);
    connect(m_scanner, &Scanner::scanError, this, &MainWindow::onScanError);

    connect(m_pathInput, &QLineEdit::returnPressed, this, &MainWindow::onScanClicked);
}

void MainWindow::onScanClicked()
{
    if (m_isScanning) return;

    QString path = m_pathInput->text().trimmed();
    if (path.isEmpty()) {
        QMessageBox::information(this, "DiskRaptor", "Please enter a directory path.");
        return;
    }

    if (!QDir(path).exists()) {
        QMessageBox::warning(this, "DiskRaptor",
            "Directory does not exist:\n" + path);
        return;
    }

    m_isScanning = true;
    m_btnScan->setEnabled(false);
    m_btnCancel->setEnabled(true);
    m_statusLabel->setText("Scanning: " + path);
    m_progressBar->show();

    qDebug() << "[DiskRaptor] Starting scan:" << path;
    m_scanner->startScan(path);

    // Notify frontend via JavaScript
    QString js = QString(
        "if (window.__TAURI__ && window.__TAURI__.events) {"
        "  window.__TAURI__.events.dispatchEvent(new CustomEvent('scan-started', "
        "    { detail: { path: '%1' } }));"
        "}"
    ).arg(path);
    m_webView->page()->runJavaScript(js);
}

void MainWindow::onBrowseClicked()
{
    QString dir = QFileDialog::getExistingDirectory(this,
        "Select Directory to Scan", m_pathInput->text());
    if (!dir.isEmpty()) {
        m_pathInput->setText(dir);
    }
}

void MainWindow::onCancelClicked()
{
    m_scanner->cancel();
    m_isScanning = false;
    m_btnScan->setEnabled(true);
    m_btnCancel->setEnabled(false);
    m_progressBar->hide();
    m_statusLabel->setText("Cancelled");
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
    m_isScanning = false;
    m_btnScan->setEnabled(true);
    m_btnCancel->setEnabled(false);
    m_progressBar->hide();

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
    qDebug() << "[DiskRaptor] Scan complete:" << result.totalFiles << "files";
}

void MainWindow::onScanError(const QString &error)
{
    m_isScanning = false;
    m_btnScan->setEnabled(true);
    m_btnCancel->setEnabled(false);
    m_progressBar->hide();
    m_statusLabel->setText("Error: " + error);
    qWarning() << "[DiskRaptor] Scan error:" << error;
}
