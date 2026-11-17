"use strict";
/**
 * Link between Agent Desks of one Wi-Fi network (a PC and a laptop). The desks find each other by a
 * UDP broadcast, pair once (the owner allows it on the other screen after comparing a code) and then
 * send reminders to each other: "переслать результат → Astra" goes to the desk where Astra works.
 *
 * Desk-to-desk API, a key per direction of a pair (the phone key is never used here):
 *   POST /api/p2p/hello   {id, name, port, key, code}  please pair; `key` = what you will show us
 *   POST /api/p2p/welcome {id, name, port, key, code}  the owner allowed it (X-Agent-Desk-Peer: key from hello)
 *   GET  /api/p2p/whoami?from=&nonce=                  proves a new address without sending a key
 *   GET  /api/p2p/info                                 name and agents of the desk (X-Agent-Desk-Peer)
 *   POST /api/p2p/inbox   {from, todos: [...]}         reminders for this desk (X-Agent-Desk-Peer)
 */
const http = require("node:http");
const dgram = require("node:dgram");
const os = require("node:os");
const crypto = require("node:crypto");
const { seal, unseal } = require("./sync.js");

const DISCOVERY_PORT = 8099;
const DEFAULT_PORT = 8098;
const ANNOUNCE_MS = 5000;
const NEARBY_TTL_MS = 17000;
const CHECK_MS = 30000;
const REQUEST_TTL_MS = 10 * 60e3;
const MAX = { peers: 10, requests: 5, items: 20 };

const nowIso = () => new Date().toISOString();
const str = (v, n) => (v === undefined || v === null ? "" : String(v)).replace(/\s+/g, " ").trim().slice(0, n);
const newKey = () => crypto.randomBytes(16).toString("hex");
const isKey = (k) => typeof k === "string" && /^[0-9a-f]{32}$/.test(k);
const isId = (v) => typeof v === "string" && /^[0-9a-f]{16}$/.test(v);
const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65536;
const compact = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest("hex");
const remoteIp = (req) => String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
const hostOf = (ip) => (ip.includes(":") ? `[${ip}]` : ip);
const knows = (agents, project, name) => [...(agents[project] || []), ...(agents["*"] || [])].some((n) => compact(n) === compact(name));

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** An error the owner should read as is (wrong address, not paired...). */
function fail(message) {
  return Object.assign(new Error(message), { user: true });
}

/** "192.168.1.20", "laptop:8098", "http://192.168.1.20:8098/" -> "http://192.168.1.20:8098" or null. */
function toBase(address) {
  const s = String(address || "").trim().replace(/^https?:\/\//i, "").replace(/[/?#].*$/, "");
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(s);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : DEFAULT_PORT;
  return validPort(port) ? `http://${m[1].toLowerCase()}:${port}` : null;
}

/** Broadcast address of every IPv4 network of this computer (255.255.255.255 alone often stays on one). */
function broadcastAddresses() {
  const out = new Set(["255.255.255.255"]);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (!(a.family === "IPv4" || a.family === 4) || a.internal || !a.netmask || a.address.startsWith("169.254.")) continue;
      const ip = a.address.split(".").map(Number);
      const mask = a.netmask.split(".").map(Number);
      out.add(ip.map((b, i) => (b | (~mask[i] & 255)) & 255).join("."));
    }
  }
  return [...out];
}

function cleanAgents(v) {
  const out = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [p, list] of Object.entries(v).slice(0, 100)) {
    if (Array.isArray(list)) out[str(p, 60)] = list.slice(0, 100).map((n) => str(n, 60)).filter(Boolean);
  }
  return out;
}

const NET_ERRORS = {
  ECONNREFUSED: "Agent Desk там не запущен или закрыт доступ из Wi-Fi",
  EHOSTUNREACH: "компьютер не в сети", ENETUNREACH: "нет сети", ETIMEDOUT: "нет ответа", ECONNRESET: "связь оборвалась",
  ENOTFOUND: "такой компьютер не найден", EAI_AGAIN: "такой компьютер не найден",
};

