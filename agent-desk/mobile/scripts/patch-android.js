#!/usr/bin/env node
"use strict";
// Runs after "cap add android": lets the app talk to the PC over plain http on the home Wi-Fi
// (the PC has no TLS certificate; the pairing key protects the requests) and sets the version.
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
fs.writeFileSync(manifestFile, manifest);

let gradle = fs.readFileSync(gradleFile, "utf8");
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${code}`).replace(/versionName\s+"[^"]*"/, `versionName "${version}"`);
fs.writeFileSync(gradleFile, gradle);
console.log(`android: cleartext в Wi-Fi разрешён, версия ${version} (${code})`);
