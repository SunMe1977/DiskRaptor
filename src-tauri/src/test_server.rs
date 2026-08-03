//! Embedded Chrome DevTools Protocol server used only by the automated UI
//! tests (`tests/run_tests.mjs`). Compiled exclusively when the `test-server`
//! feature is enabled.
#![cfg(feature = "test-server")]

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex as StdMutex;
use std::sync::{Arc, LazyLock};
use tauri::Manager;
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex as AsyncMutex;
use tokio_tungstenite::accept_async;

static CDP_RESULTS: LazyLock<StdMutex<std::collections::HashMap<String, String>>> =
    LazyLock::new(|| StdMutex::new(std::collections::HashMap::new()));

fn get_cdp_result(key: &str) -> Option<String> {
    CDP_RESULTS.lock().remove(key)
}

fn parse_cdp_value(v: &str) -> serde_json::Value {
    if let Some(inner) = v.strip_prefix("__err:") {
        return serde_json::json!({"type": "string", "value": inner});
    }
    match serde_json::from_str::<serde_json::Value>(v) {
        Ok(parsed) => serde_json::json!({"type": "object", "value": parsed}),
        Err(_) => serde_json::json!({"type": "string", "value": v}),
    }
}

async fn handle_http(stream: tokio::net::TcpStream, buf: &[u8], port: u16) {
    let req = String::from_utf8_lossy(buf);
    if req.starts_with("OPTIONS") {
        let resp = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nContent-Length: 0\r\n\r\n";
        let _ = stream.writable().await;
        let _ = stream.try_write(resp.as_bytes());
        return;
    }
    if req.starts_with("POST /cdp_result") {
        if let Some(body_start) = req.find("\r\n\r\n") {
            let body = &req[body_start + 4..];
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(body.trim()) {
                if let (Some(id), Some(value)) = (
                    data.get("id").and_then(|v| v.as_str()),
                    data.get("value").and_then(|v| v.as_str()),
                ) {
                    CDP_RESULTS.lock().insert(id.to_string(), value.to_string());
                }
            }
        }
        let resp = "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nContent-Length: 2\r\n\r\n{}";
        let _ = stream.writable().await;
        let _ = stream.try_write(resp.as_bytes());
        return;
    }
    if req.starts_with("GET /json") {
        let body = serde_json::json!([{
            "id": "page-1", "description": "", "title": "DiskRaptor",
            "type": "page", "url": "tauri://localhost",
            "webSocketDebuggerUrl": format!("ws://127.0.0.1:{}/devtools/page/page-1", port),
        }]).to_string();
        let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\n\r\n{}", body.len(), body);
        let _ = stream.writable().await;
        let _ = stream.try_write(resp.as_bytes());
    }
}

