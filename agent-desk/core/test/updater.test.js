"use strict";
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { Desk, VERSION } = require("../desk.js");
const { parseSemver, compareSemver } = require("../updater.js");

const tempDirs = [];
const servers = [];
const desks = [];

function mkDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

afterEach(async () => {
  while (desks.length) {
    try { await desks.pop().stop(); } catch { /* ignore */ }
  }
  while (servers.length) {
    const s = servers.pop();
    await new Promise((r) => s.close(() => r()));
  }
  while (tempDirs.length) {
    try { fs.rmSync(tempDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

async function postJson(baseUrl, pathname, body, headers = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Desk": "1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

describe("Built-in GitHub Release Updater & SHA-256 Self-Update", () => {
  it("compares semver tags accurately", () => {
    assert.deepEqual(parseSemver("agent-desk-v2.3.6"), [2, 3, 6]);
    assert.deepEqual(parseSemver("v2.10.0"), [2, 10, 0]);
    assert.equal(parseSemver("invalid"), null);
    assert.equal(compareSemver("2.3.7", "2.3.6"), 1);
    assert.equal(compareSemver("agent-desk-v2.3.6", "2.3.6"), 0);
    assert.equal(compareSemver("2.3.5", "2.3.6"), -1);
  });

  it("notifies once, enforces lan_phone boundaries, blocks bad SHA-256/origins, and runs verified install", async () => {
    const [maj, min, pat] = parseSemver(VERSION);
    const nextVer = `${maj}.${min}.${pat + 1}`;
    const exeName = `AgentDesk-Setup-${nextVer}.exe`;
    const apkName = `AgentDesk-${nextVer}.apk`;
    const fakeExeBytes = Buffer.from(`MZ-FAKE-NSIS-INSTALLER-${nextVer}-${"X".repeat(4096)}`, "utf8");
    const goodSha = crypto.createHash("sha256").update(fakeExeBytes).digest("hex");

    let serveCorruptExe = false;
    let redirectToUntrusted = false;
    let mockOrigin = "";

    const releaseServer = http.createServer((req, res) => {
      if (req.url === "/releases/latest") {
        if (redirectToUntrusted) {
          res.writeHead(302, { Location: "http://evil.example.invalid/releases/latest" });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          tag_name: `agent-desk-v${nextVer}`,
          name: `Agent Desk ${nextVer}`,
          published_at: "2026-11-18T08:00:00Z",
          html_url: "https://github.com/purrfect0/AgentDesk/releases/tag/agent-desk-v" + nextVer,
          body: `## Что нового\n- Автообновление Windows с проверкой SHA-256\n- Уведомление на телефоне`,
          assets: [
            { name: exeName, size: fakeExeBytes.length, browser_download_url: `${mockOrigin}/dl/${exeName}` },
            { name: `${exeName}.sha256`, size: 90, browser_download_url: `${mockOrigin}/dl/${exeName}.sha256` },
            { name: apkName, size: 12345, browser_download_url: `${mockOrigin}/dl/${apkName}` },
            { name: `${apkName}.sha256`, size: 90, browser_download_url: `${mockOrigin}/dl/${apkName}.sha256` },
          ],
        }));
        return;
      }
      if (req.url === `/dl/${exeName}.sha256`) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`${goodSha}  ${exeName}\n`);
        return;
      }
      if (req.url === `/dl/${exeName}`) {
        const payload = serveCorruptExe ? Buffer.from("CORRUPT-BYTES") : fakeExeBytes;
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(payload.length),
        });
        res.end(payload);
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    servers.push(releaseServer);
    await new Promise((resolve) => releaseServer.listen(0, "127.0.0.1", resolve));
    mockOrigin = `http://127.0.0.1:${releaseServer.address().port}`;

    const dataDir = mkDir("ad-upd-desk-");
    const updateDir = mkDir("ad-upd-bin-");
    const installedCalls = [];
    const alerts = [];

    const desk = new Desk({
      dataDir,
      port: 0,
      lan: true,
      legacyDir: null,
      updater: {
        enabled: false,
        apiUrl: `${mockOrigin}/releases/latest`,
        allowedOrigins: [mockOrigin],
        updateDir,
        installHandler: async (info) => { installedCalls.push(info); },
      },
    });
    desk.on("alert", (a) => alerts.push(a));
    desks.push(desk);
    await desk.start();
    const base = `http://127.0.0.1:${desk.boundPort}`;

    // 1. First check discovers update and emits exactly 1 update alert
    const r1 = await postJson(base, "/api/update/check", {});
    assert.equal(r1.status, 200);
    assert.equal(r1.body.available, true);
    assert.equal(r1.body.latest_version, nextVer);
    assert.equal(r1.body.can_auto_install, true);
    assert.equal(r1.body.win.has_sha256, true);
    assert.equal(alerts.filter((a) => a.kind === "update").length, 1);
    assert.match(alerts[0].title, new RegExp(nextVer.replace(/\./g, "\\.")));

    // Repeated check does NOT spam duplicate alerts for the same version
    await postJson(base, "/api/update/check", {});
    assert.equal(alerts.filter((a) => a.kind === "update").length, 1);

    // 2. Untrusted redirect origin fails closed
    redirectToUntrusted = true;
    const badOriginRes = await postJson(base, "/api/update/check", {});
    assert.equal(badOriginRes.body.phase, "error");
    assert.match(badOriginRes.body.error, /Неразрешённый адрес/);
    redirectToUntrusted = false;
    await postJson(base, "/api/update/check", {});

    // 3. Phone (non-loopback simulated vialan_phone scope check on local() directly) cannot download or install
    const phoneCheck = await desk.updater.local("check", {}, { ok: true, local: false });
    assert.equal(phoneCheck.body.can_auto_install, false);
    const phoneDl = await desk.updater.local("download", { wait: true }, { ok: true, local: false });
    assert.equal(phoneDl.code, 403);
    const phoneInst = await desk.updater.local("install", {}, { ok: true, local: false });
    assert.equal(phoneInst.code, 403);
    const phoneCfg = desk._updateConfig({ update_check: false }, { ok: true, local: false });
    assert.equal(phoneCfg.code, 403);

    // 4. Corrupt binary fails SHA-256 verification and leaves no installer
    serveCorruptExe = true;
    const corruptDl = await postJson(base, "/api/update/download", { wait: true });
    assert.equal(corruptDl.status, 500);
    assert.match(corruptDl.body.error, /SHA-256/);
    assert.equal(fs.existsSync(path.join(updateDir, exeName)), false);
    serveCorruptExe = false;

    // 5. Valid binary downloads, verifies SHA-256, and auto-installs
    const okDl = await postJson(base, "/api/update/download", { wait: true, auto_install: true });
    assert.equal(okDl.status, 200);
    assert.equal(okDl.body.verified_sha256, goodSha);
    assert.equal(installedCalls.length, 1);
    assert.equal(installedCalls[0].version, nextVer);
    assert.equal(installedCalls[0].sha256, goodSha);
    assert.equal(fs.existsSync(installedCalls[0].path), true);

    // 6. TOCTOU protection: modifying downloaded installer before manual install() fails closed and deletes it
    desk.updater.state.phase = "ready";
    fs.writeFileSync(installedCalls[0].path, "TAMPERED-ON-DISK");
    const tamperInst = await postJson(base, "/api/update/install", {});
    assert.equal(tamperInst.status, 409);
    assert.match(tamperInst.body.error, /изменён/);
    assert.equal(fs.existsSync(installedCalls[0].path), false);
  });
});
