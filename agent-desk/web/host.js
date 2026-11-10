"use strict";
// Where the UI runs:
//  - desktop: the Windows app (Electron); desktop/preload.js gives window.agentDesk;
//  - mobile:  the Android app (Capacitor); the UI is inside the app and talks to the PC over Wi-Fi;
//  - browser: a phone browser opened by the pairing link (same origin, cookie).
(() => {
  const cap = window.Capacitor;
  const mobile = !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());
  const desktop = window.agentDesk || null;
  const STORE = "ad.server";

  let server = null;
  try {
    server = JSON.parse(localStorage.getItem(STORE) || "null");
  } catch { /* broken value: ask again */ }
  if (!server || typeof server.base !== "string" || typeof server.key !== "string") server = null;

  /** "http://192.168.1.5:8098/?key=..." (also inside other text) -> {base, key} or null. */
  function parseLink(text) {
    const s = String(text || "").trim();
    const m = /https?:\/\/\S+/i.exec(s);
    let u;
    try {
      u = new URL(m ? m[0] : `http://${s}`);
    } catch {
      return null;
    }
    const key = u.searchParams.get("key") || "";
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key) || !u.hostname) return null;
    return { base: `${u.protocol}//${u.host}`, key };
  }

  // Capacitor puts every native plugin of the app into Capacitor.Plugins.
  const plugin = (name) => (mobile && cap.Plugins && cap.Plugins[name]) || null;

  /** Android 13+: the "allow notifications?" question. True when notifications may be shown. */
  async function notifyPermission() {
    const ln = plugin("LocalNotifications");
    if (!ln) return false;
    try {
      let perm = await ln.checkPermissions();
      if (perm.display !== "granted") perm = await ln.requestPermissions();
      return perm.display === "granted";
    } catch {
      return false;
    }
  }

  // The background watcher of the phone app (mobile/native/java: WatchService, AgentDeskPlugin):
  // a foreground service keeps one request to the PC open, also with the screen off, and shows each
  // alert as a Win98-style notification with the app's own chime.
  const native = () => plugin("AgentDesk");
  const watch = {
    get available() { return !!native(); },
    /** Starts the watcher for the paired PC (after a new pairing it switches to the new PC). */
    async start() {
      if (!native() || !server) return null;
      await notifyPermission();
      return native().start({ base: server.base, key: server.key });
    },
    async stop() { return native() ? native().stop() : null; },
    /** {enabled, running, lastOk, lastError, notifications, unrestricted} or null outside the app. */
    async status() { return native() ? native().status() : null; },
    /** A sample notification after `delay` seconds: turn the screen off and wait for it. */
    async test(delay = 10) { return native() ? native().test({ delay }) : null; },
    async openBattery() { return native() ? native().openBatterySettings() : null; },
    async openApp() { return native() ? native().openAppSettings() : null; },
    async openNotifications() { return native() ? native().openNotificationSettings() : null; },
  };

  window.AD_HOST = {
    kind: desktop ? "desktop" : mobile ? "mobile" : "browser",
    desktop,
    get server() { return server; },
    parseLink,
    setServer(s) {
      server = { base: s.base, key: s.key };
      localStorage.setItem(STORE, JSON.stringify(server));
    },
    forgetServer() {
      server = null;
      localStorage.removeItem(STORE);
      watch.stop().catch(() => {});
    },
    base() { return mobile && server ? server.base : ""; },
    headers() { return mobile && server ? { "X-Agent-Desk-Key": server.key } : {}; },
    notifyPermission,
    watch,
    /** A tap on a phone notification opens the app on that reminder: cb(project, todoId). */
    onNotificationTap(cb) {
      native()?.addListener("tap", (e) => {
        const todo = e && Number.isInteger(e.todo) && e.todo >= 0 ? e.todo : null;
        cb((e && e.project) || null, todo);
      });
    },
  };
})();
