import { runTest, jsExpr, assert, sleep, clickById } from "./test_shared.mjs";

runTest("DiskRaptor Downloads Cleanup Test", 9222, async (cdp) => {
  await clickById(cdp, "btn-tools", 200);
  await jsExpr(cdp, `(function(){ const items=document.querySelectorAll('.tools-item'); for(const i of items){ if(i.getAttribute('data-action')==='cleanup-downloads'){ i.click(); return 'clicked'; }} return 'not-found'; })()`);
  await sleep(1000);

  const scanPathAfter = await jsExpr(cdp, "document.getElementById('scan-path')?.value || ''");
  assert("Auto-set scan path to Downloads folder", scanPathAfter.toLowerCase().includes("download"), `path="${scanPathAfter}"`);

  for (let i = 0; i < 120; i++) {
    await sleep(250);
    const ov = await jsExpr(cdp, `document.getElementById('cleanup-overlay')?.style?.display === 'flex'`);
    if (ov) break;
  }
  await sleep(1000);

  const overlayFound = await jsExpr(cdp, "document.getElementById('cleanup-overlay')?.style?.display === 'flex'");
  const stbText = await jsExpr(cdp, "document.querySelector('.status-bar')?.textContent || ''");
  const resultOk = overlayFound || stbText.includes("No cleanable");

  assert("Cleanup popup appeared or analysis done", resultOk, `overlay=${overlayFound} stb="${stbText.slice(0, 50)}"`);

  if (overlayFound) {
    const title = await jsExpr(cdp, "document.querySelector('#cleanup-overlay h3')?.textContent || ''");
    assert("Popup shows title", title.includes("Cleanup"), `title="${title}"`);

    const checkboxCount = await jsExpr(cdp, `document.querySelectorAll('#cleanup-overlay .cleanup-item input[type="checkbox"]').length`);
    assert("Files listed with checkboxes", checkboxCount > 0, `count=${checkboxCount}`);

    const hasTooltip = await jsExpr(cdp, `document.querySelector('#cleanup-overlay .cleanup-item')?.getAttribute('title') || ''`);
    assert("Full path shown on hover", hasTooltip.length > 0, `tooltip="${hasTooltip.slice(0, 50)}"`);

    const hasSelectAll = await jsExpr(cdp, "!!document.getElementById('cleanup-select-all')");
    const hasMoveTrash = await jsExpr(cdp, "!!document.getElementById('cleanup-move-trash')");
    const hasClose = await jsExpr(cdp, "!!document.getElementById('cleanup-close-btn')");
    assert("Select All button", hasSelectAll);
    assert("Move to Trash button", hasMoveTrash);
    assert("Close button", hasClose);
  }
});
