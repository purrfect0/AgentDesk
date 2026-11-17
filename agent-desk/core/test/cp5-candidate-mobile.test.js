"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const QRCode = require("qrcode");

const { Desk, VERSION, parseMarker } = require("../desk.js");

const AGENT_DESK_ROOT = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(AGENT_DESK_ROOT, "..");

function makeTmpDir(prefix = "ad-cp5-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function woffToSfnt(woff) {
  assert.equal(woff.toString("latin1", 0, 4), "wOFF");
  const n = woff.readUInt16BE(12);
  const tables = [];
  for (let i = 0; i < n; i++) {
    const at = 44 + i * 20;
    const offset = woff.readUInt32BE(at + 4);
    const packed = woff.readUInt32BE(at + 8);
    const size = woff.readUInt32BE(at + 12);
    const raw = woff.subarray(offset, offset + packed);
    const data = packed < size ? zlib.inflateSync(raw) : raw;
    assert.equal(data.length, size);
    tables.push({ tag: woff.subarray(at, at + 4), sum: woff.readUInt32BE(at + 16), data });
  }
  tables.sort((a, b) => Buffer.compare(a.tag, b.tag));
  const sel = Math.floor(Math.log2(n));
  const range = 2 ** sel * 16;
  const head = Buffer.alloc(12 + n * 16);
  head.writeUInt32BE(woff.readUInt32BE(4), 0);
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

describe("CP5 — Candidate 2.3.4 Version Parity, Mobile Web/Font Pipeline & Android WatchService Flow", () => {
  it("keeps 2.3.4 version parity across desk/package/lockfile/mobile and extracts CHANGELOG release notes", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(AGENT_DESK_ROOT, "package.json"), "utf8"));
    const lock = JSON.parse(fs.readFileSync(path.join(AGENT_DESK_ROOT, "package-lock.json"), "utf8"));
    const mobilePkg = JSON.parse(fs.readFileSync(path.join(AGENT_DESK_ROOT, "mobile", "package.json"), "utf8"));
    assert.equal(VERSION, "2.3.4");
    assert.equal(pkg.version, "2.3.4");
    assert.equal(lock.version, "2.3.4");
    assert.equal(lock.packages[""].version, "2.3.4");
    assert.equal(mobilePkg.version, "2.3.4");

    const changelog = fs.readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8").split(/\r?\n/);
    let p = false;
    const notesLines = [];
    for (const line of changelog) {
      if (line.startsWith("## ")) {
        p = line.indexOf(`## ${VERSION} `) === 0;
        continue;
      }
      if (p) notesLines.push(line);
    }
    const notes = notesLines.join("\n").trim();
    assert.ok(notes.length > 200, "CHANGELOG.md must contain release notes for 2.3.4");
    assert.match(notes, /Порядок обновления/);
    assert.match(notes, /state\.json\.bak/);
  });

  it("prepares mobile/www cleanly and validates Android Win98 SFNT font conversion & manifest permissions", () => {
    execFileSync(process.execPath, [path.join(AGENT_DESK_ROOT, "scripts", "prepare-mobile.js")], {
      cwd: AGENT_DESK_ROOT,
      stdio: "pipe",
    });
    const www = path.join(AGENT_DESK_ROOT, "mobile", "www");
    assert.ok(fs.existsSync(path.join(www, "index.html")));
    assert.ok(fs.existsSync(path.join(www, "app.js")));
    assert.ok(fs.existsSync(path.join(www, "app.css")));
    assert.ok(fs.existsSync(path.join(www, "fonts", "ad-cyrillic.woff")));
    assert.equal(fs.existsSync(path.join(www, "popup.html")), false);
    assert.equal(fs.existsSync(path.join(www, "popup.js")), false);
    assert.equal(fs.existsSync(path.join(www, "linked-ui.test.js")), false);

    const fonts = [
      "fonts/ad-cyrillic.woff",
      "fonts/ad-cyrillic-bold.woff",
      ...(fs.existsSync(path.join(AGENT_DESK_ROOT, "web", "vendor", "ms_sans_serif.woff"))
        ? ["vendor/ms_sans_serif.woff", "vendor/ms_sans_serif_bold.woff"]
        : []),
    ];
    for (const rel of fonts) {
      const sfnt = woffToSfnt(fs.readFileSync(path.join(AGENT_DESK_ROOT, "web", rel)));
      const flavor = sfnt.readUInt32BE(0);
      assert.ok(flavor === 0x00010000 || flavor === 0x4f54544f, `${rel} must unpack to TTF/OTF SFNT`);
    }

    const patchSrc = fs.readFileSync(path.join(AGENT_DESK_ROOT, "mobile", "scripts", "patch-android.js"), "utf8");
    for (const perm of [
      "POST_NOTIFICATIONS",
      "FOREGROUND_SERVICE",
      "FOREGROUND_SERVICE_SPECIAL_USE",
      "WAKE_LOCK",
      "RECEIVE_BOOT_COMPLETED",
      "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
    ]) {
      assert.ok(patchSrc.includes(perm), `patch-android.js must declare ${perm}`);
    }
    assert.ok(patchSrc.includes('usesCleartextTraffic="true"'));
  });

  it("verifies Android QR pairing, reconnect, WatchService background long-poll, quiet-hours suppression, dedup & lan_phone scope", async () => {
    const home = makeTmpDir("ad-cp5-phone-");
    const desk = new Desk({
      dataDir: home,
      webDir: path.join(AGENT_DESK_ROOT, "web"),
      legacyDir: null,
      port: 0,
      lan: false,
      discovery: false,
      pollMs: 3600000,
      log: () => {},
    });
    desk.config.device_name = "ПК-Кандидат (синтетика)";
    await desk.start();
    desk.peers.stop();
    const base = `http://127.0.0.1:${desk.boundPort}`;
    try {
      // 1. Owner fetches QR pairing info on loopback + generates valid QR PNG
      const pairRes = await fetch(`${base}/api/pairing`);
      assert.equal(pairRes.status, 200);
      const pairInfo = await pairRes.json();
      assert.equal(pairInfo.key, desk.config.key);
      assert.equal(pairInfo.port, desk.boundPort);
      const qrDataUrl = await QRCode.toDataURL(pairInfo.url);
      assert.ok(qrDataUrl.startsWith("data:image/png;base64,"));

      // 2. Phone WebView scans QR URL /?key=<key> -> gets 302 + HttpOnly cookie ad_key
      const qrRes = await fetch(`${base}/?key=${pairInfo.key}`, { redirect: "manual" });
      assert.equal(qrRes.status, 302);
      const setCookie = qrRes.headers.get("set-cookie") || "";
      assert.match(setCookie, /ad_key=[0-9a-f]+; Max-Age=\d+; Path=\/; SameSite=Strict; HttpOnly/);

      // 3. WatchService initial connect (no `after`, Capacitor Origin + X-Agent-Desk-Key)
      const phoneHeaders = {
        Origin: "https://localhost",
        "X-Agent-Desk-Key": pairInfo.key,
        Accept: "application/json",
      };
      const initPoll = await fetch(`${base}/api/alerts?wait=1`, { headers: phoneHeaders });
      assert.equal(initPoll.status, 200);
      const initJson = await initPoll.json();
      assert.equal(typeof initJson.seq, "number");
      assert.deepEqual(initJson.alerts, []);
      assert.ok(desk.lastPhoneSeenAt, "phone poll must update lastPhoneSeenAt");

      // 4. Held background WatchService request wakes immediately when an alert arrives
      const t0 = Date.now();
      const heldPromise = fetch(`${base}/api/alerts?after=${initJson.seq}&wait=5`, { headers: phoneHeaders });
      await new Promise((r) => setTimeout(r, 80));
      desk.applyEvent(parseMarker(JSON.stringify({
        agent: "Carbon",
        project: "SyntheticMobile",
        state: "waiting",
        waiting_for: "owner_input",
        task: "Проверить QR и фоновый канал",
        question: "Подтвердить порядок обновления?",
        updated_at: new Date().toISOString(),
      }), "01-phone-wake.json"));

      const wakeRes = await heldPromise;
      const elapsedMs = Date.now() - t0;
      assert.equal(wakeRes.status, 200);
      assert.ok(elapsedMs < 2000, `long-poll should wake immediately on alert, took ${elapsedMs}ms`);
      const wakeJson = await wakeRes.json();
      assert.ok(wakeJson.seq > initJson.seq);
      assert.equal(wakeJson.alerts.length, 1);
      assert.match(wakeJson.alerts[0].title, /Carbon/);

      // 5. Reconnect / next poll with updated `after` produces zero duplicate notifications
      const dedupRes = await fetch(`${base}/api/alerts?after=${wakeJson.seq}&wait=0`, { headers: phoneHeaders });
      const dedupJson = await dedupRes.json();
      assert.equal(dedupJson.seq, wakeJson.seq);
      assert.deepEqual(dedupJson.alerts, []);

      // 6. Quiet hours suppress noisy phone alerts while preserving owner queue state
      desk.config.quiet_hours = { enabled: true, start: "00:00", end: "23:59" };
      desk._saveConfig();
      desk.applyEvent(parseMarker(JSON.stringify({
        agent: "ReviewerBot",
        project: "SyntheticMobile",
        state: "blocked",
        blocker: "Нужен доступ к тестовому стенду",
        updated_at: new Date().toISOString(),
      }), "02-quiet-blocked.json"));

      const quietRes = await fetch(`${base}/api/alerts?after=${wakeJson.seq}&wait=0`, { headers: phoneHeaders });
      const quietJson = await quietRes.json();
      assert.ok(quietJson.seq > wakeJson.seq, "alert_seq advances cleanly during quiet hours");
      assert.deepEqual(quietJson.alerts, [], "suppressed alerts must not chime on phone during quiet hours");

      // 7. Phone scope (Capacitor origin) can read compact state, item & search, while owner-only routes stay 403
      const stateRes = await fetch(`${base}/api/state?compact=1&since=0`, { headers: phoneHeaders });
      assert.equal(stateRes.status, 200);
      const stateJson = await stateRes.json();
      assert.equal(stateJson.todos.length, 2, "both cards remain visible in phone queue despite quiet hours");

      const pairingForbidden = await fetch(`${base}/api/pairing`, { headers: phoneHeaders });
      assert.equal(pairingForbidden.status, 403);
      const reconcileForbidden = await fetch(`${base}/api/reconcile`, { headers: phoneHeaders });
      assert.equal(reconcileForbidden.status, 403);
    } finally {
      await desk.stop();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
