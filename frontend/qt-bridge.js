/**
 * DiskRaptor Qt WebChannel Bridge
 * Replaces the Tauri IPC bridge for Qt 6 + QtWebEngine.
 *
 * This file provides the same window.__TAURI__ API that the existing
 * frontend code expects, but routes calls through QWebChannel to C++.
 *
 * No changes needed to the existing frontend code.
 */

(function () {
  "use strict";

  var bridge = null;
  var bridgeReady = false;
  var pendingInvokes = [];

  // ── Initialize QWebChannel ─────────────────────────────────
  function init() {
    if (typeof QWebChannel !== "undefined") {
      new QWebChannel(qt.webChannelTransport, function (channel) {
        bridge = channel.objects.bridge;
        console.log("[DiskRaptor] Qt WebChannel bridge connected");

        // Wire backend events after bridge is available.
        try {
          if (bridge && bridge.eventEmitted && bridge.eventEmitted.connect) {
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
        // Flush any pending invokes
        flushPending();
      });
    } else {
      console.warn("[DiskRaptor] QWebChannel not available (running outside Qt?)");
      // Fallback: mark bridge as ready so app.js doesn't hang forever
      setTimeout(function () {
        bridgeReady = true;
        if (window.__TAURI__) window.__TAURI__.__qtBridgeReady = true;
        window.dispatchEvent(new CustomEvent("tauri-bridge-ready"));
        flushPending();
      }, 1000);
    }
  }

  function flushPending() {
    for (var i = 0; i < pendingInvokes.length; i++) {
      try {
        pendingInvokes[i]();
      } catch (e) {
        console.error("[DiskRaptor] Pending invoke error:", e);
      }
    }
    pendingInvokes = [];
  }

  // ── Tauri-compatible invoke() ──────────────────────────────
  function invoke(cmd, args) {
    return new Promise(function (resolve, reject) {
      function doInvoke() {
        if (!bridge || typeof bridge.invoke !== "function") {
          reject(new Error("Bridge not ready: " + cmd));
          return;
        }

        try {
          var result = bridge.invoke(cmd, args || {});
          // Result is a JSON string from C++
          try {
            var parsed = JSON.parse(result);
            if (parsed.success) {
              if (typeof parsed.data === "string") {
                try {
                  var nested = JSON.parse(parsed.data);
                  resolve(nested);
                } catch {
                  resolve(parsed.data);
                }
              } else {
                resolve(parsed.data);
              }
            } else {
              reject(new Error(parsed.error || "Command failed: " + cmd));
            }
          } catch (e) {
            resolve(result);
          }
        } catch (e) {
          reject(new Error("invoke error: " + e.message));
        }
      }

      if (bridgeReady) {
        doInvoke();
      } else {
        // Queue the call — will be flushed when bridge becomes ready
        pendingInvokes.push(doInvoke);
        // Also set a safety timeout so we don't hang forever
        setTimeout(function () {
          // Remove from pending if still there
          var idx = pendingInvokes.indexOf(doInvoke);
          if (idx !== -1) pendingInvokes.splice(idx, 1);
          reject(new Error("Bridge not ready: " + cmd));
        }, 15000);
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
    console.log("[DiskRaptor] Event listener registered:", eventName);
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
  window.__TAURI__ = {
    invoke: invoke,
    __qtBridgeReady: bridgeReady,
    event: {
      listen: listen,
      emit: emit,
    },
    dialog: {
      open: function (opts) {
        return invoke("pick_directory", opts || {});
      },
    },
    events: {
      dispatchEvent: function (event) {
        emit(event.type, event.detail);
      },
      addEventListener: function (name, cb) {
        listen(name, cb);
      },
    },
  };

  // Backward compatibility for code checking typeof window.__TAURI__
  window.__TAURI_PRELOAD__ = true;

  // ── Initialize ─────────────────────────────────────────────
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  console.log("[DiskRaptor] Qt WebChannel bridge loaded");
})();
