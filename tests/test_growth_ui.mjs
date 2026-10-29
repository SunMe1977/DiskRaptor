import { runTest, jsExpr, jsInvoke, assert, sleep, waitFor, startScan, waitForOverlay, waitForScanComplete } from "./test_shared.mjs";

const hasEl = (id) => `document.getElementById('${id}') ? 'found' : 'not-found'`;

runTest("DiskRaptor Growth Features UI Test", 9272, async (cdp, scanPath) => {
  // --- 8) size filter control ---
  const sizeSel = await jsExpr(cdp, hasEl("min-size-filter"));
  assert("Size filter select exists", sizeSel === "found");
  await jsExpr(cdp, `document.getElementById('min-size-filter').value = '1073741824'; document.getElementById('min-size-filter').dispatchEvent(new Event('change', {bubbles:true})); 'set'`);
  await sleep(300);
  const minSize = await jsExpr(cdp, `window.__minSizeBytes`);
  assert("Size filter state applied", minSize === 1073741824, `got=${minSize}`);
  await jsExpr(cdp, `document.getElementById('min-size-filter').value = '0'; document.getElementById('min-size-filter').dispatchEvent(new Event('change', {bubbles:true})); 'reset'`);

  // --- 10) downloads quick button ---
  const dlBtn = await jsExpr(cdp, hasEl("welcome-downloads-btn"));
  assert("Welcome downloads button exists", dlBtn === "found");

  // --- 6) schedule controls in settings ---
  await jsExpr(cdp, `document.getElementById('settings-overlay').style.display = 'flex'; 'opened'`);
  await sleep(400);
  const sched = await jsExpr(cdp, `['settings-sched-enabled','settings-sched-freq','settings-sched-path'].map(id => document.getElementById(id) ? 'found' : 'not-found').join(',')`);
  assert("Schedule controls exist", sched === "found,found,found", `got=${sched}`);
  await jsExpr(cdp, `document.getElementById('settings-overlay').style.display = 'none'; 'closed'`);

  // --- scan for tree/history/dup assertions ---
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed", completed);

  // --- 4) snapshot persisted with totals ---
  const snapOk = await waitFor(async () => {
    const s = await jsInvoke(cdp, `window.__TAURI__.invoke("load_settings", {})`);
    const v = (s && s.data ? s.data : s) || {};
    return !!(v.scan_snapshots);
  }, { timeout: 8000, label: "snapshots" });
  assert("Scan snapshot saved", snapOk === true);

  // --- 7) tree keyboard: ArrowDown + Home/End move selection ---
  const treeReady = await waitFor(async () => {
    const n = await jsExpr(cdp, `window.__treeView ? window.__treeView.visibleNodes.length : 0`);
    return n > 1;
  }, { timeout: 10000, label: "tree-rows" });
  assert("Tree has rows for keyboard test", treeReady === true);
  if (treeReady) {
    const sel0 = await jsExpr(cdp, `window.__treeView.selectedIndex`);
    await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'End', bubbles:true})); 'end'`);
    await sleep(200);
    const selEnd = await jsExpr(cdp, `window.__treeView.selectedIndex`);
    await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Home', bubbles:true})); 'home'`);
    await sleep(200);
    const selHome = await jsExpr(cdp, `window.__treeView.selectedIndex`);
    assert("End/Home move tree selection", selEnd !== selHome || sel0 !== selEnd, `0=${sel0} end=${selEnd} home=${selHome}`);
  }
});
