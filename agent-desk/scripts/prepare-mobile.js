#!/usr/bin/env node
"use strict";
// Copies the shared UI (web/) into the Android app (mobile/www). The phone app talks to the PC
// over Wi-Fi, so the PC-only popup page is not needed there.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");
const WWW = path.join(ROOT, "mobile", "www");
const SKIP = new Set(["popup.html", "popup.js"]);

for (const need of ["vendor/98.css", "icons/world-0.png"]) {
  if (!fs.existsSync(path.join(WEB, need))) {
    console.error(`Нет web/${need}: сначала запустите "node scripts/fetch-assets.js".`);
    process.exit(1);
  }
}
fs.rmSync(WWW, { recursive: true, force: true });
fs.cpSync(WEB, WWW, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
console.log(`web -> ${path.relative(ROOT, WWW)}`);
