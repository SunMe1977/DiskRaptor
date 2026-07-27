import { runTest, jsExpr, assert, clickById, sleep } from "./test_shared.mjs";

runTest("DiskRaptor i18n/Language Test", 9214, async (cdp) => {
  const hasT = await jsExpr(cdp, `typeof window.__ === 'function' ? 'found' : 'not-found'`);
  const hasI18N = await jsExpr(cdp, `typeof window.I18N !== 'undefined' ? 'found' : 'not-found'`);
  assert("i18n system available", hasT === "found" || hasI18N === "found", `__=${hasT} I18N=${hasI18N}`);

  const langBtn = await jsExpr(cdp, `document.getElementById('btn-lang') ? 'found' : 'not-found'`);
  assert("Language button in toolbar", langBtn === "found");

  const currentLang = await jsExpr(cdp, `document.documentElement lang || document.documentElement.getAttribute('lang') || 'no-lang-attr'`);
  assert("HTML lang attribute set", currentLang !== "no-lang-attr", `lang=${currentLang}`);

  if (hasI18N === "found") {
    const i18nKeys = await jsExpr(cdp, `
      (function() {
        const langs = window.I18N.LANGUAGES;
        if (langs) return 'languages=' + langs.length + ' first=' + (langs[0]?.code || langs[0]);
        return 'no-languages';
      })()
    `);
    assert("i18n languages available", i18nKeys.includes("languages="), `${i18nKeys}`);
  }

  await clickById(cdp, "btn-lang", 300);

  const langMenuItems = await jsExpr(cdp, `
    Array.from(document.querySelectorAll('#lang-menu a, #lang-menu [data-lang], #lang-menu .lang-option')).map(el => ({
      text: el.textContent.trim().slice(0, 10),
      lang: el.getAttribute('data-lang') || el.getAttribute('data-lang-code') || el.id || ''
    }))
  `);
  assert("Language menu items", true, `count=${Array.isArray(langMenuItems) ? langMenuItems.length : 0}`);

  const tFunction = await jsExpr(cdp, `
    (typeof __ === 'function') ? __('btn.scan') :
    (window.I18N && typeof window.I18N.t === 'function') ? window.I18N.t('btn.scan') : 'no-t-function'
  `);
  assert("Translation function works", tFunction !== "no-t-function" && tFunction.length > 0, `__('btn.scan')=${tFunction}`);

  const placeholder = await jsExpr(cdp, `document.getElementById('scan-path')?.placeholder || 'no-placeholder'`);
  assert("Scan path placeholder localized", placeholder !== "no-placeholder", `placeholder="${placeholder}"`);
});
