#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { AgentClient, AgentClientError, COMMANDS, MAX_INPUT, errorResult, parseObject } = require("./agent-client.js");
const { diagnoseMarker, MARKER_TEMPLATES } = require("./marker-schema.js");

const HELP = {
  ok: true,
  usage: "node core/cli.js <command> [id] [--home DIR] [--server LOOPBACK_HTTP_ORIGIN] [--file FILE | --json OBJECT | --stdin] [--field VALUE]",
  commands: [...Object.keys(COMMANDS), "validate"],
  notes: [
    "JSON is read from piped stdin automatically unless --file or --json is supplied. Flags override JSON fields.",
    "Use --id or a positional UUID for read/context. Use --message-id for ack.",
    "validate runs offline against the shared marker schema (no running server or config needed) and returns structured field hints.",
    "coordinate transfers or reclaims task coordination between paired desks.",
    "Hyphenated field flags map to snake_case. --checkpoint, --artifacts, --assignment, --binding, --manifest, --constraints, --skills and --ack accept JSON.",
    "--needs-forward [true|false] is boolean; --seq and --assignment-epoch are integers. --timeout is milliseconds.",
    "Errors are JSON on stdout with a nonzero exit code. ACK is a receipt, not task acceptance/completion.",
    "assign accepts --prompt (max 20000 characters) or JSON prompt/message. Use --file or --stdin for multiline text. Read the returned assignment_message_id to copy or resend without reassigning.",
    "The agent key is read only from config.json; no --key option and no state.json writes.",
  ],
};
const GLOBALS = new Set(["home", "server", "file", "json", "timeout"]);
const FIELDS = new Set([
  "id", "request_id", "project", "project_id", "agent", "session_id", "message_id", "task_id", "event_id", "seq",
  "state", "execution_state", "assignment_epoch", "epoch", "previous_session_id", "previous_device_id", "device_id", "coordinator_device_id", "target_device_id", "origin_device_id", "delivery_target", "role", "adapter",
  "title", "task", "prompt", "to", "from", "phase", "waiting_for", "note", "reason", "result", "message", "ref", "needs_forward", "ack",
  "checkpoint", "artifacts", "assignment", "binding", "repo", "branch", "commit", "report", "manifest", "next_step", "constraints", "skills",
]);
const JSON_FIELDS = new Set(["checkpoint", "artifacts", "assignment", "binding", "manifest", "constraints", "skills"]);

function fieldValue(name, value) {
  if (["assignment_epoch", "epoch", "seq"].includes(name)) {
    if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new AgentClientError("INVALID_ARGUMENT", `${name} must be a safe integer.`);
    }
    return Number(value);
  }
  if (name === "needs_forward") {
    if (!["true", "false"].includes(value)) throw new AgentClientError("INVALID_ARGUMENT", "needs_forward must be true or false.");
    return value === "true";
  }
  if (JSON_FIELDS.has(name) || (name === "ack" && value.trim().startsWith("["))) {
    try { return JSON.parse(value); }
    catch { throw new AgentClientError("INVALID_JSON", `Invalid JSON for ${name}.`); }
  }
  return value;
}

