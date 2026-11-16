"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const { Desk, parseMarker } = require("../desk.js");
const { seal, unseal } = require("../sync.js");
const DISABLED = { enabled: false, mode: "disabled", roots: [], files: [], errors: [] };
async function fixture(config = {}, beforeStart = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdesk-file-opt-in-"));
  const data = path.join(root, "data"), mail = path.join(root, "files"); fs.mkdirSync(data); fs.mkdirSync(mail);
  fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ watch: [], ...config }));
  const d = new Desk({ dataDir: data, legacyDir: null, port: 0, lan: false, discovery: false, pollMs: 3600000, log() {} });
  beforeStart(d, mail); await d.start(); d.peers.stop(); return { root, mail, d };
}
async function clean(...fixtures) { for (const f of fixtures) { await f.d.stop(); fs.rmSync(f.root, { recursive: true, force: true }); } }
function pair(a, b) {
  a.config.peers = [{ id: b.config.device_id, name: "B", base: `http://127.0.0.1:${b.boundPort}`, key: "1".repeat(32), my_key: "2".repeat(32) }];
  b.config.peers = [{ id: a.config.device_id, name: "A", base: `http://127.0.0.1:${a.boundPort}`, key: "2".repeat(32), my_key: "1".repeat(32) }];
}
function request(d, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: d.boundPort, path: route, method: raw ? "POST" : "GET", headers: { "content-type": "application/json", "x-agent-desk": "1", ...headers } }, res => {
      const chunks = []; res.on("data", c => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on("error", reject); req.end(raw);
  });
}
function forbidMailWork(d) {
  d.fileWorkAttempts = [];
  for (const method of ["scan", "payload", "manifest", "diagnostics", "ensureIncomingRoot", "readChunk", "acceptChunk"]) d.mail[method] = () => { d.fileWorkAttempts.push(method); throw new Error(`disabled file module called ${method}`); };
}
test("absent file flag is persisted false; startup, tick, state and mail GET do no file work", async () => {
  const f = await fixture({}, (d, mail) => {
    d.config.mail_roots = [{ project: "P", path: mail }]; fs.writeFileSync(path.join(mail, "private.txt"), "local only"); forbidMailWork(d);
  });
  try {
    assert.equal(f.d.config.file_sync_enabled, false);
    assert.equal(JSON.parse(fs.readFileSync(f.d.configFile, "utf8")).file_sync_enabled, false);
    f.d._tick(); assert.deepEqual(f.d.payload().mail, DISABLED);
    assert.equal(f.d.payload().config.file_sync_enabled, false);
    assert.deepEqual((await request(f.d, "/api/mail")).data, DISABLED);
    assert.deepEqual((await request(f.d, "/api/state")).data.mail, DISABLED);
    assert.equal(f.d.payload().link.sync.enabled, true);
    assert.equal(fs.existsSync(path.join(f.d.dataDir, "mail")), false);
    assert.equal(f.d.state.mail_index, undefined); assert.deepEqual(f.d.fileWorkAttempts, []);
  } finally { await clean(f); }
});
test("default independent boards sync cards, task journal and ACK without scanning or downloading files", async () => {
  const a = await fixture({}, forbidMailWork), b = await fixture({}, forbidMailWork);
  try {
    pair(a.d, b.d);
    a.d.applyEvent(parseMarker(JSON.stringify({ agent: "Lead", state: "done", to: "Worker", task: "One", message: "Card request" }), "P")); a.d._saveState();
    const t = a.d.state.todos[0];
    await a.d.peers.sync(b.d.config.device_id);
    const got = b.d.state.todos.find(row => row.message_id === t.message_id); assert.ok(got);
    assert.ok(b.d.state.tasks[got.task_id]); assert.ok(a.d.state.todos[0].delivered_at); assert.equal(t.done_at, null);
    const ack = await request(b.d, "/api/agent/ack", { project: "P", agent: "Worker", message_id: got.message_id }, { "x-agent-desk-agent-key": b.d.config.agent_key });
    assert.equal(ack.status, 200); await b.d.peers.sync(a.d.config.device_id);
    assert.ok(a.d.state.todos.find(row => row.message_id === got.message_id).acked_at);
    assert.equal(a.d.peers.payload().sync.enabled, true); assert.ok(a.d.peers.payload().peers[0].synced);
    assert.deepEqual(a.d.peers.payload().peers[0].mail, { enabled: false, mode: "disabled", projects: [], files: 0, errors: [] });
    const p = a.d.config.peers[0];
    const result = b.d.peers.secureReceive({ from: a.d.config.device_id, packet: seal({ action: "events", events: [] }, p.key) });
    const decoded = unseal(result.body.packet, p.my_key); assert.deepEqual(decoded.mail, []); assert.equal(decoded.mail_more, false);
    assert.throws(() => b.d.peers.secureReceive({ from: a.d.config.device_id, packet: seal({ action: "mail-chunk", file: {} }, p.key) }), /disabled|отключ/i);
    for (const f of [a, b]) { assert.equal(fs.existsSync(path.join(f.d.dataDir, "mail")), false); assert.deepEqual(f.d.fileWorkAttempts, []); }
  } finally { await clean(a, b); }
});
test("disabled recipient ignores enabled peer files and disabled sender advertises no files", async () => {
  const a = await fixture({ file_sync_enabled: true }, (d, mail) => { d.config.mail_roots = [{ project: "P", path: mail }]; fs.writeFileSync(path.join(mail, "report.txt"), "opt-in only"); });
  const b = await fixture({}, forbidMailWork);
  try {
    pair(a.d, b.d); await b.d.peers.sync(a.d.config.device_id);
    assert.equal(fs.existsSync(path.join(b.d.dataDir, "mail")), false); assert.equal(b.d.state.mail_incoming_roots, undefined);
    await a.d.peers.sync(b.d.config.device_id); assert.equal(a.d.peers.payload().peers[0].mail.mode, "disabled");
    assert.equal(a.d.mail.manifest().length, 1); assert.deepEqual(b.d.fileWorkAttempts, []);
  } finally { await clean(a, b); }
});
test("disabled file pagination neither delays card sync nor advances file cursor", async () => {
  const a = await fixture({}, forbidMailWork), b = await fixture();
  try {
    pair(a.d, b.d); const calls = [];
    a.d.sync.journal.mail_cursors = { [b.d.config.device_id]: 17 };
    a.d.peers.secure = async (_p, value) => {
      calls.push(value);
      return { events: [], receipts: value.events.map(e => e.id), journal: b.d.sync.journal.id, cursor: 0, more: false,
        mail: [{ project: "P", path: "report.txt", size: 1, sha256: "a".repeat(64) }], mail_cursor: 100, mail_more: true,
        mail_status: { enabled: true, mode: "configured", projects: ["P"], files: 101, errors: [] } };
    };
    await a.d.peers.sync(b.d.config.device_id);
    assert.equal(calls.length, 1); assert.equal(calls[0].mail_cursor, 0);
    assert.equal(a.d.sync.journal.mail_cursors[b.d.config.device_id], 0);
    assert.deepEqual(a.d.fileWorkAttempts, []); assert.ok(a.d.peers.payload().peers[0].synced);
  } finally { await clean(a, b); }
});
test("local enabled toggle preserves configured roots, files and index on disable and after restart", async () => {
  const f = await fixture({}, (d, mail) => { d.config.mail_roots = [{ project: "P", path: mail }]; fs.writeFileSync(path.join(mail, "report.txt"), "preserved"); });
  try {
    const roots = structuredClone(f.d.config.mail_roots);
    for (const enabled of [true, false]) assert.equal(f.d._post("/api/mail/config", { enabled }, { local: false }).code, 403);
    assert.equal(f.d.config.file_sync_enabled, false);
    const on = await request(f.d, "/api/mail/config", { enabled: true }); assert.equal(on.status, 200); assert.equal(on.data.enabled, true); assert.equal(on.data.mode, "configured"); assert.equal(on.data.files.length, 1);
    assert.equal((await request(f.d, "/api/mail")).data.enabled, true);
    const index = structuredClone(f.d.state.mail_index);
    const off = await request(f.d, "/api/mail/config", { enabled: false }); assert.equal(off.status, 200); assert.deepEqual(off.data, DISABLED);
    assert.deepEqual(f.d.config.mail_roots, roots); assert.deepEqual(f.d.state.mail_index, index); assert.equal(fs.readFileSync(path.join(f.mail, "report.txt"), "utf8"), "preserved");
    assert.equal(JSON.parse(fs.readFileSync(f.d.configFile, "utf8")).file_sync_enabled, false);
    const reloaded = new Desk({ dataDir: f.d.dataDir, legacyDir: null, log() {} });
    assert.deepEqual(reloaded.payload().mail, DISABLED); assert.deepEqual(reloaded.config.mail_roots, roots); assert.deepEqual(reloaded.state.mail_index, index);
    assert.equal(f.d._post("/api/mail/config", { enabled: "true" }, { local: true }).code, 400);
  } finally { await clean(f); }
});
test("explicit roots and automatic configuration enable replication; empty roots remain opt-out", async () => {
  const a = await fixture(), b = await fixture();
  try {
    fs.writeFileSync(path.join(a.mail, "report.txt"), "explicitly shared");
    const configured = a.d._post("/api/mail/config", { roots: [{ project: "P", path: a.mail }] }, { local: true });
    assert.equal(configured.body.enabled, true); assert.equal(a.d.config.file_sync_enabled, true);
    const automatic = b.d._post("/api/mail/config", { automatic: true }, { local: true });
    assert.equal(automatic.body.enabled, true); assert.equal(automatic.body.mode, "auto");
    pair(a.d, b.d); await b.d.peers.sync(a.d.config.device_id);
    const incoming = b.d.payload().mail.roots.find(r => r.project === "P"); assert.ok(incoming);
    assert.equal(fs.readFileSync(path.join(incoming.path, "report.txt"), "utf8"), "explicitly shared");
    const disabled = b.d._post("/api/mail/config", { roots: [] }, { local: true }); assert.deepEqual(disabled.body, DISABLED);
    assert.equal(b.d.config.file_sync_enabled, false); assert.deepEqual(b.d.config.mail_roots, []);
    assert.equal(fs.readFileSync(path.join(incoming.path, "report.txt"), "utf8"), "explicitly shared");
    const stillOff = b.d._post("/api/mail/config", { enabled: true }, { local: true });
    assert.deepEqual(stillOff.body, DISABLED); assert.deepEqual(b.d.config.mail_roots, []);
  } finally { await clean(a, b); }
});
