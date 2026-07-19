// DiskRaptor — Main Window implementation
// Scanner is now a Rust DLL loaded by IpcBridge — no C++ scanner object needed.
#include "webviewwindow.h"
#include <QMessageBox>
#include <QTimer>
#include <QFile>
#include <QTextStream>
#include <QApplication>

MainWindow::MainWindow(const QString &frontendPath, QWidget *parent)
    : QMainWindow(parent), m_frontendPath(frontendPath)
{
    setupUI();
    setupMenuBar();
    setupTrayIcon();
    setupWebEngine(frontendPath);

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
    // Rust scanner cancellation is handled through IpcBridge destructor
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

void MainWindow::setupMenuBar()
{
    // ── File Menu ──────────────────────────────────────
    auto *fileMenu = menuBar()->addMenu(tr("&File"));
    auto *exitAction = fileMenu->addAction(tr("E&xit"));
    exitAction->setShortcut(QKeySequence("Ctrl+Q"));
    connect(exitAction, &QAction::triggered, this, &QMainWindow::close);

    // ── View Menu ──────────────────────────────────────
    m_viewMenu = menuBar()->addMenu(tr("&View"));

    m_viewPieAction = m_viewMenu->addAction(tr("Pie Chart"));
    m_viewPieAction->setShortcut(QKeySequence("Ctrl+1"));
    connect(m_viewPieAction, &QAction::triggered, this, &MainWindow::onViewPie);

    m_viewGalaxyAction = m_viewMenu->addAction(tr("Galaxy"));
    m_viewGalaxyAction->setShortcut(QKeySequence("Ctrl+3"));
    connect(m_viewGalaxyAction, &QAction::triggered, this, &MainWindow::onViewGalaxy);

    m_viewTreemapAction = m_viewMenu->addAction(tr("Treemap"));
    m_viewTreemapAction->setShortcut(QKeySequence("Ctrl+2"));
    connect(m_viewTreemapAction, &QAction::triggered, this, &MainWindow::onViewTreemap);

    m_viewMenu->addSeparator();

    // Language submenu
    auto *langMenu = m_viewMenu->addMenu(tr("&Language"));
    auto *langAuto = langMenu->addAction(QString::fromUtf8("🌐 Auto (System)"));
    langAuto->setData("auto");
    connect(langAuto, &QAction::triggered, this, [this]() {
        onLanguageChanged("auto");
    });

    // Common languages
    struct LangEntry { QString code; QString label; };
    QList<LangEntry> langs = {
        {"en", QString::fromUtf8("English")},
        {"de", QString::fromUtf8("Deutsch")},
        {"fr", QString::fromUtf8("Français")},
        {"es", QString::fromUtf8("Español")},
        {"it", QString::fromUtf8("Italiano")},
        {"pt", QString::fromUtf8("Português")},
        {"nl", QString::fromUtf8("Nederlands")},
        {"pl", QString::fromUtf8("Polski")},
        {"ru", QString::fromUtf8("Русский")},
        {"zh", QString::fromUtf8("简体中文")},
        {"ja", QString::fromUtf8("日本語")},
        {"ko", QString::fromUtf8("한국어")},
    };
    for (const auto &lang : langs) {
        auto *act = langMenu->addAction(lang.label);
        act->setData(lang.code);
        connect(act, &QAction::triggered, this, [this, code = lang.code]() {
            onLanguageChanged(code);
        });
    }

    // Theme submenu
    auto *themeMenu = m_viewMenu->addMenu(tr("&Theme"));
    auto *themeDark = themeMenu->addAction(tr("Dark"));
    themeDark->setCheckable(true);
    themeDark->setChecked(true);
    connect(themeDark, &QAction::triggered, this, [this]() { onThemeChanged("dark"); });
    auto *themeLight = themeMenu->addAction(tr("Light"));
    themeLight->setCheckable(true);
    connect(themeLight, &QAction::triggered, this, [this]() { onThemeChanged("light"); });
    auto *themeSystem = themeMenu->addAction(tr("System"));
    themeSystem->setCheckable(true);
    connect(themeSystem, &QAction::triggered, this, [this]() { onThemeChanged("auto"); });

    // ── Tools Menu ─────────────────────────────────────
    auto *toolsMenu = menuBar()->addMenu(tr("&Tools"));
    auto *findDupes = toolsMenu->addAction(tr("Find Duplicate Files…"));
    findDupes->setShortcut(QKeySequence("Ctrl+D"));
    connect(findDupes, &QAction::triggered, this, &MainWindow::onFindDuplicates);

    // ── Help Menu ──────────────────────────────────────
    auto *helpMenu = menuBar()->addMenu(tr("&Help"));
    auto *checkUpdates = helpMenu->addAction(tr("Check for Updates…"));
    connect(checkUpdates, &QAction::triggered, this, &MainWindow::onCheckUpdates);

    helpMenu->addSeparator();

    auto *aboutAct = helpMenu->addAction(tr("About DiskRaptor"));
    aboutAct->setShortcut(QKeySequence("Ctrl+I"));
    connect(aboutAct, &QAction::triggered, this, &MainWindow::onAbout);
}

void MainWindow::setupWebEngine(const QString &frontendPath)
{
    // IpcBridge now loads the Rust scanner DLL internally
    m_ipcBridge = new IpcBridge(this);

    m_webChannel = new QWebChannel(this);
    m_webChannel->registerObject("bridge", m_ipcBridge);
    m_webView->page()->setWebChannel(m_webChannel);

    // Disable browser's built-in right-click context menu
    m_webView->setContextMenuPolicy(Qt::NoContextMenu);

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

void MainWindow::setupTrayIcon()
{
    if (!QSystemTrayIcon::isSystemTrayAvailable()) {
        qDebug() << "[DiskRaptor] System tray not available on this platform";
        return;
    }
    m_trayIcon = new QSystemTrayIcon(this);
    m_trayIcon->setIcon(QIcon(":/app.ico"));
    m_trayIcon->setToolTip("DiskRaptor");

    m_trayMenu = new QMenu(this);
    auto *showAction = m_trayMenu->addAction(tr("Open DiskRaptor"));
    connect(showAction, &QAction::triggered, this, [this]() {
        showNormal();
        activateWindow();
        raise();
    });
    m_trayMenu->addSeparator();
    auto *quitAction = m_trayMenu->addAction(tr("Exit"));
    connect(quitAction, &QAction::triggered, qApp, &QApplication::quit);

    m_trayIcon->setContextMenu(m_trayMenu);
    m_trayIcon->show();

    connect(m_trayIcon, &QSystemTrayIcon::activated, this, &MainWindow::onTrayActivated);

    qDebug() << "[DiskRaptor] System tray icon created";
}

void MainWindow::closeEvent(QCloseEvent *event)
{
    // Actually quit the application
    event->accept();
    qApp->quit();
}

void MainWindow::onTrayActivated(QSystemTrayIcon::ActivationReason reason)
{
    if (reason == QSystemTrayIcon::DoubleClick ||
        reason == QSystemTrayIcon::Trigger) {
        showNormal();
        activateWindow();
        raise();
    }
}

void MainWindow::runJS(const QString &js)
{
    m_webView->page()->runJavaScript(js);
}

// ── Menu Action Slots ───────────────────────────────────────────

void MainWindow::onViewPie()
{
    runJS("document.querySelectorAll('.diagram-mode').forEach(function(b){b.classList.remove('active')});"
          "var btn = document.querySelector('.diagram-mode[data-mode=\"pie\"]');"
          "if(btn)btn.classList.add('active');"
          "if(window.diagram)window.diagram.setMode('pie');");
}

void MainWindow::onViewGalaxy()
{
    runJS("document.querySelectorAll('.diagram-mode').forEach(function(b){b.classList.remove('active')});"
          "var btn = document.querySelector('.diagram-mode[data-mode=\"galaxy\"]');"
          "if(btn)btn.classList.add('active');"
          "if(window.diagram){isGalaxyMode=true;if(window.galaxyView){galaxyView.show();if(galaxyView.objects.length===0&&currentStats)_feedGalaxyView();}}");
}

void MainWindow::onViewTreemap()
{
    runJS("document.querySelectorAll('.diagram-mode').forEach(function(b){b.classList.remove('active')});"
          "var btn = document.querySelector('.diagram-mode[data-mode=\"treemap\"]');"
          "if(btn)btn.classList.add('active');"
          "if(window.diagram)window.diagram.setMode('treemap');");
}

void MainWindow::onFindDuplicates()
{
    runJS("var btn = document.getElementById('btn-duplicates'); if(btn)btn.click();");
}

void MainWindow::onCheckUpdates()
{
    runJS("var overlay = document.getElementById('update-overlay');"
          "if(!overlay)return;"
          "overlay.classList.add('active');"
          "var icon = document.getElementById('update-icon');"
          "var status = document.getElementById('update-status');"
          "var version = document.getElementById('update-version');"
          "var actions = document.getElementById('update-actions');"
          "var dlBtn = document.getElementById('btn-update-download');"
          "icon.textContent = '\U0001F310';"
          "status.textContent = 'Connecting to GitHub\u2026';"
          "version.textContent = '';"
          "actions.style.display = 'none';"
          "dlBtn.style.display = 'none';"
          "window.__TAURI__.invoke('check_for_updates').then(function(result){"
          "  var currentVer = 'v0.5.0';"
          "  var remoteVer = (result||'').trim();"
          "  if(remoteVer > currentVer){"
          "    icon.textContent = '\u2B07\uFE0F';"
          "    status.textContent = 'A new version is available!';"
          "    version.textContent = 'Current: '+currentVer+' \u2192 Latest: '+remoteVer;"
          "    actions.style.display = 'flex';"
          "    dlBtn.style.display = 'inline-block';"
          "  } else {"
          "    icon.textContent = '\u2705';"
          "    status.textContent = 'You\u2019re up to date!';"
          "    version.textContent = 'Current: '+currentVer+' (latest)';"
          "    actions.style.display = 'flex';"
          "    dlBtn.style.display = 'none';"
          "  }"
          "}).catch(function(e){"
          "  icon.textContent = '\u274C';"
          "  status.textContent = 'Could not check for updates.';"
          "  version.textContent = e.message || 'Network error';"
          "  actions.style.display = 'flex';"
          "  dlBtn.style.display = 'none';"
          "});");
}

void MainWindow::onAbout()
{
    runJS("var overlay = document.getElementById('about-overlay'); if(overlay)overlay.classList.add('active');");
}

void MainWindow::onLanguageChanged(const QString &code)
{
    QString escaped = code;
    escaped.replace("'", "\\'");
    runJS(QString("if(window.I18N)window.I18N.setLocale('%1');").arg(escaped));
}

void MainWindow::onThemeChanged(const QString &theme)
{
    QString escaped = theme;
    escaped.replace("'", "\\'");
    runJS(QString(
        "var btn = document.getElementById('btn-theme');"
        "if(!btn)return;"
        "var isLight = '%1' === 'light';"
        "if('%1' === 'auto') {"
        "  isLight = window.matchMedia('(prefers-color-scheme: light)').matches;"
        "}"
        "document.body.classList.toggle('light-theme', isLight);"
        "btn.textContent = isLight ? '\\u2600' : '\\u263E';"
        "btn.title = isLight ? 'Switch to dark mode' : 'Switch to light mode';"
        "try {"
        "  var o = {}; o['theme'] = '%1';"
        "  window.__TAURI__.invoke('save_settings', o);"
        "} catch(e){}"
    ).arg(escaped));
}
