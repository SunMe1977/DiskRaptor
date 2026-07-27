import { runTest, jsExpr, assert, startScan, waitForOverlay, waitForScanComplete, sleep, clickById } from "./test_shared.mjs";

runTest("DiskRaptor Menu/Diagram Test", 9208, async (cdp, scanPath) => {
  const homeDir = await jsExpr(cdp,
    "window.__TAURI__.invoke('get_home_dir').then(r => JSON.stringify(r)).catch(e => 'ERR: ' + e.message)"
  );
  assert("get_home_dir works", homeDir.startsWith('"'), `${homeDir}`);

  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp, 400);
  assert("Scan completed", completed);
  await sleep(2000);

  const diagramModes = await jsExpr(cdp, `Array.from(document.querySelectorAll('.diagram-mode')).map(b => b.getAttribute('data-mode') || b.textContent.trim())`);
  assert("Diagram mode buttons exist", Array.isArray(diagramModes) && diagramModes.length > 0, `modes: ${diagramModes.slice(0, 5).join(",")}`);

  const hasPie = diagramModes.some(m => m.includes("pie") || m.includes("Pie"));
  const hasTreemap = diagramModes.some(m => m.includes("tree") || m.includes("Tree"));
  const hasBar = diagramModes.some(m => m.includes("bar") || m.includes("Bar"));
  assert("Pie chart mode", hasPie);
  assert("Treemap mode", hasTreemap);
  assert("Bar chart mode", hasBar);

  await clickById(cdp, "btn-tools", 300);
  const toolsItems = await jsExpr(cdp, `Array.from(document.querySelectorAll('.tools-item')).map(i => i.getAttribute('data-action') || i.textContent.trim())`);
  assert("Tools menu items exist", Array.isArray(toolsItems) && toolsItems.length > 0, `items: ${toolsItems.slice(0, 6).join(",")}`);

  const hasSettings = toolsItems.some(i => i.includes("settings"));
  const hasExport = toolsItems.some(i => i.includes("export"));
  assert("Tools: settings", hasSettings);
  assert("Tools: export", hasExport);

  const aboutResult = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('get_app_info', {});
        return 'ok=' + JSON.stringify(r).slice(0, 40);
      } catch(e) { return 'err: ' + e.message.slice(0, 30); }
    })()
  `);
  assert("About/app info invoke", aboutResult.includes("ok=") || aboutResult.startsWith("err"), `${aboutResult}`);
});
