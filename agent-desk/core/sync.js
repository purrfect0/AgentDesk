"use strict";
const crypto = require("node:crypto");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE = /^[0-9a-f]{16}$/;
const TYPES = new Set(["todo", "agent", "task", "binding"]);
const clone = (x) => JSON.parse(JSON.stringify(x));
function stableId(text) {
  const b = crypto.createHash("sha256").update(String(text)).digest().subarray(0, 16);
  b[6] = (b[6] & 15) | 80; b[8] = (b[8] & 63) | 128;
  const h = b.toString("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = (x) => crypto.createHash("sha256").update(canonical(x)).digest("hex");
const version = (ev) => [ev.clock, ev.origin, ev.id];
function newer(a, b) {
  if (!b) return true;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function error(message, status = 400) { return Object.assign(new Error(message), { status }); }
function safeData(v, depth = 0) {
  if (depth > 20) throw error("событие синхронизации слишком вложено");
  if (!v || typeof v !== "object") return;
  for (const key of Object.keys(v)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw error("недопустимый ключ события");
    safeData(v[key], depth + 1);
  }
}
function seal(data, secret) {
  const key = crypto.createHash("sha256").update(`AgentDesk-sync-v3:${secret}`).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("AgentDesk-sync-v3"));
  const body = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return { v: 3, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: body.toString("base64") };
}
function unseal(packet, secret) {
  try {
    if (!packet || packet.v !== 3 || typeof packet.data !== "string" || packet.data.length > 340000) throw error("неверный пакет синхронизации");
    const iv = Buffer.from(packet.iv || "", "base64"), tag = Buffer.from(packet.tag || "", "base64");
    if (iv.length !== 12 || tag.length !== 16) throw error("неверный пакет синхронизации");
    const key = crypto.createHash("sha256").update(`AgentDesk-sync-v3:${secret}`).digest();
    const cipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("AgentDesk-sync-v3")); cipher.setAuthTag(tag);
    const raw = Buffer.concat([cipher.update(Buffer.from(packet.data, "base64")), cipher.final()]);
    const value = JSON.parse(raw.toString("utf8")); safeData(value); return value;
  } catch { throw error("пакет не прошёл проверку ключа/целостности", 403); }
}
class SyncJournal {
  constructor(desk) {
    this.desk = desk; this.importing = false;
    const s = desk.state;
    s.sync ??= {};
    const j = s.sync;
    j.id ??= crypto.randomUUID();
    j.clock = Number.isSafeInteger(j.clock) ? j.clock : 0;
    j.base_seq = Number.isSafeInteger(j.base_seq) && j.base_seq >= 0 ? j.base_seq : 0;
    j.baseline = Array.isArray(j.baseline) ? j.baseline : [];
    j.events = Array.isArray(j.events) ? j.events : [];
    for (const k of ["applied", "versions", "hashes", "cursors", "sent", "sent_replay", "errors", "peer_journals", "conflicts", "recoveries"]) j[k] ??= {};
    // The journal is deliberately not trimmed with the UI event log: replay/dedup survives closure.
    for (const ev of j.baseline) j.applied[ev.id] = digest(ev);
    for (const ev of j.events) j.applied[ev.id] = digest(ev);
    s.remote_agents ??= {}; s.tasks ??= {}; s.bindings ??= {};
  }
  get journal() { return this.desk.state.sync; }
  totalSeq() { return (this.journal.base_seq || 0) + this.journal.events.length; }
  entities() {
    const s = this.desk.state, out = new Map();
    for (const t of s.todos) {
      const { id, routing, warning, send_error, sent_to, from_device, forward_text, ...data } = t;
      out.set(`todo:${t.message_id}`, data);
    }
    for (const [k, a] of Object.entries(s.agents)) {
      const device_id = a.device_id || this.desk.config.device_id;
      out.set(`agent:${stableId(`${device_id}:${k}`)}`, { ...a, device_id });
    }
    for (const [k, a] of Object.entries(s.remote_agents || {})) out.set(`agent:${k}`, a);
    for (const [k, t] of Object.entries(s.tasks || {})) out.set(`task:${k}`, t);
    for (const [k, b] of Object.entries(s.bindings || {})) out.set(`binding:${k}`, b);
    return out;
  }
  capture() {
    if (this.importing) return;
    const j = this.journal, current = this.entities();
    for (const [key, value] of current) {
      const hash = digest(value);
      if (j.hashes[key] === hash) continue;
      const colon = key.indexOf(":"), type = key.slice(0, colon), entity_id = key.slice(colon + 1);
      if (!UUID.test(entity_id)) continue;
      const ev = { id: crypto.randomUUID(), origin: this.desk.config.device_id, clock: ++j.clock, type, entity_id, data: clone(value), deleted: false, time: new Date().toISOString() };
      j.events.push(ev); j.applied[ev.id] = digest(ev); j.versions[key] = version(ev); j.hashes[key] = hash;
    }
    for (const key of Object.keys(j.hashes)) {
      if (current.has(key)) continue;
      const colon = key.indexOf(":"), type = key.slice(0, colon), entity_id = key.slice(colon + 1);
      const ev = { id: crypto.randomUUID(), origin: this.desk.config.device_id, clock: ++j.clock, type, entity_id, data: null, deleted: true, time: new Date().toISOString() };
      j.events.push(ev); j.applied[ev.id] = digest(ev); j.versions[key] = version(ev); delete j.hashes[key];
    }
    if (j.events.length > 2000) this.compact(2000, 600);
  }
  compact(maxEvents = 1200, keepTail = 400) {
    const j = this.journal;
    j.base_seq ??= 0;
    j.baseline ??= [];
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || !Number.isSafeInteger(keepTail) || keepTail < 0) {
      throw error("неверные параметры сжатия журнала");
    }
    if (j.events.length <= maxEvents) {
      return { compacted: 0, base_seq: j.base_seq, baseline_entities: j.baseline.length, tail_events: j.events.length };
    }
    const cut = Math.max(0, j.events.length - keepTail);
    const dropped = j.events.slice(0, cut);
    j.events = j.events.slice(cut);
    j.base_seq += cut;
    const latestByEntity = new Map();
    for (const ev of [...j.baseline, ...dropped]) {
      const k = `${ev.type}:${ev.entity_id}`;
      latestByEntity.delete(k); // preserve chronological order of latest versions
      latestByEntity.set(k, ev);
    }
    j.baseline = [...latestByEntity.values()];
    const appliedKeys = Object.keys(j.applied);
    if (appliedKeys.length > 5000) {
      const pinnedIds = new Set([...j.baseline.map((e) => e.id), ...j.events.map((e) => e.id)]);
      const recent = appliedKeys.slice(-5000);
      const nextApplied = {};
      for (const id of pinnedIds) if (j.applied[id]) nextApplied[id] = j.applied[id];
      for (const id of recent) if (j.applied[id]) nextApplied[id] = j.applied[id];
      j.applied = nextApplied;
    }
    return { compacted: cut, base_seq: j.base_seq, baseline_entities: j.baseline.length, tail_events: j.events.length };
  }
  validate(ev) {
    if (!ev || !UUID.test(ev.id) || !DEVICE.test(ev.origin) || !UUID.test(ev.entity_id) || !TYPES.has(ev.type)
      || !Number.isSafeInteger(ev.clock) || ev.clock < 1 || typeof ev.deleted !== "boolean") throw error("неверное событие синхронизации");
    if (!ev.deleted && (!ev.data || typeof ev.data !== "object" || Array.isArray(ev.data))) throw error("нет данных события");
    if (Buffer.byteLength(JSON.stringify(ev)) > 60000) throw error("событие слишком большое", 413);
    safeData(ev);
    if (!ev.deleted && ev.type === "todo" && (ev.data.message_id !== ev.entity_id || !["forward", "reply", "blocked", "limit"].includes(ev.data.kind)
      || typeof ev.data.project !== "string" || !ev.data.project || typeof ev.data.agent !== "string" || !ev.data.agent)) throw error("неверное напоминание в синхронизации");
    if (!ev.deleted && ev.type === "task" && ev.data.task_id !== ev.entity_id) throw error("неверный ID задачи");
  }
  apply(ev) {
    const s = this.desk.state, key = `${ev.type}:${ev.entity_id}`, j = this.journal;
    const priorEntity = ev.type === "todo" ? s.todos.find(t => t.message_id === ev.entity_id) : ev.type === "task" ? s.tasks[ev.entity_id] : null;
    if (priorEntity && !ev.deleted && (priorEntity.project !== ev.data.project || (priorEntity.project_id && ev.data.project_id && priorEntity.project_id !== ev.data.project_id))) throw error("идентичность проекта не может измениться при синхронизации", 409);
    const sameMessage = ev.type === "todo" && !ev.deleted && priorEntity && ["message", "to", "task_id", "assignment_epoch", "recipient_session_id", "recipient_device_id"].every(field => priorEntity[field] === ev.data[field]);
    const higherReceipt = sameMessage && (ev.data.receipt_epoch || 0) > (priorEntity.receipt_epoch || 0);
    const higherAssignment = ev.type === "task" && !ev.deleted && priorEntity
      && (((ev.data.assignment?.epoch || 0) > (priorEntity.assignment?.epoch || 0))
        || ((ev.data.coordinator_epoch || 1) > (priorEntity.coordinator_epoch || 1)))
      && ev.origin === priorEntity.coordinator_device_id;
    if (!higherAssignment && !higherReceipt && !newer(version(ev), j.versions[key])) {
      // Concurrent delivery and ACK are independent monotonic facts, not competing status snapshots.
      if (ev.type === "todo" && !ev.deleted) {
        const old = s.todos.find(t => t.message_id === ev.entity_id), incoming = ev.data;
        if (old && sameMessage) {
          if (!old.acked_at && incoming.acked_at) Object.assign(old, { acked_at: incoming.acked_at, acked_by: incoming.acked_by, forwarded_at: old.forwarded_at || incoming.forwarded_at, done_at: incoming.done_at || incoming.acked_at });
          if (!old.delivered_at && incoming.delivered_at) old.delivered_at = incoming.delivered_at;
          if (!old.forwarded_at && incoming.forwarded_at) old.forwarded_at = incoming.forwarded_at;
          if (!old.done_at && incoming.done_at && (old.receipt_epoch || 0) === (incoming.receipt_epoch || 0)) old.done_at = incoming.done_at;
        }
      }
      return;
    }
    const data = ev.deleted ? null : clone(ev.data);
    if (ev.type === "todo") {
      const pos = s.todos.findIndex(t => t.message_id === ev.entity_id);
      if (!data) { if (pos >= 0) s.todos.splice(pos, 1); }
      else if (pos >= 0) {
        const old = s.todos[pos], sameReceipt = (data.receipt_epoch || 0) === (old.receipt_epoch || 0);
        if ((data.receipt_epoch || 0) < (old.receipt_epoch || 0)) {
          if (sameMessage) {
            if (!old.acked_at && data.acked_at) Object.assign(old, { acked_at: data.acked_at, acked_by: data.acked_by, done_at: data.done_at || data.acked_at });
            old.forwarded_at ||= data.forwarded_at;
            old.delivered_at ||= data.delivered_at;
          }
          return;
        }
        s.todos[pos] = { ...data, id: old.id, display_id: old.display_id,
          delivered_at: sameMessage ? old.delivered_at || data.delivered_at : data.delivered_at,
          ...(sameMessage && old.forwarded_at ? { forwarded_at: old.forwarded_at } : {}),
          ...(old.from_device && old.from_device.id !== this.desk.config.device_id ? { from_device: old.from_device } : {}),
          ...(sameMessage && sameReceipt && old.done_at ? { done_at: old.done_at } : {}),
          ...(sameMessage && old.acked_at ? { acked_at: old.acked_at, acked_by: old.acked_by, done_at: old.done_at || old.acked_at, forwarded_at: old.forwarded_at } : {}) };
      }
      else {
        const id = s.next_id++;
        const peer = this.desk.config.peers?.find(p => p.id === ev.origin);
        const fromDevice = ev.origin && ev.origin !== this.desk.config.device_id
          ? { id: ev.origin, name: peer?.name || "другой компьютер" }
          : undefined;
        s.todos.push({ ...data, id, display_id: `AD-${id}`, ...(fromDevice ? { from_device: fromDevice } : {}) });
      }
    } else if (ev.type === "agent") {
      if (!data) delete s.remote_agents[ev.entity_id];
      else if (data.device_id !== this.desk.config.device_id) s.remote_agents[ev.entity_id] = data;
      // Returning snapshots of this device do not overwrite its local watcher/session.
    } else {
      const map = ev.type === "task" ? s.tasks : s.bindings;
      if (ev.type === "task" && data && map[ev.entity_id]) {
        const prior = map[ev.entity_id];
        if (data.coordinator_device_id !== prior.coordinator_device_id) {
          const oldCoordEpoch = prior.coordinator_epoch || 1;
          const newCoordEpoch = data.coordinator_epoch || 1;
          if (ev.origin !== prior.coordinator_device_id || newCoordEpoch <= oldCoordEpoch) {
            throw error("координатор задачи не может измениться при синхронизации", 409);
          }
        }
        const effectiveCoordinator = prior.coordinator_device_id;
        const oldEpoch = prior.assignment?.epoch || 0, newEpoch = data.assignment?.epoch || 0;
        if (newEpoch < oldEpoch) return;
        if (newEpoch !== oldEpoch && ev.origin !== effectiveCoordinator) throw error("назначение меняет только координатор", 403);
        if (newEpoch === oldEpoch && canonical(prior.assignment) !== canonical(data.assignment)) throw error("конфликт назначений одной версии", 409);
        if (["accepted", "cancelled", "archived"].includes(data.state) && data.state !== prior.state && ev.origin !== effectiveCoordinator) {
          throw error("приёмку, отмену и архивацию подтверждает только координатор", 403);
        }
        if (["accepted", "cancelled", "archived"].includes(prior.state) && data.state !== prior.state && ev.origin !== effectiveCoordinator) return;
      }
      if (!data) delete map[ev.entity_id]; else map[ev.entity_id] = data;
    }
    j.versions[key] = version(ev);
  }
  receive(events) {
    if (!Array.isArray(events) || events.length > 20) throw error("слишком большая пачка синхронизации");
    for (const ev of events) this.validate(ev);
    const before = clone(this.desk.state);
    const receipts = [];
    this.capture(); // preserve pending local changes before importing remote versions
    this.importing = true;
    try {
      const j = this.journal;
      for (const ev of events) {
        receipts.push(ev.id);
        if (j.applied[ev.id]) {
          if (j.applied[ev.id] !== true && j.applied[ev.id] !== digest(ev)) throw error("повтор event_id с другими данными", 409);
          continue;
        }
        j.clock = Math.max(j.clock, ev.clock); this.apply(ev);
        j.events.push(clone(ev)); j.applied[ev.id] = digest(ev);
      }
      j.hashes = Object.fromEntries([...this.entities()].map(([key, value]) => [key, digest(value)]));
      this.desk._saveState(); // The receipt is never returned before fsync/atomic rename succeeds.
    } catch (e) { this.desk.state = before; throw e; }
    finally { this.importing = false; }
    if (events.length) {
      for (const t of this.desk.state.todos) {
        if (!t.done_at && !t.acked_at && (!t.delivery_target || t.delivery_target === this.desk.config.device_id) && !before.todos.some(old => old.message_id === t.message_id)) {
          const fromId = t.from_device?.id || t.origin_device_id;
          if (fromId === this.desk.config.device_id) continue;
          const peer = this.desk.config.peers?.find(p => p.id === fromId);
          const fromName = peer?.name || (t.from_device?.name && !/^[0-9a-f]{16}$/i.test(t.from_device.name) ? t.from_device.name : "другой компьютер");
          this.desk._remind?.(t, { from: fromName });
        }
      }
      this.desk.emit("change");
    }
    return receipts;
  }
  page(offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.journal.events.length) throw error("курсор синхронизации вне журнала", 409);
    const events = []; let bytes = 0;
    for (const ev of this.journal.events.slice(offset, offset + 20)) {
      const size = Buffer.byteLength(JSON.stringify(ev));
      if (events.length && bytes + size > 140000) break;
      if (size > 60000) throw error("локальное событие превышает лимит", 413);
      events.push(ev); bytes += size;
    }
    return { events, cursor: offset + events.length, more: offset + events.length < this.journal.events.length };
  }
  peerPage(cursor = 0, replayOffset = null) {
    const j = this.journal;
    const baseSeq = j.base_seq || 0;
    const total = baseSeq + j.events.length;
    const inRange = replayOffset === null
      && Number.isSafeInteger(cursor)
      && (cursor === 0 ? baseSeq === 0 : (cursor >= baseSeq && cursor <= total));
    if (inRange) {
      const localOffset = cursor - baseSeq;
      const p = this.page(localOffset);
      return { events: p.events, cursor: baseSeq + p.cursor, more: p.more, replay: false, replay_offset: null };
    }
    // Controlled snapshot/replay recovery when peer is new on a compacted journal or cursor fell outside range.
    const stream = [...(j.baseline || []), ...j.events];
    const start = Number.isSafeInteger(replayOffset) && replayOffset >= 0 && replayOffset <= stream.length ? replayOffset : 0;
    const events = []; let bytes = 0;
    for (const ev of stream.slice(start, start + 20)) {
      const size = Buffer.byteLength(JSON.stringify(ev));
      if (events.length && bytes + size > 140000) break;
      if (size > 60000) throw error("локальное событие превышает лимит", 413);
      events.push(ev); bytes += size;
    }
    const nextOffset = start + events.length;
    const done = nextOffset >= stream.length;
    return {
      events,
      cursor: done ? total : 0,
      more: !done,
      replay: true,
      replay_offset: done ? null : nextOffset,
    };
  }
}
module.exports = { SyncJournal, stableId, UUID, seal, unseal };
