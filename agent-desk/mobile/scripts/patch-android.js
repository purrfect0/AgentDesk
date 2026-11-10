#!/usr/bin/env node
"use strict";
// Runs after "cap add android":
//  - lets the app talk to the PC over plain http on the home Wi-Fi (the PC has no TLS certificate;
//    the pairing key protects the requests);
//  - declares the background watcher (mobile/native/java/WatchService.java: a foreground service
//    that waits for alerts from the PC, also with the screen off) and its start after a reboot;
//  - copies the native code (mobile/native: full screen, Win98 notifications) and makes the
//    resources it needs from the web files: res/font (the 98.css pixel font and our Cyrillic) and
//    res/raw/ad_chime.wav (the app's own chime instead of the phone's notification sound);
//  - sets the version.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const APP = path.join(__dirname, "..", "android", "app");
const RES = path.join(APP, "src", "main", "res");
const WEB = path.join(__dirname, "..", "..", "web");
const NATIVE = path.join(__dirname, "..", "native");
const manifestFile = path.join(APP, "src", "main", "AndroidManifest.xml");
const gradleFile = path.join(APP, "build.gradle");
const version = require("../package.json").version;
const { appId } = require("../capacitor.config.json");
const code = Number(process.env.VERSION_CODE || process.env.GITHUB_RUN_NUMBER || 1);

if (!fs.existsSync(manifestFile)) {
  console.error("Нет android/: сначала выполните \"npx cap add android\".");
  process.exit(1);
}

let manifest = fs.readFileSync(manifestFile, "utf8");
if (!manifest.includes("usesCleartextTraffic")) {
  manifest = manifest.replace(/<application\b/, '<application\n        android:usesCleartextTraffic="true"');
}
const PERMISSIONS = [
  "POST_NOTIFICATIONS",
  "FOREGROUND_SERVICE", // the background watcher
  "FOREGROUND_SERVICE_SPECIAL_USE",
  "WAKE_LOCK", // keeps the CPU and Wi-Fi awake for the open request
  "RECEIVE_BOOT_COMPLETED", // the watcher starts again after a reboot
  "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS", // Android's "let the app run in the background?" question
];
for (const p of PERMISSIONS) {
  if (!manifest.includes(`"android.permission.${p}"`)) {
    manifest = manifest.replace(/<\/manifest>\s*$/, `    <uses-permission android:name="android.permission.${p}" />\n</manifest>\n`);
  }
}
if (!manifest.includes("com.google.mlkit.vision.DEPENDENCIES")) {
  // QR pairing: Google Play services downloads the code-scanner UI together with the app.
  manifest = manifest.replace(/<\/application>/, '    <meta-data android:name="com.google.mlkit.vision.DEPENDENCIES" android:value="barcode_ui" />\n    </application>');
}
if (!manifest.includes(".WatchService")) {
  manifest = manifest.replace(/<\/application>/, `    <service
            android:name="${appId}.WatchService"
            android:exported="false"
            android:foregroundServiceType="specialUse">
            <property
                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
                android:value="Keeps the Wi-Fi connection to the user's own PC open to show the alerts of its AI agents" />
        </service>
        <receiver android:name="${appId}.BootReceiver" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
                <action android:name="android.intent.action.QUICKBOOT_POWERON" />
            </intent-filter>
        </receiver>
    </application>`);
}
fs.writeFileSync(manifestFile, manifest);

// Native code: mobile/native/java -> the app package (replaces the generated MainActivity),
// mobile/native/res -> res.
const javaDir = path.join(APP, "src", "main", "java", ...appId.split("."));
fs.mkdirSync(javaDir, { recursive: true });
for (const f of fs.readdirSync(path.join(NATIVE, "java"))) fs.copyFileSync(path.join(NATIVE, "java", f), path.join(javaDir, f));
if (fs.existsSync(path.join(NATIVE, "res"))) fs.cpSync(path.join(NATIVE, "res"), RES, { recursive: true });

