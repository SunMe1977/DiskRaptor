import { runTest, jsInvoke, assert } from "./test_shared.mjs";

// Non-destructive smoke test of the Tauri IPC bridge: read-only commands plus
// a no-op settings write. Destructive commands (empty_trash, delete_path) are
// intentionally not exercised here.
runTest("DiskRaptor Tauri Bridge Test", 9220, async (cdp) => {
  const homeDir = await jsInvoke(cdp, "window.__TAURI__.invoke('get_home_dir')").catch(() => 'error');
  assert("get_home_dir invoke completes", homeDir !== 'error', `${typeof homeDir}`);

  const settings = await jsInvoke(cdp, "window.__TAURI__.invoke('load_settings', {})").catch(() => 'error');
  assert("load_settings invoke completes", settings !== 'error' && typeof settings === 'object', `${typeof settings}`);

  // `save_settings` takes a `settings` object and merges it; an empty merge is
  // a harmless round-trip.
  const saved = await jsInvoke(cdp, "window.__TAURI__.invoke('save_settings', { settings: {} })")
    .catch(() => 'error');
  assert("save_settings invoke completes", saved !== 'error', `${typeof saved}`);

  const openExplorer = await jsInvoke(cdp, "window.__TAURI__.invoke('open_explorer', { path: '.' })")
    .catch(() => 'error');
  assert("open_explorer invoke completes", openExplorer !== 'error', `${typeof openExplorer}`);

  const trashPath = await jsInvoke(cdp, "window.__TAURI__.invoke('get_trash_path', {})").catch(() => 'error');
  assert("get_trash_path invoke completes", trashPath !== 'error', `${typeof trashPath}`);

  const trash = await jsInvoke(cdp, "window.__TAURI__.invoke('list_trash', {})").catch(() => 'error');
  assert("list_trash invoke completes", trash !== 'error' && Array.isArray(trash), `${typeof trash}`);

  const drives = await jsInvoke(cdp, "window.__TAURI__.invoke('list_drives', {})").catch(() => 'error');
  assert("list_drives invoke completes", drives !== 'error' && Array.isArray(drives), `${typeof drives}`);

  const version = await jsInvoke(cdp, "window.__TAURI__.invoke('get_app_version', {})").catch(() => 'error');
  assert("get_app_version invoke completes", version !== 'error', `${typeof version}`);
});
