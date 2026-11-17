"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");
const { AgentClient, AgentClientError, COMMANDS, MAX_INPUT, loopbackServer } = require("../agent-client.js");
const { parseArguments, runCli } = require("../cli.js");
const { callAgentTool, registerAgentTools } = require("../mcp.js");
const CLI = path.resolve(__dirname, "../cli.js");
const MCP = path.resolve(__dirname, "../mcp.js");
const KEY = "0123456789abcdef0123456789abcdef";
const OWNER_KEY = "owner-secret-must-not-be-used";

async function fixture(t, handler) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-desk-cli-"));
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { url: req.url, method: req.method, headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined };
    calls.push(call);
    if (handler) return handler(call, res);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, route: req.url, body: call.body, device_id: "synthetic-device" }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  const config = { port, agent_key: KEY, key: OWNER_KEY, watch: [{ project: "synthetic", path: "never-watched" }], unrelated: "keep-me" };
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(home, "state.json"), '{"untouched":true}');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, port, calls, config, server, client: new AgentClient({ home }) };
}

function command(entry, args, home, input = "", extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env: { ...process.env, AGENT_DESK_HOME: home, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("synthetic CLI process timed out")); }, 8000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
const json = (result) => JSON.parse(result.stdout);

// Each command is verified against the shared contract, NOT Desk's mutable state.
test("all nine client commands use scoped agent routes and the separate key", async (t) => {
  const { client, calls, home } = await fixture(t);
  const before = fs.readFileSync(path.join(home, "config.json"), "utf8");
  const bodies = {
    inbox: { project: "Project & one", agent: "A/B", session_id: "session one" }, read: { id: "message-uuid" },
    ack: { project: "P", agent: "B", message_id: "immutable-message", session_id: "s" },
    submit: { project: "P", agent: "B", state: "done", task_id: "task-uuid", assignment_epoch: 4, session_id: "s" },
    status: {}, handoff: { task_id: "task-uuid", assignment_epoch: 4, assignment: { agent: "C", session_id: "s2" }, checkpoint: { report: "synthetic" } },
    context: { id: "task-uuid" }, assign: { task_id: "task-uuid", assignment: { agent: "B", device_id: "d", session_id: "s" } },
    transition: { task_id: "task-uuid", state: "working", assignment_epoch: 4, session_id: "s" },
  };
  for (const [name, spec] of Object.entries(COMMANDS)) {
    await client.execute(name, bodies[name]);
    const call = calls.at(-1);
    assert.equal(call.method, spec.method);
    const url = new URL(call.url, "http://127.0.0.1");
    assert.equal(url.pathname, spec.route);
    assert.equal(call.headers["x-agent-desk-agent-key"], KEY);
    assert.equal(call.headers["x-agent-desk-key"], undefined);
    assert.equal(call.headers.authorization, undefined);
    assert.ok(!call.url.includes(KEY) && !call.url.includes(OWNER_KEY));
    if (spec.method === "POST") {
      assert.equal(call.headers["x-agent-desk"], "1");
      assert.deepEqual(call.body, bodies[name]);
    } else for (const [key, value] of Object.entries(bodies[name])) assert.equal(url.searchParams.get(key), value);
  }
  assert.equal(fs.readFileSync(path.join(home, "config.json"), "utf8"), before);
  assert.equal(fs.readFileSync(path.join(home, "state.json"), "utf8"), '{"untouched":true}');
  assert.deepEqual(fs.readdirSync(home).sort(), ["config.json", "state.json"]);
  assert.equal(JSON.stringify(client), "{}");
});

