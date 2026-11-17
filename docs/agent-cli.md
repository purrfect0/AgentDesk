# Agent Desk CLI and MCP

The CLI and MCP stdio server use the same read-only credential loader and local HTTP client. They never import `Desk`, watch mail roots, edit `state.json`, or start a LAN listener. Agent Desk must already be running.

## Credentials and destination

Configuration is read from `--home DIR`, then `AGENT_DESK_HOME`, otherwise `~/AgentDesk/config.json`. Only `port` and the **separate `agent_key`** are used. There is no owner/pairing-key fallback, key flag, automatic config creation, or repair of malformed config. Obtain the local agent key through Agent Desk's local setup; do not paste credentials in checkpoints, tool arguments, or shell history.

The default destination is `http://127.0.0.1:<config.port>` (8098 if no port is configured). `--server` accepts only a plain HTTP loopback origin: `127.0.0.1`, `localhost`, or `[::1]`, optionally with a port. `localhost` is pinned to `127.0.0.1` without DNS lookup. Credentials, paths, query strings, fragments, HTTPS, LAN addresses and remote names are rejected. Requests use no proxy, do not follow redirects, and never retry writes automatically. Every request carries `X-Agent-Desk-Agent-Key`; POST also carries `X-Agent-Desk: 1`.

## CLI

From `agent-desk/`:

```text
node core/cli.js --help
node core/cli.js inbox --project Example --agent Astra --session-id session-1
node core/cli.js read <message-or-task-UUID>
node core/cli.js status
node core/cli.js context <task-UUID>
node core/cli.js ack --project Example --agent Astra --session-id session-1 --message-id <message-UUID>
node core/cli.js submit --file marker.json
node core/cli.js validate --file marker.json
node core/cli.js assign --file assignment.json
node core/cli.js transition --file transition.json
node core/cli.js handoff --file handoff.json
node core/cli.js coordinate --file coordinate.json
```

JSON input: pipe one object to stdin, supply `--stdin`, use `--file FILE`, or `--json '{...}'`. Choose one input source. In an interactive terminal, omitted input means an empty object; redirected stdin is read until EOF. Field flags override JSON fields. `read` and `context` also accept `--id UUID`. Unknown/duplicate flags and unsupported GET fields fail rather than being silently ignored.

Hyphenated flags become snake_case (`--session-id`, `--assignment-epoch`, `--device-id`, etc.). `--seq`, `--epoch` and `--assignment-epoch` parse safe integers; `--needs-forward` is boolean (bare flag means true). `--checkpoint`, `--artifacts`, `--assignment`, `--binding`, `--manifest`, `--constraints`, `--skills` parse JSON. `--ack` accepts a string or JSON array. Use an input object/file for complex or future API fields; nested checkpoint fields are not synthesized from top-level `--repo`/`--report` flags.

Limits: JSON input/request 256 KiB, HTTP response 2 MiB, config 1 MiB, total HTTP deadline 10 seconds. Override the deadline with `--timeout MS` (1–120000). Timeouts can happen after a write reaches the server: inspect status/current assignment before retrying.

Successful output is the API JSON object on stdout and exit status 0. Failures are one JSON object on stdout and exit status 1:

```json
{"ok":false,"error":{"code":"HTTP_ERROR","message":"Stale assignment_epoch; reload the task and use its current assignment","status":409}}
```

Do not treat ACK as completion. `delivered_at`, `acked_at`, `forwarded_at` and task execution state are independent. Use immutable message/task UUIDs, not local display IDs, for the agent API. Assigned markers/reports must retain their project, recipient `agent`, device/session identity, and current `assignment_epoch`. The server validates assignment ownership and rejects retired sessions. No client-side state bypass exists.

Example creation payload (`assignment.json`; assignment on an existing task must include its current `task_id` and `assignment_epoch`):

```json
{
  "project":"Example",
  "title":"Review the synthetic change",
  "prompt":"Review the diff and report findings. Preserve unrelated changes.",
  "assignment":{"agent":"Astra","device_id":"device-id","session_id":"session-1","role":"reviewer","adapter":"manual"},
  "checkpoint":{"report":"Review scope only","next_step":"Read the diff; do not launch commands from metadata","constraints":["Use approved local repository roots"]}
}
```

Assignment accepts `prompt` (or `message`) up to 20,000 characters, also available as `--prompt`. Prefer `--file` or stdin for multiline text. Oversized text is rejected, never silently clipped; the UTF-8 message envelope is limited to 58,000 bytes to reserve space for receipts. Marker limits are `message` 20,000, `note` 1,000, `result` 400 and `task` 500 characters; rejected markers retain their text in the bad-marker archive.

