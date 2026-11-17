"use strict";
/** Read-only agent credentials + bounded loopback HTTP. No Desk/state imports. */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");

const MAX_INPUT = 256 * 1024;
const MAX_RESPONSE = 2 * 1024 * 1024;
const COMMANDS = Object.freeze({
  inbox: { method: "GET", route: "/api/agent/inbox", query: ["project", "agent", "session_id"] },
  read: { method: "GET", route: "/api/agent/read", query: ["id"] },
  ack: { method: "POST", route: "/api/agent/ack" },
  submit: { method: "POST", route: "/api/agent/submit" },
  status: { method: "GET", route: "/api/agent/status", query: [] },
  handoff: { method: "POST", route: "/api/agent/task/handoff" },
  context: { method: "GET", route: "/api/agent/context", query: ["id"] },
  assign: { method: "POST", route: "/api/agent/task/assign" },
  transition: { method: "POST", route: "/api/agent/task/transition" },
  coordinate: { method: "POST", route: "/api/agent/task/coordinate" },
});

class AgentClientError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "AgentClientError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function errorResult(error) {
  // Do not serialize arbitrary errors: OS paths, request options, or credentials may be present.
  const known = error instanceof AgentClientError;
  return { ok: false, error: {
    code: known ? error.code : "INTERNAL_ERROR",
    message: known ? error.message : "Agent Desk client failed.",
    ...(known && error.status !== undefined ? { status: error.status } : {}),
  } };
}

function parseObject(text, code = "INVALID_JSON") {
  if (Buffer.byteLength(text, "utf8") > MAX_INPUT) {
    throw new AgentClientError("INPUT_TOO_LARGE", "JSON input exceeds 256 KiB.");
  }
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch { throw new AgentClientError(code, "Expected a valid JSON object."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentClientError(code, "Expected a JSON object, not an array or primitive.");
  }
  return value;
}

function loopbackServer(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new AgentClientError("UNSAFE_SERVER", "Server must be a loopback HTTP origin."); }
  if (!/^http:\/\//i.test(String(value)) || url.protocol !== "http:" || url.username || url.password
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.pathname !== "/" || url.search || url.hash) {
    throw new AgentClientError("UNSAFE_SERVER", "Server must be http://127.0.0.1, http://localhost, or http://[::1], optionally with a port; no credentials or URL paths.");
  }
  // Never resolve localhost via DNS/hosts. A proxy or redirect is never used.
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url;
}

function readAgentConfig(home) {
  let text;
  try {
    const file = path.join(home, "config.json");
    if (fs.statSync(file).size > 1024 * 1024) throw new Error("too large");
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new AgentClientError("CONFIG_UNAVAILABLE", "Cannot read Agent Desk config.json; start Agent Desk or select --home.");
  }
  let config;
  try { config = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch { throw new AgentClientError("INVALID_CONFIG", "Agent Desk config.json is invalid; it was not modified."); }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new AgentClientError("INVALID_CONFIG", "Agent Desk config.json must be an object; it was not modified.");
  }
  // Deliberately project only these fields; owner keys/watch roots/state are never exposed.
  const { port = 8098, agent_key: agentKey } = config;
  if (typeof agentKey !== "string" || !/^[A-Za-z0-9._~-]{16,512}$/.test(agentKey)) {
    throw new AgentClientError("AGENT_KEY_MISSING", "A separate local agent_key is required; owner/pairing keys are not accepted as a fallback.");
  }
  return { port, agentKey };
}

