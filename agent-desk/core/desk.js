"use strict";
/**
 * Agent Desk core: watches marker folders, keeps agent statuses and reminders,
 * serves the UI and the HTTP API. Used by the desktop app (Electron) and by
 * `node core/cli.js` (server only). Plain Node.js, no dependencies.
 */
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const os = require("node:os");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

const VERSION = "1.0.0";
const PROTOCOL = 2;
const STATES = new Set(["working", "waiting", "done", "blocked", "idle"]);
const WAITING_FOR = new Set([
  "owner_input", "owner_forward", "reviewer", "coordinator_review", "resource", "model_limit", "assignment",
]);
const FORWARD_WAITS = new Set(["owner_forward", "coordinator_review", "reviewer"]);
const LIMITS = {
  events: 500, seen: 5000, alerts: 100, rejected: 50, closed: 150,
  eventMessage: 2000, body: 256 * 1024, payloadEvents: 150, watch: 20,
};
// Origins of the phone app WebView (Capacitor). They still need the key.
const APP_ORIGINS = new Set(["capacitor://localhost", "http://localhost", "https://localhost", "ionic://localhost"]);
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".wav": "audio/wav",
};
// Pictures, fonts and sounds may be reused by the page: with no-store every redraw downloaded the
// icons again and they blinked. The ETag still brings a changed file after an update.
const REUSABLE = new Set([".png", ".ico", ".svg", ".woff", ".woff2", ".ttf", ".wav"]);
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
  + "connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

class NotAMarker extends Error {}

const nowIso = () => new Date().toISOString();
const clean = (v, limit = 500) => (v === undefined || v === null ? "" : String(v).trim().slice(0, limit));
const oneLine = (v, limit) => clean(v, limit).replace(/\s+/g, " ");
/** Name comparison key: "Opus (3)", "opus 3" and "OPUS3" are the same agent. */
const compact = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const newKey = () => crypto.randomBytes(16).toString("hex");
const isStrongKey = (k) => typeof k === "string" && /^[0-9a-f]{32,128}$/.test(k);
const ts = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : 0;
};
const localDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const stamp = () => nowIso().replace(/[:.]/g, "-");

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write via a unique temp file + rename; retries while antivirus/indexer holds the target (Windows). */
function writeJsonAtomic(file, data, pretty = false) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, pretty ? 2 : 0), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  let error;
  for (let i = 0; i < 6; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      error = e;
      if (!["EPERM", "EBUSY", "EACCES"].includes(e.code)) break;
      sleepSync(40 * (i + 1));
    }
  }
  try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  throw error;
}

/**
 * Read a JSON object. A damaged file is never silently replaced: it is renamed to
 * `<name>.corrupt-<time>` (when quarantine is on) and a warning is shown in the UI.
 */
function loadJson(file, warnings, label, quarantine = true) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    throw new Error("ожидался JSON-объект");
  } catch (e) {
    let kept = "";
    if (quarantine) {
      const bad = `${file}.corrupt-${stamp()}`;
      try {
        fs.renameSync(file, bad);
        kept = `; файл сохранён как ${path.basename(bad)}`;
      } catch { /* leave it in place */ }
    }
    warnings.push({ time: nowIso(), level: "error", text: `${label} повреждён (${e.message})${kept}. Загружены значения по умолчанию.` });
    return null;
  }
}

function lanIps() {
  const rank = (ip) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === "IPv4" || a.family === 4) && !a.internal && !a.address.startsWith("169.254.")) ips.push(a.address);
    }
  }
  return [...new Set(ips)].sort((a, b) => rank(a) - rank(b));
}

// --- markers ----------------------------------------------------------------------

/** `ack` may be a string or a list; case, spaces and surrounding text do not matter. */
function parseAcks(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value];
  const out = new Set();
  for (const item of list.slice(0, 50)) {
    const s = String(item).trim().toUpperCase();
    if (!s) continue;
    if (s.length <= 80) out.add(s);
    for (const m of s.matchAll(/\bA[BD]-\d{1,9}\b/g)) out.add(m[0]);
  }
  return [...out].slice(0, 40);
}

function parseMarker(text, folderProject, now = Date.now()) {
  const data = JSON.parse(String(text).replace(/^\uFEFF/, ""));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("маркер должен быть JSON-объектом");
  // Other JSON files in the folder (package.json, settings…) are not touched.
  if (!("agent" in data) && !("state" in data)) throw new NotAMarker("not a marker");
  const n = Number(data.seq);
  const seq = data.seq === undefined || data.seq === null || data.seq === "" || !Number.isSafeInteger(n) ? null : n;
  const received = new Date(now).toISOString();
  const agentTime = clean(data.time, 40);
  const t = Date.parse(agentTime);
  // The agent's clock is only trusted when it is plausible; otherwise the time of receipt is used.
  const plausible = Number.isFinite(t) && t <= now + 5 * 60e3 && t >= now - 30 * 86400e3;
  const ev = {
    // The folder decides the project: an agent's cwd is not a reliable project identity.
    project: oneLine(folderProject || data.project, 60),
    agent: oneLine(data.agent, 60),
    state: clean(data.state, 20).toLowerCase(),
    waiting_for: clean(data.waiting_for, 40).toLowerCase(),
    phase: oneLine(data.phase, 60),
    task: oneLine(data.task, 500),
    to: oneLine(data.to, 60),
    from: oneLine(data.from, 60),
    note: clean(data.note, 1000),
    result: clean(data.result, 400),
    message: clean(data.message, 20000),
    ref: clean(data.message_id, 80),
    ack: parseAcks(data.ack),
    needs_forward: data.needs_forward === true,
    session: clean(data.session_id, 80),
    seq,
    event_id: clean(data.event_id, 120),
    agent_time: agentTime,
    time: plausible ? new Date(t).toISOString() : received,
    received,
  };
  if (!ev.project) throw new Error("не задан проект: укажите проект у папки («Файл → Папки с маркерами») или поле project");
  if (!ev.agent) throw new Error("поле agent обязательно");
  if (!STATES.has(ev.state)) throw new Error(`state должен быть одним из: ${[...STATES].join(", ")}`);
  if (ev.waiting_for && !WAITING_FOR.has(ev.waiting_for)) {
    throw new Error(`waiting_for должен быть одним из: ${[...WAITING_FOR].join(", ")}`);
  }
  return ev;
}

