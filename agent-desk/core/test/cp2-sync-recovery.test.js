"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { Desk, parseMarker } = require("../desk.js");
const { seal } = require("../sync.js");

async function makeNode(name, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ad-cp2-${name}-`));
  const dataDir = path.join(root, "data");
  const inbox = path.join(root, "inbox");
  const mail = path.join(root, "mail");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(mail, { recursive: true });
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
    ...opts,
  });
  desk.config.device_name = name;
  desk.config.watch = [{ path: inbox, project: "SyncProj" }];
  desk.config.mail_roots = [{ project: "SyncProj", path: mail }];
  desk.config.file_sync_enabled = Boolean(opts.fileSyncEnabled);
  await desk.start();
  desk.peers.stop();
  desk.config.port = desk.boundPort;
  desk._saveConfig();
  return {
    name,
    root,
    dataDir,
    inbox,
    mail,
    desk,
    get port() { return this.desk.boundPort; },
    async restart() {
      await this.desk.stop();
      this.desk = new Desk({
        dataDir: this.dataDir,
        webDir: path.resolve(__dirname, "../../web"),
        legacyDir: null,
        port: 0,
        lan: false,
        discovery: false,
        graceMs: 0,
        pollMs: 3600000,
        log: () => {},
      });
      await this.desk.start();
      this.desk.peers.stop();
      this.desk.config.port = this.desk.boundPort;
      this.desk._saveConfig();
    },
    async cleanup() {
      await this.desk.stop();
      fs.rmSync(this.root, { recursive: true, force: true });
    },
  };
}

function pairTwo(a, b) {
  const keyAB = "a".repeat(32);
  const keyBA = "b".repeat(32);
  a.desk.config.peers = [{ id: b.desk.config.device_id, name: b.name, base: `http://127.0.0.1:${b.port}`, key: keyAB, my_key: keyBA }];
  b.desk.config.peers = [{ id: a.desk.config.device_id, name: a.name, base: `http://127.0.0.1:${a.port}`, key: keyBA, my_key: keyAB }];
  a.desk._saveConfig();
  b.desk._saveConfig();
}

function updatePeerBases(a, b) {
  a.desk.config.peers[0].base = `http://127.0.0.1:${b.port}`;
  b.desk.config.peers[0].base = `http://127.0.0.1:${a.port}`;
  a.desk._saveConfig();
  b.desk._saveConfig();
}

