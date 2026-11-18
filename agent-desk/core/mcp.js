#!/usr/bin/env node
"use strict";
/** Official MCP SDK stdio server; every tool is a thin local AgentClient call. */
const { AgentClient, AgentClientError, errorResult } = require("./agent-client.js");
const { parseArguments } = require("./cli.js");
const { diagnoseMarker, MARKER_TEMPLATES } = require("./marker-schema.js");
const PKG_VERSION = require("../package.json").version;

const DESCRIPTIONS = Object.freeze({
  inbox: "List local agent inbox messages and tasks, optionally filtered by project, agent and session_id.",
  read: "Read a message or task by its immutable UUID. Reading is not ACK or task completion.",
  ack: "Acknowledge receipt of one message_id for its project/recipient/session. This does NOT accept or complete a task.",
  submit: "Submit a structured agent marker through the authenticated API. Keep task_id, session_id and assignment_epoch for assigned work; stale assignments are rejected by the server.",
  status: "Read task, binding and device status from the local Agent Desk server.",
  handoff: "Explicit coordinator-only task handoff. Send task_id, assignment_epoch, recipient/binding and structured checkpoint/artifacts. A returned needs_manual_launch status is not a launched runtime.",
  context: "Read task context and bounded local verification checks by task UUID. Verification is evidence, not a claim that code was remotely pushed.",
  assign: "Assign on the coordinator device with title, full prompt (max 20000 characters) and recipient agent/device/session/role/adapter. Creates an owner-queue message; returns assignment_message_id for read/ACK. Assigning or copying is not delivery. Do not repeat assign to resend: read the existing assignment_message_id.",
  transition: "Transition task execution state independently of mailbox receipts. Send task_id, assignment_epoch and session_id; do not treat ACK as accepted/done.",
  coordinate: "Transfer or reclaim coordinator authority for a task across paired Agent Desk devices.",
  bind: "Register an explicit coordinator, reviewer, or worker session binding for a project without creating a dummy task.",
  wait: "Long-poll up to 25 seconds per call for un-acknowledged inbox messages addressed to an agent/project/session.",
  validate: "Validate an agent marker offline against the shared Agent Desk schema (state, waiting_for, field limits, checkpoint keys) without network or state writes.",
});

function toolSchemas(z) {
  const text = () => z.string().min(1).max(2000);
  const optionalText = () => text().optional();
  const epoch = () => z.number().int().nonnegative().optional();
  const metadata = () => z.object({}).passthrough().optional();
  const assignment = () => z.object({
    agent: optionalText(), device_id: optionalText(), session_id: optionalText(), role: optionalText(), adapter: optionalText(), epoch: epoch(),
  }).passthrough().optional();
  const taskMutation = () => z.object({
    task_id: optionalText(), id: optionalText(), project_id: optionalText(), project: optionalText(), title: optionalText(), task: optionalText(),
    prompt: z.string().min(1).max(20000).optional(), message: z.string().min(1).max(20000).optional(),
    agent: optionalText(), device_id: optionalText(), session_id: optionalText(), role: optionalText(), adapter: optionalText(),
    assignment_epoch: epoch(), previous_session_id: optionalText(), previous_device_id: optionalText(), state: optionalText(), execution_state: optionalText(),
    self_started: z.boolean().optional(),
    assignment: assignment(), binding: metadata(), checkpoint: metadata(), artifacts: z.array(z.unknown()).optional(),
  }).passthrough();
  return {
    inbox: z.object({ project: optionalText(), agent: optionalText(), session_id: optionalText() }).strict(),
    read: z.object({ id: text() }).strict(),
    ack: z.object({ project: text(), agent: text(), message_id: text(), session_id: optionalText(), assignment_epoch: epoch() }).strict(),
    submit: z.object({
      project: text(), agent: text(), state: text(), task_id: optionalText(), project_id: optionalText(),
      session_id: optionalText(), device_id: optionalText(), assignment_epoch: epoch(), execution_state: optionalText(),
      task: optionalText(), title: optionalText(), to: optionalText(), from: optionalText(), phase: optionalText(), waiting_for: optionalText(),
      message_id: optionalText(), event_id: optionalText(), seq: z.number().int().nonnegative().optional(),
      note: z.string().max(1000).optional(), result: z.string().max(400).optional(), message: z.string().max(20000).optional(),
      needs_forward: z.boolean().optional(), ack: z.union([text(), z.array(text())]).optional(),
      checkpoint: metadata(), artifacts: z.array(z.unknown()).optional(),
    }).passthrough(),
    status: z.object({}).strict(),
    handoff: taskMutation(),
    context: z.object({ id: text() }).strict(),
    assign: taskMutation(),
    transition: taskMutation(),
    coordinate: z.object({
      task_id: optionalText(), id: optionalText(), target_device_id: optionalText(), coordinator_device_id: optionalText(),
      assignment_epoch: epoch(), request_id: optionalText(), note: z.string().max(1000).optional(),
    }).passthrough(),
    bind: z.object({
      project: text(), agent: text(), session_id: text(),
      device_id: optionalText(), role: optionalText(), adapter: optionalText(),
    }).passthrough(),
    wait: z.object({
      project: optionalText(), agent: optionalText(), session_id: optionalText(), wait: optionalText(),
    }).strict(),
    validate: z.object({
      project: optionalText(), agent: optionalText(), state: optionalText(), waiting_for: optionalText(),
      execution_state: optionalText(), task_id: optionalText(), project_id: optionalText(), session_id: optionalText(),
      device_id: optionalText(), assignment_epoch: epoch(), seq: z.number().int().nonnegative().optional(),
      task: optionalText(), result: optionalText(), note: optionalText(), message: z.string().max(25000).optional(),
      checkpoint: metadata(), artifacts: z.array(z.unknown()).optional(),
    }).passthrough(),
  };
}

