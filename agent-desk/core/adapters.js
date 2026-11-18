"use strict";
/**
 * Agent Desk launch adapter contract:
 * - Manual mode remains the default safe baseline.
 * - Local mock dry-run verifies availability (`probe`), requires an explicit owner launch action,
 *   guarantees idempotent dispatch results, and records a separate `dispatched_at` receipt
 *   strictly distinct from recipient `acked_at` and task `working` state.
 * - Local `codex-cli` adapter (owner opt-in via `autopilot.codex_cli_enabled`) pushes verified
 *   prompts directly into an existing OpenAI Codex session via `codex queue --thread ... --resume`
 *   using shell-free execution.
 * - Unknown external accounts/providers remain disabled unless explicitly enabled by the owner.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const nowIso = () => new Date().toISOString();

function findCodexBinary() {
  const isWin = process.platform === "win32";
  const exeNames = isWin ? ["codex.exe", "codex.cmd"] : ["codex"];
  const candidates = [];
  if (isWin) {
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe"));
    candidates.push(path.join(os.homedir(), "AppData", "Local", "Programs", "OpenAI", "Codex", "bin", "codex.exe"));
  }
  const pathDirs = String(process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const name of exeNames) candidates.push(path.join(dir, name));
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch { /* ignore */ }
  }
  return null;
}

class ManualAdapter {
  constructor() {
    this.id = "manual";
    this.mode = "manual";
  }

  probe() {
    return {
      adapter: this.id,
      mode: this.mode,
      available: true,
      requires_owner_opt_in: false,
      checked_at: nowIso(),
      reason: "Ручной режим: скопируйте проверенный промпт в сессию агента одним действием.",
    };
  }

  launch() {
    const err = new Error("Адаптер manual не выполняет автозапуск; скопируйте проверенный контекст вручную");
    err.status = 409;
    throw err;
  }
}

class MockDryRunAdapter {
  constructor() {
    this.id = "mock-dry-run";
    this.mode = "dry_run_mock";
    this.dispatches = new Map();
  }

  probe(options = {}) {
    if (options.simulateUnavailable) {
      return {
        adapter: this.id,
        mode: this.mode,
        available: false,
        requires_owner_opt_in: false,
        checked_at: nowIso(),
        reason: "Локальный mock-адаптер временно недоступен (тестовый режим отказа).",
      };
    }
    return {
      adapter: this.id,
      mode: this.mode,
      available: true,
      requires_owner_opt_in: false,
      checked_at: nowIso(),
      reason: "Локальный dry-run mock готов: проверяет пакет запуска без внешних сетей и аккаунтов.",
    };
  }

  launch({ task, forward_text: text, request_id: reqId = "" }, options = {}) {
    const status = this.probe(options);
    if (!status.available) {
      const err = new Error(status.reason);
      err.status = 503;
      throw err;
    }
    const epoch = task?.assignment?.epoch || 1;
    const key = `${task.task_id}:${epoch}:${reqId || "default"}`;
    const payloadBuf = Buffer.from(String(text || ""), "utf8");
    const payloadSha256 = crypto.createHash("sha256").update(payloadBuf).digest("hex");

    if (this.dispatches.has(key)) {
      const existing = this.dispatches.get(key);
      if (existing.payload_sha256 !== payloadSha256) {
        const err = new Error("request_id запуска уже использован с другим содержимым промпта");
        err.status = 409;
        throw err;
      }
      return { ...existing, duplicate: true };
    }

    const receipt = {
      status: "dispatched_dry_run",
      adapter: this.id,
      mode: this.mode,
      dry_run: true,
      launch_id: crypto.randomUUID(),
      request_id: reqId || null,
      task_id: task.task_id,
      assignment_epoch: epoch,
      target_agent: task.assignment?.agent || "",
      target_device_id: task.assignment?.device_id || "",
      target_session_id: task.assignment?.session_id || "",
      dispatched_at: nowIso(),
      payload_bytes: payloadBuf.length,
      payload_sha256: payloadSha256,
      ack_received: false,
      duplicate: false,
      reason: "Команда запуска принята локальным mock dry-run; это квитанция отправки, а не ACK агента.",
    };
    this.dispatches.set(key, receipt);
    return { ...receipt };
  }
}

class CodexCliAdapter {
  constructor(opts = {}) {
    this.id = "codex-cli";
    this.mode = "local_cli";
    this.dispatches = new Map();
    this.runner = typeof opts.runner === "function" ? opts.runner : null;
    this._cachedBin = null;
    this._cachedVer = null;
    this._cachedAt = 0;
  }

  _detectBinary() {
    if (this.runner) return { ok: true, bin: "codex-mock", version: "codex-cli (test)" };
    const now = Date.now();
    if (this._cachedAt && (now - this._cachedAt) < 60000) {
      return { ok: Boolean(this._cachedBin), bin: this._cachedBin, version: this._cachedVer };
    }
    const bin = findCodexBinary();
    this._cachedBin = bin;
    this._cachedVer = bin ? "codex-cli" : null;
    this._cachedAt = now;
    return { ok: Boolean(bin), bin, version: this._cachedVer };
  }

  probe(options = {}) {
    const enabled = options.codexCliEnabled === true;
    const det = this._detectBinary();
    if (!det.ok) {
      return {
        adapter: this.id,
        mode: this.mode,
        available: false,
        requires_owner_opt_in: true,
        owner_opt_in: enabled,
        binary_found: false,
        checked_at: nowIso(),
        reason: "Codex CLI не найден на этом ПК.",
      };
    }
    if (!enabled) {
      return {
        adapter: this.id,
        mode: this.mode,
        available: false,
        requires_owner_opt_in: true,
        owner_opt_in: false,
        binary_found: true,
        version: det.version,
        checked_at: nowIso(),
        reason: `Найден ${det.version}; включите «Отправка в Codex CLI» в окне «Автопилот и чаты», чтобы доставлять задания напрямую.`,
      };
    }
    return {
      adapter: this.id,
      mode: this.mode,
      available: true,
      requires_owner_opt_in: true,
      owner_opt_in: true,
      binary_found: true,
      version: det.version,
      checked_at: nowIso(),
      reason: `Готов (${det.version}): отправляет промпт в сессию Codex через codex queue --resume.`,
    };
  }

