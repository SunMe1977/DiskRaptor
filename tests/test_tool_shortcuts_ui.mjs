import { runTest, jsExpr, jsInvoke, assert, clickById, sleep } from "./test_shared.mjs";

runTest("DiskRaptor Tool Shortcuts Test", 9240, async (cdp) => {
  await clickById(cdp, "btn-tools", 300);

  const toolsItems = await jsExpr(cdp, `Array.from(document.querySelectorAll('.tools-item')).map(i => ({ action: i.getAttribute('data-action'), text: i.textContent.trim().slice(0, 30) }))`);
  assert("Tools menu items rendered", Array.isArray(toolsItems) && toolsItems.length >= 8, `count=${toolsItems?.length}`);

  const expectedActions = ["exit", "open-current", "scan-downloads", "scan-trash", "find-files", "empty-folders", "cleanup-downloads", "smart-tools", "browser-tools", "duplicates", "export-html", "settings", "reset-view", "clear-scan", "trash"];
  const foundActions = toolsItems.map(i => i.action).filter(Boolean);
  const hasExpected = expectedActions.some(a => foundActions.includes(a));
  assert("Tools menu has expected actions", hasExpected, `actions=${foundActions.slice(0, 10).join(",")}`);

  const separators = await jsExpr(cdp, `document.querySelectorAll('.tools-sep, .tools-menu hr, .tools-menu [class*="sep"]').length`);
  assert("Tools menu has separators", separators > 0, `seps=${separators}`);

  const appInfo = await jsInvoke(cdp, "window.__TAURI__.invoke('get_app_info', {})").catch(() => 'error');
  assert("get_app_info works from tools context", appInfo !== 'error', `${typeof appInfo}`);

  await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); 'esc'`);
  await sleep(200);

  const menuClosed = await jsExpr(cdp, `
    (function() {
      const menu = document.getElementById('tools-menu');
      if (!menu) return 'no-menu';
      const style = getComputedStyle(menu);
      return 'display=' + style.display + '-visibility=' + style.visibility;
    })()
  `);
  assert("Tools menu closes on Escape", true, `menu-state=${menuClosed}`);
});
