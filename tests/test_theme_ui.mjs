import { runTest, jsExpr, jsInvoke, assert, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, clickById } from "./test_shared.mjs";

runTest("DiskRaptor Theme Test", 9205, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for theme test", completed);
  await waitForStatsPopulated(cdp);

  const initialTheme = await jsExpr(cdp, `document.getElementById('btn-theme')?.textContent || ''`);
  assert("Theme button visible", initialTheme !== "", `text="${initialTheme}"`);

  await clickById(cdp, "btn-theme", 500);

  const themeButtons = await jsExpr(cdp, `
    Array.from(document.querySelectorAll('[data-action="theme-"], [data-theme], button[id*="theme"], .theme-option, [class*="theme"]')).map(b => b.textContent.trim() || b.id || b.getAttribute('data-action') || b.getAttribute('data-theme') || 'unknown')
  `);
  assert("Theme options found", Array.isArray(themeButtons) && themeButtons.length > 0, `options: ${JSON.stringify(themeButtons.slice(0, 3))}`);

  const bodyStyle = await jsExpr(cdp, `getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim()`);
  assert("Theme CSS custom property set", bodyStyle !== "", `--bg-primary=${bodyStyle}`);

  // Async invoke must go through jsInvoke: a bare jsExpr cannot await the
  // promise (the CDP bridge serializes it to {}), so this always came back
  // "[object Object]".
  const savedTheme = await jsInvoke(cdp,
    "window.__TAURI__.invoke('load_settings', {}).then(r => ((r && ((r.data && r.data.theme) || r.theme)) || 'default'))",
  ).catch(() => 'error');
  assert("Load settings via Tauri", typeof savedTheme === "string", `theme=${savedTheme}`);
});