/** JSON request to another desk. Rejects with e.status for HTTP errors. */
function call(base, method, pathname, body, key, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const data = body === null || body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { "X-Agent-Desk": "1" };
    if (key) headers["X-Agent-Desk-Peer"] = key;
    if (data) Object.assign(headers, { "Content-Type": "application/json", "Content-Length": data.length });
    let req;
    try {
      req = http.request(new URL(pathname, base), { method, headers, timeout }, (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > 1e6) req.destroy(new Error("слишком длинный ответ"));
          else chunks.push(c);
        });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* not JSON */ }
          if (res.statusCode >= 200 && res.statusCode < 300 && json && typeof json === "object") return resolve(json);
          reject(Object.assign(new Error((json && json.error) || `ответ ${res.statusCode}`), { status: res.statusCode }));
        });
      });
    } catch (e) {
      reject(e);
      return;
    }
    req.on("timeout", () => req.destroy(Object.assign(new Error("нет ответа"), { code: "ETIMEDOUT" })));
    req.on("error", (e) => reject(NET_ERRORS[e.code] ? Object.assign(new Error(NET_ERRORS[e.code]), { code: e.code }) : e));
    req.end(data || undefined);
  });
}

class PeerLink {
  /**
   * @param {object} desk  the Desk (config, state, _alert, _commit, receiveTodos...)
   * @param {{discovery?: boolean}} o  discovery: UDP broadcast on port 8099 (the desktop app)
   */
  constructor(desk, o = {}) {
    this.desk = desk;
    this.discovery = !!o.discovery;
    this.nearby = new Map(); // id -> {id, name, ip, port, seen}: desks heard on the network
    this.requests = new Map(); // id -> {id, name, ip, base, key, code, time}: they ask to pair
    this.outgoing = new Map(); // key -> {key, code, base, id, name, time}: we asked them
    this.status = new Map(); // peer id -> {online, agents, error, checked}
    this.conflicts = new Map(); // peer id -> [{time, status, reason}]
    this.queue = desk.state.todos.filter(t => t.routing && !t.done_at).map(t => t.id); // recover pending auto-send after restart
    this.socket = null;
    this.timer = null;
    this.lastCheck = 0;
    this.busy = new Set();
  }

  /** Desk._load: this device, the paired desks, the auto-send switch. */
  static normalize(c) {
    if (!isId(c.device_id)) c.device_id = crypto.randomBytes(8).toString("hex");
    c.device_name = str(c.device_name, 60);
    c.peers = (Array.isArray(c.peers) ? c.peers : [])
      .filter((p) => p && isId(p.id) && isKey(p.key) && isKey(p.my_key) && /^http:\/\/[^/\s]+$/.test(String(p.base)))
      .slice(0, MAX.peers)
      .map((p) => ({ id: p.id, name: str(p.name, 60) || p.id, base: p.base, key: p.key, my_key: p.my_key }));
    c.peer_auto = c.peer_auto === true;
  }

  get config() { return this.desk.config; }

  get name() { return this.config.device_name || os.hostname(); }

  peer(id) { return this.config.peers.find((p) => p.id === id) || null; }

  _changed() {
    this.desk._bump();
    this.desk.emit("change");
  }

  /** A background job, one at a time per name; errors are only logged. */
  _bg(name, fn) {
    if (this.busy.has(name)) return;
    this.busy.add(name);
    Promise.resolve().then(fn).catch((e) => this.desk.log(`link ${name}:`, e.message)).finally(() => this.busy.delete(name));
  }

  // --- lifecycle, discovery ---

