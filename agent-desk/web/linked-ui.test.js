"use strict";
// Independent, synthetic UI regression checks. No Desk, installed app or real mailbox is opened.
// node --test web/linked-ui.test.js
// node web/linked-ui.test.js --serve [port]  -> loopback-only browser fixture (default 18098)
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const taskId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
function fixture() {
  const time = new Date().toISOString();
  return { version: 1, device_id: "fixture-pc", app: { version: "synthetic UI" }, config: { watch: [], stale_minutes: 20, task_repo_roots: [], task_skill_roots: [] }, agents: {}, events: [],
    todos: [{ id: 7, display_id: "AD-7", message_id: "33333333-3333-4333-8333-333333333333", task_id: taskId, project: "Demo", agent: "Codex", to: "Reviewer", kind: "forward", task: "Review", message: "Synthetic handoff", created: time, delivered_at: time, acked_at: time }],
    tasks: [{ task_id: taskId, project_id: projectId, project: "Demo", title: "Проверить передачу контекста", state: "submitted", coordinator_device_id: "fixture-pc", assignment: { agent: "Codex", device_id: "fixture-pc", session_id: "demo-session-a", epoch: 2, role: "executor", adapter: "manual" }, checkpoint: { repo: "C:\\Synthetic\\Demo", branch: "feat/demo", commit: "abcdef1234567", report: "reports/review.md", next_step: "Продолжить проверку UI", constraints: ["Только синтетические данные", "Не открывать настоящую почту"], skills: [] }, artifacts: [{ path: "reports/review.md", sha256: "a".repeat(64), status: "verified" }], history: [{ time, state: "working" }, { time, state: "submitted" }], created: time, updated: time }],
    bindings: [{ id: "demo-binding", project: "Demo", agent: "Reviewer", device_id: "fixture-laptop", session_id: "demo-session-b", role: "reviewer", adapter: "manual" }],
    mail: { roots: [{ project: "Demo", path: "C:\\Synthetic\\Demo-Shared\\mail" }], files: [{ project: "Demo", path: "reviews/ui-review.md", sha256: "b".repeat(64), size: 2048, status: "verified" }, { project: "Demo", path: "reports/checkpoint-with-a-long-name.md", sha256: "c".repeat(64), size: 512 }], errors: [] },
    link: { sync: { status: "synced", pending: 0, last_sync: time }, peers: [{ id: "fixture-laptop", name: "Ноутбук (тест)", online: false, sync: { status: "offline" } }], lan: false } };
}
if (process.argv.includes("--serve")) {
  const http = require("node:http");
  const state = fixture(); let failMode = false;
  const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let body = {};
    if (req.method === "POST") { let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 65536) return json(res, 413, { error: "fixture input too large" }); } try { body = JSON.parse(raw || "{}"); } catch { return json(res, 400, { error: "bad JSON" }); } }
    if (url.pathname === "/api/test/error") { failMode = !!body.enabled; return json(res, 200, { ok: true }); }
    if (url.pathname === "/api/test/empty") { state.tasks = []; state.todos = []; state.mail = { roots: [], files: [], errors: [] }; state.version++; return json(res, 200, { ok: true }); }
    if (failMode && url.pathname.startsWith("/api/")) return json(res, 503, { error: "Synthetic offline/error" });
    if (url.pathname === "/api/state") return json(res, 200, Number(url.searchParams.get("since")) === state.version ? { unchanged: true } : state);
    if (url.pathname === "/api/mail") return json(res, 200, state.mail);
    if (url.pathname === "/api/config") { for (const key of ["task_repo_roots", "task_skill_roots"]) if (Array.isArray(body[key])) state.config[key] = body[key]; state.version++; return json(res, 200, { ok: true }); }
    if (url.pathname === "/api/mail/config") { state.mail.roots = body.roots; state.version++; return json(res, 200, state.mail); }
    if (url.pathname === "/api/tasks/context") return json(res, 200, { text: `[Agent Desk] task_id: ${taskId}\nSynthetic verified context\nNext: UI verification only.`, task: state.tasks.find((t) => t.task_id === url.searchParams.get("id")), checks: { repo: { status: "not_verified", reason: "Synthetic fixture: no Git reads performed" }, artifacts: [{ path: "reports/review.md", status: "verified (synthetic)" }], launch: "needs_manual_launch" } });
    if (url.pathname.startsWith("/api/tasks/")) {
      const mode = url.pathname.split("/").pop(); let task = state.tasks.find((t) => t.task_id === body.task_id);
      if (task && body.assignment_epoch !== task.assignment.epoch) return json(res, 409, { error: "Stale assignment_epoch" });
      if (mode === "transition") { if (!task) return json(res, 404, { error: "not found" }); task.state = body.state; }
      else if (["handoff", "assign"].includes(mode)) {
        if (!task) { task = { task_id: require("node:crypto").randomUUID(), project_id: projectId, project: body.project, title: body.title, checkpoint: {}, artifacts: [], history: [], coordinator_device_id: state.device_id }; state.tasks.push(task); }
        task.assignment = { ...body.assignment, epoch: (task.assignment?.epoch || 0) + 1 }; task.state = "assigned"; if (body.checkpoint) task.checkpoint = body.checkpoint;
      } else return json(res, 404, { error: "unknown fixture route" });
      task.updated = new Date().toISOString(); state.version++; return json(res, 200, task);
    }
    const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.resolve(__dirname, `.${relative}`);
    if (!file.startsWith(__dirname + path.sep) || file === __filename) return res.writeHead(403).end();
    const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".woff2": "font/woff2" };
    try { res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream" }); res.end(fs.readFileSync(file)); } catch { res.writeHead(404).end(); }
  });
  const port = Number(process.argv[process.argv.indexOf("--serve") + 1]) || 18098;
  server.listen(port, "127.0.0.1", () => console.log(`Synthetic AgentDesk UI: http://127.0.0.1:${port}/ (no real mailbox; Ctrl-C to stop)`));
} else {
  const { test } = require("node:test");
  class FakeNode {
    constructor() { this.nodes = new Map(); this.classes = new Set(); this.attrs = new Map(); this.dataset = {}; this.style = {}; this.classList = { toggle: (name, on) => { const enabled = on ?? !this.classes.has(name); if (enabled) this.classes.add(name); else this.classes.delete(name); }, add: (name) => this.classes.add(name), remove: (name) => this.classes.delete(name), contains: (name) => this.classes.has(name) }; this.value = ""; this.innerHTML = ""; this.textContent = ""; this.disabled = false; this.isConnected = true; }
    getAttribute(key) { return this.attrs.get(key) || null; }
    setAttribute(key, value) { this.attrs.set(key, value); }
    querySelector(s) { if (!this.nodes.has(s)) this.nodes.set(s, new FakeNode()); return this.nodes.get(s); }
    querySelectorAll() { return []; }
    addEventListener() {}
    reportValidity() { return true; }
    focus() { this.focused = true; }
    select() { this.selected = true; }
  }
  function harness(state = fixture()) {
    const root = new FakeNode(); const mounted = [];
    const ctx = vm.createContext({ console, Date, Object, Map, Set, String, Number, JSON, Array, Promise, encodeURIComponent, location: { hostname: "localhost" }, localStorage: { getItem: () => null, setItem() {} }, document: { createElement: () => new FakeNode(), querySelector: (s) => s === "#peers-live" ? null : root.querySelector(s), querySelectorAll: () => [], addEventListener() {} }, Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 }, navigator: {}, AD_HOST: { kind: "web" }, __state: state, __mount: (title, html, onMount) => { const n = new FakeNode(); mounted.push({ title, html, node: n }); onMount?.(n); return n; } });
    const source = fs.readFileSync(path.join(__dirname, "app.js"), "utf8").split("// --- desktop app window")[0];
    vm.runInContext(source + '\ndata = __state; project = "*"; online = true; patch = (node, html) => { node.innerHTML = html; }; dialog = __mount; poll = async () => {}; const isNative = false; const native = () => null;', ctx);
    return { ctx, root, mounted, run: (code) => vm.runInContext(code, ctx) };
  }
  const submit = (h) => h.mounted.at(-1).node.querySelector("#task-form").onsubmit({ preventDefault() {} });
  test("full board render retains Agents/Journal/owner queue and exposes accessible linked panels", () => {
    const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]); assert.equal(new Set(ids).size, ids.length);
    const h = harness();
    for (const view of ["agents", "log", "tasks", "mail"]) {
      h.run(`tab = "${view}"; render()`);
      for (const id of ["agents", "log", "tasks", "mail"]) assert.equal(h.root.querySelector(`#${id}-view`).classList.contains("hidden"), id !== view);
    }
    assert.match(h.root.querySelector("#tabs").innerHTML, /Агенты/); assert.match(h.root.querySelector("#tabs").innerHTML, /Журнал/); assert.match(h.root.querySelector("#tabs").innerHTML, /aria-controls="tasks-view"/);
    assert.match(h.root.querySelector("#todo-table tbody").innerHTML, /Сообщение для/);
    h.run('online = false; render()'); assert.equal(h.root.querySelector("#board-offline").classList.contains("hidden"), false); assert.match(h.root.querySelector("#board-offline").textContent, /последние данные/);
  });
  test("task card number is visible before the title, with AD fallback and escaped aliases", () => {
    const state = fixture(); state.tasks[0].card_id = "AT-42";
    const h = harness(state); h.run("renderTasks()");
    assert.match(h.root.querySelector("#task-list").innerHTML, /aria-label="Номер карточки">AT-42<\/code> — Проверить/);
    delete state.tasks[0].card_id; const old = harness(state); old.run("renderTasks()");
    assert.match(old.root.querySelector("#task-list").innerHTML, /Номер карточки">AD-7<\/code>/);
    state.tasks[0].card_id = "<script>x</script>"; const unsafe = harness(state); unsafe.run("renderTasks()");
    assert.doesNotMatch(unsafe.root.querySelector("#task-list").innerHTML, /<script>/);
  });
  test("automatic mail settings are explicit and paired diagnostics expose disabled mode", async () => {
    const state = fixture(); state.mail.mode = "auto"; state.mail.roots = [];
    state.link.peers[0].mail = { mode: "disabled", projects: [], files: 0 };
    const h = harness(state); h.run('renderMail(); globalThis.__mailCalls = []; api = async (url, body) => { __mailCalls.push({url, body}); return {}; }; closeDialog = () => {}; mailRootsDialog();');
    assert.match(h.root.querySelector("#mail-peers").innerHTML, /файловая почта выключена/);
    const node = h.mounted.at(-1).node;
    assert.equal(node.querySelector("#mail-auto").checked, true);
    assert.equal(node.querySelector("#mail-manual").disabled, true);
    await node.querySelector("#mail-roots-form").onsubmit({ preventDefault() {} });
    assert.deepEqual(JSON.parse(h.run("JSON.stringify(__mailCalls[0])")), { url: "/api/mail/config", body: { automatic: true } });
    node.querySelector("#mail-auto").checked = false; node.querySelector("#mail-auto").onchange();
    await node.querySelector("#mail-roots-form").onsubmit({ preventDefault() {} });
    assert.deepEqual(JSON.parse(h.run("JSON.stringify(__mailCalls[1].body)")), { roots: [] });
  });
  test("delivered messages wait quietly and closed cards never request agent launch", () => {
    const h = harness();
    assert.equal(h.run('needsAction({kind:"forward",delivered_at:"2026-11-16"})'), false);
    assert.doesNotMatch(h.run('todoStatus({kind:"forward",delivered_at:"2026-11-16"})'), /нужен|запуск/i);
    assert.equal(h.run('todoStatus({kind:"forward",done_at:"2026-11-16",delivered_at:"2026-11-16"})'), "закрыто");
  });
  test("primary task views show card number and friendly device/session, with UUIDs only in technical disclosure", () => {
    const state = fixture(), t = state.tasks[0]; t.card_id = "AD-351"; t.assignment.device_id = "28b2c0078428334f"; t.assignment.session_id = "ad-ack-48a26097f3404eeb";
    state.link.peers.push({id:t.assignment.device_id,name:"Рабочий ПК",online:true});
    const h = harness(state); h.run("renderTasks()"); const html = h.root.querySelector("#task-list").innerHTML;
    assert.match(html, /AD-351/); assert.match(html, /Рабочий ПК/);
    assert.doesNotMatch(html.split('<details class="technical-details">')[0].replace(/<[^>]*>/g, ""), /28b2c0078428334f|ad-ack-48a26097f3404eeb|11111111-1111-4111/);
    h.run("taskDetails(taskList()[0])"); const dialog = h.mounted.at(-1).html;
    assert.match(dialog, /AD-351/); assert.match(dialog, /Технические данные/);
    assert.doesNotMatch(dialog.split('<details class="technical-details">')[0], /11111111-1111-4111|28b2c0078428334f|ad-ack-/);
  });
  test("owner message details prefer AD number over technical task/message IDs", () => {
    const h = harness(); h.run('selected={type:"todo",id:7}; ACTIONS.details()'); const html=h.mounted.at(-1).html;
    assert.match(html,/AD-7/); assert.match(html,/Технические данные/);
    assert.doesNotMatch(html.split('<details class="technical-details">')[0], /33333333-3333-4333|11111111-1111-4111/);
  });
  test("file mailbox is an optional menu, not a primary work tab", () => {
    const h=harness();h.run("render()");assert.doesNotMatch(h.root.querySelector("#tabs").innerHTML,/Общая почта|tab-mail/);
    assert.match(fs.readFileSync(path.join(__dirname,"index.html"),"utf8"),/data-action="file-tools"/);
  });
  test("one card per UUID, lifecycle independent of ACK, escaped task/receipt values", () => {
    const state = fixture(); state.tasks[0].title = '<img src=x onerror="alert(1)">'; state.tasks.push({ ...state.tasks[0] }); state.todos[0].message_id = '<script>x</script>';
    const h = harness(state); h.run("renderTasks()"); const html = h.root.querySelector("#task-list").innerHTML;
    assert.equal((html.match(/<article/g) || []).length, 1); assert.match(html, /сдана на проверку/); assert.match(html, /&lt;img/); assert.match(h.run("technicalDetails(data.todos[0])"), /&lt;script/); assert.doesNotMatch(html, /<script>/); assert.equal(h.run("data.todos.filter(needsAction).length"), 0);
    assert.equal(h.run('needsAction({ kind: "receipt" })'), false); assert.equal(h.run('needsAction({ kind: "reply" })'), true);
    assert.equal(h.run('needsAction({ kind: "forward", delivered_at: "2026-11-16" })'), false);
    assert.equal(h.run('needsAction({ kind: "forward", delivery_target: "fixture-laptop" })'), false);
    assert.equal(h.run('needsAction({ kind: "forward", delivery_target: "fixture-pc", delivered_at: "2026-11-16" })'), false);
  });
  test("replicated agents keep actual map keys and show device identity without cross-device selection collision", () => {
    const state = fixture(); const time = new Date().toISOString();
    const agent = { project: "Demo", agent: "Codex", state: "working", first_seen: time, updated: time, task: "Local task", device_id: "fixture-pc" };
    state.agents = { "Demo/Codex": agent, "remote:44444444-4444-4444-8444-444444444444": { ...agent, device_id: "fixture-laptop", task: "Remote task" } };
    const h = harness(state); h.run('tab = "agents"; render()');
    const html = h.root.querySelector("#agent-table tbody").innerHTML;
    assert.match(html, /data-agent="Demo\/Codex"/); assert.match(html, /data-agent="remote:44444444-4444-4444-8444-444444444444"/); assert.match(html, /Ноутбук \(тест\)/);
    h.run('selected = { type: "agent", id: "remote:44444444-4444-4444-8444-444444444444" }; applySelection(); ACTIONS.details()');
    assert.equal(h.root.querySelector("#tb-forget").disabled, true); assert.match(h.mounted.at(-1).html, /Remote task/);
  });
  test("project filtering, empty/old-server states and offline coordinator gates", () => {
    const h = harness(); h.run('project = "Missing"; renderTasks()'); assert.match(h.root.querySelector("#task-list").innerHTML, /Задач пока нет/);
    h.run('project = "*"; online = false; renderTasks()'); assert.match(h.root.querySelector("#task-list").innerHTML, /Нет связи/); assert.equal(h.root.querySelector("#task-new").disabled, true);
    h.run('online = true; data.device_id = "other"'); assert.equal(h.run("canCoordinate(data.tasks[0])"), false);
    h.run('delete data.tasks; renderTasks()'); assert.match(h.root.querySelector("#task-list").innerHTML, /Ожидается сервер/);
  });
  test("mail uses relative paths and SHA, never exposes local roots in the list", () => {
    const h = harness(); h.run("renderMail()"); const html = h.root.querySelector("#mail-list").innerHTML;
    assert.match(html, /reviews\/ui-review.md/); assert.match(html, new RegExp("b".repeat(64))); assert.doesNotMatch(html, /C:\\Synthetic/);
    assert.equal(h.run('relativeMailPath("../../secret")'), "Небезопасный путь скрыт"); assert.equal(h.run('relativeMailPath("C:\\\\secret")'), "Небезопасный путь скрыт");
    h.run('data.mail.errors = [{ project: "Demo", error: "<script>bad</script>" }]; renderMail()'); assert.match(h.root.querySelector("#mail-errors").innerHTML, /&lt;script/);
    h.run('data.mail = { roots: [], files: [], errors: [] }; renderMail()'); assert.match(h.root.querySelector("#mail-list").innerHTML, /не настроены/);
  });
  test("assign payload carries explicit device/session/role, defaults manual adapter", async () => {
    const h = harness(); const calls = []; h.ctx.__api = async (url, body) => { calls.push({ url, body }); return {}; }; h.run('api = __api; taskMutationDialog("assign", null)'); const n = h.mounted.at(-1).node;
    for (const [id, value] of Object.entries({ "#task-project": "Demo", "#task-title": "New task", "#assign-agent": "Codex", "#assign-device_id": "fixture-pc", "#assign-session_id": "new-session", "#assign-role": "executor" })) n.querySelector(id).value = value;
    await submit(h); assert.equal(calls[0].url, "/api/tasks/assign"); assert.equal(calls[0].body.assignment.session_id, "new-session"); assert.equal(calls[0].body.assignment.adapter, "manual"); assert.equal(calls[0].body.title, "New task"); assert.equal(calls[0].body.task_id, undefined);
  });
  test("transition sends exact bound reporter and epoch, not ACK", async () => {
    const h = harness(); const calls = []; h.ctx.__api = async (url, body) => { calls.push({ url, body }); return {}; }; h.run('api = __api; taskMutationDialog("transition", data.tasks[0])'); h.mounted.at(-1).node.querySelector("#task-state").value = "accepted";
    await submit(h); const body = calls[0].body; assert.equal(body.agent, "Codex"); assert.equal(body.device_id, "fixture-pc"); assert.equal(body.session_id, "demo-session-a"); assert.equal(body.assignment_epoch, 2); assert.equal(body.state, "accepted"); assert.equal(body.ack, undefined);
  });
  test("handoff saves structured checkpoint, then fetches server context (no unchecked copy)", async () => {
    const h = harness(); const calls = []; h.ctx.__api = async (url, body) => { calls.push({ url, body }); return url.includes("context?") ? { text: "VERIFIED SERVER TEXT", checks: { status: "warning" }, task: fixture().tasks[0] } : fixture().tasks[0]; }; h.run('api = __api; taskMutationDialog("handoff", data.tasks[0])'); const n = h.mounted.at(-1).node;
    for (const [key, value] of Object.entries({ agent: "Reviewer", device_id: "fixture-laptop", session_id: "new-session", role: "reviewer", adapter: "manual" })) n.querySelector(`#assign-${key}`).value = value;
    n.querySelector("#handoff-constraints").value = "Synthetic only\nNo secrets"; await submit(h);
    assert.equal(calls[0].url, "/api/tasks/handoff"); assert.deepEqual(Array.from(calls[0].body.checkpoint.constraints), ["Synthetic only", "No secrets"]); assert.equal(calls[0].body.checkpoint.repo, "C:\\Synthetic\\Demo"); assert.match(calls[1].url, /\/api\/tasks\/context\?id=/); assert.equal(h.mounted.at(-1).node.querySelector("#task-context").value, "VERIFIED SERVER TEXT");
  });
  test("saved handoff cannot be repeated when context retrieval fails; conflict is visible", async () => {
    const h = harness(); h.ctx.__api = async (url) => { if (url.includes("context?")) throw new Error("Offline fixture"); return fixture().tasks[0]; }; h.run('api = __api; taskMutationDialog("handoff", data.tasks[0])'); const n = h.mounted.at(-1).node; n.querySelector("#handoff-constraints").value = "Synthetic"; await submit(h);
    assert.equal(n.querySelector("#task-save").disabled, true); assert.match(n.querySelector("#task-error").textContent, /Контекст|контекст/);
    const conflict = harness(); conflict.ctx.__api = async () => { throw Object.assign(new Error("Stale assignment_epoch"), { status: 409 }); }; conflict.run('api = __api; taskMutationDialog("transition", data.tasks[0])'); await submit(conflict); assert.match(conflict.mounted.at(-1).node.querySelector("#task-error").textContent, /Назначение изменилось/);
  });
  test("context root approvals read existing configuration and POST only explicit deduplicated local paths", async () => {
    const state = fixture(); state.config.task_repo_roots = ["C:\\Synthetic\\Demo"]; state.config.task_skill_roots = ["C:\\Synthetic\\Skills"];
    const h = harness(state); const calls = [];
    h.ctx.__api = async (url, body) => { calls.push({ url, body }); return { ok: true }; };
    h.run('api = __api; contextRootsDialog()'); const n = h.mounted.at(-1).node;
    assert.equal(n.querySelector("#context-repo-roots").value, "C:\\Synthetic\\Demo"); assert.equal(n.querySelector("#context-skill-roots").value, "C:\\Synthetic\\Skills");
    n.querySelector("#context-repo-roots").value = " C:\\Synthetic\\Demo \r\nC:\\Synthetic\\Demo\nC:\\Synthetic\\Other\n"; n.querySelector("#context-skill-roots").value = "";
    await n.querySelector("#context-roots-form").onsubmit({ preventDefault() {} });
    assert.equal(calls[0].url, "/api/config"); assert.deepEqual(Array.from(calls[0].body.task_repo_roots), ["C:\\Synthetic\\Demo", "C:\\Synthetic\\Other"]); assert.equal(calls[0].body.task_skill_roots.length, 0); assert.deepEqual(Object.keys(calls[0].body).sort(), ["task_repo_roots", "task_skill_roots"]);
    assert.deepEqual(state.config.watch, []);
  });
  test("context root approvals enforce local/offline/length gates and preserve server validation errors", async () => {
    const h = harness(); h.ctx.__api = async () => { throw new Error("Directory not found"); }; h.run('api = __api; contextRootsDialog()'); const n = h.mounted.at(-1).node;
    n.querySelector("#context-repo-roots").value = Array.from({ length: 21 }, (_, i) => `C:\\Synthetic\\R${i}`).join("\n");
    await n.querySelector("#context-roots-form").onsubmit({ preventDefault() {} }); assert.match(n.querySelector("#context-roots-error").textContent, /20/);
    n.querySelector("#context-repo-roots").value = "C:\\Synthetic\\Missing"; await n.querySelector("#context-roots-form").onsubmit({ preventDefault() {} }); assert.match(n.querySelector("#context-roots-error").textContent, /Directory not found/);
    h.run('online = false; renderTasks()'); assert.equal(h.root.querySelector("#task-context-roots").disabled, true);
    h.run('online = true; AD_HOST.kind = "mobile"; renderTasks()'); assert.equal(h.root.querySelector("#task-context-roots").classList.contains("hidden"), true);
    const before = h.mounted.length; h.run('contextRootsDialog()'); assert.equal(h.mounted.length, before + 1); assert.match(h.mounted.at(-1).html, /только локально/);
  });
  test("UI mutation bodies are accepted by the real TaskService in a purely in-memory desk", async () => {
    const { TaskService } = require("../core/tasks.js");
    let saves = 0;
    const desk = { config: { device_id: "fixture-pc", watch: [] }, state: { tasks: {}, bindings: {} }, _saveState() { saves++; }, emit() {} };
    const service = new TaskService(desk);
    const state = fixture(); state.tasks = []; state.todos = [];
    const h = harness(state);
    h.ctx.__desk = desk;
    h.ctx.__api = async (url, body) => url.includes("context?") ? service.context(new URL(url, "http://localhost").searchParams.get("id")) : service[url.split("/").pop()](body);
    h.run('api = __api; taskMutationDialog("assign", null)');
    let n = h.mounted.at(-1).node;
    for (const [id, value] of Object.entries({ "#task-project": "Demo", "#task-title": "Contract test", "#assign-agent": "Codex", "#assign-device_id": "fixture-pc", "#assign-session_id": "contract-session-a", "#assign-role": "executor", "#assign-adapter": "manual" })) n.querySelector(id).value = value;
    await submit(h);
    assert.equal(Object.values(desk.state.tasks).length, 1);
    for (const state of ["working", "submitted", "accepted"]) {
      h.run('data.tasks = Object.values(__desk.state.tasks); taskMutationDialog("transition", data.tasks[0])');
      h.mounted.at(-1).node.querySelector("#task-state").value = state;
      await submit(h); assert.equal(Object.values(desk.state.tasks)[0].state, state);
    }
    h.run('data.tasks = Object.values(__desk.state.tasks); taskMutationDialog("handoff", data.tasks[0])');
    n = h.mounted.at(-1).node;
    for (const [k, v] of Object.entries({ agent: "Reviewer", device_id: "fixture-laptop", session_id: "contract-session-b", role: "reviewer", adapter: "manual" })) n.querySelector(`#assign-${k}`).value = v;
    n.querySelector("#handoff-next").value = "Synthetic verification only";
    n.querySelector("#handoff-constraints").value = "No real mailbox\nNo installation";
    await submit(h);
    const task = Object.values(desk.state.tasks)[0];
    assert.equal(task.assignment.epoch, 2); assert.equal(task.assignment.session_id, "contract-session-b"); assert.equal(task.state, "assigned"); assert.equal(saves, 5);
    assert.match(h.mounted.at(-1).node.querySelector("#task-context").value, new RegExp(task.task_id));
    assert.equal(task.launch.status, "needs_manual_launch");
  });
  test("context copy uses only server text and escapes verification metadata; prompt uses UUID receipt semantics", async () => {
    const h = harness(); let copied; h.ctx.__copy = async (text) => { copied = text; return true; }; h.run('copyText = __copy; contextDialog(data.tasks[0], { text: "SERVER VERIFIED", checks: { warning: "<img onerror=x>" } })'); const dialog = h.mounted.at(-1); assert.match(dialog.html, /&lt;img/); await dialog.node.querySelector("#copy-context").onclick(); assert.equal(copied, "SERVER VERIFIED");
    const prompt = h.run('agentPrompt({ project: "Demo", path: "C:\\\\Synthetic\\\\inbox" })'); assert.match(prompt, /message_id — глобальный UUID/); assert.match(prompt, /ACK не означает/); assert.match(prompt, /task_id — UUID/);
  });
}
