"use strict";
/**
 * Agent Desk launch adapter contract:
 * - Manual mode remains the default safe baseline.
 * - Local mock dry-run verifies availability (`probe`), requires an explicit owner launch action,
 *   guarantees idempotent dispatch results, and records a separate `dispatched_at` receipt
 *   strictly distinct from recipient `acked_at` and task `working` state.
 * - Real external accounts/providers remain disabled unless explicitly enabled by the owner.
 */
const crypto = require("node:crypto");

const nowIso = () => new Date().toISOString();

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
        ? `Внешний провайдер «${this.id}» разрешён владельцем, но боевой коннектор не подключён — используйте ручной режим или mock-dry-run.`
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
  constructor() {
    this.manual = new ManualAdapter();
    this.mock = new MockDryRunAdapter();
    this._mockUnavailable = false;
  }

  resolve(adapterId) {
    const id = String(adapterId || "manual").trim().toLowerCase() || "manual";
    if (id === "manual") return this.manual;
    if (id === "mock-dry-run" || id === "mock") return this.mock;
    return new ExternalGatedAdapter(id);
  }

  probeAll(config = {}) {
    const opts = {
      externalEnabled: config.external_adapters_enabled === true,
      simulateUnavailable: this._mockUnavailable,
    };
    return [
      this.manual.probe(opts),
      this.mock.probe(opts),
      new ExternalGatedAdapter("external-account").probe(opts),
    ];
  }

  probe(adapterId, config = {}) {
    return this.resolve(adapterId).probe({
      externalEnabled: config.external_adapters_enabled === true,
      simulateUnavailable: this._mockUnavailable,
    });
  }

  launch(adapterId, ctx, config = {}) {
    return this.resolve(adapterId).launch(ctx, {
      externalEnabled: config.external_adapters_enabled === true,
      simulateUnavailable: this._mockUnavailable,
    });
  }
}

module.exports = {
  ManualAdapter,
  MockDryRunAdapter,
  ExternalGatedAdapter,
  AdapterRegistry,
};
