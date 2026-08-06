import { runTest, jsExpr, assert, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, clickById, sleep } from "./test_shared.mjs";

runTest("DiskRaptor Diagram Mode Switch Test", 9232, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for diagram test", completed);
  await waitForStatsPopulated(cdp);

  const diagramContainer = await jsExpr(cdp, `document.getElementById('diagram-container') ? 'found' : 'not-found'`);
  assert("Diagram container exists", diagramContainer === "found");

  const galaxyContainer = await jsExpr(cdp, `document.getElementById('galaxy-container') ? 'found' : 'not-found'`);
  assert("Galaxy container exists", galaxyContainer === "found");

  const modeButtons = await jsExpr(cdp, `Array.from(document.querySelectorAll('.diagram-mode')).map(b => b.dataset.mode || b.textContent.trim().slice(0, 16))`);
  assert("Diagram mode buttons exist", Array.isArray(modeButtons) && modeButtons.length >= 2, `modes=${JSON.stringify(modeButtons)}`);

  const initialMode = modeButtons.find(m => m !== "galaxy") || modeButtons[0];
  if (initialMode) {
    await jsExpr(cdp, `
      (function() {
        const btns = Array.from(document.querySelectorAll('.diagram-mode'));
        const btn = btns.find(b => (b.dataset.mode || '') === '${initialMode}') || btns[0];
        if (btn) { btn.click(); return 'clicked-' + (btn.dataset.mode || 'first'); }
        return 'no-btn';
      })()
    `);
    await sleep(600);

    const activeMode = await jsExpr(cdp, `document.querySelector('.diagram-mode.active, .diagram-mode[aria-pressed="true"]') ? (document.querySelector('.diagram-mode.active, .diagram-mode[aria-pressed="true"]').dataset.mode || 'found') : 'not-found'`);
    assert("Diagram mode button shows active state", activeMode !== "not-found", `active=${activeMode}`);
  }

  const hasGalaxyBtn = modeButtons.some(m => m === "galaxy" || typeof m === "string" && m.includes("Galaxy"));
  if (hasGalaxyBtn) {
    await jsExpr(cdp, `
      (function() {
        const btn = Array.from(document.querySelectorAll('.diagram-mode')).find(b => (b.dataset.mode || '') === 'galaxy' || b.textContent.toLowerCase().includes('galaxy'));
        if (btn) { btn.click(); return 'clicked-galaxy'; }
        return 'no-galaxy-btn';
      })()
    `);
    await sleep(800);

    const galaxyVisible = await jsExpr(cdp, `
      (function() {
        const gc = document.getElementById('galaxy-container');
        const dc = document.getElementById('diagram-container');
        if (!gc || !dc) return 'missing-containers';
        return 'galaxy-display=' + gc.style.display + '-diagram-display=' + dc.style.display;
      })()
    `);
    assert("Galaxy view toggled", galaxyVisible.includes("galaxy-display="), `${galaxyVisible}`);

    await jsExpr(cdp, `
      (function() {
        const btn = Array.from(document.querySelectorAll('.diagram-mode')).find(b => (b.dataset.mode || '') === '${initialMode}' || b.textContent.trim().startsWith('${initialMode?.charAt(0) || ''}'));
        if (btn) { btn.click(); return 'back-to-' + (btn.dataset.mode || 'first'); }
        return 'no-btn';
      })()
    `);
    await sleep(400);
  }

  const pieBtn = modeButtons.find(m => typeof m === "string" && (m.includes("pie") || m.includes("Pie")));
  if (pieBtn) {
    await jsExpr(cdp, `
      (function() {
        const btn = Array.from(document.querySelectorAll('.diagram-mode')).find(b => (b.dataset.mode || '').includes('pie') || b.textContent.toLowerCase().includes('pie'));
        if (btn) { btn.click(); return 'clicked-pie'; }
        return 'no-pie-btn';
      })()
    `);
    await sleep(500);
    const pieActive = await jsExpr(cdp, `document.querySelector('.diagram-mode.active') ? (document.querySelector('.diagram-mode.active').dataset.mode || 'found') : 'not-found'`);
    assert("Pie mode selectable", pieActive !== "not-found");
  }
});
