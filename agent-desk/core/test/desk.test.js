"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { Desk, parseMarker, parseAcks, forwardText } = require("../desk.js");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-desk-"));
}

function makeDesk(extra = {}) {
  const root = tmp();
  const inbox = path.join(root, "inbox");
  fs.mkdirSync(inbox);
  const desk = new Desk({ dataDir: path.join(root, "data"), legacyDir: null, port: 0, lan: false, graceMs: 0, log: () => {}, ...extra });
  desk.config.watch = [{ path: inbox, project: "AZS" }];
  let n = 0;
  const put = (marker, name) => {
    const file = path.join(inbox, name || `m-${String(++n).padStart(4, "0")}.json`);
    fs.writeFileSync(file, typeof marker === "string" ? marker : JSON.stringify(marker));
    const t = new Date(Date.now() - 100000 + n * 10);
    fs.utimesSync(file, t, t);
    return file;
  };
  return { desk, root, inbox, put };
}

const open = (desk) => desk.state.todos.filter((t) => !t.done_at);

function request(port, { method = "GET", path: p = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

const post = (port, p, body, headers = {}) => request(port, {
  method: "POST", path: p, body, headers: { "content-type": "application/json", "x-agent-desk": "1", ...headers },
});

test("ack: string, list, lower case, legacy AB ids", () => {
  assert.deepEqual(parseAcks("ad-12"), ["AD-12"]);
  assert.ok(parseAcks(["AD-1", " ab-7 "]).includes("AB-7"));
  assert.ok(parseAcks("получил AD-3 и AD-4").includes("AD-4"));
  assert.deepEqual(parseAcks(undefined), []);
});

test("parseMarker validates and the folder decides the project", () => {
  const ev = parseMarker(JSON.stringify({ agent: " Opus  (3) ", state: "Working", project: "other", time: "bogus" }), "AZS");
  assert.equal(ev.project, "AZS");
  assert.equal(ev.agent, "Opus (3)");
  assert.equal(ev.state, "working");
  assert.equal(ev.time, ev.received);
  assert.throws(() => parseMarker(JSON.stringify({ agent: "A", state: "sleeping" }), "AZS"), /state/);
  assert.throws(() => parseMarker(JSON.stringify({ name: "pkg" }), "AZS"), (e) => e.constructor.name === "NotAMarker");
});

test("board ids: agent message_id is only a reference", () => {
  const { desk, put } = makeDesk();
  put({ agent: "Opus (3)", state: "done", task: "t1", to: "Astra", message: "v1", message_id: "AB-1" });
  desk.scanOnce();
  const [t] = open(desk);
  assert.equal(t.message_id, "AD-1");
  assert.equal(t.ref, "AB-1");
  assert.match(forwardText(t), /от: Opus \(3\) → Astra/);
  assert.match(forwardText(t), /message_id: AD-1/);
});

test("probe 1: resubmitted result after forwarding becomes a new reminder", () => {
  const { desk, put } = makeDesk();
  put({ agent: "Opus (3)", state: "done", task: "t1", to: "Astra", message: "v1" });
  desk.scanOnce();
  desk.state.todos[0].forwarded_at = new Date().toISOString();
  put({ agent: "Opus (3)", state: "done", task: "t1", to: "Astra", message: "v2" });
  desk.scanOnce();
  const live = open(desk);
  assert.equal(live.length, 1);
  assert.equal(live[0].message, "v2");
  assert.equal(live[0].supersedes, "AD-1");
  assert.equal(desk.state.todos[0].superseded_by, live[0].message_id);
  // the same message again does not create a third reminder
  put({ agent: "Opus (3)", state: "done", task: "t1", to: "Astra", message: "v2", event_id: "x" });
  desk.scanOnce();
  assert.equal(open(desk).length, 1);
});

test("probes 2-3: lower-case and list acks close reminders, ids are unique", () => {
  const { desk, put } = makeDesk();
  put({ agent: "Opus (3)", state: "done", task: "a", to: "Astra", message: "m1" });
  put({ agent: "Opus (1)", state: "done", task: "b", to: "Astra", message: "m2" });
  desk.scanOnce();
  assert.deepEqual(open(desk).map((t) => t.message_id), ["AD-1", "AD-2"]);
  put({ agent: "Astra", state: "working", task: "review", ack: ["ad-1", "AD-2"] });
  desk.scanOnce();
  assert.equal(open(desk).length, 0);
  assert.equal(desk.state.todos[0].acked_by, "Astra");
});

test("probe 4: name variants map to one agent; unknown addressee is flagged", () => {
  const { desk, put } = makeDesk();
  put({ agent: "Opus (3)", state: "working", task: "a" });
  put({ agent: "opus 3", state: "working", task: "b" });
  put({ agent: "Astra", state: "done", task: "c", to: "OPUS3" });
  put({ agent: "Astra", state: "done", task: "d", to: "Hoplit" });
  desk.scanOnce();
  assert.deepEqual(Object.keys(desk.state.agents).sort(), ["AZS/Astra", "AZS/Opus (3)"]);
  const [a, b] = open(desk);
  assert.equal(a.to, "Opus (3)");
  assert.equal(a.warning, undefined);
  assert.match(b.warning, /Hoplit/);
});

test("waiting for an assignment never creates a forward reminder", () => {
  const { desk, put } = makeDesk();
  put({ agent: "Opus (3)", state: "waiting", waiting_for: "assignment", from: "Astra", to: "Astra", task: "next" });
  desk.scanOnce();
  assert.equal(desk.state.todos.length, 0);
  assert.equal(desk.state.agents["AZS/Opus (3)"].from, "Astra");
});

test("reply reminder closes when the agent resumes; stale seq is ignored", () => {
  const { desk, put } = makeDesk();
  put({ agent: "A", state: "waiting", task: "q", session_id: "s", seq: 2 });
  desk.scanOnce();
  assert.equal(open(desk)[0].kind, "reply");
  put({ agent: "A", state: "working", task: "q", session_id: "s", seq: 1 });
  desk.scanOnce();
  assert.equal(open(desk).length, 1, "older seq must not change anything");
  put({ agent: "A", state: "working", task: "q", session_id: "s", seq: 3 });
  desk.scanOnce();
  assert.equal(open(desk).length, 0);
});

test("probe 6: foreign JSON stays, broken marker goes to bad/ and is reported", () => {
  const { desk, inbox, put } = makeDesk();
  const pkg = put({ name: "pkg", version: "1.0.0" }, "package.json");
  const bad = put("{ not json", "broken.json");
  desk.scanOnce(); // first sight: grace starts
  desk.scanOnce();
  assert.ok(fs.existsSync(pkg));
  assert.ok(!fs.existsSync(bad));
  const day = fs.readdirSync(path.join(inbox, "bad"))[0];
  assert.ok(fs.existsSync(path.join(inbox, "bad", day, "broken.json.error.txt")));
  assert.equal(desk.state.rejected.length, 1);
});

test("markers are archived only after state is saved; duplicates are skipped", () => {
  const { desk, put } = makeDesk();
  const f = put({ agent: "A", state: "done", task: "t", to: "B" });
  const original = desk._writeState.bind(desk);
  desk._writeState = () => { throw new Error("disk full"); };
  desk.scanOnce();
  assert.ok(fs.existsSync(f), "marker must stay while state cannot be saved");
  desk._writeState = original;
  desk.scanOnce();
  assert.ok(!fs.existsSync(f));
  assert.equal(desk.state.todos.length, 1);
  assert.equal(desk.state.events.length, 1);
  const saved = JSON.parse(fs.readFileSync(desk.stateFile, "utf8"));
  assert.equal(saved.todos.length, 1);
});

test("probe 8: corrupt config is quarantined, not silently replaced", () => {
  const root = tmp();
  const data = path.join(root, "data");
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, "config.json"), '{"watch": [{"path": "/x", "project": "AZS"},], }');
  const desk = new Desk({ dataDir: data, legacyDir: null, port: 0, log: () => {} });
  assert.equal(desk.warnings.length, 1);
  assert.ok(fs.readdirSync(data).some((n) => n.startsWith("config.json.corrupt-")));
});

