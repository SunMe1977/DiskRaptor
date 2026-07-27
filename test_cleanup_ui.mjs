import { runTest, jsExpr, assert, sleep, clickById, setValue, PLATFORM, IS_WIN } from "./test_shared.mjs";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

runTest("DiskRaptor Downloads Cleanup Test", 9222, async (cdp) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diskraptor-cleanup-"));
  console.log(`  Temp dir: ${tmpDir}`);

  const testFiles = [
    "old_backup.tar.gz",
    "duplicate_setup.exe",
    "temp_cache.zip",
    "large_log.txt",
    "node_modules.tar.gz",
    "installer.dmg",
  ];
  for (const f of testFiles) {
    fs.writeFileSync(path.join(tmpDir, f), "test content for " + f);
  }
  console.log(`  Created ${testFiles.length} test files`);

  await setValue(cdp, "scan-path", tmpDir);
  await sleep(200);
  await clickById(cdp, "btn-scan", 200);

  let completed = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const ov = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`);
      if (ov !== true) { await sleep(1000); completed = true; break; }
    } catch {}
  }
  assert("Scan completed", completed);

  if (completed) {
    await clickById(cdp, "btn-tools", 300);
    await jsExpr(cdp, `(function(){ const items=document.querySelectorAll('.tools-item'); for(const i of items){ if(i.getAttribute('data-action')==='cleanup-downloads'){ i.click(); return 'clicked'; }} return 'not-found'; })()`);
    await sleep(1000);

    const panelText = await jsExpr(cdp, `(document.getElementById('cleanup-panel')?.textContent || '').trim()`);
    const panelFound = panelText && panelText.length > 0;
    assert("Cleanup panel appeared", panelFound, panelFound ? `text: ${panelText.slice(0, 80)}` : "not found");

    if (panelFound) {
      const hasItems = /\d+\s*items/.test(panelText);
      const hasReclaimable = /reclaimable/.test(panelText);
      assert("Panel shows item count", hasItems, `text="${panelText.slice(0, 80)}"`);
      assert("Panel shows reclaimable total", hasReclaimable);

      const checkboxCount = await jsExpr(cdp, `document.querySelectorAll('#cleanup-panel .cleanup-item input[type="checkbox"]').length`);
      assert("Cleanable items have checkboxes", checkboxCount > 0, `count=${checkboxCount}`);

      const hasSelectAll = await jsExpr(cdp, "!!document.getElementById('cleanup-select-all')");
      const hasMoveTrash = await jsExpr(cdp, "!!document.getElementById('cleanup-move-trash')");
      const hasClose = await jsExpr(cdp, "!!document.getElementById('cleanup-close')");
      assert("Select All button", hasSelectAll);
      assert("Move to Trash button", hasMoveTrash);
      assert("Close button", hasClose);

      await jsExpr(cdp, "document.getElementById('cleanup-close').click()");
      await sleep(300);
      const closeHidden = await jsExpr(cdp, `(document.getElementById('cleanup-panel')?.style?.display || '') === 'none'`);
      assert("Close button hides panel", closeHidden);
    }
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  console.log(`  Temp dir cleaned`);
});