Assignment/handoff creates one owner-queue message per `task_id` and `assignment.epoch`, and returns `assignment_message_id`. `read <assignment_message_id>` returns `todo.forward_text`: the complete prompt plus identity/ACK instructions. Reading and copying do not mark it forwarded or received. To resend unchanged text, read the same message; do not call `assign` again. A new assignment increments the epoch and retires the prior message while retaining its receipts. `inbox` filters assignment messages by the local device and optional recipient session. A receipt for a report addressed to a lead uses the recipient's session, not the worker's task session, and does not accept the task.

Transition payload includes `task_id`, `project`, `agent`, `device_id`, `session_id`, `assignment_epoch` and `execution_state` (`assigned|working|submitted|accepted|rework|blocked`); allowed transitions/review authority are decided by the server. Handoff includes task identity/current epoch, the new recipient assignment, and optionally checkpoint/artifacts. Assignment/handoff are coordinator-device-only. `launch.status = needs_manual_launch` is not proof that an agent was launched. Context includes verification checks; absent proof is not a successful remote push claim.

### Routes

| Command | HTTP |
| --- | --- |
| inbox | GET `/api/agent/inbox?project=&agent=&session_id=` |
| read | GET `/api/agent/read?id=` |
| ack | POST `/api/agent/ack` |
| submit | POST `/api/agent/submit` |
| status | GET `/api/agent/status` |
| assign | POST `/api/agent/task/assign` |
| transition | POST `/api/agent/task/transition` |
| handoff | POST `/api/agent/task/handoff` |
| coordinate | POST `/api/agent/task/coordinate` |
| context | GET `/api/agent/context?id=` |
| validate | Offline local validation (`core/marker-schema.js`, no HTTP call) |

There are intentionally no broad admin, mail-root configuration or unscoped `/api/tasks/*` client routes.

## MCP

Official maintained SDK, stable npm metadata checked 2026-11-16:

- `@modelcontextprotocol/sdk@1.32.2` — official `modelcontextprotocol/typescript-sdk`, high-level `McpServer` and `StdioServerTransport`.
- `zod@4.6.7` — direct schema dependency (`zod/v4`).

The wrapper uses the official SDK for initialization, schemas, framing, tool listing/calls and transport. No hand-written JSON-RPC exists.

Entrypoint: `node core/mcp.js [--home DIR] [--server LOOPBACK_HTTP_ORIGIN] [--timeout MS]`. Eleven tools: `agent_desk_inbox`, `agent_desk_read`, `agent_desk_ack`, `agent_desk_submit`, `agent_desk_status`, `agent_desk_handoff`, `agent_desk_context`, `agent_desk_assign`, `agent_desk_transition`, `agent_desk_coordinate`, `agent_desk_validate`. Read-only tools (including offline `agent_desk_validate`) are annotated accordingly. Mutation schemas preserve structured metadata and delegate final validation to the HTTP API. Tool results include JSON text and `structuredContent`; operational failures set `isError: true` with the same error envelope.

Example MCP host configuration (replace paths; **do not include the key**):

```json
{
  "mcpServers": {
    "agent-desk": {
      "command":"node",
      "args":["C:\\path\\agent-desk\\core\\mcp.js","--home","C:\\path\\AgentDesk"]
    }
  }
}
```

stdout is exclusively the SDK stdio transport. Startup errors/help go to stderr, errors exit nonzero. Missing SDK is a clear `MCP_SDK_MISSING` error, not a fallback custom implementation. MCP tool arguments cannot override the server, credentials, or config directory.

## Verification and integration

```text
node --check core/agent-client.js
node --check core/cli.js
node --check core/mcp.js
node --test --test-reporter=spec core/test/cli.test.js
```

Tests use only temporary synthetic configs/state and loopback mock HTTP. They exercise every route/header, stdin/file/flag input, metadata/epoch preservation, stdout errors and exit codes, immutable config/state, no owner-key fallback, unsafe destinations/redirects, decoded credential echo redaction, total timeout and size limits, and MCP registration/client-layer errors. The optional **official SDK stdio list/call smoke** activates when dependencies are installed; otherwise it is explicitly skipped. Rerun after installing dependencies to verify real MCP framing/stdio.

Package owner integration: add CLI/MCP entrypoint scripts or bins as desired, include `core/agent-client.js`, `core/cli.js`, `core/mcp.js` and runtime dependencies in build files, and include `core/test/cli.test.js` in the test runner. No optional `serve` command was added: this wrapper does not start or change Agent Desk server exposure.
