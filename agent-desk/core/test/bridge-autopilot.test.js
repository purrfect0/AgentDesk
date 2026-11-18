"use strict";
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { Desk } = require("../desk.js");
const { parseTranscriptTail } = require("../bridge.js");
const { runCli } = require("../cli.js");

const tempDirs = [];
const desks = [];

function mkDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

afterEach(async () => {
  while (desks.length) {
    try { await desks.pop().stop(); } catch { /* ignore */ }
  }
  while (tempDirs.length) {
    try { fs.rmSync(tempDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

async function runCliCapture(argv, stdinText = "") {
  let out = "";
  const code = await runCli(argv, {
    stdin: Readable.from(stdinText ? [stdinText] : []),
    stdout: { write: (chunk) => { out += chunk; } },
  });
  return { code, stdout: out };
}

describe("Live Chat Bridge, Zero-Touch Autopilot Relay & Workflow Fixes (2.4.0)", () => {
  it("parses Antigravity and Codex JSONL transcripts and redacts secrets", () => {
    const dir = mkDir("ad-transcripts-");
    const agDir = path.join(dir, "brain", "conv-ag-1", ".system_generated", "logs");
    fs.mkdirSync(agDir, { recursive: true });
    const agFile = path.join(agDir, "transcript.jsonl");
    fs.writeFileSync(agFile, [
      JSON.stringify({ step_index: 1, type: "USER_INPUT", content: "<USER_REQUEST>\nПроверь модуль ключа sk-1234567890abcdefghijklmnop\n</USER_REQUEST>", created_at: "2026-11-18T10:00:00Z" }),
      JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", content: "Проверил, все тесты зелёные.", tool_calls: [{ name: "run_command" }], created_at: "2026-11-18T10:01:00Z" }),
    ].join("\n") + "\n");

    const parsedAg = parseTranscriptTail(agFile, "", ["custom-agent-secret-token"]);
    assert.equal(parsedAg.provider, "antigravity");
    assert.equal(parsedAg.session_id, "conv-ag-1");
    assert.equal(parsedAg.turns.length, 2);
    assert.equal(parsedAg.turns[0].text.includes("sk-1234567890"), false);
    assert.match(parsedAg.turns[0].text, /\[REDACTED\]/);
    assert.equal(parsedAg.last_assistant_text, "Проверил, все тесты зелёные.");

    const cxFile = path.join(dir, "rollout-2026-11-18-11111111-2222-4333-8444-555555555555.jsonl");
    fs.writeFileSync(cxFile, [
      JSON.stringify({ type: "session_meta", payload: { id: "11111111-2222-4333-8444-555555555555", cwd: "C:\\Repo\\Demo" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>skip</environment_context>" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Сделай ревью патча AIzaSyA12345678901234567890" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Ревью готово: замечаний нет." }] } }),
    ].join("\n") + "\n");

    const parsedCx = parseTranscriptTail(cxFile);
    assert.equal(parsedCx.provider, "codex");
    assert.equal(parsedCx.session_id, "11111111-2222-4333-8444-555555555555");
    assert.equal(parsedCx.turns.length, 2);
    assert.equal(parsedCx.turns[0].text.includes("AIzaSyA"), false);
    assert.equal(parsedCx.last_assistant_text, "Ревью готово: замечаний нет.");
  });

  it("relays tasks via Antigravity & Codex hooks, enforces circuit breaker, and fails open when offline", async () => {
    const home = mkDir("ad-hook-home-");
    const fakeUserHome = mkDir("ad-fake-user-");
    const agLogs = path.join(fakeUserHome, ".gemini", "antigravity", "brain", "ag-conv-42", ".system_generated", "logs");
    fs.mkdirSync(agLogs, { recursive: true });
    const agTranscript = path.join(agLogs, "transcript.jsonl");
    fs.writeFileSync(agTranscript, JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", content: "Готов к приёму задач." }) + "\n");

    const alerts = [];
    const desk = new Desk({
      dataDir: home,
      legacyDir: null,
      port: 0,
      lan: false,
      bridge: { homeDir: fakeUserHome },
      log() {},
    });
    desk.on("alert", (a) => alerts.push(a));
    desks.push(desk);
    await desk.start();
    desk.config.port = desk.boundPort;
    desk._updateConfig({ autopilot: { enabled: true, watch_chats: true, codex_cli_enabled: false, max_relays_per_task: 2 } }, { local: true });

    // Create task for Carbon (Antigravity)
    const task = desk.tasks.assign({
      project: "AutoProj",
      title: "Автоматическая передача",
      prompt: "Выполни шаг 1 и отчитайся Codex.",
      agent: "Carbon",
      session_id: "ag-conv-42",
    });

    // 1. Antigravity Stop hook picks up task (relay #1 of 2) and returns decision="continue"
    const stopRes1 = await runCliCapture(
      ["hook", "--home", home, "--provider=antigravity", "--agent=Carbon", "--project=AutoProj"],
      JSON.stringify({ hookEventName: "Stop", conversationId: "ag-conv-42", transcriptPath: agTranscript, continuationActive: false }),
    );
    assert.equal(stopRes1.code, 0);
    const out1 = JSON.parse(stopRes1.stdout);
    assert.equal(out1.decision, "continue");
    assert.match(out1.reason, /Выполни шаг 1/);

    // Continuation guard: if continuationActive=true, Stop hook never loops
    const guardRes = await runCliCapture(
      ["hook", "--home", home, "--provider=antigravity", "--agent=Carbon", "--project=AutoProj"],
      JSON.stringify({ hookEventName: "Stop", conversationId: "ag-conv-42", transcriptPath: agTranscript, continuationActive: true }),
    );
    assert.deepEqual(JSON.parse(guardRes.stdout), {});

    // 2. Carbon submits report to Codex -> Codex Stop hook picks it up (relay #2 of 2) with decision="block"
    await runCliCapture(["submit", "--home", home], JSON.stringify({
      project: "AutoProj",
      agent: "Carbon",
      session_id: "ag-conv-42",
      assignment_epoch: 1,
      task_id: task.task_id,
      state: "done",
      execution_state: "submitted",
      to: "Codex",
      message: "Шаг 1 готов, проверь.",
    }));

    const codexStop = await runCliCapture(
      ["hook", "--home", home, "--provider=codex", "--agent=Codex", "--project=AutoProj"],
      JSON.stringify({ hook_event_name: "Stop", session_id: "cx-sess-1", stop_hook_active: false }),
    );
    assert.equal(codexStop.code, 0);
    const cxOut = JSON.parse(codexStop.stdout);
    assert.equal(cxOut.decision, "block");
    assert.match(cxOut.reason, /Шаг 1 готов/);

    // 3. Codex sends rework back to Carbon -> relay #3 hits max_relays_per_task=2 circuit breaker!
    desk.tasks.transition({
      task_id: task.task_id,
      project: "AutoProj",
      agent: "Carbon",
      device_id: desk.config.device_id,
      session_id: "ag-conv-42",
      assignment_epoch: 1,
      state: "rework",
      note: "Поправь форматирование",
    });
    const breakerRes = await runCliCapture(
      ["hook", "--home", home, "--provider=antigravity", "--agent=Carbon", "--project=AutoProj"],
      JSON.stringify({ hookEventName: "Stop", conversationId: "ag-conv-42", continuationActive: false }),
    );
    assert.deepEqual(JSON.parse(breakerRes.stdout), {});
    assert.ok(desk.state.tasks[task.task_id].autopilot_paused_reason);
    assert.ok(alerts.some((a) => a.kind === "limit" && /Автопилот остановлен/.test(a.title)));

    // Live chat session is visible on loopback /api/chats and blocked (403) on non-local phone scope
    const chatsRes = await fetch(`http://127.0.0.1:${desk.boundPort}/api/chats`);
    assert.equal(chatsRes.status, 200);
    const chatsJson = await chatsRes.json();
    assert.ok(chatsJson.sessions.some((s) => s.session_id === "ag-conv-42" && s.last_assistant_text === "Готов к приёму задач."));

    // 4. Fail-open when Desk is stopped: hook exits 0 with "{}" and never breaks agent execution
    await desk.stop();
    const offlineHook = await runCliCapture(
      ["hook", "--home", home, "--provider=antigravity", "--agent=Carbon", "--timeout=300"],
      JSON.stringify({ hookEventName: "Stop", conversationId: "ag-conv-42" }),
    );
    assert.equal(offlineHook.code, 0);
    assert.deepEqual(JSON.parse(offlineHook.stdout), {});
  });

  it("wakes sleeping agent via `wait`, dispatches codex-cli queue, and enforces bind/self_started/rework/accepted cleanup", async () => {
    const home = mkDir("ad-wait-home-");
    const codexCalls = [];
    const desk = new Desk({
      dataDir: home,
      legacyDir: null,
      port: 0,
      lan: false,
      adapters: {
        codexCli: {
          runner: (bin, args) => {
            codexCalls.push({ bin, args });
            return { status: 0, stdout: "queued" };
          },
        },
      },
      log() {},
    });
    desks.push(desk);
    await desk.start();
    desk.config.port = desk.boundPort;
    desk._updateConfig({ autopilot: { enabled: true, watch_chats: false, codex_cli_enabled: true, max_relays_per_task: 6 } }, { local: true });

    // 1. Coordinator registers cleanly via `bind` (0 dummy todos!)
    const bindRes = await runCliCapture(["bind", "--home", home, "--project=Flow", "--agent=CarbonLead", "--session-id=lead-s1", "--role=coordinator"]);
    assert.equal(bindRes.code, 0);
    assert.equal(desk.state.todos.length, 0);

    // 2. Self-started task on Lead starts in `working` and creates 0 open owner-queue todos
    const selfRes = await runCliCapture(["assign", "--home", home, "--project=Flow", "--title=Lead plan", "--agent=CarbonLead", "--session-id=lead-s1", "--role=coordinator", "--self-started"]);
    assert.equal(selfRes.code, 0);
    const selfTask = JSON.parse(selfRes.stdout);
    assert.equal(selfTask.state, "working");
    assert.equal(desk.state.todos.filter((t) => !t.done_at).length, 0);

    // 3. Assigning a Codex worker with codex-cli adapter auto-dispatches `codex queue --resume` immediately!
    const workerRes = await runCliCapture([
      "assign", "--home", home, "--project=Flow", "--title=Implement parser",
      "--agent=Codex", "--session-id=codex-thread-99", "--adapter=codex-cli", "--prompt=Напиши парсер.",
    ]);
    assert.equal(workerRes.code, 0);
    const workerTask = JSON.parse(workerRes.stdout);
    assert.equal(codexCalls.length, 1);
    assert.equal(codexCalls[0].args[0], "queue");
    assert.ok(codexCalls[0].args.includes("codex-thread-99"));
    assert.ok(codexCalls[0].args.includes("--resume"));

    // 4. CarbonLead sleeps on `wait` -> wakes up the instant Codex submits report!
    const waitPromise = runCliCapture(["wait", "--home", home, "--project=Flow", "--agent=CarbonLead", "--wait-seconds=10"]);
    await new Promise((r) => setTimeout(r, 120));
    await runCliCapture(["submit", "--home", home], JSON.stringify({
      project: "Flow",
      agent: "Codex",
      session_id: "codex-thread-99",
      assignment_epoch: 1,
      task_id: workerTask.task_id,
      state: "done",
      execution_state: "submitted",
      ack: workerTask.assignment_message_id,
      to: "CarbonLead",
      message: "Парсер готов, тесты 10/10.",
    }));
    const waitDone = await waitPromise;
    assert.equal(waitDone.code, 0);
    const waitJson = JSON.parse(waitDone.stdout);
    assert.equal(waitJson.arrived, true);
    assert.match(waitJson.forward_text, /Парсер готов/);

    // 5. CarbonLead requests rework using its `bind` coordinator actor -> publishes rework message & auto-pushes to Codex!
    const reworkRes = await runCliCapture(["transition", "--home", home], JSON.stringify({
      task_id: workerTask.task_id,
      project: "Flow",
      assignment_epoch: 1,
      state: "rework",
      note: "Добавь тест на пустой файл",
      actor: { agent: "CarbonLead", device_id: desk.config.device_id, session_id: "lead-s1" },
    }));
    assert.equal(reworkRes.code, 0, reworkRes.stdout);
    assert.equal(codexCalls.length, 2, "rework message must also auto-dispatch to Codex thread");

    // 6. Codex resubmits -> CarbonLead accepts -> all open todos for workerTask are retired cleanly!
    await runCliCapture(["submit", "--home", home], JSON.stringify({
      project: "Flow",
      agent: "Codex",
      session_id: "codex-thread-99",
      assignment_epoch: 1,
      task_id: workerTask.task_id,
      state: "done",
      execution_state: "submitted",
      to: "CarbonLead",
      message: "Добавил тест на пустой файл.",
    }));
    assert.equal(desk.state.todos.filter((t) => t.task_id === workerTask.task_id && !t.done_at).length, 1);

    const acceptRes = await runCliCapture(["transition", "--home", home], JSON.stringify({
      task_id: workerTask.task_id,
      project: "Flow",
      assignment_epoch: 1,
      state: "accepted",
      note: "Проверено, принято",
      actor: { agent: "CarbonLead", device_id: desk.config.device_id, session_id: "lead-s1" },
    }));
    assert.equal(acceptRes.code, 0, acceptRes.stdout);
    assert.equal(
      desk.state.todos.filter((t) => t.task_id === workerTask.task_id && !t.done_at).length,
      0,
      "accepting a task must retire its open report reminder so owner queue stays clean",
    );
  });
});