test("CLI flags, JSON stdin and JSON file preserve structured metadata and override fields", async (t) => {
  const { home, calls } = await fixture(t);
  const stdin = { project: "P", agent: "A", state: "working", assignment_epoch: 3, checkpoint: { repo: "synthetic-repo", report: "not executed" }, task_id: "uuid" };
  let result = await command(CLI, ["submit", "--state", "done", "--assignment-epoch=4", "--session-id", "new-session", "--needs-forward"], home, JSON.stringify(stdin));
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stderr, "");
  assert.equal(json(result).body.state, "done");
  assert.equal(calls.at(-1).body.assignment_epoch, 4);
  assert.equal(calls.at(-1).body.needs_forward, true);
  assert.deepEqual(calls.at(-1).body.checkpoint, stdin.checkpoint);
  const file = path.join(home, "input.json");
  fs.writeFileSync(file, JSON.stringify({ task_id: "uuid", assignment_epoch: 4, assignment: { agent: "B", device_id: "d", session_id: "s" }, artifacts: [{ path: "synthetic.txt", hash: "hash", status: "submitted" }] }));
  result = await command(CLI, ["handoff", "--file", file, "--checkpoint", '{"next_step":"review"}'], home);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(calls.at(-1).url, "/api/agent/task/handoff");
  assert.deepEqual(calls.at(-1).body.checkpoint, { next_step: "review" });
  assert.equal(calls.at(-1).body.assignment.session_id, "s");
  result = await command(CLI, ["ack", "--json", '{"project":"P","agent":"B","message_id":"uuid"}', "--session-id=s"], home);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(calls.at(-1).body, { project: "P", agent: "B", message_id: "uuid", session_id: "s" });
  result = await command(CLI, ["context", "task/uuid?one", "--home", home], home);
  assert.equal(result.code, 0);
  assert.equal(new URL(calls.at(-1).url, "http://127.0.0.1").searchParams.get("id"), "task/uuid?one");
});

test("CLI remaining read/inbox/assign commands hit contract routes", async (t) => {
  const { home, calls } = await fixture(t);
  for (const [args, route] of [
    [["inbox", "--project=P", "--agent=A", "--session-id=s"], "/api/agent/inbox"],
    [["read", "immutable-message-uuid"], "/api/agent/read"],
    [["assign", "--project=P", "--title=synthetic", "--agent=A", "--device-id=d", "--session-id=s"], "/api/agent/task/assign"],
  ]) {
    const result = await command(CLI, args, home);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(new URL(calls.at(-1).url, "http://127.0.0.1").pathname, route);
  }
});