test("first run imports Agent Board data; old AB ids still ack", () => {
  const root = tmp();
  const legacy = path.join(root, "AgentBoard");
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, "config.json"), JSON.stringify({ key: "abc123abc123", watch: [{ path: "/srv/inbox", project: "AZS" }], stale_minutes: 30 }));
  fs.writeFileSync(path.join(legacy, "state.json"), JSON.stringify({
    next_id: 6, agents: {}, events: [], seen_ids: ["e1"],
    todos: [{ id: 5, kind: "forward", project: "AZS", agent: "Astra", to: "Opus (3)", task: "t", message: "m", message_id: "AB-5", created: "2026-11-10T01:51:00+08:00", forwarded_at: "2026-11-10T01:52:00+08:00" }],
  }));
  const desk = new Desk({ dataDir: path.join(root, "AgentDesk"), legacyDir: legacy, port: 0, log: () => {} });
  assert.equal(desk.config.stale_minutes, 30);
  assert.equal(desk.config.watch[0].path, "/srv/inbox");
  assert.equal(desk.config.key.length, 32, "weak legacy key is replaced");
  assert.equal(desk.state.next_id, 6);
  desk.applyEvent(parseMarker(JSON.stringify({ agent: "Opus (3)", state: "working", task: "x", ack: "AB-5" }), "AZS"));
  assert.ok(desk.state.todos[0].acked_at);
  assert.equal(fs.readFileSync(path.join(legacy, "config.json"), "utf8").includes("abc123"), true, "legacy files untouched");
});