function forwardKind(ev) {
  if (!ev.to || ev.waiting_for === "assignment") return false;
  return ev.state === "done" || ev.needs_forward || FORWARD_WAITS.has(ev.waiting_for);
}

function todoKind(ev) {
  if (forwardKind(ev)) return "forward";
  if (ev.state === "blocked") return "blocked";
  if (ev.state === "waiting" && ev.waiting_for === "model_limit") return "limit";
  if (ev.state === "waiting" && (ev.waiting_for === "" || ev.waiting_for === "owner_input")) return "reply";
  return null;
}

function defaultMessage(ev) {
  const lines = [`${ev.agent} (${ev.project}): ${ev.task || "работа завершена"}`];
  if (ev.note) lines.push(ev.note);
  if (ev.result) lines.push(`Результат: ${ev.result}`);
  return lines.join("\n");
}

/** The text the owner pastes into the addressee's chat: sender header + message + message_id footer. */
function forwardText(t) {
  if (t.kind !== "forward") return t.message;
  const head = `[Agent Desk] от: ${t.agent} → ${t.to} · проект: ${t.project}${t.task ? ` · задача: ${t.task}` : ""}`;
  const update = t.supersedes ? `\n(обновлённая версия, заменяет ${t.supersedes})` : "";
  return `${head}${update}\n\n${t.message}\n\n[Agent Desk] message_id: ${t.message_id}. `
    + `Начав работу по этому сообщению, укажи в маркере "ack": "${t.message_id}".`;
}

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const fail = (status, message) => reject(Object.assign(new Error(message), { status }));
    if (Number(req.headers["content-length"] || 0) > limit) {
      fail(413, "слишком большой запрос");
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        fail(413, "слишком большой запрос");
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on("end", () => {
      let value;
      try {
        value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      } catch {
        fail(400, "bad json");
        return;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "тело должно быть JSON-объектом");
      else resolve(value);
    });
    req.on("error", reject);
  });
}

function nameMap(value, valueIsList) {
  // {project: [names]} or {project: {alias: name}}; "*" applies to every project.
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [project, v] of Object.entries(value).slice(0, 50)) {
    const p = oneLine(project, 60);
    if (!p) continue;
    if (valueIsList && Array.isArray(v)) out[p] = v.map((n) => oneLine(n, 60)).filter(Boolean).slice(0, 100);
    if (!valueIsList && v && typeof v === "object" && !Array.isArray(v)) {
      out[p] = Object.fromEntries(Object.entries(v).slice(0, 200).map(([a, n]) => [oneLine(a, 60), oneLine(n, 60)]).filter(([a, n]) => a && n));
    }
  }
  return out;
}

// --- desk -------------------------------------------------------------------------

const { PeerLink } = require("./peers.js"); // PC <-> laptop: reminders between desks of one Wi-Fi

const REMINDER_KINDS = new Set(["forward", "reply", "blocked", "limit"]);

// Win98 icon (web/icons/<name>.png, 32x32) of each alert kind: PC popup, phone notification.
const ALERT_ICON = {
  forward: "envelope_closed-0", reply: "msg_question-0", blocked: "msg_error-0", limit: "msg_warning-0",
  done: "check-0", bad: "msg_error-0", peer: "network_normal_two_pcs-0",
};

