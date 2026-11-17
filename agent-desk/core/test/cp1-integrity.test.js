"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { Desk, parseMarker, forwardText } = require("../desk.js");
const {
  buildRetMondayCarbonScenario,
  buildHistoricalSnapshot216,
} = require("./fixtures/synthetic-program.js");

const CLI_ENTRY = path.resolve(__dirname, "../cli.js");
const MCP_ENTRY = path.resolve(__dirname, "../mcp.js");

async function createIsolatedNode(name = "NodeA", preState = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ad-cp1-${name}-`));
  const dataDir = path.join(root, "data");
  const inbox = path.join(root, "inbox");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  if (preState) {
    if (preState.config) fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(preState.config, null, 2));
    if (preState.state) fs.writeFileSync(path.join(dataDir, "state.json"), JSON.stringify(preState.state));
  }
  const desk = new Desk({
    dataDir,
    webDir: path.resolve(__dirname, "../../web"),
    legacyDir: null,
    port: 0,
    lan: false,
    discovery: false,
    graceMs: 0,
    pollMs: 3600000,
    log: () => {},
  });
  if (!preState?.config?.watch) {
    desk.config.watch = [{ path: inbox, project: "Synthetic-SSJC" }];
  }
  desk.config.device_name = name;
  await desk.start();
  desk.peers.stop();
  desk.config.port = desk.boundPort;
  desk._saveConfig();
  return {
    desk,
    root,
    dataDir,
    inbox,
    port: desk.boundPort,
    async cleanup() {
      await desk.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function httpCall(port, route, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: route,
      method: body !== undefined && method === "GET" ? "POST" : method,
      headers: {
        host: `127.0.0.1:${port}`,
        ...(raw !== null ? { "content-type": "application/json", "x-agent-desk": "1", "content-length": Buffer.byteLength(raw) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = null;
        try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end(raw);
  });
}

function runCliCmd(args, home, stdinText = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: { ...process.env, AGENT_DESK_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr, json: stdout.trim() ? JSON.parse(stdout) : null }));
    child.stdin.end(stdinText);
  });
}

function pairNodes(a, b) {
  a.desk.config.peers = [{ id: b.desk.config.device_id, name: b.desk.peers.name, base: `http://127.0.0.1:${b.port}`, key: "1".repeat(32), my_key: "2".repeat(32) }];
  b.desk.config.peers = [{ id: a.desk.config.device_id, name: a.desk.peers.name, base: `http://127.0.0.1:${a.port}`, key: "2".repeat(32), my_key: "1".repeat(32) }];
  a.desk._saveConfig();
  b.desk._saveConfig();
}

