// DiskRaptor Pro Module Loader
// Loads .dll/.so/.dylib modules from modulesPro/ at runtime
#pragma once

#include <QObject>
#include <QString>
#include <QStringList>
#include <QVariantMap>
#include <QJsonObject>
#include <QJsonArray>
#include <functional>
#include <vector>

#ifdef _WIN32
#include <windows.h>
typedef HMODULE ModuleHandle;
#else
#include <dlfcn.h>
typedef void* ModuleHandle;
#endif

// Progress callback type (matches C ABI)
typedef void (*ModuleProgressCallback)(
    uint64_t filesFound,
    uint64_t groupsFound,
    uint64_t wastedBytes,
    uint64_t hashComparisons,
    float speedFilesPerSec,
    int phase,
    const char* currentFile,
    uint64_t elapsedMs
);

class ProModule {
public:
    QString name;
    QString version;
    ModuleHandle handle = nullptr;
    bool loaded = false;
    bool initialized = false;
};

class ModuleLoader : public QObject
{
    Q_OBJECT

public:
    explicit ModuleLoader(QObject *parent = nullptr);
    ~ModuleLoader();

    // Scan for available modules
    QStringList listModules();

    // Load a specific module by name
    bool loadModule(const QString &moduleName, const QString &licenseKey);

    // Start scan with a loaded module
    bool startScan(const QString &moduleName, const QString &path);

    // Cancel scan
    void cancelScan(const QString &moduleName);

    // Get scan stats as JSON
    QString getStatsJson(const QString &moduleName);

    // Get results as JSON
    QString getResultsJson(const QString &moduleName);

    // Get license requirements
    static QString licenseKey();
    static void setLicenseKey(const QString &key);

signals:
    void progressUpdated(const QString &moduleName,
        uint64_t filesFound, uint64_t groupsFound,
        uint64_t wastedBytes, uint64_t hashComparisons,
        double speedFilesPerSec, int phase,
        const QString &currentFile, uint64_t elapsedMs);

    void scanComplete(const QString &moduleName, const QString &resultsJson);

private:
    QMap<QString, ProModule> m_modules;
    static QString s_licenseKey;

    // Module function pointers
    using FnName = const char*(*)();
    using FnVersion = const char*(*)();
    using FnInit = int(*)(const char*);
    using FnStartScan = int(*)(const char*, ModuleProgressCallback);
    using FnCancel = void(*)();
    using FnStats = void*; // returns ModuleScanStats*
    using FnResults = char*(*)();
    using FnShutdown = void(*)();
    using FnFreeString = void(*)(char*);

    // Loaded function pointers
    FnName fn_name = nullptr;
    FnVersion fn_version = nullptr;
    FnInit fn_init = nullptr;
    FnStartScan fn_startScan = nullptr;
    FnCancel fn_cancel = nullptr;
    FnStats fn_stats = nullptr;
    FnResults fn_results = nullptr;
    FnShutdown fn_shutdown = nullptr;
    FnFreeString fn_freeString = nullptr;

    // Static progress callback wrapper
    static void progressCallback(uint64_t filesFound, uint64_t groupsFound,
        uint64_t wastedBytes, uint64_t hashComparisons,
        float speedFilesPerSec, int phase,
        const char* currentFile, uint64_t elapsedMs);
};
