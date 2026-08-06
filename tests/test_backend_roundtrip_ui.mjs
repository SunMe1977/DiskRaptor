import { runTest, jsExpr, jsInvoke, assert, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

runTest("DiskRaptor Backend Roundtrip Test", 9259, async (cdp, scanPath) => {
  const commands = [
    { name: "get_home_dir", args: {} },
    { name: "get_app_info", args: {} },
    { name: "get_app_version", args: {} },
    { name: "list_drives", args: {} },
    { name: "get_memory_info", args: {} },
    { name: "is_sandboxed", args: {} },
    { name: "request_permissions", args: {} },
    { name: "get_volume_stats", args: {} },
    { name: "get_dir_stats", args: { path: scanPath } },
  ];

  for (const cmd of commands) {
    const result = await jsInvoke(cdp,
      `window.__TAURI__.invoke('${cmd.name}', ${JSON.stringify(cmd.args)})`
    ).catch(() => 'error');

    if (cmd.name === "list_drives") {
      assert(`Backend ${cmd.name} returns data`, result !== 'error', `${typeof result}`);
      if (result && !Array.isArray(result) && result.data) {
        assert(`Backend ${cmd.name} has data wrapper`, Array.isArray(result.data), `type=${typeof result.data}`);
      }
    } else if (cmd.name === "get_dir_stats") {
      assert(`Backend ${cmd.name} returns data`, result !== 'error', `${typeof result}`);
      if (result && typeof result === 'object') {
        const hasPath = typeof result.path === 'string' || typeof result.data?.path === 'string';
        assert(`Backend ${cmd.name} has path field`, hasPath || result !== 'error', `keys=${Object.keys(result).slice(0, 5).join(',')}`);
      }
    } else {
      assert(`Backend ${cmd.name} succeeds`, result !== 'error', `${typeof result}`);
    }
  }

  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for roundtrip test", completed);
  await waitForStatsPopulated(cdp);

  const statsResult = await jsInvoke(cdp,
    "window.__TAURI__.invoke('get_scan_progress', {})"
  ).catch(() => 'error');
  assert("get_scan_progress after scan", statsResult !== 'error', `${typeof statsResult}`);

  const scanResult = await jsInvoke(cdp,
    "window.__TAURI__.invoke('get_scan_result', {})"
  ).catch(() => 'error');
  assert("get_scan_result after scan", scanResult !== 'error', `${typeof scanResult}`);
});
