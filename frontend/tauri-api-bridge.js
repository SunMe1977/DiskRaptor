/**
 * Minimal Tauri IPC bridge.
 *
 * Tauri v1.8 on this platform does NOT automatically inject the full
 * IPC bridge into the global __TAURI__ object. Only the low-level
 * IPC primitive (__TAURI_IPC__) and asset helpers are available.
 *
 * This module implements invoke() and dialog.open() using the
 * window.__TAURI_IPC__() function that IS injected by the runtime.
 */
(function () {
  "use strict";

  // If the full bridge is already available, skip
  if (window.__TAURI__ && typeof window.__TAURI__.invoke === "function") {
    window.dispatchEvent(new CustomEvent("tauri-bridge-ready"));
    return;
  }

  // Check that the low-level IPC function is available
  if (typeof window.__TAURI_IPC__ !== "function") {
    console.error("Tauri IPC: __TAURI_IPC__ not available");
    window.dispatchEvent(new CustomEvent("tauri-bridge-ready"));
    return;
  }

  // Get the transformCallback from window.__TAURI__ if available
  var _transformCallback = window.__TAURI__
    ? window.__TAURI__.transformCallback
    : null;

  // Replicate the transformCallback from tauri.js if not already available
  if (typeof _transformCallback !== "function") {
    _transformCallback = function (callback, once) {
      var identifier = window.crypto.getRandomValues(new Uint32Array(1))[0];
      var prop = "_" + identifier;
      Object.defineProperty(window, prop, {
        value: function (result) {
          if (once) {
            delete window[prop];
          }
          if (typeof callback === "function") {
            callback(result);
          }
        },
        writable: false,
        configurable: true,
      });
      return identifier;
    };
  }

  // ConvertFileSrc from __TAURI__ if available
  var _convertFileSrc = window.__TAURI__
    ? window.__TAURI__.convertFileSrc
    : null;

  // Implementation of invoke() using the standard Tauri v1 IPC protocol.
  // This matches how the official @tauri-apps/api v1.x implements it.
  function invoke(cmd, args) {
    args = args || {};
    return new Promise(function (resolve, reject) {
      var callback = _transformCallback(function (result) {
        resolve(result);
        // Clean up the error callback property
        try {
          delete window["_" + error];
        } catch (e) {}
      }, true);

      var error = _transformCallback(function (errResult) {
        reject(errResult);
        // Clean up the callback property
        try {
          delete window["_" + callback];
        } catch (e) {}
      }, true);

      // Build message with args merged at top level
      var message = {
        cmd: cmd,
        callback: callback,
        error: error,
      };
      if (typeof args === "object" && args !== null) {
        var argKeys = Object.keys(args);
        for (var ki = 0; ki < argKeys.length; ki++) {
          var k = argKeys[ki];
          message[k] = args[k];
        }
      }
      // Debug log first few invocations
      if (typeof window.__TAURI__LOG_COUNT === "undefined") {
        window.__TAURI__LOG_COUNT = 0;
      }
      if (window.__TAURI__LOG_COUNT < 5) {
        console.log(
          "[IPC] invoke",
          cmd,
          "args:",
          JSON.stringify(args),
          "msg:",
          JSON.stringify(message),
        );
        window.__TAURI__LOG_COUNT++;
      }
      window.__TAURI_IPC__(message);
    });
  }

  // Simple dialog open using invoke
  function dialogOpen(options) {
    var args = options || {};
    return invoke("plugin:dialog|open", args).catch(function (e) {
      console.error("Dialog open failed:", e);
      // Try alternative: maybe dialog is available directly
      if (window.__TAURI__ && window.__TAURI__.dialog && window.__TAURI__.dialog.open !== dialogOpen) {
        console.log("Falling back to native dialog.open");
        return window.__TAURI__.dialog.open(options);
      }
      // Try alternative command format
      console.log("Trying 'tauri' plugin command...");
      return invoke("tauri", { cmd: "openDialog", options: options || {} });
    });
  }

  // Store on __TAURI__
  if (!window.__TAURI__) {
    window.__TAURI__ = {};
  }
  window.__TAURI__.invoke = invoke;
  window.__TAURI__.dialog = {
    open: dialogOpen,
  };

  console.log("Tauri IPC bridge initialised via __TAURI_IPC__");

  // Signal that the bridge is ready
  window.dispatchEvent(new CustomEvent("tauri-bridge-ready"));
})();
