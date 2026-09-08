// Issue #46. Standalone browser-only regression: no native bridge or disk scans.
// Run: npm run test:scan-timeout
// Optional: PLAYWRIGHT_CHANNEL=chromium (or msedge/chrome),
//           PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const frontend = new URL('../frontend/', import.meta.url);
const html = (await readFile(new URL('index.html', frontend), 'utf8'))
  .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
  .replace(/<link\b[^>]*>/gi, '');
const css = await readFile(new URL('style.css', frontend), 'utf8');
const scriptNames = [
  'format.js', 'i18n.js', 'dialogs.js',
  'app-modules/settings.js', 'app-modules/tools.js', 'app-modules/scan.js',
];
const scripts = await Promise.all(scriptNames.map(async name => ({
  name, content: await readFile(new URL(name, frontend), 'utf8'),
})));
const localeScripts = Object.fromEntries(await Promise.all(['en', 'de', 'fr', 'ui-extra'].map(async name => [
  name, await readFile(new URL(`i18n/${name}.js`, frontend), 'utf8'),
])));
const launchOptions = { headless: true };
if (process.env.PLAYWRIGHT_CHANNEL) launchOptions.channel = process.env.PLAYWRIGHT_CHANNEL;
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
  launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
}
// Full Chromium is often installed without Playwright's separate headless shell.
let browser;
try {
  browser = await chromium.launch(launchOptions);
} catch (error) {
  if (launchOptions.channel || launchOptions.executablePath || !/Executable doesn't exist/.test(error.message)) throw error;
  browser = await chromium.launch({ ...launchOptions, channel: 'chromium' });
}

const fakePath = '/mock/issue-46';
const secondPath = '/mock/issue-46-second';
const htmlPath = '/mock/<img src=x onerror="window.__injected=true">&folder';
const diagnostic = `TIMEOUT: no work completed for 120s; phase=walking; files=7; dirs=2; current path: ${htmlPath}`;
const stats = termination => ({
  total_files: 7, total_dirs: 2, total_size: 4096, scan_time_ms: 500,
  termination, top_files: [], file_type_breakdown: [],
});
const running = (files = 3, dirs = 1, extra = {}) => ({
  is_running: true, phase: 0, termination: null,
  files_found: files, dirs_found: dirs, bytes_found: 1024, elapsed_secs: 1, errors: [], ...extra,
});
const terminal = (termination, errors = [], files = 7, dirs = 2) => ({
  is_running: false, phase: 3, termination,
  files_found: files, dirs_found: dirs, bytes_found: 4096, elapsed_secs: 2, errors,
});
function scenario(termination = 'completed', errors = [], withResult = true) {
  return {
    progress: [running(), terminal(termination, errors)],
    result: withResult ? {
      stats: stats(termination), root_info: { total_nodes: 3, total_chunks: 1 },
    } : { success: false, error: 'No scan result' },
  };
}
// Holds the scan in "running" until the test clicks Cancel, then terminates.
function holdUntilCancelScenario(termination = 'cancelled') {
  return {
    holdUntilCancel: true,
    progress: [running(), terminal(termination)],
    result: { stats: stats(termination), root_info: { total_nodes: 3, total_chunks: 1 } },
  };
}
function emptyResultScenario() {
  return {
    progress: [terminal('completed', [], 0, 0)],
    result: {
      stats: {
        total_files: 0, total_dirs: 1, total_size: 0, scan_time_ms: 10,
        termination: 'completed', top_files: [], file_type_breakdown: [],
      },
      root_info: { total_nodes: 1, total_chunks: 1 },
    },
  };
}
function zeroTimeoutScenario() {
  return {
    progress: [terminal('timed_out', [diagnostic], 0, 0)],
    result: { success: false, error: 'No scan result' },
  };
}

async function fixture(settings = {}, scenarios = [scenario()], opts = {}) {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  // No server, file:// access, external network, or native IPC is available.
  await context.route('**/*', async route => {
    const request = route.request();
    if (request.url() === 'https://diskraptor.test/') {
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    const locale = /^https:\/\/diskraptor\.test\/i18n\/([\w-]+)\.js$/.exec(request.url())?.[1];
    if (locale && Object.hasOwn(localeScripts, locale)) {
      await page.evaluate(name => window.fixture.localeRequests.push({
        name, executed: [...window.fixture.localeExecuted],
      }), locale);
      return route.fulfill({
        contentType: 'application/javascript',
        body: `${localeScripts[locale]}\nwindow.fixture.localeExecuted.push(${JSON.stringify(locale)});`,
      });
    }
    if (request.resourceType() === 'image') {
      return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
    }
    errors.push(`Unexpected network request: ${request.url()}`);
    return route.abort();
  });
  await page.goto('https://diskraptor.test/');
  await page.addStyleTag({ content: css });
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  await page.evaluate(({ settings, scenarios, gate }) => {
    localStorage.setItem('diskraptor-lang', 'en');
    const f = window.fixture = {
      settings: { tips_dismissed: true, ...settings }, scenarios, calls: [], starts: [],
      violations: [], dialogs: [], toasts: [], sleeps: [], renders: [], diagrams: [],
      topFiles: [], prepares: [], chunks: [], rebuilds: 0, clears: 0, releases: 0,
      pulses: 0, getSettings: [], scanRecords: {}, nextId: 4600,
      localeRequests: [], localeExecuted: [],
    };
    // Kept outside `fixture` because it holds live promise resolvers.
    window.__gate = { resolvers: [], released: 0, enabled: !!gate };
    function reject(message) {
      f.violations.push(message);
      throw new Error(message);
    }
    function exactKeys(args, keys, command) {
      if (JSON.stringify(Object.keys(args).sort()) !== JSON.stringify(keys.sort())) {
        reject(`${command}: unexpected argument keys ${JSON.stringify(args)}`);
      }
    }
    const invoke = async (command, args = {}) => {
      f.calls.push({ command, args: structuredClone(args) });
      switch (command) {
        case 'load_settings': return structuredClone(f.settings);
        case 'save_settings':
          exactKeys(args, ['settings'], command);
          Object.assign(f.settings, structuredClone(args.settings));
          return true;
        case 'start_scan': {
          exactKeys(args, ['path', 'followSymlinks', 'timeoutSecs'], command);
          if (typeof args.path !== 'string' || typeof args.followSymlinks !== 'boolean' ||
              !Number.isInteger(args.timeoutSecs) || args.timeoutSecs < 0 || args.timeoutSecs > 3600) {
            reject(`Invalid start_scan arguments: ${JSON.stringify(args)}`);
          }
          const script = f.scenarios.shift();
          if (!script) reject('Unscripted scan (possibly automatic retry)');
          const id = ++f.nextId;
          f.scanRecords[id] = { script, polls: 0, results: 0 };
          f.starts.push({ id, args: structuredClone(args), badgeAtStart: !!document.getElementById('scan-error-badge') });
          return { scan_id: id };
        }
        case 'get_scan_progress':
        case 'get_scan_result': {
          exactKeys(args, ['scanId'], command);
          const scan = f.scanRecords[args.scanId];
          if (!scan) reject(`Unknown scan ID: ${args.scanId}`);
          if (command === 'get_scan_result') {
            scan.results++;
            return structuredClone(scan.script.result);
          }
          const held = scan.script.holdUntilCancel &&
            !f.calls.some(c => c.command === 'cancel_scan');
          const index = held ? 0 : Math.min(scan.polls, scan.script.progress.length - 1);
          scan.polls++;
          if (scan.polls > 30) reject('Scan exceeded scripted polling budget');
          return structuredClone(scan.script.progress[index]);
        }
        case 'cancel_scan': return true;
        case 'request_permissions': return true;
        case 'list_drives': return [];
        case 'get_app_data_dir': return { path: '/mock/app-data' };
        case 'get_autostart': return false;
        case 'set_autostart': return true;
        case 'get_memory_info':
        case 'get_process_memory': return {};
        case 'set_locale': return true;
        default: return reject(`Forbidden/unexpected fake IPC command: ${command}`);
      }
    };
    window.__TAURI__ = { invoke, core: { invoke } };
    window.app = {
      state: { isScanning: false, currentScanId: null, currentStats: null, currentScanResult: null },
      invoke,
      getSetting: async (key, fallback) => {
        f.getSettings.push({ key, fallback });
        const saved = await invoke('load_settings', {});
        return saved[key] === undefined ? fallback : saved[key];
      },
    };
    window.showToast = (message, type) => f.toasts.push({ message, type });
  }, { settings, scenarios, gate: !!opts.gate });
  for (const script of scripts) {
    await page.addScriptTag({ content: `${script.content}\n//# sourceURL=${script.name}` });
  }
  await page.evaluate(async () => {
    await window.I18N.ready;
    const f = window.fixture;
    const el = id => document.getElementById(id);
    const chkFollow = document.createElement('label');
    chkFollow.id = 'chk-follow-symlinks';
    chkFollow.innerHTML = '<input type="checkbox">';
    el('btn-scan').before(chkFollow);
    const errDisplay = document.createElement('div');
    errDisplay.id = 'scan-errors';
    el('progress-overlay').append(errDisplay);
    const scanClassList = el('btn-scan').classList;
    const add = scanClassList.add.bind(scanClassList);
    scanClassList.add = (...tokens) => {
      if (tokens.includes('btn-success-flash')) f.pulses++;
      return add(...tokens);
    };
    const yesNoDialog = window.yesNoDialog;
    window.yesNoDialog = (...args) => {
      f.dialogs.push({ args, isScanning: window.app.state.isScanning, scanDisabled: el('btn-scan').disabled });
      return yesNoDialog(...args);
    };
    // Mirrors the real ChunkLoader/TreeView lifecycle closely enough that stale
    // data, status-bar ownership and export gating behave like production.
    const treeStatusEl = () => document.querySelector('#tree-panel .status-bar');
    const loaderMock = {
      allNodes: [], scanId: null, totalNodes: 0, totalChunks: 0,
      loadedChunks: new Set(),
      prepare(totalNodes, totalChunks, scanId) {
        f.prepares.push([totalNodes, totalChunks, scanId]);
        this.scanId = scanId;
        this.totalNodes = totalNodes;
        this.totalChunks = totalChunks;
        this.allNodes = [];
        this.loadedChunks = new Set();
      },
      async loadChunk(index) {
        f.chunks.push(index);
        if (index >= 0 && index < this.totalChunks && !this.loadedChunks.has(index)) {
          this.loadedChunks.add(index);
          this.allNodes[0] = {
            name: 'root', node_type: 0, parent: 4294967295, depth: 0,
            size: 4096, file_count: 7, dir_count: 2,
          };
        }
      },
      async release() { f.releases++; this.prepare(0, 0, null); },
    };
    const treeViewMock = {
      expanded: new Set(), visibleNodes: [], selectedIndex: null, scanStatus: null,
      clear() {
        f.clears++;
        this.visibleNodes = [];
        this.expanded.clear();
        this.selectedIndex = null;
        this.scanStatus = null;
      },
      async rebuild() {
        f.rebuilds++;
        if (loaderMock.totalNodes === 0) {
          this.visibleNodes = [];
        } else {
          this.visibleNodes = loaderMock.allNodes[0] ? [{ idx: 0 }] : [];
        }
        if (this.scanStatus && this.scanStatus.scanId !== loaderMock.scanId) {
          this.scanStatus = null;
        }
        const se = treeStatusEl();
        if (!se) return;
        if (this.scanStatus) {
          se.textContent = this.scanStatus.message;
        } else {
          const n = this.visibleNodes.length;
          se.textContent = window.__('tree.visible')
            .replace('{n}', String(n)).replace('{s}', n === 1 ? '' : 's');
        }
      },
    };
    const refs = {
      scanPath: el('scan-path'), btnBrowse: el('btn-browse'), btnScan: el('btn-scan'),
      btnRescan: el('btn-rescan'), btnCancel: el('btn-cancel'), btnExport: el('btn-export'),
      progressOverlay: el('progress-overlay'), progressPath: el('progress-path'), chkFollow, errDisplay,
      loader: loaderMock,
      treeView: treeViewMock,
      diagram: { setData: value => f.diagrams.push(structuredClone(value)) },
      topFiles: { render: (...args) => f.topFiles.push(structuredClone(args)) },
      statsPanel: { render: value => f.renders.push(structuredClone(value)), updateLive: () => {} },
      hideWelcome: () => { el('welcome-placeholder').style.display = 'none'; },
      showWelcome: () => {},
      // Polls yield microtasks, not wall-clock seconds. A hard budget catches
      // loops; gate mode lets a test interleave clicks between polls.
      sleep: async ms => {
        f.sleeps.push(ms);
        if (f.sleeps.length > 200) throw new Error('Fixture sleep budget exceeded');
        if (window.__gate.enabled) {
          await new Promise(resolve => window.__gate.resolvers.push(resolve));
        }
      },
    };
    window.__refs = refs;
    window.app.initSettings(refs);
    window.app.initTools(refs);
    window.app.initScan(refs);
  });
  return { page, context, errors };
}

async function snapshot(page) {
  return page.evaluate(() => ({
    ...window.fixture, state: window.app.state,
    status: document.querySelector('.status-bar').textContent,
    nodeCount: document.getElementById('node-count')?.textContent ?? null,
    badge: document.getElementById('scan-error-badge')?.textContent ?? null,
    overlayActive: document.getElementById('progress-overlay').classList.contains('active'),
    scanDisabled: document.getElementById('btn-scan').disabled,
    cancelDisabled: document.getElementById('btn-cancel').disabled,
    exportDisabled: document.getElementById('btn-export').disabled,
    liveTree: !!document.getElementById('live-tree'),
  }));
}
async function treeProbe(page) {
  return page.evaluate(() => ({
    nodes: window.__refs.loader.allNodes.length,
    rootNode: !!window.__refs.loader.allNodes[0],
    visible: window.__refs.treeView.visibleNodes.length,
    selected: window.__refs.treeView.selectedIndex,
    loaderScanId: window.__refs.loader.scanId,
  }));
}
async function start(page, { path = fakePath, follow = false, count = 1 } = {}) {
  await page.evaluate(({ path, follow }) => {
    document.getElementById('scan-path').value = path;
    document.querySelector('#chk-follow-symlinks input').checked = follow;
    document.getElementById('btn-scan').click();
  }, { path, follow });
  await idle(page, count);
}
async function idle(page, count) {
  await page.waitForFunction(count => window.fixture.starts.length >= count && !window.app.state.isScanning,
    count, { polling: 10 });
}
// Gate mode: release exactly one pending fixture sleep.
async function gateStep(page) {
  await page.waitForFunction(() => window.__gate.resolvers.length > window.__gate.released,
    null, { polling: 10 });
  await page.evaluate(() => {
    const g = window.__gate;
    const i = g.released++;
    g.resolvers[i]();
  });
}
async function openSettings(page) {
  await page.locator('#btn-tools').click();
  await page.locator('#tools-menu [data-action="settings"]').click();
  assert.equal(await page.locator('#settings-overlay').isVisible(), true);
}
async function accessibleBounds(locator, viewport) {
  const box = await locator.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, `${locator} must have visible bounds`);
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 &&
    box.y + box.height <= viewport.height + 1, `${locator} must fit viewport: ${JSON.stringify(box)}`);
  assert.equal(await locator.evaluate(el => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }), true, `${locator} must not be clipped or covered`);
  return box;
}
function exactStart(s, index, timeoutSecs, followSymlinks = false, path = fakePath) {
  assert.deepEqual(s.starts[index].args, { path, followSymlinks, timeoutSecs });
  assert.equal(s.starts[index].badgeAtStart, false, 'old errors badge must be removed before start_scan');
}
// Completed scans hand the status bar to the tree rebuild ("N nodes visible").
const TREE_STATUS_RE = /node|visible|tree|shown/i;
function timeoutState(s) {
  assert.equal(s.state.isScanning, false);
  assert.equal(s.scanDisabled, false);
  assert.equal(s.cancelDisabled, true);
  assert.equal(s.overlayActive, false);
  assert.equal(s.pulses, 0, 'partial scans must not pulse success');
  assert.equal(s.dialogs.length, 1);
  assert.equal(s.dialogs[0].isScanning, false, 'retry dialog must open after finally releases scanning');
  assert.equal(s.dialogs[0].scanDisabled, false);
  assert.ok(s.toasts.some(t => t.type === 'warning' && /partial|timed out|interrupted/i.test(t.message)));
  assert.doesNotMatch(s.status, /scan complete/i);
}

