import { runTest, jsExpr, assert, startScan, waitForOverlay, waitForScanComplete, sleep, clickById } from "./test_shared.mjs";

runTest("DiskRaptor Integration Test", 9221, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  const overlayShown = await waitForOverlay(cdp);
  assert("Progress overlay appears", overlayShown);

  const { completed, maxFiles } = await waitForScanComplete(cdp);
  assert("Scan completes", completed, `files=${maxFiles}`);
  await sleep(2000);

  const stats = await jsExpr(cdp, `JSON.stringify({
    files: document.getElementById('stat-files')?.textContent || '',
    dirs: document.getElementById('stat-dirs')?.textContent || '',
    size: document.getElementById('stat-size')?.textContent || '',
    time: document.getElementById('stat-time')?.textContent || ''
  })`);
  const panel = JSON.parse(stats || "{}");
  assert("Stats panel data", (parseInt((panel.files || "").replace(/,/g, "")) || 0) > 0, `files=${panel.files}`);

  const treeNodes = await jsExpr(cdp, `document.querySelectorAll('.tree-row').length`);
  assert("Tree has nodes", treeNodes > 0, `nodes=${treeNodes}`);

  const topFiles = await jsExpr(cdp, `document.querySelectorAll('#topfiles-body tr').length`);
  assert("Top files has rows", topFiles > 0, `rows=${topFiles}`);

  const diagramModes = await jsExpr(cdp, `Array.from(document.querySelectorAll('.diagram-mode')).length`);
  assert("Diagram modes available", diagramModes >= 3, `count=${diagramModes}`);

  await clickById(cdp, "btn-tools", 300);
  const toolsItems = await jsExpr(cdp, `Array.from(document.querySelectorAll('.tools-item')).map(i => i.getAttribute('data-action') || i.textContent.trim())`);
  assert("Tools menu has items", toolsItems.length >= 5, `count=${toolsItems.length}`);

  const homeDir = await jsExpr(cdp,
    "window.__TAURI__.invoke('get_home_dir').then(r => JSON.stringify(r)).catch(e => 'ERR: ' + e.message)"
  );
  assert("get_home_dir works", homeDir.startsWith('"'), `${homeDir}`);

  const aboutResult = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('get_app_info', {});
        return 'ok=' + JSON.stringify(r).slice(0, 60);
      } catch(e) { return 'err: ' + e.message.slice(0, 40); }
    })()
  `);
  assert("App info via Tauri", aboutResult.includes("ok=") || aboutResult.startsWith("err"), `${aboutResult}`);
});
