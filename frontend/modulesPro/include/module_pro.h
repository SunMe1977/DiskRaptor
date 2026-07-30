#ifndef MODULE_PRO_H
#define MODULE_PRO_H

// DiskRaptor Pro Module C ABI Interface
// All modules must export these functions with extern "C"

#ifdef _WIN32
#define MODULE_EXPORT __declspec(dllexport)
#else
#define MODULE_EXPORT __attribute__((visibility("default")))
#endif

#include <stdint.h>

// Max string lengths
#define MODULE_NAME_MAX 64
#define MODULE_PATH_MAX 1024
#define MODULE_ERROR_MAX 512

// Scan phases
typedef enum {
    MODULE_PHASE_IDLE = 0,
    MODULE_PHASE_SCANNING = 1,
    MODULE_PHASE_PROCESSING = 2,
    MODULE_PHASE_COMPLETE = 3,
    MODULE_PHASE_ERROR = 4
} ModulePhase;

// Progress callback (called from module during scan)
typedef void (*ModuleProgressCallback)(
    uint64_t filesFound,
    uint64_t groupsFound,
    uint64_t wastedBytes,
    uint64_t hashComparisons,
    float speedFilesPerSec,
    ModulePhase phase,
    const char* currentFile,
    uint64_t elapsedMs
);

// Scan statistics
typedef struct {
    uint64_t totalFilesScanned;
    uint64_t duplicateGroups;
    uint64_t duplicateFiles;
    uint64_t wastedBytes;
    uint64_t hashComparisons;
    double scanTimeMs;
    double speedFilesPerSec;
    char error[MODULE_ERROR_MAX];
} ModuleScanStats;

// ── Module Lifecycle ──────────────────────────────────────────

// Get module name (e.g. "duplicateScan")
MODULE_EXPORT const char* module_name();

// Get module version
MODULE_EXPORT const char* module_version();

// Initialize module (called once on load)
// Returns 0 on success, non-zero on error
MODULE_EXPORT int module_init(const char* licenseKey);

// Start scanning
MODULE_EXPORT int module_start_scan(
    const char* path,
    ModuleProgressCallback progressCb
);

// Cancel scanning (called from another thread)
MODULE_EXPORT void module_cancel_scan();

// Get current scan stats
MODULE_EXPORT ModuleScanStats module_get_stats();

// Get result data as JSON (for frontend rendering)
// Caller must free the returned string
MODULE_EXPORT char* module_get_results_json();

// Cleanup / shutdown
MODULE_EXPORT void module_shutdown();

// Free a string allocated by the module
MODULE_EXPORT void module_free_string(char* str);

#endif // MODULE_PRO_H
