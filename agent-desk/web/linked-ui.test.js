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
    const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".woff": "font/woff", ".woff2": "font/woff2" };
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
    const ctx = vm.createContext({ console, Date, Object, Map, Set, String, Number, JSON, Array, Promise, crypto: require("node:crypto").webcrypto, window: { addEventListener() {} }, encodeURIComponent, location: { hostname: "localhost" }, localStorage: { getItem: () => null, setItem() {} }, document: { createElement: () => new FakeNode(), querySelector: (s) => s === "#peers-live" ? null : root.querySelector(s), querySelectorAll: () => [], addEventListener() {} }, Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 }, navigator: {}, AD_HOST: { kind: "web" }, __state: state, __mount: (title, html, onMount) => { const n = new FakeNode(); mounted.push({ title, html, node: n }); onMount?.(n); return n; } });
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
    assert.equal(h.root.querySelector("#todo-table tbody").innerHTML, "");
    h.run('todoFilter = "all"; renderTodos()');
    assert.match(h.root.querySelector("#todo-table tbody").innerHTML, /AD-7/);
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
    assert.equal(h.run('needsAction({kind:"forward",delivered_at:"2026-11-16",delivery_target:"fixture-laptop"})'), false);
    assert.equal(h.run('needsAction({kind:"forward",delivered_at:"2026-11-16",forwarded_at:"2026-11-16"})'), false);
    assert.equal(h.run('needsAction({kind:"forward",delivered_at:"2026-11-16",acked_at:"2026-11-16"})'), false);
    assert.equal(h.run('needsAction({kind:"forward",delivered_at:"2026-11-16",done_at:"2026-11-16"})'), false);
    assert.equal(h.run('needsAction({kind:"forward",delivered_at:"2026-11-16"})'), true);
    assert.doesNotMatch(h.run('todoStatus({kind:"forward",delivered_at:"2026-11-16",delivery_target:"fixture-laptop"})'), /нужен|запуск/i);
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
  test("hex from_device name is resolved to peer label and self-echo is hidden", () => {
    const state = fixture();
    state.todos[0].from_device = { id: "fixture-laptop", name: "fixture-laptop" };
    const h = harness(state);
    assert.equal(h.run('fromDeviceLabel(data.todos[0])'), "Ноутбук (тест)");
    assert.match(h.run('peerNote(data.todos[0])'), /Ноутбук \(тест\)/);
    assert.doesNotMatch(h.run('peerNote(data.todos[0])'), /fixture-laptop/);
    state.todos[0].from_device = { id: "fixture-pc", name: "fixture-pc" };
    assert.equal(h.run('fromDeviceLabel(data.todos[0])'), "");
    assert.equal(h.run('peerNote(data.todos[0])'), "");
  });
  test("non-forward cards without task title show clear action text and superseded stays quiet", () => {
    const state = fixture();
    state.todos = [
      { id: 10, display_id: "AD-10", message_id: "m10", project: "Demo", agent: "Opus (2)", kind: "reply", task: "", message: "Вопрос", created: new Date().toISOString() },
      { id: 11, display_id: "AD-11", message_id: "m11", project: "Demo", agent: "Astra", kind: "limit", task: "", message: "Лимит", created: new Date().toISOString() },
      { id: 12, display_id: "AD-12", message_id: "m12", project: "Demo", agent: "Ret", to: "Codex", kind: "forward", task: "", message: "Отчёт", created: new Date().toISOString() },
    ];
    const h = harness(state); h.run('renderTodos()');
    const html = h.root.querySelector("#todo-table tbody").innerHTML;
    assert.match(html, /ждёт вашего ответа/);
    assert.match(html, /закончился лимит модели/);
    assert.match(html, /Переслать Codex от Ret/);
    assert.equal(h.run('needsAction({ kind: "forward", delivered_at: "2026-11-16", superseded_by: "newer" })'), false);
  });
  test("details shows AT card number, prompt in taskDetails, disables superseded copy and offers actions", () => {
    const state = fixture(); state.tasks[0].card_id = "AT-42"; state.tasks[0].prompt = "<script>alert(1)</script>Промпт";
    Object.assign(state.todos[0], { purpose: "assignment", assignment_epoch: 2, acked_at: null, superseded_by: "newer-id" });
    const h = harness(state);
    h.run('selected={type:"todo",id:7}; ACTIONS.details()');
    const sup = h.mounted.at(-1).html;
    assert.match(sup, /AT-42/);
    assert.match(sup, /<button data-action="copy-message"[^>]*disabled/);
    assert.match(sup, /заменено/);
    delete state.todos[0].superseded_by; state.todos[0].done_at = new Date().toISOString();
    h.run('ACTIONS.details()');
    assert.match(h.mounted.at(-1).html, /data-action="reopen-todo"/);
    state.todos[0].done_at = null;
    h.run('ACTIONS.details()');
    const open = h.mounted.at(-1).html;
    assert.match(open, /data-action="mark-forwarded"/);
    assert.match(open, /data-action="done-selected"/);
    h.run('taskDetails(taskList()[0])');
    const td = h.mounted.at(-1);
    assert.match(td.html, /Промпт задания/);
    assert.equal(td.node.querySelector("#task-prompt-body").textContent, state.tasks[0].prompt);
  });
  test("clearing prompt on handoff sends empty prompt and abFocus clears hidden filters", async () => {
    const state = fixture(); state.tasks[0].prompt = "Old prompt";
    const calls = []; const h = harness(state);
    h.ctx.__api = async (url, body) => { calls.push({ url, body }); return url.includes("context?") ? { text: "OK", checks: {}, task: state.tasks[0] } : state.tasks[0]; };
    h.run('api = __api; taskMutationDialog("handoff", data.tasks[0])');
    const n = h.mounted.at(-1).node;
    n.querySelector("#task-prompt").value = "";
    await submit(h);
    assert.equal(calls[0].body.prompt, "");
    h.run('todoFilter = "waiting"; todoSearch = "old"; window.abFocus("Demo", 7)');
    assert.equal(h.run('todoSearch'), "");
    assert.equal(h.run('todoFilter'), "all");
  });
  test("task filter and search narrow the rendered cards", () => {
    const state = fixture();
    const second = { ...state.tasks[0], task_id: "55555555-5555-4555-8555-555555555555", title: "Другая задача", state: "accepted", card_id: "AT-99" };
    state.tasks.push(second);
    const h = harness(state);
    h.run('taskFilter = "accepted"; renderTasks()');
    assert.match(h.root.querySelector("#task-list").innerHTML, /AT-99/);
    assert.doesNotMatch(h.root.querySelector("#task-list").innerHTML, /AD-7/);
    h.run('taskFilter = "all"; taskSearch = "другая"; renderTasks()');
    assert.match(h.root.querySelector("#task-list").innerHTML, /Другая задача/);
    assert.doesNotMatch(h.root.querySelector("#task-list").innerHTML, /Проверить передачу/);
    h.run('taskSearch = "нет-такого"; renderTasks()');
    assert.match(h.root.querySelector("#task-list").innerHTML, /Ничего не найдено/);
  });
  test("queue searches assignment number, recipient and full prompt across projects", () => {
    const state = fixture(); state.tasks[0].card_id = "AT-42";
    Object.assign(state.todos[0], { purpose: "assignment", assignment_epoch: 2, to: "Ret", message: "Проверить редкий сценарий восстановления", acked_at: null });
    const h = harness(state);
    for (const query of ["AT-42", "ret восстанов", "AD-7", "редкий"]) {
      h.ctx.__query = query;
      h.run('project = "Other"; todoSearch = __query; renderTodos()');
      const html = h.root.querySelector("#todo-table tbody").innerHTML;
      assert.match(html, /AT-42/);
      assert.match(html, /Ret/);
      assert.doesNotMatch(html, /<button/);
    }
    h.run('todoSearch = "неизвестное"; renderTodos()');
    assert.match(h.root.querySelector("#todo-empty").textContent, /Ничего не найдено/);
  });
  test("queue separates owner actions from waiting receipts, with safe resend", async () => {
    const state = fixture(); Object.assign(state.todos[0], { acked_at: null, forwarded_at: "forwarded" });
    const h = harness(state);
    h.run('renderTodos()');
    assert.doesNotMatch(h.root.querySelector("#todo-table tbody").innerHTML, /data-todo="7"/);
    h.run('todoFilter = "waiting"; renderTodos()');
    assert.match(h.root.querySelector("#todo-table tbody").innerHTML, /переслано · ожидает получения/);
    const before = JSON.stringify(state.todos[0]);
    h.run('globalThis.copied = ""; copyText = async text => { copied = text; return true; }; api = async () => { throw new Error("Copy must not send a receipt"); }; selected = { type: "todo", id: 7 };');
    await h.run('ACTIONS["copy-message"]()');
    assert.equal(h.run('copied'), state.todos[0].message);
    assert.equal(JSON.stringify(state.todos[0]), before);
  });
  test("queue rows replace actions with elapsed creation time and expose a menu", () => {
    const state = fixture(); state.todos[0].created = new Date(Date.now() - 125 * 60000).toISOString();
    state.todos[0].updated = new Date().toISOString();
    const h = harness(state); h.run('todoFilter = "all"; renderTodos()');
    const html = h.root.querySelector("#todo-table tbody").innerHTML;
    assert.doesNotMatch(html, /<button|row-actions/);
    assert.match(html, /aria-haspopup="menu"/);
    assert.match(html, /<time[^>]*datetime="[^"]+"[^>]*>2 ч 5 мин<\/time>/);
    assert.match(fs.readFileSync(path.join(__dirname, "index.html"), "utf8"), /<th[^>]*>Когда<\/th>/);
  });
  test("todo menu mirrors receipt and offline gates with labelled icons", () => {
    const state = fixture(); Object.assign(state.todos[0], { acked_at: null, forwarded_at: null });
    const h = harness(state); const menu = h.root.querySelector("#todo-context-menu");
    h.run('renderTodoMenu(data.todos[0])');
    const copy = menu.querySelector('[data-action="copy-message"]');
    const forwarded = menu.querySelector('[data-action="mark-forwarded"]');
    const done = menu.querySelector('[data-action="done-selected"]');
    assert.equal(copy.disabled, false); assert.equal(forwarded.disabled, false); assert.equal(done.disabled, false);
    assert.equal(copy.dataset.todoId, "7");
    h.run('online = false; renderTodoMenu(data.todos[0])');
    assert.equal(copy.disabled, false); assert.equal(forwarded.disabled, true); assert.equal(done.disabled, true);
    h.run('online = true; data.todos[0].acked_at = "received"; data.todos[0].done_at = "closed"; renderTodoMenu(data.todos[0])');
    assert.equal(copy.disabled, false); assert.equal(forwarded.disabled, true); assert.equal(done.disabled, true);
    h.run('data.todos[0].superseded_by = "new-message"; renderTodoMenu(data.todos[0])');
    assert.equal(copy.disabled, true);
    const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    assert.match(html, /id="todo-context-menu"[^>]*role="menu"/);
    for (const icon of ["notepad_file-0.png", "envelope_closed-0.png", "check-0.png", "notepad-1.png"]) assert.ok(html.includes(icon));
  });
  test("Ctrl+C copies the selected visible card without stealing text editing or selection", async () => {
    const state = fixture(); state.todos[0].forward_text = "FULL PROMPT AND ACK";
    const h = harness(state); h.root.querySelector("#modal-layer").classList.add("hidden");
    h.run('selected = {type:"todo",id:7}; todoFilter = "all"; globalThis.copied = ""; copyText = async text => { copied = text; return true; };');
    let prevented = 0;
    const target = { closest: () => null };
    const event = { key: "c", code: "KeyC", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, target, preventDefault() { prevented++; } };
    h.ctx.__event = event;
    await h.run('copySelectedTodo(__event)');
    assert.equal(h.run('copied'), "FULL PROMPT AND ACK"); assert.equal(prevented, 1);
    for (const mode of ["editor", "dialog", "text", "hidden", "agent"]) {
      h.run('copied = ""; selected = {type:"todo",id:7}; todoFilter = "all";');
      h.root.querySelector("#modal-layer").classList.add("hidden");
      h.ctx.document.getSelection = () => ({ isCollapsed: true });
      event.target = { closest: () => mode === "editor" ? {} : null };
      if (mode === "dialog") h.root.querySelector("#modal-layer").classList.remove("hidden");
      if (mode === "text") h.ctx.document.getSelection = () => ({ isCollapsed: false });
      if (mode === "hidden") h.run('todoSearch = "does-not-match"');
      if (mode === "agent") h.run('todoSearch = ""; selected = {type:"agent",id:"Demo/Codex"}');
      const before = prevented; await h.run('copySelectedTodo(__event)');
      assert.equal(prevented, before, mode); assert.equal(h.run('copied'), "", mode);
    }
  });
  test("task search finds prompt and linked message number with one-click copy", async () => {
    const state = fixture(); const task = state.tasks[0]; task.card_id = "AT-42";
    task.assignment_message_id = state.todos[0].message_id;
    Object.assign(state.todos[0], { purpose: "assignment", assignment_epoch: task.assignment.epoch, message: "Промпт без обрезки", forward_text: "[Agent Desk] Полный промпт и квитанция", to: task.assignment.agent });
    task.prompt = state.todos[0].message;
    const h = harness(state);
    for (const query of ["без обрезки", "AD-7", "AT-42"]) {
      h.ctx.__query = query;
      h.run('project = "Other"; taskSearch = __query; renderTasks()');
      assert.match(h.root.querySelector("#task-list").innerHTML, /data-task-action="copy"/);
      assert.match(h.root.querySelector("#task-list").innerHTML, /AT-42/);
    }
    h.run('globalThis.copied = ""; copyText = async text => { copied = text; return true; }; api = async () => { throw new Error("No mutation for copying"); };');
    await h.run('copyTaskPrompt(data.tasks[0])');
    assert.equal(h.run('copied'), state.todos[0].forward_text);
  });
  test("old tasks label metadata copying honestly when no assignment prompt exists", () => {
    const h = harness(); h.run("renderTasks()");
    const html = h.root.querySelector("#task-list").innerHTML;
    assert.match(html, /data-task-action="copy"[^>]*>Копировать контекст</);
    assert.doesNotMatch(html, /Копировать задание для/);
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
    assert.equal(h.run('needsAction({ kind: "forward", delivered_at: "2026-11-16" })'), true);
    assert.equal(h.run('needsAction({ kind: "forward", delivery_target: "fixture-laptop" })'), false);
    assert.equal(h.run('needsAction({ kind: "forward", delivery_target: "fixture-laptop", delivered_at: "2026-11-16" })'), false);
    assert.equal(h.run('needsAction({ kind: "forward", delivery_target: "fixture-pc", delivered_at: "2026-11-16" })'), true);
    assert.equal(h.run('needsAction({ kind: "forward", delivery_target: "fixture-pc", delivered_at: "2026-11-16", forwarded_at: "2026-11-16" })'), false);
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
  test("oversized pasted prompt remains in the form with an error and no request", async () => {
    const h = harness(); let calls = 0;
    h.ctx.__api = async () => { calls++; return {}; };
    h.run('api = __api; taskMutationDialog("assign", null)');
    const node = h.mounted.at(-1).node;
    node.querySelector("#task-prompt").value = "x".repeat(20000) + "END";
    await submit(h);
    assert.equal(calls, 0);
    assert.match(node.querySelector("#task-error").textContent, /20 000/);
    assert.ok(node.querySelector("#task-prompt").value.endsWith("END"));
    assert.doesNotMatch(h.mounted.at(-1).html, /id="task-prompt"[^>]*maxlength/);
  });
  test("new manual assignment pre-fills a unique session and keeps binding controls optional", () => {
    const h = harness(); h.run('taskMutationDialog("assign", null)');
    const first = h.mounted.at(-1);
    const session = first.node.querySelector("#assign-session_id").value;
    assert.match(session, /^manual-[a-f0-9]{32}$/);
    assert.match(first.html, /<details><summary>Привязка сессии и роль/);
    h.run('taskMutationDialog("assign", null)');
    assert.notEqual(h.mounted.at(-1).node.querySelector("#assign-session_id").value, session);
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
    const desk = { config: { device_id: "fixture-pc", watch: [] }, state: { tasks: {}, bindings: {}, todos: [], next_id: 1 }, _saveState() { saves++; }, emit() {} };
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
  test("CP1 UI: 207 migrated legacy cards stay out of active filter while remaining searchable, and cancelled/archived show status reason", () => {
    const { buildHistoricalSnapshot216 } = require("../core/test/fixtures/synthetic-program.js");
    const snap = buildHistoricalSnapshot216("fixture-pc");
    const state = fixture();
    state.tasks = Object.values(snap.state.tasks).map((t) => ({ ...t, card_id: snap.state.task_card_ids[t.task_id] }));
    state.todos = snap.state.todos;
    const h = harness(state);
    h.run('project = "*"; taskFilter = "active"; renderTasks()');
    const activeHtml = h.root.querySelector("#task-list").innerHTML;
    assert.equal((activeHtml.match(/<article/g) || []).length, 6);
    assert.doesNotMatch(activeHtml, /Историческое напоминание #1\b/);
    h.run('taskFilter = "legacy"; renderTasks()');
    assert.match(h.root.querySelector("#task-count").textContent, /207 из 216/);
    h.run('taskFilter = "all"; taskSearch = "AT-150"; renderTasks()');
    assert.match(h.root.querySelector("#task-list").innerHTML, /AT-150/);
    state.tasks.at(-1).state = "cancelled";
    state.tasks.at(-1).status_reason = "Тестовая причина отмены";
    h.run('taskSearch = ""; taskFilter = "cancelled"; renderTasks()');
    assert.match(h.root.querySelector("#task-list").innerHTML, /отменена/);
    h.ctx.__lastTask = state.tasks.at(-1);
    h.run('taskDetails(__lastTask)');
    assert.match(h.mounted.at(-1).html, /Тестовая причина отмены/);
  });

  // Minimal semantic HTML tag/attribute inspector so CP3 UI tests verify DOM meaning, not raw JS source strings.
  const unescHtml = (s) => String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  function inspectDom(html) {
    const buttons = [];
    for (const bm of html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/gi)) {
      const attrs = {};
      for (const am of (bm[1] || "").matchAll(/([a-z0-9_:-]+)(?:="([^"]*)")?/gi)) attrs[am[1].toLowerCase()] = unescHtml(am[2] ?? "");
      buttons.push({ name: "button", attrs, inner: bm[2], text: unescHtml(bm[2].replace(/<[^>]*>/g, "")).trim() });
    }
    const dlPairs = {};
    for (const dm of html.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/gi)) {
      dlPairs[unescHtml(dm[1].replace(/<[^>]*>/g, "")).trim()] = unescHtml(dm[2].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    }
    return {
      dlPairs,
      buttons,
      byAction: (act) => buttons.find((t) => t.attrs["data-action"] === act || t.attrs["data-task-action"] === act) || null,
    };
  }

  test("CP3 UI: main view exposes contextual actions strictly when backing data exists", async () => {
    const state = fixture();
    state.tasks[0].state = "accepted";
    state.todos[0].acked_at = new Date().toISOString();
    const h = harness(state);
    h.run("render()");
    assert.equal(h.root.querySelector("#owner-actions").classList.contains("hidden"), true);
    assert.equal(h.root.querySelector("#owner-actions").innerHTML, "");

    // 1. Assignment forward appears -> only quick-forward-assignment
    const now = new Date().toISOString();
    state.todos.push({
      id: 21, display_id: "AD-21", message_id: "aaaaaaaa-1111-4111-8111-111111111111",
      task_id: taskId, project: "Demo", agent: "Владелец", to: "Carbon", kind: "forward",
      purpose: "assignment", assignment_epoch: 3, message: "Промпт задания",
      forward_text: "[Agent Desk] Задание для Carbon · message_id: aaaaaaaa-1111-4111-8111-111111111111",
      created: now,
    });
    h.run("render()");
    let dom = inspectDom(h.root.querySelector("#owner-actions").innerHTML);
    assert.equal(h.root.querySelector("#owner-actions").classList.contains("hidden"), false);
    assert.ok(dom.byAction("quick-forward-assignment"));
    assert.equal(dom.byAction("quick-forward-report"), null);
    assert.equal(dom.byAction("quick-reply"), null);
    assert.equal(dom.byAction("quick-review"), null);
    assert.equal(dom.byAction("quick-resource"), null);

    h.run('globalThis.__copied = ""; copyText = async (t) => { __copied = t; return true; };');
    await h.run('ACTIONS["quick-forward-assignment"]()');
    assert.equal(h.run("__copied"), state.todos[1].forward_text);

    // 2. Report forward + reply + submitted task + resource-waiting agent -> all 5 contextual actions
    state.todos.push(
      { id: 22, display_id: "AD-22", message_id: "bbbbbbbb-2222-4222-8222-222222222222", project: "Demo", agent: "Carbon", to: "Codex", kind: "forward", message: "Отчёт готов", forward_text: "[Agent Desk] Отчёт для Codex", created: now },
      { id: 23, display_id: "AD-23", message_id: "cccccccc-3333-4333-8333-333333333333", project: "Demo", agent: "Astra", kind: "reply", message: "Нужно решение", created: now },
    );
    state.tasks[0].state = "submitted";
    state.agents["Demo/Codex"] = { project: "Demo", agent: "Codex", state: "waiting", waiting_for: "resource", task: "Жду телефон", first_seen: now, updated: now, device_id: "fixture-pc" };
    h.run('tab = "tasks"; render()');
    dom = inspectDom(h.root.querySelector("#owner-actions").innerHTML);
    for (const act of ["quick-forward-assignment", "quick-forward-report", "quick-reply", "quick-review", "quick-resource"]) {
      assert.ok(dom.byAction(act), `expected contextual action ${act}`);
    }
    const cardDom = inspectDom(h.root.querySelector("#task-list").innerHTML);
    assert.ok(cardDom.byAction("review"));
    assert.ok(cardDom.byAction("release-resource"));
    assert.doesNotMatch(h.root.querySelector("#todo-table tbody").innerHTML, /<button/);

    await h.run('ACTIONS["quick-forward-report"]()');
    assert.equal(h.run("__copied"), "[Agent Desk] Отчёт для Codex");
    h.run('ACTIONS["quick-review"]()');
    assert.equal(h.mounted.at(-1).node.querySelector("#task-state").value, "accepted");
    h.run('ACTIONS["quick-resource"]()');
    assert.match(h.mounted.at(-1).node.querySelector("#resource-resume-text").value, /Ресурс свободен/);
  });

  test("CP3 UI: task cards expose executor, device, last signal, stale reason, reviewer, report/SHA, artifact availability and history", () => {
    const state = fixture();
    const staleIso = new Date(Date.now() - 45 * 60000).toISOString();
    state.agents["Demo/Codex"] = { project: "Demo", agent: "Codex", state: "working", task: "Проверить", first_seen: staleIso, updated: staleIso, device_id: "fixture-pc", session_id: "demo-session-a" };
    state.tasks[0].artifacts = [
      { path: "reports/review.md", sha256: "a".repeat(64), status: "verified", local_availability: "available_verified" },
    ];
    const h = harness(state);
    h.run("renderTasks()");
    const html = h.root.querySelector("#task-list").innerHTML;
    const dom = inspectDom(html);
    assert.match(dom.dlPairs["Исполнитель"], /Codex · исполнитель/);
    assert.match(dom.dlPairs["Компьютер"], /этот компьютер/);
    assert.match(dom.dlPairs["Последний сигнал"], /нет новых маркеров > 20 мин — активность не подтверждена/);
    assert.match(dom.dlPairs["Проверяет"], /Reviewer · ведущий/);
    assert.match(dom.dlPairs["Отчёт \/ SHA"], /reports\/review\.md/);
    assert.match(dom.dlPairs["Отчёт \/ SHA"], /SHA abcdef123456/);
    assert.match(dom.dlPairs["Отчёт \/ SHA"], /доступен на этом ПК, SHA совпал ✓/);
    assert.equal(dom.dlPairs["Следующий шаг"], "Продолжить проверку UI");
    assert.match(html, /<summary>История действий \(2\)<\/summary>/);

    // Check remaining availability statuses in taskDetails
    state.tasks[0].artifacts = [
      { path: "out/a.txt", sha256: "b".repeat(64), local_availability: "hash_mismatch" },
      { path: "out/b.txt", sha256: "c".repeat(64), local_availability: "other_device" },
      { path: "out/c.txt", sha256: "d".repeat(64), local_availability: "unapproved_root" },
    ];
    h.run("taskDetails(data.tasks[0])");
    const detailHtml = h.mounted.at(-1).html;
    assert.match(detailHtml, /SHA не совпадает на этом ПК/);
    assert.match(detailHtml, /на другом компьютере/);
    assert.match(detailHtml, /путь вне разрешённых папок контекста/);
  });

  test("CP3 UI: prompt counter, UTF-8 envelope overflow, draft protection, manual clipboard fallback and exact whitespace/CRLF/emoji/Cyrillic preservation", async () => {
    const { TaskService } = require("../core/tasks.js");
    const { forwardText: buildForwardText } = require("../core/desk.js");
    const desk = { config: { device_id: "fixture-pc", watch: [] }, state: { tasks: {}, bindings: {}, todos: [], next_id: 1 }, _saveState() {}, emit() {} };
    const service = new TaskService(desk);
    const state = fixture(); state.tasks = []; state.todos = [];
    const h = harness(state);
    h.ctx.__api = async (url, body) => service[url.split("/").pop()](body);
    h.run('api = __api; taskMutationDialog("assign", null)');
    let n = h.mounted.at(-1).node;
    const complexPrompt = "    if (ok) {\r\n      // Длинная кириллическая строка без потери пробелов 🚀\r\n    }\r\n";
    for (const [id, v] of Object.entries({ "#task-project": "Demo", "#task-title": "Whitespace test", "#assign-agent": "Carbon", "#assign-device_id": "fixture-pc", "#assign-session_id": "s-utf8-1", "#assign-role": "executor" })) {
      n.querySelector(id).value = v;
    }
    n.querySelector("#task-prompt").value = complexPrompt;
    n.querySelector("#task-prompt").oninput();
    assert.match(n.querySelector("#task-prompt-stats").textContent, /UTF-8:/);

    // Close without saving -> reopen -> draft must be restored
    h.run('taskMutationDialog("assign", null)');
    n = h.mounted.at(-1).node;
    assert.equal(n.querySelector("#task-prompt").value, complexPrompt);
    assert.equal(n.querySelector("#task-draft-row").classList.contains("hidden"), false);

    // UTF-8 envelope overflow (< 20,000 chars, > 58,000 UTF-8 bytes via 3-byte chars)
    const heavy3Byte = "\u25fc".repeat(19500);
    n.querySelector("#task-prompt").value = heavy3Byte;
    n.querySelector("#task-prompt").oninput();
    for (const [id, v] of Object.entries({ "#task-project": "Demo", "#task-title": "Overflow test", "#assign-agent": "Carbon", "#assign-device_id": "fixture-pc", "#assign-session_id": "s-utf8-2", "#assign-role": "executor" })) {
      n.querySelector(id).value = v;
    }
    await submit(h);
    assert.equal(Object.keys(desk.state.tasks).length, 0);
    assert.match(n.querySelector("#task-error").textContent, /58 000 Б/);
    assert.equal(n.querySelector("#task-prompt").value, heavy3Byte);

    // Reset draft and submit exact complexPrompt -> verify byte-for-byte preservation + manual fallback
    n.querySelector("#task-draft-reset").onclick();
    n.querySelector("#task-prompt").value = complexPrompt;
    n.querySelector("#task-prompt").oninput();
    await submit(h);
    const savedTask = Object.values(desk.state.tasks)[0];
    assert.equal(savedTask.prompt, complexPrompt);
    const savedTodo = desk.state.todos[0];
    savedTodo.forward_text = buildForwardText(savedTodo);
    assert.ok(savedTodo.forward_text.includes(complexPrompt));

    // Manual clipboard fallback when clipboard API is blocked
    h.ctx.__todo = savedTodo;
    h.run('copyText = async () => false;');
    const ok = await h.run('copyPromptText(__todo.forward_text, null, "Carbon")');
    assert.equal(ok, false);
    assert.equal(h.mounted.at(-1).node.querySelector("#manual-copy").value, savedTodo.forward_text);
  });

  test("CP3 UI: universal search (UUIDs, aliases, device, state) and selection preservation across sync/handoff", () => {
    const state = fixture();
    state.config.aliases = { Demo: { "карбон": "Carbon" }, "*": {} };
    const now = new Date().toISOString();
    const msg1 = "aaaaaaaa-0000-4000-8000-000000000001";
    const msg2 = "bbbbbbbb-0000-4000-8000-000000000002";
    state.tasks[0].assignment = { agent: "Carbon", device_id: "fixture-laptop", session_id: "s-1", epoch: 2, role: "executor", adapter: "manual" };
    state.tasks[0].assignment_message_id = msg1;
    state.todos = [{
      id: 30, display_id: "AD-30", message_id: msg1, task_id: taskId, project_id: projectId,
      project: "Demo", agent: "Владелец", to: "Carbon", kind: "forward", purpose: "assignment",
      assignment_epoch: 2, recipient_device_id: "fixture-laptop", task: "Синхронизация",
      message: "Проверить индексы журнала", created: now,
    }];
    const h = harness(state);
    for (const q of [taskId, msg1, projectId, "карбон", "fixture-laptop", "Ноутбук (тест)", "сдана на проверку", "индексы журнала"]) {
      h.ctx.__q = q;
      h.run('project = "Other"; todoSearch = __q; renderTodos(); taskSearch = __q; renderTasks();');
      assert.match(h.root.querySelector("#todo-table tbody").innerHTML, /data-todo="30"/, `todo search failed for ${q}`);
      if (q !== msg1) assert.match(h.root.querySelector("#task-list").innerHTML, new RegExp(taskId), `task search failed for ${q}`);
    }

    // Select AD-30 in active filter, then simulate synced handoff superseding msg1 -> msg2
    h.run('project = "*"; todoSearch = ""; todoFilter = "action"; selected = selectTodoRef(data.todos[0]); render()');
    assert.equal(h.run("selected.id"), 30);
    state.todos[0].superseded_by = msg2;
    state.todos[0].done_at = now;
    state.todos.push({
      id: 31, display_id: "AD-31", message_id: msg2, supersedes: msg1, task_id: taskId, project_id: projectId,
      project: "Demo", agent: "Владелец", to: "Carbon", kind: "forward", purpose: "assignment",
      assignment_epoch: 3, recipient_device_id: "fixture-pc", task: "Синхронизация",
      message: "Новый актуальный промпт", created: now,
    });
    h.run("render()");
    assert.equal(h.run("selected.id"), 31);
    assert.equal(h.run("selected.message_id"), msg2);
  });

  test("CP3 UI: quiet hours, project mute, disconnected phone status and structured diagnostics/rejection dialog", async () => {
    const { buildHistoricalSnapshot216 } = require("../core/test/fixtures/synthetic-program.js");
    const { diagnoseMarker } = require("../core/marker-schema.js");
    const state = fixture();
    const seenIso = new Date(Date.now() - 180000).toISOString();
    state.phone_status = { connected: false, waiting_pollers: 0, last_seen_at: seenIso };
    state.config.quiet_hours = { enabled: true, start: "23:00", end: "07:30" };
    state.config.notify_projects = { Demo: true };
    state.pipeline = { pending: 2, queued: 4, rejected: 9, applied: 120, acked: 18 };
    const samples = buildHistoricalSnapshot216("fixture-pc").invalidMarkerSamples;
    state.rejected = samples.map((m, idx) => {
      const d = diagnoseMarker(m.raw, "Demo");
      const first = d.errors[0] || { code: "DEVICE_MISMATCH", field: "device_id", expected: ["fixture-pc"], hint: "Используйте актуальное устройство", retryable: true };
      return { file: m.name, project: "Demo", seq: d.seq ?? (idx + 1), code: first.code, field: first.field, expected: first.expected, hint: first.hint, retryable: first.retryable, time: seenIso };
    });

    const calls = [];
    const h = harness(state);
    h.ctx.__api = async (url, body) => {
      calls.push({ url, body });
      if (url === "/api/diagnostics") return { redacted: true, pipeline: state.pipeline, rejected_by_field: { waiting_for: 6, state: 2, device_id: 1 } };
      return { ok: true };
    };
    h.run('api = __api; copyText = async (t) => { globalThis.__diagCopied = t; return true; }; render()');
    assert.match(h.root.querySelector("#sb-counts").textContent, /тихие часы/);
    assert.match(h.root.querySelector("#sb-counts").textContent, /телефон отключён/);
    assert.match(h.root.querySelector("#sb-counts").textContent, /отказов: 9/);

    h.run('ACTIONS["notify-settings"]()');
    const qhDialog = h.mounted.at(-1);
    assert.match(qhDialog.html, /телефон отключён/);
    qhDialog.node.querySelector("#notify-proj-0").checked = false;
    await qhDialog.node.querySelector("#notify-settings-form").onsubmit({ preventDefault() {} });
    assert.equal(calls[0].url, "/api/config");
    assert.equal(calls[0].body.quiet_hours.enabled, true);
    assert.equal(calls[0].body.notify_projects.Demo, false);

    h.run("ACTIONS.diagnostics()");
    const diag = h.mounted.at(-1);
    for (const chip of ["Не обработано: <b>2</b>", "В очереди: <b>4</b>", "Отклонено: <b>9</b>", "Применено: <b>120</b>", "ACK: <b>18</b>"]) {
      assert.ok(diag.html.includes(chip), `missing chip ${chip}`);
    }
    assert.match(diag.html, /waiting_for/);
    assert.match(diag.html, /временно/);
    assert.match(diag.html, /постоянно/);
    assert.match(diag.html, /agentdesk validate/);
    await diag.node.querySelector("#diag-export").onclick();
    const exported = JSON.parse(h.run("__diagCopied"));
    assert.equal(exported.redacted, true);
    assert.equal(exported.rejected_by_field.waiting_for, 6);
  });

  test("CP4 UI: agent registry, read-only resources, JSON handoff/handback export, mock-dry-run launch button and limit session rotation", async () => {
    const state = fixture();
    state.resources = {
      phone: { resource: "phone", read_only: true, status: "UNKNOWN", holder: null, source: "unconfigured", freshness_sec: null },
      server: { resource: "server", read_only: true, status: "BUSY", holder: "Opus (2)", source: "lease_file", freshness_sec: 12 },
    };
    state.adapters = [
      { adapter: "manual", mode: "manual", available: true, reason: "Ручной режим" },
      { adapter: "mock-dry-run", mode: "dry_run_mock", available: true, reason: "Локальный mock" },
      { adapter: "external-account", mode: "external", available: false, reason: "Отключено по умолчанию" },
    ];
    state.config.agent_registry = {
      Demo: [{ name: "Claude Opus", aliases: ["опус"], capabilities: [], verified_channel: "cli_or_mcp", device_id: "fixture-pc", status: "active", session_id: "s-1" }],
    };
    state.tasks[0].state = "assigned";
    state.tasks[0].assignment.adapter = "mock-dry-run";
    state.todos.push({ id: 50, display_id: "AD-50", message_id: "50505050-5050-4050-8050-505050505050", project: "Demo", agent: "Claude Opus", kind: "limit", message: "Лимит", created: new Date().toISOString() });

    const calls = [];
    const h = harness(state);
    h.ctx.__api = async (url, body) => {
      calls.push({ url, body });
      if (url.startsWith("/api/tasks/handoff-json")) return { schema: "agent-desk.handoff.v1", handback_template: { state: "done", execution_state: "submitted" } };
      if (url === "/api/tasks/launch") return { receipt: { adapter: "mock-dry-run", status: "dispatched_dry_run", reason: "Отправлено в mock" } };
      return { ok: true };
    };
    h.run('api = __api; copyText = async (t) => { globalThis.__cp4Copied = t; return true; }; renderTasks()');
    const cardDom = inspectDom(h.root.querySelector("#task-list").innerHTML);
    assert.ok(cardDom.byAction("launch"), "mock-dry-run assigned task exposes explicit launch button");

    h.run('ACTIONS["agent-registry"]()');
    const regHtml = h.mounted.at(-1).html;
    assert.match(regHtml, /UNKNOWN/);
    assert.match(regHtml, /BUSY/);
    assert.match(regHtml, /Opus \(2\)/);
    assert.match(regHtml, /возможности не заявлены \(не угадываются\)/);
    assert.match(regHtml, /cli_or_mcp/);

    h.run('contextDialog(data.tasks[0], { text: "CTX", checks: {} })');
    const ctxNode = h.mounted.at(-1).node;
    await ctxNode.querySelector("#copy-handoff-json").onclick();
    assert.equal(JSON.parse(h.run("__cp4Copied")).schema, "agent-desk.handoff.v1");
    await ctxNode.querySelector("#copy-handback-tpl").onclick();
    assert.equal(JSON.parse(h.run("__cp4Copied")).execution_state, "submitted");

    h.run('selected = { type: "todo", id: 50 }; ACTIONS.details()');
    assert.match(h.mounted.at(-1).html, /data-action="rotate-limit-session"/);
    await h.run('ACTIONS["rotate-limit-session"]()');
    assert.ok(calls.some((c) => c.url === "/api/agents/rotate-session" && c.body.agent === "Claude Opus"));
  });
}
