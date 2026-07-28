#include "webviewwindow.h"
#include <QMessageBox>
#include <QTimer>
#include <QFile>
#include <QTextStream>
#include <QApplication>
#include <QSettings>
#include <QJsonDocument>
#include <QJsonObject>

MainWindow::MainWindow(const QString &frontendPath, QWidget *parent)
    : QMainWindow(parent), m_frontendPath(frontendPath)
{
    setupUI();
    setupMenuBar();
    setupTrayIcon();

    m_ipcBridge = new IpcBridge(this);

    connect(m_ipcBridge, &IpcBridge::eventEmitted, this, [this](const QString &event, const QVariant &payload) {
        m_webView->postEvent(event, payload);
    });

    setupWebView(frontendPath);

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
    qDebug() << "[DiskRaptor] Shutdown";
}

void MainWindow::setupUI()
{
    auto *centralWidget = new QWidget(this);
    auto *mainLayout = new QVBoxLayout(centralWidget);
    mainLayout->setContentsMargins(0, 0, 0, 0);
    mainLayout->setSpacing(0);

    m_webView = new WKWebViewWrapper();
    m_webView->setMinimumSize(800, 400);
    m_webView->setInvokeHandler([this](const QString &cmd, const QVariantMap &args) {
        return handleInvoke(cmd, args);
    });
    mainLayout->addWidget(m_webView, 1);

    setCentralWidget(centralWidget);
}

