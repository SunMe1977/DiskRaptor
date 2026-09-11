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
    for (let i = 0; i < 5; i++) {
      await wait(3000);
      
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
      console.log(`Check ${i + 1}:`, stateResult.result.value);
    }
    
    // Check get_scan_result for scanId 3
    const result3 = await send('Runtime.evaluate', {
      expression: `
        (async function() {
          try {
            const result = await window.__TAURI__.invoke('get_scan_result', { scanId: 3 });
            return JSON.stringify(result);
          } catch(e) {
            return JSON.stringify({ error: e.message });
          }
        })()
      `,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('Scan 3 result:', result3.result.value);
    
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
