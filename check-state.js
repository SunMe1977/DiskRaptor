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
    const result = await send('Runtime.evaluate', {
      expression: `
        (function() {
          try {
            return JSON.stringify({
              isScanning: window.app && window.app.state && window.app.state.isScanning,
              currentScanId: window.app && window.app.state && window.app.state.currentScanId,
              hasResult: !!(window.app && window.app.state && window.app.state.currentScanResult),
              tauriAvailable: typeof window.__TAURI__ !== 'undefined',
              tauriInvokeAvailable: typeof window.__TAURI__ !== 'undefined' && typeof window.__TAURI__.invoke === 'function',
              i18nAvailable: typeof window.I18N !== 'undefined',
              treeViewExists: typeof window.treeView !== 'undefined',
              scanModuleExists: typeof window.app !== 'undefined' && typeof window.app.initScan === 'function'
            });
          } catch(e) {
            return JSON.stringify({ error: e.message });
          }
        })()
      `,
      returnByValue: true
    });
    console.log('App state:', result.result.value);
    
    // Check for console messages
    const logs = await send('Runtime.getConsoleLogs');
    if (logs && logs.result) {
      console.log('Console logs:', JSON.stringify(logs.result, null, 2));
    }
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
  console.error('Timeout waiting for WebSocket');
  ws.close();
  process.exit(1);
}, 5000);
