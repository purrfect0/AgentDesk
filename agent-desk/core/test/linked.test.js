"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), http = require("node:http"), crypto = require("node:crypto");
const { Desk, parseMarker } = require("../desk.js");
const { seal } = require("../sync.js");
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), "agentdesk-linked-test-")); }
async function fixture(fileSyncEnabled = false) {
  const root = temp(), mail = path.join(root, "mail"); fs.mkdirSync(mail);
  const d = new Desk({ dataDir: path.join(root,"data"), legacyDir:null, port:0, lan:false, discovery:false, log() {} });
  d.config.watch = []; d.config.mail_roots = [{project:"P",path:mail}]; d.config.file_sync_enabled = fileSyncEnabled;
  await d.start(); d.peers.stop(); return { d,root,mail };
}
function pair(a,b) {
  a.config.peers = [{id:b.config.device_id,name:"Synthetic B",base:`http://127.0.0.1:${b.boundPort}`,key:"1".repeat(32),my_key:"2".repeat(32)}];
  b.config.peers = [{id:a.config.device_id,name:"Synthetic A",base:`http://127.0.0.1:${a.boundPort}`,key:"2".repeat(32),my_key:"1".repeat(32)}];
  a._saveConfig(); b._saveConfig();
}
function apply(d, value, project="P") { const e = parseMarker(JSON.stringify(value),project); d.applyEvent(e); d._saveState(); return e; }
function request(d, route, body, headers={}) {
  return new Promise((resolve,reject)=>{
    const raw=body===undefined?null:JSON.stringify(body), req=http.request({host:"127.0.0.1",port:d.boundPort,path:route,method:raw?"POST":"GET",headers:{host:`127.0.0.1:${d.boundPort}`,"content-type":"application/json","x-agent-desk":"1",...headers}},res=>{
      const chunks=[];res.on("data",c=>chunks.push(c));res.on("end",()=>{const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,data:JSON.parse(text)});});
    });req.on("error",reject);req.end(raw);
  });
}
async function clean(...fixtures) { for(const f of fixtures) { await f.d.stop(); fs.rmSync(f.root,{recursive:true,force:true}); } }
test("paired boards share one UUID and receipt; delivery does not complete task", async()=>{
  const a=await fixture(),b=await fixture();try {
    pair(a.d,b.d);
    apply(a.d,{agent:"Lead",state:"done",to:"Worker",task:"One",message:"Synthetic request"});
    const original=a.d.state.todos[0]; assert.match(original.message_id,/^[0-9a-f-]{36}$/);
    await a.d.peers.sync(b.d.config.device_id);
    const got=b.d.state.todos.find(t=>t.message_id===original.message_id);assert.ok(got);assert.equal(original.done_at,null);
    assert.ok(a.d.state.todos[0].delivered_at);
    const ack=await request(b.d,"/api/agent/ack",{project:"P",agent:"Worker",message_id:got.message_id},{"x-agent-desk-agent-key":b.d.config.agent_key});
    assert.equal(ack.status,200,JSON.stringify(ack));await b.d.peers.sync(a.d.config.device_id);
    assert.ok(a.d.state.todos.find(t=>t.message_id===got.message_id).acked_at);
    assert.notEqual(a.d.state.tasks[got.task_id]?.state,"accepted");
    await a.d.peers.sync(b.d.config.device_id);assert.equal(b.d.state.todos.filter(t=>t.message_id===got.message_id).length,1);
  } finally {await clean(a,b);}
});
test("cross-project/wrong-agent ACK is rejected and stale seq does not acknowledge",async()=>{
  const a=await fixture();try{
    apply(a.d,{agent:"Worker",state:"working",task:"Old",session_id:"s",seq:2});
    apply(a.d,{agent:"Lead",state:"done",to:"Worker",task:"New",message:"Synthetic"});const t=a.d.state.todos[0];
    const bad=await request(a.d,"/api/agent/ack",{project:"Other",agent:"Stranger",message_id:t.message_id},{"x-agent-desk-agent-key":a.d.config.agent_key});
    assert.equal(bad.status,403);assert.equal(t.acked_at,null);
    apply(a.d,{agent:"Worker",state:"working",task:"Old",session_id:"s",seq:1,ack:t.message_id});
    assert.equal(t.acked_at,null);assert.equal(a.d.state.events.at(-1).stale,true);
  }finally{await clean(a);}
});
test("failed receiver fsync returns failure, no success receipt, then retries safely",async()=>{
  const a=await fixture(),b=await fixture();try{
    pair(a.d,b.d);apply(a.d,{agent:"Lead",state:"done",to:"Worker",task:"One",message:"Synthetic"});
    const write=b.d._writeState;b.d._writeState=()=>{throw new Error("synthetic disk full");};
    await assert.rejects(()=>a.d.peers.sync(b.d.config.device_id));assert.equal(b.d.state.todos.length,0);
    assert.equal(a.d.state.todos[0].done_at,null);b.d._writeState=write;
    await a.d.peers.sync(b.d.config.device_id);assert.equal(b.d.state.todos.length,1);
  }finally{await clean(a,b);}
});
test("unknown/tampered encrypted peer is rejected and keys are absent from payload",async()=>{
  const a=await fixture(),b=await fixture();try{
    pair(a.d,b.d);
    const r=await request(b.d,"/api/p2p/sync",{from:a.d.config.device_id,packet:seal({action:"events",events:[]},"f".repeat(32))});
    assert.equal(r.status,403);assert.equal(b.d.state.todos.length,0);
    assert.ok(!JSON.stringify(a.d.payload()).includes(a.d.config.agent_key));
    assert.ok(!JSON.stringify(a.d.payload()).includes(a.d.config.peers[0].key));
  }finally{await clean(a,b);}
});
test("project mail content is copied between independent roots and survives repeat sync",async()=>{
  const a=await fixture(true),b=await fixture(true);try{
    pair(a.d,b.d);const bytes=crypto.randomBytes(150000);fs.writeFileSync(path.join(a.mail,"synthetic-report.bin"),bytes);
    await b.d.peers.sync(a.d.config.device_id);
    assert.deepEqual(fs.readFileSync(path.join(b.mail,"synthetic-report.bin")),bytes);
    await b.d.peers.sync(a.d.config.device_id);assert.equal(fs.readdirSync(b.mail).filter(n=>n==="synthetic-report.bin").length,1);
  }finally{await clean(a,b);}
});
test("assigned prompt survives peer sync, restart and recipient ACK without duplicates", async () => {
  const a = await fixture(), b = await fixture();
  try {
    pair(a.d, b.d);
    const task = a.d.tasks.assign({ project: "P", title: "Find me", prompt: "Полный промпт\nПоследняя строка", agent: "Worker", device_id: b.d.config.device_id, session_id: "worker-session" });
    await a.d.peers.sync(b.d.config.device_id);
    const got = b.d.state.todos.find(t => t.message_id === task.assignment_message_id);
    assert.ok(got);
    assert.equal(got.message, "Полный промпт\nПоследняя строка");
    assert.equal(got.assignment_epoch, 1);
    const headers = { "x-agent-desk-agent-key": b.d.config.agent_key };
    const wrong = await request(b.d, "/api/agent/ack", { project: "P", agent: "Worker", message_id: got.message_id, session_id: "retired-session" }, headers);
    assert.equal(wrong.status, 409);
    const ack = await request(b.d, "/api/agent/ack", { project: "P", agent: "Worker", message_id: got.message_id, session_id: "worker-session", assignment_epoch: 1 }, headers);
    assert.equal(ack.status, 200, JSON.stringify(ack));
    await b.d.peers.sync(a.d.config.device_id);
    assert.ok(a.d.state.todos.find(t => t.message_id === got.message_id).acked_at);
    assert.equal(a.d.state.tasks[task.task_id].state, "assigned");
    const restored = new Desk({ dataDir: a.d.dataDir, legacyDir: null, port: 0, lan: false, discovery: false, log() {} });
    assert.equal(restored.state.todos.filter(t => t.message_id === got.message_id).length, 1);
    assert.ok(restored.state.todos.find(t => t.message_id === got.message_id).acked_at);
  } finally { await clean(a, b); }
});