/** WOFF 1.0 -> sfnt (TrueType/OpenType): the same tables, each unpacked if it was zlib-packed. */
function woffToSfnt(woff) {
  if (woff.toString("latin1", 0, 4) !== "wOFF") throw new Error("не WOFF 1.0");
  const n = woff.readUInt16BE(12);
  const tables = [];
  for (let i = 0; i < n; i++) {
    const at = 44 + i * 20;
    const offset = woff.readUInt32BE(at + 4);
    const packed = woff.readUInt32BE(at + 8);
    const size = woff.readUInt32BE(at + 12);
    const raw = woff.subarray(offset, offset + packed);
    const data = packed < size ? zlib.inflateSync(raw) : raw;
    if (data.length !== size) throw new Error("битая таблица шрифта");
    tables.push({ tag: woff.subarray(at, at + 4), sum: woff.readUInt32BE(at + 16), data });
  }
  tables.sort((a, b) => Buffer.compare(a.tag, b.tag)); // looked up by binary search
  const sel = Math.floor(Math.log2(n));
  const range = 2 ** sel * 16;
  const head = Buffer.alloc(12 + n * 16);
  head.writeUInt32BE(woff.readUInt32BE(4), 0); // flavor
  head.writeUInt16BE(n, 4);
  head.writeUInt16BE(range, 6);
  head.writeUInt16BE(sel, 8);
  head.writeUInt16BE(n * 16 - range, 10);
  const parts = [head];
  let pos = head.length;
  tables.forEach((t, i) => {
    const rec = 12 + i * 16;
    t.tag.copy(head, rec);
    head.writeUInt32BE(t.sum, rec + 4);
    head.writeUInt32BE(pos, rec + 8);
    head.writeUInt32BE(t.data.length, rec + 12);
    const pad = (4 - (t.data.length % 4)) % 4;
    parts.push(t.data, Buffer.alloc(pad));
    pos += t.data.length + pad;
  });
  return Buffer.concat(parts);
}

// Fonts of the Win98 notifications (Win98Notice.java): Latin from 98.css, Cyrillic from
// scripts/make-font.js. Android reads only TrueType/OpenType, the web files are WOFF.
const FONTS = {
  w98: "vendor/ms_sans_serif.woff",
  w98_bold: "vendor/ms_sans_serif_bold.woff",
  ad_cyrillic: "fonts/ad-cyrillic.woff",
  ad_cyrillic_bold: "fonts/ad-cyrillic-bold.woff",
};
fs.mkdirSync(path.join(RES, "font"), { recursive: true });
for (const [name, file] of Object.entries(FONTS)) {
  const sfnt = woffToSfnt(fs.readFileSync(path.join(WEB, file)));
  const ext = sfnt.readUInt32BE(0) === 0x4f54544f ? "otf" : "ttf"; // "OTTO": CFF outlines
  fs.writeFileSync(path.join(RES, "font", `${name}.${ext}`), sfnt);
}

/**
 * The app's chime (chime() in web/app.js: triangle tones 880 Hz and 1318.5 Hz 0.12 s later, each
 * up in 20 ms and down by 0.5 s) as a 16-bit mono WAV. The notification channel plays it, so the
 * phone sounds like Agent Desk and not like the phone's default notification.
 */
function chimeWav() {
  const rate = 44100;
  const len = Math.round(rate * 0.7);
  const pcm = Buffer.alloc(len * 2);
  for (let i = 0; i < len; i++) {
    const t = i / rate;
    let v = 0;
    for (const [f, dt] of [[880, 0], [1318.5, 0.12]]) {
      const u = t - dt;
      if (u < 0 || u > 0.55) continue;
      const g = u < 0.02 ? 1e-4 * (0.4 / 1e-4) ** (u / 0.02) : u < 0.5 ? 0.4 * (1e-4 / 0.4) ** ((u - 0.02) / 0.48) : 1e-4;
      v += g * (4 * Math.abs(((u * f) % 1) - 0.5) - 1);
    }
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "latin1");
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8, "latin1");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "latin1");
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
fs.mkdirSync(path.join(RES, "raw"), { recursive: true });
fs.writeFileSync(path.join(RES, "raw", "ad_chime.wav"), chimeWav());

let gradle = fs.readFileSync(gradleFile, "utf8");
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${code}`).replace(/versionName\s+"[^"]*"/, `versionName "${version}"`);
fs.writeFileSync(gradleFile, gradle);
console.log(`android: Wi-Fi без TLS, фоновая служба, нативный код, шрифты и звук Win98, версия ${version} (${code})`);
