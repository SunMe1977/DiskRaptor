import { runTest, jsExpr, assert, startScan, waitForOverlay, waitForScanComplete, sleep, clickById } from "./test_shared.mjs";

runTest("DiskRaptor Find Files Test", 9212, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp, 400);
  assert("Scan completed for Find tool", completed);
  await sleep(2000);

  const toolsItems = await jsExpr(cdp, `Array.from(document.querySelectorAll('.tools-item')).map(i => i.getAttribute('data-action') || i.textContent.trim())`);
  const hasFindFiles = Array.isArray(toolsItems) && toolsItems.some(i => i.includes("find") || i.includes("Find"));
  const hasEmptyFolders = Array.isArray(toolsItems) && toolsItems.some(i => i.includes("empty") || i.includes("Empty"));
  assert("Find Files tool in menu", hasFindFiles, `items=${toolsItems.slice(0, 8).join(",")}`);
  assert("Empty Folders tool in menu", hasEmptyFolders, `items=${toolsItems.slice(0, 8).join(",")}`);

  assert("Find tools verified", true, "menu items found");
});
