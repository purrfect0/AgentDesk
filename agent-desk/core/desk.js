"use strict";
/**
 * Agent Desk core: watches marker folders, keeps agent statuses and reminders,
 * serves the UI and the HTTP API, including the installed CLI/MCP agent interface.
 * The core runs in the desktop app (Electron). Marker watching uses plain Node.js.
 */
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const os = require("node:os");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { SyncJournal, stableId, UUID } = require("./sync.js");
const { classifyRuntimeRejection, MARKER_TEMPLATES } = require("./marker-schema.js");
const { AdapterRegistry } = require("./adapters.js");

const VERSION = "2.3.4"; // the app version, the same as in package.json (a test checks it)
const PROTOCOL = 3;
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
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 2) {
      const bakTmp = `${file}.bak.${process.pid}.tmp`;
      fs.copyFileSync(file, bakTmp);
      fs.renameSync(bakTmp, `${file}.bak`);
    }
  } catch { /* best-effort backup before atomic swap */ }
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
 * `<name>.corrupt-<time>` (when quarantine is on), restored from `<name>.bak` if available,
 * and a warning is shown in the UI.
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
    const bak = `${file}.bak`;
    if (quarantine && fs.existsSync(bak)) {
      try {
        const bakVal = JSON.parse(fs.readFileSync(bak, "utf8").replace(/^\uFEFF/, ""));
        if (bakVal && typeof bakVal === "object" && !Array.isArray(bakVal)) {
          warnings.push({ time: nowIso(), level: "error", text: `${label} повреждён (${e.message})${kept}. Данные восстановлены из резервной копии ${path.basename(bak)}.` });
          return bakVal;
        }
      } catch { /* backup also unreadable: fall through to defaults */ }
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
  for (const [field, limit] of [["message", 20000], ["note", 1000], ["result", 400], ["task", 500]]) {
    if (data[field] !== undefined && data[field] !== null && (typeof data[field] !== "string" || data[field].length > limit)) {
      throw new Error(`${field}: максимум ${limit} символов; текст не принят, сократите его или передайте файл отдельно`);
    }
  }
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
    task_id: clean(data.task_id, 80),
    project_id: clean(data.project_id, 80),
    device_id: clean(data.device_id, 80),
    execution_state: clean(data.execution_state, 30),
    assignment_epoch: data.assignment_epoch,
    artifacts: data.artifacts,
    checkpoint: data.checkpoint,
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
  for (const field of ["task_id", "project_id"]) if (ev[field] && !UUID.test(ev[field])) throw new Error(`${field} должен быть UUID`);
  if (ev.execution_state && !["assigned", "working", "submitted", "accepted", "rework", "blocked", "cancelled", "archived"].includes(ev.execution_state)) throw new Error("неверное execution_state");
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
  const assignment = t.purpose === "assignment"
    ? `\n[Agent Desk] project_id: ${t.project_id}; task_id: ${t.task_id}; assignment_epoch: ${t.assignment_epoch}; session_id: ${t.recipient_session_id}; device_id: ${t.recipient_device_id}. Сохраняй эти поля в отчётах по заданию.`
    : (t.project_id && t.task_id ? `\n[Agent Desk] project_id: ${t.project_id}; task_id: ${t.task_id}.` : "");
  return `${head}${update}\n\n${t.message}${assignment}\n\n[Agent Desk] message_id: ${t.message_id}. `
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
    this.lastPhoneSeenAt = null;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this._load();
    this.port = o.port ?? this.config.port;
    this.lanOverride = o.lan;
    this.peers = new PeerLink(this, { discovery: o.discovery });
    this.sync = new SyncJournal(this);
    this.adapters = new AdapterRegistry();
    this._buildForwardText = forwardText;
    const { TaskService } = require("./tasks.js");
    const { MailStore } = require("./mail.js");
    this.tasks = new TaskService(this);
    // Conservative, in-memory-only migration: never infer that an old reminder was accepted.
    for (const t of this.state.todos) if (!t.task_id && t.task) {
      t.task_id = stableId(`legacy-task:${t.message_id}`);
      this.state.tasks[t.task_id] ??= {
        task_id: t.task_id, project_id: t.project_id, project: t.project, title: t.task,
        state: t.kind === "blocked" ? "blocked" : "assigned", coordinator_device_id: t.origin_device_id,
        assignment: { agent: t.to || t.agent, device_id: this.config.device_id, session_id: "", epoch: 1, role: "legacy", adapter: "manual" },
        checkpoint: { next_step: "Сверьте прежний отчёт и явно назначьте текущую сессию." }, artifacts: [], history: [],
        managed_assignment: false, created: t.created, updated: t.updated,
        launch: { status: "needs_manual_launch", adapter: "manual", reason: "Старая запись: устройство/сессию исполнителя нужно подтвердить." },
      };
    }
    this.mail = new MailStore(this);
    this._numberTaskCards();
    for (const task of Object.values(this.state.tasks)) {
      if (task.managed_assignment && task.state === "assigned" && task.coordinator_device_id === this.config.device_id
          && !task.assignment_message_id && !this.state.todos.some(t => t.task_id === task.task_id)) {
        try { this.tasks._assignmentMessage(task); }
        catch (error) { this.warnings.push({ time: nowIso(), level: "error", text: `${this.state.task_card_ids[task.task_id]}: не удалось подготовить промпт для пересылки. Откройте контекст задачи. ${error.message}` }); }
      }
    }
  }

  _load() {
    const firstRun = !fs.existsSync(this.configFile) && !fs.existsSync(this.stateFile);
    const cfg = loadJson(this.configFile, this.warnings, "config.json") || {};
    const st = loadJson(this.stateFile, this.warnings, "state.json") || {};
    if (firstRun) this._importLegacy(cfg, st);
    this.config = {
      port: 8098, lan: true, notify: true, popup_sound: true, popup_volume: 80, stale_minutes: 90, autostart: true,
      retention_days: 0, watch: [{ path: path.join(this.dataDir, "markers"), project: "" }],
      agents: {}, aliases: {}, agent_registry: {}, external_adapters_enabled: false, resource_status_files: {},
      allowed_hosts: [], file_sync_enabled: false,
      quiet_hours: { enabled: false, start: "23:00", end: "08:00" }, notify_projects: {},
      ...cfg,
    };
    const c = this.config;
    c.file_sync_enabled = c.file_sync_enabled === true;
    c.external_adapters_enabled = c.external_adapters_enabled === true;
    const hhmmRe = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    c.quiet_hours = {
      enabled: c.quiet_hours?.enabled === true,
      start: hhmmRe.test(String(c.quiet_hours?.start || "")) ? String(c.quiet_hours.start) : "23:00",
      end: hhmmRe.test(String(c.quiet_hours?.end || "")) ? String(c.quiet_hours.end) : "08:00",
    };
    c.notify_projects = c.notify_projects && typeof c.notify_projects === "object" && !Array.isArray(c.notify_projects)
      ? Object.fromEntries(Object.entries(c.notify_projects).slice(0, 60).map(([k, v]) => [oneLine(k, 60), v !== false]).filter(([k]) => k))
      : {};
    if (!isStrongKey(c.key)) c.key = newKey(); // old 48-bit Agent Board keys are replaced
    if (!isStrongKey(c.agent_key)) c.agent_key = newKey(); // separate loopback-only agent API credential
    c.watch = (Array.isArray(c.watch) ? c.watch : [])
      .filter((w) => w && typeof w === "object" && clean(w.path))
      .map((w) => ({ path: clean(w.path, 400), project: oneLine(w.project, 60) }));
    c.agents = nameMap(c.agents, true);
    c.aliases = nameMap(c.aliases, false);
    c.allowed_hosts = (Array.isArray(c.allowed_hosts) ? c.allowed_hosts : []).map((h) => clean(h, 100).toLowerCase()).filter(Boolean);
    PeerLink.normalize(c); // device_id, device_name, peers (keys of each pair), peer_auto
    c.agent_registry = this._normalizeRegistry(c.agent_registry, c.device_id);
    c.resource_status_files = c.resource_status_files && typeof c.resource_status_files === "object" && !Array.isArray(c.resource_status_files)
      ? Object.fromEntries(["phone", "server"].filter((k) => typeof c.resource_status_files[k] === "string" && path.isAbsolute(c.resource_status_files[k])).map((k) => [k, c.resource_status_files[k]]))
      : {};

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
      t.display_id ??= /^A[BD]-\d+$/i.test(t.message_id) ? t.message_id : `AD-${t.id}`;
      t.origin_device_id ??= this.config.device_id;
      if (!UUID.test(t.message_id)) {
        t.legacy_message_id = t.message_id;
        t.message_id = stableId(`legacy:${t.origin_device_id}:${t.message_id}`);
      }
      t.project_id ||= stableId(`project:${compact(t.project)}`);
      t.updated ??= t.created;
    }
    const maxId = s.todos.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
    s.next_id = Math.max(Number(s.next_id) || 1, maxId + 1);
    s.alert_seq = Number(s.alert_seq) || 0;
    s.version = (Number(s.version) || 0) + 1;
    this.seen = new Set(s.seen_ids);
    this._compactCache = null;
    this._entityVersions = new Map();
    this._removedEntities = [];
    this._minDeltaVersion = s.version;
    this._eventsSig = "";
    this._eventsVersion = s.version;
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

  _numberTaskCards() {
    const s = this.state;
    if (!s.task_card_ids || typeof s.task_card_ids !== "object" || Array.isArray(s.task_card_ids)) s.task_card_ids = {};
    const used = new Set(Object.values(s.task_card_ids).filter(v => typeof v === "string"));
    let next = Number.isSafeInteger(s.next_task_card_id) && s.next_task_card_id > 0 ? s.next_task_card_id : 1;
    for (const label of used) if (/^AT-\d+$/.test(label)) next = Math.max(next, Number(label.slice(3)) + 1);
    const tasks = Object.values(s.tasks || {}).sort((a, b) => String(a.created || "").localeCompare(String(b.created || "")) || a.task_id.localeCompare(b.task_id));
    for (const task of tasks) {
      if (s.task_card_ids[task.task_id]) continue;
      const rows = s.todos.filter(t => t.task_id === task.task_id && t.purpose !== "assignment").sort((a, b) => a.id - b.id);
      const linked = rows.map(t => t.display_id || `AD-${t.id}`).find(label => !used.has(label));
      let label = linked;
      if (!label) {
        while (used.has(`AT-${next}`)) next++;
        if (!Number.isSafeInteger(next)) throw new Error("исчерпан счётчик номеров задач");
        label = `AT-${next++}`;
      }
      s.task_card_ids[task.task_id] = label; used.add(label);
    }
    s.next_task_card_id = next;
  }

  _saveState() {
    this._numberTaskCards();
    this.sync?.capture();
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

  _normalizeRegistry(raw, fallbackDevice = "") {
    const out = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    for (const [projRaw, list] of Object.entries(raw).slice(0, 60)) {
      const proj = oneLine(projRaw, 60);
      if (!proj || !Array.isArray(list)) continue;
      const seen = new Set();
      const rows = [];
      for (const item of list.slice(0, 60)) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const name = oneLine(item.name || item.agent, 60);
        if (!name || seen.has(compact(name))) continue;
        seen.add(compact(name));
        const aliases = Array.isArray(item.aliases)
          ? [...new Set(item.aliases.map((a) => oneLine(a, 60)).filter((a) => a && compact(a) !== compact(name)))].slice(0, 20)
          : [];
        // Capabilities are ONLY what was explicitly declared or verified — NEVER guessed from provider/model name.
        const capabilities = Array.isArray(item.capabilities)
          ? [...new Set(item.capabilities.map((cap) => oneLine(cap, 40)).filter(Boolean))].slice(0, 16)
          : [];
        const verifiedChannel = ["cli_or_mcp", "marker_folder", "manual", ""].includes(item.verified_channel) ? item.verified_channel : "";
        const status = ["active", "paused", "archived"].includes(item.status) ? item.status : "active";
        const deviceId = clean(item.device_id, 64) || fallbackDevice;
        const sessionId = clean(item.session_id, 80);
        const role = ["executor", "reviewer", "coordinator"].includes(item.role) ? item.role : "executor";
        const adapter = clean(item.adapter, 40) || "manual";
        rows.push({
          name,
          aliases,
          capabilities,
          verified_channel: verifiedChannel,
          device_id: deviceId,
          status,
          session_id: sessionId,
          role,
          adapter,
        });
      }
      if (rows.length) out[proj] = rows;
    }
    return out;
  }

  _syncRegistrySideEffects(proj, rows) {
    this.config.agents[proj] ??= [];
    this.config.aliases[proj] ??= {};
    for (const r of rows) {
      if (!this.config.agents[proj].some((n) => compact(n) === compact(r.name))) this.config.agents[proj].push(r.name);
      for (const al of r.aliases) this.config.aliases[proj][al] = r.name;
      if (r.session_id && r.device_id && r.status === "active") {
        this.state.bindings ??= {};
        const existing = Object.values(this.state.bindings).find((b) => b.project === proj && this._sameAgent(b.agent, r.name) && b.device_id === r.device_id && b.role === r.role);
        const id = existing?.id || crypto.randomUUID();
        this.state.bindings[id] = {
          id,
          project: proj,
          agent: r.name,
          role: r.role,
          device_id: r.device_id,
          session_id: r.session_id,
          adapter: r.adapter,
        };
      }
    }
  }

  agentRegistryStatus(project, agent) {
    if (!project || !agent) return "active";
    const list = this.config.agent_registry?.[project] || [];
    const entry = list.find((r) => this._sameAgent(r.name, agent) || (r.aliases || []).some((al) => this._sameAgent(al, agent)));
    return entry?.status || "active";
  }

  updateAgentRegistry(body, auth) {
    if (!auth?.local) return { code: 403, body: { error: "реестр агентов настраивается только на ПК" } };
    if (!body || typeof body !== "object" || Array.isArray(body)) return { code: 400, body: { error: "нужен объект" } };
    const proj = oneLine(body.project, 60);
    if (!proj) return { code: 400, body: { error: "нужен project" } };
    const nextMap = { ...this.config.agent_registry };
    if (Array.isArray(body.entries)) {
      const norm = this._normalizeRegistry({ [proj]: body.entries }, this.config.device_id);
      if (norm[proj]?.length) {
        nextMap[proj] = norm[proj];
        this._syncRegistrySideEffects(proj, norm[proj]);
      } else {
        delete nextMap[proj];
      }
    } else if (body.entry && typeof body.entry === "object") {
      const cur = [...(nextMap[proj] || [])];
      const normSingle = this._normalizeRegistry({ [proj]: [body.entry] }, this.config.device_id)[proj]?.[0];
      if (!normSingle) return { code: 400, body: { error: "некорректная запись агента (нужно поле name)" } };
      const idx = cur.findIndex((r) => this._sameAgent(r.name, normSingle.name));
      if (idx >= 0) cur[idx] = { ...cur[idx], ...normSingle, verified_channel: normSingle.verified_channel || cur[idx].verified_channel || "" };
      else cur.push(normSingle);
      nextMap[proj] = cur;
      this._syncRegistrySideEffects(proj, cur);
    } else {
      return { code: 400, body: { error: "нужны entries или entry" } };
    }
    this.config.agent_registry = nextMap;
    this._saveConfig();
    this._saveState();
    this.emit("config", this.config);
    this.emit("change");
    return { body: { ok: true, project: proj, entries: nextMap[proj] || [] } };
  }

  rotateAgentSession(body, auth) {
    if (!auth?.local) return { code: 403, body: { error: "смена сессии выполняется только на ведущем ПК" } };
    const proj = oneLine(body?.project, 60);
    const rawAgent = oneLine(body?.agent, 60);
    if (!proj || !rawAgent) return { code: 400, body: { error: "нужны project и agent" } };
    const agent = this.canonical(proj, rawAgent);
    if (this.agentRegistryStatus(proj, agent) !== "active") {
      return { code: 409, body: { error: `агент «${agent}» на паузе или в архиве; активируйте его перед сменой сессии` } };
    }
    const newSession = clean(body?.new_session_id, 80) || `rot-${crypto.randomBytes(8).toString("hex")}`;
    const regList = [...(this.config.agent_registry?.[proj] || [])];
    const regIdx = regList.findIndex((r) => this._sameAgent(r.name, agent));
    const deviceId = clean(body?.device_id, 64) || regList[regIdx]?.device_id || this.config.device_id;
    const role = regList[regIdx]?.role || "executor";
    const adapter = regList[regIdx]?.adapter || "manual";
    if (regIdx >= 0) regList[regIdx] = { ...regList[regIdx], session_id: newSession, device_id: deviceId };
    else regList.push({ name: agent, aliases: [], capabilities: [], verified_channel: "", device_id: deviceId, status: "active", session_id: newSession, role, adapter });
    this.config.agent_registry = { ...this.config.agent_registry, [proj]: regList };
    this._syncRegistrySideEffects(proj, regList);

    // Close open model_limit reminders for this agent in this project
    const now = nowIso();
    for (const t of this.state.todos) {
      if (t.kind === "limit" && !t.done_at && t.project === proj && this._sameAgent(t.agent, agent)) {
        this._close(t, now, true);
        t.updated = now;
      }
    }

    // Handoff target task (or active task of this agent in project) to the new session
    let handedTask = null;
    const targetTaskId = body?.task_id ? this._resolveTaskId(body.task_id) : null;
    const candidate = targetTaskId
      ? this.state.tasks?.[String(targetTaskId).toLowerCase()]
      : Object.values(this.state.tasks || {}).find((t) => t.project === proj && this._sameAgent(t.assignment?.agent, agent) && ["assigned", "working", "blocked", "rework"].includes(t.state) && t.coordinator_device_id === this.config.device_id);
    if (candidate) {
      try {
        handedTask = this.tasks.handoff({
          task_id: candidate.task_id,
          project: candidate.project,
          project_id: candidate.project_id,
          assignment_epoch: candidate.assignment.epoch,
          agent,
          device_id: deviceId,
          session_id: newSession,
          role: candidate.assignment.role || role,
          adapter: candidate.assignment.adapter || adapter,
        });
      } catch (e) {
        return { code: e.status || 409, body: { error: e.message } };
      }
    }
    this._saveConfig();
    this._saveState();
    this.emit("config", this.config);
    this.emit("change");
    return { body: { ok: true, project: proj, agent, session_id: newSession, task: handedTask && this.tasks.enrich(handedTask) } };
  }

  resourceStatus() {
    const out = {};
    const nowMs = Date.now();
    const staleSec = (Number(this.config.stale_minutes) || 20) * 60;
    for (const kind of ["phone", "server"]) {
      const waitingAgents = Object.values(this.state.agents || {})
        .filter((a) => a.state === "waiting" && a.waiting_for === "resource" && (
          kind === "phone" ? /телефон|phone|adb|apk/i.test(`${a.task || ""} ${a.note || ""}`) : /сервер|server|gpu|build|стенд/i.test(`${a.task || ""} ${a.note || ""}`) || !/телефон|phone|adb|apk/i.test(`${a.task || ""} ${a.note || ""}`)
        ))
        .map((a) => ({
          project: a.project,
          agent: a.agent,
          task: a.task || "",
          age_sec: a.updated ? Math.max(0, Math.round((nowMs - Date.parse(a.updated)) / 1000)) : null,
        }));
      const file = this.config.resource_status_files?.[kind];
      if (file) {
        try {
          const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
          const updatedAt = parsed?.updated_at || parsed?.time || null;
          const freshnessSec = updatedAt && Number.isFinite(Date.parse(updatedAt))
            ? Math.max(0, Math.round((nowMs - Date.parse(updatedAt)) / 1000))
            : null;
          const holder = oneLine(parsed?.holder || parsed?.owner || "", 80) || null;
          out[kind] = {
            resource: kind,
            read_only: true,
            status: holder ? "BUSY" : "FREE",
            holder,
            note: oneLine(parsed?.note || parsed?.task || "", 160),
            source: "lease_file",
            freshness_sec: freshnessSec,
            stale: freshnessSec !== null ? freshnessSec > staleSec : null,
            waiting_agents: waitingAgents,
          };
          continue;
        } catch {
          out[kind] = {
            resource: kind,
            read_only: true,
            status: "UNKNOWN",
            holder: null,
            source: "lease_file_unavailable",
            freshness_sec: null,
            stale: null,
            waiting_agents: waitingAgents,
            reason: "Файл статуса ресурса недоступен или повреждён (только чтение).",
          };
          continue;
        }
      }
      if (kind === "phone" && this.lastPhoneSeenAt) {
        const ps = this.phoneStatus();
        const freshnessSec = Math.max(0, Math.round((nowMs - Date.parse(this.lastPhoneSeenAt)) / 1000));
        out.phone = {
          resource: "phone",
          read_only: true,
          status: ps.connected ? "ONLINE_NO_LEASE" : "UNKNOWN",
          holder: null,
          source: "phone_poller_telemetry",
          freshness_sec: freshnessSec,
          stale: !ps.connected,
          waiting_agents: waitingAgents,
          reason: ps.connected ? "Телефон на связи с Desk; внешняя бронь ADB не подключена." : "Телефон отключён; статус брони неизвестен (UNKNOWN).",
        };
      } else {
        out[kind] = {
          resource: kind,
          read_only: true,
          status: "UNKNOWN",
          holder: null,
          source: waitingAgents.length ? "agent_markers_only" : "unconfigured",
          freshness_sec: waitingAgents[0]?.age_sec ?? null,
          stale: null,
          waiting_agents: waitingAgents,
          reason: "Источник брони не настроен; отображение только для чтения (UNKNOWN).",
        };
      }
    }
    return out;
  }

  knownAgents(project) {
    const names = [];
    const add = (n) => {
      if (n && !names.some((x) => compact(x) === compact(n))) names.push(n);
    };
    for (const r of this.config.agent_registry?.[project] || []) if (r.status !== "archived") add(r.name);
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
  _inQuietHours(nowDate = new Date()) {
    const q = this.config.quiet_hours;
    if (!q || !q.enabled) return false;
    const toMins = (s) => { const [h, m] = String(s || "00:00").split(":").map(Number); return (h * 60) + m; };
    const start = toMins(q.start), end = toMins(q.end);
    const cur = nowDate.getHours() * 60 + nowDate.getMinutes();
    if (start === end) return true;
    return start < end ? (cur >= start && cur <= end) : (cur >= start || cur <= end);
  }

  _alert(kind, project, title, body, todoId, extra = {}) {
    const s = this.state;
    const normTitle = String(title).slice(0, 200);
    const normBody = String(body || "").slice(0, 600);
    if (todoId !== null && todoId !== undefined) {
      const openTodo = s.todos.find((t) => t.id === todoId && !t.done_at);
      const dup = s.alerts.findLast((prev) => prev.todo === todoId && prev.kind === kind && prev.title === normTitle && prev.body === normBody && prev.receipt_epoch === (openTodo?.receipt_epoch || 0));
      if (dup) return;
    }
    const projectMuted = Boolean(project && this.config.notify_projects?.[project] === false);
    const suppressed = Boolean(projectMuted || this._inQuietHours());
    const openTodo = todoId !== null && todoId !== undefined ? s.todos.find((t) => t.id === todoId) : null;
    s.alert_seq += 1;
    const a = {
      id: s.alert_seq, kind, project, title: normTitle, body: normBody,
      action: String(extra.action || "").slice(0, 200), agent: extra.agent || null, to: extra.to || null,
      icon: ALERT_ICON[kind] || "msg_information-0", todo: todoId ?? null, receipt_epoch: openTodo?.receipt_epoch || 0,
      suppressed, time: nowIso(),
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

  receiveTodos(peer, items) {
    if (!Array.isArray(items) || items.length > 20) throw Object.assign(new Error("неверная пачка напоминаний"), { status: 400 });
    const before = JSON.parse(JSON.stringify(this.state));
    const now = nowIso(), notices = [];
    let added = 0;
    this.state.imported_ids ??= {};
    try {
      for (const x of items) {
        if (!x || typeof x !== "object" || !REMINDER_KINDS.has(x.kind) || !x.project || !x.agent || !x.message_id) {
          throw Object.assign(new Error("напоминание должно содержать kind/project/agent/message_id"), { status: 400 });
        }
        const ref = oneLine(x.message_id, 80), origin = `${peer.id}:${ref}`;
        const sharedId = UUID.test(ref) ? ref.toLowerCase() : stableId(`legacy:${peer.id}:${ref}`);
        if (this.state.imported_ids[origin] || this.state.todos.some(t => t.message_id === sharedId || t.origin === origin)) continue;
        const project = oneLine(x.project, 60), agent = this.canonical(project, oneLine(x.agent, 60));
        const ev = { project, agent, to: x.to ? this.canonical(project, oneLine(x.to, 60)) : "", task: oneLine(x.task, 500),
          note: clean(x.note, 2000), result: clean(x.result, 2000), waiting_for: oneLine(x.waiting_for, 40), ref, received: now,
          task_id: UUID.test(x.task_id || "") ? x.task_id : "", project_id: UUID.test(x.project_id || "") ? x.project_id : stableId(`project:${compact(project)}`) };
        const t = this._newTodo(x.kind, ev, clean(x.message, 20000) || defaultMessage(ev), {
          message_id: sharedId, origin, origin_device_id: x.origin_device_id || peer.id,
          from_device: { id: peer.id, name: peer.name }, created: x.created || now,
        });
        this.state.imported_ids[origin] = sharedId; notices.push(t); added++;
      }
      this._saveState(); // Fail rather than acknowledging an in-memory-only import.
    } catch (e) { this.state = before; throw e; }
    for (const t of notices) this._remind(t, { from: peer.name });
    if (added) this.emit("change");
    return added;
  }

  _ackError(t, ev) {
    if (t.superseded_by) return "Сообщение заменено; получите текущую версию задания";
    const task = t.task_id && this.state.tasks?.[t.task_id];
    if (t.purpose === "assignment") {
      if (!task || t.assignment_epoch !== task.assignment.epoch) return "Назначение изменилось; получите текущую версию задания";
      if (t.recipient_device_id !== this.config.device_id) return "ACK нужно отправить с компьютера получателя";
      if (ev.assignment_epoch !== undefined && ev.assignment_epoch !== t.assignment_epoch) return "ACK относится к прежнему назначению";
    }
    const sameAssignee = task && this._sameAgent(t.to, task.assignment.agent);
    const session = t.recipient_session_id || (sameAssignee ? task.assignment.session_id : "");
    if (session && session !== ev.session) return "ACK из другой сессии получателя";
    return "";
  }

  _acknowledge(ev, explicitTaskId = ev.task_id) {
    let count = 0;
    for (const t of this.state.todos) {
      if (t.kind !== "forward" || t.acked_at || t.project !== ev.project || !this._sameAgent(t.to, ev.agent)) continue;
      if (this._ackError(t, ev)) continue;
      if (explicitTaskId && t.task_id && explicitTaskId !== t.task_id) continue;
      // Legacy display IDs are accepted only for unambiguous messages created on this desk.
      // Same title never implicitly ACKs or links tasks: only an explicit ack moves acked_at.
      const localLegacy = t.origin_device_id === this.config.device_id && !t.from_device
        && ev.ack.includes(String(t.legacy_message_id || t.display_id || "").toUpperCase());
      const explicit = ev.ack.includes(String(t.message_id).toUpperCase()) || localLegacy;
      if (!explicit) continue;
      t.acked_at = ev.received; t.acked_by = ev.agent; t.forwarded_at ||= ev.received;
      this._close(t, ev.received, true); count++;
    }
    return count;
  }

  _projectIdentity(project, taskId) {
    const task = taskId && this.state.tasks?.[taskId];
    if (task && task.project === project) return task.project_id;
    const ids = [...new Set(Object.values(this.state.tasks || {}).filter(t => t.project === project && UUID.test(t.project_id || "")).map(t => t.project_id))];
    if (ids.length > 1) throw Object.assign(new Error("неоднозначный проект: укажите project_id"), { status: 409 });
    return ids[0] || stableId(`project:${compact(project)}`);
  }

  _newTodo(kind, ev, message, extra = {}) {
    const s = this.state;
    const id = s.next_id++;
    const t = {
      id, kind, project: ev.project, agent: ev.agent, to: ev.to, task: ev.task, note: ev.note, result: ev.result,
      waiting_for: ev.waiting_for, message, message_id: crypto.randomUUID(), display_id: `AD-${id}`,
      task_id: ev.task_id || "", project_id: ev.project_id || stableId(`project:${compact(ev.project)}`), origin_device_id: this.config.device_id,
      ref: ev.ref, created: ev.received, updated: ev.received,
      forwarded_at: null, acked_at: null, done_at: null, receipt_epoch: 0, auto: false, ...extra,
    };
    if (kind === "forward" && !this.knownAgents(ev.project).some((n) => this._sameAgent(n, ev.to))) {
      t.warning = `Адресат «${ev.to}» не знаком доске в проекте ${ev.project}: проверьте имя.`;
    }
    s.todos.push(t);
    return t;
  }

  applyEvent(ev, channel = "marker_folder") {
    const s = this.state;
    ev.agent = this.canonical(ev.project, ev.agent);
    if (ev.to) ev.to = this.canonical(ev.project, ev.to);
    if (ev.from) ev.from = this.canonical(ev.project, ev.from);
    const key = `${ev.project}/${ev.agent}`;
    const agent = s.agents[key] || { project: ev.project, agent: ev.agent, first_seen: ev.received };
    const stored = { ...ev, message: ev.message.slice(0, LIMITS.eventMessage) };
    s.events.push(stored);
    if (s.events.length > LIMITS.events) s.events.splice(0, s.events.length - LIMITS.events);

    if (ev.session && ev.seq !== null && agent.session === ev.session && agent.seq !== null && agent.seq !== undefined && ev.seq <= agent.seq) {
      stored.stale = true; // an older marker cannot acknowledge a newer assignment
      return;
    }
    const explicitTaskId = ev.task_id;
    ev.device_id ||= this.config.device_id;
    ev.project_id ||= this._projectIdentity(ev.project, ev.task_id);
    const receiptOnly = ev.state === "idle" && ev.ack.length && !ev.execution_state && !ev.checkpoint && !ev.artifacts && !ev.task && !ev.to && !ev.message;
    const task = receiptOnly ? null : this.tasks?.observe(ev);
    if (task?.task_id) ev.task_id = task.task_id;
    this._acknowledge(ev, explicitTaskId);
    for (const k of ["state", "waiting_for", "phase", "task", "to", "from", "note", "result", "session", "seq"]) agent[k] = ev[k];
    agent.device_id = this.config.device_id;
    agent.task_id = ev.task_id;
    agent.verified_channel = channel;
    agent.updated = ev.time;
    agent.received = ev.received;
    s.agents[key] = agent;
    const regEntry = (this.config.agent_registry?.[ev.project] || []).find((r) => this._sameAgent(r.name, ev.agent));
    if (regEntry && !regEntry.verified_channel) regEntry.verified_channel = channel;

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
      if (existing && (kind !== "forward" || existing.message === message)) {
        const changed = existing.message !== message;
        Object.assign(existing, { note: ev.note, result: ev.result, waiting_for: ev.waiting_for, message, updated: ev.received });
        if (ev.ref) existing.ref = ev.ref;
        todo = existing;
        if (changed) alertTitle = "updated";
      } else if (existing) {
        // A copied prompt may already be in a chat even without a manual forwarding receipt.
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

    if (todo) {
      const envelope = { id: crypto.randomUUID(), origin: "x".repeat(128), clock: Number.MAX_SAFE_INTEGER, type: "todo", entity_id: todo.message_id, data: todo, deleted: false, time: ev.received };
      if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > 58000) throw Object.assign(new Error("Сообщение превышает лимит 58 000 байт; сократите текст или передайте файл отдельно (остальное место зарезервировано для квитанций)"), { status: 413 });
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
    const pinned = new Set();
    for (const task of Object.values(s.tasks || {})) {
      if (task && task.state !== "archived" && task.assignment_message_id) pinned.add(task.assignment_message_id);
    }
    for (const open of s.todos) {
      if (!open.done_at && open.supersedes) pinned.add(open.supersedes);
    }
    const trimmable = closed.filter((t) => !pinned.has(t.message_id));
    if (trimmable.length <= LIMITS.closed) return;
    const keep = new Set(trimmable.sort((a, b) => ts(b.done_at) - ts(a.done_at)).slice(0, LIMITS.closed));
    s.todos = s.todos.filter((t) => !t.done_at || pinned.has(t.message_id) || keep.has(t));
  }

  _reject(file, folder, project, error, rawText = "") {
    const name = path.basename(file);
    let moved = "";
    const diag = classifyRuntimeRejection(error, rawText, project, this.state.tasks);
    try {
      moved = this._archive(file, folder, "bad");
      fs.writeFileSync(`${moved}.error.txt`, `${error}\ncode: ${diag.code}\nfield: ${diag.field}\nexpected: ${(diag.expected || []).join(", ")}\nhint: ${diag.hint}\n`, "utf8");
    } catch (e) {
      this.log("cannot move bad marker", file, e.message);
    }
    const s = this.state;
    s.rejected.push({
      time: nowIso(),
      file: name,
      folder,
      project: diag.project || project || "",
      seq: diag.seq,
      code: diag.code,
      field: diag.field,
      expected: diag.expected,
      hint: diag.hint,
      retryable: diag.retryable,
      error: String(error).slice(0, 300),
      moved_to: moved,
    });
    if (s.rejected.length > LIMITS.rejected) s.rejected.splice(0, s.rejected.length - LIMITS.rejected);
    this.dirty = true;
    this._alert("bad", diag.project || project || "", `Маркер отклонён: ${name}`, `${error} (${diag.hint})`, null, { action: diag.hint || "Исправьте маркер: файл не прошёл проверку" });
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
          this._reject(f, w.path, w.project, e.message, raw);
          changed = true;
          continue;
        }
        this.pending.delete(f);
        const id = ev.event_id || `sha:${sha256(raw)}`;
        if (!this.seen.has(id)) {
          const before = JSON.parse(JSON.stringify(this.state));
          try { this.applyEvent(ev); this._remember(id); }
          catch (e) {
            this.state = before;
            this._reject(f, w.path, w.project, e.message, raw);
            changed = true; continue;
          }
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
      if (this.fileSyncEnabled && this.mail?.scan()) this._saveState();
      this._cleanup();
    } catch (e) {
      this.log("scan failed:", e.stack || e.message);
    }
  }

  // --- API payloads ---

  // Card/task events always synchronize. File replication is a separate, explicit owner choice.
  get fileSyncEnabled() {
    return this.config.file_sync_enabled === true
      && !(Array.isArray(this.config.mail_roots) && this.config.mail_roots.length === 0);
  }

  mailPayload(auth = { local: true }) {
    if (!this.fileSyncEnabled) return { enabled: false, mode: "disabled", roots: [], files: [], errors: [] };
    const raw = this.mail.payload();
    if (auth?.local) return { ...raw, enabled: true };
    return {
      ...raw,
      roots: (raw.roots || []).map((r) => ({ project: r.project })),
      errors: (raw.errors || []).map((e) => (typeof e === "object" && e ? { project: e.project, error: e.error || e.message || e.status } : e)),
      enabled: true,
    };
  }

  mailDiagnostics() {
    if (!this.fileSyncEnabled) return { enabled: false, mode: "disabled", projects: [], files: 0, errors: [] };
    return { ...this.mail.diagnostics(), enabled: true };
  }

  phoneStatus() {
    const connected = Boolean(this.lastPhoneSeenAt && Date.now() - Date.parse(this.lastPhoneSeenAt) < 90000);
    return {
      connected,
      waiting_pollers: this._waiters.size,
      last_seen_at: this.lastPhoneSeenAt,
    };
  }

  diagnosticsExport() {
    const s = this.state;
    const linkPayload = this.peers.payload();
    const queuedEvents = (linkPayload.peers || []).reduce((sum, p) => sum + (p.pending_events || 0), 0);
    const rejectedByCode = {};
    const rejectedByField = {};
    for (const r of s.rejected) {
      const c = r.code || "MARKER_REJECTED";
      const f = r.field || "marker";
      rejectedByCode[c] = (rejectedByCode[c] || 0) + 1;
      rejectedByField[f] = (rejectedByField[f] || 0) + 1;
    }
    const tasksByState = {};
    const tasksByOrigin = {};
    for (const t of Object.values(s.tasks || {})) {
      tasksByState[t.state] = (tasksByState[t.state] || 0) + 1;
      const orig = this.tasks.originKind(t);
      tasksByOrigin[orig] = (tasksByOrigin[orig] || 0) + 1;
    }
    return {
      generated_at: nowIso(),
      app: { name: "Agent Desk", version: VERSION, protocol: PROTOCOL },
      redacted: true,
      pipeline: {
        pending: this.pending.size,
        queued: queuedEvents,
        rejected: s.rejected.length,
        applied: s.events.length,
        acked: s.todos.filter((t) => t.acked_at).length,
      },
      rejected_by_code: rejectedByCode,
      rejected_by_field: rejectedByField,
      recent_rejections: s.rejected.slice(-20).map((r) => ({
        time: r.time,
        code: r.code || "MARKER_REJECTED",
        field: r.field || "marker",
        expected: r.expected || [],
        hint: r.hint || "",
        retryable: Boolean(r.retryable),
        seq: r.seq ?? null,
      })),
      tasks_by_state: tasksByState,
      tasks_by_origin: tasksByOrigin,
      todos_summary: {
        total: s.todos.length,
        open: s.todos.filter((t) => !t.done_at).length,
        forwarded: s.todos.filter((t) => t.forwarded_at).length,
        acked: s.todos.filter((t) => t.acked_at).length,
      },
      sync: {
        protocol: PROTOCOL,
        base_seq: s.sync?.base_seq || 0,
        baseline_entities: s.sync?.baseline?.length || 0,
        tail_events: s.sync?.events?.length || 0,
        paired_peers: (linkPayload.peers || []).length,
        online_peers: (linkPayload.peers || []).filter((p) => p.online).length,
      },
      phone_status: this.phoneStatus(),
      templates: Object.keys(MARKER_TEMPLATES),
    };
  }

  _scopeTask(enriched, auth = { local: true }) {
    if (!enriched || auth?.local) return enriched;
    const copy = structuredClone(enriched);
    if (copy.checkpoint && typeof copy.checkpoint === "object") {
      if (copy.checkpoint.repo) delete copy.checkpoint.repo;
      if (Array.isArray(copy.checkpoint.skills)) {
        copy.checkpoint.skills = copy.checkpoint.skills.map((s) => (
          s && typeof s === "object" && s.path && path.isAbsolute(s.path)
            ? { ...s, path: path.basename(s.path) }
            : s
        ));
      }
    }
    return copy;
  }

  _redactLocalPaths(txt) {
    let out = String(txt || "");
    const roots = [
      this.dataDir,
      ...(this.config.watch || []).map((w) => w?.path),
      ...(this.config.task_repo_roots || []).map((r) => (typeof r === "string" ? r : r?.path)),
      ...(this.config.task_skill_roots || []).map((r) => (typeof r === "string" ? r : r?.path)),
      ...(this.config.mail_roots || []).map((r) => r?.path),
    ].filter((p) => typeof p === "string" && p.length > 1).sort((a, b) => b.length - a.length);
    for (const r of roots) out = out.split(r).join("<локальный путь ПК>");
    out = out.replace(/[A-Za-z]:[\\/][^\s"'`)\]]+/g, "<локальный путь ПК>");
    out = out.replace(/(^|[\s("'`\[])\/(?:tmp|var|home|Users|root|opt|etc|mnt|srv|run|private)\/[^\s"'`)\]]+/g, "$1<локальный путь ПК>");
    return out;
  }

  _scopedContext(id, auth = { local: true }) {
    const res = this.tasks.context(this._resolveTaskId(id));
    if (auth?.local) return res;
    const scrub = (txt) => this._redactLocalPaths(txt);
    const checks = structuredClone(res.checks || {});
    if (Array.isArray(checks.skills)) {
      checks.skills = checks.skills.map((s) => ({
        ...s,
        path: s.path && path.isAbsolute(s.path) ? path.basename(s.path) : s.path,
      }));
    }
    return {
      text: scrub(res.text),
      task: this._scopeTask(res.task, auth),
      checks,
    };
  }

  _scopeTodo(todo, auth = { local: true }) {
    if (!todo || auth?.local) return todo;
    const copy = { ...todo };
    if (typeof copy.message === "string") copy.message = this._redactLocalPaths(copy.message);
    if (typeof copy.forward_text === "string") copy.forward_text = this._redactLocalPaths(copy.forward_text);
    if (typeof copy.message_preview === "string") copy.message_preview = this._redactLocalPaths(copy.message_preview);
    return copy;
  }

  _compactTodo(t) {
    const { message, ...rest } = t;
    const msg = String(message || "");
    return {
      ...rest,
      has_message: msg.length > 0,
      message_chars: msg.length,
      message_preview: msg.slice(0, 160),
    };
  }

  _compactTask(enriched) {
    const { prompt, history, ...rest } = enriched;
    const p = String(prompt || "");
    const hist = Array.isArray(history) ? history : [];
    return {
      ...rest,
      history: hist.slice(-6),
      history_count: hist.length,
      has_prompt: p.length > 0,
      prompt_chars: p.length,
      prompt_preview: p.slice(0, 160),
    };
  }

  _ensureCompactIndex() {
    const ver = this.state.version;
    if (this._compactCache && this._compactCache.version === ver) return this._compactCache;
    if (this._compactCache && ver < this._compactCache.version) {
      this._entityVersions.clear();
      this._removedEntities = [];
      this._minDeltaVersion = ver;
    }
    const tasksList = this.tasks.list().map((t) => this._compactTask(this.tasks.enrich(t)));
    const todosList = this.state.todos.map((t) => this._compactTodo(t));
    const seenKeys = new Set();
    for (const ct of tasksList) {
      const key = `task:${ct.task_id}`;
      seenKeys.add(key);
      const json = JSON.stringify(ct);
      const prev = this._entityVersions.get(key);
      if (!prev || prev.json !== json) this._entityVersions.set(key, { json, ver });
    }
    for (const cm of todosList) {
      const key = `todo:${cm.id}`;
      seenKeys.add(key);
      const json = JSON.stringify(cm);
      const prev = this._entityVersions.get(key);
      if (!prev || prev.json !== json) this._entityVersions.set(key, { json, ver });
    }
    for (const key of [...this._entityVersions.keys()]) {
      if (seenKeys.has(key)) continue;
      this._entityVersions.delete(key);
      const sep = key.indexOf(":");
      const kind = key.slice(0, sep);
      const rawId = key.slice(sep + 1);
      this._removedEntities.push({ kind, id: kind === "todo" ? Number(rawId) : rawId, ver });
    }
    if (this._removedEntities.length > 512) {
      const dropped = this._removedEntities.splice(0, this._removedEntities.length - 512);
      this._minDeltaVersion = Math.max(this._minDeltaVersion, dropped.at(-1).ver + 1);
    }
    const evSlice = this.state.events.slice(-LIMITS.payloadEvents).map(({ message, ...e }) => e);
    const evSig = `${this.state.events.length}:${evSlice.at(-1)?.event_id || evSlice.at(-1)?.time || ""}`;
    if (evSig !== this._eventsSig) {
      this._eventsSig = evSig;
      this._eventsVersion = ver;
    }
    this._compactCache = { version: ver, tasksList, todosList, evSlice };
    return this._compactCache;
  }

  _commonEnvelope(auth = { local: true }) {
    const localOwner = Boolean(auth?.local);
    const s = this.state;
    const c = this.config;
    const projects = new Set([...Object.values(s.agents).map((a) => a.project), ...c.watch.map((w) => w.project).filter(Boolean)]);
    const linkPayload = this.peers.payload(auth);
    const scrubWarn = (txt) => (localOwner ? txt : this._redactLocalPaths(txt));
    return {
      version: s.version,
      scope: localOwner ? "loopback_owner" : "lan_phone",
      verified_capabilities: {
        local_owner: localOwner,
        repo_roots_approved: localOwner && Array.isArray(c.task_repo_roots) && c.task_repo_roots.length > 0,
        skill_roots_approved: localOwner && Array.isArray(c.task_skill_roots) && c.task_skill_roots.length > 0,
        file_sync_enabled: this.fileSyncEnabled,
        agent_cli_loopback_only: true,
      },
      app: { name: "Agent Desk", version: VERSION, protocol: PROTOCOL },
      agents: { ...s.agents, ...Object.fromEntries(Object.entries(s.remote_agents || {}).map(([k, a]) => [`remote:${k}`, a])) },
      device_id: c.device_id,
      bindings: Object.values(s.bindings || {}),
      mail: this.mailPayload(auth),
      rejected: s.rejected.slice(-20).map(({ folder: _f, moved_to: _m, ...r }) => r),
      pipeline: {
        pending: this.pending.size,
        queued: (linkPayload.peers || []).reduce((sum, p) => sum + (p.pending_events || 0), 0),
        rejected: s.rejected.length,
        applied: s.events.length,
        acked: s.todos.filter((t) => t.acked_at).length,
      },
      phone_status: this.phoneStatus(),
      resources: this.resourceStatus(),
      adapters: this.adapters.probeAll(c),
      alert_seq: s.alert_seq,
      alerts: s.alerts.filter((a) => !a.suppressed).slice(-10),
      warnings: this.warnings.map((w) => ({ ...w, text: scrubWarn(w.text) })),
      known_agents: Object.fromEntries([...projects].map((p) => [p, this.knownAgents(p)])),
      config: {
        stale_minutes: c.stale_minutes, notify: c.notify, quiet_hours: c.quiet_hours, notify_projects: c.notify_projects,
        watch: localOwner ? c.watch : c.watch.map((w) => ({ project: w.project })),
        lan: c.lan, popup_sound: c.popup_sound,
        popup_volume: c.popup_volume, autostart: c.autostart, retention_days: c.retention_days,
        agents: c.agents, aliases: c.aliases, agent_registry: c.agent_registry || {},
        external_adapters_enabled: Boolean(c.external_adapters_enabled),
        task_repo_roots: localOwner ? (c.task_repo_roots || []) : [],
        task_skill_roots: localOwner ? (c.task_skill_roots || []) : [],
        file_sync_enabled: this.fileSyncEnabled,
      },
      server_time: nowIso(),
      host: localOwner ? os.hostname() : (c.device_name || "Agent Desk PC"),
      link: linkPayload,
    };
  }

  payload(auth = { local: true }) {
    const s = this.state;
    const base = this._commonEnvelope(auth);
    return {
      ...base,
      tasks: this.tasks.list().map((t) => this._scopeTask(this.tasks.enrich(t), auth)),
      todos: s.todos.map((t) => this._scopeTodo({ ...t, forward_text: forwardText(t) }, auth)),
      events: s.events.slice(-LIMITS.payloadEvents).map(({ message, ...e }) => e),
    };
  }

  compactPayload(auth = { local: true }, sinceVersion = null) {
    const idx = this._ensureCompactIndex();
    const base = this._commonEnvelope(auth);
    const canDelta = Number.isSafeInteger(sinceVersion)
      && sinceVersion >= this._minDeltaVersion
      && sinceVersion < idx.version
      && (idx.version - sinceVersion) <= 128;
    if (!canDelta) {
      return {
        ...base,
        compact: true,
        delta: false,
        tasks: idx.tasksList.map((t) => this._scopeTask(t, auth)),
        todos: auth?.local ? idx.todosList : idx.todosList.map((t) => this._scopeTodo(t, auth)),
        events: idx.evSlice,
      };
    }
    const eventsUnchanged = this._eventsVersion <= sinceVersion;
    return {
      ...base,
      compact: true,
      delta: true,
      base_version: sinceVersion,
      tasks_upsert: idx.tasksList
        .filter((t) => (this._entityVersions.get(`task:${t.task_id}`)?.ver ?? idx.version) > sinceVersion)
        .map((t) => this._scopeTask(t, auth)),
      tasks_remove: this._removedEntities.filter((r) => r.kind === "task" && r.ver > sinceVersion).map((r) => r.id),
      todos_upsert: idx.todosList
        .filter((t) => (this._entityVersions.get(`todo:${t.id}`)?.ver ?? idx.version) > sinceVersion)
        .map((t) => this._scopeTodo(t, auth)),
      todos_remove: this._removedEntities.filter((r) => r.kind === "todo" && r.ver > sinceVersion).map((r) => r.id),
      events_unchanged: eventsUnchanged,
      events: eventsUnchanged ? [] : idx.evSlice,
    };
  }

  itemPayload(url, auth = { local: true }) {
    const rawTodo = clean(url.searchParams.get("todo"), 128);
    const rawTask = clean(url.searchParams.get("task"), 128);
    let todo = null;
    if (rawTodo) {
      todo = this.state.todos.find((t) => (
        String(t.id) === rawTodo
        || t.message_id === rawTodo.toLowerCase()
        || String(t.display_id || "").toUpperCase() === rawTodo.toUpperCase()
      )) || null;
    }
    let taskObj = null;
    if (rawTask) {
      const resolved = this._resolveTaskId(rawTask);
      const key = typeof resolved === "string" ? resolved.toLowerCase() : resolved;
      taskObj = this.state.tasks?.[key] || this.state.tasks?.[resolved] || null;
    } else if (todo?.task_id) {
      taskObj = this.state.tasks?.[todo.task_id] || null;
    }
    if (!todo && !taskObj) return null;
    return {
      todo: todo ? this._scopeTodo({ ...todo, forward_text: forwardText(todo) }, auth) : null,
      task: taskObj ? this._scopeTask(this.tasks.enrich(taskObj), auth) : null,
    };
  }

  searchPayload(url) {
    const rawQ = String(url.searchParams.get("q") || "").trim().slice(0, 400);
    const projFilter = clean(url.searchParams.get("project"), 80);
    if (!rawQ) return { q: "", todo_ids: [], task_ids: [] };
    const words = rawQ.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const peerNames = new Map((this.config.peers || []).map((p) => [p.id, p.name]));
    const devLabel = (id) => (id === this.config.device_id ? (this.config.device_name || "этот компьютер") : peerNames.get(id) || "");
    const aliasesOf = (proj, name) => {
      if (!name) return [];
      const low = String(name).toLocaleLowerCase();
      const merged = { ...(this.config.aliases["*"] || {}), ...(proj ? (this.config.aliases[proj] || {}) : {}) };
      const out = [];
      for (const [al, can] of Object.entries(merged)) {
        if (String(can).toLocaleLowerCase() === low || String(al).toLocaleLowerCase() === low) out.push(al, can);
      }
      return out;
    };
    const matches = (parts) => {
      const hay = parts.filter(Boolean).join(" ").toLocaleLowerCase();
      return words.every((w) => hay.includes(w));
    };
    const todoIds = [];
    const todosByTask = new Map();
    for (const t of this.state.todos) {
      if (t.task_id) {
        let arr = todosByTask.get(t.task_id);
        if (!arr) { arr = []; todosByTask.set(t.task_id, arr); }
        arr.push(t);
      }
      if (projFilter && projFilter !== "*" && t.project !== projFilter) continue;
      const cardId = t.task_id ? this.state.task_card_ids?.[t.task_id] : "";
      const taskState = t.task_id ? this.state.tasks?.[t.task_id]?.state : "";
      const devId = t.recipient_device_id || t.origin_device_id || t.from_device?.id || "";
      if (matches([
        t.display_id, `AD-${t.id}`, t.message_id, t.task_id, t.project_id, t.ref,
        cardId, taskState, t.task, t.project, t.agent, ...aliasesOf(t.project, t.agent),
        t.to, ...aliasesOf(t.project, t.to), devId, devLabel(devId), t.from_device?.name,
        t.kind, t.note, t.result, t.message,
      ])) todoIds.push(t.id);
    }
    const taskLabel = { assigned: "назначена", working: "в работе", submitted: "сдана на проверку", accepted: "принята", rework: "на доработке", blocked: "заблокирована", cancelled: "отменена", archived: "в архиве" };
    const taskIds = [];
    for (const t of Object.values(this.state.tasks || {})) {
      if (projFilter && projFilter !== "*" && t.project !== projFilter) continue;
      const cardId = this.state.task_card_ids?.[t.task_id] || "";
      const linked = todosByTask.get(t.task_id) || [];
      if (matches([
        cardId, t.task_id, t.project_id, t.assignment_message_id, t.title, t.project,
        t.assignment?.agent, ...aliasesOf(t.project, t.assignment?.agent),
        t.assignment?.device_id, devLabel(t.assignment?.device_id),
        t.coordinator_device_id, devLabel(t.coordinator_device_id),
        t.state, taskLabel[t.state], t.status_reason,
        t.checkpoint?.branch, t.checkpoint?.commit, t.checkpoint?.report, t.checkpoint?.next_step,
        t.prompt, ...linked.flatMap((r) => [r.display_id, r.message_id, r.to, r.message]),
      ])) taskIds.push(t.task_id);
    }
    return { q: rawQ, todo_ids: todoIds, task_ids: taskIds };
  }

  reconcileReport() {
    const s = this.state;
    const j = s.sync || {};
    const tasks = Object.values(s.tasks || {})
      .sort((a, b) => a.task_id.localeCompare(b.task_id))
      .map((t) => {
        const receipts = s.todos
          .filter((r) => r.task_id === t.task_id)
          .sort((a, b) => a.message_id.localeCompare(b.message_id))
          .map((r) => ({
            message_id: r.message_id,
            display_id: r.display_id,
            purpose: r.purpose || r.kind,
            delivered_at: r.delivered_at || null,
            forwarded_at: r.forwarded_at || null,
            acked_at: r.acked_at || null,
            done_at: r.done_at || null,
            superseded_by: r.superseded_by || null,
          }));
        return {
          task_id: t.task_id,
          card_id: s.task_card_ids?.[t.task_id] || null,
          project: t.project,
          project_id: t.project_id,
          coordinator_device_id: t.coordinator_device_id,
          coordinator_epoch: t.coordinator_epoch || 1,
          epoch: t.assignment?.epoch || 1,
          assignee: t.assignment?.agent || "",
          assignee_device_id: t.assignment?.device_id || "",
          assignee_session_id: t.assignment?.session_id || "",
          state: t.state,
          assignment_message_id: t.assignment_message_id || null,
          receipts,
        };
      });
    const todos = [...s.todos]
      .sort((a, b) => a.message_id.localeCompare(b.message_id))
      .map((r) => ({
        message_id: r.message_id,
        display_id: r.display_id,
        task_id: r.task_id || null,
        origin_device_id: r.origin_device_id,
        delivered_at: r.delivered_at || null,
        forwarded_at: r.forwarded_at || null,
        acked_at: r.acked_at || null,
        done_at: r.done_at || null,
        supersedes: r.supersedes || null,
        superseded_by: r.superseded_by || null,
      }));
    return {
      generated_at: nowIso(),
      device_id: this.config.device_id,
      journal: {
        id: j.id || null,
        clock: j.clock || 0,
        base_seq: j.base_seq || 0,
        baseline_entities: j.baseline?.length || 0,
        tail_events: j.events?.length || 0,
      },
      totals: {
        tasks: tasks.length,
        todos: todos.length,
        delivered_todos: todos.filter((r) => r.delivered_at).length,
        acked_todos: todos.filter((r) => r.acked_at).length,
      },
      tasks,
      todos,
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

  _resolveTaskId(id) {
    const value = clean(id, 128);
    if (/^AT-\d+$/i.test(value)) {
      const upper = value.toUpperCase();
      return Object.entries(this.state.task_card_ids || {}).find(([, card]) => card === upper)?.[0] || value;
    }
    if (/^A[BD]-\d+$/i.test(value)) {
      const upper = value.toUpperCase();
      const todo = this.state.todos.find(t => String(t.display_id || "").toUpperCase() === upper);
      if (todo?.task_id) return todo.task_id;
    }
    return id;
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
    if (url.pathname.startsWith("/api/agent/")) return this._agent(req, res, url, cors);
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
        if (!auth.local || APP_ORIGINS.has(req.headers.origin)) this.lastPhoneSeenAt = nowIso();
        const hasSince = url.searchParams.has("since");
        const since = hasSince ? Number(url.searchParams.get("since")) : null;
        if (hasSince && since === this.state.version) return this._send(res, 200, { unchanged: true, version: since }, cors);
        if (url.searchParams.get("compact") === "1") return this._send(res, 200, this.compactPayload(auth, hasSince && Number.isSafeInteger(since) ? since : null), cors);
        return this._send(res, 200, this.payload(auth), cors);
      }
      if (url.pathname === "/api/item") {
        const item = this.itemPayload(url, auth);
        return item ? this._send(res, 200, item, cors) : this._send(res, 404, { error: "not found" }, cors);
      }
      if (url.pathname === "/api/search") return this._send(res, 200, this.searchPayload(url), cors);
      if (url.pathname === "/api/alert") {
        const a = this.state.alerts.find((x) => String(x.id) === url.searchParams.get("id"));
        return a ? this._send(res, 200, a, cors) : this._send(res, 404, { error: "not found" }, cors);
      }
      if (url.pathname === "/api/alerts") {
        if (!auth.local || APP_ORIGINS.has(req.headers.origin)) this.lastPhoneSeenAt = nowIso();
        return this._waitAlerts(res, url, cors);
      }
      if (url.pathname === "/api/diagnostics") return this._send(res, 200, this.diagnosticsExport(), cors);
      if (url.pathname === "/api/resources") return this._send(res, 200, this.resourceStatus(), cors);
      if (url.pathname === "/api/adapters/probe") {
        const id = url.searchParams.get("adapter");
        return this._send(res, 200, id ? this.adapters.probe(id, this.config) : { adapters: this.adapters.probeAll(this.config) }, cors);
      }
      if (url.pathname === "/api/mail") return this._send(res, 200, this.mailPayload(auth), cors);
      if (url.pathname === "/api/tasks/context") {
        try { return this._send(res, 200, this._scopedContext(url.searchParams.get("id"), auth), cors); }
        catch (e) { return this._send(res, e.status || 400, { error: e.message }, cors); }
      }
      if (url.pathname === "/api/tasks/handoff-json") {
        try { return this._send(res, 200, this.tasks.handoffPackage(this._resolveTaskId(url.searchParams.get("id")), auth), cors); }
        catch (e) { return this._send(res, e.status || 400, { error: e.message }, cors); }
      }
      if (url.pathname === "/api/reconcile") {
        return auth.local ? this._send(res, 200, this.reconcileReport(), cors) : this._send(res, 403, { error: "только на ПК" }, cors);
      }
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
    try {
      const r = await this.peers.p2p(req, url, body && typeof body === "object" && !Array.isArray(body) ? body : {});
      return this._send(res, r.code || 200, r.body || { ok: true });
    } catch (e) { return this._send(res, e.status || 500, { error: e.status ? e.message : "не удалось долговечно сохранить синхронизацию" }); }
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
      this._send(res, 200, { seq: s.alert_seq, alerts: valid ? s.alerts.filter((a) => a.id > after && !a.suppressed).slice(-20) : [] }, cors);
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

  async _agent(req, res, url, cors) {
    const remote = req.socket.remoteAddress || "";
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
    if (!loopback || req.headers.origin || req.headers["sec-fetch-site"] === "cross-site"
      || !safeEqual(req.headers["x-agent-desk-agent-key"] || "", this.config.agent_key)) {
      return this._send(res, 403, { error: "нужен локальный ключ Agent API" }, cors);
    }
    const route = url.pathname.slice("/api/agent/".length);
    try {
      if (req.method === "GET") {
        const project = url.searchParams.get("project") || "", agent = url.searchParams.get("agent") || "", session_id = url.searchParams.get("session_id") || "";
        const tasks = this.tasks.list({ project, agent, session_id, ...(route === "inbox" ? { device_id: this.config.device_id } : {}) }).map(t => this.tasks.enrich(t));
        if (route === "inbox") return this._send(res, 200, {
          device_id: this.config.device_id, tasks,
          todos: this.state.todos.filter(t => !t.acked_at && !t.done_at && !t.superseded_by && (!project || t.project === project) && (!agent || this._sameAgent(t.to, agent))
            && (!t.recipient_device_id || t.recipient_device_id === this.config.device_id)
            && (!session_id || !t.recipient_session_id || t.recipient_session_id === session_id))
            .map(t => ({ ...t, forward_text: forwardText(t) })),
        }, cors);
        if (route === "status") return this._send(res, 200, { tasks, bindings: Object.values(this.state.bindings || {}), device_id: this.config.device_id }, cors);
        if (route === "context") return this._send(res, 200, this.tasks.context(this._resolveTaskId(url.searchParams.get("id"))), cors);
        if (route === "read") {
          const rawId = clean(url.searchParams.get("id"), 128);
          const resolved = this._resolveTaskId(rawId);
          const resolvedKey = typeof resolved === "string" ? resolved.toLowerCase() : resolved;
          const taskObj = this.state.tasks?.[resolvedKey] || this.state.tasks?.[resolved] || null;
          const todo = this.state.todos.find(t => t.message_id === rawId.toLowerCase() || t.message_id === rawId || String(t.display_id || "").toUpperCase() === rawId.toUpperCase())
            || (taskObj?.assignment_message_id && this.state.todos.find(t => t.message_id === taskObj.assignment_message_id))
            || (taskObj && (this.state.todos.findLast(t => t.task_id === taskObj.task_id && !t.superseded_by) || this.state.todos.findLast(t => t.task_id === taskObj.task_id)));
          const task = taskObj || (todo && this.state.tasks?.[todo.task_id]);
          return this._send(res, todo || task ? 200 : 404, todo || task ? {
            todo: todo && { ...todo, forward_text: forwardText(todo) },
            task: task && this.tasks.enrich(task),
          } : { error: "сообщение/задача не найдены" }, cors);
        }
        return this._send(res, 404, { error: "not found" }, cors);
      }
      if (req.method !== "POST") return this._send(res, 405, { error: "method not allowed" }, cors);
      if (req.headers["x-agent-desk"] !== "1" || !/^application\/json\b/i.test(req.headers["content-type"] || "")) return this._send(res, 415, { error: "нужен JSON и X-Agent-Desk" }, cors);
      const body = await readJsonBody(req, LIMITS.body);
      if (route.startsWith("task/")) {
        const action = route.slice(5);
        if (!["assign", "transition", "handoff", "coordinate"].includes(action)) return this._send(res, 404, { error: "not found" }, cors);
        if (action === "assign" && !body.task_id && !body.id && body.project && !body.project_id) body.project_id = this._projectIdentity(body.project);
        return this._send(res, 200, this.tasks[action](body), cors);
      }
      const before = JSON.parse(JSON.stringify(this.state)), beforeSeen = new Set(this.seen);
      try {
        if (route === "ack") {
          if (!body.agent || !body.project || !body.message_id) throw Object.assign(new Error("agent/project/message_id обязательны"), { status: 400 });
          const ev = parseMarker(JSON.stringify({ ...body, state: "idle", ack: body.message_id }), body.project);
          const t = this.state.todos.find(t => t.message_id.toUpperCase() === String(body.message_id).toUpperCase()
            || (t.origin_device_id === this.config.device_id && !t.from_device && t.display_id === body.message_id));
          if (!t) throw Object.assign(new Error("сообщение не найдено"), { status: 404 });
          if (t.project !== ev.project || !this._sameAgent(t.to, ev.agent)) throw Object.assign(new Error("ACK не соответствует проекту/адресату"), { status: 403 });
          const ackError = this._ackError(t, ev);
          if (ackError) throw Object.assign(new Error(ackError), { status: 409 });
          if (t.acked_at) return this._send(res, 200, { ok: true, message_id: t.message_id, acked_at: t.acked_at, duplicate: true }, cors);
          if (!this._acknowledge(ev)) throw Object.assign(new Error("ACK не соответствует назначению"), { status: 409 });
          this._saveState(); this.emit("change");
          return this._send(res, 200, { ok: true, message_id: t.message_id, acked_at: t.acked_at }, cors);
        }
        if (route === "submit") {
          if (!body.agent || !body.state) throw Object.assign(new Error("agent и state обязательны"), { status: 400 });
          const ev = parseMarker(JSON.stringify(body), body.project);
          ev.event_id ||= crypto.randomUUID();
          if (this.seen.has(ev.event_id)) return this._send(res, 200, { ok: true, event_id: ev.event_id, duplicate: true }, cors);
          this.applyEvent(ev, "cli_or_mcp"); this._remember(ev.event_id); this._saveState(); this.emit("change");
          const todo = this.state.todos.findLast(t => t.task_id === ev.task_id);
          return this._send(res, 200, { ok: true, event_id: ev.event_id, task_id: ev.task_id, message_id: todo?.message_id }, cors);
        }
        return this._send(res, 404, { error: "not found" }, cors);
      } catch (e) { this.state = before; this.seen = beforeSeen; throw e; }
    } catch (e) { return this._send(res, e.status || 400, { error: e.message }, cors); }
  }

  _post(pathname, body, auth) {
    if (pathname.startsWith("/api/tasks/")) {
      const action = pathname.slice("/api/tasks/".length);
      if (!["assign", "transition", "handoff", "coordinate", "launch"].includes(action)) return { code: 404, body: { error: "not found" } };
      if (action === "launch" && !auth.local) return { code: 403, body: { error: "запуск адаптера выполняется только локально на ведущем ПК" } };
      if (action === "assign" && !body.task_id && !body.id && body.project && !body.project_id) body.project_id = this._projectIdentity(body.project);
      try { return { body: this.tasks[action](body) }; }
      catch (e) { return { code: e.status || 400, body: { error: e.message } }; }
    }
    if (pathname === "/api/agents/registry") return this.updateAgentRegistry(body, auth);
    if (pathname === "/api/agents/rotate-session") return this.rotateAgentSession(body, auth);
    if (pathname === "/api/mail/config") {
      if (!auth.local) return { code: 403, body: { error: "синхронизация файлов настраивается только на ПК" } };
      if (Object.hasOwn(body, "enabled") && typeof body.enabled !== "boolean") return { code: 400, body: { error: "enabled должен быть true или false" } };
      if (body.automatic === true) {
        delete this.config.mail_roots;
        this.config.file_sync_enabled = body.enabled !== false;
      } else if (Object.hasOwn(body, "roots")) {
        if (!Array.isArray(body.roots) || body.roots.length > 20) return { code: 400, body: { error: "roots должен быть списком до 20 папок" } };
        for (const r of body.roots) {
          if (!r || !r.project || !path.isAbsolute(r.path || "") || !fs.existsSync(r.path) || !fs.lstatSync(r.path).isDirectory() || fs.lstatSync(r.path).isSymbolicLink()) return { code: 400, body: { error: "нужны проект и существующая обычная папка" } };
        }
        this.config.mail_roots = body.roots.map(r => ({ project: oneLine(r.project,60), path: r.path }));
        this.config.file_sync_enabled = body.roots.length > 0 && body.enabled !== false;
      } else if (typeof body.enabled === "boolean") {
        // Toggling never deletes roots, files, incoming roots or the saved conflict/hash index.
        this.config.file_sync_enabled = body.enabled
          && !(Array.isArray(this.config.mail_roots) && this.config.mail_roots.length === 0);
      } else return { code: 400, body: { error: "нужны enabled, automatic:true или roots" } };
      this._saveConfig();
      if (this.fileSyncEnabled) this.mail.scan();
      this._saveState(); this.emit("change");
      return { body: this.mailPayload() };
    }
    const s = this.state;
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length === 4 && parts[0] === "api" && parts[1] === "todo") {
      const before = JSON.parse(JSON.stringify(this.state));
      const t = s.todos.find((x) => String(x.id) === parts[2]);
      if (!t) return { code: 404, body: { error: "not found" } };
      const now = nowIso();
      if (parts[3] === "forwarded") {
        t.forwarded_at ||= now;
      } else if (parts[3] === "done") {
        this._close(t, now, false);
      } else if (parts[3] === "undo") {
        if (t.superseded_by) return { code: 409, body: { error: "Это сообщение заменено новым; откройте текущую карточку" } };
        if (!t.acked_at) t.done_at = null;
        t.receipt_epoch = (t.receipt_epoch || 0) + 1;
      } else {
        return { code: 404, body: { error: "not found" } };
      }
      t.auto = false;
      t.updated = now;
      try {
        this._saveState();
      } catch (e) {
        this.state = before;
        return { code: 500, body: { error: `не удалось сохранить состояние: ${e.message}` } };
      }
      this.emit("change");
      return {};
    }
    switch (pathname) {
      case "/api/ui/show":
        this.emit("show", { todo: body.todo ?? null, project: body.project ?? null });
        return {};
      case "/api/agent/forget": {
        const before = JSON.parse(JSON.stringify(this.state));
        delete s.agents[`${oneLine(body.project, 60)}/${oneLine(body.agent, 60)}`];
        try { this._saveState(); } catch (e) { this.state = before; return { code: 500, body: { error: `не удалось сохранить состояние: ${e.message}` } }; }
        this.emit("change");
        return {};
      }
      case "/api/config":
        return this._updateConfig(body, auth);
      case "/api/pairing/rotate":
        if (!auth.local) return { code: 403, body: { error: "только на ПК" } };
        this.config.key = newKey();
        this._saveConfig();
        this._bump();
        return { body: this.pairing() };
      case "/api/rejected/clear": {
        if (!auth.local) return { code: 403, body: { error: "только на ПК" } };
        const before = JSON.parse(JSON.stringify(this.state));
        s.rejected = [];
        try { this._saveState(); } catch (e) { this.state = before; return { code: 500, body: { error: `не удалось сохранить состояние: ${e.message}` } }; }
        this.emit("change");
        return {};
      }
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
    const admin = ["watch", "lan", "autostart", "agents", "aliases", "agent_registry", "external_adapters_enabled", "resource_status_files", "allowed_hosts", "retention_days", "task_repo_roots", "task_skill_roots"].filter((k) => k in body);
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
    for (const key of ["task_repo_roots", "task_skill_roots"]) {
      if (!(key in body)) continue;
      const roots = body[key];
      if (!Array.isArray(roots) || roots.length > 20 || roots.some(p => typeof p !== "string" || !path.isAbsolute(p) || !fs.existsSync(p) || !fs.lstatSync(p).isDirectory() || fs.lstatSync(p).isSymbolicLink())) return { code: 400, body: { error: `${key}: нужны существующие обычные папки (до 20)` } };
    }
    for (const key of ["task_repo_roots", "task_skill_roots"]) if (key in body) c[key] = [...new Set(body[key])];
    for (const k of ["notify", "popup_sound", "autostart", "lan"]) if (typeof body[k] === "boolean") c[k] = body[k];
    if (body.quiet_hours && typeof body.quiet_hours === "object" && !Array.isArray(body.quiet_hours)) {
      const hhmmRe = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
      if ("enabled" in body.quiet_hours && typeof body.quiet_hours.enabled === "boolean") c.quiet_hours.enabled = body.quiet_hours.enabled;
      if (hhmmRe.test(String(body.quiet_hours.start || ""))) c.quiet_hours.start = String(body.quiet_hours.start);
      if (hhmmRe.test(String(body.quiet_hours.end || ""))) c.quiet_hours.end = String(body.quiet_hours.end);
    }
    if (body.notify_projects && typeof body.notify_projects === "object" && !Array.isArray(body.notify_projects)) {
      c.notify_projects = Object.fromEntries(Object.entries(body.notify_projects).slice(0, 60).map(([k, v]) => [oneLine(k, 60), v !== false]).filter(([k]) => k));
    }
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
    if ("agent_registry" in body) c.agent_registry = this._normalizeRegistry(body.agent_registry, c.device_id);
    if (typeof body.external_adapters_enabled === "boolean") c.external_adapters_enabled = body.external_adapters_enabled;
    if (body.resource_status_files && typeof body.resource_status_files === "object" && !Array.isArray(body.resource_status_files)) {
      c.resource_status_files = Object.fromEntries(["phone", "server"].filter((k) => typeof body.resource_status_files[k] === "string" && path.isAbsolute(body.resource_status_files[k])).map((k) => [k, body.resource_status_files[k]]));
    }
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
