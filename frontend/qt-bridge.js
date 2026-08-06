(function () {
  "use strict";

  const bridgeReady = false;
  const isWkMode = false;
  let isTauriV2 = false;
  let pendingInvokes = [];
  let callIdCounter = 0;
  let pendingCalls = {};
  if (!window.__TAURI__) window.__TAURI__ = {};
  let tauriInvoke = (window.__TAURI__ && typeof window.__TAURI__.invoke === "function")
    ? window.__TAURI__.invoke
    : (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === "function")
      ? window.__TAURI__.core.invoke
      : null;

  // ── Initialize WKWebView message handler ────────────────────
  function init() {
    if (bridgeReady) return;

    // Check for WKWebView message handler (macOS Qt app with WKWebView)
    if (window.webkit &&
        window.webkit.messageHandlers &&
        window.webkit.messageHandlers.bridge) {
      isWkMode = true;
      bridgeReady = true;
      window.__TAURI__.__qtBridgeReady = true;
      window.dispatchEvent(new CustomEvent("tauri-bridge-ready"));
      flushPending();
      console.debug("[DiskRaptor] WKWebView bridge connected");
      return;
    }

    // Fallback: original Tauri IPC (v1 or v2)
    if (typeof tauriInvoke === "function") {
      console.debug("[DiskRaptor] Using Tauri IPC fallback");
      isTauriV2 = !!(window.__TAURI__ && window.__TAURI__.core);
      bridgeReady = true;
      if (!window.__TAURI__) window.__TAURI__ = {};
      window.__TAURI__.__qtBridgeReady = true;
      window.dispatchEvent(new CustomEvent("tauri-bridge-ready"));
      flushPending();
      return;
    }

    // Check for Tauri v2 core.invoke (withGlobalTauri: true)
    if (window.__TAURI__ && window.__TAURI__.core &&
        typeof window.__TAURI__.core.invoke === "function") {
      console.debug("[DiskRaptor] Using Tauri v2 IPC");
      isTauriV2 = true;
      tauriInvoke = window.__TAURI__.core.invoke;
      bridgeReady = true;
      window.__TAURI__.__qtBridgeReady = true;
      window.dispatchEvent(new CustomEvent("tauri-bridge-ready"));
      flushPending();
      return;
    }

    // Retry after a short delay (bridge may not be injected yet)
    if (!init._retryTimer) {
      init._retryTimer = setTimeout(function () {
        init._retryTimer = null;
        init();
      }, 100);
    }
  }

  function flushPending() {
    const q = pendingInvokes;
    pendingInvokes = [];
    q.forEach(function (fn) {
      try { fn(); } catch (e) { console.error("[DiskRaptor] Pending invoke error:", e); }
    });
  }

  // ── WKWebView IPC: send message to native, wait for response ─
  function wkInvoke(cmd, args) {
    return new Promise(function (resolve, reject) {
      const callId = "dr_" + (++callIdCounter);
      pendingCalls[callId] = { resolve: resolve, reject: reject };

      try {
        window.webkit.messageHandlers.bridge.postMessage({
          id: callId,
          cmd: cmd,
          args: args || {}
        });
      } catch (e) {
        delete pendingCalls[callId];
        reject(new Error("WKWebView IPC error: " + e.message));
      }
    });
  }

  // ── Called by native code to resolve a pending call ──────────
  window.__TAURI__._resolve = function (callId, resultJson) {
    const call = pendingCalls[callId];
    if (!call) return;
    delete pendingCalls[callId];

    try {
      const parsed = JSON.parse(resultJson);
      if (parsed && typeof parsed === "object" && parsed.hasOwnProperty("data")) {
        call.resolve(parsed.data);
      } else {
        call.resolve(parsed);
      }
    } catch (e) {
      call.resolve(resultJson);
    }
  };

  // ── Tauri-compatible invoke() ──────────────────────────────
  function invoke(cmd, args) {
    return new Promise(function (resolve, reject) {
      function doInvoke() {
        if (isWkMode) {
          wkInvoke(cmd, args).then(resolve).catch(reject);
          return;
        }

        if (typeof tauriInvoke === "function") {
          tauriInvoke(cmd, args).then(function(r) {
            if (r && typeof r === "object" && "data" in r) { resolve(r.data); }
            else { resolve(r); }
          }).catch(reject);
        } else {
          reject(new Error("No IPC bridge available: " + cmd));
        }
      }

      if (bridgeReady) {
        doInvoke();
      } else {
        pendingInvokes.push(doInvoke);
      }
    });
  }

  // ── Event system ───────────────────────────────────────────
  const eventListeners = {};

  function listen(eventName, callback) {
    if (!eventListeners[eventName]) {
      eventListeners[eventName] = [];
    }
    eventListeners[eventName].push(callback);
    return function () {
      const idx = eventListeners[eventName].indexOf(callback);
      if (idx !== -1) eventListeners[eventName].splice(idx, 1);
    };
  }

  function emit(eventName, payload) {
    const listeners = eventListeners[eventName] || [];
    listeners.forEach(function (cb) {
      try {
        cb({ payload: payload, event: eventName });
      } catch (e) {
        console.error("[DiskRaptor] Event handler error:", e);
      }
    });
  }

  // ── Listen for native events via CustomEvent ────────────────
  window.addEventListener("tauri-event", function (e) {
    if (e.detail && e.detail.type) {
      emit(e.detail.type, e.detail.payload);
    }
  });

  // ── Expose as window.__TAURI__ ─────────────────────────────
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

  console.debug("[DiskRaptor] Bridge loaded");
})();