test("CP1-1: identity chain includes project_id in forward_text, read resolves task UUID + todo, 7 lifecycle signs advance only on real actions, and same title never links or ACKs", async () => {
  const node = await createIsolatedNode("CP1-Identity");
  try {
    const agentHeaders = { "x-agent-desk-agent-key": node.desk.config.agent_key };
    const created = (await httpCall(node.port, "/api/tasks/assign", {
      body: {
        project: "Synthetic-SSJC",
        title: "Общее имя задачи",
        prompt: "Промпт первой задачи",
        agent: "Carbon",
        device_id: node.desk.config.device_id,
        session_id: "sess-1",
        role: "executor",
      },
    })).data;
    const secondSameTitle = (await httpCall(node.port, "/api/tasks/assign", {
      body: {
        project: "Synthetic-SSJC",
        title: "Общее имя задачи",
        prompt: "Промпт второй независимой задачи с тем же заголовком",
        agent: "Carbon",
        device_id: node.desk.config.device_id,
        session_id: "sess-2",
        role: "executor",
      },
    })).data;

    assert.notEqual(created.task_id, secondSameTitle.task_id);
    assert.equal(created.project_id, secondSameTitle.project_id);

    // Read by task_id UUID directly must return both task (with card_id & lifecycle_signs) and todo (with forward_text containing project_id)
    const readByTaskUuid = await httpCall(node.port, `/api/agent/read?id=${created.task_id}`, { headers: agentHeaders });
    assert.equal(readByTaskUuid.status, 200);
    assert.ok(readByTaskUuid.data.todo, "read by task UUID must include linked assignment todo");
    assert.equal(readByTaskUuid.data.todo.message_id, created.assignment_message_id);
    assert.ok(readByTaskUuid.data.task.card_id);
    const ft = readByTaskUuid.data.todo.forward_text;
    for (const expectedField of [
      `project_id: ${created.project_id}`,
      `task_id: ${created.task_id}`,
      "assignment_epoch: 1",
      "session_id: sess-1",
      `device_id: ${node.desk.config.device_id}`,
      `message_id: ${created.assignment_message_id}`,
    ]) {
      assert.ok(ft.includes(expectedField), `forward_text missing: ${expectedField}`);
    }

    // Check initial 7 lifecycle signs: only on_board & needs_forward are true
    assert.deepEqual(readByTaskUuid.data.task.lifecycle_signs, {
      on_board: true,
      needs_forward: true,
      forwarded: false,
      recipient_acked: false,
      executing: false,
      submitted: false,
      accepted: false,
    });

    // Mark first todo forwarded by owner
    const todo1 = node.desk.state.todos.find((t) => t.message_id === created.assignment_message_id);
    await httpCall(node.port, `/api/todo/${todo1.id}/forwarded`, { body: {} });
    const afterForward = (await httpCall(node.port, `/api/agent/read?id=${created.task_id}`, { headers: agentHeaders })).data.task.lifecycle_signs;
    assert.equal(afterForward.forwarded, true);
    assert.equal(afterForward.needs_forward, false);
    assert.equal(afterForward.recipient_acked, false);

    // Same-title working marker on task 2 WITHOUT ack must NOT implicitly ACK task 1!
    const work2 = await httpCall(node.port, "/api/agent/submit", {
      headers: agentHeaders,
      body: {
        project: "Synthetic-SSJC",
        project_id: secondSameTitle.project_id,
        agent: "Carbon",
        state: "working",
        execution_state: "working",
        task_id: secondSameTitle.task_id,
        assignment_epoch: 1,
        session_id: "sess-2",
        task: "Общее имя задачи",
      },
    });
    assert.equal(work2.status, 200);
    assert.equal(node.desk.state.todos.find((t) => t.message_id === created.assignment_message_id).acked_at, null, "same title must never implicitly ACK another task");
    // Even task 1 working WITHOUT explicit ack must NOT set recipient_acked on managed assignment!
    await httpCall(node.port, "/api/agent/submit", {
      headers: agentHeaders,
      body: {
        project: "Synthetic-SSJC",
        project_id: created.project_id,
        agent: "Carbon",
        state: "working",
        execution_state: "working",
        task_id: created.task_id,
        assignment_epoch: 1,
        session_id: "sess-1",
        task: "Общее имя задачи",
      },
    });
    const afterWorkNoAck = (await httpCall(node.port, `/api/agent/read?id=${created.task_id}`, { headers: agentHeaders })).data.task.lifecycle_signs;
    assert.equal(afterWorkNoAck.executing, true);
    assert.equal(afterWorkNoAck.recipient_acked, false, "working without explicit ack must not forge recipient_acked");

    // Explicit ACK advances recipient_acked
    const ackRes = await httpCall(node.port, "/api/agent/ack", {
      headers: agentHeaders,
      body: {
        project: "Synthetic-SSJC",
        agent: "Carbon",
        session_id: "sess-1",
        assignment_epoch: 1,
        message_id: created.assignment_message_id,
      },
    });
    assert.equal(ackRes.status, 200);
    const afterAck = (await httpCall(node.port, `/api/agent/read?id=${created.task_id}`, { headers: agentHeaders })).data.task.lifecycle_signs;
    assert.equal(afterAck.recipient_acked, true);
  } finally {
    await node.cleanup();
  }
});

