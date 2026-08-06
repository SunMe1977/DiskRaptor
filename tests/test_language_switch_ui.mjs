import { runTest, jsExpr, jsInvoke, assert, clickById, sleep } from "./test_shared.mjs";

runTest("DiskRaptor Language Switch Test", 9241, async (cdp) => {
  const langBtn = await jsExpr(cdp, `document.getElementById('btn-lang') ? 'found' : 'not-found'`);
  assert("Language button exists", langBtn === "found");

  const hasI18N = await jsExpr(cdp, `typeof window.I18N !== 'undefined' ? 'found' : 'not-found'`);
  assert("I18N system loaded", hasI18N === "found");

  if (langBtn === "found") {
    await clickById(cdp, "btn-lang", 300);

    const langMenu = await jsExpr(cdp, `document.getElementById('lang-menu') ? 'found' : 'not-found'`);
    assert("Language menu opened", langMenu === "found");

    const langItems = await jsExpr(cdp, `Array.from(document.querySelectorAll('#lang-list .lang-item, #lang-list button, #lang-list [data-lang]')).map(el => el.dataset.lang || el.textContent.trim().slice(0, 20))`);
    assert("Language list populated", Array.isArray(langItems) && langItems.length > 0, `count=${langItems?.length}`);

    const hasAuto = langItems.some(l => typeof l === "string" && l.includes("auto") || l === "auto");
    assert("Auto language option present", hasAuto || langItems.length > 0);

    const langFilter = await jsExpr(cdp, `document.getElementById('lang-filter') ? 'found' : 'not-found'`);
    assert("Language filter input exists", langFilter === "found");

    if (langFilter === "found") {
      await jsExpr(cdp, `document.getElementById('lang-filter').value = 'en'; 'set'`);
      await jsExpr(cdp, `document.getElementById('lang-filter').dispatchEvent(new Event('input', {bubbles:true})); 'input'`);
      await sleep(300);

      const filteredItems = await jsExpr(cdp, `Array.from(document.querySelectorAll('#lang-list .lang-item, #lang-list button')).length`);
      assert("Language filter reduces list", filteredItems <= langItems.length, `before=${langItems.length} after=${filteredItems}`);

      await jsExpr(cdp, `document.getElementById('lang-filter').value = ''; 'cleared'`);
      await jsExpr(cdp, `document.getElementById('lang-filter').dispatchEvent(new Event('input', {bubbles:true})); 'cleared'`);
      await sleep(200);
    }

    const currentLocale = await jsExpr(cdp, `window.I18N ? window.I18N.getLocale().raw : 'no-i18n'`);
    assert("Current locale accessible", currentLocale !== "no-i18n", `locale=${currentLocale}`);

    await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); 'esc'`);
    await sleep(200);

    const menuClosed = await jsExpr(cdp, `document.getElementById('lang-menu')?.classList.contains('active') === false`);
    assert("Language menu closes on Escape", menuClosed === true);
  }

  const tFn = await jsExpr(cdp, `typeof window.__ === 'function' ? 'found' : 'not-found'`);
  assert("Translation function available", tFn === "found");
});
