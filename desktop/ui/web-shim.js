/* web-shim.js — lets ui/app.js run in a plain browser.
 *
 * The Tauri build exposes window.__TAURI__ (core.invoke + event.listen).
 * This file provides a browser implementation of the same surface:
 *   - connect/send/disconnect  -> WebSocket to the soju /socket endpoint
 *   - irc-line / irc-closed    -> WebSocket message/close events
 *   - cred_*                   -> localStorage (weaker than the OS keychain)
 *   - notifications            -> Notification API
 *   - opener/autostart         -> window.open / graceful stubs
 *   - save_export              -> Blob download
 *   - deep-link                -> never fires (https invite links TBD)
 *
 * It no-ops when the real Tauri API is present, so index.html can include
 * it unconditionally.
 */
(function () {
  if (window.__TAURI__) return;

  // soju WebSocket endpoint from config.js. In dev (allowWsOverride) it can be
  // overridden with ?irc=ws://host:port/socket or localStorage "snailog.ws".
  const CONFIG = window.SNAILOG_CONFIG || {};
  const WS_URL = (CONFIG.allowWsOverride && (new URLSearchParams(location.search).get("irc")
    || localStorage.getItem("snailog.ws")))
    || CONFIG.wsUrl || "ws://127.0.0.1:16668/socket";

  let ws = null;
  const handlers = new Map();   // event name -> Set<callback>

  function emit(name, payload) {
    for (const cb of handlers.get(name) || []) {
      try { cb({ payload }); } catch (e) { console.error(e); }
    }
  }

  function connect() {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("websocket error"));
      ws.onmessage = (e) => emit("irc-line", String(e.data));
      ws.onclose = () => { ws = null; emit("irc-closed", null); };
    });
  }

  const invoke = async (cmd, args = {}) => {
    switch (cmd) {
      case "connect":
        return connect();
      case "send":
        if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("not connected");
        ws.send(args.line + "\r\n");
        return;
      case "disconnect":
        if (ws) { const w = ws; ws = null; w.onclose = null; w.close(); }
        return;
      case "cred_save":
        localStorage.setItem(`snailog.cred.${args.account}`, args.password);
        return;
      case "cred_load":
        return localStorage.getItem(`snailog.cred.${args.account}`) ?? null;
      case "cred_clear":
        localStorage.removeItem(`snailog.cred.${args.account}`);
        return;
      case "device_name":
        return `Web · ${navigator.userAgent.replace(/.*\((.*?)\).*/, "$1").slice(0, 60) || "browser"}`;
      case "launched_at_login":
        return false;
      case "save_export": {
        const blob = new Blob([args.contents], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = args.name;
        a.click();
        URL.revokeObjectURL(a.href);
        return args.name;
      }
      case "test_scenario":
        return null;
      case "test_log":
        console.debug("[e2e]", args.line);
        return;
      case "plugin:opener|open_url":
        window.open(args.url, "_blank", "noopener");
        return;
      case "plugin:opener|reveal_item_in_dir":
        return;
      case "plugin:notification|is_permission_granted":
        return typeof Notification === "undefined" ? false : Notification.permission === "granted";
      case "plugin:notification|request_permission":
        if (typeof Notification === "undefined") return "denied";
        return Notification.requestPermission();
      case "plugin:notification|notify": {
        if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
        const o = args.options || {};
        new Notification(o.title || "snailog", { body: o.body || "" });
        return;
      }
      case "plugin:autostart|is_enabled":
        return false;
      case "plugin:autostart|enable":
      case "plugin:autostart|disable":
        return;
      default:
        console.warn("[web-shim] unimplemented command:", cmd);
        return null;
    }
  };

  const listen = (name, cb) => {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name).add(cb);
    return Promise.resolve(() => handlers.get(name)?.delete(cb));
  };

  // Window management doesn't exist in a browser tab — no-op stubs.
  const appWindow = {
    unminimize: async () => {},
    show: async () => {},
    setFocus: async () => {},
    requestUserAttention: async () => {},
    outerPosition: async () => ({ x: 0, y: 0 }),
    setPosition: async () => {},
    setTitle: async (t) => { document.title = t; },
  };

  window.__TAURI__ = {
    isWebApp: true,   // lets app.js hide desktop-only settings
    core: { invoke },
    event: { listen },
    window: { getCurrentWindow: () => appWindow },
    dpi: {
      PhysicalPosition: class {
        constructor(x, y) { this.x = x; this.y = y; }
      },
    },
  };
})();
