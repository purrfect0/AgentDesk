"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {PeerLink}=require("../peers.js");
const {SyncJournal}=require("../sync.js");
const {Desk,parseMarker}=require("../desk.js");
function fake(id="aaaaaaaaaaaaaaaa") { const d={config:{device_id:id,peer_auto:true,peers:[{id:"bbbbbbbbbbbbbbbb"},{id:"cccccccccccccccc"}]},state:{todos:[],agents:{},tasks:{},bindings:{},next_id:1},knownAgents(){return[];},emit(){},_saveState(){this.sync?.capture();}};d.sync=new SyncJournal(d);d.peers=new PeerLink(d);return d; }
test("routing follows the current task assignment instead of an earlier binding",()=>{
 const d=fake(),id=crypto.randomUUID();d.state.tasks[id]={task_id:id,project:"P",state:"working",binding_id:"new",assignment:{agent:"Ret",device_id:"cccccccccccccccc",session_id:"new",epoch:2}};
 d.state.bindings={old:{id:"old",project:"P",agent:"Ret",device_id:"bbbbbbbbbbbbbbbb"},new:{id:"new",project:"P",agent:"Ret",device_id:"cccccccccccccccc"}};
 assert.equal(d.peers.routeFor({kind:"forward",project:"P",to:"Ret",task_id:id}).id,"cccccccccccccccc");
});
test("ambiguous active devices never select the first same-named agent",()=>{
 const d=fake();d.state.tasks={one:{project:"P",state:"working",assignment:{agent:"Ret",device_id:"bbbbbbbbbbbbbbbb"}},two:{project:"P",state:"working",assignment:{agent:"Ret",device_id:"cccccccccccccccc"}}};
 const t={kind:"forward",project:"P",to:"Ret"};assert.equal(d.peers.routeFor(t),null);assert.match(t.warning,/несколько/);
});
test("new coordinator epoch wins over a larger old-worker Lamport clock",()=>{
 const a=fake(),b=fake("bbbbbbbbbbbbbbbb"),id=crypto.randomUUID();
 a.state.tasks[id]={task_id:id,project:"P",coordinator_device_id:a.config.device_id,state:"working",assignment:{agent:"Ret",device_id:b.config.device_id,session_id:"old",epoch:1}};a._saveState();b.sync.receive(a.sync.page().events);
 b.state.tasks[id].state="submitted";b.sync.journal.clock=1000;b._saveState();
 a.state.tasks[id].assignment={agent:"Ret",device_id:b.config.device_id,session_id:"new",epoch:2};a.state.tasks[id].state="assigned";a._saveState();b.sync.receive([a.sync.journal.events.at(-1)]);
 assert.equal(b.state.tasks[id].assignment.epoch,2);assert.equal(b.state.tasks[id].assignment.session_id,"new");
});
test("task project identity cannot be retagged by a newer peer snapshot",()=>{
 const a=fake(),b=fake("bbbbbbbbbbbbbbbb"),id=crypto.randomUUID(),pid=crypto.randomUUID();
 a.state.tasks[id]={task_id:id,project_id:pid,project:"P",coordinator_device_id:a.config.device_id,state:"working",assignment:{agent:"Ret",device_id:b.config.device_id,session_id:"old",epoch:1}};a._saveState();const ev=a.sync.page().events[0];b.sync.receive([ev]);
 const bad=structuredClone(ev);bad.id=crypto.randomUUID();bad.clock=100;bad.data.project_id=crypto.randomUUID();assert.throws(()=>b.sync.receive([bad]),/идентичность проекта/);assert.equal(b.state.tasks[id].project_id,pid);
});
test("legacy markers reuse an explicitly assigned project UUID instead of remapping it",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"agentdesk-project-id-"));try{
 const d=new Desk({dataDir:root,legacyDir:null,discovery:false,log(){}}),pid=crypto.randomUUID();
 d.tasks.assign({project:"P",project_id:pid,title:"Assigned",agent:"Ret",device_id:d.config.device_id,session_id:"s",adapter:"manual"});
 const ev=parseMarker(JSON.stringify({agent:"Lead",state:"done",task:"New report",to:"Ret",message:"Synthetic"}),"P");d.applyEvent(ev);d._saveState();
 assert.equal(ev.project_id,pid);assert.equal(d.state.todos[0].project_id,pid);assert.ok(Object.values(d.state.tasks).every(t=>t.project_id===pid));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
