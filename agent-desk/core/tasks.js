"use strict";
/** Standalone task lifecycle; no runtime launching, network calls or implicit filesystem roots. */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES = new Set(["assigned", "working", "submitted", "accepted", "rework", "blocked"]);
const NEXT = {
  assigned: ["working", "submitted", "blocked"], working: ["submitted", "blocked"],
  submitted: ["accepted", "rework", "blocked"], accepted: [],
  rework: ["working", "submitted", "blocked"], blocked: ["assigned", "working", "submitted", "rework"],
};
const SECRET = /(?:-----BEGIN [^-]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:gh[pousr]_[\w]{16,}|github_pat_[\w]{16,}|sk-[\w-]{16,})|(?:password|passwd|secret|authorization|(?:api|agent|access|refresh)[ _-]?key|(?:(?:access|refresh)[ _-]?)?token)["']?\s*[=:]\s*["']?[^\s"']+|https?:\/\/[^\s/@]+:[^\s/@]+@)/i;
const SECRET_PATH = /(?:^|[/\\])(?:\.git|\.env(?:\.[^/\\]+)?|node_modules|credentials?(?:\.[^/\\]+)?|secrets?(?:\.[^/\\]+)?|id_(?:rsa|ed25519)|[^/\\]*\.(?:pem|key|p12|pfx|keystore))(?:[/\\]|$)/i;
const clone = (value) => structuredClone(value);
const now = () => new Date().toISOString();
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
function text(v, field, max = 500, required = false) {
  if (v === undefined || v === null) { if (required) fail(400, `${field} is required`); return ""; }
  if (typeof v !== "string" || v.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)) fail(400, `${field} must be a bounded string`);
  const out = v.trim();
  if (required && !out) fail(400, `${field} is required`);
  if (SECRET.test(out)) fail(400, `${field} contains credential-like data; remove it`);
  return out;
}
function uuid(v, field) {
  if (typeof v !== "string" || !UUID.test(v)) fail(400, `${field} must be a UUID`);
  return v.toLowerCase();
}
function identity(v, field, required = true) {
  const out = text(v, field, 128, required);
  if (out && !/^[a-z0-9._:-]+$/i.test(out)) fail(400, `${field} contains unsupported characters`);
  return out;
}
function epoch(v, required = true) {
  if (v === undefined && !required) return null;
  if (!Number.isSafeInteger(v) || v < 1) fail(400, "assignment_epoch must be a positive integer");
  return v;
}
function keys(value, allowed, field) {
  if (!object(value)) fail(400, `${field} must be an object`);
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(400, `${field} contains unsupported fields (commands and secrets are not allowed)`);
}
function relative(v, field) {
  const out = text(v, field, 1024, true).replace(/\\/g, "/");
  if (path.isAbsolute(out) || /^[a-z]:/i.test(out) || out.split("/").some((s) => !s || s.startsWith(".") || s.includes(":")) || SECRET_PATH.test(out)) fail(400, `${field} must be a safe relative non-secret file path`);
  return out;
}
function absolutePath(v, field) {
  const out = text(v, field, 1024, true);
  const withoutDrive = out.replace(/^[a-z]:/i, "");
  if (!path.isAbsolute(out) || withoutDrive.includes(":") || /^\\\\[?.]\\/.test(out) || SECRET_PATH.test(out)) fail(400, `${field} must be an absolute non-secret path without device/stream syntax`);
  return out;
}
function hash(v, field = "sha256") {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/i.test(v)) fail(400, `${field} must be a SHA-256 hex digest`);
  return v.toLowerCase();
}
function artifacts(value) {
  if (!Array.isArray(value) || value.length > 64) fail(400, "artifacts/manifest must be a list of at most 64 files");
  const seenPaths = new Set();
  return value.map((item) => {
    keys(item, ["path", "hash", "sha256", "status", "size"], "artifact");
    const out = { path: relative(item.path, "artifact.path") };
    if (seenPaths.has(out.path)) fail(400, "artifact/manifest paths must be unique");
    seenPaths.add(out.path);
    if (item.sha256 !== undefined || item.hash !== undefined) {
      out.sha256 = hash(item.sha256 ?? item.hash);
      if (item.hash !== undefined && hash(item.hash) !== out.sha256) fail(400, "artifact hashes disagree");
    }
    if (item.status !== undefined) {
      out.status = text(item.status, "artifact.status", 32, true);
      if (!["expected", "present", "verified", "missing", "changed", "added", "modified", "deleted", "submitted", "unverified"].includes(out.status)) fail(400, "unsupported artifact status");
    }
    if (item.size !== undefined) {
      if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > 8 * 1024 * 1024) fail(400, "artifact.size exceeds 8 MiB");
      out.size = item.size;
    }
    return out;
  });
}
function narrative(value, field) {
  if (/^(?:[$>#]\s*)?(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh|bash|sh|zsh|curl|wget|node|python\d*|npm|npx|git|ssh|scp|sudo|rm|del|rmdir|echo|eval|exec)\s/im.test(value) || /`|\$\(|&&|\|\|/.test(value)) fail(400, `${field} must be descriptive metadata, not an executable command`);
  return value;
}
function checkpoint(value) {
  keys(value, ["repo", "branch", "commit", "report", "manifest", "next_step", "constraints", "skills"], "checkpoint");
  const out = {};
  for (const name of ["repo", "branch", "commit", "report", "next_step"]) {
    if (value[name] !== undefined) out[name] = text(value[name], `checkpoint.${name}`, name === "next_step" ? 4000 : 1024);
  }
  for (const name of ["report", "next_step"]) if (out[name]) out[name] = narrative(out[name], `checkpoint.${name}`);
  if (out.repo) out.repo = absolutePath(out.repo, "checkpoint.repo");
  if (out.branch && (!/^[a-z0-9_./-]+$/i.test(out.branch) || /^[-/]|[/.]$|\.\.|\/\/|\.lock(?:\/|$)/.test(out.branch))) fail(400, "checkpoint.branch is not a safe Git ref");
  if (out.commit && !/^(?:[a-f0-9]{7,40}|[a-f0-9]{64})$/i.test(out.commit)) fail(400, "checkpoint.commit must be a Git object hex id");
  if (value.manifest !== undefined) out.manifest = artifacts(value.manifest);
  if (value.constraints !== undefined) {
    if (!Array.isArray(value.constraints) || value.constraints.length > 32) fail(400, "checkpoint.constraints must be a bounded list");
    out.constraints = value.constraints.map((s) => narrative(text(s, "constraint", 1000, true), "constraint"));
  }
  if (value.skills !== undefined) {
    if (!Array.isArray(value.skills) || value.skills.length > 8) fail(400, "checkpoint.skills must select at most 8 files");
    out.skills = value.skills.map((s) => {
      if (typeof s === "string") s = { path: s };
      keys(s, ["path", "sha256", "name"], "skill");
      const p = text(s.path, "skill.path", 1024, true);
      if (SECRET_PATH.test(p) || !/\.(?:md|txt)$/i.test(p)) fail(400, "select non-secret Markdown/text skill files only");
      if (path.isAbsolute(p)) absolutePath(p, "skill.path");
      else relative(p, "skill.path");
      const item = { path: p };
      if (s.sha256 !== undefined) item.sha256 = hash(s.sha256);
      if (s.name !== undefined) item.name = text(s.name, "skill.name", 100, true);
      return item;
    });
  }
  if (JSON.stringify(out).length > 64 * 1024) fail(400, "checkpoint exceeds 64 KiB");
  return out;
}
function metadata(body, task) {
  if (body.checkpoint !== undefined) task.checkpoint = checkpoint(body.checkpoint);
  if (body.artifacts !== undefined) task.artifacts = artifacts(body.artifacts);
}
function contained(root, file) {
  const rel = path.relative(root, file);
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}
/** Reject links/junctions at every component, including the approved root's ancestors. */
function noLinks(file) {
  const absolute = path.resolve(file);
  const base = path.parse(absolute).root;
  let current = base;
  for (const part of absolute.slice(base.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("symlink/junction paths are not allowed");
  }
  if (path.resolve(fs.realpathSync(absolute)).toLowerCase() !== absolute.toLowerCase()) throw new Error("path resolves outside its declared location");
  return absolute;
}
function boundedRead(file, max) {
  noLinks(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink > 1 || stat.size > max) throw new Error("not a bounded regular single-link file");
    const buffer = Buffer.alloc(Math.min(stat.size + 1, max + 1));
    let length = 0;
    while (length < buffer.length) {
      const got = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!got) break;
      length += got;
    }
    if (length > max || length !== stat.size) throw new Error("file changed or exceeds read limit");
    noLinks(file);
    const after = fs.statSync(file);
    if (after.ino !== stat.ino || after.dev !== stat.dev || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("file changed while reading");
    return buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
function redacted(value) {
  const blocksRemoved = String(value).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi, "[private key block omitted]");
  return blocksRemoved.split(/\r?\n/).map((line) => SECRET.test(line) ? "[credential-like line omitted]" : line).join("\n");
}
function safeOutput(value) {
  if (typeof value === "string") return redacted(value);
  if (Array.isArray(value)) return value.map(safeOutput);
  if (object(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:password|passwd|secret|token|authorization|(?:api|agent|access|refresh)[_-]?key)/i.test(key)).map(([key, item]) => [key, safeOutput(item)]));
  return value;
}

class TaskService {
  constructor(desk) {
    if (!desk || !object(desk.state) || !object(desk.config)) throw new TypeError("TaskService requires a loaded desk");
    this.desk = desk;
    if (!object(desk.state.tasks)) desk.state.tasks = {};
    if (!object(desk.state.bindings)) desk.state.bindings = {};
  }

  list(filters = {}) {
    if (!object(filters)) fail(400, "filters must be an object");
    return Object.values(this.desk.state.tasks).filter((task) => {
      for (const key of ["task_id", "project_id", "project", "state"]) if (filters[key] && task[key] !== filters[key]) return false;
      for (const key of ["device_id", "session_id", "role"]) if (filters[key] && task.assignment[key] !== filters[key]) return false;
      return !filters.agent || this._same(task.assignment.agent, filters.agent, task.project);
    }).map(clone);
  }

  get(id) {
    const task = this.desk.state.tasks[uuid(id, "task_id")];
    if (!task) fail(404, "Task not found");
    return clone(task);
  }

  _same(a, b, project) {
    const canonical = (s) => typeof this.desk.canonical === "function" ? this.desk.canonical(project, s) : s;
    const norm = (s) => String(canonical(s)).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    return norm(a) === norm(b);
  }

  _project(body, existing) {
    const project = text(body.project ?? existing?.project, "project", 60, true);
    const projectId = body.project_id !== undefined && body.project_id !== null && body.project_id !== "" ? uuid(body.project_id, "project_id") : existing?.project_id;
    if (existing && (project !== existing.project || (projectId && projectId !== existing.project_id))) fail(403, "Task belongs to a different project");
    const ids = [...new Set(Object.values(this.desk.state.tasks).filter((t) => t.project === project).map((t) => t.project_id))];
    if (!existing && projectId && ids.length && !ids.includes(projectId)) fail(409, "Project identity conflicts with the known project; resolve the mapping first");
    if (!existing && !projectId && ids.length > 1) fail(409, "Ambiguous project identity; provide project_id");
    return { project, project_id: projectId || ids[0] || crypto.randomUUID() };
  }

  _assignment(body, fallback = {}, observed = false) {
    if (body.assignment !== undefined && !object(body.assignment)) fail(400, "assignment must be an object");
    const source = { ...body, ...(body.assignment || {}) };
    const project = body.project;
    let agent = text(source.agent ?? source.to ?? fallback.agent, "agent", 60, true);
    if (typeof this.desk.canonical === "function") agent = this.desk.canonical(project, agent);
    return {
      agent, device_id: identity(source.device_id ?? fallback.device_id, "device_id"),
      session_id: identity(source.session_id ?? source.session ?? fallback.session_id, "session_id", !observed),
      epoch: fallback.epoch || 1, role: text(source.role ?? fallback.role ?? "worker", "role", 60, true),
      adapter: identity(source.adapter ?? fallback.adapter ?? "manual", "adapter"),
    };
  }

  _coordinator(task) {
    const local = identity(this.desk.config.device_id, "local device_id");
    if (task && task.coordinator_device_id !== local) fail(409, "Only the coordinator device can assign or hand off this task; open its Agent Desk");
    return local;
  }

  _expected(body, task) {
    const value = body.assignment_epoch ?? body.epoch;
    if (epoch(value) !== task.assignment.epoch) fail(409, "Stale assignment_epoch; reload the task and use its current assignment");
    if (body.binding_id !== undefined && uuid(body.binding_id, "binding_id") !== task.binding_id) fail(409, "Binding has been retired; reload the task");
    for (const [key, field] of [["previous_session_id", "session_id"], ["previous_device_id", "device_id"]]) {
      if (body[key] !== undefined && identity(body[key], key) !== task.assignment[field]) fail(409, "The previous assignment has been retired");
    }
  }

  _reporter(body, task, legacy = false) {
    this._project(body, task);
    const agent = text(body.agent, "agent", 60, true);
    if (!this._same(agent, task.assignment.agent, task.project)) fail(403, "Reporter is not the assigned recipient");
    const device = identity(body.device_id ?? (legacy ? this.desk.config.device_id : undefined), "device_id");
    if (device !== task.assignment.device_id) fail(403, "Reporter is bound to a different device");
    const session = identity(body.session_id ?? body.session, "session_id", !legacy || !!task.assignment.session_id);
    if (session !== task.assignment.session_id) fail(409, "Report from a retired or different session; request an explicit handoff");
    if (body.assignment_epoch !== undefined || body.epoch !== undefined || !legacy || task.managed_assignment) this._expected(body, task);
  }

  _reviewer(body, task) {
    this._project(body, task);
    this._expected(body, task);
    if (this.desk.config.device_id !== task.coordinator_device_id) fail(403, "Review must be performed on the coordinator device");
    const actor = body.actor || body;
    if (!object(actor)) fail(400, "actor must be an object");
    const agent = text(actor.agent, "review actor.agent", 60, true);
    const device = identity(actor.device_id, "review actor.device_id");
    const session = identity(actor.session_id ?? actor.session, "review actor.session_id");
    if (device !== task.coordinator_device_id) fail(403, "Review actor is not on the coordinator device");
    const binding = Object.values(this.desk.state.bindings).find((b) => b.project === task.project && this._same(b.agent, agent, task.project) && b.device_id === device && b.session_id === session && ["coordinator", "reviewer"].includes(b.role));
    if (!binding) fail(403, "Review actor needs an explicit coordinator/reviewer binding for this project and session");
    return { agent: binding.agent, device_id: device, session_id: session, role: binding.role, binding_id: binding.id };
  }

  _new(body, assignment, coordinator) {
    const project = this._project(body);
    const time = now();
    return {
      task_id: body.task_id !== undefined ? uuid(body.task_id, "task_id") : crypto.randomUUID(), ...project,
      title: text(body.title ?? body.task, "title", 500, true), state: "assigned", coordinator_device_id: coordinator,
      assignment, checkpoint: {}, artifacts: [], history: [], created: time, updated: time,
      managed_assignment: false,
      launch: { status: "needs_manual_launch", adapter: assignment.adapter, reason: "No launch adapter is implemented; copy context into the target session manually." },
    };
  }

  _history(task, kind, body = {}, oldState = task.state, prior, actor) {
    const row = {
      time: now(), kind, from_state: oldState, state: task.state, agent: task.assignment.agent,
      device_id: task.assignment.device_id, session_id: task.assignment.session_id, assignment_epoch: task.assignment.epoch,
    };
    if (body.event_id) row.event_id = text(body.event_id, "event_id", 120, true);
    if (body.note) row.note = text(body.note, "note", 1000);
    if (body.seq !== undefined && body.seq !== null) {
      if (!Number.isSafeInteger(body.seq) || body.seq < 0) fail(400, "seq must be a nonnegative integer");
      row.seq = body.seq;
    }
    if (actor) row.actor = clone(actor);
    if (prior) row.previous_assignment = clone(prior);
    task.history = [...task.history, row].slice(-200);
    task.updated = row.time;
  }

  _put(task, persist) {
    const state = this.desk.state;
    const before = persist ? clone(state) : null;
    const dirtyBefore = this.desk.dirty;
    const a = task.assignment;
    const existing = Object.values(state.bindings).find((b) => b.project === task.project && this._same(b.agent, a.agent, task.project) && b.device_id === a.device_id && b.session_id === a.session_id && b.role === a.role && b.adapter === a.adapter);
    const binding = existing || { id: crypto.randomUUID(), project: task.project, agent: a.agent, role: a.role, device_id: a.device_id, session_id: a.session_id, adapter: a.adapter };
    task.binding_id = binding.id;
    // Match the parent journal's complete UTF-8 event budget, not just checkpoint characters.
    const envelope = { id: crypto.randomUUID(), origin: "x".repeat(128), clock: Number.MAX_SAFE_INTEGER, type: "task", entity_id: task.task_id, data: task, deleted: false, time: now() };
    if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > 60000) fail(400, "Task exceeds the 60,000-byte sync event budget; shorten checkpoint/artifacts/history text");
    state.tasks = { ...state.tasks, [task.task_id]: task };
    state.bindings = { ...state.bindings, [binding.id]: binding };
    if (persist) {
      try { this.desk._saveState(); }
      catch (error) { this.desk.state = before; this.desk.dirty = dirtyBefore; throw error; }
      this.desk.emit("change");
    }
    return clone(task);
  }

  assign(body) {
    if (!object(body)) fail(400, "body must be an object");
    const id = body.task_id ?? body.id;
    let task = id !== undefined ? this.get(id) : null;
    const coordinator = this._coordinator(task);
    if (task) { this._project(body, task); this._expected(body, task); }
    const assignment = this._assignment({ ...body, project: body.project ?? task?.project }, { device_id: coordinator });
    const prior = task?.assignment;
    if (prior) {
      if (prior.epoch === Number.MAX_SAFE_INTEGER) fail(409, "Assignment epoch exhausted");
      assignment.epoch = prior.epoch + 1;
    }
    if (!task) task = this._new(body, assignment, coordinator);
    const old = task.state;
    task.assignment = assignment;
    task.state = "assigned";
    task.managed_assignment = true;
    task.launch = { status: "needs_manual_launch", adapter: assignment.adapter, reason: "No launch adapter is implemented; copy context into the target session manually." };
    metadata(body, task);
    this._history(task, "assign", body, old, prior);
    return this._put(task, true);
  }

  _state(body, task, observed = false) {
    const state = text(body.execution_state ?? body.state, "execution_state", 20, true);
    if (!STATES.has(state)) fail(400, `execution_state must be one of ${[...STATES].join(", ")}`);
    if (state !== task.state && !NEXT[task.state]?.includes(state)) fail(409, `Cannot transition from ${task.state} to ${state}`);
    if (["accepted", "rework"].includes(state) && this.desk.config.device_id !== task.coordinator_device_id) fail(403, "Acceptance/rework requires the coordinator device");
    // Observed review decisions must originate on the coordinator device too.
    if (observed && ["accepted", "rework"].includes(state) && body.device_id !== task.coordinator_device_id) fail(403, "Acceptance/rework markers must come from the coordinator device");
    return state;
  }

  transition(body) {
    if (!object(body)) fail(400, "body must be an object");
    const task = this.get(body.task_id ?? body.id);
    const review = ["accepted", "rework"].includes(body.execution_state ?? body.state);
    let actor;
    if (review && body.actor) actor = this._reviewer(body, task);
    else {
      this._reporter(body, task);
      if (review) actor = { agent: "owner", device_id: this.desk.config.device_id, session_id: "", role: "owner" };
    }
    const old = task.state;
    task.state = this._state(body, task);
    metadata(body, task);
    this._history(task, "transition", body, old, undefined, actor);
    return this._put(task, true);
  }

  handoff(body) {
    if (!object(body)) fail(400, "body must be an object");
    const task = this.get(body.task_id ?? body.id);
    this._coordinator(task);
    this._project(body, task);
    this._expected(body, task);
    const prior = clone(task.assignment);
    const assignment = this._assignment({ ...body, project: task.project }, prior);
    if (assignment.device_id === prior.device_id && assignment.session_id === prior.session_id && this._same(assignment.agent, prior.agent, task.project)) fail(409, "Handoff must select a different agent, device or session");
    if (prior.epoch === Number.MAX_SAFE_INTEGER) fail(409, "Assignment epoch exhausted");
    assignment.epoch = prior.epoch + 1;
    const old = task.state;
    task.assignment = assignment;
    task.state = "assigned";
    task.managed_assignment = true;
    task.launch = { status: "needs_manual_launch", adapter: assignment.adapter, reason: "No launch adapter is implemented; copy context into the target session manually." };
    metadata(body, task);
    this._history(task, "handoff", body, old, prior);
    return this._put(task, true);
  }

  /** Caller supplies already validated/canonicalized markers and owns their save/archive transaction. */
  observe(ev, todo) {
    if (!object(ev)) fail(400, "marker must be an object");
    if (ev.stale) return null;
    const project = text(ev.project, "project", 60, true);
    const title = text(ev.task ?? ev.title, "task", 500);
    const agent = text(ev.agent, "agent", 60, true);
    if (!title && !ev.task_id) return null; // ACK/idle-only markers do not invent tasks.
    let task;
    if (ev.task_id !== undefined && ev.task_id !== "") {
      const id = uuid(ev.task_id, "task_id");
      task = this.desk.state.tasks[id] ? this.get(id) : null;
    } else {
      const matches = Object.values(this.desk.state.tasks).filter((t) => t.project === project && t.title === title && this._same(t.assignment.agent, agent, project));
      task = matches.length === 1 ? clone(matches[0]) : null;
    }
    const legacy = !ev.task_id && !task?.managed_assignment;
    const review = ["accepted", "rework"].includes(ev.execution_state);
    let actor;
    if (!task) {
      const local = this._coordinator();
      const assignment = this._assignment({ ...ev, project }, { device_id: local }, !ev.task_id);
      if (ev.task_id || ev.assignment_epoch !== undefined) assignment.epoch = epoch(ev.assignment_epoch);
      task = this._new({ ...ev, task_id: ev.task_id || undefined, title }, assignment, local);
      task.managed_assignment = !!ev.task_id;
    } else {
      if (review) actor = this._reviewer(ev, task);
      else this._reporter(ev, task, legacy);
      if (ev.event_id && task.history.some((h) => h.event_id === ev.event_id)) return clone(task);
      const reporterSession = actor?.session_id ?? task.assignment.session_id;
      const previousSeq = [...task.history].reverse().find((h) => (h.actor?.session_id ?? h.session_id) === reporterSession && h.assignment_epoch === task.assignment.epoch && h.seq !== undefined)?.seq;
      if (ev.seq !== undefined && ev.seq !== null && previousSeq !== undefined && ev.seq <= previousSeq) fail(409, "Stale marker sequence for this assignment");
    }
    const old = task.state;
    const inferred = ev.execution_state || ({ working: "working", done: "submitted", blocked: "blocked" })[ev.state];
    if (inferred) task.state = this._state({ execution_state: inferred, device_id: actor?.device_id ?? task.assignment.device_id }, task, true);
    metadata(ev, task);
    this._history(task, "observe", ev, old, undefined, actor);
    const result = this._put(task, false);
    // Marker identity is additive; reminders/receipts remain independent of task completion.
    ev.task_id = task.task_id;
    ev.project_id = task.project_id;
    if (todo) { todo.task_id = task.task_id; todo.project_id = task.project_id; }
    return result;
  }

  _roots(kind, task) {
    const configured = this.desk.config[`task_${kind}_roots`] ?? this.desk.config[`approved_${kind}_roots`] ?? [];
    if (!Array.isArray(configured)) return [];
    return configured.slice(0, 32).filter((r) => typeof r === "string" || (object(r) && (!r.project || r.project === task.project) && (!r.project_id || r.project_id === task.project_id)))
      .map((r) => typeof r === "string" ? r : r.path).filter((p) => typeof p === "string" && path.isAbsolute(p)).map((p) => path.resolve(p));
  }

  _approved(file, roots) {
    const target = path.resolve(file);
    const root = roots.find((r) => contained(r, target));
    if (!root) throw new Error("path is outside explicitly approved roots");
    noLinks(root);
    return noLinks(target);
  }

  _git(repo, args) {
    const env = {};
    for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG"]) if (process.env[name] !== undefined) env[name] = process.env[name];
    Object.assign(env, { GIT_ATTR_NOSYSTEM: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_COUNT: "0", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", LC_ALL: "C" });
    const result = spawnSync("git", ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", `core.attributesFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "-c", `core.excludesFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "-c", "credential.helper=", ...args], { cwd: repo, env, shell: false, windowsHide: true, encoding: "utf8", timeout: 1500, maxBuffer: 256 * 1024 });
    if (result.error || result.status !== 0) throw new Error(result.error?.code === "ETIMEDOUT" ? "Git verification timed out" : "Git verification unavailable or failed");
    return result.stdout.trim();
  }

  _gitMetadata(repo) {
    const directory = path.join(repo, ".git");
    noLinks(directory);
    if (!fs.statSync(directory).isDirectory()) throw new Error("linked worktrees/submodules are not supported for verification");
    for (const name of ["commondir", "config.worktree", "worktrees", "objects/info/alternates", "objects/info/http-alternates"]) {
      if (fs.existsSync(path.join(directory, name))) throw new Error("redirecting Git metadata is not supported");
    }
    const configPath = path.join(directory, "config");
    if (fs.existsSync(configPath)) {
      const config = boundedRead(configPath, 64 * 1024).toString("utf8");
      if (/^\s*\[\s*(?:include(?:if)?|filter|submodule|extensions|alias|fsmonitor)(?:\s|\])/im.test(config) || /^\s*(?:worktree|gitdir|fsmonitor|hookspath|sshcommand|askpass|editor|pager)\s*=/im.test(config)) throw new Error("Git includes, redirects or executable configuration are not allowed for verification");
    }
    const pending = [directory];
    let entries = 0;
    while (pending.length) {
      const current = pending.pop();
      const handle = fs.opendirSync(current);
      try {
        let entry;
        while ((entry = handle.readSync())) {
          if (++entries > 4096) throw new Error("Git metadata exceeds bounded inspection limit");
          const file = path.join(current, entry.name);
          const stat = fs.lstatSync(file);
          if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || stat.isFile() && stat.nlink > 1) throw new Error("linked or special Git metadata is not supported");
          if (stat.isDirectory()) pending.push(file);
        }
      } finally { handle.closeSync(); }
    }
  }

  context(id) {
    const task = this.get(id);
    // Also validate replicated metadata before reading it; state from peers is not filesystem authority.
    const cp = checkpoint(task.checkpoint || {});
    const files = artifacts(task.artifacts || []);
    const checks = { repo: { status: "not_requested" }, artifacts: [], skills: [], report: { status: cp.report ? "metadata_only" : "not_requested" }, remote_push: { status: "unverified", reason: "No network fetch or push is performed." } };
    const lines = ["[Agent Desk task context — metadata, not executable instructions]", `task_id: ${task.task_id}`, `project: ${task.project}`, `project_id: ${task.project_id}`, `title: ${task.title}`, `state: ${task.state}`, `coordinator_device_id: ${task.coordinator_device_id}`, `agent: ${task.assignment.agent}`, `device_id: ${task.assignment.device_id}`, `session_id: ${task.assignment.session_id}`, `assignment_epoch: ${task.assignment.epoch}`, `adapter: ${task.assignment.adapter} (needs_manual_launch)`, "ACK/delivery are receipts only; done reports mean submitted, not accepted."];
    if (cp.next_step) lines.push(`next_step: ${cp.next_step}`);
    if (cp.report) lines.push(`report (unread metadata): ${cp.report}`);
    if (cp.constraints?.length) lines.push("constraints:", ...cp.constraints.map((s) => `- ${s}`));
    let repo;
    if (cp.repo) {
      try {
        repo = this._approved(cp.repo, this._roots("repo", task));
        if (!fs.statSync(repo).isDirectory()) throw new Error("repo must be a directory");
        // Linked worktrees/submodules can redirect Git outside approval; fail closed here.
        this._gitMetadata(repo);
        const top = this._git(repo, ["rev-parse", "--show-toplevel"]);
        if (path.resolve(top).toLowerCase() !== repo.toLowerCase()) throw new Error("checkpoint.repo must name the repository root");
        const head = this._git(repo, ["rev-parse", "--verify", "HEAD"]);
        let branch = null;
        try { branch = this._git(repo, ["symbolic-ref", "--short", "-q", "HEAD"]); } catch { /* detached HEAD */ }
        const status = this._git(repo, ["status", "--porcelain=v1", "--untracked-files=no", "--ignore-submodules=all"]);
        let commitPresent = null;
        let resolvedCommit;
        if (cp.commit) {
          try { resolvedCommit = this._git(repo, ["rev-parse", "--verify", `${cp.commit}^{commit}`]); commitPresent = true; }
          catch { commitPresent = false; }
        }
        checks.repo = { status: "verified", head, branch, clean_tracked: !status, branch_matches: cp.branch ? cp.branch === branch : null, commit_present: commitPresent, commit_matches_head: cp.commit ? resolvedCommit === head : null };
        if (resolvedCommit) {
          const refs = this._git(repo, ["for-each-ref", `--contains=${resolvedCommit}`, "--format=%(refname)", "refs/remotes/"]).split(/\r?\n/).filter((r) => /^refs\/remotes\/[a-z0-9_./-]+$/i.test(r)).slice(0, 64);
          checks.remote_push = refs.length ? { status: "local_remote_tracking_evidence", refs, reason: "These local cached refs contain the checkpoint commit; remote freshness/push is not verified." } : { status: "unverified", reason: "No local remote-tracking ref contains this commit; no fetch performed." };
        }
      } catch (error) { checks.repo = { status: "blocked", reason: redacted(error.message).slice(0, 200) }; repo = undefined; }
    }
    let remaining = 32 * 1024 * 1024;
    const selected = [...files, ...(cp.manifest || [])];
    const seen = new Set();
    for (const item of selected) {
      if (seen.has(item.path)) continue;
      seen.add(item.path);
      const row = { path: item.path, status: "blocked" };
      const declarations = selected.filter((other) => other.path === item.path);
      const declaredHashes = new Set(declarations.map((other) => other.sha256).filter(Boolean));
      const declaredSizes = new Set(declarations.map((other) => other.size).filter((size) => size !== undefined));
      if (declaredHashes.size > 1 || declaredSizes.size > 1) {
        row.status = "conflicting_metadata";
        row.reason = "Artifact and manifest declarations disagree; verification omitted";
        checks.artifacts.push(row);
        continue;
      }
      const expectedHash = [...declaredHashes][0];
      const expectedSize = [...declaredSizes][0];
      try {
        if (!repo) throw new Error("Approved repository verification is required");
        const file = this._approved(path.join(repo, item.path), [repo]);
        const data = boundedRead(file, Math.min(8 * 1024 * 1024, remaining));
        remaining -= data.length;
        row.sha256 = crypto.createHash("sha256").update(data).digest("hex");
        row.size = data.length;
        row.status = expectedHash && expectedHash !== row.sha256 || expectedSize !== undefined && expectedSize !== row.size ? "mismatch" : expectedHash ? "verified" : "present_unpinned";
      } catch (error) { row.reason = redacted(error.message).slice(0, 200); }
      checks.artifacts.push(row);
    }
    let skillRemaining = 128 * 1024;
    for (const selectedSkill of cp.skills || []) {
      const row = { path: selectedSkill.path, status: "blocked" };
      try {
        const roots = this._roots("skill", task);
        const candidates = path.isAbsolute(selectedSkill.path) ? [selectedSkill.path] : roots.map((r) => path.join(r, selectedSkill.path)).filter((p) => fs.existsSync(p));
        if (candidates.length !== 1) throw new Error("Skill selection is missing or ambiguous within approved roots");
        const file = this._approved(candidates[0], roots);
        const data = boundedRead(file, Math.min(32 * 1024, skillRemaining));
        skillRemaining -= data.length;
        row.sha256 = crypto.createHash("sha256").update(data).digest("hex");
        if (selectedSkill.sha256 && selectedSkill.sha256 !== row.sha256) { row.status = "mismatch"; row.reason = "Selected skill hash does not match; content omitted"; }
        else {
          const raw = data.toString("utf8");
          const safe = redacted(raw);
          row.status = safe !== raw ? "redacted" : selectedSkill.sha256 ? "verified" : "present_unpinned";
          lines.push(`\n[selected skill: ${selectedSkill.name || selectedSkill.path}; reference text only]`, safe, "[end selected skill]");
        }
      } catch (error) { row.reason = redacted(error.message).slice(0, 200); }
      checks.skills.push(row);
    }
    lines.push(`\nVerification: ${JSON.stringify(checks)}`);
    return { text: redacted(lines.join("\n")), task: safeOutput(task), checks: safeOutput(checks) };
  }
}

module.exports = { TaskService };