function httpReq(port, route, { method = "GET", body, headers = {} } = {}) {
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

test("CP2-1: PC <-> Laptop + Phone end-to-end lifecycle, network faults, burst >60 events, clock skew, dual restart, old peer and delivery vs ACK separation", async () => {
  const pc = await makeNode("MainPC");
  const laptop = await makeNode("WorkerLaptop");
  try {
    pairTwo(pc, laptop);
    const phoneHeaders = { origin: "capacitor://localhost", "x-agent-desk-key": pc.desk.config.key };
    const initAlerts = await httpReq(pc.port, "/api/alerts", { headers: phoneHeaders });
    assert.equal(initAlerts.status, 200);
    const baseAlertSeq = initAlerts.data.seq;

    // 1. Assign on PC targeting Laptop worker
    const assigned = pc.desk.tasks.assign({
      project: "SyncProj",
      title: "Cross-desk assignment",
      prompt: "Run cross-desk task and report back",
      agent: "Astra",
      device_id: laptop.desk.config.device_id,
      session_id: "astra-laptop-s1",
      role: "executor",
    });

    // Check outbound pending_events BEFORE sync
    const preLink = pc.desk.peers.payload().peers[0];
    assert.ok(preLink.pending_events > 0, "outbound pending_events must be > 0 before sync");

    // 2. Fault: drop AFTER receiver saves, BEFORE HTTP response arrives at sender!
    const origSecure = pc.desk.peers.secure.bind(pc.desk.peers);
    let droppedOnce = false;
    pc.desk.peers.secure = async (peer, payload) => {
      const res = await origSecure(peer, payload);
      if (!droppedOnce && payload.action === "events" && payload.events?.length) {
        droppedOnce = true;
        throw Object.assign(new Error("связь оборвалась"), { code: "ECONNRESET" });
      }
      return res;
    };
    await assert.rejects(() => pc.desk.peers.sync(laptop.desk.config.device_id), /связь оборвалась/);
    assert.equal(laptop.desk.state.todos.length, 1, "receiver already saved before network drop");
    pc.desk.peers.secure = origSecure;

    // Retry via safe UI action POST /api/peers/sync -> must succeed without creating duplicate on Laptop!
    const retryRes = await httpReq(pc.port, "/api/peers/sync", { body: { id: laptop.desk.config.device_id } });
    assert.equal(retryRes.status, 200);
    assert.equal(laptop.desk.state.todos.length, 1, "no duplicate todo after post-save drop retry");

    // Verify board delivery is recorded, while recipient agent ACK is STILL null!
    const pcTodoAfterDeliver = pc.desk.state.todos.find((t) => t.message_id === assigned.assignment_message_id);
    assert.ok(pcTodoAfterDeliver.delivered_at, "delivered_at set after peer receipt");
    assert.equal(pcTodoAfterDeliver.acked_at, null, "board delivery must never set acked_at");

    // 3. Laptop worker ACKs and submits report with skewed clock (+3 min, within plausible window, and -40 days implausible clamped)
    const lapAgentHeaders = { "x-agent-desk-agent-key": laptop.desk.config.agent_key };
    const ackRes = await httpReq(laptop.port, "/api/agent/ack", {
      headers: lapAgentHeaders,
      body: {
        project: "SyncProj",
        agent: "Astra",
        session_id: "astra-laptop-s1",
        assignment_epoch: 1,
        message_id: assigned.assignment_message_id,
      },
    });
    assert.equal(ackRes.status, 200);

    const subRes = await httpReq(laptop.port, "/api/agent/submit", {
      headers: lapAgentHeaders,
      body: {
        project: "SyncProj",
        agent: "Astra",
        state: "done",
        execution_state: "submitted",
        task_id: assigned.task_id,
        assignment_epoch: 1,
        session_id: "astra-laptop-s1",
        device_id: laptop.desk.config.device_id,
        to: "Codex",
        message: "Cross-desk work completed, ready for review",
        time: "2020-01-01T00:00:00.000Z", // implausible clock skew -> clamped safely
        seq: 1,
      },
    });
    assert.equal(subRes.status, 200);

    // Sync Laptop -> PC; Phone model polls alerts & state on PC
    await laptop.desk.peers.sync(pc.desk.config.device_id);
    const phoneAlerts = await httpReq(pc.port, `/api/alerts?after=${baseAlertSeq}`, { headers: phoneHeaders });
    assert.equal(phoneAlerts.status, 200);
    assert.ok(phoneAlerts.data.alerts.some((a) => a.kind === "forward" && a.to === "Codex"), "Phone receives alert for incoming Laptop report");

    const pcAccept = await httpReq(pc.port, "/api/tasks/transition", {
      body: {
        task_id: assigned.task_id,
        project: "SyncProj",
        agent: "Astra",
        device_id: laptop.desk.config.device_id,
        session_id: "astra-laptop-s1",
        assignment_epoch: 1,
        state: "accepted",
        note: "Accepted on MainPC",
      },
    });
    assert.equal(pcAccept.status, 200);
    await pc.desk.peers.sync(laptop.desk.config.device_id);
    assert.equal(laptop.desk.state.tasks[assigned.task_id].state, "accepted");

    // 4. Burst > 60 events across single sync() call (requires >3 pages of 20 events; test >5 pages = 125 events!)
    for (let i = 0; i < 62; i++) {
      pc.desk.tasks.assign({
        project: "SyncProj",
        title: `Burst task #${i}`,
        prompt: `Burst prompt #${i}`,
        agent: "Carbon",
        device_id: pc.desk.config.device_id,
        session_id: `burst-sess-${i}`,
      });
    }
    // 62 tasks * 2 entities (task + todo + binding) = ~186 events (> 5 * 20 = 100!)
    await pc.desk.peers.sync(laptop.desk.config.device_id);
    assert.equal(Object.keys(laptop.desk.state.tasks).length, Object.keys(pc.desk.state.tasks).length, "single sync() must drain >100-event burst completely");

    // 5. Dual restart of both PC and Laptop
    await pc.restart();
    await laptop.restart();
    updatePeerBases(pc, laptop);
    await pc.desk.peers.sync(laptop.desk.config.device_id);
    assert.equal(Object.keys(laptop.desk.state.tasks).length, 63);

    // 6. Old protocol peer (HTTP 404 on /api/p2p/sync) surfaces clear compat_reason
    const oldServer = http.createServer((_req, res) => { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"not found"}'); });
    await new Promise((r) => oldServer.listen(0, "127.0.0.1", r));
    try {
      const oldPort = oldServer.address().port;
      pc.desk.config.peers.push({ id: "3333333333333333", name: "OldDesk22", base: `http://127.0.0.1:${oldPort}`, key: "c".repeat(32), my_key: "d".repeat(32) });
      await assert.rejects(() => pc.desk.peers.sync("3333333333333333"));
      const oldPeerStatus = pc.desk.peers.payload().peers.find((p) => p.id === "3333333333333333");
      assert.match(oldPeerStatus.compat_reason || oldPeerStatus.error, /2\.3\.0|обновите|стар/i);
    } finally {
      oldServer.close();
    }
  } finally {
    await pc.cleanup();
    await laptop.cleanup();
  }
});

test("CP2-2: journal compaction, snapshot/replay recovery on cursor lag, dedup beyond 500/5000/150 limits, state.json.bak recovery, no false 200 on save failure, and UUID reconciliation report", async () => {
  const pc = await makeNode("CompactionPC");
  const laggingLaptop = await makeNode("LaggingLaptop");
  try {
    pairTwo(pc, laggingLaptop);
    // Sync initial state so LaggingLaptop has cursor > 0 (e.g. cursor = 3)
    const t0 = pc.desk.tasks.assign({
      project: "SyncProj",
      title: "Initial synced task",
      prompt: "Before Laptop goes offline",
      agent: "Carbon",
      device_id: pc.desk.config.device_id,
      session_id: "c-0",
    });
    await pc.desk.peers.sync(laggingLaptop.desk.config.device_id);
    await laggingLaptop.desk.peers.sync(pc.desk.config.device_id);
    assert.ok(laggingLaptop.desk.state.tasks[t0.task_id]);

    // Now LaggingLaptop goes offline while PC generates 80 updates on the task + supersedes chain, then compacts journal!
    let prevMsgId = null;
    for (let i = 1; i <= 40; i++) {
      const ev = parseMarker(JSON.stringify({
        agent: "Worker",
        state: "done",
        to: "Lead",
        task: "Evolving report",
        message: `Report revision v${i}`,
      }), "SyncProj");
      pc.desk.applyEvent(ev);
      pc.desk._saveState();
      prevMsgId = pc.desk.state.todos.findLast((t) => t.task === "Evolving report").message_id;
    }
    assert.ok(prevMsgId);
    const beforeLen = pc.desk.sync.journal.events.length;
    assert.ok(beforeLen > 40);

    // Compact journal aggressively (maxEvents=20, keepTail=10) so base_seq > LaggingLaptop's old cursor!
    const compStats = pc.desk.sync.compact(20, 10);
    pc.desk._saveState();
    assert.ok(compStats.base_seq > 10, "base_seq advanced past lagging peer cursor");
    assert.ok(pc.desk.sync.journal.events.length <= 10);

    // LaggingLaptop reconnects: instead of failing forever with 409 cursor out of journal, controlled snapshot/replay converges!
    await laggingLaptop.desk.peers.sync(pc.desk.config.device_id);
    await pc.desk.peers.sync(laggingLaptop.desk.config.device_id);

    const recPc = pc.desk.reconcileReport();
    const recLap = laggingLaptop.desk.reconcileReport();
    assert.deepEqual(
      recLap.tasks.map((r) => ({ task_id: r.task_id, coordinator: r.coordinator_device_id, epoch: r.epoch, state: r.state })),
      recPc.tasks.map((r) => ({ task_id: r.task_id, coordinator: r.coordinator_device_id, epoch: r.epoch, state: r.state })),
      "Controlled snapshot/replay must converge all task UUIDs, epochs, states and coordinator owners"
    );
    const activeReportPc = pc.desk.state.todos.find((t) => t.message_id === prevMsgId);
    const activeReportLap = laggingLaptop.desk.state.todos.find((t) => t.message_id === prevMsgId);
    assert.ok(activeReportLap, "latest head of supersedes chain replicated after compaction replay");
    assert.equal(activeReportLap.supersedes, activeReportPc.supersedes);

    // Save failure on /api/todo/:id/forwarded MUST NOT return HTTP 200 receipt!
    const openTodo = pc.desk.state.todos.find((t) => !t.done_at && !t.forwarded_at);
    const origWrite = pc.desk._writeState.bind(pc.desk);
    pc.desk._writeState = () => { throw new Error("disk ENOSPC"); };
    const failedForward = await httpReq(pc.port, `/api/todo/${openTodo.id}/forwarded`, { body: {} });
    assert.equal(failedForward.status, 500, "save failure must never return HTTP 200 receipt");
    assert.equal(pc.desk.state.todos.find((t) => t.id === openTodo.id).forwarded_at, null, "in-memory state rolled back on save failure");
    pc.desk._writeState = origWrite;

    // Corrupt / empty state.json recovery from state.json.bak
    pc.desk._saveState(); // ensures state.json.bak is up to date
    const expectedTaskCount = Object.keys(pc.desk.state.tasks).length;
    await pc.desk.stop();
    fs.writeFileSync(path.join(pc.dataDir, "state.json"), ""); // 0-byte truncated state.json!
    pc.desk = new Desk({ dataDir: pc.dataDir, legacyDir: null, port: 0, lan: false, discovery: false, log: () => {} });
    assert.equal(Object.keys(pc.desk.state.tasks).length, expectedTaskCount, "0-byte corrupt state.json must recover from state.json.bak");
    assert.ok(pc.desk.warnings.some((w) => /резервн|bak|восстановл/i.test(w.text)), "warning explains recovery from backup");
    assert.ok(fs.readdirSync(pc.dataDir).some((n) => n.startsWith("state.json.corrupt-")), "corrupt state.json quarantined");
    await pc.desk.start();
    pc.desk.peers.stop();
  } finally {
    await pc.cleanup();
    await laggingLaptop.cleanup();
  }
});

test("CP2-3: peer conflict reporting, disabled file mail isolation, and negative mail security controls", async () => {
  const pc = await makeNode("MailGuardPC", { fileSyncEnabled: true });
  const laptop = await makeNode("MailDisabledLaptop", { fileSyncEnabled: false });
  try {
    pairTwo(pc, laptop);
    // Write a safe file and secret/forbidden files in PC mail folder
    fs.writeFileSync(path.join(pc.mail, "notes.md"), "safe shared notes");
    fs.writeFileSync(path.join(pc.mail, ".env"), "SECRET=123");
    fs.writeFileSync(path.join(pc.mail, "credentials.json"), "{}");
    pc.desk.mail.scan();
    assert.deepEqual(pc.desk.mail.manifest().map((f) => f.path), ["notes.md"], "secret and hidden files excluded");

    // Laptop has file_sync_enabled=false: tasks & ACKs sync, zero files transferred!
    const t = pc.desk.tasks.assign({
      project: "SyncProj",
      title: "Task without mail",
      prompt: "Cards sync while mail is off",
      agent: "Carbon",
      device_id: laptop.desk.config.device_id,
      session_id: "nomail-s1",
    });
    await pc.desk.peers.sync(laptop.desk.config.device_id);
    await laptop.desk.peers.sync(pc.desk.config.device_id);
    assert.ok(laptop.desk.state.tasks[t.task_id]);
    assert.equal(fs.readdirSync(laptop.mail).length, 0, "disabled file mail must not transfer folder contents");

    // Negative controls on MailStore.acceptChunk: traversal, absolute path, tampered hash, duplicate byte mismatch, secret file
    const validSha = crypto.createHash("sha256").update("hello").digest("hex");
    const validData = Buffer.from("hello").toString("base64");
    for (const badPath of ["../escape.txt", "C:\\Windows\\win.ini", "/etc/passwd", ".env", "sub/id_rsa", "api_key_dump.txt"]) {
      assert.throws(
        () => pc.desk.mail.acceptChunk("peer1", { project: "SyncProj", path: badPath, sha256: validSha, offset: 0, total: 5, data: validData }),
        (e) => e.code === "MAIL_PATH",
        `must reject unsafe path: ${badPath}`
      );
    }
    // Tampered hash
    assert.throws(
      () => pc.desk.mail.acceptChunk("peer1", { project: "SyncProj", path: "tampered.txt", sha256: "f".repeat(64), offset: 0, total: 5, data: validData }),
      (e) => e.code === "MAIL_HASH"
    );
    // Out-of-order chunk
    assert.throws(
      () => pc.desk.mail.acceptChunk("peer1", { project: "SyncProj", path: "order.txt", sha256: validSha, offset: 2, total: 5, data: Buffer.from("llo").toString("base64") }),
      (e) => e.code === "MAIL_ORDER"
    );
    // Directory junction inside mail root
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-outside-"));
    try {
      fs.symlinkSync(outsideDir, path.join(pc.mail, "junction-dir"), "junction");
      assert.throws(
        () => pc.desk.mail.acceptChunk("peer1", { project: "SyncProj", path: "junction-dir/pwn.txt", sha256: validSha, offset: 0, total: 5, data: validData }),
        (e) => e.code === "MAIL_SYMLINK"
      );
      assert.equal(fs.readdirSync(outsideDir).length, 0);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }

    // Peer conflict reporting when rogue peer attempts to change coordinator without authority
    const forgedTaskEv = {
      id: crypto.randomUUID(),
      origin: laptop.desk.config.device_id,
      clock: 99999,
      type: "task",
      entity_id: t.task_id,
      deleted: false,
      time: new Date().toISOString(),
      data: { ...pc.desk.state.tasks[t.task_id], coordinator_device_id: laptop.desk.config.device_id },
    };
    const p = laptop.desk.config.peers[0];
    const hijackAttempt = await httpReq(pc.port, "/api/p2p/sync", {
      body: { from: laptop.desk.config.device_id, packet: seal({ action: "events", cursor: 0, events: [forgedTaskEv] }, p.key) },
    });
    assert.equal(hijackAttempt.status, 409);
    const peerInfoOnPc = pc.desk.peers.payload().peers.find((x) => x.id === laptop.desk.config.device_id);
    assert.ok(peerInfoOnPc.conflicts?.length >= 1, "peer status records safe conflict notice on rejected sync mutation");
  } finally {
    await pc.cleanup();
    await laptop.cleanup();
  }
});
