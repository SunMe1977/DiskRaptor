#!/bin/bash
# DiskRaptor Uninstall Helper (macOS)
# Removes the app and its settings.

APP_PATH="/Applications/DiskRaptor.app"
SETTINGS_PATH="$HOME/Library/Preferences/com.diskraptor.DiskRaptor.plist"
CACHES_PATH="$HOME/Library/Caches/com.diskraptor.DiskRaptor"
SUPPORT_PATH="$HOME/Library/Application Support/DiskRaptor"
SANDBOX_PATH="$HOME/Library/Containers/com.diskraptor.DiskRaptor"

echo "DiskRaptor Uninstall Helper"
echo "==========================="
echo ""

if [ -d "$APP_PATH" ]; then
    echo "  Removing app..."
    rm -rf "$APP_PATH"
    echo "  ✓ App removed"
else
    echo "  App not found at $APP_PATH"
fi

echo "  Removing settings..."
rm -f "$SETTINGS_PATH" 2>/dev/null
rm -rf "$CACHES_PATH" 2>/dev/null
rm -rf "$SUPPORT_PATH" 2>/dev/null
rm -rf "$SANDBOX_PATH" 2>/dev/null
echo "  ✓ Settings removed"

echo ""
echo "DiskRaptor has been uninstalled."