  start() {
    this.stop();
    if (this.discovery && this.desk.lanEnabled) this._listen();
    this.timer = setInterval(() => this._tick(), ANNOUNCE_MS);
    this._tick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.socket) {
      try { this.socket.close(); } catch { /* closed */ }
      this.socket = null;
    }
  }

  _listen() {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.on("error", (e) => {
      this.desk.log("discovery off:", e.message);
      try { sock.close(); } catch { /* closed */ }
      if (this.socket === sock) this.socket = null;
    });
    sock.on("message", (msg, rinfo) => this._heard(msg, rinfo));
    sock.bind(DISCOVERY_PORT, () => {
      try { sock.setBroadcast(true); } catch { /* some adapters */ }
      this.socket = sock;
      this._announce();
    });
  }

  _announce() {
    if (!this.socket) return;
    const msg = Buffer.from(JSON.stringify({ agentDesk: 1, id: this.config.device_id, name: this.name, port: this.desk.boundPort }));
    for (const addr of broadcastAddresses()) {
      try { this.socket.send(msg, DISCOVERY_PORT, addr, () => {}); } catch { /* adapter gone */ }
    }
  }

  _heard(msg, rinfo) {
    let m;
    try { m = JSON.parse(msg.toString("utf8", 0, 2000)); } catch { return; }
    if (!m || m.agentDesk !== 1 || !isId(m.id) || m.id === this.config.device_id || !validPort(m.port)) return;
    const name = str(m.name, 60) || rinfo.address;
    const old = this.nearby.get(m.id);
    this.nearby.set(m.id, { id: m.id, name, ip: rinfo.address, port: m.port, seen: Date.now() });
    const p = this.peer(m.id);
    const base = `http://${hostOf(rinfo.address)}:${m.port}`;
    if (p && p.base !== base) this._bg(`follow:${p.id}`, () => this.follow(p, base));
    if (!old || old.ip !== rinfo.address || old.name !== name || old.port !== m.port) this._changed();
  }

  /** A paired desk is heard at a new address (the router gave it another IP): move only with proof. */
  async follow(p, base) {
    const nonce = crypto.randomBytes(16).toString("hex");
    const r = await call(base, "GET", `/api/p2p/whoami?from=${this.config.device_id}&nonce=${nonce}`, null, null, 4000);
    if (r.id !== p.id || !safeEqual(String(r.proof || ""), hmac(p.my_key, `${nonce}|${new URL(base).host}`))) {
      throw new Error(`${base}: это не «${p.name}»`);
    }
    p.base = base;
    this.desk._saveConfig();
    await this.check(p);
  }

  _tick() {
    const now = Date.now();
    let changed = false;
    const expire = (map, ttl, at) => {
      for (const [k, v] of map) {
        if (now - at(v) > ttl) {
          map.delete(k);
          changed = true;
        }
      }
    };
    expire(this.nearby, NEARBY_TTL_MS, (n) => n.seen);
    expire(this.requests, REQUEST_TTL_MS, (r) => Date.parse(r.time));
    expire(this.outgoing, REQUEST_TTL_MS, (o) => Date.parse(o.time));
    if (changed) this._changed();
    this._announce();
    if (this.config.peers.length && now - this.lastCheck >= CHECK_MS) {
      this.lastCheck = now;
      this._bg("check", () => this.checkAll());
    }
    if (this.queue.length) this._bg("flush", () => this.flush());
    for (const p of this.config.peers) this._bg(`sync:${p.id}`, () => this.sync(p.id));
  }

  async checkAll() {
    for (const p of [...this.config.peers]) await this.check(p);
  }

  /** Is the paired desk on, and which agents work there (for "send to" and auto-send). */
  async check(p) {
    const before = this.status.get(p.id);
    let s;
    let renamed = false;
    try {
      const r = await this.secure(p, { action: "info" });
      if (r.id !== p.id) throw new Error("по этому адресу теперь другой компьютер");
      const name = str(r.name, 60);
      if (name && name !== p.name) {
        p.name = name;
        renamed = true;
        this.desk._saveConfig();
      }
      s = { ...before, online: true, agents: cleanAgents(r.agents), error: "", protocol: 3, mail: r.mail_status || null };
    } catch (e) {
      const error = e.status === 403 ? `«${p.name}» больше не знает этот компьютер: удалите его и подключите заново` : e.message;
      s = { online: false, agents: (before && before.agents) || {}, error };
    }
    s.checked = nowIso();
    this.status.set(p.id, s);
    const sig = (x) => JSON.stringify(x ? [x.online, x.agents, x.error] : null);
    if (renamed || sig(before) !== sig(s)) this._changed();
    return s;
  }

  // --- pairing ---

  /** Ask the desk at `address` to pair; its owner allows it there after comparing the code. */
  async connect(address) {
    const base = toBase(address);
    if (!base) throw fail("укажите адрес другого компьютера, например 192.168.1.20");
    const loopback = /^http:\/\/(127\.|localhost:|\[::1\])/.test(base);
    if (!loopback && !this.desk.lanEnabled) throw fail("сначала откройте доступ из Wi-Fi на этом компьютере: Файл → Подключить телефон → «Разрешить»");
    if (this.config.peers.length >= MAX.peers) throw fail(`можно подключить не больше ${MAX.peers} компьютеров`);
    const key = newKey();
    const code = String(crypto.randomInt(1000, 10000));
    const host = base.slice("http://".length);
    let r;
    try {
      r = await call(base, "POST", "/api/p2p/hello", { id: this.config.device_id, name: this.name, port: this.desk.boundPort, key, code });
    } catch (e) {
      if (e.status === 403 || e.status === 404) throw fail(`${host}: там старая версия Agent Desk — обновите её`);
      throw fail(`${host}: ${e.message}`);
    }
    if (!isId(r.id)) throw fail(`${host}: там отвечает не Agent Desk`);
    for (const [k, o] of this.outgoing) if (o.id === r.id) this.outgoing.delete(k);
    const name = str(r.name, 60) || host;
    this.outgoing.set(key, { key, code, base, id: r.id, name, time: nowIso() });
    this._changed();
    return { code, name };
  }

  _hello(req, b) {
    const ip = remoteIp(req);
    const port = Number(b.port);
    if (!isId(b.id) || !isKey(b.key) || !/^\d{4}$/.test(String(b.code)) || !validPort(port)) return { code: 400, body: { error: "неверный запрос" } };
    if (b.id === this.config.device_id) return { code: 400, body: { error: "это тот же самый компьютер" } };
    if (!this.requests.has(b.id) && this.requests.size >= MAX.requests) return { code: 429, body: { error: "слишком много запросов, попробуйте позже" } };
    const name = str(b.name, 60) || ip;
    const code = String(b.code);
    this.requests.set(b.id, { id: b.id, name, ip, base: `http://${hostOf(ip)}:${port}`, key: b.key, code, time: nowIso() });
    this.desk._alert("peer", "", `«${name}» хочет обмениваться задачами`, `Адрес ${ip}, код ${code}`, null, {
      action: `Разрешите в Agent Desk, если на «${name}» показан код ${code}`,
    });
    this.desk._commit();
    return { body: { id: this.config.device_id, name: this.name } };
  }

  /** The owner allowed the request here: give that desk our key, remember its key. */
  async accept(id) {
    const r = this.requests.get(id);
    if (!r) throw fail("запрос устарел: подключите компьютер заново");
    if (!this.peer(id) && this.config.peers.length >= MAX.peers) throw fail(`можно подключить не больше ${MAX.peers} компьютеров`);
    const myKey = newKey();
    try {
      await call(r.base, "POST", "/api/p2p/welcome", { id: this.config.device_id, name: this.name, port: this.desk.boundPort, key: myKey, code: r.code }, r.key);
    } catch (e) {
      throw fail(`«${r.name}» не отвечает: ${e.message}`);
    }
    this.requests.delete(id);
    const p = this._keep({ id: r.id, name: r.name, base: r.base, key: r.key, my_key: myKey });
    this._bg(`check:${p.id}`, () => this.check(p));
    return { name: p.name };
  }

  _welcome(req, b) {
    const given = String(req.headers["x-agent-desk-peer"] || "");
    const o = given ? [...this.outgoing.values()].find((x) => safeEqual(given, x.key)) : null;
    const port = Number(b.port);
    if (!o || String(b.code) !== o.code || b.id !== o.id) return { code: 403, body: { error: "нет такого запроса" } };
    if (!isKey(b.key) || !validPort(port)) return { code: 400, body: { error: "неверный запрос" } };
    this.outgoing.delete(o.key);
    const p = this._keep({ id: o.id, name: str(b.name, 60) || o.name, base: `http://${hostOf(remoteIp(req))}:${port}`, key: b.key, my_key: o.key });
    this.desk._alert("peer", "", `«${p.name}» подключён`, "Теперь между компьютерами можно отправлять задачи", null, {
      action: "Выберите задачу и нажмите «Отправить»",
    });
    this.desk._commit();
    this._bg(`check:${p.id}`, () => this.check(p));
    return { body: { ok: true } };
  }

  _keep(p) {
    this.config.peers = [...this.config.peers.filter((x) => x.id !== p.id), p].slice(-MAX.peers);
    this.desk._saveConfig();
    this._changed();
    return p;
  }

  // --- reminders ---

  /** Send reminders with durable peer receipts; board delivery never completes the task. */
  async send(peerId, ids, auto = false) {
    const p = this.peer(peerId);
    if (!p) throw fail("этот компьютер не подключён");
    const todos = ids.map((id) => this.desk.state.todos.find((t) => t.id === id)).filter((t) => t && !t.done_at);
    if (!todos.length) throw fail("нечего отправлять: задача уже закрыта");
    try {
      this.desk._saveState();
      const events = todos.map(t => this.desk.sync.journal.events.findLast(ev => ev.type === "todo" && ev.entity_id === t.message_id)).filter(Boolean);
      const r = await this.secure(p, { action: "events", cursor: 0, events, mail_cursor: 0 });
      if (!Array.isArray(r.receipts) || events.some(ev => !r.receipts.includes(ev.id))) throw fail("получатель не подтвердил сохранение всех сообщений");
      this.desk.sync.receive(r.events || []);
    } catch (e) {
      this.status.set(p.id, { agents: {}, ...this.status.get(p.id), online: false, error: e.message, checked: nowIso() });
      this._changed();
      throw fail(`«${p.name}» не отвечает: ${e.message}`);
    }
    const now = nowIso();
    for (const original of todos) {
      const t = this.desk.state.todos.find(row => row.message_id === original.message_id);
      if (!t) continue;
      t.sent_to = { id: p.id, name: p.name, at: now, auto };
      t.delivery_target = p.id; t.delivered_at ||= now;
      delete t.routing;
      t.updated = now;
      // Board delivery is not an agent receipt or task completion.

    }
    this.desk._commit();
    return { sent: todos.length, name: p.name };
  }

  /** config.peer_auto: the one online paired desk where the addressee works, if it is unknown here. */
  routeFor(t) {
    if (!this.config.peer_auto || t.kind !== "forward" || !t.to) return null;
    const tasks = Object.values(this.desk.state.tasks || {});
    const current = this.desk.state.tasks?.[t.task_id];
    if (current?.assignment && compact(current.assignment.agent) === compact(t.to)) {
      return current.assignment.device_id === this.config.device_id ? null : this.peer(current.assignment.device_id);
    }
    const active = tasks.filter(task => task.project === t.project && task.state !== "accepted" && compact(task.assignment?.agent) === compact(t.to));
    const currentBindingIds = new Set(tasks.map(task => task.binding_id).filter(Boolean));
    const bindings = Object.values(this.desk.state.bindings || {}).filter(b => currentBindingIds.has(b.id) && b.project === t.project && compact(b.agent) === compact(t.to));
    const devices = [...new Set((active.length ? active.map(task => task.assignment.device_id) : bindings.map(b => b.device_id)).filter(Boolean))];
    if (devices.length > 1) { t.warning = "Адресат назначен на несколько устройств: выберите конкретную задачу/устройство."; return null; }
    if (devices.length === 1) return devices[0] === this.config.device_id ? null : this.peer(devices[0]);
    if (this.desk.knownAgents(t.project).some((n) => compact(n) === compact(t.to))) return null;
    const hits = this.config.peers.filter((p) => {
      const s = this.status.get(p.id);
      return s && s.online && knows(s.agents, t.project, t.to);
    });
    return hits.length === 1 ? hits[0] : null;
  }

  route(t, p) {
    t.routing = { id: p.id, name: p.name };
    delete t.warning; // the addressee is known there
    this.queue.push(t.id);
    setImmediate(() => this._bg("flush", () => this.flush()));
  }

  async flush() {
    while (this.queue.length) {
      const id = this.queue.shift();
      const t = this.desk.state.todos.find((x) => x.id === id);
      if (!t || t.done_at || !t.routing) continue;
      try {
        await this.send(t.routing.id, [t.id], true);
      } catch (e) {
        t.send_error = e.message;
        if (!this.queue.includes(t.id)) this.queue.push(t.id);
        this.desk._commit();
        break; // retry on the next tick, never spin while the peer is offline
      }
    }
  }

  async secure(p, payload) {
    const r = await call(p.base, "POST", "/api/p2p/sync", { from: this.config.device_id, packet: seal(payload, p.key) }, null, 8000);
    return unseal(r.packet, p.my_key);
  }

  async sync(peerId) {
    const p = this.peer(peerId);
    if (!p) throw fail("компьютер не подключён");
    try {
      if (this.desk.fileSyncEnabled) { this.desk.mail.scan(); this.desk._saveState(); }
      for (let batch = 0; batch < 50; batch++) {
        const j = this.desk.sync.journal;
        j.mail_cursors ??= {};
        j.sent_replay ??= {};
        j.cursors_replay ??= {};
        j.recoveries ??= {};
        const page = this.desk.sync.peerPage(j.sent[p.id] || 0, j.sent_replay[p.id] ?? null);
        const r = await this.secure(p, {
          action: "events",
          cursor: j.cursors[p.id] || 0,
          replay_offset: j.cursors_replay[p.id] ?? null,
          journal: j.peer_journals[p.id],
          events: page.events,
          mail_cursor: this.desk.fileSyncEnabled ? (j.mail_cursors[p.id] || 0) : 0,
        });
        if (!Array.isArray(r.receipts) || page.events.some(ev => !r.receipts.includes(ev.id))) throw fail("нет долговечной квитанции по всем событиям");
        this.desk.sync.receive(r.events || []);
        const current = this.desk.sync.journal;
        current.sent_replay ??= {};
        current.cursors_replay ??= {};
        current.recoveries ??= {};
        const reset = current.peer_journals[p.id] && current.peer_journals[p.id] !== r.journal;
        if (reset) {
          current.sent[p.id] = 0;
          delete current.sent_replay[p.id];
        } else if (page.replay && page.replay_offset !== null) {
          current.sent_replay[p.id] = page.replay_offset;
        } else {
          current.sent[p.id] = page.cursor;
          delete current.sent_replay[p.id];
        }
        if (r.replay && r.replay_offset !== null && r.replay_offset !== undefined) {
          current.cursors_replay[p.id] = r.replay_offset;
          current.recoveries[p.id] = { at: nowIso(), mode: "snapshot_replay_in_progress" };
        } else {
          current.cursors[p.id] = r.cursor;
          delete current.cursors_replay[p.id];
          if (r.replay || page.replay) current.recoveries[p.id] = { at: nowIso(), mode: "snapshot_replay_completed" };
        }
        current.peer_journals[p.id] = r.journal;
        current.mail_cursors ??= {}; current.mail_cursors[p.id] = this.desk.fileSyncEnabled ? (r.mail_cursor || 0) : 0;
        for (const ev of page.events) if (ev.type === "todo" && !ev.deleted) {
          const t = this.desk.state.todos.find(t => t.message_id === ev.entity_id);
          if (t && !t.delivered_at) t.delivered_at = nowIso();
        }
        this.desk._saveState();
        const now = nowIso();
        const old = this.status.get(p.id) || {};
        const compatReason = r.protocol && r.protocol < 3 ? "Узел использует старый протокол: обновите Agent Desk до актуальной версии" : "";
        this.status.set(p.id, { ...old, online: true, agents: cleanAgents(r.agents), error: "", compat_reason: compatReason, checked: now, synced: now, last_connected_at: now, protocol: r.protocol || 3, mail: r.mail_status || null });
        await this.syncMail(p, r.mail || []);
        if (!reset && !page.more && !r.more && (!this.desk.fileSyncEnabled || !r.mail_more)) break;
      }
      delete this.desk.sync.journal.errors[p.id]; this._changed();
      return { ok: true, synced: this.status.get(p.id)?.synced };
    } catch (e) {
      const isOldPeer = e.status === 404;
      const text = isOldPeer ? "для синхронизации карточек обновите AgentDesk на этом компьютере до 2.3.0" : e.message;
      this.desk.sync.journal.errors[p.id] = text;
      if (e.status === 409 || e.status === 403) this._recordConflict(p.id, e.status, text);
      const old = this.status.get(p.id) || {};
      this.status.set(p.id, {
        ...old,
        error: text,
        compat_reason: isOldPeer ? text : (old.compat_reason || ""),
        checked: nowIso(),
        online: e.status ? true : false,
      });
      this._changed(); throw e;
    }
  }

  _recordConflict(peerId, status, reason) {
    const row = { time: nowIso(), status: status || 409, reason: String(reason || "конфликт синхронизации").slice(0, 240) };
    const prev = this.conflicts.get(peerId) || [];
    this.conflicts.set(peerId, [...prev, row].slice(-10));
    if (this.desk.state?.sync) {
      this.desk.state.sync.conflicts ??= {};
      const persisted = Array.isArray(this.desk.state.sync.conflicts[peerId]) ? this.desk.state.sync.conflicts[peerId] : [];
      this.desk.state.sync.conflicts[peerId] = [...persisted, row].slice(-10);
    }
  }

  async syncMail(p, manifest) {
    if (!this.desk.fileSyncEnabled) return;
    if (!Array.isArray(manifest) || manifest.length > 100) throw fail("неверный список почты");
    const local = this.desk.mail.manifest();
    this.desk.sync.journal.mail_received ??= {};
    const roots = this.desk.mail.payload().roots || [];
    for (const item of manifest) {
      if (!this.desk.fileSyncEnabled) return;
      if (!roots.some(root => root.project === item.project)) {
        const incoming = this.desk.mail.ensureIncomingRoot(item.project, item);
        if (!incoming) continue;
        roots.push(incoming);
      }
      if (local.some(f => f.project === item.project && f.path === item.path && f.sha256 === item.sha256)) continue;
      const receivedKey = `${p.id}:${item.project}:${item.path}`;
      if (this.desk.sync.journal.mail_received[receivedKey] === item.sha256 && local.some(f => f.project === item.project && f.sha256 === item.sha256)) continue;
      let offset = 0;
      while (offset < item.size || offset === 0) {
        if (!this.desk.fileSyncEnabled) return;
        const r = await this.secure(p, { action: "mail-chunk", file: { project: item.project, path: item.path, sha256: item.sha256, offset } });
        if (!this.desk.fileSyncEnabled) return;
        const chunk = r.chunk;
        if (!chunk || chunk.offset !== offset || chunk.sha256 !== item.sha256 || chunk.total !== item.size) throw fail("неверный фрагмент почты");
        await this.desk.mail.acceptChunk(p, { ...item, ...chunk, previous_hash: item.previous_hash });
        const next = chunk.next ?? offset + Buffer.from(chunk.data || "", "base64").length;
        if (next <= offset && item.size > 0) throw fail("пустой фрагмент почты");
        offset = next; if (offset >= item.size) break;
      }
      this.desk.sync.journal.mail_received[receivedKey] = item.sha256;
      this.desk._saveState();
    }
  }

  secureReceive(body) {
    const p = this.peer(body.from);
    if (!p) throw Object.assign(fail("неизвестное устройство"), { status: 403 });
    const value = unseal(body.packet, p.my_key);
    let result;
    if (value.action === "info") {
      result = { id: this.config.device_id, name: this.name, agents: this.desk.agentDirectory(), protocol: 3, mail_status: this.desk.mailDiagnostics() };
    } else if (value.action === "events") {
      let receipts;
      try {
        receipts = this.desk.sync.receive(value.events || []);
      } catch (e) {
        if (e.status === 409 || e.status === 403) this._recordConflict(p.id, e.status, e.message);
        throw e;
      }
      const sameJournal = value.journal === this.desk.sync.journal.id;
      const page = this.desk.sync.peerPage(sameJournal ? (value.cursor || 0) : 0, sameJournal ? (value.replay_offset ?? null) : null);
      const all = this.desk.fileSyncEnabled ? this.desk.mail.manifest() : [];
      const start = Number.isSafeInteger(value.mail_cursor) && value.mail_cursor >= 0 && value.mail_cursor < all.length ? value.mail_cursor : 0;
      const mail = []; let mailBytes = 0;
      for (const item of all.slice(start, start + 100)) {
        const bytes = Buffer.byteLength(JSON.stringify(item));
        if (mail.length && mailBytes + bytes > 30000) break;
        mail.push(item); mailBytes += bytes;
      }
      const next = start + mail.length;
      result = { ...page, journal: this.desk.sync.journal.id, protocol: 3, receipts, mail, mail_cursor: next < all.length ? next : 0, mail_more: next < all.length,
        id: this.config.device_id, name: this.name, agents: this.desk.agentDirectory(), mail_status: this.desk.mailDiagnostics() };
      this.desk._saveState();
    } else if (value.action === "mail-chunk") {
      if (!this.desk.fileSyncEnabled) throw Object.assign(fail("синхронизация файлов отключена"), { status: 403 });
      result = { chunk: this.desk.mail.readChunk(value.file || {}) };
    } else throw Object.assign(fail("неизвестное действие синхронизации"), { status: 400 });
    return { body: { packet: seal(result, p.key) } };
  }

  // --- HTTP ---

  _peerOf(req) {
    const given = String(req.headers["x-agent-desk-peer"] || "");
    return given ? this.config.peers.find((p) => safeEqual(given, p.my_key)) || null : null;
  }

  /** Requests of other desks (before the phone/UI key check of Desk._handle). */
  p2p(req, url, body) {
    const route = url.pathname.slice("/api/p2p/".length);
    if (req.method === "POST" && route === "sync") return this.secureReceive(body);
    if (req.method === "POST" && route === "hello") return this._hello(req, body);
    if (req.method === "POST" && route === "welcome") return this._welcome(req, body);
    if (req.method === "GET" && route === "whoami") {
      const p = this.peer(url.searchParams.get("from") || "");
      const nonce = url.searchParams.get("nonce") || "";
      if (!p || !/^[0-9a-f]{32}$/.test(nonce)) return { code: 404, body: { error: "not found" } };
      return { body: { id: this.config.device_id, proof: hmac(p.key, `${nonce}|${req.headers.host}`) } };
    }
    const p = this._peerOf(req);
    if (!p) return { code: 403, body: { error: "этот компьютер не подключён" } };
    if (req.method === "GET" && route === "info") {
      return { body: { id: this.config.device_id, name: this.name, version: this.desk.version, protocol: 3, agents: this.desk.agentDirectory() } };
    }
    if (req.method === "POST" && route === "inbox") {
      const items = Array.isArray(body.todos) ? body.todos : [];
      const added = this.desk.receiveTodos(p, items);
      return { body: { ok: true, added, receipts: items.map(t => t.message_id) } };
    }
    return { code: 404, body: { error: "not found" } };
  }

  /** The UI of this desk: POST /api/peers/<action>. Pairing only on the PC itself, sending also from the phone. */
  async local(action, body, auth) {
    if (action !== "send" && !auth.local) return { code: 403, body: { error: "только на ПК" } };
    const id = String(body.id || "");
    try {
      switch (action) {
        case "connect":
          return { body: await this.connect(body.address) };
        case "accept":
          return { body: await this.accept(id) };
        case "reject":
          this.requests.delete(id);
          this._changed();
          return {};
        case "cancel":
          for (const [k, o] of this.outgoing) if (o.id === id) this.outgoing.delete(k);
          this._changed();
          return {};
        case "remove":
          this.config.peers = this.config.peers.filter((p) => p.id !== id);
          this.status.delete(id);
          this.desk._saveConfig();
          this._changed();
          return {};
        case "settings":
          if (typeof body.auto === "boolean") this.config.peer_auto = body.auto;
          if (typeof body.name === "string") this.config.device_name = str(body.name, 60);
          this.desk._saveConfig();
          this._changed();
          this._announce();
          return {};
        case "send": {
          const ids = (Array.isArray(body.todos) ? body.todos : []).map(Number).filter(Number.isInteger).slice(0, MAX.items);
          return { body: await this.send(String(body.peer || ""), ids) };
        }
        case "sync": {
          const targetId = String(body.id || body.peer || "");
          if (targetId) return { body: await this.sync(targetId) };
          const synced = [];
          for (const peer of this.config.peers) synced.push({ id: peer.id, ...(await this.sync(peer.id)) });
          return { body: { ok: true, peers: synced } };
        }
        default:
          return { code: 404, body: { error: "not found" } };
      }
    } catch (e) {
      return { code: e.status || (e.user ? 400 : 500), body: { error: e.message } };
    }
  }

  /** For the UI (no keys): this device, paired desks, desks nearby, open requests. */
  payload() {
    const c = this.config;
    const j = this.desk.state.sync || {};
    const totalSeq = (j.base_seq || 0) + (j.events?.length || 0);
    return {
      id: c.device_id,
      name: this.name,
      lan: this.desk.lanEnabled,
      discovery: !!this.socket,
      auto: c.peer_auto,
      sync: {
        enabled: true,
        protocol: 3,
        events: j.events?.length || 0,
        base_seq: j.base_seq || 0,
        baseline_entities: j.baseline?.length || 0,
        errors: j.errors || {},
        recoveries: j.recoveries || {},
      },
      peers: c.peers.map((p) => {
        const s = this.status.get(p.id) || {};
        const sent = Number.isSafeInteger(j.sent?.[p.id]) ? j.sent[p.id] : 0;
        const queuedTodos = this.queue.filter((todoId) => {
          const t = this.desk.state.todos?.find((row) => row.id === todoId);
          return t && !t.done_at && t.routing?.id === p.id;
        }).length;
        const pendingEvents = Math.max(0, totalSeq - sent) + queuedTodos;
        const memConflicts = this.conflicts.get(p.id) || [];
        const savedConflicts = Array.isArray(j.conflicts?.[p.id]) ? j.conflicts[p.id] : [];
        const mergedConflicts = [...savedConflicts, ...memConflicts.filter((m) => !savedConflicts.some((sv) => sv.time === m.time && sv.reason === m.reason))].slice(-5);
        return {
          id: p.id,
          name: p.name,
          base: p.base,
          online: s.online ?? null,
          error: s.error || "",
          compat_reason: s.compat_reason || "",
          agents: s.agents || {},
          checked: s.checked || null,
          synced: s.synced || null,
          last_connected_at: s.last_connected_at || s.synced || (s.online ? s.checked : null),
          pending_events: pendingEvents,
          conflicts: mergedConflicts,
          protocol: s.protocol || null,
          mail: s.mail || null,
        };
      }),
      nearby: [...this.nearby.values()].filter((n) => !this.peer(n.id)).map(({ id, name, ip, port }) => ({ id, name, ip, port })),
      requests: [...this.requests.values()].map(({ id, name, ip, code, time }) => ({ id, name, ip, code, time })),
      outgoing: [...this.outgoing.values()].map(({ id, name, base, code, time }) => ({ id, name, base, code, time })),
    };
  }
}

module.exports = { PeerLink, toBase, DISCOVERY_PORT };
