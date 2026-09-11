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

ws.on('open', async () => {
  try {
    // Check active_scan_id and running state via a custom Tauri command
    // Actually, let me just check what the frontend thinks
    const stateResult = await send('Runtime.evaluate', {
      expression: `
        (function() {
          try {
            const state = window.app && window.app.state;
            return JSON.stringify({
              currentScanId: state && state.currentScanId,
              isScanning: state && state.isScanning,
              currentStats: state && state.currentStats,
              lastFilesFound: state && state.lastFilesFound,
              lastDirsFound: state && state.lastDirsFound
            });
          } catch(e) {
            return JSON.stringify({ error: e.message });
          }
        })()
      `,
      returnByValue: true
    });
    console.log('Frontend state:', stateResult.result.value);
    
    // Try to call start_scan again to see what happens
    const startResult = await send('Runtime.evaluate', {
      expression: `
        (async function() {
          try {
            const result = await window.__TAURI__.invoke('start_scan', {
              path: 'C:\\Users\\hansj',
              followSymlinks: false,
              timeoutSecs: 30
            });
            return JSON.stringify(result);
          } catch(e) {
            return JSON.stringify({ error: e.message });
          }
        })()
      `,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('Start scan result:', startResult.result.value);
    
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
}, 15000);
