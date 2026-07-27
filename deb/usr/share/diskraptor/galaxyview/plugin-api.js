/**
 * DiskRaptor — GalaxyView Plugin API
 * Extensible plugin system for celestial bodies, animations,
 * rendering techniques, overlays, and AI insight providers.
 * Every visual object is a plugin.
 */
(function () {
  "use strict";

  class PluginAPI {
    constructor(galaxyView) {
      this.gv = galaxyView;
      this.plugins = new Map();
      this.hooks = {
        beforeRender: [],
        afterRender: [],
        beforeUpdate: [],
        afterUpdate: [],
        onObjectCreated: [],
        onObjectDestroyed: [],
        onCameraMove: [],
        onScanStart: [],
        onScanProgress: [],
        onScanComplete: [],
        onInsightGenerated: [],
      };
    }

    // ── Plugin Registration ───────────────────────────────────

    /**
     * Register a plugin.
     * @param {string} name - Unique plugin name
     * @param {Object} plugin - Plugin implementation
     * @param {Object} plugin.meta - Plugin metadata
     * @param {string} plugin.meta.version - Plugin version
     * @param {string} plugin.meta.description - Description
     * @param {Function} [plugin.init] - Called when plugin is loaded
     * @param {Function} [plugin.dispose] - Called when plugin is removed
     * @param {Object} [plugin.hooks] - Hook functions
     */
    register(name, plugin) {
      if (this.plugins.has(name)) {
        console.warn(`[GalaxyView] Plugin "${name}" already registered, skipping`);
        return false;
      }

      this.plugins.set(name, plugin);

      // Register hooks
      if (plugin.hooks) {
        for (const [hookName, fn] of Object.entries(plugin.hooks)) {
          if (this.hooks[hookName] && typeof fn === "function") {
            this.hooks[hookName].push(fn);
          }
        }
      }

      // Init
      if (typeof plugin.init === "function") {
        plugin.init(this.gv, this);
      }

      // Dispatch event
      this._dispatch("plugin-registered", { name, plugin });
      return true;
    }

    /**
     * Unregister a plugin.
     * @param {string} name - Plugin name to remove
     */
    unregister(name) {
      const plugin = this.plugins.get(name);
      if (!plugin) return false;

      // Remove hooks
      if (plugin.hooks) {
        for (const [hookName, fn] of Object.entries(plugin.hooks)) {
          const idx = this.hooks[hookName]?.indexOf(fn);
          if (idx !== undefined && idx > -1) {
            this.hooks[hookName].splice(idx, 1);
          }
        }
      }

      // Dispose
      if (typeof plugin.dispose === "function") {
        plugin.dispose();
      }

      this.plugins.delete(name);
      this._dispatch("plugin-unregistered", { name });
      return true;
    }

    // ── Hook Execution ────────────────────────────────────────

    /** Run all registered beforeRender hooks */
    runHook(hookName, ...args) {
      const hooks = this.hooks[hookName];
      if (!hooks) return;
      for (const fn of hooks) {
        try { fn(...args); } catch (e) {
          console.warn(`[GalaxyView] Hook "${hookName}" error:`, e);
        }
      }
    }

    // ── Creating Custom Celestial Bodies ──────────────────────

    /**
     * Register a custom celestial body type.
     * @param {string} typeName - Unique type name
     * @param {Object} definition - Body definition
     * @param {Function} definition.create - Function to create the body: (data) => body
     * @param {Function} [definition.update] - Per-frame update: (body, time, dt) => void
     * @param {Function} [definition.render] - Custom render: (ctx, body, camera) => void
     * @param {Function} [definition.getMetadata] - Metadata for hover: (body) => string
     */
    registerBodyType(typeName, definition) {
      if (!this.gv || !this.gv.customBodyTypes) {
        if (this.gv) this.gv.customBodyTypes = new Map();
      }
      if (this.gv) {
        this.gv.customBodyTypes.set(typeName, definition);
      }
      this._dispatch("body-type-registered", { typeName, definition });
    }

    // ── Custom Animations ─────────────────────────────────────

    /**
     * Register a custom animation.
     * @param {string} name - Animation name
     * @param {Object} animation - Animation implementation
     * @param {Function} animation.animate - Apply animation: (obj, time, dt) => void
     */
    registerAnimation(name, animation) {
      if (this.gv && this.gv.customAnimations) {
        this.gv.customAnimations.set(name, animation);
      }
      this._dispatch("animation-registered", { name });
    }

    // ── Custom AI Insight Providers ───────────────────────────

    /**
     * Register an AI insight provider.
     * @param {string} name - Provider name
     * @param {Function} provider - Function that returns insights: (stats, topFiles) => [{icon, text, priority}]
     */
    registerInsightProvider(name, provider) {
      if (this.gv && this.gv.insightProviders) {
        this.gv.insightProviders.push({ name, fn: provider });
      }
      this._dispatch("insight-provider-registered", { name });
    }

    // ── State & Info ──────────────────────────────────────────

    getRegisteredPlugins() {
      const result = [];
      for (const [name, plugin] of this.plugins) {
        result.push({
          name,
          meta: plugin.meta || { version: "0.0.0" },
        });
      }
      return result;
    }

    getPlugin(name) {
      return this.plugins.get(name) || null;
    }

    hasPlugin(name) {
      return this.plugins.has(name);
    }

    // ── Internal ──────────────────────────────────────────────

    _dispatch(event, data) {
      const evt = new CustomEvent("galaxyview:" + event, {
        detail: data,
        bubbles: false,
      });
      window.dispatchEvent(evt);
    }

    dispose() {
      for (const [name] of this.plugins) {
        this.unregister(name);
      }
      this.plugins.clear();
      for (const key of Object.keys(this.hooks)) {
        this.hooks[key] = [];
      }
    }
  }

  // ── Built-in Plugins (example) ─────────────────────────────

  /** "Orbit Glow" plugin: adds extra glow to fast-orbiting objects */
  function registerBuiltinPlugins(api) {
    api.register("orbit-glow", {
      meta: {
        version: "1.0.0",
        description: "Adds extra glow to fast-orbiting celestial bodies",
      },
      init: () => {},
      hooks: {
        beforeRender: (objects, camera) => {
          for (const obj of objects) {
            if (obj.type === "moon" && obj.orbitSpeed > 0.003) {
              obj._extraGlow = obj.orbitSpeed * 50;
            }
          }
        },
      },
      dispose: () => {},
    });

    api.register("performance-monitor", {
      meta: {
        version: "1.0.0",
        description: "Shows FPS and object count overlay",
      },
      init: (gv, pluginApi) => {
        const el = document.createElement("div");
        el.className = "galaxy-perf-monitor";
        el.style.cssText =
          "position:absolute;bottom:8px;left:8px;color:rgba(255,255,255,0.5);font-size:11px;font-family:monospace;pointer-events:none;z-index:100";
        el.textContent = "FPS: -- | Objects: --";
        if (gv && gv.container) gv.container.appendChild(el);
        pluginApi._perfEl = el;
      },
      hooks: {
        afterRender: (fps, objectCount) => {
          const el = PluginAPI._perfEl;
          if (el) el.textContent = `FPS: ${fps || "--"} | Objects: ${objectCount || "--"}`;
        },
      },
      dispose: (gv, pluginApi) => {
        if (pluginApi._perfEl && pluginApi._perfEl.parentElement) {
          pluginApi._perfEl.parentElement.removeChild(pluginApi._perfEl);
        }
      },
    });
  }

  window.GalaxyView = window.GalaxyView || {};
  window.GalaxyView.PluginAPI = PluginAPI;
  window.GalaxyView.registerBuiltinPlugins = registerBuiltinPlugins;
})();
