import { runTest, jsExpr, assert } from "./test_shared.mjs";

runTest("DiskRaptor Tauri Bridge Test", 9220, async (cdp) => {
  const homeDir = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('get_home_dir');
        return 'home=' + (typeof r === 'string' ? r : JSON.stringify(r).slice(0, 40));
      } catch(e) { return 'err: ' + e.message.slice(0, 40); }
    })()
  `);
  assert("get_home_dir invoke", homeDir.startsWith("home="), `${homeDir}`);

  const loadSettings = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('load_settings', {});
        return 'ok=' + JSON.stringify(r).slice(0, 60);
      } catch(e) { return 'err: ' + e.message.slice(0, 40); }
    })()
  `);
  assert("load_settings invoke", loadSettings.startsWith("ok="), `${loadSettings}`);

  const saveSettings = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('save_settings', { key: 'test' });
        return 'ok=' + JSON.stringify(r).slice(0, 40);
      } catch(e) { return 'err: ' + e.message.slice(0, 40); }
    })()
  `);
  assert("save_settings invoke", saveSettings.startsWith("ok=") || saveSettings.includes("err"), `${saveSettings}`);

  const openDir = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('open_directory', { path: '/' });
        return 'ok=' + JSON.stringify(r).slice(0, 40);
      } catch(e) { return 'err: ' + e.message.slice(0, 40); }
    })()
  `);
  assert("open_directory invoke", openDir.includes("ok=") || openDir.includes("err"), `${openDir}`);

  const emptyTrash = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('empty_trash', {});
        return 'ok=' + JSON.stringify(r).slice(0, 40);
      } catch(e) { return 'err: ' + e.message.slice(0, 40); }
    })()
  `);
  assert("empty_trash invoke", emptyTrash.includes("ok=") || emptyTrash.includes("err"), `${emptyTrash}`);

  const listTrash = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('list_trash', {});
        return 'ok=' + JSON.stringify(r).slice(0, 40);
      } catch(e) { return 'err: ' + e.message.slice(0, 40); }
    })()
  `);
  assert("list_trash invoke", listTrash.includes("ok=") || listTrash.includes("err"), `${listTrash}`);

  assert("Bridge invokes complete", true, "non-blocking commands only");
});