async fn handle_ws(stream: tokio::net::TcpStream, buf: Vec<u8>, addr: std::net::SocketAddr, app: tauri::AppHandle, _cdp_port: u16) {
    struct PrependReader {
        buf: Vec<u8>,
        pos: usize,
        stream: tokio::net::TcpStream,
    }
    impl tokio::io::AsyncRead for PrependReader {
        fn poll_read(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            let me = self.get_mut();
            if me.pos < me.buf.len() {
                let len = std::cmp::min(buf.remaining(), me.buf.len() - me.pos);
                buf.put_slice(&me.buf[me.pos..me.pos + len]);
                me.pos += len;
                std::task::Poll::Ready(Ok(()))
            } else {
                std::pin::Pin::new(&mut me.stream).poll_read(cx, buf)
            }
        }
    }
    impl tokio::io::AsyncWrite for PrependReader {
        fn poll_write(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &[u8],
        ) -> std::task::Poll<std::io::Result<usize>> {
            let me = self.get_mut();
            std::pin::Pin::new(&mut me.stream).poll_write(cx, buf)
        }
        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            let me = self.get_mut();
            std::pin::Pin::new(&mut me.stream).poll_flush(cx)
        }
        fn poll_shutdown(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            let me = self.get_mut();
            std::pin::Pin::new(&mut me.stream).poll_shutdown(cx)
        }
    }
    let prepend = PrependReader { buf, pos: 0, stream };
    eprintln!("[CDP] WS handshaking with {}...", addr);
    let ws = match accept_async(prepend).await {
        Ok(ws) => { eprintln!("[CDP] WS handshake OK"); ws }
        Err(e) => { eprintln!("[CDP] WS error on {}: {}", addr, e); return; }
    };
    eprintln!("[CDP] WS connected: {}", addr);
    let (write, mut read) = ws.split();
    let write = Arc::new(AsyncMutex::new(write));

    eprintln!("[CDP] WS entering message loop");
    while let Some(msg) = read.next().await {
        match msg {
            Ok(tokio_tungstenite::tungstenite::Message::Text(text)) => {
                eprintln!("[CDP] WS text msg: {} bytes", text.len());
                if let Ok(req) = serde_json::from_str::<serde_json::Value>(&text) {
                    let id = req.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
                    let method = req.get("method").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let result = match method.as_str() {
                        "Runtime.evaluate" | "Runtime.awaitPromise" => {
                            let expr = req.get("params").and_then(|p| p.get("expression"))
                                .and_then(|e| e.as_str()).unwrap_or("");
                            let await_promise = method == "Runtime.awaitPromise" || req.get("params")
                                .and_then(|p| p.get("awaitPromise")).and_then(|b| b.as_bool()).unwrap_or(false);
                            let cdp_id = format!("__cdp_{}", id);

                            if let Some(w) = app.get_webview_window("main") {
                                let ejs = format!(
                                    "try{{var r=eval({});var s=JSON.stringify(r);var x=new XMLHttpRequest();x.open('POST','http://127.0.0.1:{}/cdp_result',true);x.setRequestHeader('Content-Type','text/plain');x.send(JSON.stringify({{id:'{}',value:s}}));}}catch(e){{}}",
                                    serde_json::Value::String(expr.to_string()), _cdp_port, cdp_id
                                );
                                let _ = w.eval(&ejs).ok();
                            }

                            let mut value = serde_json::Value::Null;
                            if await_promise {
                                for _ in 0..300 {
                                    if let Some(v) = get_cdp_result(&cdp_id) {
                                        value = parse_cdp_value(&v);
                                        break;
                                    }
                                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                                }
                                if value.is_null() {
                                    value = serde_json::json!({"type": "undefined"});
                                }
                            }
                            serde_json::json!({"result": value})
                        }
                        "Page.getResourceTree" => {
                            serde_json::json!({"frameTree": {"frame": {"id": "1", "url": "tauri://localhost", "mimeType": "text/html", "securityOrigin": "tauri://localhost", "loaderId": "1"}}})
                        }
                        _ => serde_json::json!({}),
                    };
                    let resp = serde_json::json!({"id": id, "result": result});
                    let mut w = write.lock().await;
                    let _ = w.send(tokio_tungstenite::tungstenite::Message::Text(
                        serde_json::to_string(&resp).unwrap()
                    )).await;
                }
            }
            Ok(tokio_tungstenite::tungstenite::Message::Close(_)) => break,
            _ => {}
        }
    }
    eprintln!("[CDP] WS disconnected: {}", addr);
}

pub async fn cdp_server(port: u16, app: tauri::AppHandle) {
    let listener = match tokio::net::TcpListener::bind(format!("127.0.0.1:{}", port)).await {
        Ok(l) => l,
        Err(e) => { eprintln!("[CDP] Failed to listen: {}", e); return; }
    };
    eprintln!("[CDP] Listening on ws://127.0.0.1:{}/", port);

    loop {
        let (mut stream, addr) = match listener.accept().await {
            Ok(s) => s,
            Err(_) => continue,
        };

        let app_clone = app.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 8192];
            let n = match stream.read(&mut buf).await {
                Ok(n) if n > 0 => n,
                _ => return,
            };
            let buf = buf[..n].to_vec();

            let req_str = String::from_utf8_lossy(&buf);
            if req_str.starts_with("GET /json") || req_str.starts_with("POST /cdp_result") {
                handle_http(stream, &buf, port).await;
            } else if req_str.contains("Upgrade: websocket") || req_str.contains("upgrade: websocket") {
                handle_ws(stream, buf, addr, app_clone, port).await;
            } else {
                let resp = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
                let _ = stream.writable().await;
                let _ = stream.try_write(resp.as_bytes());
            }
        });
    }
}
