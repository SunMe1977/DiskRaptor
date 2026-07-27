import { runTest, jsExpr, assert, clickById, sleep } from "./test_shared.mjs";

runTest("DiskRaptor Settings Test", 9202, async (cdp) => {
  await clickById(cdp, "btn-tools", 300);
  await jsExpr(cdp, `(function(){ const items=document.querySelectorAll('.tools-item'); for(const i of items){ if(i.getAttribute('data-action')==='settings'){ i.click(); return 'opened'; }} return 'not-found'; })()`);
  await sleep(500);

  const overlayVisible = await jsExpr(cdp, `document.getElementById('settings-overlay')?.style?.display === 'flex'`);
  assert("Settings overlay visible", overlayVisible === true);

  const defPath = await jsExpr(cdp, `
    (function() {
      const inp = document.getElementById('settings-default-path');
      if (!inp) return 'not-found';
      return 'found type=' + inp.tagName + ' val=' + (inp.value || '');
    })()
  `);
  assert("Default path input", defPath.startsWith("found"), `${defPath}`);

  const themeOptions = await jsExpr(cdp, `
    (function() {
      const sel = document.getElementById('settings-theme');
      if (!sel) return 'not-found';
      return 'options=' + sel.options.length + ' values=' + Array.from(sel.options).map(o => o.value).join(',');
    })()
  `);
  assert("Theme select has options", themeOptions.startsWith("options="), `${themeOptions}`);

  const themeSet = await jsExpr(cdp, `
    (function() {
      const sel = document.getElementById('settings-theme');
      if (!sel || sel.options.length < 2) return 'not-enough-options';
      const cur = sel.value;
      const next = sel.selectedIndex < sel.options.length - 1 ? sel.selectedIndex + 1 : 0;
      sel.selectedIndex = next;
      sel.dispatchEvent(new Event('change', {bubbles:true}));
      return 'changed-from-' + cur + '-to-' + sel.options[next].value;
    })()
  `);
  assert("Theme value changed", !themeSet.startsWith("not-enough"), `${themeSet}`);

  await sleep(300);
  await clickById(cdp, "settings-close", 300);
  const overlayClosed = await jsExpr(cdp, `document.getElementById('settings-overlay')?.style?.display !== 'flex'`);
  assert("Settings overlay closes", overlayClosed === true);
});
