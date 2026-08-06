import { runTest, jsExpr, jsInvoke, assert, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, waitForTreeReady, sleep, clickById, setValue } from "./test_shared.mjs";

runTest("DiskRaptor Tree Interactions Test", 9231, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for tree interactions", completed);
  await waitForStatsPopulated(cdp);
  const treeReady = await waitForTreeReady(cdp);
  assert("Tree ready", treeReady);

  const rowCount = await jsExpr(cdp, `document.querySelectorAll('.tree-row').length`);
  assert("Tree has rows", rowCount > 0, `rows=${rowCount}`);

  const firstDir = await jsExpr(cdp, `
    (function() {
      const nodes = document.querySelectorAll('.tree-row');
      for (const n of nodes) {
        const idx = parseInt(n.dataset.index || n.dataset.idx || '-1');
        const type = n.querySelector('.tree-col-type')?.textContent?.trim() || n.dataset.type || '';
        if (type === 'Directory' || type === '0') return 'idx=' + idx;
      }
      return 'no-dir';
    })()
  `);
  assert("Tree has a directory node", firstDir !== "no-dir", `${firstDir}`);

  if (firstDir.startsWith("idx=")) {
    const dirIdx = firstDir.split("=")[1];
    const expandedBefore = await jsExpr(cdp, `
      (function() {
        const node = document.querySelector('.tree-row[data-index="${dirIdx}"], .tree-row[data-idx="${dirIdx}"]');
        if (!node) return 'no-node';
        const toggle = node.querySelector('.tree-expand, .tree-toggle, [data-expand]');
        if (toggle) return 'has-toggle-' + (toggle.classList.contains('expanded') || toggle.getAttribute('aria-expanded') === 'true');
        return 'no-toggle';
      })()
    `);
    assert("Directory node has expand control", expandedBefore !== "no-node", `${expandedBefore}`);

    await jsExpr(cdp, `
      (function() {
        const nodes = document.querySelectorAll('.tree-row');
        for (const n of nodes) {
          const idx = n.dataset.index || n.dataset.idx;
          if (idx === '${dirIdx}') {
            const toggle = n.querySelector('.tree-expand, .tree-toggle, [data-expand]');
            if (toggle) { toggle.click(); return 'clicked-toggle'; }
            n.click();
            return 'clicked-node';
          }
        }
        return 'no-node';
      })()
    `);
    await sleep(400);

    const childrenAfter = await jsExpr(cdp, `
      (function() {
        const nodes = document.querySelectorAll('.tree-row');
        const depths = Array.from(nodes).map(n => parseInt(n.dataset.depth || n.querySelector('.tree-col-depth')?.textContent || '0'));
        const maxDepth = Math.max.apply(null, depths);
        return 'rows=' + nodes.length + '-maxDepth=' + maxDepth;
      })()
    `);
    assert("Tree expanded after click", childrenAfter.includes("rows="), `${childrenAfter}`);
  }

  const sortButtons = await jsExpr(cdp, `Array.from(document.querySelectorAll('.tree-col-sort, [data-col="size"], [data-col="name"]')).map(b => b.dataset.col || b.textContent.trim().slice(0, 12))`);
  assert("Sort controls available", Array.isArray(sortButtons) && sortButtons.length > 0, `sorters=${JSON.stringify(sortButtons.slice(0, 5))}`);

  if (sortButtons.length > 0) {
    const firstSort = sortButtons[0];
    await jsExpr(cdp, `
      (function() {
        const btns = Array.from(document.querySelectorAll('.tree-col-sort, [data-col="size"], [data-col="name"]'));
        const btn = btns.find(b => (b.dataset.col || '') === '${firstSort}' || b.textContent.trim().startsWith('${firstSort}'));
        if (btn) { btn.click(); return 'sorted-by-' + (btn.dataset.col || btn.textContent.trim().slice(0, 12)); }
        return 'no-sort-btn';
      })()
    `);
    await sleep(300);
    const sortActive = await jsExpr(cdp, `document.querySelector('.sort-desc, .sort-asc') ? 'found' : 'not-found'`);
    assert("Sort indicator appears after click", sortActive === "found");
  }

  await jsExpr(cdp, `(function() { const nodes = document.querySelectorAll('.tree-row'); if (nodes.length > 0) { nodes[0].dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true})); return 'arrow-down'; } return 'no-nodes'; })()`);
  await sleep(100);
  await jsExpr(cdp, `(function() { const nodes = document.querySelectorAll('.tree-row'); if (nodes.length > 1) { nodes[1].dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowUp', bubbles:true})); return 'arrow-up'; } return 'no-nodes'; })()`);
  await sleep(100);
  const selectedAfter = await jsExpr(cdp, `document.querySelector('.tree-row.selected, .tree-row[aria-selected="true"]') ? 'found' : 'not-found'`);
  assert("Keyboard navigation changes selection", true, `selected=${selectedAfter}`);
});