test("report recipient ACK uses recipient session rather than worker session", async () => {
  const a = await fixture();
  try {
    const task = a.d.tasks.assign({ project: "P", title: "Report", agent: "Worker", session_id: "worker-session" });
    apply(a.d, { agent: "Worker", state: "done", task_id: task.task_id, assignment_epoch: 1, session_id: "worker-session", to: "Lead", message: "Review this report" });
    const report = a.d.state.todos.find(t => t.to === "Lead");
    const ack = await request(a.d, "/api/agent/ack", { project: "P", agent: "Lead", session_id: "lead-session", message_id: report.message_id }, { "x-agent-desk-agent-key": a.d.config.agent_key });
    assert.equal(ack.status, 200, JSON.stringify(ack));
    assert.ok(a.d.state.todos.find(t => t.message_id === report.message_id).acked_at);
    assert.equal(a.d.state.tasks[task.task_id].state, "submitted");
  } finally { await clean(a); }
});

test("oversized marker is rejected before changing task, queue or journal", async () => {
  const a = await fixture();
  try {
    const before = JSON.stringify(a.d.state);
    const response = await request(a.d, "/api/agent/submit", { project: "P", agent: "Worker", state: "done", to: "Lead", task: "Long message", message: "x".repeat(20000) + "END" }, { "x-agent-desk-agent-key": a.d.config.agent_key });
    assert.equal(response.status, 400);
    assert.match(response.data.error, /message.*20000/);
    assert.equal(JSON.stringify(a.d.state), before);
    const accepted = parseMarker(JSON.stringify({ project: "P", agent: "Worker", state: "done", message: "x".repeat(19997) + "END" }));
    assert.equal(accepted.message.length, 20000);
    assert.ok(accepted.message.endsWith("END"));
  } finally { await clean(a); }
});

