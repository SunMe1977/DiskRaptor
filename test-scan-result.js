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
    // Call get_scan_progress via Tauri
    const progressResult = await send('Runtime.evaluate', {
      expression: `
        (async function() {
          try {
            const result = await window.__TAURI__.invoke('get_scan_progress', { scanId: 1 });
            return JSON.stringify(result);
          } catch(e) {
            return JSON.stringify({ error: e.message });
          }
        })()
      `,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('Scan progress:', progressResult.result.value);
    
    // Call get_scan_result via Tauri
    const resultResult = await send('Runtime.evaluate', {
      expression: `
        (async function() {
          try {
            const result = await window.__TAURI__.invoke('get_scan_result', { scanId: 1 });
            return JSON.stringify(result);
          } catch(e) {
            return JSON.stringify({ error: e.message });
          }
        })()
      `,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('Scan result:', resultResult.result.value);
    
    // Check for errors in the UI
    const errorCheck = await send('Runtime.evaluate', {
      expression: `
        (function() {
          try {
            const errBadge = document.getElementById('scan-error-badge');
            const errorDisplay = document.getElementById('error-display');
            return JSON.stringify({
              errorBadge: errBadge ? errBadge.textContent : 'not found',
              errorDisplay: errorDisplay ? errorDisplay.textContent : 'not found'
            });
          } catch(e) {
            return JSON.stringify({ error: e.message });
          }
        })()
      `,
      returnByValue: true
    });
    console.log('Errors:', errorCheck.result.value);
    
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
