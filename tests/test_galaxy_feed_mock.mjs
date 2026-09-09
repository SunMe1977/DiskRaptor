// Browser-only reproduction: full app.js + real index.html + galaxy bundle,
// with a mocked Tauri bridge. Verifies that clicking Galaxy after a scan feeds
// scan data (empty state hidden, canvas + shaded planets present).
/* global window, document, getComputedStyle */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const FRONTEND = new URL('../frontend/', import.meta.url);
const DIST = new URL('../frontend-dist/', import.meta.url);

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chromium', headless: true });

async function run(root, label) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.addInitScript(() => {
    const invoke = async (cmd, args) => {
      switch (cmd) {
        case 'load_settings': return {};
        case 'save_settings': return true;
        case 'list_drives': return [];
        case 'get_home_dir': return 'C:\\Users\\test';
        case 'get_app_info': return { version: '1.0.27', name: 'DiskRaptor', os: 'windows', arch: 'x64' };
        case 'get_app_version': return { version: '1.0.27', name: 'DiskRaptor' };
        case 'is_sandboxed': return { sandboxed: false };
        case 'get_app_data_dir': return { path: 'C:\\appdata' };
        case 'get_autostart': return false;
        case 'set_autostart': return true;
        case 'get_memory_info': return {};
        case 'get_process_memory': return {};
        case 'set_locale': return true;
        case 'get_system_locale': return 'en';
        case 'list_disks': return [];
        case 'get_dir_stats': return { total_files: 0, total_size: 0 };
        case 'get_scan_progress': return { is_running: false, phase: 3 };
        case 'get_scan_result': return null;
        case 'get_chunk': return null;
        case 'get_children': return null;
        case 'get_stats': return null;
        case 'list_downloads_candidates': return [];
        case 'check_for_updates': return null;
        case 'list_apfs_volumes': return [];
        case 'list_trash': return [];
        case 'request_permissions': return { permissions: 'ok' };
        case 'get_trash_path': return 'C:\\trash';
        default: return null;
      }
    };
    window.__TAURI__ = {
      invoke,
      core: { invoke },
      path: { homeDir: async () => 'C:\\Users\\test' },
      event: { listen: async () => () => {}, once: async () => () => {}, emit: async () => {} },
      app: { getVersion: async () => '1.0.27' },
      window: { getCurrent: () => ({ onResized: () => () => {} }) },
    };
  });

  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    try {
      const body = await readFile(new URL(path, root), 'utf8');
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
      const contentType = ext === 'js' || ext === 'mjs' ? 'application/javascript'
        : ext === 'css' ? 'text/css' : ext === 'html' ? 'text/html' : 'text/plain';
      return route.fulfill({ contentType, body });
    } catch (e) {
      return route.fulfill({ status: 404, body: 'not found: ' + path });
    }
  });

  await page.goto('https://galaxy.test/');
  await page.waitForFunction(() => window.app && window.app.state, null, { timeout: 20000 });

  // Inject a completed-scan result (mimics what scan.js sets).
  await page.evaluate(() => {
    const stats = {
      total_files: 25, total_dirs: 6, total_size: 5e8, scan_time_ms: 100,
      top_files: [
        { path: 'C:/Photos/a.jpg', size: 4e8 },
        { path: 'C:/Photos/b.jpg', size: 5e7 },
        { path: 'C:/Code/x.js', size: 1e6 },
      ],
      file_type_breakdown: [], termination: 'completed',
    };
    window.app.state.currentStats = stats;
    window.app.state.currentScanResult = { stats, root_info: { total_nodes: 30, total_chunks: 1 } };
  });

  // Click the Galaxy diagram-mode button (real handler).
  await page.evaluate(() => {
    const btn = document.querySelector('.diagram-mode[data-mode="galaxy"]');
    btn.click();
  });

  await page.waitForTimeout(2500);

  const result = await page.evaluate(() => {
    const gc = document.getElementById('galaxy-container');
    const empty = gc ? gc.querySelector('.galaxy-empty') : null;
    const canvas = gc ? gc.querySelector('canvas.galaxy-canvas') : null;
    let nonBlank = false;
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      const ctx = canvas.getContext('2d');
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 8 || d[i + 1] > 8 || d[i + 2] > 8) { nonBlank = true; break; }
      }
    }
    return {
      emptyDisplay: empty ? getComputedStyle(empty).display : 'no-empty-el',
      canvasCount: gc ? gc.querySelectorAll('canvas.galaxy-canvas').length : 0,
      canvasSize: canvas ? (canvas.width + 'x' + canvas.height) : 'none',
      nonBlank,
      hasNamespace: !!(window.GalaxyView && window.GalaxyView.GalaxyView),
    };
  });

  console.log(`${label}:`, JSON.stringify(result));
  console.log(`${label} errors:`, JSON.stringify(errors.slice(0, 40), null, 2));
  assert.equal(result.emptyDisplay, 'none', `${label}: empty state must be hidden after feeding scan data`);
  assert.ok(result.canvasCount > 0, `${label}: galaxy canvas must exist`);
  assert.ok(result.nonBlank, `${label}: galaxy canvas must be rendered (non-blank)`);
  const fatal = errors.filter(e => /GalaxyView init failed|Galaxy scripts not loaded/.test(e));
  assert.deepEqual(fatal, [], `${label}: no fatal galaxy init errors`);

  // Close (blank the canvas first so a re-render is detectable), then reopen.
  await page.evaluate(() => {
    const gc = document.getElementById('galaxy-container');
    const canvas = gc && gc.querySelector('canvas.galaxy-canvas');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    const close = document.getElementById('g-close');
    if (close) close.click();
  });
  await page.waitForTimeout(200);
  const closedDisplay = await page.evaluate(() => {
    const gc = document.getElementById('galaxy-container');
    return gc ? getComputedStyle(gc).display : 'none';
  });
  assert.equal(closedDisplay, 'none', `${label}: close (✖) must hide the galaxy`);

  await page.evaluate(() => document.querySelector('.diagram-mode[data-mode="galaxy"]').click());
  await page.waitForTimeout(2500);
  const reopened = await page.evaluate(() => {
    const gc = document.getElementById('galaxy-container');
    const canvas = gc ? gc.querySelector('canvas.galaxy-canvas') : null;
    let nonBlank = false;
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      const ctx = canvas.getContext('2d');
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 8 || d[i + 1] > 8 || d[i + 2] > 8) { nonBlank = true; break; }
      }
    }
    return { display: gc ? getComputedStyle(gc).display : 'none', nonBlank };
  });
  assert.notEqual(reopened.display, 'none', `${label}: reopen must show the galaxy again`);
  assert.ok(reopened.nonBlank, `${label}: reopen must re-render the galaxy (render loop restarted)`);

  await page.close();
}

try {
  await run(FRONTEND, 'source (frontend)');
  await run(DIST, 'bundle (frontend-dist)');
  console.log('\nPASS: scan -> galaxy click feeds data and renders planets');
} finally {
  await browser.close();
}