test("reopening a reminder preserves forwarded and received history", async () => {
  const a = await fixture();
  try {
    apply(a.d, { agent: "Lead", state: "done", to: "Worker", task: "Repeat", message: "Same text" });
    const message = a.d.state.todos[0];
    Object.assign(message, { forwarded_at: "forwarded", acked_at: "received", acked_by: "Worker", done_at: "closed" });
    a.d._saveState();
    const result = await request(a.d, `/api/todo/${message.id}/undo`, {});
    assert.equal(result.status, 200);
    const after = a.d.state.todos[0];
    assert.equal(after.message_id, message.message_id);
    assert.equal(after.message, "Same text");
    assert.equal(after.forwarded_at, "forwarded");
    assert.equal(after.acked_at, "received");
    assert.equal(after.acked_by, "Worker");
  } finally { await clean(a); }
});

test("changing delivered text creates a new message and old ACK cannot confirm it", async () => {
  const a = await fixture(), b = await fixture();
  try {
    pair(a.d, b.d);
    apply(a.d, { agent: "Lead", state: "done", to: "Worker", task: "Revision", message: "Version one" });
    const originalId = a.d.state.todos[0].message_id;
    await a.d.peers.sync(b.d.config.device_id);
    apply(a.d, { agent: "Lead", state: "done", to: "Worker", task: "Revision", message: "Version two" });
    const updated = a.d.state.todos.find(t => t.message_id !== originalId);
    assert.ok(updated);
    assert.equal(updated.supersedes, originalId);
    const ack = await request(b.d, "/api/agent/ack", { project: "P", agent: "Worker", message_id: originalId }, { "x-agent-desk-agent-key": b.d.config.agent_key });
    assert.equal(ack.status, 200);
    await b.d.peers.sync(a.d.config.device_id);
    assert.equal(a.d.state.todos.find(t => t.message_id === updated.message_id).acked_at, null);
    assert.equal(a.d.state.todos.find(t => t.message_id === updated.message_id).message, "Version two");
  } finally { await clean(a, b); }
});

test("agent read returns the full forwardable assignment and inbox respects recipient sessions", async () => {
  const a = await fixture();
  try {
    const task = a.d.tasks.assign({ project: "P", title: "Agent workflow", prompt: "Полный текст\nEND", agent: "Worker", session_id: "worker-session" });
    const headers = { "x-agent-desk-agent-key": a.d.config.agent_key };
    const read = await request(a.d, `/api/agent/read?id=${task.assignment_message_id}`, undefined, headers);
    assert.equal(read.status, 200);
    assert.match(read.data.todo.forward_text, /Полный текст\nEND/);
    assert.ok(read.data.todo.forward_text.includes(task.task_id));
    assert.match(read.data.todo.forward_text, /assignment_epoch: 1/);
    const other = await request(a.d, "/api/agent/inbox?project=P&agent=Worker&session_id=old-session", undefined, headers);
    assert.equal(other.data.todos.length, 0);
    assert.equal(other.data.tasks.length, 0);
    const own = await request(a.d, "/api/agent/inbox?project=P&agent=Worker&session_id=worker-session", undefined, headers);
    assert.equal(own.data.todos.length, 1);
    assert.equal(own.data.tasks.length, 1);
  } finally { await clean(a); }
});

