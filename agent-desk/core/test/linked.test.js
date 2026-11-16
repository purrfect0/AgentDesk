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