test("HTTP security and API", async (t) => {
  const { desk, put } = makeDesk();
  await desk.start();
  const port = desk.boundPort;
  t.after(() => desk.stop());

  const ping = await request(port, { path: "/api/ping" });
  assert.equal(ping.json.app, "agent-desk");

  // probe 5: DNS rebinding and CSRF
  assert.equal((await request(port, { path: "/api/pairing", headers: { host: "evil.example" } })).status, 403);
  assert.equal((await request(port, { path: "/api/pairing", headers: { host: "localhost" } })).status, 403, "port must match");
  assert.equal((await post(port, "/api/config", { notify: false }, { "content-type": "text/plain" })).status, 415);
  assert.equal((await post(port, "/api/config", { notify: false }, { "x-agent-desk": "" })).status, 403);
  assert.equal((await post(port, "/api/config", { notify: false }, { origin: "http://evil.example" })).status, 403);
  assert.equal((await post(port, "/api/config", { notify: false }, { origin: "http://localhost" })).status, 403, "other local port is another site");
  assert.equal(desk.config.notify, true);
  assert.equal((await post(port, "/api/config", [1, 2])).status, 400);

  const pairing = await request(port, { path: "/api/pairing" });
  assert.equal(pairing.status, 200);
  const key = pairing.json.key;
  // a foreign origin with the key works (phone app); without key it does not
  const withKey = await post(port, "/api/config", { notify: false }, { origin: "capacitor://localhost", "x-agent-desk-key": key });
  assert.equal(withKey.status, 200);
  assert.equal(withKey.headers["access-control-allow-origin"], "capacitor://localhost");
  // admin settings are refused from a non-local (keyed) client
  assert.equal((await post(port, "/api/config", { watch: [] }, { origin: "capacitor://localhost", "x-agent-desk-key": key })).status, 403);
  assert.equal((await post(port, "/api/config", { watch: [{ path: "/definitely/missing", project: "X" }] })).status, 400);

  // pairing link -> HttpOnly cookie
  const link = await request(port, { path: `/?key=${key}`, headers: { origin: "http://evil.example" } });
  assert.equal(link.status, 302);
  assert.match(link.headers["set-cookie"][0], /HttpOnly/);

  // probe 7: incremental polling
  put({ agent: "A", state: "done", task: "t", to: "B", message: "x".repeat(20000) });
  desk.scanOnce();
  const full = await request(port, { path: "/api/state" });
  assert.equal(full.json.events[0].message, undefined, "event log carries no message bodies");
  assert.ok(full.json.todos[0].forward_text.includes("AD-1"));
  const same = await request(port, { path: `/api/state?since=${full.json.version}` });
  assert.deepEqual(same.json, { unchanged: true, version: full.json.version });

  const id = full.json.todos[0].id;
  assert.equal((await post(port, `/api/todo/${id}/done`, {})).status, 200);
  assert.ok(desk.state.todos[0].done_at);
  assert.equal((await post(port, `/api/todo/${id}/undo`, {})).status, 200);
  assert.equal(desk.state.todos[0].done_at, null);

  const rotated = await post(port, "/api/pairing/rotate", {});
  assert.notEqual(rotated.json.key, key);
  assert.equal((await request(port, { path: "/api/state", headers: { origin: "capacitor://localhost", "x-agent-desk-key": key } })).status, 403);
});

test("second copy fails on the port before touching any files", async (t) => {
  const a = makeDesk();
  await a.desk.start();
  t.after(() => a.desk.stop());
  const root = tmp();
  const b = new Desk({ dataDir: path.join(root, "data"), legacyDir: null, port: a.desk.boundPort, lan: false, log: () => {} });
  await assert.rejects(b.start(), (e) => e.code === "EADDRINUSE");
  assert.equal(b.timer, null);
  assert.ok(!fs.existsSync(path.join(root, "data", "state.json")));
});

test("phone app preflight allows the home network (Chromium Private Network Access)", async () => {
  const { desk } = makeDesk();
  await desk.start();
  try {
    const ask = (origin) => request(desk.boundPort, {
      method: "OPTIONS", path: "/api/state",
      headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "x-agent-desk-key", "access-control-request-private-network": "true" },
    });
    const app = await ask("http://localhost");
    assert.equal(app.status, 204);
    assert.equal(app.headers["access-control-allow-origin"], "http://localhost");
    assert.equal(app.headers["access-control-allow-private-network"], "true");
    const evil = await ask("https://evil.example");
    assert.equal(evil.status, 403);
    assert.equal(evil.headers["access-control-allow-private-network"], undefined);
  } finally {
    await desk.stop();
  }
});
