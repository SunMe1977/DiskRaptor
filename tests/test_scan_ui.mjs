import { runTest, jsExpr, assert, startScan, waitForOverlay, waitForScanComplete, sleep } from "./test_shared.mjs";

runTest("DiskRaptor Scan Test", 9200, async (cdp, scanPath) => {
  const homeDir = await jsExpr(cdp,
    "window.__TAURI__.invoke('get_home_dir').then(r => JSON.stringify(r)).catch(e => 'ERR: ' + e.message)"
  );
  assert("get_home_dir works", homeDir.startsWith('"'), `${homeDir}`);

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
  const statFiles = parseInt((panel.files || "").replace(/,/g, "")) || 0;
  const statDirs = parseInt((panel.dirs || "").replace(/,/g, "")) || 0;
  const sizeOk = (panel.size || "").trim() !== "" && (panel.size || "").trim() !== "—";
  assert("Stats panel populated", statFiles > 0 && statDirs > 0 && sizeOk,
    `files=${panel.files} dirs=${panel.dirs} size=${panel.size}`);

  await sleep(3000);
  const treeHtml = await jsExpr(cdp, `document.getElementById('tree-scroll')?.innerHTML?.length || 0`);
  const treeRows = await jsExpr(cdp, `document.querySelectorAll('.tree-row')?.length || 0`);
  assert("Tree has content", treeHtml > 100 || treeRows > 0, `html=${treeHtml} rows=${treeRows}`);

  assert("Scan completed with data", completed && maxFiles > 0 && statFiles > 0, `files=${maxFiles}`);
});
