// DiskRaptor Pro Module Loader implementation
#include "module_loader.h"
#include <QDir>
#include <QDebug>
#include <QJsonDocument>
#include <QJsonObject>
#include <QCoreApplication>

QString ModuleLoader::s_licenseKey = "DR-2026-PRO"; // Default dev key

ModuleLoader::ModuleLoader(QObject *parent)
    : QObject(parent)
{
}

ModuleLoader::~ModuleLoader()
{
    for (auto it = m_modules.begin(); it != m_modules.end(); ++it) {
        if (it->loaded && fn_shutdown) {
            fn_shutdown();
        }
#ifdef _WIN32
        if (it->handle) FreeLibrary(it->handle);
#else
        if (it->handle) dlclose(it->handle);
#endif
    }
    m_modules.clear();
}

QStringList ModuleLoader::listModules()
{
    QStringList modules;
    QString modulesDir = QCoreApplication::applicationDirPath() + "/modulesPro";

    // Also check relative paths
    QStringList searchPaths = {
        modulesDir,
        QDir::currentPath() + "/modulesPro",
        QDir::currentPath() + "/../modulesPro",
    };

    for (const auto &dir : searchPaths) {
        QDir d(dir);
        if (!d.exists()) continue;

#ifdef _WIN32
        for (const auto &f : d.entryList({"*.dll"}, QDir::Files)) {
            modules.append(d.absoluteFilePath(f));
        }
#else
        for (const auto &f : d.entryList({"*.so", "*.dylib"}, QDir::Files)) {
            modules.append(d.absoluteFilePath(f));
        }
#endif
    }

    return modules;
}

bool ModuleLoader::loadModule(const QString &modulePath, const QString &licenseKey)
{
    ProModule mod;
    mod.name = QFileInfo(modulePath).baseName();

#ifdef _WIN32
    mod.handle = LoadLibraryW((LPCWSTR)modulePath.utf16());
    if (!mod.handle) {
        qWarning() << "[Module] Failed to load:" << modulePath
                   << "Error:" << GetLastError();
        return false;
    }

    fn_name = (FnName)GetProcAddress(mod.handle, "module_name");
    fn_version = (FnVersion)GetProcAddress(mod.handle, "module_version");
    fn_init = (FnInit)GetProcAddress(mod.handle, "module_init");
    fn_startScan = (FnStartScan)GetProcAddress(mod.handle, "module_start_scan");
    fn_cancel = (FnCancel)GetProcAddress(mod.handle, "module_cancel_scan");
    fn_stats = (FnStats)GetProcAddress(mod.handle, "module_get_stats");
    fn_results = (FnResults)GetProcAddress(mod.handle, "module_get_results_json");
    fn_shutdown = (FnShutdown)GetProcAddress(mod.handle, "module_shutdown");
    fn_freeString = (FnFreeString)GetProcAddress(mod.handle, "module_free_string");
#else
    mod.handle = dlopen(modulePath.toUtf8(), RTLD_NOW);
    if (!mod.handle) {
        qWarning() << "[Module] Failed to load:" << modulePath
                   << "Error:" << dlerror();
        return false;
    }

    fn_name = (FnName)dlsym(mod.handle, "module_name");
    fn_version = (FnVersion)dlsym(mod.handle, "module_version");
    fn_init = (FnInit)dlsym(mod.handle, "module_init");
    fn_startScan = (FnStartScan)dlsym(mod.handle, "module_start_scan");
    fn_cancel = (FnCancel)dlsym(mod.handle, "module_cancel_scan");
    fn_results = (FnResults)dlsym(mod.handle, "module_get_results_json");
    fn_shutdown = (FnShutdown)dlsym(mod.handle, "module_shutdown");
    fn_freeString = (FnFreeString)dlsym(mod.handle, "module_free_string");
#endif

    if (!fn_name || !fn_init || !fn_startScan || !fn_cancel || !fn_results) {
        qWarning() << "[Module] Missing required exports in:" << modulePath;
#ifdef _WIN32
        FreeLibrary(mod.handle);
#else
        dlclose(mod.handle);
#endif
        return false;
    }

    mod.name = QString::fromUtf8(fn_name());
    if (fn_version) mod.version = QString::fromUtf8(fn_version());

    // Initialize with license
    QByteArray keyUtf8 = licenseKey.toUtf8();
    int initResult = fn_init(keyUtf8.constData());
    if (initResult != 0) {
        qWarning() << "[Module] Init failed for:" << mod.name
                   << "Code:" << initResult;
#ifdef _WIN32
        FreeLibrary(mod.handle);
#else
        dlclose(mod.handle);
#endif
        return false;
    }

    mod.loaded = true;
    mod.initialized = true;
    m_modules[mod.name] = mod;

    qDebug() << "[Module] Loaded:" << mod.name << "v" << mod.version;
    return true;
}

bool ModuleLoader::startScan(const QString &moduleName, const QString &path)
{
    if (!m_modules.contains(moduleName)) return false;
    if (!fn_startScan) return false;

    QByteArray pathUtf8 = path.toUtf8();
    int result = fn_startScan(pathUtf8.constData(), progressCallback);
    return result == 0;
}

void ModuleLoader::cancelScan(const QString &moduleName)
{
    if (fn_cancel) fn_cancel();
}

QString ModuleLoader::getStatsJson(const QString &moduleName)
{
    Q_UNUSED(moduleName)
    // Stats are sent via callback, but we could also query directly
    return "{}";
}

QString ModuleLoader::getResultsJson(const QString &moduleName)
{
    if (!m_modules.contains(moduleName) || !fn_results) return "{}";
    char* json = fn_results();
    if (!json) return "{}";
    QString result = QString::fromUtf8(json);
    if (fn_freeString) fn_freeString(json);
    return result;
}

QString ModuleLoader::licenseKey()
{
    return s_licenseKey;
}

void ModuleLoader::setLicenseKey(const QString &key)
{
    s_licenseKey = key;
}

// Static progress callback → emit signal
static ModuleLoader* g_callbackTarget = nullptr;

void ModuleLoader::progressCallback(uint64_t filesFound, uint64_t groupsFound,
    uint64_t wastedBytes, uint64_t hashComparisons,
    float speedFilesPerSec, int phase,
    const char* currentFile, uint64_t elapsedMs)
{
    if (!g_callbackTarget) return;

    QString moduleName = "duplicateScan"; // Only one module for now
    QString curFile = currentFile ? QString::fromUtf8(currentFile) : "";

    g_callbackTarget->emit progressUpdated(
        moduleName, filesFound, groupsFound, wastedBytes,
        hashComparisons, speedFilesPerSec, phase, curFile, elapsedMs);

    if (phase == 3) { // COMPLETE
        g_callbackTarget->emit scanComplete(moduleName,
            g_callbackTarget->getResultsJson(moduleName));
    }
}