test("receipt-only marker from a report recipient does not impersonate the assignee", async () => {
  const a = await fixture();
  try {
    const task = a.d.tasks.assign({ project: "P", title: "Report receipt", agent: "Worker", session_id: "worker-session" });
    apply(a.d, { agent: "Worker", state: "done", task_id: task.task_id, assignment_epoch: 1, session_id: "worker-session", to: "Lead", message: "Result" });
    const message = a.d.state.todos.find(t => t.to === "Lead");
    const response = await request(a.d, "/api/agent/submit", { project: "P", agent: "Lead", state: "idle", session_id: "lead-session", task_id: task.task_id, ack: message.message_id }, { "x-agent-desk-agent-key": a.d.config.agent_key });
    assert.equal(response.status, 200, JSON.stringify(response));
    assert.ok(a.d.state.todos.find(t => t.message_id === message.message_id).acked_at);
    assert.equal(a.d.state.tasks[task.task_id].state, "submitted");
    assert.equal(a.d.state.tasks[task.task_id].assignment.agent, "Worker");
  } finally { await clean(a); }
});

test("multibyte message exceeding sync budget is rejected without poisoning journal", async () => {
  const a = await fixture();
  try {
    const response = await request(a.d, "/api/agent/submit", { project: "P", agent: "Worker", state: "done", to: "Lead", task: "Unicode", message: "文".repeat(20000) }, { "x-agent-desk-agent-key": a.d.config.agent_key });
    assert.equal(response.status, 413);
    assert.equal(a.d.state.todos.length, 0);
    assert.doesNotThrow(() => a.d.sync.page());
  } finally { await clean(a); }
});

test("changed text after read gets a fresh UUID even before manual forwarding", async () => {
  const a = await fixture();
  try {
    const headers = { "x-agent-desk-agent-key": a.d.config.agent_key };
    apply(a.d, { agent: "Lead", state: "done", to: "Worker", task: "Copied text", message: "Original" });
    const original = a.d.state.todos[0].message_id;
    const read = await request(a.d, `/api/agent/read?id=${original}`, undefined, headers);
    assert.match(read.data.todo.forward_text, /Original/);
    apply(a.d, { agent: "Lead", state: "done", to: "Worker", task: "Copied text", message: "Changed" });
    const updated = a.d.state.todos.find(row => !row.done_at);
    assert.notEqual(updated.message_id, original);
    assert.equal(updated.message, "Changed");
    const stale = await request(a.d, "/api/agent/ack", { project: "P", agent: "Worker", message_id: original }, headers);
    assert.equal(stale.status, 409);
    assert.equal(a.d.state.todos.find(row => row.message_id === updated.message_id).acked_at, null);
  } finally { await clean(a); }
});

test("agent read and context accept AT task card numbers and attach card_id", async () => {
  const a = await fixture();
  try {
    const task = a.d.tasks.assign({ project: "P", title: "Lookup by AT", prompt: "Prompt body", agent: "Worker", session_id: "worker-session" });
    a.d._saveState();
    const cardId = a.d.state.task_card_ids[task.task_id];
    assert.match(cardId, /^AT-\d+$/);
    const headers = { "x-agent-desk-agent-key": a.d.config.agent_key };
    const read = await request(a.d, `/api/agent/read?id=${cardId.toLowerCase()}`, undefined, headers);
    assert.equal(read.status, 200, JSON.stringify(read));
    assert.equal(read.data.task.task_id, task.task_id);
    assert.equal(read.data.task.card_id, cardId);
    assert.equal(read.data.todo.message_id, task.assignment_message_id);
    assert.match(read.data.todo.forward_text, /Prompt body/);
    const ctx = await request(a.d, `/api/agent/context?id=${cardId}`, undefined, headers);
    assert.equal(ctx.status, 200, JSON.stringify(ctx));
    assert.equal(ctx.data.task.task_id, task.task_id);
    assert.equal((await request(a.d, "/api/agent/read?id=AT-99999", undefined, headers)).status, 404);
    assert.equal((await request(a.d, "/api/agent/context?id=AT-99999", undefined, headers)).status, 400);
  } finally { await clean(a); }
});

test("agent API requires its own loopback key, validates submit before publication",async()=>{
  const a=await fixture();try{
    assert.equal((await request(a.d,"/api/agent/status")).status,403);
    const headers={"x-agent-desk-agent-key":a.d.config.agent_key};
    assert.equal((await request(a.d,"/api/agent/status",undefined,headers)).status,200);
    assert.equal((await request(a.d,"/api/agent/status",undefined,{...headers,origin:"http://evil.example"})).status,403);
    const r=await request(a.d,"/api/agent/submit",{project:"P",result:"synthetic"},headers);assert.equal(r.status,400);assert.match(r.data.error,/agent/);
    assert.equal(a.d.state.todos.length,0);
  }finally{await clean(a);}
});
