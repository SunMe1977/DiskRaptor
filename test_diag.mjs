import WebSocket from "ws";
import http from "http";

const PORT = parseInt(process.argv[2]) || 9235;

async function cdpFetch(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(); } });
    }).on("error", reject);
  });
}

async function main() {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const pages = await cdpFetch(`http://127.0.0.1:${PORT}/json/list`);
      if (Array.isArray(pages) && pages.length > 0 && pages[0].webSocketDebuggerUrl) {
        const wsUrl = pages[0].webSocketDebuggerUrl;
        console.log("WS URL:", wsUrl);
        const ws = new WebSocket(wsUrl);
        let msgId = 0;
        function send(method, params = {}) {
          return new Promise((resolve) => {
            const id = ++msgId;
            ws.send(JSON.stringify({ id, method, params }));
            ws.on("message", (raw) => {
              const m = JSON.parse(raw.toString());
              if (m.id === id) resolve(m);
            });
          });
        }
        await new Promise((r) => { ws.on("open", r); setTimeout(r, 5000); });
        // Check if __TAURI__ exists and invoke works
        let r = await send("Runtime.evaluate", {
          expression: "typeof window.__TAURI__ !== 'undefined' && typeof window.__TAURI__.invoke === 'function'",
          returnByValue: true, awaitPromise: false,
        });
        console.log("invoke exists:", JSON.stringify(r?.result?.result?.value));
        // Call get_home_dir and capture
        await send("Runtime.evaluate", {
          expression: "window.__TAURI__.invoke('get_home_dir',{}).then(r=>window.__diag_r=r).catch(e=>window.__diag_r='ERR:'+e.message)",
          returnByValue: false, awaitPromise: false,
        });
        await new Promise(r => setTimeout(r, 3000));
        r = await send("Runtime.evaluate", {
          expression: "typeof window.__diag_r === 'string' ? window.__diag_r : JSON.stringify(window.__diag_r)",
          returnByValue: true, awaitPromise: false,
        });
        console.log("get_home_dir result:", r?.result?.result?.value);
        ws.close();
        process.exit(0);
      }
    } catch {}
  }
  console.log("Timeout waiting for page");
  process.exit(1);
}
main();
