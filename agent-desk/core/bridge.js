"use strict";
/**
 * Sanctioned Live Chat & Zero-Touch Relay Bridge for Antigravity and OpenAI Codex.
 *
 * Supported official mechanisms (no screen scraping, no keystroke injection, no undocumented APIs):
 * 1. Read-only tail parsing of Antigravity `transcript.jsonl` and Codex `rollout-*.jsonl`
 *    (from hook payloads or owner-enabled local session directories), bounded to 256 KiB per read
 *    with secret redaction and strict path/symlink checks.
 * 2. Official Lifecycle Hooks (`agentdesk hook --provider antigravity|codex`):
 *    - Antigravity `.agents/hooks.json`: `SessionStart`/`PreInvocation` (`injectSteps`) & `Stop` (`decision: "continue"`).
 *    - Codex `.codex/hooks.json`: `Stop` (`decision: "block"`).
 * 3. Active CLI Session Push via `CodexCliAdapter` (`codex queue --thread ... --resume`) when
 *    explicitly opted in by the local owner, guarded by a per-task circuit breaker (`max_relays_per_task`).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_TAIL_BYTES = 256 * 1024;
const MAX_TURNS_PER_SESSION = 10;
const MAX_TURN_TEXT = 1600;
const MAX_LIVE_SESSIONS = 24;
const RECENT_FILE_WINDOW_MS = 12 * 3600 * 1000;

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
  /(["']?(?:api[_-]?key|agent[_-]?key|token|secret|password)["']?\s*[:=]\s*["'])[^"']{8,}(["'])/gi,
];

function redactSecrets(raw, extraSecrets = []) {
  let s = String(raw ?? "");
  for (const secret of extraSecrets) {
    if (typeof secret === "string" && secret.length >= 12) {
      s = s.split(secret).join("[REDACTED]");
    }
  }
  for (let i = 0; i < SECRET_PATTERNS.length; i++) {
    const re = SECRET_PATTERNS[i];
    if (i === SECRET_PATTERNS.length - 1) s = s.replace(re, "$1[REDACTED]$2");
    else s = s.replace(re, "[REDACTED]");
  }
  return s;
}

function trimTurnText(raw, extraSecrets = []) {
  const clean = redactSecrets(raw, extraSecrets).replace(/\r\n/g, "\n").trim();
  if (!clean) return "";
  return clean.length > MAX_TURN_TEXT ? `${clean.slice(0, MAX_TURN_TEXT)}…` : clean;
}

function readTailLines(filePath, maxBytes = MAX_TAIL_BYTES) {
  const st = fs.lstatSync(filePath);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error("Transcript must be a regular non-symlink file");
  const size = st.size;
  if (size === 0) return { lines: [], size: 0, mtimeMs: st.mtimeMs };
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const buf = Buffer.allocUnsafe(length);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buf, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  let text = buf.toString("utf8");
  if (start > 0) {
    const nl = text.indexOf("\n");
    text = nl >= 0 ? text.slice(nl + 1) : "";
  }
  return {
    lines: text.split(/\r?\n/).filter((l) => l.trim()),
    size,
    mtimeMs: st.mtimeMs,
  };
}

function stripAntigravityTags(text) {
  const s = String(text || "");
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(s);
  if (m) return m[1].trim();
  if (s.includes("<SYSTEM_MESSAGE>") && !s.includes("[Agent Desk]")) return "";
  return s;
}

function extractCodexContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.input_text === "string") return part.input_text;
      if (typeof part.output_text === "string") return part.output_text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseTranscriptTail(filePath, providerHint = "", extraSecrets = []) {
  const { lines, size, mtimeMs } = readTailLines(filePath);
  let provider = providerHint === "antigravity" || providerHint === "codex" ? providerHint : "";
  let sessionId = "";
  let cwd = "";
  const turns = [];

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== "object") continue;

    // Auto-detect provider if not specified
    if (!provider) {
      if ("step_index" in obj || obj.type === "USER_INPUT" || obj.type === "PLANNER_RESPONSE") provider = "antigravity";
      else if (obj.type === "session_meta" || obj.type === "response_item" || obj.type === "turn_context" || obj.type === "event_msg") provider = "codex";
    }

    if (provider === "antigravity") {
      if (obj.type === "USER_INPUT") {
        const cleaned = stripAntigravityTags(obj.content);
        const text = trimTurnText(cleaned, extraSecrets);
        if (text) turns.push({ role: "user", text, time: obj.created_at || null, step: obj.step_index ?? null });
      } else if (obj.type === "PLANNER_RESPONSE") {
        const tools = Array.isArray(obj.tool_calls)
          ? obj.tool_calls.map((t) => t?.name || t?.ToolName).filter(Boolean).slice(0, 6)
          : [];
        const text = trimTurnText(obj.content, extraSecrets);
        if (text || tools.length) {
          turns.push({
            role: "assistant",
            text: text || (tools.length ? `[вызов инструментов: ${tools.join(", ")}]` : ""),
            tools,
            time: obj.created_at || null,
            step: obj.step_index ?? null,
          });
        }
      }
    } else if (provider === "codex") {
      const payload = obj.payload && typeof obj.payload === "object" ? obj.payload : obj;
      if (obj.type === "session_meta") {
        sessionId = String(payload.id || payload.session_id || sessionId || "");
        cwd = String(payload.cwd || cwd || "");
      } else if (obj.type === "turn_context") {
        cwd = String(payload.cwd || cwd || "");
      } else if (obj.type === "response_item" && payload.type === "message" && ["user", "assistant"].includes(payload.role)) {
        const rawText = extractCodexContentText(payload.content);
        if (payload.role === "user" && /^\s*<environment_context>/i.test(rawText)) continue;
        const text = trimTurnText(rawText, extraSecrets);
        if (text) {
          const prev = turns.at(-1);
          if (!prev || prev.role !== payload.role || prev.text !== text) {
            turns.push({ role: payload.role, text, time: obj.timestamp || payload.timestamp || null });
          }
        }
      } else if (obj.type === "event_msg" && ["user_message", "agent_message"].includes(payload.type)) {
        const role = payload.type === "user_message" ? "user" : "assistant";
        const text = trimTurnText(payload.message || payload.text || "", extraSecrets);
        if (text) {
          const prev = turns.at(-1);
          if (!prev || prev.role !== role || prev.text !== text) {
            turns.push({ role, text, time: obj.timestamp || null });
          }
        }
      }
    }
  }

  if (!sessionId) {
    if (provider === "antigravity") {
      const parts = path.normalize(filePath).split(path.sep);
      const brainIdx = parts.findIndex((p) => p.toLowerCase() === "brain");
      if (brainIdx >= 0 && parts[brainIdx + 1]) sessionId = parts[brainIdx + 1];
    } else {
      const base = path.basename(filePath, ".jsonl");
      const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(base);
      sessionId = m ? m[1] : base;
    }
  }

  const recentTurns = turns.slice(-MAX_TURNS_PER_SESSION);
  const lastAssistant = [...recentTurns].reverse().find((t) => t.role === "assistant")?.text || "";
  const lastUser = [...recentTurns].reverse().find((t) => t.role === "user")?.text || "";

  return {
    provider: provider || "unknown",
    session_id: sessionId || path.basename(filePath, ".jsonl"),
    cwd,
    size,
    mtime_ms: mtimeMs,
    updated_at: new Date(mtimeMs).toISOString(),
    turns: recentTurns,
    last_assistant_text: lastAssistant,
    last_user_text: lastUser,
  };
}

function containedIn(rootDir, targetPath) {
  const rel = path.relative(path.resolve(rootDir), path.resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

class ChatBridge {
  constructor(desk, opts = {}) {
    this.desk = desk;
    this.homeDir = opts.homeDir || os.homedir();
    this.codexSessionsDir = opts.codexSessionsDir || path.join(this.homeDir, ".codex", "sessions");
    this.antigravityBrainDir = opts.antigravityBrainDir || path.join(this.homeDir, ".gemini", "antigravity", "brain");
    this.antigravityCliBrainDir = opts.antigravityCliBrainDir || path.join(this.homeDir, ".gemini", "antigravity-cli", "brain");
    this.extraAllowedRoots = Array.isArray(opts.allowedRoots) ? opts.allowedRoots.map((p) => path.resolve(p)) : [];

    this._fileCache = new Map(); // filePath -> `${size}:${mtimeMs}`
    this._sessions = new Map();  // key -> session summary
    this._lastScanMs = 0;
  }

  _secrets() {
    return [this.desk.config?.key, this.desk.config?.agent_key].filter(Boolean);
  }

  _allowedTranscriptRoots() {
    const c = this.desk.config || {};
    return [
      path.join(this.homeDir, ".gemini"),
      path.join(this.homeDir, ".codex"),
      this.codexSessionsDir,
      this.antigravityBrainDir,
      this.antigravityCliBrainDir,
      ...(Array.isArray(c.task_repo_roots) ? c.task_repo_roots : []),
      ...(Array.isArray(c.watch) ? c.watch.map((w) => w.path).filter(Boolean) : []),
      ...this.extraAllowedRoots,
    ].map((p) => path.resolve(p));
  }

  isTranscriptAllowed(filePath) {
    if (!filePath || typeof filePath !== "string") return false;
    const resolved = path.resolve(filePath);
    if (!resolved.toLowerCase().endsWith(".jsonl")) return false;
    if (!this._allowedTranscriptRoots().some((root) => containedIn(root, resolved))) return false;
    try {
      const st = fs.lstatSync(resolved);
      return st.isFile() && !st.isSymbolicLink();
    } catch {
      return false;
    }
  }

  _inferProjectFromCwd(cwd) {
    if (!cwd) return "";
    const resolved = path.resolve(cwd);
    for (const w of this.desk.config?.watch || []) {
      if (w.project && w.path && (containedIn(w.path, resolved) || containedIn(path.dirname(w.path), resolved))) {
        return w.project;
      }
    }
    for (const t of Object.values(this.desk.state?.tasks || {})) {
      if (t.project && t.checkpoint?.repo && containedIn(t.checkpoint.repo, resolved)) {
        return t.project;
      }
    }
    return "";
  }

  _upsertSession(entry) {
    const key = `${entry.provider}:${entry.session_id}`;
    const prev = this._sessions.get(key) || {};
    this._sessions.set(key, {
      key,
      provider: entry.provider,
      session_id: entry.session_id,
      agent: entry.agent || prev.agent || (entry.provider === "codex" ? "Codex" : entry.provider === "antigravity" ? "Antigravity" : ""),
      project: entry.project || prev.project || this._inferProjectFromCwd(entry.cwd) || "",
      cwd: entry.cwd || prev.cwd || "",
      updated_at: entry.updated_at || new Date().toISOString(),
      source: entry.source || prev.source || "transcript",
      turns: entry.turns?.length ? entry.turns : (prev.turns || []),
      last_assistant_text: entry.last_assistant_text || prev.last_assistant_text || "",
      last_user_text: entry.last_user_text || prev.last_user_text || "",
      last_hook_event: entry.last_hook_event || prev.last_hook_event || null,
    });
    if (this._sessions.size > MAX_LIVE_SESSIONS) {
      const sorted = [...this._sessions.entries()].sort((a, b) => String(b[1].updated_at).localeCompare(String(a[1].updated_at)));
      this._sessions = new Map(sorted.slice(0, MAX_LIVE_SESSIONS));
    }
  }

  ingestTranscriptFile(filePath, meta = {}) {
    if (!this.isTranscriptAllowed(filePath)) return null;
    const resolved = path.resolve(filePath);
    let st;
    try { st = fs.lstatSync(resolved); } catch { return null; }
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const sig = `${st.size}:${st.mtimeMs}`;
    if (!meta.force && this._fileCache.get(resolved) === sig) return null;
    try {
      const parsed = parseTranscriptTail(resolved, meta.provider || "", this._secrets());
      this._fileCache.set(resolved, sig);
      if (!parsed.turns.length && !meta.session_id) return null;
      this._upsertSession({
        ...parsed,
        session_id: meta.session_id || parsed.session_id,
        agent: meta.agent || "",
        project: meta.project || "",
        cwd: meta.cwd || parsed.cwd,
        source: meta.source || "transcript_watch",
        last_hook_event: meta.hook_event || null,
      });
      return this._sessions.get(`${parsed.provider}:${meta.session_id || parsed.session_id}`);
    } catch {
      return null;
    }
  }

  _collectRecentJsonl() {
    const out = [];
    const cutoff = Date.now() - RECENT_FILE_WINDOW_MS;

    // 1. Antigravity brain/*/.system_generated/logs/transcript.jsonl
    for (const brainRoot of [this.antigravityBrainDir, this.antigravityCliBrainDir]) {
      let convDirs = [];
      try { convDirs = fs.readdirSync(brainRoot, { withFileTypes: true }); } catch { continue; }
      for (const d of convDirs) {
        if (!d.isDirectory() || d.isSymbolicLink()) continue;
        const f = path.join(brainRoot, d.name, ".system_generated", "logs", "transcript.jsonl");
        try {
          const st = fs.lstatSync(f);
          if (st.isFile() && !st.isSymbolicLink() && st.mtimeMs >= cutoff) {
            out.push({ file: f, mtimeMs: st.mtimeMs, provider: "antigravity", session_id: d.name });
          }
        } catch { /* ignore */ }
      }
    }

    // 2. Codex ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (check newest 2 year/month/day folders)
    try {
      const years = fs.readdirSync(this.codexSessionsDir).filter((x) => /^\d{4}$/.test(x)).sort().slice(-2);
      for (const y of years) {
        const yDir = path.join(this.codexSessionsDir, y);
        const months = fs.readdirSync(yDir).filter((x) => /^\d{2}$/.test(x)).sort().slice(-2);
        for (const m of months) {
          const mDir = path.join(yDir, m);
          const days = fs.readdirSync(mDir).filter((x) => /^\d{2}$/.test(x)).sort().slice(-3);
          for (const d of days) {
            const dDir = path.join(mDir, d);
            for (const name of fs.readdirSync(dDir)) {
              if (!name.endsWith(".jsonl")) continue;
              const f = path.join(dDir, name);
              try {
                const st = fs.lstatSync(f);
                if (st.isFile() && !st.isSymbolicLink() && st.mtimeMs >= cutoff) {
                  out.push({ file: f, mtimeMs: st.mtimeMs, provider: "codex" });
                }
              } catch { /* ignore */ }
            }
          }
        }
      }
    } catch { /* codex sessions dir may not exist */ }

    return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 10);
  }

  tick() {
    if (!this.desk.config?.autopilot?.watch_chats) return false;
    const now = Date.now();
    if (now - this._lastScanMs < 3000) return false;
    this._lastScanMs = now;
    let changed = false;
    for (const item of this._collectRecentJsonl()) {
      if (this.ingestTranscriptFile(item.file, { provider: item.provider, session_id: item.session_id, source: "auto_watch" })) {
        changed = true;
      }
    }
    if (changed) {
      this.desk._bump();
      this.desk.emit("change");
    }
    return changed;
  }

  _pendingTodoForAgent({ project = "", agent = "", session_id = "" }) {
    if (!agent) return null;
    const localDevice = this.desk.config.device_id;
    const todos = this.desk.state.todos || [];
    return todos.find((t) => (
      t.kind === "forward"
      && !t.done_at
      && !t.superseded_by
      && !t.acked_at
      && !t.auto_relayed_at
      && (!project || t.project === project)
      && this.desk._sameAgent(t.to, agent)
      && (!t.recipient_device_id || t.recipient_device_id === localDevice)
      && (!t.delivery_target || t.delivery_target === localDevice)
      && (!session_id || !t.recipient_session_id || t.recipient_session_id === session_id)
    )) || null;
  }

  _checkAndIncrementCircuitBreaker(todo) {
    const maxRelays = Math.max(1, Math.min(50, Number(this.desk.config.autopilot?.max_relays_per_task) || 6));
    const task = todo.task_id ? this.desk.state.tasks?.[todo.task_id] : null;
    const used = Number(task?.auto_relay_count || 0);
    if (used >= maxRelays) {
      if (task && !task.autopilot_paused_reason) {
        task.autopilot_paused_reason = `Достигнут предел автопересылок (${maxRelays}) без участия владельца`;
        this.desk._alert(
          "limit",
          todo.project || "",
          `Автопилот остановлен (${todo.project || "проект"})`,
          `Задача достигла лимита ${maxRelays} автоматических передач подряд — проверьте ход диалога агентов.`,
          todo.id,
          { action: "Проверьте живые чаты и при необходимости продолжите вручную" },
        );
      }
      return false;
    }
    if (task) task.auto_relay_count = used + 1;
    return true;
  }

  /**
   * Processes a lifecycle hook event from Antigravity or Codex (`POST /api/agent/hook`).
   * Returns `{ hook_stdout, relayed_todo_id, session }` where `hook_stdout` is the exact
   * JSON object to emit on the hook process's stdout.
   */
  handleHook(body = {}) {
    const rawHook = body.hook && typeof body.hook === "object" ? body.hook : body;
    const provider = String(
      body.provider
      || ("conversationId" in rawHook || "hookEventName" in rawHook ? "antigravity" : "")
      || ("stop_hook_active" in rawHook || "hook_event_name" in rawHook ? "codex" : "antigravity"),
    ).toLowerCase();

    const eventName = String(rawHook.hookEventName || rawHook.hook_event_name || body.event || "Stop");
    const sessionId = String(rawHook.conversationId || rawHook.session_id || body.session_id || "").slice(0, 120);
    const transcriptPath = String(rawHook.transcriptPath || rawHook.transcript_path || body.transcript_path || "");
    const cwd = String(rawHook.cwd || (Array.isArray(rawHook.workspacePaths) && rawHook.workspacePaths[0]) || body.cwd || "");
    const project = String(body.project || this._inferProjectFromCwd(cwd) || "").slice(0, 60);
    const agent = String(body.agent || (provider === "codex" ? "Codex" : "Carbon")).slice(0, 60);
    const alreadyContinued = Boolean(rawHook.continuationActive || rawHook.stop_hook_active);

    let session = null;
    if (transcriptPath) {
      session = this.ingestTranscriptFile(transcriptPath, {
        provider,
        session_id: sessionId,
        agent,
        project,
        cwd,
        source: `${provider}_hook`,
        hook_event: eventName,
        force: true,
      });
    } else if (sessionId) {
      this._upsertSession({
        provider,
        session_id: sessionId,
        agent,
        project,
        cwd,
        updated_at: new Date().toISOString(),
        source: `${provider}_hook`,
        last_hook_event: eventName,
        turns: [],
      });
      session = this._sessions.get(`${provider}:${sessionId}`);
    }

    const defaultOut = provider === "antigravity" ? {} : null;
    if (!this.desk.config.autopilot?.enabled) {
      this.desk._bump();
      this.desk.emit("change");
      return { ok: true, relayed: false, hook_stdout: defaultOut, session };
    }

    // Never loop infinitely inside a forced Stop continuation
    if (eventName === "Stop" && alreadyContinued) {
      this.desk._bump();
      this.desk.emit("change");
      return { ok: true, relayed: false, reason: "continuation_guard", hook_stdout: defaultOut, session };
    }

    const canInject = (provider === "antigravity" && ["SessionStart", "PreInvocation", "Stop"].includes(eventName))
      || (provider === "codex" && eventName === "Stop");
    if (!canInject) {
      this.desk._bump();
      this.desk.emit("change");
      return { ok: true, relayed: false, hook_stdout: defaultOut, session };
    }

    const todo = this._pendingTodoForAgent({ project, agent, session_id: body.strict_session ? sessionId : "" });
    if (!todo) {
      this.desk._bump();
      this.desk.emit("change");
      return { ok: true, relayed: false, hook_stdout: defaultOut, session };
    }

    if (!this._checkAndIncrementCircuitBreaker(todo)) {
      this.desk._commit();
      return { ok: true, relayed: false, reason: "circuit_breaker", hook_stdout: defaultOut, session };
    }

    const text = this.desk._buildForwardText(todo);
    const now = new Date().toISOString();
    todo.auto_relayed_at = now;
    todo.auto_relay_channel = `${provider}_hook:${eventName}`;
    todo.forwarded_at ||= now;
    todo.updated = now;
    this.desk._commit();

    let hookStdout;
    if (provider === "antigravity") {
      if (eventName === "Stop") {
        hookStdout = { decision: "continue", reason: text };
      } else {
        hookStdout = { injectSteps: [{ systemMessage: { systemMessage: text } }] };
      }
    } else {
      hookStdout = { decision: "block", reason: text };
    }

    return {
      ok: true,
      relayed: true,
      relayed_todo_id: todo.id,
      message_id: todo.message_id,
      hook_stdout: hookStdout,
      session,
    };
  }

  /**
   * Optional active push for idle Codex sessions when a new forwardable todo appears
   * and `autopilot.enabled && autopilot.codex_cli_enabled` is turned on by the owner.
   */
  tryAutoDispatchTodo(todo) {
    const auto = this.desk.config?.autopilot;
    if (!auto?.enabled || !auto?.codex_cli_enabled || !todo || todo.kind !== "forward" || todo.done_at || todo.acked_at || todo.auto_relayed_at) {
      return null;
    }
    if (todo.recipient_device_id && todo.recipient_device_id !== this.desk.config.device_id) return null;
    const task = todo.task_id ? this.desk.state.tasks?.[todo.task_id] : null;
    const targetsAssignee = Boolean(task?.assignment?.agent && this.desk._sameAgent(todo.to, task.assignment.agent));
    const recipientBinding = !targetsAssignee
      ? Object.values(this.desk.state?.bindings || {}).findLast((b) => b.project === todo.project && this.desk._sameAgent(b.agent, todo.to) && b.device_id === this.desk.config.device_id)
      : null;
    const adapterId = targetsAssignee ? (task?.assignment?.adapter || "") : (recipientBinding?.adapter || "");
    const looksCodex = adapterId === "codex-cli" || /^codex\b/i.test(String(todo.to || ""));
    if (!looksCodex) return null;

    const threadId = todo.recipient_session_id
      || (targetsAssignee ? task?.assignment?.session_id : recipientBinding?.session_id)
      || "";
    if (!threadId) return null;
    const cwd = task?.checkpoint?.repo || this.desk.config.watch?.find((w) => w.project === todo.project)?.path || "";

    if (!this._checkAndIncrementCircuitBreaker(todo)) {
      this.desk._commit();
      return null;
    }

    try {
      const receipt = this.desk.adapters.launch("codex-cli", {
        task: {
          task_id: task?.task_id || todo.task_id || todo.message_id,
          assignment: {
            agent: todo.to,
            epoch: todo.assignment_epoch || task?.assignment?.epoch || 1,
            session_id: threadId,
            device_id: this.desk.config.device_id,
          },
          checkpoint: task?.checkpoint || {},
        },
        forward_text: this.desk._buildForwardText(todo),
        request_id: todo.message_id,
        cwd,
      }, this.desk.config);
      const now = new Date().toISOString();
      todo.launch_dispatched_at = receipt.dispatched_at || now;
      todo.auto_relayed_at = now;
      todo.auto_relay_channel = "codex-cli";
      todo.forwarded_at ||= now;
      todo.updated = now;
      return receipt;
    } catch (e) {
      this.desk.log("autopilot codex-cli dispatch skipped:", e.message);
      return null;
    }
  }

  snippets(agentAntigravity = "Carbon", agentCodex = "Codex", project = "") {
    const cliCmd = process.platform === "win32"
      ? '"C:\\Program Files\\Agent Desk\\agentdesk.cmd"'
      : "node agent-desk/core/cli.js";
    const mcpCmd = process.platform === "win32"
      ? "C:\\Program Files\\Agent Desk\\agentdesk-mcp.cmd"
      : "node";
    const projArg = project ? ` --project "${project.replace(/"/g, "")}"` : "";

    const antigravityHooks = {
      "agent-desk-bridge": {
        SessionStart: [
          { type: "command", command: `${cliCmd} hook --provider antigravity --agent "${agentAntigravity}"${projArg}`, timeout: 8 },
        ],
        Stop: [
          { type: "command", command: `${cliCmd} hook --provider antigravity --agent "${agentAntigravity}"${projArg}`, timeout: 8 },
        ],
      },
    };

    const codexHooks = {
      Stop: [
        { type: "command", command: `${cliCmd} hook --provider codex --agent "${agentCodex}"${projArg}`, timeout: 8 },
      ],
    };

    const mcpConfig = {
      mcpServers: {
        "agent-desk": process.platform === "win32"
          ? { command: mcpCmd, args: [] }
          : { command: "node", args: ["agent-desk/core/mcp.js"] },
      },
    };

    return {
      antigravity_hooks_path: ".agents/hooks.json",
      antigravity_hooks: JSON.stringify(antigravityHooks, null, 2),
      codex_hooks_path: ".codex/hooks.json",
      codex_hooks: JSON.stringify(codexHooks, null, 2),
      mcp_config_path: "~/.gemini/config/mcp_config.json",
      mcp_config: JSON.stringify(mcpConfig, null, 2),
      standby_command: `${cliCmd} wait --agent "${agentAntigravity}"${projArg} --wait-seconds 1800`,
    };
  }

  summaryPayload(auth = { local: false }) {
    const c = this.desk.config?.autopilot || {};
    const sessions = [...this._sessions.values()].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return {
      enabled: Boolean(c.enabled),
      watch_chats: Boolean(c.watch_chats),
      codex_cli_enabled: Boolean(c.codex_cli_enabled),
      max_relays_per_task: Number(c.max_relays_per_task) || 6,
      active_sessions: sessions.length,
      sessions: auth?.local
        ? sessions.map(({ cwd: _c, ...s }) => s)
        : sessions.map((s) => ({
            key: s.key,
            provider: s.provider,
            agent: s.agent,
            project: s.project,
            updated_at: s.updated_at,
          })),
    };
  }

  fullPayload(project = "", agentAntigravity = "Carbon", agentCodex = "Codex") {
    return {
      ...this.summaryPayload({ local: true }),
      codex_probe: this.desk.adapters.probe("codex-cli", this.desk.config),
      snippets: this.snippets(agentAntigravity, agentCodex, project),
    };
  }
}

module.exports = { ChatBridge, parseTranscriptTail, redactSecrets };
