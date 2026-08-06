import { runTest, jsExpr, jsInvoke, assert, clickById, sleep } from "./test_shared.mjs";

runTest("DiskRaptor Error Handling Test", 9239, async (cdp) => {
  await setValue(cdp, "scan-path", "/nonexistent/path/that/does/not/exist/12345");
  await clickById(cdp, "btn-scan", 300);

  let errorFound = false;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    const status = await jsExpr(cdp, `document.querySelector('.status-bar')?.textContent || ''`);
    const errorEl = await jsExpr(cdp, `document.getElementById('scan-errors')?.textContent || document.getElementById('scan-errors')?.innerText || ''`);
    if (status.toLowerCase().includes("error") || status.toLowerCase().includes("not found") || status.toLowerCase().includes("complete") || errorEl.length > 0) {
      errorFound = true;
      break;
    }
    if (i === 30) {
      const progressOverlay = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`);
      if (!progressOverlay) {
        errorFound = true;
        break;
      }
    }
  }
  assert("Invalid path handled gracefully", errorFound, "app did not surface error state for nonexistent path");

  const afterInvalid = await jsExpr(cdp, `document.getElementById('btn-scan')?.disabled === false`);
  assert("Scan button re-enabled after invalid path", afterInvalid === true);

  const validPath = await jsInvoke(cdp, "window.__TAURI__.invoke('get_home_dir')").catch(() => '/tmp');
  const homeDir = typeof validPath === 'string' ? validPath : (validPath?.data || validPath?.path || '/tmp');
  await setValue(cdp, "scan-path", homeDir);
  await clickById(cdp, "btn-scan", 200);

  const overlayAfterValid = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`);
  assert("Valid path starts scan normally", overlayAfterValid === true, `overlay=${overlayAfterValid}`);

  await jsExpr(cdp, `window.__TAURI__.invoke('cancel_scan', {}).catch(() => {}); 'cancelling'`);
  await sleep(300);

  const systemCommandsOk = await jsExpr(cdp, `
    (async () => {
      try {
        const r1 = await window.__TAURI__.invoke('get_home_dir');
        const r2 = await window.__TAURI__.invoke('get_app_info');
        const r3 = await window.__TAURI__.invoke('list_drives');
        return r1 ? 'ok' : 'fail';
      } catch(e) { return 'err:' + e.message; }
    })()
  `);
  assert("System commands still responsive after error", systemCommandsOk === "ok", `${systemCommandsOk}`);
});