test("CLI can use an explicit loopback server port without updating stored config", async (t) => {
  const { home, port } = await fixture(t);
  const file = path.join(home, "config.json");
  fs.writeFileSync(file, JSON.stringify({ port: 1, agent_key: KEY }));
  const before = fs.readFileSync(file, "utf8");
  const result = await command(CLI, ["status", "--server", `http://localhost:${port}`], home);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(json(result).device_id, "synthetic-device");
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("unsafe destinations rejected before config read, including credentials and URL paths", () => {
  for (const server of ["https://127.0.0.1:8098", "http://192.168.1.2:8098", "http://example.com", "http://127.0.0.1.example.com", "http://user:pass@127.0.0.1:8098", "http://127.0.0.1/api", "http://127.0.0.1?key=x", "http://127.0.0.1#x", "file:///tmp/config", "http://[::ffff:192.168.0.1]"]) {
    assert.throws(() => new AgentClient({ home: "synthetic-config-that-does-not-exist", server }), (e) => e.code === "UNSAFE_SERVER", server);
  }
  assert.equal(loopbackServer("http://localhost:8098").hostname, "127.0.0.1");
  assert.equal(loopbackServer("http://[::1]:8098").hostname, "[::1]");
});

test("HTTP redirects never forward the credential to another request", async (t) => {
  const { home, calls } = await fixture(t, (_call, res) => { res.writeHead(302, { Location: "http://example.com/stolen" }); res.end(); });
  const result = await command(CLI, ["status"], home);
  assert.equal(result.code, 1);
  assert.equal(json(result).error.code, "REDIRECT_BLOCKED");
  assert.equal(calls.length, 1);
  assert.ok(!result.stdout.includes(KEY));
});

test("HTTP conflict is machine readable, preserves status, is not retried, and redacts decoded key echoes", async (t) => {
  const escaped = KEY.split("").map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const { home, calls } = await fixture(t, (_call, res) => { res.writeHead(409, { "Content-Type": "application/json" }); res.end(`{"ok":false,"error":{"message":"retired session ${escaped}"}}`); });
  const result = await command(CLI, ["transition", "--task-id=t", "--state=working", "--assignment-epoch=1"], home);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(json(result), { ok: false, error: { code: "HTTP_ERROR", message: "retired session [REDACTED]", status: 409 } });
  assert.equal(calls.length, 1);
});

test("successful credential echo is redacted too", async (t) => {
  const { client } = await fixture(t, (_call, res) => { res.end(JSON.stringify({ task: { note: `echo ${KEY}` }, [KEY]: KEY })); });
  assert.deepEqual(await client.execute("status"), { task: { note: "echo [REDACTED]" }, "[REDACTED]": "[REDACTED]" });
});

test("missing separate key never falls back to owner key or creates/repairs config", async (t) => {
  const { home, calls } = await fixture(t);
  const file = path.join(home, "config.json");
  fs.writeFileSync(file, JSON.stringify({ port: 8098, key: OWNER_KEY }));
  let before = fs.readFileSync(file, "utf8");
  let result = await command(CLI, ["status"], home);
  assert.equal(result.code, 1);
  assert.equal(json(result).error.code, "AGENT_KEY_MISSING");
  assert.ok(!result.stdout.includes(OWNER_KEY));
  assert.equal(fs.readFileSync(file, "utf8"), before);
  fs.writeFileSync(file, '{"broken":');
  before = fs.readFileSync(file, "utf8");
  result = await command(CLI, ["status"], home);
  assert.equal(json(result).error.code, "INVALID_CONFIG");
  assert.equal(fs.readFileSync(file, "utf8"), before);
  fs.unlinkSync(file);
  result = await command(CLI, ["status"], home);
  assert.equal(json(result).error.code, "CONFIG_UNAVAILABLE");
  assert.equal(fs.existsSync(file), false);
  assert.equal(calls.length, 0);
});

test("invalid arguments and malformed JSON fail on stdout with no HTTP or secret output", async (t) => {
  const { home, calls } = await fixture(t);
  for (const [args, input, code] of [
    [["wat"], "", "UNKNOWN_COMMAND"], [["read"], "", "INVALID_INPUT"],
    [["submit"], "{", "INVALID_JSON"], [["submit"], "[]", "INVALID_JSON"],
    [["submit", "--seq=1.5"], "", "INVALID_ARGUMENT"], [["submit", "--needs-forward=no"], "", "INVALID_ARGUMENT"],
    [["status", "--key", KEY], "", "INVALID_ARGUMENT"], [["read", "one", "two"], "", "INVALID_ARGUMENT"],
    [["status", "--file", "synthetic-absent-input.json"], "", "INPUT_UNAVAILABLE"],
    [["status", "--project=P"], "", "INVALID_INPUT"],
  ]) {
    const result = await command(CLI, args, home, input);
    assert.equal(result.code, 1, result.stdout);
    assert.equal(result.stderr, "");
    assert.equal(json(result).error.code, code);
    assert.ok(!result.stdout.includes(KEY) && !result.stdout.includes(OWNER_KEY));
  }
  assert.equal(calls.length, 0);
  assert.throws(() => parseArguments(["submit", "--file=a", "--json={}"]), (e) => e.code === "INVALID_ARGUMENT");
  assert.throws(() => parseArguments(["submit", "--seq=1", "--seq=2"]), (e) => e.code === "INVALID_ARGUMENT");
  assert.throws(() => parseArguments(["--server=http://127.0.0.1", "status"], { mcp: true }), (e) => e.code === "INVALID_ARGUMENT");
});

test("invalid config ports, unsafe header keys and timeouts are rejected without HTTP", async (t) => {
  const { home, calls } = await fixture(t);
  for (const port of [0, -1, 65536, "8098", 1.5]) {
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ port, agent_key: KEY }));
    assert.throws(() => new AgentClient({ home }), (e) => e.code === "INVALID_CONFIG");
  }
  for (const agent_key of ["", KEY + "\r\nX-Injected: true", "short", 123]) {
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ port: 8098, agent_key }));
    assert.throws(() => new AgentClient({ home }), (e) => e.code === "AGENT_KEY_MISSING");
  }
  for (const timeout of [0, 120001, NaN, 1.5]) {
    assert.throws(() => new AgentClient({ home, timeout }), (e) => e.code === "INVALID_TIMEOUT");
  }
  assert.equal(calls.length, 0);
});

