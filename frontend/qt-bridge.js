/**
 * DiskRaptor Qt WebChannel Bridge
 * Provides the same window.__TAURI__ API that the existing
 * frontend code expects, but routes calls through QWebChannel to C++.
 *
 * When QWebChannel is not available (Tauri standalone mode),
 * the existing Tauri IPC invoke is left intact.
 *
 * Queues invoke() calls until the bridge is ready to avoid
 * "Bridge not ready" race conditions on startup.
 */

(function () {
  "use strict";

  var bridge = null;
  var bridgeReady = false;
  var isQtMode = false;
  var initStartedAt = Date.now();
  var maxInitWaitMs = 60000;
  var initRetryTimer = null;
  var pendingInvokes = [];
  var tauriInvoke = (window.__TAURI__ && typeof window.__TAURI__.invoke === "function")
    ? window.__TAURI__.invoke
    : null;

  // ── Initialize QWebChannel ─────────────────────────────────
  function init() {
    if (bridgeReady) {
      return;
    }

    var hasQWebChannel = typeof QWebChannel !== "undefined";
    var hasQtTransport =
      typeof qt !== "undefined" &&
      qt &&
      qt.webChannelTransport;

    // In Qt mode, qwebchannel.js can load before qt.webChannelTransport is ready.
    // Retry for a short window instead of falling through to a broken state.
    if (hasQWebChannel && hasQtTransport) {
      try {
        isQtMode = true;
        new QWebChannel(qt.webChannelTransport, function (channel) {
          bridge = channel.objects.bridge;
          console.log("[DiskRaptor] Qt WebChannel bridge connected");

          // Wire backend events after bridge is available.
          try {
            if (bridge && typeof bridge.eventEmitted === "object" && typeof bridge.eventEmitted.connect === "function") {
              bridge.eventEmitted.connect(function (eventName, payload) {
                emit(eventName, payload);
              });
            }
          } catch (e) {
            console.log("[DiskRaptor] Event signal not available:", e.message);
          }

          // Signal ready
          bridgeReady = true;
          window.__TAURI__.__qtBridgeReady = true;
          window.dispatchEvent(new CustomEvent("tauri-bridge-ready"));
          flushPending();
        });
      } catch (e) {
        console.warn("[DiskRaptor] QWebChannel init failed, retrying:", e.message);
        if (Date.now() - initStartedAt < maxInitWaitMs) {
          if (!initRetryTimer) {
            initRetryTimer = setTimeout(function () {
              initRetryTimer = null;
              init();
            }, 100);
          }
        }
      }
    } else {
      // In Tauri mode (no Qt WebChannel), fall back immediately if
      // the low-level Tauri IPC exists — don't wait 60 seconds.
      if (typeof tauriInvoke === "function") {
        console.warn("[DiskRaptor] Qt transport unavailable; falling back to Tauri invoke");
        bridgeReady = true;
        if (!window.__TAURI__) window.__TAURI__ = {};
        window.__TAURI__.__qtBridgeReady = true;
        window.dispatchEvent(new CustomEvent("tauri-bridge-ready"));
        flushPending();
        return;
      }

      // No Tauri IPC either — keep retrying for Qt transport up to maxInitWaitMs
      if (Date.now() - initStartedAt < maxInitWaitMs) {
        if (!initRetryTimer) {
          initRetryTimer = setTimeout(function () {
            initRetryTimer = null;
            init();
          }, 100);
        }
        return;
      }

      console.error("[DiskRaptor] Qt transport unavailable and no Tauri fallback; keeping bridge pending");
    }
  }

  function flushPending() {
    var q = pendingInvokes;
    pendingInvokes = [];
    q.forEach(function (fn) {
      try { fn(); } catch (e) { console.error("[DiskRaptor] Pending invoke error:", e); }
    });
  }

  // ── Robust data extraction ────────────────────────────────
  // Handles all possible return formats from the C++ bridge
  function extractData(raw) {
    // Already an object with progress fields
    if (raw && typeof raw === 'object' && (raw.files_found !== undefined || raw.filesFound !== undefined)) {
      return raw;
    }
    // String — try to parse as JSON
    if (typeof raw === 'string') {
      try {
        var p = JSON.parse(raw);
        if (p && p.success) {
          // p.data might be object or string
          if (p.data && typeof p.data === 'object') {
            // Already has progress fields
            if (p.data.files_found !== undefined || p.data.filesFound !== undefined) {
              return p.data;
            }
            // p.data might contain another level (double-wrapping)
            if (p.data.data && typeof p.data.data === 'object') {
              return p.data.data;
            }
            // Return p.data as-is
            return p.data;
          }
          // p.data is a string — parse again
          if (typeof p.data === 'string') {
            try { return JSON.parse(p.data); } catch { return p.data; }
          }
        }
        // No success wrapper — return parsed object directly
        return p;
      } catch {}
    }
    // Object with success wrapper but no data field
    if (raw && typeof raw === 'object' && raw.success) {
      return raw.data || raw;
    }
    return raw;
  }

  // ── Tauri-compatible invoke() ──────────────────────────────
  // In Qt mode: routes through QWebChannel bridge to C++
  // In Tauri mode: falls through to the original Tauri IPC invoke
  function invoke(cmd, args) {
    return new Promise(function (resolve, reject) {
      function doInvoke() {
        // Qt mode — use the QWebChannel bridge
        if (isQtMode) {
          if (!bridge || typeof bridge.invoke !== "function") {
            // Re-queue until channel object is actually available.
            pendingInvokes.push(doInvoke);
            if (!initRetryTimer) {
              initRetryTimer = setTimeout(function () {
                initRetryTimer = null;
                init();
              }, 100);
            }
            return;
          }
          try {
            var prom = bridge.invoke(cmd, args || {});
            if (prom && typeof prom.then === 'function') {
              prom.then(function(result) {
                try {
                  var parsed = JSON.parse(result);
                  if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "data")) {
                    resolve(parsed.data);
                  } else {
                    resolve(parsed);
                  }
                } catch(e) {
                  resolve(result);
                }
              }).catch(function(e) { reject(e); });
            } else {
              try {
                var parsedSync = JSON.parse(prom);
                if (parsedSync && typeof parsedSync === "object" && Object.prototype.hasOwnProperty.call(parsedSync, "data")) {
                  resolve(parsedSync.data);
                } else {
                  resolve(parsedSync);
                }
              } catch(e) {
                resolve(prom);
              }
            }
          } catch (e) {
            reject(new Error("invoke error: " + e.message));
          }
          return;
        }

        // Tauri mode — use the original Tauri IPC invoke
        if (typeof tauriInvoke === "function") {
          try {
            tauriInvoke(cmd, args).then(resolve).catch(reject);
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error("No IPC bridge available: " + cmd));
        }
      }

      if (bridgeReady) {
        doInvoke();
      } else {
        // Queue the call — flushed when bridge becomes ready
        pendingInvokes.push(doInvoke);
      }
    });
  }

  // ── Event system ───────────────────────────────────────────
  var eventListeners = {};

  function listen(eventName, callback) {
    if (!eventListeners[eventName]) {
      eventListeners[eventName] = [];
    }
    eventListeners[eventName].push(callback);
  }

  function emit(eventName, payload) {
    var listeners = eventListeners[eventName] || [];
    listeners.forEach(function (cb) {
      try {
        cb({ payload: payload, event: eventName });
      } catch (e) {
        console.error("[DiskRaptor] Event handler error:", e);
      }
    });
  }

  // ── Expose as window.__TAURI__ ─────────────────────────────
  // Preserve existing properties (like invoke from tauri-api-bridge.js)
  if (!window.__TAURI__) {
    window.__TAURI__ = {};
  }
  window.__TAURI__.invoke = invoke;
  window.__TAURI__.__qtBridgeReady = bridgeReady;
  window.__TAURI__.event = window.__TAURI__.event || {
    listen: listen,
    emit: emit,
  };
  if (!window.__TAURI__.dialog) {
    window.__TAURI__.dialog = {
      open: function (opts) {
        return invoke("pick_directory", opts || {});
      },
    };
  }
  window.__TAURI__.events = window.__TAURI__.events || {
    dispatchEvent: function (event) {
      emit(event.type, event.detail);
    },
    addEventListener: function (name, cb) {
      listen(name, cb);
    },
  };

  window.__TAURI_PRELOAD__ = true;

  // ── Initialize ─────────────────────────────────────────────
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  console.log("[DiskRaptor] Qt WebChannel bridge loaded");
})();
