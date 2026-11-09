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

  const notifications = () => (mobile && cap.Plugins && cap.Plugins.LocalNotifications) || null;
  let channelReady = null;

  async function notifyReady() {
    const ln = notifications();
    if (!ln) return null;
    if (!channelReady) {
      channelReady = (async () => {
        let perm = await ln.checkPermissions();
        if (perm.display !== "granted") perm = await ln.requestPermissions();
        if (perm.display !== "granted") return false;
        try {
          await ln.createChannel({ id: "todos", name: "Нужно сделать", description: "Пересылки и вопросы агентов", importance: 4, vibration: true });
        } catch { /* Android < 8 has no channels */ }
        return true;
      })().catch(() => false);
    }
    return (await channelReady) ? ln : null;
  }

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
    },
    base() { return mobile && server ? server.base : ""; },
    headers() { return mobile && server ? { "X-Agent-Desk-Key": server.key } : {}; },
    notifyPermission: notifyReady,
    /** Android notification; a tap opens the app on that reminder. */
    async notify({ id, title, body, project, todo }) {
      const ln = await notifyReady();
      if (!ln) return;
      await ln.schedule({
        notifications: [{ id: (Number(id) || Date.now()) % 2147483647, title, body: body || "", channelId: "todos", extra: { project, todo } }],
      });
    },
    onNotificationTap(cb) {
      const ln = notifications();
      ln?.addListener("localNotificationActionPerformed", (e) => {
        const x = (e && e.notification && e.notification.extra) || {};
        cb(x.project || null, Number.isInteger(x.todo) ? x.todo : null);
      });
    },
  };
})();
