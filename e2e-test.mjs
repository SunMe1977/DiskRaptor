import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';

const APP_DIR = path.resolve('.');
const BINARY = path.join(APP_DIR, 'target', 'release', 'diskraptor.exe');
const TEST_PORT = '9222';
let tp = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function startApp() {
  const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + TEST_PORT };
  tp = spawn(BINARY, [], { cwd: APP_DIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  tp.stderr.on('data', d => { stderr += d.toString(); });
  tp.on('exit', (code) => { if (code !== 0) console.log('  [EXIT code=' + code + ']', stderr.trim().split('\n').slice(-3).join('\n')); });
  return new Promise(r => setTimeout(r, 5000));
}
function kill() { try { if (tp) tp.kill(); } catch {} }

async function run() {
  console.log('\n  === SCAN C: DRIVE ===\n');
  await startApp();

  let browser;
  for (let i = 0; i < 30; i++) { try { browser = await chromium.connectOverCDP('http://localhost:' + TEST_PORT, { timeout: 3000 }); break; } catch { await sleep(1000); } }
  if (!browser) { console.log('  FAIL'); kill(); process.exit(1); }

  let page;
  for (let i = 0; i < 20; i++) {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) { if (p.url().includes('tauri')) { page = p; break; } }
    if (page) break; await sleep(1000);
  }
  if (!page) { console.log('  FAIL'); kill(); process.exit(1); }

  page.on('pageerror', err => console.log('  [PAGE_ERROR]', err.message));

  for (let i = 0; i < 30; i++) {
    const ok = await page.evaluate(() => typeof window.__TAURI__?.invoke === 'function').catch(() => false);
    if (ok) break; await sleep(1000);
  }

  // Scan C:\
  console.log('  Scanning C:\\ ...');
  console.log('  (this may take a while, 10min timeout)\n');
  const sid = await page.evaluate(async () => {
    const r = await window.__TAURI__.invoke('start_scan', { path: 'C:\\' });
    return r.scan_id;
  });

  let lastFiles = 0;
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    const p = await page.evaluate(async (id) => {
      try {
        const prog = await window.__TAURI__.invoke('get_scan_progress', { scanId: id });
        return { files: prog.files_found, running: prog.is_running, phase: prog.phase };
      } catch (e) { return null; }
    }, sid);
    if (!p) { console.log('\n  PROGRESS FAILED - app may have crashed'); break; }
    if (p.files !== lastFiles || i % 6 === 0) {
      console.log('  ' + ((i+1)*5) + 's: files=' + p.files + ' phase=' + p.phase + ' running=' + p.running);
      lastFiles = p.files;
    }
    if (!p.running) { console.log('\n  SCAN COMPLETED at ' + ((i+1)*5) + 's'); break; }
  }

  const result = await page.evaluate(async (id) => {
    try {
      const r = await window.__TAURI__.invoke('get_scan_result', { scanId: id });
      if (!r) return null;
      return { files: r.stats.total_files, dirs: r.stats.total_dirs, totalNodes: r.root_info.total_nodes };
    } catch (e) { return { error: String(e) }; }
  }, sid).catch(e => ({ error: 'evaluate failed: ' + e.message }));

  console.log('\n  Result:', JSON.stringify(result, null, 2));
  console.log(result && result.files ? '\n  ✅ PASSED\n' : '\n  ❌ FAILED\n');
  kill();
  try { if (browser) await browser.close(); } catch {}
  process.exit(result && result.files ? 0 : 1);
}
run();
