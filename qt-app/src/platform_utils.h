// DiskRaptor — Platform-specific utilities
// Cross-platform: Windows + Linux
#pragma once

#include <QString>
#include <QStringList>

namespace PlatformUtils {

// Get the path to the application's data directory
QString appDataPath();

// Get all available drive roots (C:\, D:\, /mnt/..., etc.)
QStringList listDrives();

// Open file manager to show/select a path
bool showInExplorer(const QString &path);

// Open terminal at a given directory
bool openTerminal(const QString &dir);

// Show file/folder properties dialog
bool showProperties(const QString &path);

// Get home directory
QString homeDir();

// Number of CPU threads available
int cpuThreadCount();

// Platform name for display
QString platformName();

// Set up PATH and Qt WebEngine environment variables so DiskRaptor.exe
// works without the launcher. Returns true if runtime directory found.
bool setupRuntimeEnvironment();
}