test("CP1-2: idempotent retry after timeout/double-click, ACK before/after forward, repeated ACK, rework/resubmission, and _trimTodos protection", async () => {
  const node = await createIsolatedNode("CP1-Idempotency");
  try {
    const agentHeaders = { "x-agent-desk-agent-key": node.desk.config.agent_key };
    // 1. Create with request_id + duplicate retry (simulating dropped HTTP response / double click)
    const createBody = {
      request_id: "req-assign-001",
      project: "Synthetic-SSJC",
      title: "Idempotent task",
      prompt: "Initial prompt text",
      agent: "Astra",
      device_id: node.desk.config.device_id,
      session_id: "astra-s1",
      role: "executor",
    };
    const r1 = await httpCall(node.port, "/api/tasks/assign", { body: createBody });
    const r2 = await httpCall(node.port, "/api/tasks/assign", { body: createBody });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r1.data.task_id, r2.data.task_id);
    assert.equal(r1.data.assignment.epoch, 1);
    assert.equal(r2.data.assignment.epoch, 1);
    assert.equal(Object.keys(node.desk.state.tasks).length, 1);
    assert.equal(node.desk.state.todos.length, 1);

    // Same request_id with DIFFERENT title must fail 409
    const rConflict = await httpCall(node.port, "/api/tasks/assign", { body: { ...createBody, title: "Different title" } });
    assert.equal(rConflict.status, 409);

    // 2. Handoff + exact retry WITHOUT request_id (client timed out at epoch 1 and retried identical handoff)
    const handoffBody = {
      task_id: r1.data.task_id,
      assignment_epoch: 1,
      agent: "Carbon",
      device_id: node.desk.config.device_id,
      session_id: "carbon-s2",
      role: "executor",
      prompt: "Updated handoff prompt",
      checkpoint: { next_step: "Verify idempotent handoff retry" },
    };
    const h1 = await httpCall(node.port, "/api/tasks/handoff", { body: handoffBody });
    assert.equal(h1.status, 200);
    assert.equal(h1.data.assignment.epoch, 2);
    const hRetry = await httpCall(node.port, "/api/tasks/handoff", { body: handoffBody });
    assert.equal(hRetry.status, 200, "exact retry of handoff on epoch-1 must safely return existing epoch-2 task");
    assert.equal(hRetry.data.assignment.epoch, 2);
    assert.equal(hRetry.data.assignment_message_id, h1.data.assignment_message_id);

    // Stale handoff with DIFFERENT session on epoch 1 must still reject with 409!
    const hStaleDiff = await httpCall(node.port, "/api/tasks/handoff", {
      body: { ...handoffBody, session_id: "carbon-different-s3" },
    });
    assert.equal(hStaleDiff.status, 409);

    // 3. ACK BEFORE manual forwarded_at + repeated ACK idempotency (zero journal churn)
    const ack1 = await httpCall(node.port, "/api/agent/ack", {
      headers: agentHeaders,
      body: { project: "Synthetic-SSJC", agent: "Carbon", session_id: "carbon-s2", assignment_epoch: 2, message_id: h1.data.assignment_message_id },
    });
    assert.equal(ack1.status, 200);
    const clockAfterFirstAck = node.desk.sync.journal.clock;
    const ack2 = await httpCall(node.port, "/api/agent/ack", {
      headers: agentHeaders,
      body: { project: "Synthetic-SSJC", agent: "Carbon", session_id: "carbon-s2", assignment_epoch: 2, message_id: h1.data.assignment_message_id },
    });
    assert.equal(ack2.status, 200);
    assert.equal(ack2.data.acked_at, ack1.data.acked_at);
    assert.equal(node.desk.sync.journal.clock, clockAfterFirstAck, "repeated identical ACK must not churn journal");

    // 4. Submit -> Rework -> Resubmit preserves task_id and card_id
    const cardBefore = node.desk.state.task_card_ids[r1.data.task_id];
    await httpCall(node.port, "/api/agent/submit", {
      headers: agentHeaders,
      body: { project: "Synthetic-SSJC", agent: "Carbon", state: "done", execution_state: "submitted", task_id: r1.data.task_id, assignment_epoch: 2, session_id: "carbon-s2", to: "Codex", message: "v1 submission" },
    });
    assert.equal(node.desk.state.tasks[r1.data.task_id].state, "submitted");
    const rework = await httpCall(node.port, "/api/tasks/transition", {
      body: { task_id: r1.data.task_id, project: "Synthetic-SSJC", agent: "Carbon", device_id: node.desk.config.device_id, session_id: "carbon-s2", assignment_epoch: 2, state: "rework", note: "Add negative test" },
    });
    assert.equal(rework.status, 200);
    assert.equal(rework.data.state, "rework");
    await httpCall(node.port, "/api/agent/submit", {
      headers: agentHeaders,
      body: { project: "Synthetic-SSJC", agent: "Carbon", state: "done", execution_state: "submitted", task_id: r1.data.task_id, assignment_epoch: 2, session_id: "carbon-s2", to: "Codex", message: "v2 resubmission" },
    });
    assert.equal(node.desk.state.tasks[r1.data.task_id].state, "submitted");
    assert.equal(node.desk.state.task_card_ids[r1.data.task_id], cardBefore);

    // 5. _trimTodos protection: 170 closed unrelated todos must NOT delete active task's assignment_message_id!
    for (let i = 0; i < 170; i++) {
      const ev = parseMarker(JSON.stringify({ agent: "Helper", state: "done", to: "Codex", task: `Noise ${i}`, message: `msg ${i}` }), "Synthetic-SSJC");
      node.desk.applyEvent(ev);
      const lastTodo = node.desk.state.todos.at(-1);
      lastTodo.done_at = new Date(Date.now() + 10000 + i).toISOString();
    }
    node.desk._trimTodos();
    assert.ok(
      node.desk.state.todos.some((t) => t.message_id === h1.data.assignment_message_id),
      "active task assignment_message_id must survive _trimTodos beyond 150 closed items"
    );
  } finally {
    await node.cleanup();
  }
});

