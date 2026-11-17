"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {Desk,parseMarker}=require("../desk.js"),{stableId}=require("../sync.js");
function make(){const root=fs.mkdtempSync(path.join(os.tmpdir(),"agentdesk-card-number-"));const d=new Desk({dataDir:root,legacyDir:null,discovery:false,log(){}});d.config.watch=[];return{d,root};}
function assign(d,title){return d.tasks.assign({project:"P",project_id:stableId("project:p"),title,agent:"Worker",device_id:d.config.device_id,session_id:"card-session",adapter:"manual"});}
function observe(d,message){const ev=parseMarker(JSON.stringify({agent:"Lead",state:"done",to:"Worker",task:"Synthetic report",message}),"P");d.applyEvent(ev);d._saveState();return ev;}
test("task-only cards have distinct persistent local numbers, not list indices",()=>{
 const {d,root}=make();try{const one=assign(d,"One"),two=assign(d,"Two");const byId=Object.fromEntries(d.payload().tasks.map(t=>[t.task_id,t.card_id]));assert.equal(byId[one.task_id],"AT-1");assert.equal(byId[two.task_id],"AT-2");d._saveConfig();const restored=new Desk({dataDir:root,legacyDir:null,discovery:false,log(){}});assert.equal(restored.payload().tasks.find(t=>t.task_id===one.task_id).card_id,"AT-1");assert.equal(restored.payload().tasks.find(t=>t.task_id===two.task_id).card_id,"AT-2");}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test("existing assigned task without a message becomes visible once without renumbering", () => {
 const {d,root}=make();try {
  const task=assign(d,"Existing assignment");
  d.state.todos=[];
  delete d.state.tasks[task.task_id].assignment_message_id;
  d.state.task_card_ids[task.task_id]="AT-42";
  d._saveConfig();d._saveState();
  const restored=new Desk({dataDir:root,legacyDir:null,discovery:false,log(){}});
  assert.equal(restored.state.todos.length,1);
  assert.equal(restored.payload().tasks.find(t=>t.task_id===task.task_id).card_id,"AT-42");
  const message=restored.state.todos[0].message_id;
  restored._saveState();
  const again=new Desk({dataDir:root,legacyDir:null,discovery:false,log(){}});
  assert.equal(again.state.todos.length,1);assert.equal(again.state.todos[0].message_id,message);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test("linked card shows its AD number and does not renumber on resubmission",()=>{
 const {d,root}=make();try{const ev=observe(d,"v1"),first=d.state.todos[0];assert.equal(d.payload().tasks.find(t=>t.task_id===ev.task_id).card_id,"AD-1");first.forwarded_at=new Date().toISOString();observe(d,"v2");assert.equal(d.state.todos.length,2);assert.equal(d.state.todos[1].display_id,"AD-2");assert.equal(d.payload().tasks.find(t=>t.task_id===ev.task_id).card_id,"AD-1");}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test("numbers remain stable after lifecycle and sorting changes",()=>{
 const {d,root}=make();try{const t=assign(d,"One");assign(d,"Two");for(const state of ["working","submitted","accepted"])d.tasks.transition({task_id:t.task_id,project:"P",agent:"Worker",device_id:d.config.device_id,session_id:"card-session",assignment_epoch:1,state});assert.equal(d.payload().tasks.find(row=>row.task_id===t.task_id).card_id,"AT-1");}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test("local card numbers are not replicated as task identity or reused on another board",()=>{
 const a=make(),b=make();try{assign(b.d,"Already local");const t=assign(a.d,"From A");const event=a.d.sync.journal.events.find(ev=>ev.type==="task"&&ev.entity_id===t.task_id);assert.equal(event.data.card_id,undefined);b.d.sync.receive(a.d.sync.page().events);assert.equal(b.d.payload().tasks.find(row=>row.task_id===t.task_id).card_id,"AT-2");assert.equal(a.d.payload().tasks.find(row=>row.task_id===t.task_id).card_id,"AT-1");assert.equal(new Set(b.d.payload().tasks.map(row=>row.card_id)).size,2);}finally{fs.rmSync(a.root,{recursive:true,force:true});fs.rmSync(b.root,{recursive:true,force:true});}
});
