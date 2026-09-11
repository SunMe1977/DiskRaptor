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
    // Click the scan button
    const clickResult = await send('Runtime.evaluate', {
      expression: `
        (function() {
          try {
            const btnScan = document.getElementById('btn-scan');
            if (btnScan) {
              btnScan.click();
              return JSON.stringify({ clicked: true, buttonText: btnScan.textContent });
            }
            return JSON.stringify({ clicked: false, reason: 'btn-scan not found' });
          } catch(e) {
            return JSON.stringify({ clicked: false, error: e.message });
          }
        })()
      `,
      returnByValue: true
    });
    console.log('Click result:', clickResult.result.value);
    
    // Wait a bit for scan to start
    await new Promise(r => setTimeout(r, 3000));
    
    // Check state after scan start
    const stateResult = await send('Runtime.evaluate', {
      expression: `
        (function() {
          try {
            return JSON.stringify({
              isScanning: window.app && window.app.state && window.app.state.isScanning,
              currentScanId: window.app && window.app.state && window.app.state.currentScanId,
              hasResult: !!(window.app && window.app.state && window.app.state.currentScanResult),
              scanPath: document.getElementById('scan-path') ? document.getElementById('scan-path').value : 'not found'
            });
          } catch(e) {
            return JSON.stringify({ error: e.message });
          }
        })()
      `,
      returnByValue: true
    });
    console.log('State after click:', stateResult.result.value);
    
    // Check for errors
    const errors = await send('Runtime.evaluate', {
      expression: `
        (function() {
          try {
            const errDisplay = document.getElementById('error-display');
            return JSON.stringify({
              errorDisplayText: errDisplay ? errDisplay.textContent : 'not found',
              errorDisplayVisible: errDisplay ? getComputedStyle(errDisplay).display : 'n/a'
            });
          } catch(e) {
            return JSON.stringify({ error: e.message });
          }
        })()
      `,
      returnByValue: true
    });
    console.log('Error display:', errors.result.value);
    
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
}, 10000);
