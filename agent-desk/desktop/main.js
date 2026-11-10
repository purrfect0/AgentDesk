"use strict";
// Agent Desk for Windows: the board core (core/desk.js) runs inside the app; the window, tray
// icon and Win98-style popups are Electron. Installed by the NSIS setup (npm run dist:win).
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, dialog, shell, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { Desk } = require("../core/desk.js");

const TITLE = "Agent Desk";
const WEB = path.join(__dirname, "..", "web");
const ICON = path.join(__dirname, process.platform === "win32" ? "icon.ico" : "icon.png");
const HIDDEN = process.argv.includes("--hidden");
const MAX_POPUPS = 4;
const POPUP = { w: 340, h: 146, gap: 8 };

let desk = null;
let win = null;
let tray = null;
let quitting = false;
let boundLan = null;
const popups = []; // newest first: index 0 is the lowest popup, the others stack above it

app.setAppUserModelId("app.agentdesk.desktop");
if (!app.requestSingleInstanceLock()) {
  app.quit(); // the running copy shows its window (second-instance below)
} else {
  app.on("second-instance", () => showMain());
  app.whenReady().then(boot).catch((e) => fatal("Не удалось запустить Agent Desk", e.stack || String(e)));
}

function fatal(title, text) {
  dialog.showErrorBox(title, text);
  app.exit(1);
}

const base = () => `http://127.0.0.1:${desk.boundPort}/`;
const ours = (url) => typeof url === "string" && desk && url.startsWith(base());

async function boot() {
  Menu.setApplicationMenu(null);
  desk = new Desk({ webDir: WEB });
  try {
    await desk.start();
  } catch (e) {
    if (e.code === "EADDRINUSE") {
      return fatal(`Порт ${desk.port} занят`,
        `Agent Desk не может запуститься: порт ${desk.port} уже занят.\n\n`
        + "Скорее всего, запущен старый Agent Board (Python). Закройте его (значок в трее → Выход, или pythonw.exe в диспетчере задач) "
        + "и уберите его из автозагрузки, затем запустите Agent Desk снова. Данные Agent Board перенесутся сами.");
    }
    throw e;
  }
  boundLan = desk.lanEnabled;
  desk.on("alert", (a) => {
    if (!desk.config.notify) return; // PC popups are off; the phone still gets the alert (GET /api/alerts)
    try { showPopup(a); } catch (e) { desk.log("popup failed:", e.message); }
    if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true); // the taskbar button blinks
  });
  desk.on("show", ({ project, todo }) => showMain(project, todo));
  desk.on("config", onConfig);
  desk.on("change", updateTray);
  applyAutostart();
  createTray();
  createWindow();
}

// --- main window -------------------------------------------------------------------

const boundsFile = () => path.join(app.getPath("userData"), "window.json");

function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), "utf8"));
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width - 50 && b.x + b.width > a.x + 50 && b.y >= a.y - 10 && b.y < a.y + a.height - 50;
    });
    return visible ? b : null;
  } catch {
    return null;
  }
}

function saveBounds() {
  if (!win || win.isDestroyed() || win.isMaximized() || win.isMinimized()) return;
  try {
    fs.writeFileSync(boundsFile(), JSON.stringify(win.getBounds()));
  } catch { /* not important */ }
}

const webPreferences = () => ({
  preload: path.join(__dirname, "preload.js"),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  spellcheck: false,
  autoplayPolicy: "no-user-gesture-required",
});

function guard(contents) {
  // Only our own pages inside the app; other links open in the browser.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (e, url) => {
    if (!ours(url)) e.preventDefault();
  });
}

