// DiskRaptor scan debug script
// Launches app with CDP and checks bridge status + scan functionality
const http = require('http');
const { execSync, spawn } = require('child_process');
const path = require('path');

const APPDIR = 'C:\\Program Files\\DiskRaptor';
const LAUNCHER = path.join(APPDIR, 'DiskRaptorLauncher.exe');
const CDP_PORT = 9222;

async function getCDPPage() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const pages = JSON.parse(data);
          if (pages.length > 0) resolve(pages[0]);
          else reject(new Error('No pages'));
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function sendCDPCommand(wsUrl, cmd) {
  const WebSocket = require('ws');
  const ws = new WebSocket(wsUrl);
  return new Promise((resolve, reject) => {
    const id = 1;
    ws.on('open', () => {
      ws.send(JSON.stringify({ id, method: cmd, params: {} }));
    });
    ws.on('message', data => {
      const resp = JSON.parse(data.toString());
      if (resp.id === id) {
        ws.close();
        resolve(resp);
      }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Timeout')), 5000);
  });
}

async function main() {
  console.log('=== DiskRaptor Scan Debug ===');
  
  // Kill existing
  try { execSync('taskkill /f /im DiskRaptor.exe 2>nul & taskkill /f /im DiskRaptorLauncher.exe 2>nul & taskkill /f /im QtWebEngineProcess.exe 2>nul'); } catch(e) {}
  
  await new Promise(r => setTimeout(r, 2000));
  
  // Launch
  const proc = spawn(LAUNCHER, [], { 
    env: { ...process.env, QTWEBENGINE_REMOTE_DEBUGGING: String(CDP_PORT) },
    stdio: 'pipe'
  });
  
  console.log('Launched, waiting 15s for startup...');
  await new Promise(r => setTimeout(r, 15000));
  
  if (proc.exitCode !== null) {
    console.log(`Launcher exited with code ${proc.exitCode}`);
    return;
  }
  
  // Check CDP
  try {
    const page = await getCDPPage();
    console.log(`CDP connected: "${page.title}"`);
    
    // First, check console
    const enableResult = await sendCDPCommand(page.webSocketDebuggerUrl, 'Console.enable');
    console.log('Console enabled:', JSON.stringify(enableResult));
    
    // Check if __TAURI__ exists
    const check = await sendCDPCommand(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression: 'JSON.stringify({ hasTauri: !!window.__TAURI__, hasInvoke: !!(window.__TAURI__ && window.__TAURI__.invoke), bridgeReady: !!(window.__TAURI__ && window.__TAURI__.__qtBridgeReady) })'
    });
    console.log('Bridge status:', check.result?.value);
    
    // List drives
    const drives = await sendCDPCommand(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression: 'window.__TAURI__.invoke("list_drives").then(r => JSON.stringify(r)).catch(e => "ERROR: " + e.toString())'
    });
    console.log('list_drives result:', drives.result?.value);
    
    // Test scan path
    const scanPath = await sendCDPCommand(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression: 'document.getElementById("scan-path") ? document.getElementById("scan-path").value : "NO INPUT"'
    });
    console.log('Scan path value:', scanPath.result?.value);
    
    // Check for any errors
    console.log('Stderr output:', proc.stderr.read()?.toString() || '(none)');
    
  } catch(e) {
    console.log('CDP Error:', e.message);
  }
  
  // Cleanup
  try { execSync('taskkill /f /im DiskRaptor.exe 2>nul & taskkill /f /im DiskRaptorLauncher.exe 2>nul'); } catch(e) {}
}

main().catch(console.error);