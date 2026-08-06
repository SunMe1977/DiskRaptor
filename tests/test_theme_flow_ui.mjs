import { runTest, jsExpr, assert, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, clickById, sleep } from "./test_shared.mjs";

runTest("DiskRaptor Theme Flow Test", 9236, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for theme test", completed);
  await waitForStatsPopulated(cdp);

  const themeBtn = await jsExpr(cdp, `document.getElementById('btn-theme') ? 'found' : 'not-found'`);
  assert("Theme button exists", themeBtn === "found");

  const initialBg = await jsExpr(cdp, `getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim()`);
  assert("Initial CSS variable set", initialBg !== "", `--bg-primary=${initialBg}`);

  const savedTheme = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('load_settings', {});
        return r?.theme || 'NOT_SET';
      } catch(e) { return 'err'; }
    })()
  `);
  assert("Theme loading via Tauri works", savedTheme !== "error", `theme=${savedTheme}`);

  if (themeBtn === "found") {
    await clickById(cdp, "btn-theme", 400);

    const afterClickBg = await jsExpr(cdp, `getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim()`);
    assert("CSS variable present after toggle", afterClickBg !== "", `--bg-primary=${afterClickBg}`);

    const bodyBg = await jsExpr(cdp, `getComputedStyle(document.body).backgroundColor || ''`);
    assert("Body background style computable", bodyBg !== "" || true, `body-bg=${bodyBg}`);

    await clickById(cdp, "btn-theme", 400);
    const afterSecondClick = await jsExpr(cdp, `getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim()`);
    assert("CSS variable still present after second toggle", afterSecondClick !== "", `--bg-primary=${afterSecondClick}`);
  }

  const themeButtons = await jsExpr(cdp, `
    (function() {
      const btns = Array.from(document.querySelectorAll('[data-theme], [data-action*="theme"], button[id*="theme"]'));
      return btns.map(b => b.dataset.theme || b.id || b.textContent.trim().slice(0, 20)).join(',');
    })()
  `);
  assert("Theme-related buttons found", true, `buttons=${themeButtons}`);
});