test("stdin and body limits fail before sending HTTP", async (t) => {
  const { home, client, calls } = await fixture(t);
  let stdout = "";
  const code = await runCli(["submit", "--home", home], { stdin: Readable.from([`{"message":"${"x".repeat(MAX_INPUT)}"}`]), stdout: { write: (chunk) => { stdout += chunk; } } });
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).error.code, "INPUT_TOO_LARGE");
  await assert.rejects(client.execute("submit", { message: "x".repeat(MAX_INPUT) }), (e) => e.code === "INPUT_TOO_LARGE");
  await assert.rejects(client.execute("read", { id: { bad: "nested" } }), (e) => e.code === "INVALID_INPUT");
  assert.equal(calls.length, 0);
});

test("HTTP timeout, interrupted response, invalid JSON and oversized response are bounded", async (t) => {
  await t.test("timeout", async (t) => {
    const { home, calls } = await fixture(t, () => {});
    await assert.rejects(new AgentClient({ home, timeout: 40 }).execute("submit", {}), (e) => e.code === "TIMEOUT");
    assert.equal(calls.length, 1);
  });
  await t.test("non JSON", async (t) => {
    const { client } = await fixture(t, (_call, res) => { res.end("not json"); });
    await assert.rejects(client.execute("status"), (e) => e.code === "INVALID_RESPONSE");
  });
  await t.test("oversize", async (t) => {
    const { client } = await fixture(t, (_call, res) => { res.end(JSON.stringify({ data: "x".repeat(2 * 1024 * 1024) })); });
    await assert.rejects(client.execute("status"), (e) => e.code === "RESPONSE_TOO_LARGE");
  });
  await t.test("interrupted", async (t) => {
    const { client } = await fixture(t, (_call, res) => { res.writeHead(200, { "Content-Length": "100" }); res.write("{"); setImmediate(() => res.destroy()); });
    await assert.rejects(client.execute("status"), (e) => ["NETWORK_ERROR", "INVALID_RESPONSE"].includes(e.code));
  });
});

test("help needs no config and documents receipt semantics", async (t) => {
  const { home } = await fixture(t);
  fs.unlinkSync(path.join(home, "config.json"));
  const result = await command(CLI, ["--help"], home);
  assert.equal(result.code, 0);
  assert.deepEqual(json(result).commands, Object.keys(COMMANDS));
  assert.ok(json(result).notes.some((s) => s.includes("receipt")));
});

// A schema-builder stub tests registration/forwarding only. SDK owns all protocol framing.
function mockZod() {
  function schema(kind, shape) {
    const value = { kind, shape };
    for (const method of ["min", "max", "int", "nonnegative", "optional", "strict", "passthrough"]) value[method] = () => value;
    return value;
  }
  return { string: () => schema("string"), number: () => schema("number"), boolean: () => schema("boolean"), union: (shape) => schema("union", shape), unknown: () => schema("unknown"), object: (shape) => schema("object", shape), array: (shape) => schema("array", shape) };
}

test("MCP registers nine tools and uses the same authenticated client without SDK dependency", async (t) => {
  const { client, calls } = await fixture(t);
  const tools = new Map();
  const server = { registerTool: (name, spec, handler) => tools.set(name, { spec, handler }) };
  assert.equal(registerAgentTools(server, client, mockZod()), server);
  assert.equal(tools.size, 9);
  for (const name of Object.keys(COMMANDS)) {
    const tool = tools.get(`agent_desk_${name}`);
    assert.ok(tool);
    assert.equal(tool.spec.annotations.readOnlyHint, COMMANDS[name].method === "GET");
    const input = ["read", "context"].includes(name) ? { id: "uuid" } : name === "status" ? {} : name === "inbox" ? { project: "P" } : { task_id: "uuid", session_id: "s", assignment_epoch: 4, checkpoint: { next_step: "review" } };
    const result = await tool.handler(input);
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.equal(calls.at(-1).headers["x-agent-desk-agent-key"], KEY);
    if (COMMANDS[name].method === "POST") assert.deepEqual(calls.at(-1).body, input);
  }
  assert.match(tools.get("agent_desk_ack").spec.description, /does NOT accept or complete/);
});

test("MCP error result is machine readable and does not serialize unknown error details", async () => {
  let result = await callAgentTool({ execute: async () => { throw new AgentClientError("HTTP_ERROR", "stale assignment", 409); } }, "transition", {});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.status, 409);
  result = await callAgentTool({ execute: async () => { throw new Error(KEY); } }, "status", {});
  assert.equal(result.structuredContent.error.code, "INTERNAL_ERROR");
  assert.ok(!JSON.stringify(result).includes(KEY));
});