async function callAgentTool(client, command, args = {}) {
  try {
    if (command === "validate") {
      const diag = diagnoseMarker(args, args?.project || "");
      const value = diag.not_a_marker
        ? { ok: false, errors: [{ code: "NOT_A_MARKER", field: "agent/state", expected: ["agent", "state"], hint: "Укажите хотя бы agent и state.", retryable: false, message: "Объект не распознан как маркер Agent Desk." }], templates: Object.keys(MARKER_TEMPLATES) }
        : { ok: diag.ok, project: diag.project, seq: diag.seq, task_id: diag.task_id || null, errors: diag.errors };
      return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
    }
    const value = await client.execute(command, args);
    return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
  } catch (error) {
    const value = errorResult(error);
    return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: true };
  }
}

function registerAgentTools(server, client, z) {
  const schemas = toolSchemas(z);
  for (const [command, description] of Object.entries(DESCRIPTIONS)) {
    const readOnly = ["inbox", "read", "status", "context", "wait", "validate"].includes(command);
    server.registerTool(`agent_desk_${command}`, {
      title: `Agent Desk: ${command}`,
      description,
      inputSchema: schemas[command],
      annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: false },
    }, (args) => callAgentTool(client, command, args));
  }
  return server;
}

function loadSdk() {
  try {
    return {
      McpServer: require("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
      StdioServerTransport: require("@modelcontextprotocol/sdk/server/stdio.js").StdioServerTransport,
      z: require("zod/v4").z,
    };
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") {
      throw new AgentClientError("MCP_SDK_MISSING", "Install official @modelcontextprotocol/sdk@1.32.2 and zod@4.6.7 before starting MCP.");
    }
    throw new AgentClientError("MCP_SDK_UNAVAILABLE", "The official MCP SDK could not be loaded.");
  }
}

async function startMcp(options = {}) {
  const client = new AgentClient(options);
  const { McpServer, StdioServerTransport, z } = loadSdk();
  const server = new McpServer({ name: "agent-desk", version: PKG_VERSION }, { maxToolInputElements: 10000 });
  registerAgentTools(server, client, z);
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 512 * 1024 }));
  return server;
}

async function main() {
  const { options, help } = parseArguments(process.argv.slice(2), { mcp: true });
  if (help) {
    process.stderr.write("Agent Desk MCP: node core/mcp.js [--home DIR] [--server LOOPBACK_HTTP_ORIGIN] [--timeout MS]\nTools: agent_desk_{inbox,read,ack,submit,status,handoff,context,assign,transition,coordinate,bind,wait,validate}\n");
    return;
  }
  const server = await startMcp(options);
  const close = () => { server.close().catch(() => {}).finally(() => { process.exitCode = 0; }); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (require.main === module) main().catch((error) => {
  // stdout belongs exclusively to the SDK transport, including on startup failure.
  process.stderr.write(`${JSON.stringify(errorResult(error))}\n`);
  process.exitCode = 1;
});
module.exports = { startMcp, registerAgentTools, callAgentTool, toolSchemas, DESCRIPTIONS };