function createWindow() {
  const b = loadBounds();
  win = new BrowserWindow({
    width: b?.width || 960, height: b?.height || 660, x: b?.x, y: b?.y,
    minWidth: 420, minHeight: 320, frame: false, roundedCorners: false, show: false, title: TITLE, icon: ICON,
    backgroundColor: "#c0c0c0", webPreferences: webPreferences(),
  });
  guard(win.webContents);
  win.on("focus", () => win.flashFrame(false));
  win.loadURL(`${base()}#native`);
  win.once("ready-to-show", () => { if (!HIDDEN) win.show(); });
  win.on("close", (e) => {
    saveBounds();
    if (!quitting) {
      e.preventDefault(); // closing hides: the app keeps running in the tray to show popups
      win.hide();
    }
  });
  const sendMax = () => win.webContents.send("maximized", win.isMaximized());
  win.on("maximize", sendMax);
  win.on("unmaximize", sendMax);
  win.on("resized", saveBounds);
  win.on("moved", saveBounds);
  win.webContents.on("render-process-gone", () => { if (!quitting) win.reload(); });
}

function showMain(project, todo) {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (project || Number.isInteger(todo)) {
    const js = `window.abFocus && window.abFocus(${JSON.stringify(project || null)}, ${Number.isInteger(todo) ? todo : "null"})`;
    win.webContents.executeJavaScript(js).catch(() => {});
  }
}

// --- tray --------------------------------------------------------------------------

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON));
  tray.on("click", () => showMain());
  rebuildTrayMenu();
  updateTray();
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Открыть Agent Desk", click: () => showMain() },
    { type: "separator" },
    { label: "Всплывающие окна", type: "checkbox", checked: !!desk.config.notify, click: (i) => setConfig({ notify: i.checked }) },
    { label: "Запускать вместе с Windows", type: "checkbox", checked: !!desk.config.autostart, click: (i) => setConfig({ autostart: i.checked }) },
    { type: "separator" },
    { label: "Выход", click: () => quit() },
  ]));
}

function updateTray() {
  if (!tray) return;
  const open = desk.state.todos.filter((t) => !t.done_at && !(t.kind === "forward" && t.forwarded_at)).length;
  tray.setToolTip(open ? `${TITLE} — нужно сделать: ${open}` : `${TITLE} — всё под контролем`);
}

function setConfig(patch) {
  const r = desk._updateConfig(patch, { local: true });
  if (r.code) desk.log("config:", r.body.error);
}

// --- settings that the app applies ---------------------------------------------------

function applyAutostart() {
  if (!app.isPackaged) return; // never register electron.exe from a dev checkout
  app.setLoginItemSettings({ openAtLogin: !!desk.config.autostart, args: ["--hidden"] });
}

async function onConfig() {
  applyAutostart();
  rebuildTrayMenu();
  if (desk.lanEnabled !== boundLan) {
    // Wi-Fi access on/off: listen again on the same port (127.0.0.1 only, or the whole network).
    try {
      await desk.stop();
      await desk.start();
      boundLan = desk.lanEnabled;
    } catch (e) {
      dialog.showErrorBox("Agent Desk", `Не удалось перезапустить сервер: ${e.message}`);
    }
  }
}

// --- popups (Win98 message boxes in the corner, like the Python version) -------------

// Like the Windows 11 notification stack: the newest popup appears at the bottom and pushes the
// older ones up; each one leaves by itself after 20 s (popup.js), the rest slide down.
const popupArea = () => screen.getPrimaryDisplay().workArea;
const popupY = (i) => { const a = popupArea(); return a.y + a.height - (POPUP.h + POPUP.gap) * (i + 1) - 4; };

function glide(p, y) {
  if (p.isDestroyed()) return;
  clearInterval(p.glideTimer);
  const [x, from] = p.getPosition();
  if (from === y) return;
  const t0 = Date.now();
  const ms = 220;
  p.glideTimer = setInterval(() => {
    if (p.isDestroyed()) return clearInterval(p.glideTimer);
    const k = Math.min(1, (Date.now() - t0) / ms);
    const ease = 1 - (1 - k) ** 3;
    p.setBounds({ x, y: Math.round(from + (y - from) * ease), width: POPUP.w, height: POPUP.h });
    if (k >= 1) clearInterval(p.glideTimer);
  }, 15);
}