let sdkAvailable = false;
try { require.resolve("@modelcontextprotocol/sdk/client/index.js"); require.resolve("zod/v4"); sdkAvailable = true; } catch { /* parent installs dependencies */ }

test("MCP missing dependency is a nonzero startup error on stderr only", { skip: sdkAvailable && "SDK installed; see official stdio smoke" }, async (t) => {
  const { home } = await fixture(t);
  const result = await command(MCP, [], home);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).error.code, "MCP_SDK_MISSING");
  assert.ok(!result.stderr.includes(KEY));
});

test("CLI and MCP assign, read and ACK against an isolated real Desk", { skip: !sdkAvailable && "official MCP SDK not installed" }, async (t) => {
  const { Desk } = require("../desk.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-desk-real-api-"));
  const desk = new Desk({ dataDir: home, legacyDir: null, port: 0, lan: false, discovery: false, log() {} });
  desk.config.watch = [];
  await desk.start(); desk.peers.stop(); desk.config.port = desk.boundPort; desk._saveConfig();
  t.after(async () => { await desk.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  const prompt = "Проверь поиск задания.\nНе потеряй последнюю строку.";
  const result = await command(CLI, ["assign", "--project=P", "--title=CLI assignment", "--agent=Worker", "--session-id=cli-session", "--prompt", prompt], home);
  assert.equal(result.code, 0, result.stdout);
  const cliTask = json(result);
  assert.equal(desk.state.todos.length, 1);
  const read = await command(CLI, ["read", cliTask.assignment_message_id], home);
  assert.equal(read.code, 0, read.stdout);
  assert.ok(json(read).todo.forward_text.includes(prompt));
  assert.equal(desk.state.todos[0].forwarded_at, null);
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP, "--home", home], env: { ...process.env, AGENT_DESK_HOME: home }, stderr: "pipe" });
  const client = new Client({ name: "assignment-contract", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const assigned = await client.callTool({ name: "agent_desk_assign", arguments: { project: "P", title: "MCP assignment", agent: "Worker", session_id: "mcp-session", prompt } });
    assert.equal(assigned.isError, undefined, JSON.stringify(assigned));
    const task = assigned.structuredContent;
    assert.equal(desk.state.todos.length, 2);
    const listed = await client.callTool({ name: "agent_desk_inbox", arguments: { project: "P", agent: "Worker", session_id: "mcp-session" } });
    assert.equal(listed.structuredContent.todos.length, 1);
    assert.equal(listed.structuredContent.todos[0].message_id, task.assignment_message_id);
    const ack = await client.callTool({ name: "agent_desk_ack", arguments: { project: "P", agent: "Worker", session_id: "mcp-session", message_id: task.assignment_message_id, assignment_epoch: 1 } });
    assert.equal(ack.isError, undefined, JSON.stringify(ack));
    assert.ok(desk.state.todos.find(row => row.message_id === task.assignment_message_id).acked_at);
    assert.equal(desk.state.tasks[task.task_id].state, "assigned");
    const bad = await client.callTool({ name: "agent_desk_submit", arguments: { project: "P", agent: "Worker", state: "done", message: "x".repeat(20001) } });
    assert.equal(bad.isError, true);
    assert.equal(desk.state.todos.length, 2);
  } finally { await client.close(); }
});

test("official SDK stdio list/call smoke with only synthetic loopback HTTP", { skip: !sdkAvailable && "official MCP SDK not installed; parent must install and rerun" }, async (t) => {
  const { home, calls } = await fixture(t);
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP, "--home", home], env: { ...process.env, AGENT_DESK_HOME: home }, stderr: "pipe" });
  const client = new Client({ name: "agent-desk-synthetic-test", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 9);
    const result = await client.callTool({ name: "agent_desk_ack", arguments: { project: "P", agent: "A", message_id: "synthetic-uuid" } });
    assert.equal(result.isError, undefined);
    assert.equal(calls.at(-1).url, "/api/agent/ack");
    assert.equal(calls.at(-1).headers["x-agent-desk-agent-key"], KEY);
    assert.deepEqual(calls.at(-1).body, { project: "P", agent: "A", message_id: "synthetic-uuid" });
  } finally { await client.close(); }
});
