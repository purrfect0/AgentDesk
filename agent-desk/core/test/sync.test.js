"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { SyncJournal, stableId, seal, unseal } = require("../sync.js");
function desk(id = "aaaaaaaaaaaaaaaa") {
  const d = { config: { device_id: id }, state: { agents: {}, todos: [], next_id: 1 }, emit() {}, _saveState() { this.sync.capture(); this.saved = JSON.parse(JSON.stringify(this.state)); } };
  d.sync = new SyncJournal(d); return d;
}
function todo(d, name = "one") {
  const t = { id: d.state.next_id++, message_id: crypto.randomUUID(), display_id: "AD-1", kind: "forward", project: "P", agent: "Lead", to: "Worker", task: name, message: "Synthetic", origin_device_id: d.config.device_id, acked_at: null, done_at: null };
  d.state.todos.push(t); d._saveState(); return t;
}
test("journal retains message UUID and deduplicates repeated closed message across restart", () => {
  const a = desk(), b = desk("bbbbbbbbbbbbbbbb"), t = todo(a);
  const events = a.sync.page().events;
  b.sync.receive(events); assert.equal(b.state.todos[0].message_id, t.message_id);
  b.state.todos[0].acked_at = "synthetic-time"; b.state.todos[0].done_at = "synthetic-time"; b._saveState();
  const before = b.state.todos.length; b.sync.receive(events); assert.equal(b.state.todos.length, before);
  b.sync = new SyncJournal(b); b.sync.receive(events); assert.equal(b.state.todos.length, before);
});
test("remote receipt is not returned when persistence fails and import rolls back", () => {
  const a = desk(), b = desk("bbbbbbbbbbbbbbbb"); todo(a);
  b._saveState = () => { throw new Error("synthetic disk full"); };
  assert.throws(() => b.sync.receive(a.sync.page().events), /disk full/);
  assert.equal(b.state.todos.length, 0); assert.equal(b.sync.journal.events.length, 0);
});
test("import does not create a new echo event", () => {
  const a = desk(), b = desk("bbbbbbbbbbbbbbbb"); todo(a);
  b.sync.receive(a.sync.page().events); const count = b.sync.journal.events.length;
  b._saveState(); assert.equal(b.sync.journal.events.length, count);
});
test("newer receipt converges despite older message arriving late", () => {
  const a = desk(), b = desk("bbbbbbbbbbbbbbbb"), t = todo(a);
  const first = a.sync.page().events;
  t.acked_at = "received"; t.done_at = "received"; a._saveState();
  const last = a.sync.journal.events.at(-1); b.sync.receive([last]); b.sync.receive(first);
  assert.equal(b.state.todos[0].acked_at, "received");
});
test("entity tombstone wins over replay of an older snapshot", () => {
  const a = desk(), b = desk("bbbbbbbbbbbbbbbb"); todo(a);
  const first = a.sync.page().events; a.state.todos = []; a._saveState();
  b.sync.receive(a.sync.journal.events); b.sync.receive(first); assert.equal(b.state.todos.length, 0);
});
test("sync payload is encrypted and authenticated with directional pair secret", () => {
  const secret = "a".repeat(32), packet = seal({ text: "private synthetic text" }, secret);
  assert.ok(!JSON.stringify(packet).includes("private synthetic text"));
  assert.equal(unseal(packet, secret).text, "private synthetic text");
  assert.throws(() => unseal(packet, "b".repeat(32)), /целостности/);
  const broken = { ...packet, data: Buffer.from("corrupt").toString("base64") };
  assert.throws(() => unseal(broken, secret), /целостности/);
});
test("bad entity ID and prototype keys are rejected before any mutation", () => {
  const a = desk(), b = desk("bbbbbbbbbbbbbbbb"); todo(a);
  const ev = structuredClone(a.sync.page().events[0]); ev.entity_id = "../bad";
  assert.throws(() => b.sync.receive([ev]), /событие/); assert.equal(b.state.todos.length, 0);
  const forged = JSON.parse(JSON.stringify(a.sync.page().events[0]).replace('"data":{', '"data":{"__proto__":{},'));
  assert.throws(() => b.sync.receive([forged]), /ключ/); assert.equal({}.polluted, undefined);
});
test("journal has bounded paging and validates cursors", () => {
  const a = desk(); for (let i = 0; i < 23; i++) todo(a, String(i));
  const page = a.sync.page(); assert.equal(page.events.length, 20); assert.equal(page.more, true);
  assert.equal(a.sync.page(page.cursor).events.length, 3);
  assert.throws(() => a.sync.page(-1), /курсор/);
});
test("legacy identity is deterministic but scoped to its source desk", () => {
  assert.equal(stableId("a:AD-1"), stableId("a:AD-1")); assert.notEqual(stableId("a:AD-1"), stableId("b:AD-1"));
});


test("concurrent ACK and board delivery merge even when ACK has the lower Lamport tie-break", () => {
  const a = desk("ffffffffffffffff"), b = desk("aaaaaaaaaaaaaaaa"), t = todo(a);
  b.sync.receive(a.sync.page().events);
  t.delivered_at = "board"; a._saveState();
  b.state.todos[0].acked_at = "agent"; b.state.todos[0].done_at = "agent"; b._saveState();
  a.sync.receive([b.sync.journal.events.at(-1)]);
  b.sync.receive([a.sync.journal.events.at(-1)]);
  assert.equal(a.state.todos[0].acked_at, "agent"); assert.equal(b.state.todos[0].acked_at, "agent");
});

test("same event UUID with modified data is rejected transactionally", () => {
  const a=desk(),b=desk("bbbbbbbbbbbbbbbb");todo(a);const ev=a.sync.page().events[0];b.sync.receive([ev]);
  const forged=structuredClone(ev);forged.data.message="different";
  assert.throws(()=>b.sync.receive([forged]),/другими данными/);assert.equal(b.state.todos[0].message,"Synthetic");
});

test("retired task assignment cannot overwrite a handoff even with a larger clock", () => {
  const a=desk(),b=desk("bbbbbbbbbbbbbbbb"),id=crypto.randomUUID();
  a.state.tasks[id]={task_id:id,project:"P",coordinator_device_id:a.config.device_id,state:"working",assignment:{agent:"Worker",device_id:b.config.device_id,session_id:"old",epoch:1}};a._saveState();
  b.sync.receive(a.sync.page().events);const retired=structuredClone(a.sync.journal.events.at(-1));
  a.state.tasks[id].assignment={agent:"Worker",device_id:b.config.device_id,session_id:"new",epoch:2};a._saveState();b.sync.receive([a.sync.journal.events.at(-1)]);
  retired.id=crypto.randomUUID();retired.clock=1000;b.sync.receive([retired]);
  assert.equal(b.state.tasks[id].assignment.session_id,"new");assert.equal(b.state.tasks[id].assignment.epoch,2);
});
