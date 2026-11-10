import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  runTest, jsExpr, jsInvoke, assert, sleep, waitFor,
  startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, waitForTreeReady,
} from "./test_shared.mjs";

// End-to-end regression coverage for move-to-trash: the deleted item must
// disappear from disk, the tree, the stats panel, the diagram and the
// Top-Files table — without a rescan.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dr-del-ui-"));
const fileVictim = path.join(tmp, "delete-me.txt");
const folderVictim = path.join(tmp, "folder");
const batchA = path.join(tmp, "batch-a.txt");
const batchB = path.join(tmp, "batch-b.txt");
const topVictim = path.join(tmp, "top-victim.txt");
const diagramVictim = path.join(tmp, "diagram-victim.txt");

fs.writeFileSync(path.join(tmp, "keep.txt"), "keep");
fs.writeFileSync(fileVictim, "delete me");
fs.writeFileSync(batchA, "batch a");
fs.writeFileSync(batchB, "batch b");
fs.writeFileSync(topVictim, "top victim");
fs.writeFileSync(diagramVictim, "diagram victim");
fs.mkdirSync(folderVictim);
fs.writeFileSync(path.join(folderVictim, "inner-a.txt"), "aaaa");
fs.writeFileSync(path.join(folderVictim, "inner-b.txt"), "bbbbbb");

function readJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function snapshot(cdp) {
  const raw = await jsExpr(cdp, `JSON.stringify({
    files: Number((document.getElementById('stat-files')?.textContent || '0').replace(/[^0-9]/g, '')),
    dirs: Number((document.getElementById('stat-dirs')?.textContent || '0').replace(/[^0-9]/g, '')),
    sizeText: document.getElementById('stat-size')?.textContent || '',
    rows: Array.from(document.querySelectorAll('.tree-row')).map(r => r.textContent || ''),
    topPaths: ((window.app.state.currentStats || {}).top_files || []).map(f => (typeof f === 'string' ? f : f.path)),
    diagramPaths: ((window.__diagram && window.__diagram.files) || []).map(f => f.path),
    status: (document.getElementById('tree-status') || document.querySelector('.status-bar'))?.textContent || ''
  })`);
  return readJson(raw) || {};
}

async function waitGone(cdp, check, label) {
  return waitFor(async () => check(await snapshot(cdp)), { timeout: 8000, label });
}