function restack() {
  popups.forEach((p, i) => glide(p, popupY(i)));
}

/** Plays the leave animation in the popup, then closes it (also if the page does not answer). */
function dismiss(p) {
  const i = popups.indexOf(p);
  if (i >= 0) popups.splice(i, 1);
  restack();
  if (p.isDestroyed() || p.leaving) return;
  p.leaving = true;
  p.webContents.send("popup-leave");
  setTimeout(() => { if (!p.isDestroyed()) p.destroy(); }, 700);
}

function showPopup(alert) {
  if (!desk.config.notify) return;
  while (popups.length >= MAX_POPUPS) dismiss(popups[popups.length - 1]);
  const area = popupArea();
  const p = new BrowserWindow({
    x: area.x + area.width - POPUP.w - 12,
    y: popupY(0),
    width: POPUP.w, height: POPUP.h, frame: false, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, show: false, title: `${TITLE} — ${alert.project || ""}`,
    icon: ICON, transparent: true, backgroundColor: "#00000000", hasShadow: false, roundedCorners: false,
    webPreferences: webPreferences(),
  });
  p.setAlwaysOnTop(true, "pop-up-menu");
  p.agentAlert = alert;
  guard(p.webContents);
  const q = new URLSearchParams({
    id: String(alert.id), sound: desk.config.popup_sound !== false ? "1" : "0", volume: String(desk.config.popup_volume ?? 80),
  });
  p.loadURL(`${base()}popup.html?${q}`);
  p.once("ready-to-show", () => p.showInactive()); // does not steal focus from the chat being typed in
  p.on("closed", () => {
    clearInterval(p.glideTimer);
    const i = popups.indexOf(p);
    if (i >= 0) { popups.splice(i, 1); restack(); }
  });
  popups.unshift(p);
  restack();
}

// --- IPC from preload.js -------------------------------------------------------------

function senderWindow(e) {
  if (!ours(e.senderFrame?.url)) return null;
  return BrowserWindow.fromWebContents(e.sender);
}

ipcMain.on("win", (e, what) => {
  const w = senderWindow(e);
  if (!w) return;
  if (what === "minimize") w.minimize();
  else if (what === "close") w.close();
  else if (what === "quit") quit();
});
ipcMain.handle("win-toggle-maximize", (e) => {
  const w = senderWindow(e);
  if (!w) return false;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
  return w.isMaximized();
});
ipcMain.handle("win-resize", (e, width, height) => {
  const w = senderWindow(e);
  if (!w || w !== win || !Number.isFinite(width) || !Number.isFinite(height)) return;
  const [minW, minH] = w.getMinimumSize();
  const [x, y] = w.getPosition();
  w.setBounds({ x, y, width: Math.max(minW, Math.round(width)), height: Math.max(minH, Math.round(height)) });
});
ipcMain.on("win-title", (e, title) => {
  const w = senderWindow(e);
  if (w === win) win.setTitle(String(title).slice(0, 100));
});
// QR code of the pairing link for the "Connect phone" dialog (SVG, black squares on white).
ipcMain.handle("qr", async (e, text) => {
  if (senderWindow(e) !== win || typeof text !== "string" || text.length > 500) return null;
  return require("qrcode").toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
});
ipcMain.on("popup", (e, what) => {
  const w = senderWindow(e);
  if (!w || !w.agentAlert) return;
  if (what === "open") showMain(w.agentAlert.project, w.agentAlert.todo);
  if (what === "gone") w.destroy(); // the leave animation has finished
  else dismiss(w);
});

// --- quit ------------------------------------------------------------------------------

function quit() {
  quitting = true;
  app.quit();
}

app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => { /* keep running in the tray */ });
let stopped = false;
app.on("will-quit", (e) => {
  if (stopped || !desk) return;
  e.preventDefault();
  stopped = true;
  desk.stop().catch(() => {}).finally(() => app.quit());
});
