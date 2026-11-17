"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { Desk } = require("../desk.js");
const { buildHistoricalSnapshot216 } = require("./fixtures/synthetic-program.js");

const CLI_ENTRY = path.resolve(__dirname, "../cli.js");

async function createNode(extraConfig = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-cp3-"));
  const dataDir = path.join(root, "data");
  const inbox = path.join(root, "inbox");
  const repoDir = path.join(root, "approved-repo");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });
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
  Object.assign(desk.config, {
    watch: [{ path: inbox, project: "HistProject" }],
    task_repo_roots: [repoDir],
    ...extraConfig,
  });
  await desk.start();
  desk.peers.stop();
  desk.config.port = desk.boundPort;
  desk._saveConfig();
  return {
    root,
    dataDir,
    inbox,
    repoDir,
    desk,
    port: desk.boundPort,
    async cleanup() {
      await desk.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
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
        resolve({ status: res.statusCode, data });
      });
    });
    req.on("error", reject);
    req.end(raw);
  });
}

function runCli(args, home, stdinText = "") {
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

test("CP3-1: quiet hours, per-project notification mute, alert deduplication, and phone connection status tracking", async () => {
  const node = await createNode();
  try {
    // Configure quiet_hours covering 00:00..23:59 (always quiet) and mute project "MutedProj"
    const cfgRes = await httpReq(node.port, "/api/config", {
      body: {
        quiet_hours: { enabled: true, start: "00:00", end: "23:59" },
        notify_projects: { MutedProj: false, HistProject: true },
      },
    });
    assert.equal(cfgRes.status, 200);
    assert.equal(node.desk.config.quiet_hours.enabled, true);

    let popupEvents = 0;
    node.desk.on("alert", (a) => { if (!a.suppressed) popupEvents++; });

    // Alert in MutedProj -> suppressed
    node.desk._alert("forward", "MutedProj", "Muted title", "body", 1, { agent: "A", to: "B", action: "act" });
    assert.equal(popupEvents, 0, "muted project must suppress active popup/chime notification");

    // Disable quiet hours, verify HistProject emits ONCE and deduplicates identical repeat!
    await httpReq(node.port, "/api/config", {
      body: { quiet_hours: { enabled: false, start: "23:00", end: "07:00" } },
    });
    node.desk._alert("reply", "HistProject", "Astra ждёт ответа", "Вопрос #1", 42, { agent: "Astra", action: "Ответьте" });
    node.desk._alert("reply", "HistProject", "Astra ждёт ответа", "Вопрос #1", 42, { agent: "Astra", action: "Ответьте" });
    assert.equal(popupEvents, 1, "identical repeat alert for same open reminder must be deduplicated");

    // Disconnected vs connected phone status
    assert.equal(node.desk.payload().phone_status.connected, false);
    await httpReq(node.port, "/api/alerts", {
      headers: { origin: "capacitor://localhost", "x-agent-desk-key": node.desk.config.key },
    });
    assert.equal(node.desk.payload().phone_status.connected, true);
  } finally {
    await node.cleanup();
  }
});

test("CP3-2: byte-for-byte prompt fidelity with Cyrillic/emoji/CRLF, UTF-8 overflow guard, and local artifact availability check", async () => {
  const node = await createNode();
  try {
    const artifactContent = Buffer.from("synthetic verified attachment content\r\nline 2\n", "utf8");
    const artifactSha = crypto.createHash("sha256").update(artifactContent).digest("hex");
    fs.mkdirSync(path.join(node.repoDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(node.repoDir, "docs", "spec.md"), artifactContent);

    const complexPrompt = [
      "Заголовок кириллицей: проверка точного копирования 🧪📦🔍",
      "Строка с CRLF и отступами:\r\n    - пункт 1 (пробелы сохранены)\r\n    - пункт 2 (эмодзи ✅ и таблица А-Я)",
      "Финальная строка без порчи символов.",
    ].join("\r\n");

    const task = node.desk.tasks.assign({
      project: "HistProject",
      title: "Проверка кириллицы, CRLF и вложений",
      prompt: complexPrompt,
      agent: "Carbon",
      device_id: node.desk.config.device_id,
      session_id: "cp3-copy-s1",
      checkpoint: { repo: node.repoDir, next_step: "Проверить доступность вложения" },
      artifacts: [
        { path: "docs/spec.md", sha256: artifactSha, status: "submitted" },
        { path: "docs/missing.md", sha256: "a".repeat(64), status: "expected" },
      ],
    });

    const agentHeaders = { "x-agent-desk-agent-key": node.desk.config.agent_key };
    const readRes = await httpReq(node.port, `/api/agent/read?id=${task.task_id}`, { headers: agentHeaders });
    const stateRes = await httpReq(node.port, "/api/state");
    const uiTodo = stateRes.data.todos.find((t) => t.message_id === task.assignment_message_id);
    assert.equal(
      Buffer.compare(Buffer.from(uiTodo.forward_text, "utf8"), Buffer.from(readRes.data.todo.forward_text, "utf8")),
      0,
      "UI forward_text and CLI read forward_text must match byte-for-byte"
    );
    assert.ok(uiTodo.forward_text.includes(complexPrompt), "CRLF, indentation, Cyrillic and emoji preserved without corruption");

    // Check artifact availability on current device in enriched task payload
    const enrichedTask = stateRes.data.tasks.find((t) => t.task_id === task.task_id);
    const specArt = enrichedTask.artifacts.find((a) => a.path === "docs/spec.md");
    const missArt = enrichedTask.artifacts.find((a) => a.path === "docs/missing.md");
    assert.equal(specArt.local_availability, "available_verified");
    assert.equal(missArt.local_availability, "missing_on_device");
  } finally {
    await node.cleanup();
  }
});

test("CP3-4: structured marker rejection diagnostics (6 waiting_for, 2 state, 1 device), unchanged bad/ archive, CLI validate preflight, and redacted diagnostic export", async () => {
  const snap = buildHistoricalSnapshot216("1111111111111111");
  const node = await createNode({ device_id: "1111111111111111" });
  node.desk.state = { ...node.desk.state, ...snap.state };
  node.desk._saveState();

  try {
    // Write all 9 invalid marker samples into inbox and verify structured rejections + untouched raw bytes in bad/
    const rawByFile = new Map();
    for (const sample of snap.invalidMarkerSamples) {
      rawByFile.set(sample.name, sample.raw);
      fs.writeFileSync(path.join(node.inbox, sample.name), sample.raw, "utf8");
    }
    node.desk.scanOnce(); // First scan: 8 parse-error markers enter pending ("не обработано"), 1 runtime device mismatch rejected immediately
    assert.equal(node.desk.diagnosticsExport().pipeline.pending, 8, "first sight holds unparsable markers in pending state");
    assert.equal(node.desk.state.rejected.length, 1);
    node.desk.scanOnce(); // Second scan (graceMs=0): all 8 pending markers move to rejected ("отклонено")
    assert.equal(node.desk.diagnosticsExport().pipeline.pending, 0);
    assert.equal(node.desk.state.rejected.length, 9);

    const byCode = node.desk.state.rejected.reduce((acc, r) => {
      acc[r.code] = (acc[r.code] || 0) + 1;
      return acc;
    }, {});
    assert.equal(byCode.INVALID_WAITING_FOR, 6);
    assert.equal(byCode.INVALID_STATE, 2);
    assert.equal(byCode.DEVICE_MISMATCH, 1);

    for (const r of node.desk.state.rejected) {
      assert.ok(r.field, `rejected marker ${r.file} must report field`);
      assert.ok(Array.isArray(r.expected) && r.expected.length > 0, `rejected marker ${r.file} must report expected values`);
      assert.ok(r.hint, `rejected marker ${r.file} must include safe hint`);
      assert.equal(typeof r.retryable, "boolean");
      assert.equal(r.project, "HistProject");
      assert.equal(typeof r.seq, "number");
      // Verify archived bad/ file is preserved byte-for-byte without modification!
      assert.equal(fs.readFileSync(r.moved_to, "utf8"), rawByFile.get(r.file));
    }

    // Preflight CLI validate: catches invalid marker offline with structured field/expected/hint and exit=1, passes valid marker with exit=0
    const badFile = path.join(node.root, "preflight-bad.json");
    fs.writeFileSync(badFile, JSON.stringify({ project: "HistProject", agent: "Carbon", state: "waiting", waiting_for: "coffee_break", seq: 4 }));
    const badCli = await runCli(["validate", "--file", badFile], node.dataDir);
    assert.equal(badCli.code, 1);
    assert.equal(badCli.json.ok, false);
    assert.equal(badCli.json.errors[0].code, "INVALID_WAITING_FOR");
    assert.equal(badCli.json.errors[0].field, "waiting_for");
    assert.ok(badCli.json.errors[0].expected.includes("owner_input"));

    const goodFile = path.join(node.root, "preflight-good.json");
    fs.writeFileSync(goodFile, JSON.stringify({ project: "HistProject", agent: "Carbon", state: "working", execution_state: "working", task: "Preflight check", seq: 5 }));
    const goodCli = await runCli(["validate", "--file", goodFile], node.dataDir);
    assert.equal(goodCli.code, 0, goodCli.stdout);
    assert.equal(goodCli.json.ok, true);

    // Safe diagnostic export hides local paths, keys, hostnames, and prompt/message texts by default!
    const diagRes = await httpReq(node.port, "/api/diagnostics");
    assert.equal(diagRes.status, 200);
    const diagJson = JSON.stringify(diagRes.data);
    assert.ok(!diagJson.includes(node.inbox), "diagnostic export must hide local watch paths");
    assert.ok(!diagJson.includes(node.repoDir), "diagnostic export must hide local repo roots");
    assert.ok(!diagJson.includes(node.desk.config.key), "diagnostic export must never include owner key");
    assert.ok(!diagJson.includes(node.desk.config.agent_key), "diagnostic export must never include agent key");
    assert.ok(!diagJson.includes("Полный синтетический промпт"), "diagnostic export must omit prompt contents");
    assert.equal(diagRes.data.pipeline.rejected, 9);
    assert.equal(diagRes.data.rejected_by_code.INVALID_WAITING_FOR, 6);
    assert.equal(diagRes.data.rejected_by_code.INVALID_STATE, 2);
    assert.equal(diagRes.data.rejected_by_code.DEVICE_MISMATCH, 1);
    assert.equal(typeof diagRes.data.pipeline.pending, "number");
    assert.equal(typeof diagRes.data.pipeline.queued, "number");
    assert.equal(typeof diagRes.data.pipeline.applied, "number");
    assert.equal(typeof diagRes.data.pipeline.acked, "number");
  } finally {
    await node.cleanup();
  }
});
