import { runTest, jsExpr, assert, clickById, sleep } from "./test_shared.mjs";

runTest("DiskRaptor Duplicates Test", 9213, async (cdp) => {
  const toolsItems = await jsExpr(cdp, `Array.from(document.querySelectorAll('.tools-item')).map(i => i.getAttribute('data-action') || i.textContent.trim())`);
  const hasDuplicates = Array.isArray(toolsItems) && toolsItems.some(i => i.includes("dup") || i.includes("Dup"));
  assert("Duplicates tool in menu", hasDuplicates, `items=${toolsItems.slice(0, 8).join(",")}`);

  assert("Duplicates test complete", true, "menu verified");
});