class AgentClient {
  #agentKey;
  #server;
  #timeout;
  constructor({ home = process.env.AGENT_DESK_HOME || path.join(os.homedir(), "AgentDesk"), server, timeout = 10000 } = {}) {
    // Validate destination before reading any credentials.
    const override = server === undefined ? null : loopbackServer(server);
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000) {
      throw new AgentClientError("INVALID_TIMEOUT", "Timeout must be an integer from 1 to 120000 milliseconds.");
    }
    const { port, agentKey } = readAgentConfig(home);
    if (!override && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) {
      throw new AgentClientError("INVALID_CONFIG", "Agent Desk config.port must be an integer from 1 to 65535.");
    }
    this.#server = override || loopbackServer(`http://127.0.0.1:${port}`);
    this.#agentKey = agentKey;
    this.#timeout = timeout;
  }

  #redact(text) { return text.split(this.#agentKey).join("[REDACTED]"); }

  async execute(command, input = {}) {
    const spec = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
    if (!spec) throw new AgentClientError("UNKNOWN_COMMAND", "Unknown Agent Desk command.");
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new AgentClientError("INVALID_INPUT", "Command input must be a JSON object.");
    }
    const url = new URL(spec.route, this.#server);
    let body;
    if (spec.method === "GET") {
      for (const [key, value] of Object.entries(input)) {
        if (!spec.query.includes(key)) throw new AgentClientError("INVALID_INPUT", `Unsupported query field: ${key.slice(0, 80)}.`);
        if (typeof value !== "string" || !value.trim() || value.length > 2000) {
          throw new AgentClientError("INVALID_INPUT", "Query values must be nonempty strings of at most 2000 characters.");
        }
        url.searchParams.set(key, value);
      }
      if (["read", "context"].includes(command) && !input.id) {
        throw new AgentClientError("INVALID_INPUT", `${command} requires id (message UUID or task UUID).`);
      }
    } else {
      try { body = JSON.stringify(input); }
      catch { throw new AgentClientError("INVALID_INPUT", "Command input must be serializable JSON."); }
      if (Buffer.byteLength(body) > MAX_INPUT) throw new AgentClientError("INPUT_TOO_LARGE", "JSON input exceeds 256 KiB.");
    }
    return this.#request(url, spec.method, body);
  }

  #request(url, method, body) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let req;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => {
        finish(new AgentClientError("TIMEOUT", "Agent Desk request timed out; a write may have reached the server. Check status before retrying."));
        req?.destroy();
      }, this.#timeout);
      const headers = { "X-Agent-Desk-Agent-Key": this.#agentKey, Accept: "application/json" };
      if (body !== undefined) Object.assign(headers, { "X-Agent-Desk": "1", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      try {
        req = http.request(url, { method, headers, agent: false }, (res) => {
          const status = res.statusCode || 502;
          if (status >= 300 && status < 400) {
            finish(new AgentClientError("REDIRECT_BLOCKED", "Agent Desk redirects are not followed, to protect the agent key.", status));
            res.destroy();
            return;
          }
          const chunks = [];
          let size = 0;
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_RESPONSE) {
              finish(new AgentClientError("RESPONSE_TOO_LARGE", "Agent Desk response exceeds 2 MiB.", status));
              res.destroy();
            } else chunks.push(chunk);
          });
          res.on("error", () => finish(new AgentClientError("NETWORK_ERROR", "Agent Desk response was interrupted.")));
          res.on("end", () => {
            if (settled) return;
            let value;
            try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
            catch {
              finish(new AgentClientError(status >= 400 ? "HTTP_ERROR" : "INVALID_RESPONSE", "Agent Desk returned a non-JSON response.", status));
              return;
            }
            // Redact after JSON decoding too (escaped echoes must not reveal the key).
            try { value = JSON.parse(this.#redact(JSON.stringify(value))); }
            catch {
              finish(new AgentClientError("INVALID_RESPONSE", "Agent Desk returned an invalid response.", status));
              return;
            }
            if (!value || typeof value !== "object" || Array.isArray(value)) {
              finish(new AgentClientError("INVALID_RESPONSE", "Agent Desk response must be a JSON object.", status));
            } else if (status < 200 || status >= 300 || value.ok === false) {
              const message = typeof value.error === "string" ? value.error
                : typeof value.error?.message === "string" ? value.error.message : `Agent Desk request failed (HTTP ${status}).`;
              finish(new AgentClientError("HTTP_ERROR", message.slice(0, 2000), status));
            } else finish(null, value);
          });
        });
        req.on("error", () => finish(new AgentClientError("NETWORK_ERROR", "Cannot reach the local Agent Desk server; check that it is running.")));
        req.end(body);
      } catch {
        finish(new AgentClientError("NETWORK_ERROR", "Cannot create the local Agent Desk request."));
      }
    });
  }
}

module.exports = { AgentClient, AgentClientError, COMMANDS, MAX_INPUT, errorResult, parseObject, loopbackServer };
