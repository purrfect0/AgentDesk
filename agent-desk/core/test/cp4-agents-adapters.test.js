"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { Desk, parseMarker } = require("../desk.js");

function callHttp(port, { method = "GET", path: reqPath = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: reqPath,
      headers: { host: `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* ignore */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

const postOwner = (port, reqPath, body) => callHttp(port, {
  method: "POST",
  path: reqPath,
  headers: { "content-type": "application/json", "x-agent-desk": "1" },
  body,
});

test("CP4-3 Agent registry: aliases, non-fabricated capabilities, verified channel, pause/archive guard, stale vs event-driven limit, and session rotation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-cp4-reg-"));
  const desk = new Desk({
    dataDir: path.join(root, "data"),
    legacyDir: null,
    port: 0,
    lan: false,
    graceMs: 0,
    discovery: false,
    pollMs: 600000,
    log: () => {},
  });
  desk.config.stale_minutes = 15;
  await desk.start();
  const port = desk.boundPort;

  try {
    // 1. Registering an agent named after a provider NEVER invents capabilities when capabilities are omitted
    const r1 = await postOwner(port, "/api/agents/registry", {
      project: "RegProj",
      entry: {
        name: "Claude Opus (1)",
        aliases: ["опус1", "opus-one"],
        status: "active",
        session_id: "opus-s1",
        role: "executor",
      },
    });
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.json.entries[0].capabilities, [], "Capabilities must never be guessed from provider/model name");
    assert.equal(r1.json.entries[0].verified_channel, "");
    assert.equal(desk.canonical("RegProj", "опус1"), "Claude Opus (1)");

    // 2. Submitting via Agent CLI verifies channel = "cli_or_mcp"
    const task = desk.tasks.assign({
      project: "RegProj",
      title: "Проверка смены сессии при лимите",
      agent: "Claude Opus (1)",
      device_id: desk.config.device_id,
      session_id: "opus-s1",
      role: "executor",
      prompt: "Выполнить проверку реестра",
    });

    const submitRes = await callHttp(port, {
      method: "POST",
      path: "/api/agent/submit",
      headers: {
        "x-agent-desk-agent-key": desk.config.agent_key,
        "content-type": "application/json",
        "x-agent-desk": "1",
      },
      body: {
        project: "RegProj",
        project_id: task.project_id,
        agent: "опус1",
        session_id: "opus-s1",
        device_id: desk.config.device_id,
        task_id: task.task_id,
        assignment_epoch: 1,
        seq: 1,
        state: "working",
        execution_state: "working",
        ack: [task.assignment_message_id],
      },
    });
    assert.equal(submitRes.status, 200);
    assert.equal(desk.config.agent_registry.RegProj[0].verified_channel, "cli_or_mcp");

    // 3. Silence > stale_minutes never mutates agent state to stopped/limit
    const staleIso = new Date(Date.now() - 40 * 60000).toISOString();
    desk.state.agents["RegProj/Claude Opus (1)"].updated = staleIso;
    assert.equal(desk.state.agents["RegProj/Claude Opus (1)"].state, "working");

    // 4. Model limit occurs ONLY via explicit event -> creates limit todo -> rotate-session hands off & closes limit todo!
    desk.applyEvent(parseMarker(JSON.stringify({
      project: "RegProj",
      project_id: task.project_id,
      agent: "Claude Opus (1)",
      session_id: "opus-s1",
      device_id: desk.config.device_id,
      task_id: task.task_id,
      assignment_epoch: 1,
      seq: 2,
      state: "waiting",
      waiting_for: "model_limit",
      task: task.title,
      note: "Достигнут лимит токенов",
    }), "RegProj"));
    const limitTodo = desk.state.todos.find((t) => t.kind === "limit" && !t.done_at);
    assert.ok(limitTodo, "Explicit model_limit event creates limit todo");

    const rot = await postOwner(port, "/api/agents/rotate-session", {
      project: "RegProj",
      agent: "Claude Opus (1)",
      new_session_id: "opus-s2-rotated",
    });
    assert.equal(rot.status, 200);
    assert.equal(rot.json.session_id, "opus-s2-rotated");
    assert.equal(rot.json.task.assignment.session_id, "opus-s2-rotated");
    assert.equal(rot.json.task.assignment.epoch, 2);
    assert.ok(desk.state.todos.find((t) => t.id === limitTodo.id).done_at, "Limit reminder closed upon session rotation");

    // 5. Pausing or archiving blocks new assignments while keeping history intact
    await postOwner(port, "/api/agents/registry", {
      project: "RegProj",
      entry: { name: "Claude Opus (1)", status: "paused" },
    });
    const blockedAssign = await postOwner(port, "/api/tasks/assign", {
      project: "RegProj",
      title: "Новая задача для агента на паузе",
      agent: "Claude Opus (1)",
      device_id: desk.config.device_id,
      session_id: "opus-s3",
    });
    assert.equal(blockedAssign.status, 409);
    assert.match(blockedAssign.json.error, /paused/);
  } finally {
    await desk.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CP4-3 Handoff/handback/reopen: verification_steps as plain text, OUT/manifest, JSON handoff export, handback submission, and standard API reopen", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-cp4-ho-"));
  const desk = new Desk({
    dataDir: path.join(root, "data"),
    legacyDir: null,
    port: 0,
    lan: false,
    graceMs: 0,
    discovery: false,
    pollMs: 600000,
    log: () => {},
  });
  await desk.start();
  const port = desk.boundPort;

  try {
    const t = desk.tasks.assign({
      project: "HoProj",
      title: "Подготовить кандидат",
      agent: "Astra",
      device_id: desk.config.device_id,
      session_id: "astra-1",
      role: "executor",
    });
    const handed = desk.tasks.handoff({
      task_id: t.task_id,
      project: "HoProj",
      project_id: t.project_id,
      assignment_epoch: 1,
      agent: "Carbon",
      device_id: desk.config.device_id,
      session_id: "carbon-2",
      role: "executor",
      checkpoint: {
        branch: "carbon/stabilization",
        commit: "1b12a53c8f7dae4de9ae2c4302a3ee3c66b8e170",
        out_dir: "OUT",
        report: "OUT/REPORT.md",
        manifest: [{ path: "OUT/REPORT.md", sha256: "a".repeat(64), status: "expected" }],
        verification_steps: ["npm test", "node --test web/linked-ui.test.js"],
        next_step: "Прогнать проверки и сдать отчёт",
        constraints: ["Без настоящих ключей"],
      },
    });
    assert.deepEqual(handed.checkpoint.verification_steps, ["npm test", "node --test web/linked-ui.test.js"]);
    assert.equal(handed.checkpoint.out_dir, "OUT");

    const ctx = desk.tasks.context(handed.task_id);
    assert.match(ctx.text, /never run automatically by Agent Desk/);
    assert.match(ctx.text, /npm test/);

    const pkgRes = await callHttp(port, { path: `/api/tasks/handoff-json?id=${handed.task_id}` });
    assert.equal(pkgRes.status, 200);
    assert.equal(pkgRes.json.schema, "agent-desk.handoff.v1");
    assert.equal(pkgRes.json.task.assignment_epoch, 2);

    // External agent fills handback_template and submits via parseMarker/applyEvent
    const hb = {
      ...pkgRes.json.handback_template,
      message: "Все проверки зелёные, отчёт в OUT/REPORT.md.",
      checkpoint: {
        ...pkgRes.json.handback_template.checkpoint,
        commit: "fb2f19e30f97bf489694fb85d107a0fb6b970143",
      },
      artifacts: [{ path: "OUT/REPORT.md", sha256: "b".repeat(64), status: "submitted" }],
    };
    desk.applyEvent(parseMarker(JSON.stringify(hb), "HoProj"));
    assert.equal(desk.tasks.get(handed.task_id).state, "submitted");

    // Coordinator accepts -> archives -> reopens via standard /api/tasks/transition (state: "rework")!
    desk.tasks.transition({
      task_id: handed.task_id, project: "HoProj", project_id: handed.project_id,
      agent: "Carbon", device_id: desk.config.device_id, session_id: "carbon-2",
      assignment_epoch: 2, state: "accepted",
    });
    desk.tasks.transition({
      task_id: handed.task_id, project: "HoProj", project_id: handed.project_id,
      agent: "Carbon", device_id: desk.config.device_id, session_id: "carbon-2",
      assignment_epoch: 2, state: "archived", reason: "В архив после релиза",
    });
    assert.equal(desk.tasks.get(handed.task_id).state, "archived");

    const reopenRes = await postOwner(port, "/api/tasks/transition", {
      task_id: handed.task_id, project: "HoProj", project_id: handed.project_id,
      agent: "Carbon", device_id: desk.config.device_id, session_id: "carbon-2",
      assignment_epoch: 2, state: "rework", note: "Переоткрыто для дополнительной проверки",
    });
    assert.equal(reopenRes.status, 200);
    assert.equal(reopenRes.json.state, "rework");
    assert.equal(reopenRes.json.status_reason, undefined);
  } finally {
    await desk.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CP4-4 Mock dry-run adapter, external account gate, separate dispatch receipt vs ACK, and read-only server/phone resources", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-cp4-adp-"));
  const leaseFile = path.join(root, "server-lease.json");
  fs.writeFileSync(leaseFile, JSON.stringify({
    holder: "Opus (2)",
    task: "Perfetto benchmark",
    updated_at: new Date(Date.now() - 15000).toISOString(),
  }));

  const desk = new Desk({
    dataDir: path.join(root, "data"),
    legacyDir: null,
    port: 0,
    lan: false,
    graceMs: 0,
    discovery: false,
    pollMs: 600000,
    log: () => {},
  });
  desk.config.resource_status_files = {
    server: leaseFile,
    phone: path.join(root, "missing-phone-lease.json"),
  };
  await desk.start();
  const port = desk.boundPort;

  try {
    // 1. Adapter probe checks: manual & mock-dry-run available; external-account gated off by default
    const probeRes = await callHttp(port, { path: "/api/adapters/probe" });
    assert.equal(probeRes.status, 200);
    const byId = Object.fromEntries(probeRes.json.adapters.map((a) => [a.adapter, a]));
    assert.equal(byId.manual.available, true);
    assert.equal(byId["mock-dry-run"].available, true);
    assert.equal(byId["external-account"].available, false);
    assert.equal(byId["external-account"].requires_owner_opt_in, true);

    // 2. Task assigned with mock-dry-run is NOT auto-launched on assign; requires explicit POST /api/tasks/launch
    const task = desk.tasks.assign({
      project: "AdpProj",
      title: "Проверить dry-run запуск",
      agent: "Carbon",
      device_id: desk.config.device_id,
      session_id: "dry-s1",
      adapter: "mock-dry-run",
      prompt: "Промпт для проверки mock адаптера",
    });
    assert.equal(task.launch.status, "needs_manual_launch");

    // External account launch is blocked (403) without explicit owner opt-in
    const extBlocked = await postOwner(port, "/api/tasks/launch", {
      task_id: task.task_id, project: "AdpProj", assignment_epoch: 1, adapter: "external-cloud",
    });
    assert.equal(extBlocked.status, 403);

    // Explicit mock-dry-run launch records separate dispatched_at receipt WITHOUT setting acked_at or working!
    const launch1 = await postOwner(port, "/api/tasks/launch", {
      task_id: task.task_id, project: "AdpProj", assignment_epoch: 1, adapter: "mock-dry-run", request_id: "req-dry-1",
    });
    assert.equal(launch1.status, 200);
    assert.equal(launch1.json.receipt.status, "dispatched_dry_run");
    assert.equal(launch1.json.receipt.duplicate, false);
    assert.equal(launch1.json.receipt.ack_received, false);
    assert.equal(desk.tasks.get(task.task_id).state, "assigned", "Dispatch receipt must never advance task to working");
    const todo = desk.state.todos.find((t) => t.message_id === task.assignment_message_id);
    assert.ok(todo.launch_dispatched_at);
    assert.equal(todo.acked_at, null, "Dispatch receipt must stay strictly separate from recipient ACK");

    // Exact retry is idempotent (duplicate: true)
    const launch2 = await postOwner(port, "/api/tasks/launch", {
      task_id: task.task_id, project: "AdpProj", assignment_epoch: 1, adapter: "mock-dry-run", request_id: "req-dry-1",
    });
    assert.equal(launch2.status, 200);
    assert.equal(launch2.json.receipt.duplicate, true);
    assert.equal(launch2.json.receipt.launch_id, launch1.json.receipt.launch_id);

    // 3. Read-only resources: server shows BUSY + holder + freshness from lease_file; missing phone file shows UNKNOWN; lease file untouched!
    const beforeStat = fs.statSync(leaseFile).mtimeMs;
    const resStatus = await callHttp(port, { path: "/api/resources" });
    assert.equal(resStatus.status, 200);
    assert.equal(resStatus.json.server.read_only, true);
    assert.equal(resStatus.json.server.status, "BUSY");
    assert.equal(resStatus.json.server.holder, "Opus (2)");
    assert.equal(resStatus.json.server.source, "lease_file");
    assert.ok(Number.isFinite(resStatus.json.server.freshness_sec));
    assert.equal(resStatus.json.phone.status, "UNKNOWN");
    assert.equal(resStatus.json.phone.source, "lease_file_unavailable");
    assert.equal(fs.statSync(leaseFile).mtimeMs, beforeStat, "Read-only resource check must never write to lease files");
  } finally {
    await desk.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