class Desk extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} [o.dataDir]   config.json, state.json (default: env AGENT_DESK_HOME or ~/AgentDesk)
   * @param {string} [o.webDir]    UI files to serve
   * @param {number} [o.port]      overrides config.port without saving it (0 = any free port)
   * @param {boolean} [o.lan]      overrides config.lan without saving it
   * @param {string|null} [o.legacyDir] Agent Board data to import on first run (default ~/AgentBoard, null = off)
   * @param {boolean} [o.discovery] find other Agent Desks of the Wi-Fi by UDP broadcast (the desktop app)
   */
  constructor(o = {}) {
    super();
    this.setMaxListeners(100); // each phone waiting on GET /api/alerts?wait listens for "alert"
    this._waiters = new Set();
    this.version = VERSION;
    this.dataDir = path.resolve(o.dataDir || process.env.AGENT_DESK_HOME || path.join(os.homedir(), "AgentDesk"));
    this.webDir = o.webDir ? path.resolve(o.webDir) : null;
    this.legacyDir = o.legacyDir === undefined ? path.join(os.homedir(), "AgentBoard") : o.legacyDir;
    this.log = o.log || ((...a) => console.error("[agent-desk]", ...a));
    this.pollMs = o.pollMs ?? 1500;
    this.graceMs = o.graceMs ?? 10000;
    this.configFile = path.join(this.dataDir, "config.json");
    this.stateFile = path.join(this.dataDir, "state.json");
    this.warnings = [];
    this.pending = new Map(); // unparsable file -> {sig, first}: waits for a slow writer before bad/
    this.ignored = new Map(); // non-marker JSON -> sig: left in place, not re-read
    this.dirty = false;
    this.timer = null;
    this.server = null;
    this.lastCleanup = 0;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this._load();
    this.port = o.port ?? this.config.port;
    this.lanOverride = o.lan;
    this.peers = new PeerLink(this, { discovery: o.discovery });
  }

  _load() {
    const firstRun = !fs.existsSync(this.configFile) && !fs.existsSync(this.stateFile);
    const cfg = loadJson(this.configFile, this.warnings, "config.json") || {};
    const st = loadJson(this.stateFile, this.warnings, "state.json") || {};
    if (firstRun) this._importLegacy(cfg, st);
    this.config = {
      port: 8098, lan: true, notify: true, popup_sound: true, popup_volume: 80, stale_minutes: 90, autostart: true,
      retention_days: 0, watch: [{ path: path.join(this.dataDir, "markers"), project: "" }],
      agents: {}, aliases: {}, allowed_hosts: [],
      ...cfg,
    };
    const c = this.config;
    if (!isStrongKey(c.key)) c.key = newKey(); // old 48-bit Agent Board keys are replaced
    c.watch = (Array.isArray(c.watch) ? c.watch : [])
      .filter((w) => w && typeof w === "object" && clean(w.path))
      .map((w) => ({ path: clean(w.path, 400), project: oneLine(w.project, 60) }));
    c.agents = nameMap(c.agents, true);
    c.aliases = nameMap(c.aliases, false);
    c.allowed_hosts = (Array.isArray(c.allowed_hosts) ? c.allowed_hosts : []).map((h) => clean(h, 100).toLowerCase()).filter(Boolean);
    PeerLink.normalize(c); // device_id, device_name, peers (keys of each pair), peer_auto

    this.state = {
      agents: {}, todos: [], events: [], seen_ids: [], alerts: [], rejected: [], next_id: 1, alert_seq: 0,
      ...st,
    };
    const s = this.state;
    for (const k of ["todos", "events", "seen_ids", "alerts", "rejected"]) if (!Array.isArray(s[k])) s[k] = [];
    if (!s.agents || typeof s.agents !== "object") s.agents = {};
    for (const t of s.todos) {
      t.forwarded_at ??= null;
      t.acked_at ??= null;
      t.done_at ??= null;
      t.message ??= "";
      t.message_id ??= `AB-${t.id}`;
      t.updated ??= t.created;
    }
    const maxId = s.todos.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
    s.next_id = Math.max(Number(s.next_id) || 1, maxId + 1);
    s.alert_seq = Number(s.alert_seq) || 0;
    s.version = (Number(s.version) || 0) + 1;
    this.seen = new Set(s.seen_ids);
  }

  /** First run: take folders, agents and reminders from the Python Agent Board (read-only). */
  _importLegacy(cfg, st) {
    const dir = this.legacyDir;
    if (!dir || path.resolve(dir) === this.dataDir) return;
    const oldCfgFile = path.join(dir, "config.json");
    if (!fs.existsSync(oldCfgFile)) return;
    const ignore = [];
    const oldCfg = loadJson(oldCfgFile, ignore, "", false);
    const oldState = loadJson(path.join(dir, "state.json"), ignore, "", false);
    if (oldCfg) {
      for (const k of ["port", "lan", "notify", "popup_sound", "popup_volume", "stale_minutes", "watch"]) {
        if (k in oldCfg) cfg[k] = oldCfg[k];
      }
    }
    if (oldState) for (const k of ["agents", "todos", "events", "seen_ids", "next_id"]) if (k in oldState) st[k] = oldState[k];
    st.migrated_from = dir;
    this.warnings.push({
      time: nowIso(), level: "info",
      text: `Импортированы папки, агенты и напоминания из Agent Board (${dir}). Старую Agent Board больше не запускайте: `
        + "две доски на одних папках забирают маркеры друг у друга. Телефон нужно подключить заново (новый ключ).",
    });
  }

  // --- persistence ---

  _bump() {
    this.state.version += 1;
  }

  _saveConfig() {
    writeJsonAtomic(this.configFile, this.config, true);
  }

  _writeState() {
    this.state.seen_ids = [...this.seen].slice(-LIMITS.seen);
    writeJsonAtomic(this.stateFile, this.state);
  }

  _saveState() {
    this._bump();
    try {
      this._writeState();
      this.dirty = false;
    } catch (e) {
      this.dirty = true;
      throw e;
    }
  }

  /** Save after a UI action; a failed write is retried by the next scan. */
  _commit() {
    try {
      this._saveState();
    } catch (e) {
      this.log("state save failed:", e.message);
    }
    this.emit("change");
  }

  _remember(id) {
    this.seen.add(id);
    if (this.seen.size > LIMITS.seen) this.seen.delete(this.seen.values().next().value);
  }

  // --- agents ---

  knownAgents(project) {
    const names = [];
    const add = (n) => {
      if (n && !names.some((x) => compact(x) === compact(n))) names.push(n);
    };
    for (const n of this.config.agents[project] || []) add(n);
    for (const n of this.config.agents["*"] || []) add(n);
    for (const a of Object.values(this.state.agents)) if (a.project === project) add(a.agent);
    return names;
  }

  /** Map a name from a marker to the agent's canonical name (aliases, then known names). */
  canonical(project, raw) {
    const name = oneLine(raw, 60);
    if (!name) return "";
    const aliases = { ...(this.config.aliases["*"] || {}), ...(this.config.aliases[project] || {}) };
    const alias = Object.entries(aliases).find(([a]) => compact(a) === compact(name));
    if (alias) return alias[1];
    return this.knownAgents(project).find((n) => compact(n) === compact(name)) || name;
  }

  _sameAgent(a, b) {
    return compact(a) === compact(b);
  }

  // --- events ---

  /**
   * Something needs the owner. Always recorded: the PC shows a popup only when config.notify is on,
   * the phone asks GET /api/alerts on its own. `action` says what to do, in a few words.
   */
  _alert(kind, project, title, body, todoId, extra = {}) {
    const s = this.state;
    s.alert_seq += 1;
    const a = {
      id: s.alert_seq, kind, project, title: String(title).slice(0, 200), body: String(body || "").slice(0, 600),
      action: String(extra.action || "").slice(0, 200), agent: extra.agent || null, to: extra.to || null,
      icon: ALERT_ICON[kind] || "msg_information-0", todo: todoId ?? null, time: nowIso(),
    };
    s.alerts.push(a);
    if (s.alerts.length > LIMITS.alerts) s.alerts.splice(0, s.alerts.length - LIMITS.alerts);
    this.emit("alert", a);
  }

  _close(t, at, auto) {
    if (t.done_at) return;
    t.done_at = at;
    t.auto = auto;
    this.emit("todo-closed", t);
  }

  /** Popup and phone notification of a reminder: what happened and what to do. */
  _remind(t, { again = "", body, from = "" } = {}) {
    const who = `${t.agent} (${t.project})`;
    const text = {
      forward: [`${who}: переслать → ${t.to}${again}`, `Перешлите результат агенту ${t.to}`],
      reply: [`${who} ждёт вашего ответа`, `Ответьте агенту ${t.agent}: он ждёт вашего решения`],
      blocked: [`${who} заблокирован`, `Помогите агенту ${t.agent}: он не может продолжить`],
      limit: [`${who}: закончился лимит модели`, `Начните новую сессию или смените модель для ${t.agent}`],
    }[t.kind];
    if (!text) return;
    const title = from ? `С «${from}»: ${text[0]}` : text[0];
    this._alert(t.kind, t.project, title, body ?? (t.task || t.note), t.id, { agent: t.agent, to: t.to, action: text[1] });
  }

  /** {project: [agent names]} known here, "*" = agents of every project: other desks route by it. */
  agentDirectory() {
    const c = this.config;
    const projects = new Set([...Object.values(this.state.agents).map((a) => a.project), ...c.watch.map((w) => w.project), ...Object.keys(c.agents)]);
    projects.delete("*");
    projects.delete("");
    const out = Object.fromEntries([...projects].map((p) => [p, this.knownAgents(p)]));
    out["*"] = [...(c.agents["*"] || [])];
    return out;
  }

  /** Reminders sent by a paired desk (core/peers.js): new reminders here, with a note where from. */
  receiveTodos(peer, items) {
    const now = nowIso();
    let added = 0;
    for (const x of items) {
      if (!x || typeof x !== "object" || !REMINDER_KINDS.has(x.kind)) continue;
      const ref = oneLine(x.message_id, 40);
      const origin = `${peer.id}:${ref}`;
      if (ref && this.state.todos.some((t) => t.origin === origin && !t.done_at)) continue; // sent twice
      const project = oneLine(x.project, 60);
      const agent = this.canonical(project, oneLine(x.agent, 60));
      if (!agent) continue;
      const ev = {
        project, agent, to: x.to ? this.canonical(project, oneLine(x.to, 60)) : "", task: oneLine(x.task, 500),
        note: clean(x.note, 2000), result: clean(x.result, 2000), waiting_for: oneLine(x.waiting_for, 40), ref, received: now,
      };
      const t = this._newTodo(x.kind, ev, clean(x.message, 20000) || defaultMessage(ev), { origin, from_device: { id: peer.id, name: peer.name } });
      this._remind(t, { from: peer.name });
      added += 1;
    }
    if (added) {
      this._trimTodos();
      this._commit();
    }
    return added;
  }

  _acknowledge(ev) {
    for (const t of this.state.todos) {
      if (t.kind !== "forward" || t.acked_at) continue;
      // An explicit ack is unique (AD-n) and closes the reminder whoever sends it.
      const explicit = ev.ack.includes(String(t.message_id).toUpperCase());
      // Implicit ack: the addressee starts working on the same task after the owner forwarded it.
      const implicit = !ev.ack.length && ev.state === "working" && t.forwarded_at && !t.done_at && ev.task
        && ev.task === t.task && t.project === ev.project && this._sameAgent(t.to, ev.agent);
      if (!explicit && !implicit) continue;
      t.acked_at = ev.received;
      t.acked_by = ev.agent;
      t.forwarded_at ||= ev.received;
      this._close(t, ev.received, true);
    }
  }

  _newTodo(kind, ev, message, extra = {}) {
    const s = this.state;
    const id = s.next_id++;
    const t = {
      id, kind, project: ev.project, agent: ev.agent, to: ev.to, task: ev.task, note: ev.note, result: ev.result,
      waiting_for: ev.waiting_for, message, message_id: `AD-${id}`, ref: ev.ref, created: ev.received, updated: ev.received,
      forwarded_at: null, acked_at: null, done_at: null, auto: false, ...extra,
    };
    if (kind === "forward" && !this.knownAgents(ev.project).some((n) => this._sameAgent(n, ev.to))) {
      t.warning = `Адресат «${ev.to}» не знаком доске в проекте ${ev.project}: проверьте имя.`;
    }
    s.todos.push(t);
    return t;
  }

  applyEvent(ev) {
    const s = this.state;
    ev.agent = this.canonical(ev.project, ev.agent);
    if (ev.to) ev.to = this.canonical(ev.project, ev.to);
    if (ev.from) ev.from = this.canonical(ev.project, ev.from);
    const key = `${ev.project}/${ev.agent}`;
    const agent = s.agents[key] || { project: ev.project, agent: ev.agent, first_seen: ev.received };
    const stored = { ...ev, message: ev.message.slice(0, LIMITS.eventMessage) };
    s.events.push(stored);
    if (s.events.length > LIMITS.events) s.events.splice(0, s.events.length - LIMITS.events);

    this._acknowledge(ev);

    if (ev.session && ev.seq !== null && agent.session === ev.session && agent.seq !== null && agent.seq !== undefined && ev.seq <= agent.seq) {
      stored.stale = true; // an older marker of the same session arrived late
      return;
    }
    for (const k of ["state", "waiting_for", "phase", "task", "to", "from", "note", "result", "session", "seq"]) agent[k] = ev[k];
    agent.updated = ev.time;
    agent.received = ev.received;
    s.agents[key] = agent;

    if (ev.state !== "waiting" && ev.state !== "blocked") {
      for (const t of s.todos) {
        if (["reply", "blocked", "limit"].includes(t.kind) && !t.done_at && t.project === ev.project && this._sameAgent(t.agent, ev.agent)) {
          this._close(t, ev.received, true);
        }
      }
    }

    const kind = todoKind(ev);
    let todo = null;
    let alertTitle = null;
    if (kind) {
      const message = ev.message || defaultMessage(ev);
      const existing = s.todos.find((t) => !t.done_at && t.kind === kind && t.project === ev.project && this._sameAgent(t.agent, ev.agent)
        && (kind !== "forward" || (t.task === ev.task && this._sameAgent(t.to, ev.to))));
      if (existing && !(kind === "forward" && existing.forwarded_at)) {
        const changed = existing.message !== message;
        Object.assign(existing, { note: ev.note, result: ev.result, waiting_for: ev.waiting_for, message, updated: ev.received });
        if (ev.ref) existing.ref = ev.ref;
        todo = existing;
        if (changed) alertTitle = "updated";
      } else if (existing) {
        // Already forwarded: a changed result must reach the addressee again.
        if (existing.message !== message) {
          todo = this._newTodo(kind, ev, message, { supersedes: existing.message_id });
          existing.superseded_by = todo.message_id;
          this._close(existing, ev.received, true);
          alertTitle = "resubmitted";
        }
      } else {
        todo = this._newTodo(kind, ev, message);
        alertTitle = "new";
      }
    }

    const who = `${ev.agent} (${ev.project})`;
    if (todo && alertTitle) {
      // The addressee works on another desk of this Wi-Fi (config.peer_auto): it goes there, no popup here.
      const peer = alertTitle !== "updated" ? this.peers.routeFor(todo) : null;
      if (peer) this.peers.route(todo, peer);
      else this._remind(todo, { again: alertTitle === "resubmitted" ? " — обновлённый результат" : "", body: ev.task || ev.note });
    } else if (!kind && ev.state === "done") {
      this._alert("done", ev.project, `${who} закончил`, ev.task || ev.result, null, { agent: ev.agent, action: "Проверьте результат и дайте следующую задачу" });
    }
    this._trimTodos();
  }

  _trimTodos() {
    const s = this.state;
    const closed = s.todos.filter((t) => t.done_at);
    if (closed.length <= LIMITS.closed) return;
    const keep = new Set(closed.sort((a, b) => ts(b.done_at) - ts(a.done_at)).slice(0, LIMITS.closed));
    s.todos = s.todos.filter((t) => !t.done_at || keep.has(t));
  }

  _reject(file, folder, project, error) {
    const name = path.basename(file);
    let moved = "";
    try {
      moved = this._archive(file, folder, "bad");
      fs.writeFileSync(`${moved}.error.txt`, `${error}\n`, "utf8");
    } catch (e) {
      this.log("cannot move bad marker", file, e.message);
    }
    const s = this.state;
    s.rejected.push({ time: nowIso(), file: name, folder, project, error: String(error).slice(0, 300), moved_to: moved });
    if (s.rejected.length > LIMITS.rejected) s.rejected.splice(0, s.rejected.length - LIMITS.rejected);
    this.dirty = true;
    this._alert("bad", project || "", `Маркер отклонён: ${name}`, error, null, { action: "Исправьте маркер: файл не прошёл проверку" });
  }

  _archive(file, folder, sub) {
    const dir = path.join(folder, sub, localDate());
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(file);
    let target = path.join(dir, base);
    for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${path.parse(base).name}.${i}${path.extname(base)}`);
    fs.renameSync(file, target);
    return target;
  }

  // --- watcher ---

  /**
   * One pass over all watched folders. Order per marker: apply -> save state -> archive.
   * A crash between save and archive only causes a re-read, which the seen-id check skips.
   */
  scanOnce() {
    const toArchive = [];
    let changed = false;
    for (const w of this.config.watch) {
      let names;
      try {
        names = fs.readdirSync(w.path);
      } catch {
        continue; // folder offline (share not mounted): try again next round
      }
      const files = [];
      for (const n of names) {
        if (!n.toLowerCase().endsWith(".json")) continue;
        const f = path.join(w.path, n);
        let st;
        try {
          st = fs.statSync(f);
        } catch {
          continue;
        }
        if (st.isFile()) files.push({ f, st });
      }
      files.sort((a, b) => a.st.mtimeMs - b.st.mtimeMs || a.f.localeCompare(b.f));
      for (const { f, st } of files) {
        const sig = `${st.size}:${st.mtimeMs}`;
        if (this.ignored.get(f) === sig) continue;
        let raw;
        try {
          raw = fs.readFileSync(f, "utf8");
        } catch {
          continue; // still being written or locked
        }
        let ev;
        try {
          ev = parseMarker(raw, w.project);
        } catch (e) {
          if (e instanceof NotAMarker) {
            this.ignored.set(f, sig);
            continue;
          }
          const p = this.pending.get(f);
          if (!p || p.sig !== sig) {
            this.pending.set(f, { sig, first: Date.now() }); // grace counted from our first sight, not mtime
            continue;
          }
          if (Date.now() - p.first < this.graceMs) continue;
          this.pending.delete(f);
          this._reject(f, w.path, w.project, e.message);
          changed = true;
          continue;
        }
        this.pending.delete(f);
        const id = ev.event_id || `sha:${sha256(raw)}`;
        if (!this.seen.has(id)) {
          this._remember(id);
          this.applyEvent(ev);
          this.dirty = true;
          changed = true;
        }
        toArchive.push([f, w.path]);
      }
    }
    if (this.dirty) {
      try {
        this._saveState();
      } catch (e) {
        this.log("state save failed, markers stay in the inbox:", e.message);
        return changed;
      }
    }
    for (const [f, folder] of toArchive) {
      try {
        this._archive(f, folder, "processed");
      } catch (e) {
        if (e.code !== "ENOENT") this.log("cannot archive", f, e.message);
      }
    }
    if (changed) this.emit("change");
    return changed;
  }

  /** Optional: delete processed/ and bad/ day folders older than retention_days (0 = keep forever). */
  _cleanup() {
    const days = Number(this.config.retention_days) || 0;
    if (days <= 0 || Date.now() - this.lastCleanup < 3600e3) return;
    this.lastCleanup = Date.now();
    const limit = Date.now() - days * 86400e3;
    for (const w of this.config.watch) {
      for (const sub of ["processed", "bad"]) {
        let names = [];
        try {
          names = fs.readdirSync(path.join(w.path, sub));
        } catch {
          continue;
        }
        for (const n of names) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(n) || Date.parse(`${n}T23:59:59`) >= limit) continue;
          try {
            fs.rmSync(path.join(w.path, sub, n), { recursive: true, force: true });
          } catch (e) {
            this.log("cleanup failed", n, e.message);
          }
        }
      }
    }
  }

  _tick() {
    try {
      this.scanOnce();
      this._cleanup();
    } catch (e) {
      this.log("scan failed:", e.stack || e.message);
    }
  }

  // --- API payloads ---

  payload() {
    const s = this.state;
    const c = this.config;
    const projects = new Set([...Object.values(s.agents).map((a) => a.project), ...c.watch.map((w) => w.project).filter(Boolean)]);
    return {
      version: s.version,
      app: { name: "Agent Desk", version: VERSION, protocol: PROTOCOL },
      agents: s.agents,
      todos: s.todos.map((t) => ({ ...t, forward_text: forwardText(t) })),
      events: s.events.slice(-LIMITS.payloadEvents).map(({ message, ...e }) => e),
      rejected: s.rejected.slice(-20),
      alert_seq: s.alert_seq,
      alerts: s.alerts.slice(-10),
      warnings: this.warnings,
      known_agents: Object.fromEntries([...projects].map((p) => [p, this.knownAgents(p)])),
      config: {
        stale_minutes: c.stale_minutes, notify: c.notify, watch: c.watch, lan: c.lan, popup_sound: c.popup_sound,
        popup_volume: c.popup_volume, autostart: c.autostart, retention_days: c.retention_days, agents: c.agents, aliases: c.aliases,
      },
      server_time: nowIso(),
      host: os.hostname(),
      link: this.peers.payload(),
    };
  }

  pairing() {
    const key = this.config.key;
    const urls = lanIps().map((ip) => `http://${ip}:${this.boundPort}/?key=${key}`);
    return { url: urls[0] || `http://127.0.0.1:${this.boundPort}/?key=${key}`, urls, key, lan: this.lanEnabled, port: this.boundPort };
  }

  get lanEnabled() {
    return this.lanOverride ?? this.config.lan;
  }

  // --- HTTP ---

  _hostAllowed(hostname, port) {
    if (port !== this.boundPort) return false;
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const me = os.hostname().toLowerCase();
    if (["127.0.0.1", "localhost", "::1", me, `${me}.local`, `${me}.lan`].includes(h)) return true;
    if (this.config.allowed_hosts.includes(h)) return true;
    return this.lanEnabled && lanIps().includes(h);
  }

  /** Host header allow-list: blocks DNS rebinding (evil.example -> 127.0.0.1). */
  _hostHeaderOk(host) {
    const m = /^(\[[^\]]+\]|[^:\s]+)(?::(\d{1,5}))?$/.exec(String(host || ""));
    return !!m && this._hostAllowed(m[1], m[2] ? Number(m[2]) : 80);
  }

  _ownOrigin(origin) {
    try {
      const u = new URL(origin);
      return u.protocol === "http:" && this._hostAllowed(u.hostname, Number(u.port || 80));
    } catch {
      return false;
    }
  }

  _auth(req, url) {
    const remote = req.socket.remoteAddress || "";
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
    const origin = req.headers.origin;
    const crossSite = (origin && !this._ownOrigin(origin)) || req.headers["sec-fetch-site"] === "cross-site";
    const cookie = /(?:^|;\s*)ad_key=([0-9a-f]+)/.exec(req.headers.cookie || "");
    const given = req.headers["x-agent-desk-key"] || (cookie && cookie[1]) || url.searchParams.get("key") || "";
    const local = loopback && !crossSite;
    if (given && safeEqual(given, this.config.key)) return { ok: true, local };
    return { ok: local, local };
  }

  _cors(req) {
    const origin = req.headers.origin;
    return origin && APP_ORIGINS.has(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
  }

  _send(res, code, body, headers = {}) {
    const h = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...headers };
    if (body === null || body === undefined) {
      res.writeHead(code, h);
      res.end();
      return;
    }
    const data = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    h["Content-Type"] ??= typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8";
    h["Content-Length"] = data.length;
    res.writeHead(code, h);
    res.end(data);
  }

  _static(res, pathname, req) {
    if (!this.webDir) return this._send(res, 404, "not found");
    let rel;
    try {
      rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    } catch {
      return this._send(res, 400, "bad path");
    }
    const target = path.resolve(this.webDir, rel);
    if (!target.startsWith(this.webDir + path.sep)) return this._send(res, 404, "not found");
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      return this._send(res, 404, "not found");
    }
    if (!stat.isFile()) return this._send(res, 404, "not found");
    const ext = path.extname(target).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    const headers = { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (REUSABLE.has(ext)) {
      const etag = `W/"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
      Object.assign(headers, { "Cache-Control": "no-cache", ETag: etag });
      const known = String(req?.headers["if-none-match"] || "").split(",").map((s) => s.trim());
      if (known.includes(etag)) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
    }
    let data;
    try {
      data = fs.readFileSync(target);
    } catch {
      return this._send(res, 404, "not found");
    }
    headers["Content-Length"] = data.length;
    if (type.startsWith("text/html")) Object.assign(headers, { "Content-Security-Policy": CSP, "X-Frame-Options": "DENY" });
    res.writeHead(200, headers);
    res.end(data);
  }

  async _handle(req, res) {
    const url = new URL(req.url, "http://desk.invalid");
    if (!this._hostHeaderOk(req.headers.host)) return this._send(res, 403, { error: "host not allowed" });
    const cors = this._cors(req);
    if (req.method === "OPTIONS") {
      if (!cors["Access-Control-Allow-Origin"]) return this._send(res, 403, null);
      // Chromium / Android WebView (Private Network Access): the phone app may call the PC on the
      // home network only when the preflight explicitly allows it.
      const pna = req.headers["access-control-request-private-network"] === "true" ? { "Access-Control-Allow-Private-Network": "true" } : {};
      return this._send(res, 204, null, {
        ...cors, ...pna, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Max-Age": "600",
        "Access-Control-Allow-Headers": "content-type, x-agent-desk, x-agent-desk-key",
      });
    }
    if (url.pathname === "/api/ping") return this._send(res, 200, { app: "agent-desk", version: VERSION, protocol: PROTOCOL }, cors);
    if (url.pathname.startsWith("/api/p2p/")) return this._p2p(req, res, url); // another desk: own keys
    const auth = this._auth(req, url);
    if (!auth.ok) {
      if (url.pathname.startsWith("/api/")) return this._send(res, 403, { error: "нет доступа: нужен ключ из «Файл → Подключить телефон»" }, cors);
      return this._send(res, 403, "Нет доступа. Откройте ссылку из меню «Файл → Подключить телефон» в Agent Desk на ПК.");
    }
    if (req.method === "GET") {
      if (url.searchParams.has("key") && !url.pathname.startsWith("/api/")) {
        // Pairing link -> HttpOnly cookie, and the key disappears from the address bar.
        return this._send(res, 302, null, {
          Location: url.pathname,
          "Set-Cookie": `ad_key=${this.config.key}; Max-Age=31536000; Path=/; SameSite=Strict; HttpOnly`,
        });
      }
      if (url.pathname === "/api/state") {
        const since = Number(url.searchParams.get("since"));
        if (url.searchParams.has("since") && since === this.state.version) return this._send(res, 200, { unchanged: true, version: since }, cors);
        return this._send(res, 200, this.payload(), cors);
      }
      if (url.pathname === "/api/alert") {
        const a = this.state.alerts.find((x) => String(x.id) === url.searchParams.get("id"));
        return a ? this._send(res, 200, a, cors) : this._send(res, 404, { error: "not found" }, cors);
      }
      if (url.pathname === "/api/alerts") return this._waitAlerts(res, url, cors);
      if (url.pathname === "/api/pairing") {
        return auth.local ? this._send(res, 200, this.pairing(), cors) : this._send(res, 403, { error: "только на ПК" }, cors);
      }
      if (url.pathname.startsWith("/api/")) return this._send(res, 404, { error: "not found" }, cors);
      return this._static(res, url.pathname, req);
    }
    if (req.method !== "POST") return this._send(res, 405, { error: "method not allowed" }, cors);
    // CSRF: a form or no-cors fetch from a web page cannot send JSON with a custom header.
    if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) return this._send(res, 415, { error: "нужен Content-Type: application/json" }, cors);
    if (req.headers["x-agent-desk"] !== "1") return this._send(res, 403, { error: "нет заголовка X-Agent-Desk" }, cors);
    let body;
    try {
      body = await readJsonBody(req, LIMITS.body);
    } catch (e) {
      return this._send(res, e.status || 400, { error: e.message }, cors);
    }
    const r = url.pathname.startsWith("/api/peers/")
      ? await this.peers.local(url.pathname.slice("/api/peers/".length), body && typeof body === "object" ? body : {}, auth)
      : this._post(url.pathname, body, auth);
    return this._send(res, r.code || 200, r.body || { ok: true }, cors);
  }

  /** Requests of another Agent Desk of the Wi-Fi (core/peers.js): keys of the pair, no CORS. */
  async _p2p(req, res, url) {
    let body = {};
    if (req.method === "POST") {
      if (!/^application\/json\b/i.test(req.headers["content-type"] || "") || req.headers["x-agent-desk"] !== "1") {
        return this._send(res, 403, { error: "нужны Content-Type: application/json и X-Agent-Desk: 1" });
      }
      try {
        body = await readJsonBody(req, LIMITS.body);
      } catch (e) {
        return this._send(res, e.status || 400, { error: e.message });
      }
    } else if (req.method !== "GET") {
      return this._send(res, 405, { error: "method not allowed" });
    }
    const r = this.peers.p2p(req, url, body && typeof body === "object" && !Array.isArray(body) ? body : {});
    return this._send(res, r.code || 200, r.body || { ok: true });
  }

  /**
   * Alerts newer than ?after=N. With ?wait=S (at most 30) the request stays open until the next
   * alert: the phone's background service keeps one request open instead of polling. Without a
   * valid `after` (first call, or the PC's history was reset) the answer is just the current seq.
   */
  _waitAlerts(res, url, cors) {
    const s = this.state;
    const after = Number(url.searchParams.get("after"));
    const valid = url.searchParams.has("after") && Number.isInteger(after) && after >= 0 && after <= s.alert_seq;
    const answer = () => {
      if (res.writableEnded) return;
      this._send(res, 200, { seq: s.alert_seq, alerts: valid ? s.alerts.filter((a) => a.id > after).slice(-20) : [] }, cors);
    };
    const wait = Math.min(30, Math.max(0, Number(url.searchParams.get("wait")) || 0));
    if (!valid || after < s.alert_seq || !wait) return answer();
    let timer = null;
    const forget = () => {
      clearTimeout(timer);
      this.off("alert", onAlert);
      this._waiters.delete(finish);
    };
    const finish = () => { forget(); answer(); };
    const onAlert = () => setImmediate(finish); // alerts of one scan arrive together
    timer = setTimeout(finish, wait * 1000);
    this.on("alert", onAlert);
    this._waiters.add(finish);
    res.on("close", forget);
  }

  _post(pathname, body, auth) {
    const s = this.state;
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length === 4 && parts[0] === "api" && parts[1] === "todo") {
      const t = s.todos.find((x) => String(x.id) === parts[2]);
      if (!t) return { code: 404, body: { error: "not found" } };
      const now = nowIso();
      if (parts[3] === "forwarded") {
        t.forwarded_at ||= now;
      } else if (parts[3] === "done") {
        this._close(t, now, false);
      } else if (parts[3] === "undo") {
        Object.assign(t, { done_at: null, forwarded_at: null, acked_at: null, acked_by: null, sent_to: null, send_error: null });
      } else {
        return { code: 404, body: { error: "not found" } };
      }
      t.auto = false;
      t.updated = now;
      this._commit();
      return {};
    }
    switch (pathname) {
      case "/api/ui/show":
        this.emit("show", { todo: body.todo ?? null, project: body.project ?? null });
        return {};
      case "/api/agent/forget":
        delete s.agents[`${oneLine(body.project, 60)}/${oneLine(body.agent, 60)}`];
        this._commit();
        return {};
      case "/api/config":
        return this._updateConfig(body, auth);
      case "/api/pairing/rotate":
        if (!auth.local) return { code: 403, body: { error: "только на ПК" } };
        this.config.key = newKey();
        this._saveConfig();
        this._bump();
        return { body: this.pairing() };
      case "/api/rejected/clear":
        s.rejected = [];
        this._commit();
        return {};
      case "/api/warnings/dismiss":
        this.warnings = [];
        this._bump();
        this.emit("change");
        return {};
      default:
        return { code: 404, body: { error: "not found" } };
    }
  }

  _updateConfig(body, auth) {
    const c = this.config;
    const admin = ["watch", "lan", "agents", "aliases", "allowed_hosts", "retention_days"].filter((k) => k in body);
    if (admin.length && !auth.local) return { code: 403, body: { error: `эти настройки меняются только на ПК: ${admin.join(", ")}` } };
    let watch = null;
    if ("watch" in body) {
      if (!Array.isArray(body.watch)) return { code: 400, body: { error: "watch должен быть списком" } };
      const errors = [];
      watch = [];
      for (const w of body.watch.slice(0, LIMITS.watch)) {
        const p = clean(w && w.path, 400);
        if (!p) continue;
        let st = null;
        try {
          st = path.isAbsolute(p) ? fs.statSync(p) : null;
        } catch { /* missing */ }
        if (!path.isAbsolute(p)) errors.push(`нужен полный путь: ${p}`);
        else if (!st || !st.isDirectory()) errors.push(`папка не найдена: ${p}`);
        else watch.push({ path: p, project: oneLine(w.project, 60) });
      }
      if (errors.length) return { code: 400, body: { error: errors.join("; ") } };
    }
    for (const k of ["notify", "popup_sound", "autostart", "lan"]) if (typeof body[k] === "boolean") c[k] = body[k];
    const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    if (int(body.popup_volume, 0, 100)) c.popup_volume = body.popup_volume;
    if (int(body.stale_minutes, 1, 10080)) c.stale_minutes = body.stale_minutes;
    if (int(body.retention_days, 0, 3650)) c.retention_days = body.retention_days;
    if (watch) {
      c.watch = watch;
      this.ignored.clear();
      this.pending.clear();
    }
    if ("agents" in body) c.agents = nameMap(body.agents, true);
    if ("aliases" in body) c.aliases = nameMap(body.aliases, false);
    if (Array.isArray(body.allowed_hosts)) c.allowed_hosts = body.allowed_hosts.map((h) => clean(h, 100).toLowerCase()).filter(Boolean).slice(0, 20);
    this._saveConfig();
    this._bump();
    this.emit("config", c);
    this.emit("change");
    return { body: { ok: true, restart: typeof body.lan === "boolean" } };
  }

  // --- lifecycle ---

  _listen() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this._handle(req, res).catch((e) => {
          this.log("http error:", e.stack || e.message);
          try {
            this._send(res, 500, { error: "internal error" });
          } catch { /* connection gone */ }
        });
      });
      server.once("error", reject);
      server.listen(this.port, this.lanEnabled ? "0.0.0.0" : "127.0.0.1", () => {
        server.off("error", reject);
        server.on("error", (e) => this.log("server error:", e.message));
        this.server = server;
        this.boundPort = server.address().port;
        resolve();
      });
    });
  }

  /**
   * Bind the port first: a second copy fails here and never touches state or marker folders.
   * Rejects with code EADDRINUSE when the port is taken (old Agent Board, another Agent Desk).
   */
  async start() {
    await this._listen();
    const defaultInbox = path.join(this.dataDir, "markers");
    if (this.config.watch.some((w) => path.resolve(w.path) === defaultInbox)) fs.mkdirSync(defaultInbox, { recursive: true });
    this._saveConfig();
    this._saveState();
    this._tick();
    this.timer = setInterval(() => this._tick(), this.pollMs);
    this.peers.start();
    return this;
  }

  async stop() {
    this.peers.stop();
    clearInterval(this.timer);
    this.timer = null;
    if (this.dirty) {
      try {
        this._saveState();
      } catch (e) {
        this.log("final save failed:", e.message);
      }
    }
    for (const finish of [...this._waiters]) finish(); // answer waiting phones before closing
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => {
        server.close(() => resolve());
        setImmediate(() => server.closeAllConnections?.()); // after the answers above are written
      });
    }
  }
}

module.exports = {
  Desk, parseMarker, parseAcks, forwardText, forwardKind, todoKind, compact, writeJsonAtomic, NotAMarker,
  VERSION, PROTOCOL, STATES, WAITING_FOR,
};