runTest("DiskRaptor Delete Refresh Test", 9285, async (cdp) => {
  let previousConfirm;
  try {
    previousConfirm = await jsInvoke(cdp, `window.__TAURI__.invoke('load_settings', {})`);
    await jsInvoke(cdp, `window.__TAURI__.invoke('save_settings', { settings: { confirm_delete: false } })`);

    await startScan(cdp, tmp);
    await waitForOverlay(cdp);
    const { completed } = await waitForScanComplete(cdp);
    assert("Scan completed", completed);
    await waitForStatsPopulated(cdp);
    await waitForTreeReady(cdp);

    const before = await snapshot(cdp);
    assert("Initial tree lists all entries", before.rows.length >= 8, `rows=${before.rows.length}`);
    assert("Initial stats count files", before.files === 8, `files=${before.files}`);
    assert("Initial stats count dirs", before.dirs === 2, `dirs=${before.dirs}`);

    // 1) Tree single-file delete -------------------------------------------
    const rc = await jsExpr(cdp, `
      (function() {
        const row = Array.from(document.querySelectorAll('.tree-row'))
          .find(r => r.textContent.includes('delete-me.txt'));
        if (!row) return 'not-found';
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 120 }));
        return 'ok';
      })()
    `);
    assert("Context menu opened on file row", rc === "ok", rc);
    await sleep(250);
    await jsExpr(cdp, `document.querySelector('#tree-context-menu [data-action="delete"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); 'clicked'`);

    const fileGone = await waitGone(cdp, s => s.files === 7 && !s.rows.join("|").includes("delete-me.txt"), "file delete");
    assert("Deleted file left the disk", !fs.existsSync(fileVictim));
    assert("Tree/stats updated after file delete", fileGone);
    const afterFile = await snapshot(cdp);
    assert("Top-Files dropped deleted file", !afterFile.topPaths.join("|").includes("delete-me.txt"));
    assert("Diagram dropped deleted file", !afterFile.diagramPaths.join("|").includes("delete-me.txt"));
    assert("Status confirms move to trash", /trash|papierkorb/i.test(afterFile.status), afterFile.status);

    // 2) Tree folder delete -------------------------------------------------
    await jsExpr(cdp, `
      (function() {
        const row = Array.from(document.querySelectorAll('.tree-row'))
          .find(r => r.textContent.includes('folder'));
        if (!row) return 'not-found';
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 120 }));
        return 'ok';
      })()
    `);
    await sleep(250);
    await jsExpr(cdp, `document.querySelector('#tree-context-menu [data-action="delete"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); 'clicked'`);

    const folderGone = await waitGone(cdp, s => s.files === 5 && s.dirs === 1, "folder delete");
    assert("Deleted folder left the disk", !fs.existsSync(folderVictim));
    assert("Tree/stats updated after folder delete", folderGone);
    const afterFolder = await snapshot(cdp);
    assert("Folder delete removed inner files from Top-Files",
      !afterFolder.topPaths.join("|").includes("inner-"));
    assert("Folder delete removed inner files from diagram",
      !afterFolder.diagramPaths.join("|").includes("inner-"));

    // 3) Batch tree delete --------------------------------------------------
    const batchStarted = await jsExpr(cdp, `
      (function() {
        const tv = window.__treeView;
        if (!tv) return 'no-tree';
        const idxs = [];
        const nodes = tv.loader.allNodes || [];
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          if (n && (n.name === 'batch-a.txt' || n.name === 'batch-b.txt')) idxs.push(i);
        }
        if (idxs.length < 2) return 'nodes-not-found';
        tv.selectedIndices = idxs;
        tv._handleDeleteMany();
        return 'ok';
      })()
    `);
    assert("Batch delete started", batchStarted === "ok", batchStarted);
    const batchGone = await waitGone(cdp, s => s.files === 3, "batch delete");
    assert("Batch files left the disk", !fs.existsSync(batchA) && !fs.existsSync(batchB));
    assert("Tree/stats updated after batch delete", batchGone);

    // 4) Top-Files row delete ----------------------------------------------
    await jsExpr(cdp, `
      (function() {
        const tbody = document.getElementById('topfiles-body');
        if (!tbody) return 'no-tbody';
        const row = Array.from(tbody.querySelectorAll('tr'))
          .find(r => r.textContent.includes('top-victim'));
        if (!row) return 'not-found';
        const btn = row.querySelector('button');
        if (!btn) return 'no-button';
        btn.click();
        return 'ok';
      })()
    `);
    const topGone = await waitGone(cdp, s => !s.topPaths.join("|").includes("top-victim"), "topfiles delete");
    assert("Top-Files row delete removed the file from disk", !fs.existsSync(topVictim));
    assert("Top-Files row delete refreshed the table", topGone);

    // 5) Diagram context-menu delete ---------------------------------------
    const diagStarted = await jsExpr(cdp, `
      (function() {
        const dg = window.__diagram;
        if (!dg) return 'no-diagram';
        const file = (dg.files || []).find(f => f.path.includes('diagram-victim'));
        if (!file) return 'file-not-in-diagram';
        dg._contextHit = { path: file.path, size: file.size };
        const fakeTarget = { closest: function() { return { dataset: { action: 'delete' } }; } };
        dg._onContextMenuAction({ target: fakeTarget });
        return 'ok';
      })()
    `);
    assert("Diagram delete started", diagStarted === "ok", diagStarted);
    const diagGone = await waitGone(cdp, s => !s.diagramPaths.join("|").includes("diagram-victim"), "diagram delete");
    assert("Diagram delete removed the file from disk", !fs.existsSync(diagramVictim));
    assert("Diagram delete refreshed the diagram", diagGone);
    const finalSnap = await snapshot(cdp);
    assert("Final stats only contain the kept file", finalSnap.files === 1, `files=${finalSnap.files}`);
    assert("Final tree only contains the kept file",
      finalSnap.rows.length === 2 && finalSnap.rows.join("|").includes("keep.txt"),
      `rows=${finalSnap.rows.length}`);
  } finally {
    try {
      const restore = previousConfirm && previousConfirm.confirm_delete;
      if (typeof restore === "boolean") {
        await jsInvoke(cdp, `window.__TAURI__.invoke('save_settings', { settings: { confirm_delete: ${restore} } })`);
      }
    } catch { /* ignore */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