let passed = 0;
const failures = [];
async function test(name, settings, scenarios, run, opts = {}) {
  let f;
  try {
    f = await fixture(settings, scenarios, opts);
    await run(f.page);
    const s = await snapshot(f.page);
    assert.deepEqual(s.violations, [], 'fake IPC contract violations (including swallowed rejections)');
    assert.deepEqual(f.errors, [], 'browser errors');
    assert.ok(s.sleeps.every(ms => ms <= 1000));
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}\n${error.stack}`);
    if (f) {
      const s = await snapshot(f.page).catch(() => null);
      console.error(JSON.stringify({ browserErrors: f.errors, starts: s?.starts, violations: s?.violations, status: s?.status }));
    }
  } finally {
    if (f) await f.context.close();
  }
}

try {
  for (const [name, value, expected, follow] of [
    ['default', undefined, 120, false], ['configured', 45, 45, true],
    ['disabled', 0, 0, false], ['maximum', 3600, 3600, true],
  ]) {
    await test(`${name} timeout uses exact camelCase start arguments`,
      value === undefined ? {} : { scan_timeout_secs: value }, [scenario()], async page => {
        await start(page, { follow });
        const s = await snapshot(page);
        exactStart(s, 0, expected, follow);
        assert.deepEqual(s.getSettings, [{ key: 'scan_timeout_secs', fallback: 120 }]);
        assert.equal(s.pulses, 1);
        assert.equal(s.dialogs.length, 0);
        assert.equal(s.state.currentStats.termination, 'completed');
        // Every scan first resets the previous one, then renders the result.
        assert.deepEqual(s.renders, [null, stats('completed')]);
        assert.deepEqual(s.diagrams, [null, stats('completed')]);
        assert.deepEqual(s.prepares, [[0, 0, null], [3, 1, s.starts[0].id]]);
        assert.deepEqual(s.chunks, [0]);
        assert.equal(s.clears, 1);
        assert.equal(s.rebuilds, 1);
        assert.equal(s.exportDisabled, false);
        assert.equal(s.badge, null);
        assert.equal((await treeProbe(page)).rootNode, true);
        assert.match(s.status, TREE_STATUS_RE);
        assert.equal(s.scanRecords[s.starts[0].id].results, 1);
      });
  }

  for (const value of [-1, 3601, 1.5, '60', '0', '', 'invalid', null, true, [], {}]) {
    await test(`invalid persisted timeout ${JSON.stringify(value)} falls back`,
      { scan_timeout_secs: value }, [scenario()], async page => {
        await start(page);
        exactStart(await snapshot(page), 0, 120);
        await openSettings(page);
        assert.equal(await page.locator('#settings-scan-timeout').inputValue(), '120');
      });
  }

  await test('timeout validator handles non-JSON numeric edge cases', {}, [], async page => {
    assert.deepEqual(await page.evaluate(() =>
      [undefined, NaN, Infinity, -Infinity, 0, 1, 120, 3600].map(window.app.scanTimeoutSeconds)),
    [120, 120, 120, 120, 0, 1, 120, 3600]);
  });

  await test('preferences save/reopen, zero, bounds, invalid input, and next scan', {},
    [scenario(), scenario()], async page => {
      await openSettings(page);
      const input = page.locator('#settings-scan-timeout');
      assert.deepEqual(await input.evaluate(el => ({ type: el.type, min: el.min, max: el.max, step: el.step, required: el.required })),
        { type: 'number', min: '0', max: '3600', step: '1', required: true });
      assert.equal(await input.inputValue(), '120');
      for (const value of ['240', '0', '3600']) {
        await input.fill(value);
        await page.locator('#settings-save').click();
        assert.equal(await page.locator('#settings-overlay').isVisible(), false);
        assert.equal((await snapshot(page)).settings.scan_timeout_secs, Number(value));
        await openSettings(page);
        assert.equal(await input.inputValue(), value);
      }
      const before = (await snapshot(page)).calls.filter(c => c.command === 'save_settings').length;
      for (const value of ['-1', '3601', '1.5', '']) {
        await input.fill(value);
        assert.equal(await input.evaluate(el => el.checkValidity()), false);
        await page.locator('#settings-save').click();
        assert.equal(await page.locator('#settings-overlay').isVisible(), true);
        const s = await snapshot(page);
        assert.equal(s.settings.scan_timeout_secs, 3600);
        assert.equal(s.calls.filter(c => c.command === 'save_settings').length, before);
      }
      // A number input sanitizes non-numeric text to empty; required must reject it.
      await input.evaluate(el => { el.value = 'not-a-number'; });
      await page.locator('#settings-save').click();
      assert.equal((await snapshot(page)).calls.filter(c => c.command === 'save_settings').length, before);
      await input.fill('75');
      await page.locator('#settings-save').click();
      await start(page);
      exactStart(await snapshot(page), 0, 75);
      await openSettings(page);
      await input.fill('0');
      await page.locator('#settings-save').click();
      await start(page, { count: 2 });
      exactStart(await snapshot(page), 1, 0);
      await openSettings(page);
      assert.equal(await input.inputValue(), '0');
    });

  for (const dismiss of ['close', 'escape']) {
    await test(`final-progress timeout without result: escaped diagnostics, ${dismiss} does not retry`, {},
      [scenario('timed_out', [diagnostic], false)], async page => {
        await start(page, { path: htmlPath });
        let s = await snapshot(page);
        timeoutState(s);
        assert.equal(s.state.currentStats.total_files, 7);
        assert.equal(s.state.currentStats.termination, 'timed_out');
        assert.equal(s.exportDisabled, true, 'no result must not be exportable');
        assert.match(s.badge, /1/);
        const dialog = page.locator('.dlg-overlay');
        assert.ok((await dialog.textContent()).includes(htmlPath));
        assert.match(await dialog.textContent(), /drive connection|permission dialogs/i);
        assert.equal(await dialog.locator('img, script').count(), 0);
        assert.equal(await page.evaluate(() => window.__injected === true), false);
        await page.clock.runFor(10000);
        assert.equal((await snapshot(page)).starts.length, 1, 'no automatic retry while dialog waits');
        if (dismiss === 'close') await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        else await page.keyboard.press('Escape');
        await page.clock.runFor(10000);
        assert.equal(await dialog.count(), 0);
        s = await snapshot(page);
        assert.equal(s.starts.length, 1);
        assert.equal(s.settings.scan_timeout_secs, undefined);
        assert.equal(s.scanRecords[s.starts[0].id].results, 1, 'timeout must fetch once, not wait through result retries');
        await page.locator('#scan-error-badge').click();
        const details = page.locator('div').filter({ has: page.locator('.sb-close') });
        assert.ok((await details.last().evaluate(el => el.parentElement.textContent)).includes(htmlPath));
        assert.equal(await page.locator('img[src="x"]').count(), 0);
        await page.locator('.sb-close').click();
      });
  }

  for (const [seconds, retrySeconds] of [[30, 120], [120, 240], [240, 480], [2000, 3600], [3600, 3600]]) {
    await test(`manual retry ${seconds}s -> ${retrySeconds}s is one-shot and preserves preference`,
      { scan_timeout_secs: seconds }, [scenario('timed_out', [diagnostic], false), scenario(), scenario()], async page => {
        await start(page, { follow: true });
        timeoutState(await snapshot(page));
        await page.clock.runFor(10000);
        assert.equal((await snapshot(page)).starts.length, 1);
        // User edits while the modal waits must not change the failed scan's retry target/options.
        await page.evaluate(() => {
          document.getElementById('scan-path').value = '/mock/different';
          document.querySelector('#chk-follow-symlinks input').checked = false;
        });
        await page.locator('.dlg-overlay').getByRole('button', { name: `Retry with ${retrySeconds}s timeout`, exact: true }).click();
        await idle(page, 2);
        let s = await snapshot(page);
        exactStart(s, 0, seconds, true);
        exactStart(s, 1, retrySeconds, true);
        assert.notEqual(s.starts[0].id, s.starts[1].id);
        assert.equal(s.state.currentScanId, s.starts[1].id);
        assert.equal(s.settings.scan_timeout_secs, seconds);
        assert.equal(s.calls.filter(c => c.command === 'save_settings' && 'scan_timeout_secs' in c.args.settings).length, 0);
        assert.equal(s.badge, null);
        assert.equal(s.pulses, 1);
        assert.equal(s.exportDisabled, false);
        await page.clock.runFor(10000);
        assert.equal((await snapshot(page)).starts.length, 2);
        await start(page, { count: 3 });
        s = await snapshot(page);
        exactStart(s, 2, seconds);
        assert.equal(s.pulses, 2);
      });
  }

  for (const errors of [[], ['Access denied: /mock/private', diagnostic]]) {
    await test(`partial timeout result retains tree ${errors.length ? 'with permission error before TIMEOUT' : 'without diagnostics'}`,
      { scan_timeout_secs: 120 }, [scenario('timed_out', errors)], async page => {
        await start(page);
        const s = await snapshot(page);
        timeoutState(s);
        assert.equal(s.state.currentScanResult.stats.termination, 'timed_out');
        assert.deepEqual(s.renders, [null, stats('timed_out')]);
        assert.deepEqual(s.diagrams, [null, stats('timed_out')]);
        assert.deepEqual(s.prepares, [[0, 0, null], [3, 1, s.starts[0].id]]);
        assert.deepEqual(s.chunks, [0]);
        assert.equal(s.rebuilds, 1);
        assert.equal(s.exportDisabled, false, 'partial results remain exportable');
        assert.equal((await treeProbe(page)).rootNode, true);
        assert.equal(s.scanRecords[s.starts[0].id].results, 1);
        if (errors.length) {
          assert.match(s.status, /no work completed/);
          assert.doesNotMatch(s.status, /Access denied/);
          assert.match(s.badge, /2/);
          assert.ok(s.dialogs[0].args[0].includes(htmlPath));
          assert.doesNotMatch(s.dialogs[0].args[0], /Access denied/);
        } else {
          // The partial status must survive the tree rebuild (scanStatus).
          assert.match(s.status, /partial|timed out/i);
        }
        await page.keyboard.press('Escape');
      });
  }

  for (const termination of ['cancelled', 'limit_reached']) {
    await test(`${termination} partial result retains tree without retry or success`, {}, [scenario(termination)], async page => {
      await start(page);
      await page.clock.runFor(10000);
      const s = await snapshot(page);
      assert.equal(s.state.isScanning, false);
      assert.equal(s.pulses, 0);
      assert.equal(s.dialogs.length, 0);
      assert.equal(s.starts.length, 1);
      assert.deepEqual(s.state.currentScanResult.stats, stats(termination));
      assert.deepEqual(s.renders, [null, stats(termination)]);
      assert.deepEqual(s.chunks, [0]);
      assert.equal(s.exportDisabled, false);
      assert.match(s.status, /partial/i);
      assert.match(s.status, termination === 'cancelled' ? /cancelled|cancel/i : /limit/i);
      assert.ok(s.toasts.some(t => t.type === 'warning' && /partial/i.test(t.message)));
      assert.equal(await page.locator('.dlg-overlay').count(), 0);
    });
  }

  for (const termination of ['timed_out', 'cancelled', 'failed']) {
    await test(`${termination} terminal progress without result or errors remains partial`, {},
      [scenario(termination, [], false)], async page => {
        await start(page);
        const s = await snapshot(page);
        assert.equal(s.scanRecords[s.starts[0].id].results, 1);
        assert.equal(s.pulses, 0);
        assert.equal(s.exportDisabled, true, 'no result must not be exportable');
        assert.match(s.status, /partial|interrupted/i);
        assert.doesNotMatch(s.status, /scan complete/i);
        assert.equal(s.state.currentStats.total_files, 7);
        assert.equal(s.state.currentStats.termination, termination);
        if (termination === 'timed_out') {
          timeoutState(s);
          await page.keyboard.press('Escape');
        } else {
          assert.equal(s.dialogs.length, 0);
        }
        await page.clock.runFor(10000);
        assert.equal((await snapshot(page)).starts.length, 1);
      });
  }

  await test('completed terminal progress without result is reported interrupted, not complete', {},
    [scenario('completed', [], false)], async page => {
      await start(page);
      await page.clock.runFor(10000);
      const s = await snapshot(page);
      assert.equal(s.pulses, 0);
      assert.equal(s.dialogs.length, 0);
      assert.equal(s.exportDisabled, true);
      assert.equal(s.state.currentStats.termination, 'interrupted');
      assert.match(s.status, /partial|interrupted/i);
      assert.doesNotMatch(s.status, /scan complete/i);
      assert.ok(s.toasts.some(t => t.type === 'warning' && /partial|interrupted/i.test(t.message)));
      assert.equal(s.starts.length, 1);
    });

  await test('usable empty result stays complete and exportable', {}, [emptyResultScenario()], async page => {
    await start(page);
    await page.clock.runFor(10000);
    const s = await snapshot(page);
    assert.equal(s.pulses, 1);
    assert.equal(s.dialogs.length, 0);
    assert.equal(s.exportDisabled, false);
    assert.equal(s.state.currentStats.total_files, 0);
    assert.equal(s.state.currentStats.termination, 'completed');
    assert.ok(!s.toasts.some(t => t.type === 'warning' && /partial|interrupted/i.test(t.message)));
    assert.match(s.status, TREE_STATUS_RE);
    assert.equal(s.starts.length, 1);
  });

  await test('zero-file timeout after a populated scan leaves no stale tree', {},
    [scenario(), zeroTimeoutScenario()], async page => {
      await start(page);
      let probe = await treeProbe(page);
      assert.equal(probe.rootNode, true, 'first scan populates the tree');
      assert.equal(probe.visible, 1);
      assert.equal((await snapshot(page)).exportDisabled, false);
      await start(page, { path: secondPath, count: 2 });
      const s = await snapshot(page);
      probe = await treeProbe(page);
      assert.equal(probe.rootNode, false, 'stale nodes must be cleared at scan start');
      assert.equal(probe.nodes, 0);
      assert.equal(probe.visible, 0);
      assert.equal(probe.selected, null);
      assert.equal(probe.loaderScanId, s.starts[1].id, 'loader tracks the new scan, not the stale one');
      assert.equal(s.clears, 2);
      assert.equal(s.exportDisabled, true);
      assert.equal(s.pulses, 1, 'only the first, completed scan may pulse');
      assert.equal(s.state.isScanning, false);
      assert.equal(s.dialogs.length, 1);
      assert.equal(s.dialogs[0].isScanning, false);
      assert.match(s.status, /partial|timed out/i);
      assert.match(s.nodeCount, /0 shown/);
      await page.keyboard.press('Escape');
      await page.clock.runFor(10000);
      assert.equal((await snapshot(page)).starts.length, 2);
    });

  await test('pending progress frame cannot resurrect the live tree', {},
    [{
      progress: [running(3, 1, { live_entries: ['a.txt', 'b.txt'] }), terminal('completed')],
      result: { stats: stats('completed'), root_info: { total_nodes: 3, total_chunks: 1 } },
    }], async page => {
      await start(page);
      let s = await snapshot(page);
      assert.equal(s.liveTree, false);
      // A cancelled RAF must not fire when the clock resumes after completion.
      await page.clock.runFor(5000);
      s = await snapshot(page);
      assert.equal(s.liveTree, false, 'live overlay must stay hidden after the scan ends');
      assert.equal(s.pulses, 1);
    });

  await test('cancel only requests cancellation; the scan loop renders the partial result', {},
    [holdUntilCancelScenario('cancelled')], async page => {
      await page.evaluate(({ path }) => {
        document.getElementById('scan-path').value = path;
        document.getElementById('btn-scan').click();
      }, { path: fakePath });
      await gateStep(page); // start_scan + first poll (running, held)
      await gateStep(page); // second poll (still held)
      await page.evaluate(() => document.getElementById('btn-cancel').click());
      await gateStep(page); // poll observes cancel_scan -> terminal
      await idle(page, 1);
      const s = await snapshot(page);
      const cancelCalls = s.calls.filter(c => c.command === 'cancel_scan').length;
      assert.equal(cancelCalls, 1, 'cancel handler requests cancellation exactly once');
      assert.equal(s.calls.filter(c => c.command === 'release_scan').length, 0,
        'cancel handler must not release the loader');
      assert.equal(s.scanRecords[s.starts[0].id].results, 1, 'only the scan loop fetches the result');
      assert.equal(s.state.isScanning, false);
      assert.equal(s.pulses, 0);
      assert.equal(s.dialogs.length, 0);
      assert.deepEqual(s.renders, [null, stats('cancelled')]);
      assert.match(s.status, /partial|cancel/i);
      assert.equal(s.exportDisabled, false);
      assert.equal(s.cancelDisabled, true);
      assert.equal(s.scanDisabled, false);
    }, { gate: true });

  await test('restart while scanning cancels first, then scans the new path', {},
    [holdUntilCancelScenario('cancelled'), scenario()], async page => {
      await page.evaluate(({ path }) => {
        document.getElementById('scan-path').value = path;
        document.getElementById('btn-scan').click();
      }, { path: fakePath });
      await gateStep(page); // scan 1 first poll (held)
      await gateStep(page); // scan 1 second poll (held)
      // A disabled button swallows .click(); re-enable to simulate a programmatic
      // re-trigger (e.g. tools menu) while the old loop is still winding down.
      await page.evaluate(({ path }) => {
        document.getElementById('scan-path').value = path;
        document.getElementById('btn-scan').disabled = false;
        document.getElementById('btn-scan').click();
      }, { path: secondPath });
      await gateStep(page); // scan 1 sees cancel -> terminal; restart sleep pending
      await gateStep(page); // restart wait resumes, scan 2 starts, first poll
      await gateStep(page); // scan 2 second poll -> terminal
      await gateStep(page); // any trailing sleep
      await idle(page, 2);
      const s = await snapshot(page);
      assert.equal(s.starts.length, 2);
      exactStart(s, 0, 120, false, fakePath);
      exactStart(s, 1, 120, false, secondPath);
      assert.notEqual(s.starts[0].id, s.starts[1].id);
      assert.equal(s.state.currentScanId, s.starts[1].id);
      assert.equal(s.calls.filter(c => c.command === 'cancel_scan').length, 1);
      assert.equal(s.pulses, 1, 'only the completed second scan pulses');
      assert.equal(s.exportDisabled, false);
      assert.match(s.status, TREE_STATUS_RE);
      assert.equal(s.rebuilds >= 1, true);
    }, { gate: true });

  await test('dynamic en/de locales retain timeout keys; French uses English fallback', {}, [], async page => {
    const keys = ['settings.scan_timeout', 'settings.scan_timeout_help', 'scan.timeout_help', 'scan.retry_timeout'];
    const english = await page.evaluate(keys => keys.map(window.__), keys);
    assert.equal(english[0], 'Scan idle timeout (seconds)');
    assert.match(english[1], /0 disables/);
    assert.match(english[2], /idle timeout/);
    assert.equal(english[3], 'Retry with {seconds}s timeout');
    for (const locale of ['de', 'fr', 'en', 'de']) {
      // setLocale emits once immediately and once after actual scripts finish loading.
      await page.evaluate(locale => {
        window.fixture.localeChanges = 0;
        const listener = () => {
          if (++window.fixture.localeChanges === 2) {
            window.removeEventListener('locale-changed', listener);
          }
        };
        window.addEventListener('locale-changed', listener);
        window.I18N.setLocale(locale);
      }, locale);
      await page.waitForFunction(() => window.fixture.localeChanges === 2, null, { polling: 10 });
      const values = await page.evaluate(keys => keys.map(window.__), keys);
      if (locale === 'de') {
        assert.equal(values[0], 'Scan-Leerlaufzeitlimit (Sekunden)');
        assert.match(values[1], /0 deaktiviert/);
        assert.match(values[2], /Leerlaufzeitlimits/);
        assert.equal(values[3], 'Erneut scannen mit {seconds}s Zeitlimit');
      } else {
        assert.deepEqual(values, english);
      }
      assert.equal(await page.locator('label[for="settings-scan-timeout"]').textContent(), values[0]);
      assert.equal(await page.locator('#settings-scan-timeout-help').textContent(), values[1]);
      assert.equal(await page.evaluate(() => window.I18N.getLocale().resolved), locale);
    }
    const s = await snapshot(page);
    assert.deepEqual(s.localeExecuted, ['en', 'ui-extra', 'de', 'ui-extra', 'fr', 'ui-extra']);
    assert.deepEqual(s.localeRequests.map(r => r.name), s.localeExecuted);
    for (let i = 1; i < s.localeRequests.length; i += 2) {
      assert.equal(s.localeRequests[i].executed.at(-1), s.localeRequests[i - 1].name,
        'ui-extra must not be requested until the base locale has executed');
    }
  });

  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const paths = Array.from({ length: 16 }, (_, i) => `/mock/active-${i}/${'long-folder-name/'.repeat(10)}${htmlPath}`);
    const longDiagnostic = `TIMEOUT: no work completed for 240s; active paths:\n${paths.join('\n')}`;
    const errors = [...Array.from({ length: 99 }, (_, i) => `Access denied: /mock/private-${i}`), longDiagnostic];
    await test(`${viewport.width}x${viewport.height} settings and long timeout dialog stay accessible`, {},
      [scenario('timed_out', errors), scenario()], async page => {
        await page.setViewportSize(viewport);
        await openSettings(page);
        await page.clock.runFor(300);
        const settingsCard = page.locator('#settings-overlay .overlay-card');
        const settingsBox = await accessibleBounds(settingsCard, viewport);
        assert.ok(settingsBox.height <= viewport.height * 0.9 + 2);
        await page.locator('#settings-scan-timeout').fill('240');
        await accessibleBounds(page.locator('#settings-scan-timeout'), viewport);
        await page.locator('#settings-save').scrollIntoViewIfNeeded();
        await accessibleBounds(page.locator('#settings-save'), viewport);
        await accessibleBounds(page.locator('#settings-close'), viewport);
        assert.equal(await settingsCard.evaluate(el => el.scrollHeight <= el.clientHeight || el.scrollTop > 0),
          true, 'settings footer must be reachable, scrolling only when needed');
        await page.locator('#settings-save').click();
        await openSettings(page);
        assert.equal(await page.locator('#settings-scan-timeout').inputValue(), '240');
        await page.locator('#settings-close').click();
        await start(page);
        const timedOut = await snapshot(page);
        timeoutState(timedOut);
        assert.match(timedOut.badge, /100/);
        await page.clock.runFor(300);
        const dialog = page.locator('.dlg-card');
        const dialogBox = await accessibleBounds(dialog, viewport);
        assert.ok(dialogBox.height <= viewport.height * 0.9 + 2);
        const body = page.locator('.dlg-card > div').first();
        assert.ok((await body.textContent()).includes(paths.at(-1)));
        assert.equal(await body.locator('img, script').count(), 0);
        assert.equal(await body.evaluate(el => el.scrollHeight > el.clientHeight), true, 'long diagnostics need a scrollable body');
        const retry = dialog.getByRole('button', { name: 'Retry with 480s timeout', exact: true });
        const close = dialog.getByRole('button', { name: 'Close', exact: true });
        await accessibleBounds(retry, viewport);
        await accessibleBounds(close, viewport);
        await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
        assert.equal(await body.evaluate(el => el.scrollTop > 0 && Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 1), true);
        await accessibleBounds(retry, viewport);
        await accessibleBounds(close, viewport);
        await page.clock.runFor(10000);
        assert.equal((await snapshot(page)).starts.length, 1);
        await retry.click();
        await idle(page, 2);
        const s = await snapshot(page);
        exactStart(s, 1, 480);
        assert.equal(s.settings.scan_timeout_secs, 240);
        assert.equal(s.pulses, 1);
        assert.equal(s.badge, null);
      });
  }

  await test('a retry that times out again requires a second manual decision',
    { scan_timeout_secs: 120 }, [scenario('timed_out', [diagnostic], false), scenario('timed_out', [diagnostic], false)], async page => {
      await start(page);
      await page.locator('.dlg-overlay').getByRole('button', { name: 'Retry with 240s timeout', exact: true }).click();
      await idle(page, 2);
      await page.clock.runFor(10000);
      const s = await snapshot(page);
      exactStart(s, 1, 240);
      assert.equal(s.starts.length, 2);
      assert.equal(s.dialogs.length, 2);
      assert.equal(s.pulses, 0);
      assert.equal(s.settings.scan_timeout_secs, 120);
      assert.equal(await page.locator('.dlg-overlay').getByRole('button', { name: 'Retry with 480s timeout', exact: true }).count(), 1);
      await page.keyboard.press('Escape');
      await page.clock.runFor(10000);
      assert.equal((await snapshot(page)).starts.length, 2);
    });
} finally {
  await browser.close();
}
console.log(`\n${passed} passed, ${failures.length} failed (browser-only issue #46 regression).`);
if (failures.length) process.exitCode = 1;
