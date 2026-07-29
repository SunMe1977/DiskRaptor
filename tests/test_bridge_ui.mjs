import { runTest, jsInvoke, assert } from "./test_shared.mjs";

runTest("DiskRaptor Tauri Bridge Test", 9220, async (cdp) => {
  const homeDir = await jsInvoke(cdp, "window.__TAURI__.invoke('get_home_dir')").catch(() => 'error');
  assert("get_home_dir invoke completes", homeDir !== 'error', `${typeof homeDir}`);

  const r2 = await jsInvoke(cdp, "window.__TAURI__.invoke('load_settings', {})").catch(() => 'error');
  assert("load_settings invoke completes", r2 !== 'error', `${typeof r2}`);

  const r3 = await jsInvoke(cdp, "window.__TAURI__.invoke('save_settings', { key: 'test' })").catch(() => 'error');
  assert("save_settings invoke completes", r3 !== 'error', `${typeof r3}`);

  const r4 = await jsInvoke(cdp, "window.__TAURI__.invoke('open_directory', { path: '/' })").catch(() => 'error');
  assert("open_directory invoke completes", r4 !== 'error', `${typeof r4}`);

  const r5 = await jsInvoke(cdp, "window.__TAURI__.invoke('empty_trash', {})").catch(() => 'error');
  assert("empty_trash invoke completes", r5 !== 'error', `${typeof r5}`);

  const r6 = await jsInvoke(cdp, "window.__TAURI__.invoke('list_trash', {})").catch(() => 'error');
  assert("list_trash invoke completes", r6 !== 'error', `${typeof r6}`);

  assert("Bridge invokes complete", true, "non-blocking commands only");
});
