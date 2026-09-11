const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/C0EFFEED56E915AE214FA7F1E86B8122');

let msgId = 1;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

ws.on('open', async () => {
  try {
    // Call the frontend initScan function directly
    const initResult = await send('Runtime.evaluate', {
      expression: `
        (async function() {
          try {
            if (typeof window.app !== 'undefined' && typeof window.app.initScan === 'function') {
              const refs = {
                loader: { clear: function() {} },
                treeView: { render: function() {} },
                diagram: { render: function() {} },
                topFiles: { render: function() {} },
                statsPanel: { render: function() {} },
                scanPath: document.getElementById('scan-path'),
                btnBrowse: document.getElementById('btn-browse'),
                btnScan: document.getElementById('btn-scan'),
                btnRescan: document.getElementById('btn-rescan'),
                btnCancel: document.getElementById('btn-cancel'),
                btnExport: document.getElementById('btn-export'),
                progressOverlay: document.getElementById('progress-overlay'),
                progressPath: document.getElementById('progress-path'),
                chkFollow: document.getElementById('chk-follow'),
                errDisplay: document.getElementById('error-display'),
                hideWelcome: function() {},
                sleep: function(ms) { return new Promise(r => setTimeout(r, ms)); }
              };
              await window.app.initScan(refs);
              return JSON.stringify({ success: true });
            }
            return JSON.stringify({ success: false, reason: 'initScan not found' });
          } catch(e) {
            return JSON.stringify({ success: false, error: e.message, stack: e.stack });
          }
        })()
      `,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('Init scan result:', initResult.result.value);
    
    await wait(5000);
    
    const stateResult = await send('Runtime.evaluate', {
      expression: `
        (function() {
          try {
            const state = window.app && window.app.state;
            return JSON.stringify({
              currentScanId: state && state.currentScanId,
              isScanning: state && state.isScanning,
              hasResult: !!(state && state.currentScanResult)
            });
          } catch(e) {
            return JSON.stringify({ error: e.message });
          }
        })()
      `,
      returnByValue: true
    });
    console.log('State after initScan:', stateResult.result.value);
    
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    ws.close();
    process.exit(0);
  }
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
});

ws.on('error', (e) => {
  console.error('WebSocket error:', e.message);
  process.exit(1);
});

setTimeout(() => {
  console.error('Timeout');
  ws.close();
  process.exit(1);
}, 30000);
