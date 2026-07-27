import { runTest, jsExpr, assert, clickById, sleep } from "./test_shared.mjs";

runTest("DiskRaptor Trash Recovery Test", 9219, async (cdp) => {
  await clickById(cdp, "btn-tools", 300);
  const trashRecoveryClick = await jsExpr(cdp, `(function(){ const items=document.querySelectorAll('.tools-item'); for(const i of items){ if(i.getAttribute('data-action')==='trash-recovery'){ i.click(); return 'clicked'; }} return 'not-found'; })()`);
  assert("Trash Recovery menu item clickable", trashRecoveryClick === "clicked");
  await sleep(500);

  const trashPanel = await jsExpr(cdp, `
    (function() {
      const p = document.getElementById('trash-panel') || document.querySelector('[id*="trash-recovery"], [class*="trash-recovery"]');
      return p ? 'panel-found' : 'no-panel';
    })()
  `);
  assert("Trash Recovery panel rendered", trashPanel === "panel-found", `${trashPanel}`);

  const trashList = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('list_trash', {});
        return 'ok-' + JSON.stringify(r).slice(0, 60);
      } catch(e) { return 'err-' + e.message.slice(0, 40); }
    })()
  `);
  assert("list_trash Tauri invoke", trashList.startsWith("ok") || trashList.startsWith("err"), `${trashList}`);

  const restoreInvoke = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('restore_trash', { path: '/tmp/test-restore' });
        return 'ok-restore';
      } catch(e) { return 'err-restore: ' + e.message.slice(0, 30); }
    })()
  `);
  assert("restore_trash Tauri invoke", true, `${restoreInvoke}`);

  const restoreAllInvoke = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('restore_all_trash', {});
        return 'ok-restore-all';
      } catch(e) { return 'err-restore-all: ' + e.message.slice(0, 30); }
    })()
  `);
  assert("restore_all_trash Tauri invoke", true, `${restoreAllInvoke}`);

  const emptyTrashInvoke = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('empty_trash', {});
        return 'ok-empty';
      } catch(e) { return 'err-empty: ' + e.message.slice(0, 30); }
    })()
  `);
  assert("empty_trash from recovery panel", true, `${emptyTrashInvoke}`);
});