function parseArguments(argv, { mcp = false } = {}) {
  const options = {};
  const fields = {};
  const positions = [];
  const seen = new Set();
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") { help = true; continue; }
    if (!token.startsWith("--")) {
      if (token.startsWith("-")) throw new AgentClientError("INVALID_ARGUMENT", "Use long --field options.");
      positions.push(token);
      continue;
    }
    const equal = token.indexOf("=");
    const name = token.slice(2, equal < 0 ? undefined : equal).replace(/-/g, "_");
    const globalName = name.replace(/_/g, "-");
    if (name === "stdin") {
      if (mcp || equal >= 0 || seen.has(name)) throw new AgentClientError("INVALID_ARGUMENT", "Invalid --stdin option.");
      seen.add(name);
      options.stdin = true;
      continue;
    }
    const global = GLOBALS.has(globalName);
    if ((!global && (mcp || !FIELDS.has(name))) || (mcp && ["file", "json"].includes(globalName))) {
      throw new AgentClientError("INVALID_ARGUMENT", "Unknown or unsupported option.");
    }
    if (seen.has(name)) throw new AgentClientError("INVALID_ARGUMENT", "Duplicate option.");
    seen.add(name);
    let value = equal < 0 ? undefined : token.slice(equal + 1);
    if (value === undefined) {
      if (name === "needs_forward" && (i + 1 >= argv.length || argv[i + 1].startsWith("--"))) value = "true";
      else {
        value = argv[++i];
        if (value === undefined || value.startsWith("--")) throw new AgentClientError("INVALID_ARGUMENT", "Option requires a value (use --field=value for values beginning with --).");
      }
    }
    if (global) {
      if (globalName === "timeout") {
        if (!/^\d+$/.test(value)) throw new AgentClientError("INVALID_TIMEOUT", "Timeout must be an integer in milliseconds.");
        options.timeout = Number(value);
      } else options[globalName] = value;
    } else fields[name] = fieldValue(name, value);
  }
  if (mcp) {
    if (positions.length) throw new AgentClientError("INVALID_ARGUMENT", "MCP accepts only --home, --server and --timeout.");
    return { options, help };
  }
  const command = positions.shift();
  if (command === "help") help = true;
  if (!help && (!command || (!Object.hasOwn(COMMANDS, command) && command !== "validate"))) {
    throw new AgentClientError("UNKNOWN_COMMAND", "Choose inbox, read, ack, submit, status, handoff, context, assign, transition, coordinate or validate; use --help.");
  }
  if (positions.length) {
    if (!["read", "context"].includes(command) || positions.length !== 1 || fields.id !== undefined) {
      throw new AgentClientError("INVALID_ARGUMENT", "Only read/context accept one positional id.");
    }
    fields.id = positions[0];
  }
  if ([options.file !== undefined, options.json !== undefined, options.stdin === true].filter(Boolean).length > 1) {
    throw new AgentClientError("INVALID_ARGUMENT", "Choose only one of --file, --json and --stdin.");
  }
  return { command, options, fields, help };
}

async function readInput(options, stdin) {
  if (options.json !== undefined) return parseObject(options.json);
  if (options.file !== undefined) {
    try {
      if (fs.statSync(options.file).size > MAX_INPUT) throw new AgentClientError("INPUT_TOO_LARGE", "JSON input exceeds 256 KiB.");
      return parseObject(fs.readFileSync(options.file, "utf8"));
    } catch (error) {
      if (error instanceof AgentClientError) throw error;
      throw new AgentClientError("INPUT_UNAVAILABLE", "Cannot read the JSON input file.");
    }
  }
  if (!options.stdin && stdin.isTTY) return {};
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_INPUT) throw new AgentClientError("INPUT_TOO_LARGE", "JSON input exceeds 256 KiB.");
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof AgentClientError) throw error;
    throw new AgentClientError("INPUT_UNAVAILABLE", "Cannot read JSON stdin.");
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? parseObject(text) : {};
}

async function runCli(argv = process.argv.slice(2), { stdin = process.stdin, stdout = process.stdout } = {}) {
  try {
    const { command, options, fields, help } = parseArguments(argv);
    if (help) { stdout.write(`${JSON.stringify(HELP)}\n`); return 0; }
    const input = { ...await readInput(options, stdin), ...fields };
    if (command === "validate") {
      const diag = diagnoseMarker(input, fields.project || "");
      if (diag.not_a_marker) {
        stdout.write(`${JSON.stringify({ ok: false, errors: [{ code: "NOT_A_MARKER", field: "agent/state", expected: ["agent", "state"], hint: "Укажите хотя бы agent и state.", retryable: false, message: "Файл не распознан как маркер Agent Desk." }], templates: Object.keys(MARKER_TEMPLATES) })}\n`);
        return 1;
      }
      const out = { ok: diag.ok, project: diag.project, seq: diag.seq, task_id: diag.task_id || null, errors: diag.errors };
      stdout.write(`${JSON.stringify(out)}\n`);
      return diag.ok ? 0 : 1;
    }
    const client = new AgentClient(options);
    const value = await client.execute(command, input);
    stdout.write(`${JSON.stringify(value)}\n`);
    return 0;
  } catch (error) {
    stdout.write(`${JSON.stringify(errorResult(error))}\n`);
    return 1;
  }
}

if (require.main === module) runCli().then((code) => { process.exitCode = code; });
module.exports = { runCli, parseArguments, readInput, HELP };
