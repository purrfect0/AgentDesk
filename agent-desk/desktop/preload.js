"use strict";
// The only bridge between the pages and the app: window controls and popup buttons.
// The pages get no Node.js access (contextIsolation + sandbox).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentDesk", {
  desktop: true,
  minimize: () => ipcRenderer.send("win", "minimize"),
  toggleMaximize: () => ipcRenderer.invoke("win-toggle-maximize"),
  close: () => ipcRenderer.send("win", "close"),
  quit: () => ipcRenderer.send("win", "quit"),
  resize: (width, height) => ipcRenderer.invoke("win-resize", Number(width), Number(height)),
  setTitle: (title) => ipcRenderer.send("win-title", String(title)),
  popup: (what) => ipcRenderer.send("popup", ["open", "gone"].includes(what) ? what : "close"),
  onPopupLeave: (cb) => ipcRenderer.on("popup-leave", () => cb()),
  qr: (text) => ipcRenderer.invoke("qr", String(text)),
  onMaximized: (cb) => ipcRenderer.on("maximized", (_e, value) => cb(!!value)),
});
