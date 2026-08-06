import { runTest, jsExpr, jsInvoke, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

runTest("DiskRaptor System Info Test", 9253, async (cdp) => {
  const memoryInfo = await jsInvoke(cdp,
    "window.__TAURI__.invoke('get_memory_info', {})"
  ).catch(() => 'error');
  assert("get_memory_info completes", memoryInfo !== 'error', `${typeof memoryInfo}`);

  if (memoryInfo && typeof memoryInfo === 'object') {
    const hasTotal = typeof memoryInfo.total === 'number' || typeof memoryInfo.data?.total === 'number';
    assert("Memory info has total field", hasTotal, `keys=${Object.keys(memoryInfo).slice(0, 6).join(',')}`);
  }

  const processMemory = await jsInvoke(cdp,
    "window.__TAURI__.invoke('get_process_memory', {})"
  ).catch(() => 'error');
  assert("get_process_memory completes", processMemory !== 'error', `${typeof processMemory}`);

  if (processMemory && typeof processMemory === 'object') {
    const hasResident = typeof processMemory.resident === 'number' || typeof processMemory.data?.resident === 'number';
    assert("Process memory has resident field", hasResident, `keys=${Object.keys(processMemory).slice(0, 6).join(',')}`);
  }

  const appInfo = await jsInvoke(cdp,
    "window.__TAURI__.invoke('get_app_info', {})"
  ).catch(() => 'error');
  assert("get_app_info completes", appInfo !== 'error', `${typeof appInfo}`);

  if (appInfo && typeof appInfo === 'object') {
    const hasVersion = typeof appInfo.version === 'string' || typeof appInfo.data?.version === 'string';
    assert("App info has version", hasVersion, `version=${appInfo.version || appInfo.data?.version}`);
  }

  const volumeStats = await jsInvoke(cdp,
    "window.__TAURI__.invoke('get_volume_stats', {})"
  ).catch(() => 'error');
  assert("get_volume_stats completes", volumeStats !== 'error', `${typeof volumeStats}`);

  if (volumeStats && Array.isArray(volumeStats)) {
    assert("Volume stats is array", true, `count=${volumeStats.length}`);
    if (volumeStats.length > 0) {
      const first = volumeStats[0];
      assert("Volume entry has path", typeof first.path === 'string' || typeof first === 'string', `first=${JSON.stringify(first).slice(0, 60)}`);
    }
  } else if (volumeStats && typeof volumeStats === 'object' && volumeStats.data) {
    assert("Volume stats has data wrapper", Array.isArray(volumeStats.data), `type=${typeof volumeStats.data}`);
  }

  const appVersion = await jsInvoke(cdp,
    "window.__TAURI__.invoke('get_app_version', {})"
  ).catch(() => 'error');
  assert("get_app_version completes", appVersion !== 'error', `${typeof appVersion}`);
});