  launch({ task, forward_text: text, request_id: reqId = "", cwd = "" }, options = {}) {
    const status = this.probe(options);
    if (!status.available) {
      const err = new Error(status.reason);
      err.status = options.codexCliEnabled === true ? 503 : 403;
      throw err;
    }
    const thread = String(task?.assignment?.session_id || "").trim();
    if (!thread || !/^[A-Za-z0-9._:-]{1,120}$/.test(thread)) {
      const err = new Error("Для запуска codex-cli укажите UUID или имя треда Codex в поле session_id");
      err.status = 400;
      throw err;
    }

    const epoch = task?.assignment?.epoch || 1;
    const key = `${task.task_id}:${epoch}:${reqId || "default"}`;
    const payloadStr = String(text || "");
    const payloadBuf = Buffer.from(payloadStr, "utf8");
    const payloadSha256 = crypto.createHash("sha256").update(payloadBuf).digest("hex");

    if (this.dispatches.has(key)) {
      const existing = this.dispatches.get(key);
      if (existing.payload_sha256 !== payloadSha256) {
        const err = new Error("request_id запуска уже использован с другим содержимым промпта");
        err.status = 409;
        throw err;
      }
      return { ...existing, duplicate: true };
    }

    const args = ["queue", "--thread", thread, "--message", payloadStr, "--resume"];
    const workDir = cwd || task?.checkpoint?.repo || "";
    if (workDir && path.isAbsolute(workDir) && fs.existsSync(workDir)) {
      args.push("-C", workDir);
    }

    const det = this._detectBinary();
    const res = this.runner
      ? this.runner(det.bin, args, { cwd: workDir })
      : spawnSync(det.bin, args, { shell: false, windowsHide: true, encoding: "utf8", timeout: 15000 });

    if (res.error || (typeof res.status === "number" && res.status !== 0)) {
      const detail = String(res.stderr || res.error?.message || `код ${res.status}`).trim().slice(0, 240);
      const err = new Error(`Codex CLI отклонил постановку в очередь: ${detail}`);
      err.status = 502;
      throw err;
    }

    const receipt = {
      status: "dispatched_codex_queue",
      adapter: this.id,
      mode: this.mode,
      dry_run: false,
      launch_id: crypto.randomUUID(),
      request_id: reqId || null,
      task_id: task.task_id,
      assignment_epoch: epoch,
      target_agent: task.assignment?.agent || "",
      target_device_id: task.assignment?.device_id || "",
      target_session_id: thread,
      dispatched_at: nowIso(),
      payload_bytes: payloadBuf.length,
      payload_sha256: payloadSha256,
      ack_received: false,
      duplicate: false,
      reason: "Сообщение поставлено в очередь сессии Codex (codex queue --resume); ждём ACK агента.",
    };
    this.dispatches.set(key, receipt);
    return { ...receipt };
  }
}

class ExternalGatedAdapter {
  constructor(id) {
    this.id = id;
    this.mode = "external";
  }

  probe(options = {}) {
    const enabled = options.externalEnabled === true;
    return {
      adapter: this.id,
      mode: this.mode,
      available: false,
      requires_owner_opt_in: true,
      owner_opt_in: enabled,
      checked_at: nowIso(),
      reason: enabled
        ? `Внешний провайдер «${this.id}» разрешён владельцем, но боевой коннектор не подключён — используйте ручной режим, codex-cli или mock-dry-run.`
        : `Внешние аккаунты («${this.id}») отключены по умолчанию; включение требует отдельного явного решения владельца.`,
    };
  }

  launch(_ctx, options = {}) {
    const st = this.probe(options);
    const err = new Error(st.reason);
    err.status = options.externalEnabled === true ? 501 : 403;
    throw err;
  }
}

class AdapterRegistry {
  constructor(opts = {}) {
    this.manual = new ManualAdapter();
    this.mock = new MockDryRunAdapter();
    this.codexCli = new CodexCliAdapter(opts.codexCli || {});
    this._mockUnavailable = false;
  }

  _opts(config = {}) {
    return {
      externalEnabled: config.external_adapters_enabled === true,
      codexCliEnabled: Boolean(config.autopilot?.codex_cli_enabled),
      simulateUnavailable: this._mockUnavailable,
    };
  }

  resolve(adapterId) {
    const id = String(adapterId || "manual").trim().toLowerCase() || "manual";
    if (id === "manual") return this.manual;
    if (id === "mock-dry-run" || id === "mock") return this.mock;
    if (id === "codex-cli" || id === "codex") return this.codexCli;
    return new ExternalGatedAdapter(id);
  }

  probeAll(config = {}) {
    const opts = this._opts(config);
    return [
      this.manual.probe(opts),
      this.codexCli.probe(opts),
      this.mock.probe(opts),
      new ExternalGatedAdapter("external-account").probe(opts),
    ];
  }

  probe(adapterId, config = {}) {
    return this.resolve(adapterId).probe(this._opts(config));
  }

  launch(adapterId, ctx, config = {}) {
    return this.resolve(adapterId).launch(ctx, this._opts(config));
  }
}

module.exports = {
  ManualAdapter,
  MockDryRunAdapter,
  CodexCliAdapter,
  ExternalGatedAdapter,
  AdapterRegistry,
};
