"use strict";
/** Standalone task lifecycle; no runtime launching, network calls or implicit filesystem roots. */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { stableId } = require("./sync.js");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES = new Set(["assigned", "working", "submitted", "accepted", "rework", "blocked", "cancelled", "archived"]);
const COORDINATOR_STATES = new Set(["accepted", "rework", "cancelled", "archived"]);
const NEXT = {
  assigned: ["working", "submitted", "blocked", "cancelled", "archived"],
  working: ["submitted", "blocked", "cancelled"],
  submitted: ["accepted", "rework", "blocked", "cancelled"],
  accepted: ["rework", "archived"],
  rework: ["working", "submitted", "blocked", "cancelled"],
  blocked: ["assigned", "working", "submitted", "rework", "cancelled", "archived"],
  cancelled: ["rework", "archived"],
  archived: ["rework"],
};
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
const payloadDigest = (value) => crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
const SECRET = /(?:-----BEGIN [^-]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:gh[pousr]_[\w]{16,}|github_pat_[\w]{16,}|sk-[\w-]{16,})|(?:password|passwd|secret|authorization|(?:api|agent|access|refresh)[ _-]?key|(?:(?:access|refresh)[ _-]?)?token)["']?\s*[=:]\s*["']?[^\s"']+|https?:\/\/[^\s/@]+:[^\s/@]+@)/i;
const SECRET_PATH = /(?:^|[/\\])(?:\.git|\.env(?:\.[^/\\]+)?|node_modules|credentials?(?:\.[^/\\]+)?|secrets?(?:\.[^/\\]+)?|id_(?:rsa|ed25519)|[^/\\]*\.(?:pem|key|p12|pfx|keystore))(?:[/\\]|$)/i;
const clone = (value) => structuredClone(value);
const now = () => new Date().toISOString();
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
function text(v, field, max = 500, required = false, raw = false) {
  if (v === undefined || v === null) { if (required) fail(400, `${field} is required`); return ""; }
  if (typeof v !== "string" || v.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)) fail(400, `${field} must be a bounded string`);
  const trimmed = v.trim();
  if (required && !trimmed) fail(400, `${field} is required`);
  const out = raw ? (trimmed ? v : "") : trimmed;
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
  keys(value, ["repo", "branch", "commit", "report", "manifest", "next_step", "constraints", "skills", "verification_steps", "out_dir"], "checkpoint");
  const out = {};
  for (const name of ["repo", "branch", "commit", "report", "next_step"]) {
    if (value[name] !== undefined) out[name] = text(value[name], `checkpoint.${name}`, name === "next_step" ? 4000 : 1024);
  }
  for (const name of ["report", "next_step"]) if (out[name]) out[name] = narrative(out[name], `checkpoint.${name}`);
  if (out.repo) out.repo = absolutePath(out.repo, "checkpoint.repo");
  if (value.out_dir !== undefined && String(value.out_dir).trim() !== "") out.out_dir = relative(value.out_dir, "checkpoint.out_dir");
  if (out.branch && (!/^[a-z0-9_./-]+$/i.test(out.branch) || /^[-/]|[/.]$|\.\.|\/\/|\.lock(?:\/|$)/.test(out.branch))) fail(400, "checkpoint.branch is not a safe Git ref");
  if (out.commit && !/^(?:[a-f0-9]{7,40}|[a-f0-9]{64})$/i.test(out.commit)) fail(400, "checkpoint.commit must be a Git object hex id");
  if (value.manifest !== undefined) out.manifest = artifacts(value.manifest);
  if (value.constraints !== undefined) {
    if (!Array.isArray(value.constraints) || value.constraints.length > 32) fail(400, "checkpoint.constraints must be a bounded list");
    out.constraints = value.constraints.map((s) => narrative(text(s, "constraint", 1000, true), "constraint"));
  }
  if (value.verification_steps !== undefined) {
    if (!Array.isArray(value.verification_steps) || value.verification_steps.length > 20) fail(400, "checkpoint.verification_steps must be a list of at most 20 text items");
    out.verification_steps = value.verification_steps.map((s) => text(s, "verification_step", 500, true));
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

  _assignmentMessage(task, { selfStarted = false } = {}) {
    const s = this.desk.state;
    const messageId = stableId(`assignment:${task.task_id}:${task.assignment.epoch}`);
    if (s.todos.some(t => t.message_id === messageId)) { task.assignment_message_id = messageId; return null; }
    const a = task.assignment, time = task.updated;
    const cp = task.checkpoint || {};
    const context = [["Репозиторий", cp.repo], ["Ветка", cp.branch], ["Коммит", cp.commit], ["Папка OUT", cp.out_dir], ["Отчёт", cp.report], ["Следующий шаг", cp.next_step]]
      .filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`);
    if (cp.verification_steps?.length) context.push(`Проверочные команды (текст для исполнителя, без автозапуска):\n${cp.verification_steps.map(value => `- ${value}`).join("\n")}`);
    if (cp.constraints?.length) context.push(`Ограничения:\n${cp.constraints.map(value => `- ${value}`).join("\n")}`);
    const message = [task.prompt || task.title, ...context].join("\n\n");
    const id = s.next_id || 1;
    const todo = {
      id, display_id: `AD-${id}`, kind: "forward", project: task.project, project_id: task.project_id,
      agent: "Владелец", to: a.agent, task: task.title, task_id: task.task_id, message,
      message_id: messageId, origin_device_id: task.coordinator_device_id,
      purpose: "assignment", assignment_epoch: a.epoch, recipient_session_id: a.session_id,
      recipient_device_id: a.device_id, created: time, updated: time,
      forwarded_at: selfStarted ? time : null,
      acked_at: selfStarted ? time : null,
       ...(selfStarted ? { acked_by: a.agent } : {}),
      done_at: selfStarted ? time : null,
      receipt_epoch: 0, auto: Boolean(selfStarted),
    };
    const envelope = { id: crypto.randomUUID(), origin: task.coordinator_device_id, clock: Number.MAX_SAFE_INTEGER, type: "todo", entity_id: messageId, data: todo, deleted: false, time };
    if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > 58000) fail(400, "Assignment prompt exceeds 58,000 bytes; shorten it or reference an attachment (space is reserved for receipts)");
    for (const prior of s.todos) {
      if (prior.purpose !== "assignment" || prior.task_id !== task.task_id || prior.assignment_epoch >= a.epoch) continue;
      prior.superseded_by = messageId;
      prior.done_at ||= time;
      prior.updated = time;
      todo.supersedes = prior.message_id;
    }
    task.assignment_message_id = messageId;
    s.next_id = id + 1;
    s.todos.push(todo);
    return todo;
  }

  _reworkMessage(task, actor, reworkText) {
    const cleanText = String(reworkText || "").trim();
    if (!cleanText) return null;
    const s = this.desk.state;
    const a = task.assignment, time = task.updated;
    const messageId = crypto.randomUUID();
    const sender = actor?.agent && actor.agent !== "owner" ? actor.agent : "Владелец";
    const id = s.next_id || 1;
    const todo = {
      id, display_id: `AD-${id}`, kind: "forward", project: task.project, project_id: task.project_id,
      agent: sender, to: a.agent, task: task.title, task_id: task.task_id,
      message: `Возвращено на доработку:\n${cleanText}`,
      message_id: messageId, origin_device_id: task.coordinator_device_id,
      purpose: "rework", assignment_epoch: a.epoch, recipient_session_id: a.session_id,
      recipient_device_id: a.device_id, created: time, updated: time,
      forwarded_at: null, acked_at: null, done_at: null, receipt_epoch: 0, auto: false,
    };
    const envelope = { id: crypto.randomUUID(), origin: task.coordinator_device_id, clock: Number.MAX_SAFE_INTEGER, type: "todo", entity_id: messageId, data: todo, deleted: false, time };
    if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > 58000) fail(400, "Rework message exceeds 58,000 bytes");
    for (const prior of s.todos) {
      if (prior.task_id !== task.task_id || prior.purpose === "assignment" || prior.done_at) continue;
      prior.superseded_by = messageId;
      prior.done_at = time;
      prior.closed_reason = "rework";
      prior.updated = time;
    }
    s.next_id = id + 1;
    s.todos.push(todo);
    return todo;
  }

  originKind(task) {
    if (task?.managed_assignment) return "managed";
    return task?.assignment?.role === "legacy" ? "migrated" : "observed";
  }

  lifecycleSigns(task) {
    const todos = Array.isArray(this.desk.state.todos) ? this.desk.state.todos : [];
    const localDevice = this.desk.config.device_id;
    const activeMsg = (task.state === "rework" && todos.findLast((t) => t.task_id === task.task_id && !t.superseded_by && t.purpose === "rework"))
      || (task.assignment_message_id && todos.find((t) => t.message_id === task.assignment_message_id))
      || todos.find((t) => t.task_id === task.task_id && !t.superseded_by && t.purpose === "assignment")
      || null;
    const needsForward = Boolean(
      activeMsg
      && !activeMsg.superseded_by
      && !activeMsg.forwarded_at
      && !activeMsg.acked_at
      && !activeMsg.done_at
      && (!activeMsg.delivery_target || activeMsg.delivery_target === localDevice)
    );
    return {
      on_board: Boolean(task?.created),
      needs_forward: needsForward,
      forwarded: Boolean(activeMsg?.forwarded_at),
      recipient_acked: Boolean(activeMsg?.acked_at),
      executing: task.state === "working",
      submitted: task.state === "submitted",
      accepted: task.state === "accepted",
    };
  }

  isActiveWork(task) {
    if (!task || ["accepted", "cancelled", "archived", "submitted"].includes(task.state)) return false;
    const origin = this.originKind(task);
    if (origin === "managed") return ["assigned", "working", "rework", "blocked"].includes(task.state);
    const todos = Array.isArray(this.desk.state.todos) ? this.desk.state.todos : [];
    const hasOpenTodo = todos.some((t) => t.task_id === task.task_id && !t.done_at && !t.superseded_by);
    if (origin === "migrated") return task.state === "blocked" && hasOpenTodo;
    if (task.state === "assigned") return hasOpenTodo;
    return ["working", "rework", "blocked"].includes(task.state);
  }

  _artifactAvailability(task, item) {
    const remoteAssignee = task.assignment?.device_id && task.assignment.device_id !== this.desk.config.device_id;
    const repoPath = task.checkpoint?.repo;
    if (!repoPath) return remoteAssignee ? "other_device" : "unverified";
    let approvedRepo;
    try {
      approvedRepo = this._approved(repoPath, this._roots("repo", task));
    } catch {
      return remoteAssignee ? "other_device" : "unapproved_root";
    }
    try {
      const target = path.resolve(approvedRepo, item.path);
      if (!contained(approvedRepo, target)) return "unapproved_root";
      if (!fs.existsSync(target)) return "missing_on_device";
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 8 * 1024 * 1024) return "missing_on_device";
      if (!item.sha256) return "available_unpinned";
      const data = fs.readFileSync(target);
      const actual = crypto.createHash("sha256").update(data).digest("hex");
      return actual === item.sha256.toLowerCase() ? "available_verified" : "hash_mismatch";
    } catch {
      return "missing_on_device";
    }
  }

  enrich(task) {
    if (!task) return task;
    const copy = clone(task);
    const card = this.desk.state.task_card_ids?.[copy.task_id];
    if (card) copy.card_id = card;
    copy.origin_kind = this.originKind(copy);
    copy.lifecycle_signs = this.lifecycleSigns(copy);
    copy.active_work = this.isActiveWork(copy);
    if (Array.isArray(copy.artifacts) && copy.artifacts.length) {
      copy.artifacts = copy.artifacts.map((a) => ({ ...a, local_availability: this._artifactAvailability(copy, a) }));
    }
    return copy;
  }

  _requestSpec(kind, body) {
    if (body.request_id === undefined || body.request_id === null || body.request_id === "") return null;
    const id = identity(body.request_id, "request_id", true);
    const { request_id: _ignored, ...rest } = body;
    return { id, kind, hash: payloadDigest({ kind, body: rest }) };
  }

  _replayRequest(spec) {
    if (!spec) return null;
    const entry = this.desk.state.task_requests?.[spec.id];
    if (!entry) return null;
    if (entry.hash !== spec.hash) fail(409, "request_id was already used with different parameters");
    const existing = this.desk.state.tasks?.[entry.task_id];
    return existing ? clone(existing) : null;
  }

  _isExactEpochRetry(kind, body, task) {
    const supplied = body.assignment_epoch ?? body.epoch;
    if (!Number.isSafeInteger(supplied) || supplied !== task.assignment.epoch - 1 || task.state !== "assigned") return false;
    const last = task.history?.at(-1);
    if (!last || last.kind !== kind || last.assignment_epoch !== task.assignment.epoch) return false;
    const fallback = kind === "handoff" ? last.previous_assignment || task.assignment : { device_id: task.coordinator_device_id };
    const candidate = this._assignment({ ...body, project: body.project ?? task.project }, fallback);
    const cur = task.assignment;
    if (!this._same(candidate.agent, cur.agent, task.project)
      || candidate.device_id !== cur.device_id
      || candidate.session_id !== cur.session_id
      || candidate.role !== cur.role
      || candidate.adapter !== cur.adapter) return false;
    if (body.prompt !== undefined || body.message !== undefined) {
      const wantedPrompt = text(body.prompt ?? body.message, "prompt", 20000, false, true);
      if (wantedPrompt !== (task.prompt || "")) return false;
    }
    if (body.checkpoint !== undefined && canonicalJson(checkpoint(body.checkpoint)) !== canonicalJson(task.checkpoint || {})) return false;
    if (body.artifacts !== undefined && canonicalJson(artifacts(body.artifacts)) !== canonicalJson(task.artifacts || [])) return false;
    return true;
  }

  _retireOpenAssignmentTodos(task, reasonState) {
    const todos = this.desk.state.todos;
    if (!Array.isArray(todos)) return;
    const time = task.updated || now();
    for (const row of todos) {
      if (row.task_id === task.task_id && !row.done_at) {
        row.done_at = time;
        row.closed_reason = reasonState;
        row.updated = time;
      }
    }
  }

  _put(task, persist, publishAssignment = false, reqSpec = null, putOpts = {}) {
    const state = this.desk.state;
    const before = persist ? clone(state) : null;
    const dirtyBefore = this.desk.dirty;
    const a = task.assignment;
    const existing = Object.values(state.bindings).find((b) => b.project === task.project && this._same(b.agent, a.agent, task.project) && b.device_id === a.device_id && b.session_id === a.session_id && b.role === a.role && b.adapter === a.adapter);
    const binding = existing || { id: crypto.randomUUID(), project: task.project, agent: a.agent, role: a.role, device_id: a.device_id, session_id: a.session_id, adapter: a.adapter };
    task.binding_id = binding.id;
    if (publishAssignment) task.assignment_message_id = stableId(`assignment:${task.task_id}:${a.epoch}`);
    const envelope = { id: crypto.randomUUID(), origin: "x".repeat(128), clock: Number.MAX_SAFE_INTEGER, type: "task", entity_id: task.task_id, data: task, deleted: false, time: now() };
    if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > 60000) fail(400, "Task exceeds the 60,000-byte sync event budget; shorten checkpoint/artifacts/history text");
    let createdTodo = null;
    try {
      if (publishAssignment) createdTodo = this._assignmentMessage(task, { selfStarted: Boolean(putOpts.selfStarted) });
      if (putOpts.reworkText) createdTodo = this._reworkMessage(task, putOpts.actor, putOpts.reworkText);
      else if (task.state === "rework") {
        const time = task.updated || now();
        for (const row of state.todos || []) {
          if (row.task_id === task.task_id && row.purpose !== "assignment" && !row.done_at) {
            row.done_at = time;
            row.closed_reason = "rework";
            row.updated = time;
          }
        }
      }
      if (["accepted", "cancelled", "archived"].includes(task.state)) this._retireOpenAssignmentTodos(task, task.state);
      if (createdTodo && !putOpts.selfStarted) this.desk.bridge?.tryAutoDispatchTodo?.(createdTodo);
      state.tasks = { ...state.tasks, [task.task_id]: task };
      state.bindings = { ...state.bindings, [binding.id]: binding };
      if (reqSpec) {
        const prevMap = object(state.task_requests) ? state.task_requests : {};
        const entries = [...Object.entries(prevMap).filter(([k]) => k !== reqSpec.id), [reqSpec.id, { hash: reqSpec.hash, task_id: task.task_id, time: task.updated }]].slice(-500);
        state.task_requests = Object.fromEntries(entries);
      }
      if (persist) this.desk._saveState();
    } catch (error) {
      if (persist) { this.desk.state = before; this.desk.dirty = dirtyBefore; }
      throw error;
    }
    if (persist) this.desk.emit("change");
    return clone(task);
  }

  bind(body) {
    if (!object(body)) fail(400, "body must be an object");
    const { project } = this._project(body);
    let agent = text(body.agent, "agent", 60, true);
    if (typeof this.desk.canonical === "function") agent = this.desk.canonical(project, agent);
    const device = identity(body.device_id ?? this.desk.config.device_id, "device_id");
    const session = identity(body.session_id ?? body.session, "session_id", true);
    const role = text(body.role ?? "coordinator", "role", 60, true);
    const adapter = identity(body.adapter ?? "manual", "adapter");
    const state = this.desk.state;
    const before = clone(state);
    const existing = Object.values(state.bindings || {}).find((b) => b.project === project && this._same(b.agent, agent, project) && b.device_id === device && b.session_id === session && b.role === role);
    const binding = existing ? { ...existing, adapter } : { id: crypto.randomUUID(), project, agent, role, device_id: device, session_id: session, adapter };
    try {
      state.bindings = { ...(state.bindings || {}), [binding.id]: binding };
      this.desk._saveState();
    } catch (e) {
      this.desk.state = before;
      throw e;
    }
    this.desk.emit("change");
    return { ok: true, binding: clone(binding) };
  }

  _checkAgentRegistryActive(project, agent) {
    const status = this.desk.agentRegistryStatus?.(project, agent);
    if (status === "paused" || status === "archived") {
      fail(409, `Agent "${agent}" is ${status} in the project registry; activate it before assignment`);
    }
  }

  assign(body) {
    if (!object(body)) fail(400, "body must be an object");
    const reqSpec = this._requestSpec("assign", body);
    const replayed = this._replayRequest(reqSpec);
    if (replayed) return replayed;
    const id = body.task_id ?? body.id;
    let task = id !== undefined ? this.get(id) : null;
    const coordinator = this._coordinator(task);
    if (task) {
      this._project(body, task);
      if (this._isExactEpochRetry("assign", body, task)) return clone(task);
      this._expected(body, task);
    }
    const targetProject = body.project ?? task?.project;
    const assignment = this._assignment({ ...body, project: targetProject }, { device_id: coordinator });
    this._checkAgentRegistryActive(targetProject, assignment.agent);
    const prior = task?.assignment;
    if (prior) {
      if (prior.epoch === Number.MAX_SAFE_INTEGER) fail(409, "Assignment epoch exhausted");
      assignment.epoch = prior.epoch + 1;
    }
    if (!task) task = this._new(body, assignment, coordinator);
    const selfStarted = Boolean(body.self_started);
    const old = task.state;
    task.assignment = assignment;
    task.state = selfStarted ? "working" : "assigned";
    delete task.status_reason;
    task.managed_assignment = true;
    task.launch = selfStarted
      ? { status: "self_started", adapter: assignment.adapter, reason: "Задача создана и сразу начата самим исполнителем/ведущим." }
      : { status: "needs_manual_launch", adapter: assignment.adapter, reason: "No launch adapter is implemented; copy context into the target session manually." };
    if (body.prompt !== undefined || body.message !== undefined) {
      const prompt = text(body.prompt ?? body.message, "prompt", 20000, false, true);
      if (prompt) task.prompt = prompt;
      else delete task.prompt;
    }
    metadata(body, task);
    this._history(task, "assign", body, old, prior);
    return this._put(task, true, true, reqSpec, { selfStarted });
  }

  _state(body, task, observed = false) {
    const state = text(body.execution_state ?? body.state, "execution_state", 20, true);
    if (!STATES.has(state)) fail(400, `execution_state must be one of ${[...STATES].join(", ")}`);
    if (state !== task.state && !NEXT[task.state]?.includes(state)) fail(409, `Cannot transition from ${task.state} to ${state}`);
    if (COORDINATOR_STATES.has(state) && this.desk.config.device_id !== task.coordinator_device_id) fail(403, "Acceptance/rework/cancel/archive requires the coordinator device");
    // Observed review/cancel/archive decisions must originate on the coordinator device too.
    if (observed && COORDINATOR_STATES.has(state) && body.device_id !== task.coordinator_device_id) fail(403, "Review/cancel/archive markers must come from the coordinator device");
    return state;
  }

  transition(body) {
    if (!object(body)) fail(400, "body must be an object");
    const reqSpec = this._requestSpec("transition", body);
    const replayed = this._replayRequest(reqSpec);
    if (replayed) return replayed;
    const task = this.get(body.task_id ?? body.id);
    const requestedState = body.execution_state ?? body.state;
    const coordAction = COORDINATOR_STATES.has(requestedState);
    const cancelOrArchive = ["cancelled", "archived"].includes(requestedState);
    let actor;
    if (coordAction && body.actor) actor = this._reviewer(body, task);
    else if (cancelOrArchive && !task.managed_assignment && !body.agent && !body.session_id) {
      this._project(body, task);
      if (this.desk.config.device_id !== task.coordinator_device_id) fail(403, "Cancel/archive requires the coordinator device");
      if (body.assignment_epoch !== undefined || body.epoch !== undefined) this._expected(body, task);
      actor = { agent: "owner", device_id: this.desk.config.device_id, session_id: "", role: "owner" };
    } else {
      this._reporter(body, task, !task.managed_assignment);
      if (coordAction) actor = { agent: "owner", device_id: this.desk.config.device_id, session_id: "", role: "owner" };
    }
    const reasonText = text(body.reason ?? body.note, "reason", 1000, requestedState === "cancelled");
    const old = task.state;
    task.state = this._state(body, task);
    if (task.state === "cancelled") task.status_reason = reasonText;
    else if (task.state === "archived") task.status_reason = reasonText || task.status_reason || "Перенесено в архив владельцем";
    else if (task.state === "rework") delete task.status_reason;
    const reworkText = task.state === "rework" ? text(body.message ?? body.reason ?? body.note, "message", 20000, false, true) : "";
    metadata(body, task);
    this._history(task, "transition", { ...body, note: body.note ?? reasonText }, old, undefined, actor);
    return this._put(task, true, false, reqSpec, { actor, reworkText });
  }

  handoff(body) {
    if (!object(body)) fail(400, "body must be an object");
    const reqSpec = this._requestSpec("handoff", body);
    const replayed = this._replayRequest(reqSpec);
    if (replayed) return replayed;
    const task = this.get(body.task_id ?? body.id);
    this._coordinator(task);
    this._project(body, task);
    if (this._isExactEpochRetry("handoff", body, task)) return clone(task);
    this._expected(body, task);
    const prior = clone(task.assignment);
    const assignment = this._assignment({ ...body, project: task.project }, prior);
    this._checkAgentRegistryActive(task.project, assignment.agent);
    if (assignment.device_id === prior.device_id && assignment.session_id === prior.session_id && this._same(assignment.agent, prior.agent, task.project)) fail(409, "Handoff must select a different agent, device or session");
    if (prior.epoch === Number.MAX_SAFE_INTEGER) fail(409, "Assignment epoch exhausted");
    assignment.epoch = prior.epoch + 1;
    const old = task.state;
    task.assignment = assignment;
    task.state = "assigned";
    delete task.status_reason;
    task.managed_assignment = true;
    task.launch = { status: "needs_manual_launch", adapter: assignment.adapter, reason: "No launch adapter is implemented; copy context into the target session manually." };
    if (body.prompt !== undefined || body.message !== undefined) {
      const prompt = text(body.prompt ?? body.message, "prompt", 20000, false, true);
      if (prompt) task.prompt = prompt;
      else delete task.prompt;
    }
    metadata(body, task);
    this._history(task, "handoff", body, old, prior);
    return this._put(task, true, true, reqSpec);
  }

  coordinate(body) {
    if (!object(body)) fail(400, "body must be an object");
    const reqSpec = this._requestSpec("coordinate", body);
    const replayed = this._replayRequest(reqSpec);
    if (replayed) return replayed;
    const task = this.get(body.task_id ?? body.id);
    const local = identity(this.desk.config.device_id, "local device_id");
    const target = identity(body.coordinator_device_id ?? body.target_device_id, "coordinator_device_id");
    if (task.coordinator_device_id === target && task.previous_coordinator_device_id === local) {
      this._expected(body, task);
      return clone(task);
    }
    this._coordinator(task);
    this._project(body, task);
    this._expected(body, task);
    if (target === local) return clone(task);
    const nextCoordEpoch = (task.coordinator_epoch || 1) + 1;
    if (!Number.isSafeInteger(nextCoordEpoch)) fail(409, "Coordinator epoch exhausted");
    task.previous_coordinator_device_id = local;
    task.coordinator_device_id = target;
    task.coordinator_epoch = nextCoordEpoch;
    const actor = { agent: "owner", device_id: local, session_id: "", role: "coordinator" };
    this._history(task, "coordinate", { note: body.note || `Координация передана на устройство ${target}` }, task.state, undefined, actor);
    return this._put(task, true, false, reqSpec);
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
      const matches = Object.values(this.desk.state.tasks).filter((t) => !["cancelled", "archived"].includes(t.state) && t.project === project && t.title === title && this._same(t.assignment.agent, agent, project)
        && (t.managed_assignment || ((!ev.device_id || t.assignment.device_id === ev.device_id) && (!t.assignment.session_id || !ev.session || t.assignment.session_id === ev.session))));
      task = matches.length === 1 ? clone(matches[0]) : null;
    }
    const legacy = !ev.task_id && !task?.managed_assignment;
    const review = COORDINATOR_STATES.has(ev.execution_state);
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
    if (inferred) {
      const reasonText = text(ev.note, "reason", 1000, inferred === "cancelled");
      task.state = this._state({ execution_state: inferred, device_id: actor?.device_id ?? task.assignment.device_id }, task, true);
      if (task.state === "cancelled") task.status_reason = reasonText;
      else if (task.state === "archived") task.status_reason = reasonText || task.status_reason || "Перенесено в архив";
      if (old === "rework" && ["working", "submitted"].includes(task.state)) {
        const at = ev.received || now();
        for (const row of this.desk.state.todos || []) {
          if (row.task_id === task.task_id && row.purpose === "rework" && !row.done_at) {
            row.forwarded_at ||= at; row.acked_at ||= at; row.acked_by ||= ev.agent; row.done_at = at; row.updated = at;
          }
        }
      }
    }
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
    if (task.prompt) lines.push("\n[Assignment prompt]", task.prompt, "[End assignment prompt]\n");
    if (task.assignment_message_id) lines.push(`message_id: ${task.assignment_message_id}; use this UUID to acknowledge receipt`);
    if (cp.next_step) lines.push(`next_step: ${cp.next_step}`);
    if (cp.out_dir) lines.push(`out_dir: ${cp.out_dir}`);
    if (cp.report) lines.push(`report (unread metadata): ${cp.report}`);
    if (cp.verification_steps?.length) lines.push("[Verification commands — plain text for executor, never run automatically by Agent Desk]", ...cp.verification_steps.map((s) => `- ${s}`));
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

  launch(body) {
    if (!object(body)) fail(400, "body must be an object");
    const task = this.get(body.task_id ?? body.id);
    this._coordinator(task);
    this._project(body, task);
    if (body.assignment_epoch !== undefined || body.epoch !== undefined) this._expected(body, task);
    const reqId = body.request_id !== undefined && body.request_id !== null && body.request_id !== "" ? identity(body.request_id, "request_id", true) : "";
    const adapterId = body.adapter !== undefined ? identity(body.adapter, "adapter", true) : (task.assignment?.adapter || "manual");
    if (task.launch?.status === "dispatched_dry_run"
      && task.launch.assignment_epoch === task.assignment.epoch
      && task.launch.adapter === adapterId
      && (task.launch.request_id || "") === reqId) {
      return { task: this.enrich(task), receipt: { ...clone(task.launch), duplicate: true } };
    }
    if (!this.desk.adapters) fail(501, "Adapter registry is not initialized");
    const todo = (this.desk.state.todos || []).find((t) => t.message_id === task.assignment_message_id) || null;
    const forwardTxt = this.desk._buildForwardText ? (todo ? this.desk._buildForwardText(todo) : (task.prompt || task.title)) : (todo?.message || task.prompt || task.title);
    const receipt = this.desk.adapters.launch(adapterId, {
      task,
      message: todo?.message || task.prompt || "",
      forward_text: forwardTxt,
      request_id: reqId,
    }, this.desk.config);
    if (!receipt.duplicate) {
      const before = clone(this.desk.state);
      try {
        task.launch = receipt;
        if (todo) {
          todo.launch_dispatched_at = receipt.dispatched_at;
          todo.launch_adapter = receipt.adapter;
          todo.updated = receipt.dispatched_at;
        }
        this._history(task, "launch_dry_run", { note: `Отправлено в адаптер ${receipt.adapter} (до фактического ACK)` }, task.state);
        this.desk.state.tasks = { ...this.desk.state.tasks, [task.task_id]: task };
        this.desk._saveState();
      } catch (e) {
        this.desk.state = before;
        throw e;
      }
      this.desk.emit("change");
    }
    return { task: this.enrich(task), receipt };
  }

  handoffPackage(id, auth = { local: true }) {
    const task = this.get(id);
    const enriched = this.enrich(task);
    const cp = clone(enriched.checkpoint || {});
    if (!auth?.local && cp.repo) delete cp.repo;
    const a = enriched.assignment || {};
    return safeOutput({
      schema: "agent-desk.handoff.v1",
      generated_at: now(),
      notice: "Human-readable handoff package. Verification commands are plain text for the executor; Agent Desk never executes shell commands.",
      task: {
        task_id: enriched.task_id,
        card_id: enriched.card_id || null,
        project: enriched.project,
        project_id: enriched.project_id,
        title: enriched.title,
        state: enriched.state,
        coordinator_device_id: enriched.coordinator_device_id,
        assignment_epoch: a.epoch,
        assignment_message_id: enriched.assignment_message_id || null,
        recipient: {
          agent: a.agent,
          device_id: a.device_id,
          session_id: a.session_id,
          role: a.role,
          adapter: a.adapter,
        },
      },
      prompt: enriched.prompt || "",
      checkpoint: cp,
      artifacts: enriched.artifacts || [],
      handback_template: {
        project: enriched.project,
        project_id: enriched.project_id,
        agent: a.agent || "<Agent>",
        session_id: a.session_id || "<session-id>",
        device_id: a.device_id || "<device-id>",
        task_id: enriched.task_id,
        assignment_epoch: a.epoch || 1,
        seq: 2,
        state: "done",
        execution_state: "submitted",
        to: "Владелец",
        task: enriched.title,
        message: "<Краткий итог для ведущего: что сделано, ветка/SHA, путь к отчёту, открытые пункты>",
        result: cp.report || (cp.out_dir ? `${cp.out_dir}/REPORT.md` : "OUT/REPORT.md"),
        checkpoint: {
          branch: cp.branch || "<branch>",
          commit: "<40-char-sha>",
          out_dir: cp.out_dir || "OUT",
          report: cp.report || "OUT/REPORT.md",
          next_step: "Проверить отчёт и подтвердить приёмку ведущим",
        },
        artifacts: (enriched.artifacts || []).length
          ? enriched.artifacts.map((art) => ({ path: art.path, sha256: art.sha256 || "<64-char-sha256>", status: "submitted" }))
          : [{ path: "OUT/REPORT.md", sha256: "<64-char-sha256>", status: "submitted" }],
      },
    });
  }
}

module.exports = { TaskService };
