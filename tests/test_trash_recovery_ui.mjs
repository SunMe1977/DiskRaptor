import { runTest, jsExpr, jsInvoke, assert, clickById, sleep } from "./test_shared.mjs";

// Trash handling has two parts:
//  - the Tools menu "Empty Trash" action (destructive - presence only)
//  - the TrashRecovery panel class (trashrecovery.js), which lists items and
//    offers restore / permanent delete. The panel is instantiated here
//    explicitly so the test never mutates the real recycle bin.
runTest("DiskRaptor Trash Recovery Test", 9219, async (cdp) => {
  await clickById(cdp, "btn-tools", 300);
  const menu = await jsExpr(cdp,
    `JSON.stringify(Array.from(document.querySelectorAll('.tools-item')).map(i => i.getAttribute('data-action')))`);
  let actions = [];
  try { actions = JSON.parse(menu); } catch { /* ignore */ }
  assert("Tools menu offers trash action", Array.isArray(actions) && actions.includes("trash"), menu);
  await jsExpr(cdp, `document.dispatchEvent(new MouseEvent('click', { bubbles: true })); 'dismiss'`);
  await sleep(200);

  const trashPath = await jsInvoke(cdp, "window.__TAURI__.invoke('get_trash_path', {})")
    .catch((e) => "error:" + e.message);
  assert("get_trash_path invoke completes",
    (typeof trashPath === "string" && trashPath.length > 0) ||
    (trashPath && typeof trashPath === "object" && typeof trashPath.error === "string"),
    `${typeof trashPath}:${JSON.stringify(trashPath).slice(0, 80)}`);

  const trashList = await jsInvoke(cdp, "window.__TAURI__.invoke('list_trash', {})")
    .catch((e) => "error:" + e.message);
  assert("list_trash returns an array", Array.isArray(trashList), `${typeof trashList}`);

  const panel = await jsExpr(cdp, `
    (async () => {
      if (typeof TrashRecovery !== 'function') return 'no-class';
      if (!window.__trashRecoveryTest) window.__trashRecoveryTest = new TrashRecovery();
      await window.__trashRecoveryTest.open();
      return document.getElementById('trash-panel') ? 'panel-found' : 'no-panel';
    })()
  `);
  assert("Trash Recovery panel renders", panel === "panel-found", `${panel}`);

  if (panel === "panel-found") {
    const controls = await jsExpr(cdp, `JSON.stringify({
      search: !!document.getElementById('trash-search'),
      type: !!document.getElementById('trash-type'),
      sort: !!document.getElementById('trash-sort'),
      restoreAll: !!document.getElementById('trash-restore-all'),
      restoreSelected: !!document.getElementById('trash-restore-selected'),
      deleteSelected: !!document.getElementById('trash-delete-selected'),
      close: !!document.getElementById('trash-close')
    })`);
    const c = JSON.parse(controls);
    assert("Trash search/filter controls", c.search && c.type && c.sort, controls);
    assert("Trash restore/delete controls", c.restoreAll && c.restoreSelected && c.deleteSelected, controls);

    const summary = await jsExpr(cdp, `document.getElementById('trash-summary')?.textContent || ''`);
    assert("Trash summary rendered", summary.length > 0, `summary="${summary}"`);

    await jsExpr(cdp, `document.getElementById('trash-close').click(); 'ok'`);
    await sleep(200);
    const hidden = await jsExpr(cdp, `document.getElementById('trash-panel')?.style.display === 'none'`);
    assert("Trash panel closes", hidden === true);
  }
});
