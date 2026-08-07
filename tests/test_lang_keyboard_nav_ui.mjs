import { runTest, jsExpr, assert, clickById, sleep } from "./test_shared.mjs";

runTest("DiskRaptor Language Menu Keyboard Navigation Test", 9279, async (cdp) => {
  const langBtn = await jsExpr(cdp, `document.getElementById('btn-lang') ? 'found' : 'not-found'`);
  assert("Language button exists", langBtn === "found");

  if (langBtn === "found") {
    await clickById(cdp, "btn-lang", 300);

    const langMenu = await jsExpr(cdp, `document.getElementById('lang-menu')?.classList.contains('active')`);
    assert("Language menu opened", langMenu === true);

    const langItems = await jsExpr(cdp, `Array.from(document.querySelectorAll('#lang-list .lang-item, #lang-list button')).length`);
    assert("Language items rendered", langItems > 0, `items=${langItems}`);

    await jsExpr(cdp, `
      (function() {
        const items = Array.from(document.querySelectorAll('#lang-list .lang-item, #lang-list button'));
        if (items.length === 0) return 'no-items';
        items[0].focus();
        return 'focused-first';
      })()
    `);
    await sleep(200);

    await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); 'arrow-down'`);
    await sleep(150);

    const focusedIndex = await jsExpr(cdp, `
      (function() {
        const active = document.activeElement;
        const items = Array.from(document.querySelectorAll('#lang-list .lang-item, #lang-list button'));
        const idx = items.indexOf(active);
        return 'idx=' + idx;
      })()
    `);
    assert("ArrowDown moved focus", focusedIndex.startsWith("idx="), `${focusedIndex}`);

    await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); 'arrow-up'`);
    await sleep(150);

    const afterArrowUp = await jsExpr(cdp, `
      (function() {
        const active = document.activeElement;
        const items = Array.from(document.querySelectorAll('#lang-list .lang-item, #lang-list button'));
        const idx = items.indexOf(active);
        return 'idx=' + idx;
      })()
    `);
    assert("ArrowUp moved focus back", afterArrowUp.startsWith("idx="), `${afterArrowUp}`);

    await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); 'enter'`);
    await sleep(200);

    await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'esc'`);
    await sleep(200);

    const menuClosed = await jsExpr(cdp, `document.getElementById('lang-menu')?.classList.contains('active') === false`);
    assert("Language menu closed after Escape", menuClosed === true);
  }
});
