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
    this.queue = []; // ids of reminders to send on their own (config.peer_auto)
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
      const r = await call(p.base, "GET", "/api/p2p/info", null, p.key, 4000);
      if (r.id !== p.id) throw new Error("по этому адресу теперь другой компьютер");
      const name = str(r.name, 60);
      if (name && name !== p.name) {
        p.name = name;
        renamed = true;
        this.desk._saveConfig();
      }
      s = { online: true, agents: cleanAgents(r.agents), error: "" };
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

  /** Send reminders to a paired desk; here they are closed with a note where they went. */
  async send(peerId, ids, auto = false) {
    const p = this.peer(peerId);
    if (!p) throw fail("этот компьютер не подключён");
    const todos = ids.map((id) => this.desk.state.todos.find((t) => t.id === id)).filter((t) => t && !t.done_at);
    if (!todos.length) throw fail("нечего отправлять: задача уже закрыта");
    const items = todos.map((t) => ({
      kind: t.kind, project: t.project, agent: t.agent, to: t.to, task: t.task, note: t.note, result: t.result,
      waiting_for: t.waiting_for, message: t.message, message_id: t.message_id, created: t.created,
    }));
    try {
      await call(p.base, "POST", "/api/p2p/inbox", { from: { id: this.config.device_id, name: this.name }, todos: items }, p.key);
    } catch (e) {
      this.status.set(p.id, { agents: {}, ...this.status.get(p.id), online: false, error: e.message, checked: nowIso() });
      this._changed();
      throw fail(`«${p.name}» не отвечает: ${e.message}`);
    }
    const now = nowIso();
    for (const t of todos) {
      t.sent_to = { id: p.id, name: p.name, at: now, auto };
      delete t.routing;
      t.updated = now;
      this.desk._close(t, now, auto);
    }
    this.desk._commit();
    return { sent: todos.length, name: p.name };
  }

  /** config.peer_auto: the one online paired desk where the addressee works, if it is unknown here. */
  routeFor(t) {
    if (!this.config.peer_auto || t.kind !== "forward" || !t.to) return null;
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
        delete t.routing; // it stays here: the owner forwards it himself
        t.send_error = e.message;
        this.desk._remind(t);
        this.desk._commit();
      }
    }
  }

  // --- HTTP ---

  _peerOf(req) {
    const given = String(req.headers["x-agent-desk-peer"] || "");
    return given ? this.config.peers.find((p) => safeEqual(given, p.my_key)) || null : null;
  }

  /** Requests of other desks (before the phone/UI key check of Desk._handle). */
  p2p(req, url, body) {
    const route = url.pathname.slice("/api/p2p/".length);
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
      return { body: { id: this.config.device_id, name: this.name, version: this.desk.version, agents: this.desk.agentDirectory() } };
    }
    if (req.method === "POST" && route === "inbox") {
      const items = Array.isArray(body.todos) ? body.todos.slice(0, MAX.items) : [];
      return { body: { ok: true, added: this.desk.receiveTodos(p, items) } };
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
        default:
          return { code: 404, body: { error: "not found" } };
      }
    } catch (e) {
      return { code: e.user ? 400 : 500, body: { error: e.message } };
    }
  }

  /** For the UI (no keys): this device, paired desks, desks nearby, open requests. */
  payload() {
    const c = this.config;
    return {
      id: c.device_id,
      name: this.name,
      lan: this.desk.lanEnabled,
      discovery: !!this.socket,
      auto: c.peer_auto,
      peers: c.peers.map((p) => {
        const s = this.status.get(p.id) || {};
        return { id: p.id, name: p.name, base: p.base, online: s.online ?? null, error: s.error || "", agents: s.agents || {}, checked: s.checked || null };
      }),
      nearby: [...this.nearby.values()].filter((n) => !this.peer(n.id)).map(({ id, name, ip, port }) => ({ id, name, ip, port })),
      requests: [...this.requests.values()].map(({ id, name, ip, code, time }) => ({ id, name, ip, code, time })),
      outgoing: [...this.outgoing.values()].map(({ id, name, base, code, time }) => ({ id, name, base, code, time })),
    };
  }
}

module.exports = { PeerLink, toBase, DISCOVERY_PORT };