test("CP1-3: 216-task historical snapshot separates 207 migrated legacy cards from active managed assignments and supports cancel/archive with reason", async () => {
  const snap = buildHistoricalSnapshot216("1111111111111111");
  const node = await createIsolatedNode("CP1-Hist216", {
    config: { device_id: "1111111111111111", watch: [] },
    state: snap.state,
  });
  try {
    const payload = node.desk.payload();
    assert.equal(payload.tasks.length, 216);
    const migrated = payload.tasks.filter((t) => t.origin_kind === "migrated");
    const managed = payload.tasks.filter((t) => t.origin_kind === "managed");
    assert.equal(migrated.length, 207);
    assert.equal(managed.length, 9);

    // Active accounting: only the 6 non-accepted/non-submitted managed tasks (#208, #209, #210, #211, #213, #214) are active_work!
    const activeWork = payload.tasks.filter((t) => t.active_work);
    assert.equal(activeWork.length, 6, "207 legacy unmanaged assigned stubs must not inflate active_work");
    const needsForward = payload.tasks.filter((t) => t.lifecycle_signs?.needs_forward);
    assert.equal(needsForward.length, 1, "only #208 (unforwarded managed assignment) needs forwarding");

    // Cancel #208 requires a reason, retires its open assignment todo, and records status_reason
    const target = needsForward[0];
    const noReason = await httpCall(node.port, "/api/tasks/transition", {
      body: {
        task_id: target.task_id,
        project: target.project,
        agent: target.assignment.agent,
        device_id: target.assignment.device_id,
        session_id: target.assignment.session_id,
        assignment_epoch: target.assignment.epoch,
        state: "cancelled",
      },
    });
    assert.equal(noReason.status, 400, "cancelling without reason must be rejected");

    const cancelled = await httpCall(node.port, "/api/tasks/transition", {
      body: {
        task_id: target.task_id,
        project: target.project,
        agent: target.assignment.agent,
        device_id: target.assignment.device_id,
        session_id: target.assignment.session_id,
        assignment_epoch: target.assignment.epoch,
        state: "cancelled",
        note: "Дубликат тестового поручения",
      },
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.data.state, "cancelled");
    assert.equal(cancelled.data.status_reason, "Дубликат тестового поручения");
    const retiredTodo = node.desk.state.todos.find((t) => t.message_id === target.assignment_message_id);
    assert.ok(retiredTodo.done_at, "cancelling task must close its unforwarded assignment reminder");

    // Archive one of the legacy cards explicitly (coordinator action without worker session requirement)
    const legacyCard = migrated[0];
    const archived = await httpCall(node.port, "/api/tasks/transition", {
      body: {
        task_id: legacyCard.task_id,
        project: legacyCard.project,
        assignment_epoch: 1,
        state: "archived",
        note: "Исторический импорт проверен и отправлен в архив",
      },
    });
    assert.equal(archived.status, 200);
    assert.equal(archived.data.state, "archived");
    assert.equal(archived.data.status_reason, "Исторический импорт проверен и отправлен в архив");
  } finally {
    await node.cleanup();
  }
});

test("CP1-4: role enforcement, wrong marker device_id rejection, dual-device coordination transfer/return, and CLI/MCP/marker/UI parity", async () => {
  const pc = await createIsolatedNode("LeadPC");
  const laptop = await createIsolatedNode("LeadLaptop");
  try {
    pairNodes(pc, laptop);
    // Assign via CLI on LeadPC
    const cliAssign = await runCliCmd([
      "assign",
      "--project=Synthetic-SSJC",
      "--title=Parity & Coordination Task",
      "--prompt=Verify all four adapters and coordinator return",
      "--agent=Carbon",
      `--device-id=${pc.desk.config.device_id}`,
      "--session-id=carbon-parity-1",
    ], pc.dataDir);
    assert.equal(cliAssign.code, 0, cliAssign.stdout);
    const taskId = cliAssign.json.task_id;

    // File marker with WRONG device_id in inbox must be rejected (not silently overwritten by local device_id!)
    const badMarkerFile = path.join(pc.inbox, "wrong-device.json");
    fs.writeFileSync(badMarkerFile, JSON.stringify({
      project: "Synthetic-SSJC",
      agent: "Carbon",
      state: "working",
      execution_state: "working",
      task_id: taskId,
      assignment_epoch: 1,
      session_id: "carbon-parity-1",
      device_id: "deadbeefdeadbeef",
      ack: [cliAssign.json.assignment_message_id],
      seq: 1,
    }));
    pc.desk.scanOnce();
    assert.equal(pc.desk.state.rejected.length, 1, "marker claiming wrong device_id must be rejected");
    assert.equal(pc.desk.state.todos[0].acked_at, null, "rejected marker must not ACK assignment");

    // Valid file marker moves task to working and ACKs
    fs.writeFileSync(path.join(pc.inbox, "valid-work.json"), JSON.stringify({
      project: "Synthetic-SSJC",
      agent: "Carbon",
      state: "working",
      execution_state: "working",
      task_id: taskId,
      assignment_epoch: 1,
      session_id: "carbon-parity-1",
      device_id: pc.desk.config.device_id,
      ack: [cliAssign.json.assignment_message_id],
      seq: 2,
    }));
    pc.desk.scanOnce();
    assert.equal(pc.desk.state.tasks[taskId].state, "working");
    assert.ok(pc.desk.state.todos[0].acked_at);

    // Submit via MCP
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_ENTRY, "--home", pc.dataDir],
      env: { ...process.env, AGENT_DESK_HOME: pc.dataDir },
      stderr: "pipe",
    });
    const mcpClient = new Client({ name: "cp1-parity", version: "1.0.0" }, { capabilities: {} });
    try {
      await mcpClient.connect(transport);
      const sub = await mcpClient.callTool({
        name: "agent_desk_submit",
        arguments: {
          project: "Synthetic-SSJC",
          agent: "Carbon",
          state: "done",
          execution_state: "submitted",
          task_id: taskId,
          assignment_epoch: 1,
          session_id: "carbon-parity-1",
          device_id: pc.desk.config.device_id,
          to: "Codex",
          message: "Submitted via MCP",
          seq: 3,
        },
      });
      assert.equal(sub.isError, undefined);
      assert.equal(pc.desk.state.tasks[taskId].state, "submitted");
    } finally {
      await mcpClient.close();
    }

    // Sync to Laptop; Laptop CANNOT accept while LeadPC is coordinator!
    await pc.desk.peers.sync(laptop.desk.config.device_id);
    const unauthorizedAccept = await httpCall(laptop.port, "/api/tasks/transition", {
      body: {
        task_id: taskId,
        project: "Synthetic-SSJC",
        agent: "Carbon",
        device_id: pc.desk.config.device_id,
        session_id: "carbon-parity-1",
        assignment_epoch: 1,
        state: "accepted",
      },
    });
    assert.equal(unauthorizedAccept.status, 403);

    // LeadPC explicitly transfers coordination to LeadLaptop
    const transfer = await httpCall(pc.port, "/api/tasks/coordinate", {
      body: {
        task_id: taskId,
        assignment_epoch: 1,
        coordinator_device_id: laptop.desk.config.device_id,
        note: "Продолжаю координацию с ноутбука",
      },
    });
    assert.equal(transfer.status, 200);
    assert.equal(transfer.data.coordinator_device_id, laptop.desk.config.device_id);
    assert.equal(transfer.data.coordinator_epoch, 2);

    await pc.desk.peers.sync(laptop.desk.config.device_id);
    assert.equal(laptop.desk.state.tasks[taskId].coordinator_device_id, laptop.desk.config.device_id);

    // LeadLaptop requests rework, then returns coordination back to LeadPC!
    const lapRework = await httpCall(laptop.port, "/api/tasks/transition", {
      body: {
        task_id: taskId,
        project: "Synthetic-SSJC",
        agent: "Carbon",
        device_id: pc.desk.config.device_id,
        session_id: "carbon-parity-1",
        assignment_epoch: 1,
        state: "rework",
        note: "Проверено с ноутбука",
      },
    });
    assert.equal(lapRework.status, 200);

    const returnCoord = await httpCall(laptop.port, "/api/tasks/coordinate", {
      body: {
        task_id: taskId,
        assignment_epoch: 1,
        coordinator_device_id: pc.desk.config.device_id,
        note: "Возврат координации на основной ПК",
      },
    });
    assert.equal(returnCoord.status, 200);
    assert.equal(returnCoord.data.coordinator_epoch, 3);

    await laptop.desk.peers.sync(pc.desk.config.device_id);
    assert.equal(pc.desk.state.tasks[taskId].coordinator_device_id, pc.desk.config.device_id);
    assert.equal(pc.desk.state.tasks[taskId].state, "rework");
  } finally {
    await pc.cleanup();
    await laptop.cleanup();
  }
});

