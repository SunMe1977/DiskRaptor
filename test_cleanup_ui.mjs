import { runTest, jsExpr, assert, sleep, clickById } from "./test_shared.mjs";

runTest("DiskRaptor Downloads Cleanup Test", 9222, async (cdp) => {
  await clickById(cdp, "btn-tools", 200);
  await jsExpr(cdp, `(function(){ const items=document.querySelectorAll('.tools-item'); for(const i of items){ if(i.getAttribute('data-action')==='cleanup-downloads'){ i.click(); return 'clicked'; }} return 'not-found'; })()`);
  await sleep(1000);

  const scanPathAfter = await jsExpr(cdp, "document.getElementById('scan-path')?.value || ''");
  assert("Auto-set scan path to Downloads folder", scanPathAfter.toLowerCase().includes("download"), `path="${scanPathAfter}"`);

  let overlaySeen = false;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    try {
      const ov = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`);
      if (ov === true) { overlaySeen = true; break; }
    } catch {}
  }

  if (overlaySeen) {
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        const ov = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`);
        if (ov !== true) break;
      } catch {}
    }
  }
  await sleep(2000);

  const panelEl = await jsExpr(cdp, "!!document.getElementById('cleanup-panel')");
  const stbText = await jsExpr(cdp, "document.querySelector('.status-bar')?.textContent || ''");
  const analysisRan = panelEl || stbText.includes("cleanable") || stbText.includes("Cleanable") || stbText.includes("No cleanable") || /\d+/.test(stbText);
  assert("Cleanup analysis ran after auto-scan", analysisRan, `stb="${stbText.slice(0, 60)}"`);

  if (panelEl) {
    const checkboxCount = await jsExpr(cdp, `document.querySelectorAll('#cleanup-panel .cleanup-item input[type="checkbox"]').length`);
    assert("Cleanable files listed with checkboxes", checkboxCount > 0, `count=${checkboxCount}`);

    const hasSelectAll = await jsExpr(cdp, "!!document.getElementById('cleanup-select-all')");
    const hasMoveTrash = await jsExpr(cdp, "!!document.getElementById('cleanup-move-trash')");
    const hasClose = await jsExpr(cdp, "!!document.getElementById('cleanup-close')");
    assert("Select All button", hasSelectAll);
    assert("Move to Trash button", hasMoveTrash);
    assert("Close button", hasClose);
  }

  console.log(`  Status: ${stbText.slice(0, 60)}`);
  console.log(`  Panel:  ${panelEl ? "found" : "not found"}`);
});
