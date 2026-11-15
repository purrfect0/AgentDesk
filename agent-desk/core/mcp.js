#!/usr/bin/env node
"use strict";
/** Official MCP SDK stdio server; every tool is a thin local AgentClient call. */
const { AgentClient, AgentClientError, errorResult } = require("./agent-client.js");
const { parseArguments } = require("./cli.js");

const DESCRIPTIONS = Object.freeze({
  inbox: "List local agent inbox messages and tasks, optionally filtered by project, agent and session_id.",
  read: "Read a message or task by its immutable UUID. Reading is not ACK or task completion.",
  ack: "Acknowledge receipt of one message_id for its project/recipient/session. This does NOT accept or complete a task.",
  submit: "Submit a structured agent marker through the authenticated API. Keep task_id, session_id and assignment_epoch for assigned work; stale assignments are rejected by the server.",
  status: "Read task, binding and device status from the local Agent Desk server.",
  handoff: "Explicit coordinator-only task handoff. Send task_id, assignment_epoch, recipient/binding and structured checkpoint/artifacts. A returned needs_manual_launch status is not a launched runtime.",
  context: "Read task context and bounded local verification checks by task UUID. Verification is evidence, not a claim that code was remotely pushed.",
  assign: "Explicit coordinator-only assignment through Agent Desk. Send task identity and recipient agent/device/session/role/adapter; preserve server assignment epoch rules.",
  transition: "Transition task execution state independently of mailbox receipts. Send task_id, assignment_epoch and session_id; do not treat ACK as accepted/done.",
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
    agent: optionalText(), device_id: optionalText(), session_id: optionalText(), role: optionalText(), adapter: optionalText(),
    assignment_epoch: epoch(), previous_session_id: optionalText(), previous_device_id: optionalText(), state: optionalText(), execution_state: optionalText(),
    assignment: assignment(), binding: metadata(), checkpoint: metadata(), artifacts: z.array(z.unknown()).optional(),
  }).passthrough();
  return {
    inbox: z.object({ project: optionalText(), agent: optionalText(), session_id: optionalText() }).strict(),
    read: z.object({ id: text() }).strict(),
    ack: z.object({ project: text(), agent: text(), message_id: text(), session_id: optionalText() }).strict(),
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
  };
}

async function callAgentTool(client, command, args = {}) {
  try {
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
    const readOnly = ["inbox", "read", "status", "context"].includes(command);
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
  const server = new McpServer({ name: "agent-desk", version: "1.0.0" }, { maxToolInputElements: 10000 });
  registerAgentTools(server, client, z);
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 512 * 1024 }));
  return server;
}

async function main() {
  const { options, help } = parseArguments(process.argv.slice(2), { mcp: true });
  if (help) {
    process.stderr.write("Agent Desk MCP: node core/mcp.js [--home DIR] [--server LOOPBACK_HTTP_ORIGIN] [--timeout MS]\nTools: agent_desk_{inbox,read,ack,submit,status,handoff,context,assign,transition}\n");
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
