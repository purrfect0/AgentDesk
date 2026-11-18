"use strict";
// Built-in update checker and SHA-256 verified Windows self-updater (zero external dependencies).
// Checks GitHub Releases, notifies PC + paired Android phone once per version, and on Windows
// downloads AgentDesk-Setup-<v>.exe + .sha256, verifies SHA-256 before & right before launch, and
// invokes the NSIS silent upgrade (/S --updated --force-run).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");

const DEFAULT_RELEASE_API = "https://api.github.com/repos/purrfect0/AgentDesk/releases/latest";
const DEFAULT_RELEASE_PAGE = "https://github.com/purrfect0/AgentDesk/releases/latest";
const DEFAULT_ALLOWED_ORIGINS = new Set([
  "https://api.github.com",
  "https://github.com",
  "https://objects.githubusercontent.com",
  "https://release-assets.githubusercontent.com",
]);

const MAX_JSON_BYTES = 512 * 1024;
const MAX_SHA_BYTES = 8 * 1024;
const MAX_EXE_BYTES = 320 * 1024 * 1024;
const CHECK_INTERVAL_MS = 6 * 3600 * 1000;
const INITIAL_DELAY_MS = 12 * 1000;

function parseSemver(raw) {
  const s = String(raw || "").trim().replace(/^agent-desk-v/i, "").replace(/^v/i, "");
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(s);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function normalizeVersion(raw) {
  const p = parseSemver(raw);
  return p ? `${p[0]}.${p[1]}.${p[2]}` : "";
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function firstNoteLine(notes) {
  for (const raw of String(notes || "").split(/\r?\n/)) {
    const line = raw.replace(/^[#>*\-\s]+/, "").replace(/\*\*/g, "").trim();
    if (line && !/^Файлы:/i.test(line)) return line.slice(0, 220);
  }
  return "Доступны исправления и улучшения для Windows и Android.";
}

function fileSha256(filePath) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    while ((bytes = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(buf.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

class UpdateManager {
  constructor(desk, opts = {}) {
    this.desk = desk;
    this.enabled = Boolean(opts.enabled);
    this.apiUrl = opts.apiUrl || DEFAULT_RELEASE_API;
    this.allowedOrigins = new Set([
      ...DEFAULT_ALLOWED_ORIGINS,
      ...(Array.isArray(opts.allowedOrigins) ? opts.allowedOrigins : []),
    ]);
    this.updateDir = opts.updateDir || path.join(os.tmpdir(), "agent-desk-updates");
    this.initialDelayMs = opts.initialDelayMs ?? INITIAL_DELAY_MS;
    this.checkIntervalMs = opts.checkIntervalMs ?? CHECK_INTERVAL_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15000;
    this.installHandler = typeof opts.installHandler === "function" ? opts.installHandler : null;

    this._initTimer = null;
    this._pollTimer = null;
    this._checkingPromise = null;
    this._downloadPromise = null;
    this._lastCheckMs = 0;

    this.installerPath = null;
    this.expectedSha256 = null;
    this.readyVersion = null;

    this.state = {
      phase: "idle", // idle | checking | up_to_date | available | downloading | ready | installing | error
      available: false,
      current_version: desk.version,
      latest_version: null,
      published_at: null,
      checked_at: null,
      release_url: DEFAULT_RELEASE_PAGE,
      notes: "",
      win: null,
      apk: null,
      progress: null,
      verified_sha256: null,
      error: null,
    };
  }

  setInstallHandler(fn) {
    this.installHandler = typeof fn === "function" ? fn : null;
  }

  canAutoInstall() {
    return typeof this.installHandler === "function";
  }

  start() {
    this.stop();
    if (!this.enabled) return;
    this._initTimer = setTimeout(() => {
      if (this.desk.config.update_check !== false) {
        this.check({ force: false }).catch(() => {});
      }
    }, this.initialDelayMs);
    this._initTimer.unref?.();
    this._pollTimer = setInterval(() => {
      if (this.desk.config.update_check !== false) {
        this.check({ force: false }).catch(() => {});
      }
    }, this.checkIntervalMs);
    this._pollTimer.unref?.();
  }

  stop() {
    if (this._initTimer) { clearTimeout(this._initTimer); this._initTimer = null; }
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  _notifyUi() {
    this.desk._bump();
    this.desk.emit("change");
  }

  _isAllowedUrl(rawUrl) {
    try {
      const u = new URL(String(rawUrl || ""));
      if (!["https:", "http:"].includes(u.protocol)) return false;
      return this.allowedOrigins.has(u.origin);
    } catch {
      return false;
    }
  }

  _request(rawUrl, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
      if (!this._isAllowedUrl(rawUrl)) {
        reject(new Error("Неразрешённый адрес источника обновлений"));
        return;
      }
      const u = new URL(rawUrl);
      const transport = u.protocol === "https:" ? https : http;
      const headers = {
        "User-Agent": `AgentDesk/${this.desk.version}`,
        Accept: u.hostname === "api.github.com" ? "application/vnd.github+json" : "*/*",
      };
      const req = transport.get(u, { headers, timeout: this.requestTimeoutMs }, (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error("Слишком много перенаправлений при проверке обновлений"));
            return;
          }
          let nextUrl;
          try { nextUrl = new URL(res.headers.location, u).toString(); } catch {
            reject(new Error("Некорректный адрес перенаправления"));
            return;
          }
          this._request(nextUrl, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (code !== 200) {
          res.resume();
          reject(new Error(`Сервер обновлений ответил HTTP ${code}`));
          return;
        }
        resolve(res);
      });
      req.on("timeout", () => req.destroy(new Error("Превышено время ожидания ответа GitHub")));
      req.on("error", reject);
    });
  }

  async _fetchBuffer(rawUrl, maxBytes) {
    const res = await this._request(rawUrl);
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy(new Error("Ответ сервера обновлений превышает допустимый размер"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
  }

  async check({ force = false } = {}) {
    if (this._checkingPromise) return this._checkingPromise;
    if (!force && this._lastCheckMs && (Date.now() - this._lastCheckMs) < 60 * 1000) {
      return this.state;
    }
    if (["downloading", "installing"].includes(this.state.phase)) return this.state;

    this._checkingPromise = (async () => {
      const prevPhase = this.state.phase;
      this.state.phase = "checking";
      this.state.error = null;
      this._notifyUi();
      try {
        const raw = await this._fetchBuffer(this.apiUrl, MAX_JSON_BYTES);
        const rel = JSON.parse(raw.toString("utf8"));
        const latest = normalizeVersion(rel.tag_name || rel.name || "");
        if (!latest) throw new Error("Не удалось распознать номер версии последнего релиза");

        const assets = Array.isArray(rel.assets) ? rel.assets : [];
        const pick = (re) => assets.find((a) => a && typeof a.name === "string" && re.test(a.name) && this._isAllowedUrl(a.browser_download_url));
        const winExe = pick(/^AgentDesk-Setup-[0-9A-Za-z._-]+\.exe$/i);
        const winSha = pick(/^AgentDesk-Setup-[0-9A-Za-z._-]+\.exe\.sha256$/i);
        const apk = pick(/^AgentDesk-[0-9A-Za-z._-]+\.apk$/i);
        const apkSha = pick(/^AgentDesk-[0-9A-Za-z._-]+\.apk\.sha256$/i);

        const available = compareSemver(latest, this.desk.version) > 0;
        const alreadyReady = available && this.readyVersion === latest && this.installerPath && fs.existsSync(this.installerPath);

        this._lastCheckMs = Date.now();
        this.state.current_version = this.desk.version;
        this.state.latest_version = latest;
        this.state.available = available;
        this.state.published_at = typeof rel.published_at === "string" ? rel.published_at : null;
        this.state.checked_at = new Date().toISOString();
        this.state.release_url = this._isAllowedUrl(rel.html_url) ? rel.html_url : DEFAULT_RELEASE_PAGE;
        this.state.notes = String(rel.body || "").slice(0, 4000).trim();
        this.state.win = winExe ? {
          name: winExe.name,
          size: Number(winExe.size) || 0,
          url: winExe.browser_download_url,
          sha_url: winSha ? winSha.browser_download_url : null,
        } : null;
        this.state.apk = apk ? {
          name: apk.name,
          size: Number(apk.size) || 0,
          url: apk.browser_download_url,
          sha_url: apkSha ? apkSha.browser_download_url : null,
        } : null;
        this.state.phase = alreadyReady ? "ready" : (available ? "available" : "up_to_date");
        this.state.error = null;

        if (available && this.desk.config.last_notified_update !== latest) {
          this.desk.config.last_notified_update = latest;
          try { this.desk._saveConfig(); } catch { /* ignore config write error */ }
          this.desk._alert(
            "update",
            "",
            `Доступно обновление Agent Desk ${latest}`,
            firstNoteLine(this.state.notes),
            null,
            { action: "Откройте «Справка → Обновление…», чтобы обновиться в один клик" },
          );
          this.desk._commit();
        } else {
          this._notifyUi();
        }
      } catch (e) {
        this.state.phase = prevPhase === "ready" ? "ready" : "error";
        this.state.error = e.message || "Не удалось проверить обновления";
        this.state.checked_at = new Date().toISOString();
        this._notifyUi();
      } finally {
        this._checkingPromise = null;
      }
      return this.state;
    })();
    return this._checkingPromise;
  }

  async download({ autoInstall = false } = {}) {
    if (this._downloadPromise) return this._downloadPromise;
    if (!this.state.latest_version) await this.check({ force: true });
    if (!this.state.available) {
      throw Object.assign(new Error("У вас уже установлена актуальная версия"), { status: 409 });
    }
    const win = this.state.win;
    if (!win || !win.url) {
      throw Object.assign(new Error("В релизе ещё нет установщика Windows (.exe)"), { status: 404 });
    }
    if (!win.sha_url) {
      throw Object.assign(new Error("В релизе отсутствует файл контрольной суммы .sha256 — скачивание остановлено"), { status: 409 });
    }
    if (!/^AgentDesk-Setup-[0-9A-Za-z._-]+\.exe$/i.test(win.name)) {
      throw Object.assign(new Error("Недопустимое имя файла установщика"), { status: 400 });
    }

    const targetVersion = this.state.latest_version;
    if (this.state.phase === "ready" && this.readyVersion === targetVersion && this.installerPath && fs.existsSync(this.installerPath)) {
      if (autoInstall && this.canAutoInstall()) await this.install();
      return this.state;
    }

    this._downloadPromise = (async () => {
      let partPath = null;
      try {
        this.state.phase = "downloading";
        this.state.error = null;
        this.state.progress = { percent: 0, downloaded: 0, total: win.size || 0 };
        this._notifyUi();

        const shaRaw = (await this._fetchBuffer(win.sha_url, MAX_SHA_BYTES)).toString("utf8").trim();
        const shaMatch = /^([0-9a-f]{64})\b/i.exec(shaRaw);
        if (!shaMatch) throw new Error("Не удалось прочитать контрольную сумму SHA-256 релиза");
        const expectedSha = shaMatch[1].toLowerCase();

        fs.mkdirSync(this.updateDir, { recursive: true });
        const finalPath = path.join(this.updateDir, win.name);
        partPath = `${finalPath}.${process.pid}.part`;
        try { fs.unlinkSync(partPath); } catch { /* ignore */ }

        const res = await this._request(win.url);
        const total = Number(res.headers["content-length"]) || win.size || 0;
        if (total > MAX_EXE_BYTES) {
          res.destroy();
          throw new Error("Размер установщика превышает допустимый предел");
        }

        const hash = crypto.createHash("sha256");
        let downloaded = 0;
        let lastEmit = 0;

        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(partPath, { flags: "w" });
          const fail = (err) => {
            res.destroy();
            out.destroy();
            reject(err);
          };
          res.setTimeout(60000, () => fail(new Error("Прервалась загрузка установщика (таймаут сети)")));
          res.on("data", (chunk) => {
            downloaded += chunk.length;
            if (downloaded > MAX_EXE_BYTES) {
              fail(new Error("Размер скачиваемого файла превысил допустимый лимит"));
              return;
            }
            hash.update(chunk);
            const pct = total > 0 ? Math.min(99, Math.round((downloaded * 100) / total)) : 0;
            this.state.progress = { percent: pct, downloaded, total };
            const now = Date.now();
            if (now - lastEmit >= 350) {
              lastEmit = now;
              this._notifyUi();
            }
          });
          res.on("error", fail);
          out.on("error", fail);
          res.pipe(out);
          out.on("finish", resolve);
        });

        const actualSha = hash.digest("hex");
        if (actualSha !== expectedSha) {
          try { fs.unlinkSync(partPath); } catch { /* ignore */ }
          throw new Error("Контрольная сумма SHA-256 не совпала — повреждённый файл удалён");
        }

        try { fs.unlinkSync(finalPath); } catch { /* ignore */ }
        fs.renameSync(partPath, finalPath);
        partPath = null;

        this.installerPath = finalPath;
        this.expectedSha256 = expectedSha;
        this.readyVersion = targetVersion;
        this.state.verified_sha256 = expectedSha;
        this.state.progress = { percent: 100, downloaded, total: total || downloaded };
        this.state.phase = "ready";
        this.state.error = null;
        this._notifyUi();

        if (autoInstall && this.canAutoInstall()) {
          await this.install();
        }
      } catch (e) {
        if (partPath) {
          try { fs.unlinkSync(partPath); } catch { /* ignore */ }
        }
        this.state.phase = "error";
        this.state.error = e.message || "Ошибка загрузки обновления";
        this._notifyUi();
        throw e;
      } finally {
        this._downloadPromise = null;
      }
      return this.state;
    })();

    return this._downloadPromise;
  }

  async install() {
    if (!this.canAutoInstall()) {
      throw Object.assign(new Error("Автоустановка работает в установленном приложении Windows; запустите скачанный установщик вручную"), { status: 409 });
    }
    if (this.state.phase !== "ready" || !this.installerPath || !this.expectedSha256 || !fs.existsSync(this.installerPath)) {
      throw Object.assign(new Error("Установщик ещё не скачан или был удалён — нажмите «Скачать и установить»"), { status: 409 });
    }
    const diskSha = fileSha256(this.installerPath);
    if (diskSha !== this.expectedSha256) {
      try { fs.unlinkSync(this.installerPath); } catch { /* ignore */ }
      this.installerPath = null;
      this.state.phase = "error";
      this.state.error = "Файл установщика во временной папке был изменён — повторите загрузку";
      this._notifyUi();
      throw Object.assign(new Error(this.state.error), { status: 409 });
    }
    this.state.phase = "installing";
    this._notifyUi();
    await this.installHandler({
      path: this.installerPath,
      version: this.readyVersion,
      sha256: this.expectedSha256,
    });
    return this.state;
  }

  async local(action, body = {}, auth = { local: false }) {
    if (action === "check") {
      await this.check({ force: true });
      return { body: this.payload(auth) };
    }
    if (action === "download") {
      if (!auth.local) return { code: 403, body: { error: "скачивание установщика выполняется только на ПК" } };
      const autoInstall = Boolean(body.auto_install);
      if (body.wait === true) {
        try {
          await this.download({ autoInstall });
          return { body: this.payload(auth) };
        } catch (e) {
          return { code: e.status || 500, body: { error: e.message } };
        }
      }
      this.download({ autoInstall }).catch((e) => this.desk.log("update download failed:", e.message));
      return { body: this.payload(auth) };
    }
    if (action === "install") {
      if (!auth.local) return { code: 403, body: { error: "установка обновления выполняется только на ПК" } };
      try {
        await this.install();
        return { body: this.payload(auth) };
      } catch (e) {
        return { code: e.status || 500, body: { error: e.message } };
      }
    }
    return { code: 404, body: { error: "not found" } };
  }

  payload(auth = { local: false }) {
    const s = this.state;
    return {
      phase: s.phase,
      available: s.available,
      current_version: this.desk.version,
      latest_version: s.latest_version,
      published_at: s.published_at,
      checked_at: s.checked_at,
      release_url: s.release_url,
      notes: s.notes,
      progress: s.progress ? { ...s.progress } : null,
      verified_sha256: s.verified_sha256,
      error: s.error,
      auto_check: this.desk.config.update_check !== false,
      can_auto_install: Boolean(auth?.local && this.canAutoInstall()),
      win: s.win ? { name: s.win.name, size: s.win.size, url: s.win.url, has_sha256: Boolean(s.win.sha_url) } : null,
      apk: s.apk ? { name: s.apk.name, size: s.apk.size, url: s.apk.url, has_sha256: Boolean(s.apk.sha_url) } : null,
    };
  }
}

module.exports = { UpdateManager, parseSemver, normalizeVersion, compareSemver };
