#!/usr/bin/env node
"use strict";
// Runs after "cap add android": lets the app talk to the PC over plain http on the home Wi-Fi
// (the PC has no TLS certificate; the pairing key protects the requests), copies the native code
// of the app (mobile/native: full screen) and sets the version.
const fs = require("node:fs");
const path = require("node:path");

const APP = path.join(__dirname, "..", "android", "app");
const manifestFile = path.join(APP, "src", "main", "AndroidManifest.xml");
const gradleFile = path.join(APP, "build.gradle");
const version = require("../package.json").version;
const code = Number(process.env.VERSION_CODE || process.env.GITHUB_RUN_NUMBER || 1);

if (!fs.existsSync(manifestFile)) {
  console.error("Нет android/: сначала выполните \"npx cap add android\".");
  process.exit(1);
}

let manifest = fs.readFileSync(manifestFile, "utf8");
if (!manifest.includes("usesCleartextTraffic")) {
  manifest = manifest.replace(/<application\b/, '<application\n        android:usesCleartextTraffic="true"');
}
if (!manifest.includes("android.permission.POST_NOTIFICATIONS")) {
  manifest = manifest.replace(/<\/manifest>\s*$/, '    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n</manifest>\n');
}
if (!manifest.includes("com.google.mlkit.vision.DEPENDENCIES")) {
  // QR pairing: Google Play services downloads the code-scanner UI together with the app.
  manifest = manifest.replace(/<\/application>/, '    <meta-data android:name="com.google.mlkit.vision.DEPENDENCIES" android:value="barcode_ui" />\n    </application>');
}
fs.writeFileSync(manifestFile, manifest);

// Native code: mobile/native/java -> the app package (replaces the generated MainActivity),
// mobile/native/res -> res.
const NATIVE = path.join(__dirname, "..", "native");
const { appId } = require("../capacitor.config.json");
const javaDir = path.join(APP, "src", "main", "java", ...appId.split("."));
fs.mkdirSync(javaDir, { recursive: true });
for (const f of fs.readdirSync(path.join(NATIVE, "java"))) fs.copyFileSync(path.join(NATIVE, "java", f), path.join(javaDir, f));
if (fs.existsSync(path.join(NATIVE, "res"))) fs.cpSync(path.join(NATIVE, "res"), path.join(APP, "src", "main", "res"), { recursive: true });

let gradle = fs.readFileSync(gradleFile, "utf8");
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${code}`).replace(/versionName\s+"[^"]*"/, `versionName "${version}"`);
fs.writeFileSync(gradleFile, gradle);
console.log(`android: cleartext в Wi-Fi разрешён, нативный код скопирован, версия ${version} (${code})`);