test("CP1-5 (Gate): 'Ret -> monday.com -> Carbon' chain with 2 stale senders, retry and restart yields 1 active task, 1 current prompt (epoch=3), full history and 0 false ACKs/submissions", async () => {
  const scenario = buildRetMondayCarbonScenario();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-cp1-gate-"));
  const dataDir = path.join(root, "data");
  const inbox = path.join(root, "inbox");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });

  let desk = new Desk({
    dataDir,
    legacyDir: null,
    port: 0,
    lan: false,
    discovery: false,
    graceMs: 0,
    pollMs: 3600000,
    log: () => {},
  });
  desk.config.device_id = scenario.epochs[0].device_id;
  desk.config.watch = [{ path: inbox, project: scenario.project }];
  await desk.start();
  desk.peers.stop();

  try {
    const agentHeaders = { "x-agent-desk-agent-key": desk.config.agent_key };
    const [e1, e2, e3] = scenario.epochs;

    // Epoch 1: Assign to Ret
    const t1 = (await httpCall(desk.boundPort, "/api/tasks/assign", {
      body: {
        project: scenario.project,
        project_id: scenario.project_id,
        title: scenario.title,
        prompt: e1.prompt,
        agent: e1.agent,
        device_id: e1.device_id,
        session_id: e1.session_id,
        role: e1.role,
      },
    })).data;
    const taskId = t1.task_id;
    assert.equal(t1.assignment.epoch, 1);

    // Handoff Epoch 1 -> Epoch 2 (monday.com)
    const t2 = (await httpCall(desk.boundPort, "/api/tasks/handoff", {
      body: {
        task_id: taskId,
        assignment_epoch: 1,
        agent: e2.agent,
        device_id: e2.device_id,
        session_id: e2.session_id,
        role: e2.role,
        prompt: e2.prompt,
      },
    })).data;
    assert.equal(t2.assignment.epoch, 2);

    // Handoff Epoch 2 -> Epoch 3 (Carbon), plus duplicate timeout retry!
    const handoff3Body = {
      task_id: taskId,
      assignment_epoch: 2,
      agent: e3.agent,
      device_id: e3.device_id,
      session_id: e3.session_id,
      role: e3.role,
      prompt: e3.prompt,
      checkpoint: { next_step: "Carbon executes epoch 3" },
    };
    const t3 = (await httpCall(desk.boundPort, "/api/tasks/handoff", { body: handoff3Body })).data;
    const t3Retry = (await httpCall(desk.boundPort, "/api/tasks/handoff", { body: handoff3Body })).data;
    assert.equal(t3.assignment.epoch, 3);
    assert.equal(t3Retry.assignment.epoch, 3);
    assert.equal(t3Retry.assignment_message_id, t3.assignment_message_id);

    // Stale Sender #1 (Ret, epoch 1) tries to ACK and submit done
    const staleAck1 = await httpCall(desk.boundPort, "/api/agent/ack", {
      headers: agentHeaders,
      body: { project: scenario.project, agent: e1.agent, session_id: e1.session_id, assignment_epoch: 1, message_id: t1.assignment_message_id },
    });
    assert.equal(staleAck1.status, 409);
    const staleSub1 = await httpCall(desk.boundPort, "/api/agent/submit", {
      headers: agentHeaders,
      body: { project: scenario.project, agent: e1.agent, state: "done", execution_state: "submitted", task_id: taskId, assignment_epoch: 1, session_id: e1.session_id, to: "Codex", message: "Late Ret report" },
    });
    assert.equal(staleSub1.status, 403, "retired different agent Ret is rejected with 403");
    const staleSameAgentOldEpoch = await httpCall(desk.boundPort, "/api/agent/submit", {
      headers: agentHeaders,
      body: { project: scenario.project, agent: e3.agent, state: "done", execution_state: "submitted", task_id: taskId, assignment_epoch: 2, session_id: e3.session_id, to: "Codex", message: "Stale epoch Carbon report" },
    });
    assert.equal(staleSameAgentOldEpoch.status, 409, "same agent with stale epoch is rejected with 409");

    // Stale Sender #2 (monday.com, epoch 2) tries to submit working/done via file marker AND HTTP
    fs.writeFileSync(path.join(inbox, "stale-monday.json"), JSON.stringify({
      project: scenario.project,
      agent: e2.agent,
      state: "done",
      execution_state: "submitted",
      task_id: taskId,
      assignment_epoch: 2,
      session_id: e2.session_id,
      device_id: e2.device_id,
      ack: [t2.assignment_message_id, t3.assignment_message_id],
      to: "Codex",
      message: "Late monday.com submission",
    }));
    desk.scanOnce();
    assert.equal(desk.state.rejected.length, 1);
    assert.equal(desk.state.tasks[taskId].state, "assigned", "stale monday.com marker must not submit task");
    assert.equal(desk.state.todos.find((t) => t.message_id === t3.assignment_message_id).acked_at, null, "stale marker must not ACK epoch 3");

    // Carbon (epoch 3) sends real ACK + working
    const carbonWork = await httpCall(desk.boundPort, "/api/agent/submit", {
      headers: agentHeaders,
      body: {
        project: scenario.project,
        project_id: scenario.project_id,
        agent: e3.agent,
        state: "working",
        execution_state: "working",
        task_id: taskId,
        assignment_epoch: 3,
        session_id: e3.session_id,
        device_id: e3.device_id,
        ack: [t3.assignment_message_id],
        seq: 1,
        note: "Carbon started epoch 3",
      },
    });
    assert.equal(carbonWork.status, 200);

    // Full server restart
    await desk.stop();
    desk = new Desk({
      dataDir,
      legacyDir: null,
      port: 0,
      lan: false,
      discovery: false,
      graceMs: 0,
      pollMs: 3600000,
      log: () => {},
    });
    await desk.start();
    desk.peers.stop();

    const payload = desk.payload();
    const activeTasks = payload.tasks.filter((t) => t.active_work);
    assert.equal(payload.tasks.length, 1, "exactly 1 task UUID across the entire chain");
    assert.equal(activeTasks.length, 1, "exactly 1 active task");
    assert.equal(activeTasks[0].task_id, taskId);
    assert.equal(activeTasks[0].state, "working");
    assert.equal(activeTasks[0].assignment.agent, "Carbon");
    assert.equal(activeTasks[0].assignment.epoch, 3);

    const nonSupersededAssignmentTodos = payload.todos.filter((t) => t.purpose === "assignment" && !t.superseded_by);
    assert.equal(nonSupersededAssignmentTodos.length, 1, "exactly 1 current assignment prompt");
    assert.equal(nonSupersededAssignmentTodos[0].message_id, t3.assignment_message_id);
    assert.ok(nonSupersededAssignmentTodos[0].acked_at, "Carbon's real ACK is preserved after restart");
    assert.equal(nonSupersededAssignmentTodos[0].acked_by, "Carbon");

    // Verify zero false ACKs on retired epochs 1 & 2 and zero false submissions
    assert.equal(payload.todos.find((t) => t.message_id === t1.assignment_message_id).acked_at, null);
    assert.equal(payload.todos.find((t) => t.message_id === t2.assignment_message_id).acked_at, null);
    assert.equal(payload.todos.filter((t) => t.agent === "Ret" || t.agent === "monday.com").length, 0, "zero false report cards from stale senders");
    assert.ok(activeTasks[0].history.length >= 4, "all 3 assignment/handoff epochs + Carbon working preserved in history");
  } finally {
    await desk.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
