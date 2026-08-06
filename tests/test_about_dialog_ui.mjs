import { runTest, jsExpr, jsInvoke, assert, clickById, sleep } from "./test_shared.mjs";

runTest("DiskRaptor About Dialog Test", 9242, async (cdp) => {
  const aboutOverlay = await jsExpr(cdp, `document.getElementById('about-overlay') ? 'found' : 'not-found'`);
  assert("About overlay exists in DOM", aboutOverlay === "found");

  const aboutVersion = await jsExpr(cdp, `document.querySelector('.about-version') ? 'found' : 'not-found'`);
  assert("About version element exists", aboutVersion === "found");

  const aboutLogo = await jsExpr(cdp, `document.getElementById('about-logo-img') ? 'found' : 'not-found'`);
  assert("About logo element exists", aboutLogo === "found");

  if (aboutOverlay === "found") {
    await jsExpr(cdp, `document.getElementById('about-overlay').classList.add('active'); 'opened'`);
    await sleep(300);

    const overlayActive = await jsExpr(cdp, `document.getElementById('about-overlay')?.classList.contains('active')`);
    assert("About overlay active", overlayActive === true);

    const aboutTabs = await jsExpr(cdp, `Array.from(document.querySelectorAll('.about-tab')).map(t => t.dataset.tab || t.textContent.trim().slice(0, 20))`);
    assert("About tabs exist", Array.isArray(aboutTabs) && aboutTabs.length >= 1, `tabs=${JSON.stringify(aboutTabs?.slice(0, 5))}`);

    if (aboutTabs && aboutTabs.length > 0) {
      const secondTab = aboutTabs[1];
      await jsExpr(cdp, `
        (function() {
          const tabs = Array.from(document.querySelectorAll('.about-tab'));
          const tab = tabs.find(t => (t.dataset.tab || t.textContent.trim().slice(0, 20)) === '${secondTab}') || tabs[1];
          if (tab) { tab.click(); return 'clicked-' + (tab.dataset.tab || tab.textContent.trim().slice(0, 12)); }
          return 'no-tab';
        })()
      `);
      await sleep(300);

      const tabContent = await jsExpr(cdp, `
        (function() {
          const tabs = Array.from(document.querySelectorAll('.about-tab'));
          const active = tabs.find(t => t.classList.contains('active')) || tabs[1];
          const targetId = 'about-tab-' + (active?.dataset.tab || '');
          const content = document.getElementById(targetId);
          return content ? 'found-content' : 'no-content';
        })()
      `);
      assert("About tab content visible", tabContent === "found-content");
    }

    const changelogTab = await jsExpr(cdp, `document.querySelector('[data-tab="changelog"], .about-tab[data-tab="changelog"]') ? 'found' : 'not-found'`);
    if (changelogTab === "found") {
      await jsExpr(cdp, `document.querySelector('[data-tab="changelog"], .about-tab[data-tab="changelog"]').click(); 'changelog'`);
      await sleep(400);

      const changelogContent = await jsExpr(cdp, `document.getElementById('about-tab-changelog') ? 'found' : 'not-found'`);
      assert("Changelog tab content exists", changelogContent === "found");
    }

    await clickById(cdp, "btn-about-close", 300);
    await sleep(200);

    const overlayClosed = await jsExpr(cdp, `document.getElementById('about-overlay')?.classList.contains('active') === false`);
    assert("About overlay closes", overlayClosed === true);
  }

  const appInfo = await jsInvoke(cdp, "window.__TAURI__.invoke('get_app_info', {})").catch(() => 'error');
  assert("get_app_info returns version", appInfo !== 'error' && appInfo?.version, `version=${appInfo?.version || 'missing'}`);

  const versionEl = await jsExpr(cdp, `document.querySelector('.about-version')?.textContent?.trim() || ''`);
  assert("Version text populated in about dialog", versionEl.length > 0, `version-text="${versionEl}"`);
});