void MainWindow::setupMenuBar()
{
    auto *fileMenu = menuBar()->addMenu(tr("&File"));
    auto *exitAction = fileMenu->addAction(tr("E&xit"));
    exitAction->setShortcut(QKeySequence("Ctrl+Q"));
    connect(exitAction, &QAction::triggered, this, &QMainWindow::close);

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

    auto *langMenu = m_viewMenu->addMenu(tr("&Language"));
    auto *langAuto = langMenu->addAction(QString::fromUtf8("🌐 Auto (System)"));
    langAuto->setData("auto");
    connect(langAuto, &QAction::triggered, this, [this]() { onLanguageChanged("auto"); });

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

    themeMenu->addSeparator();

    struct ThemeEntry { QString id; QString label; };
    QList<ThemeEntry> diagramThemes = {
        {"default", QString::fromUtf8("🔵 Default — Ocean Depths")},
        {"forest",  QString::fromUtf8("🌲 Forest — Deep Woods")},
        {"desert",  QString::fromUtf8("🏜️ Desert — Golden Sands")},
        {"ice",     QString::fromUtf8("❄️ Ice — Frozen Tundra")},
        {"fairy",   QString::fromUtf8("🧚 Fairy — Enchanted Garden")},
    };
    for (const auto &th : diagramThemes) {
        auto *act = themeMenu->addAction(th.label);
        act->setData(th.id);
        connect(act, &QAction::triggered, this, [this, id = th.id]() {
            runJS(QString("if(window.__diagram&&window.__diagram.setTheme)window.__diagram.setTheme('%1');")
                      .arg(id));
        });
    }

    auto *toolsMenu = menuBar()->addMenu(tr("&Tools"));
    auto *scanDl = toolsMenu->addAction(tr("Scan Downloads"));
    connect(scanDl, &QAction::triggered, this, [this]() { runJS("var el=document.querySelector('.tools-item[data-action=scan-downloads]');if(el)el.click();"); });
    auto *scanTrash = toolsMenu->addAction(tr("Scan Trash"));
    connect(scanTrash, &QAction::triggered, this, [this]() { runJS("var el=document.querySelector('.tools-item[data-action=scan-trash]');if(el)el.click();"); });
    auto *trashRec = toolsMenu->addAction(tr("Trash Recovery…"));
    connect(trashRec, &QAction::triggered, this, [this]() { runJS("var el=document.querySelector('.tools-item[data-action=trash-recovery]');if(el)el.click();"); });
    auto *findFiles = toolsMenu->addAction(tr("Find Files…"));
    connect(findFiles, &QAction::triggered, this, [this]() { runJS("var el=document.querySelector('.tools-item[data-action=find-files]');if(el)el.click();"); });
    auto *emptyFolders = toolsMenu->addAction(tr("Empty Folders…"));
    connect(emptyFolders, &QAction::triggered, this, [this]() { runJS("var el=document.querySelector('.tools-item[data-action=empty-folders]');if(el)el.click();"); });
    auto *cleanupDl = toolsMenu->addAction(tr("Downloads Cleanup"));
    connect(cleanupDl, &QAction::triggered, this, [this]() { runJS("var el=document.querySelector('.tools-item[data-action=cleanup-downloads]');if(el)el.click();"); });
    auto *findDupes = toolsMenu->addAction(tr("Find Duplicate Files…"));
    findDupes->setShortcut(QKeySequence("Ctrl+D"));
    connect(findDupes, &QAction::triggered, this, &MainWindow::onFindDuplicates);
    toolsMenu->addSeparator();
    auto *exportHtml = toolsMenu->addAction(tr("Export HTML Report…"));
    connect(exportHtml, &QAction::triggered, this, [this]() { runJS("var el=document.querySelector('.tools-item[data-action=export-html]');if(el)el.click();"); });
    auto *prefs = toolsMenu->addAction(tr("Preferences…"));
    prefs->setShortcut(QKeySequence("Ctrl+,"));
    connect(prefs, &QAction::triggered, this, [this]() { runJS("var el=document.querySelector('.tools-item[data-action=settings]');if(el)el.click();"); });
    auto *clearScan = toolsMenu->addAction(tr("Clear Scan"));
    connect(clearScan, &QAction::triggered, this, [this]() { runJS("var el=document.querySelector('.tools-item[data-action=clear-scan]');if(el)el.click();"); });
    toolsMenu->addSeparator();
    auto *emptyTrash = toolsMenu->addAction(tr("Empty Trash…"));
    emptyTrash->setShortcut(QKeySequence("Ctrl+Delete"));
    connect(emptyTrash, &QAction::triggered, this, [this]() { runJS("var el=document.querySelector('.tools-item[data-action=trash]');if(el)el.click();"); });

    auto *helpMenu = menuBar()->addMenu(tr("&Help"));
    bool fromMacAppStore = QSettings(QCoreApplication::applicationDirPath() + "/../Info.plist",
      QSettings::NativeFormat).value("DiskRaptorDisableUpdates", false).toBool();
    if (!fromMacAppStore) {
      auto *checkUpdates = helpMenu->addAction(tr("Check for Updates…"));
      connect(checkUpdates, &QAction::triggered, this, &MainWindow::onCheckUpdates);
    }

    helpMenu->addSeparator();

    auto *aboutAct = helpMenu->addAction(tr("About DiskRaptor"));
    aboutAct->setShortcut(QKeySequence("Ctrl+I"));
    connect(aboutAct, &QAction::triggered, this, &MainWindow::onAbout);
}

void MainWindow::setupWebView(const QString &frontendPath)
{
    QString indexPath = QDir(frontendPath).filePath("index.html");
    QString url = QUrl::fromLocalFile(indexPath).toString();
    qDebug() << "[DiskRaptor] Loading:" << url;
    m_webView->loadURL(QUrl(url));

    connect(m_webView, &WKWebViewWrapper::loadFinished, this, [this](bool ok) {
        if (ok) {
            qDebug() << "[DiskRaptor] Frontend loaded successfully";
            m_statusLabel->setText("Frontend loaded");
        } else {
            qWarning() << "[DiskRaptor] Frontend load FAILED";
            m_statusLabel->setText("Frontend load failed!");
        }
    });
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
    m_webView->evaluateJS(js);
}

QString MainWindow::handleInvoke(const QString &cmd, const QVariantMap &args)
{
    return m_ipcBridge->invoke(cmd, args);
}

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
        "btn.title = isLight ? 'Switch to dark mode' : 'Switch to dark mode';"
        "try {"
        "  var o = {}; o['theme'] = '%1';"
        "  window.__TAURI__.invoke('save_settings', o);"
        "} catch(e){}"
    ).arg(escaped));
}
