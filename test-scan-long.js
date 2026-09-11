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
    // Check state multiple times
    for (let i = 0; i < 10; i++) {
      await wait(2000);
      
      const stateResult = await send('Runtime.evaluate', {
        expression: `
          (function() {
            try {
              const state = window.app && window.app.state;
              const progressOverlay = document.getElementById('progress-overlay');
              const progressPath = document.getElementById('progress-path');
              return JSON.stringify({
                isScanning: state && state.isScanning,
                currentScanId: state && state.currentScanId,
                hasResult: !!(state && state.currentScanResult),
                progressOverlayActive: progressOverlay ? getComputedStyle(progressOverlay).display : 'not found',
                progressPathText: progressPath ? progressPath.textContent : 'not found'
              });
            } catch(e) {
              return JSON.stringify({ error: e.message });
            }
          })()
        `,
        returnByValue: true
      });
      console.log(`Check ${i + 1}:`, stateResult.result.value);
      
      // Also check if there are any console errors
      const consoleLogs = await send('Runtime.evaluate', {
        expression: `
          (function() {
            try {
              const logs = window.__consoleErrors || [];
              return JSON.stringify(logs.slice(-5));
            } catch(e) {
              return JSON.stringify({ error: e.message });
            }
          })()
        `,
        returnByValue: true
      });
      if (consoleLogs.result.value && consoleLogs.result.value !== '[]') {
        console.log('Console logs:', consoleLogs.result.value);
      }
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
  console.error('Timeout');
  ws.close();
  process.exit(1);
}, 30000);
