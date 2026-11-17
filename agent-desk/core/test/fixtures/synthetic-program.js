"use strict";
/**
 * Deterministic synthetic control fixtures for CP0-CP5 verification and A/B benchmarks.
 * Contains zero live keys, zero real user paths, and zero private prompt contents.
 */
const crypto = require("node:crypto");
const { stableId } = require("../../sync.js");

const SYNTHETIC_DEVICES = Object.freeze({
  coordinator: "1111111111111111",
  workerLaptop: "2222222222222222",
});

function deterministicUuid(tag) {
  return stableId(`synthetic-fixture:${tag}`);
}

/**
 * Synthetic control 1: "Ret -> monday.com -> Carbon" 3-epoch handoff chain
 * with two stale senders (epoch 1 Ret, epoch 2 monday.com), retry and restart.
 */
function buildRetMondayCarbonScenario() {
  const projectId = deterministicUuid("project:ssjc-synthetic");
  const taskId = deterministicUuid("task:at-42-synthetic");
  return {
    project: "Synthetic-SSJC",
    project_id: projectId,
    task_id: taskId,
    title: "Synthetic AT-42: стабилизация очереди и передача контекста",
    epochs: [
      {
        epoch: 1,
        agent: "Ret",
        device_id: SYNTHETIC_DEVICES.coordinator,
        session_id: "ret-synth-20261118-s1",
        role: "executor",
        adapter: "manual",
        prompt: "Этап 1 (синтетика): первичный разбор карточки и сбор базовых фактов.",
      },
      {
        epoch: 2,
        agent: "monday.com",
        device_id: SYNTHETIC_DEVICES.workerLaptop,
        session_id: "monday-synth-20261118-s2",
        role: "executor",
        adapter: "manual",
        prompt: "Этап 2 (синтетика): проверка промежуточного состояния перед передачей в Carbon.",
      },
      {
        epoch: 3,
        agent: "Carbon",
        device_id: SYNTHETIC_DEVICES.coordinator,
        session_id: "carbon-synth-20261118-s3",
        role: "executor",
        adapter: "manual",
        prompt: "Этап 3 (синтетика): финальная реализация, идемпотентность и проверка рестарта.\r\nСтрока 2 с кириллицей и проверкой пробелов.",
      },
    ],
  };
}

/**
 * Synthetic control 2: Historical snapshot with 216 tasks (207 unmanaged legacy assigned + 9 explicit/active),
 * 150 todos, 500 events, and 9 rejected markers (6 waiting_for, 2 state, 1 device_id).
 */
function buildHistoricalSnapshot216(deviceId = SYNTHETIC_DEVICES.coordinator) {
  const projectId = deterministicUuid("project:hist-synthetic");
  const tasks = {};
  const taskCardIds = {};
  const todos = [];
  const events = [];

  for (let i = 1; i <= 207; i++) {
    const messageId = deterministicUuid(`legacy-todo:${i}`);
    const taskId = stableId(`legacy-task:${messageId}`);
    const iso = new Date(Date.UTC(2026, 10, 1, 0, i % 60, 0)).toISOString();
    tasks[taskId] = {
      task_id: taskId,
      project_id: projectId,
      project: "HistProject",
      title: `Историческое напоминание #${i}`,
      state: "assigned",
      coordinator_device_id: deviceId,
      assignment: {
        agent: i % 2 === 0 ? "Astra" : "Opus (1)",
        device_id: deviceId,
        session_id: "",
        epoch: 1,
        role: "legacy",
        adapter: "manual",
      },
      checkpoint: { next_step: "Сверьте прежний отчёт и явно назначьте текущую сессию." },
      artifacts: [],
      history: [],
      managed_assignment: false,
      created: iso,
      updated: iso,
      launch: {
        status: "needs_manual_launch",
        adapter: "manual",
        reason: "Старая запись: устройство/сессию исполнителя нужно подтвердить.",
      },
    };
    taskCardIds[taskId] = `AT-${i}`;
    if (i <= 141) {
      todos.push({
        id: i,
        display_id: `AD-${i}`,
        kind: "forward",
        project: "HistProject",
        project_id: projectId,
        agent: "Codex",
        to: i % 2 === 0 ? "Astra" : "Opus (1)",
        task: `Историческое напоминание #${i}`,
        task_id: taskId,
        message: `Синтетический архивный отчёт #${i}`,
        message_id: messageId,
        origin_device_id: deviceId,
        created: iso,
        updated: iso,
        forwarded_at: iso,
        acked_at: iso,
        done_at: iso,
        receipt_epoch: 0,
        auto: true,
      });
    }
  }

  const managedSpecs = [
    { idx: 208, state: "assigned", acked: false, forwarded: false, agent: "Carbon" },
    { idx: 209, state: "assigned", acked: false, forwarded: true, agent: "Astra" },
    { idx: 210, state: "working", acked: true, forwarded: true, agent: "Carbon" },
    { idx: 211, state: "working", acked: true, forwarded: true, agent: "Hoplite" },
    { idx: 212, state: "submitted", acked: true, forwarded: true, agent: "Opus (1)" },
    { idx: 213, state: "rework", acked: true, forwarded: true, agent: "Opus (2)" },
    { idx: 214, state: "blocked", acked: true, forwarded: true, agent: "Astra" },
    { idx: 215, state: "accepted", acked: true, forwarded: true, agent: "Carbon" },
    { idx: 216, state: "accepted", acked: true, forwarded: true, agent: "Ret" },
  ];

  let nextTodoId = 142;
  for (const spec of managedSpecs) {
    const taskId = deterministicUuid(`managed-task:${spec.idx}`);
    const messageId = stableId(`assignment:${taskId}:1`);
    const iso = new Date(Date.UTC(2026, 10, 17, 12, spec.idx - 200, 0)).toISOString();
    const todoId = nextTodoId++;
    tasks[taskId] = {
      task_id: taskId,
      project_id: projectId,
      project: "HistProject",
      title: `Явная управляемая задача #${spec.idx}`,
      prompt: `Полный синтетический промпт управляемой задачи #${spec.idx}`,
      state: spec.state,
      coordinator_device_id: deviceId,
      assignment_message_id: messageId,
      assignment: {
        agent: spec.agent,
        device_id: deviceId,
        session_id: `session-${spec.idx}`,
        epoch: 1,
        role: "executor",
        adapter: "manual",
      },
      checkpoint: { next_step: "Проверить синтетический шаг" },
      artifacts: [],
      history: [{ time: iso, kind: "assign", from_state: "assigned", state: spec.state, agent: spec.agent, device_id: deviceId, session_id: `session-${spec.idx}`, assignment_epoch: 1 }],
      managed_assignment: true,
      created: iso,
      updated: iso,
      launch: { status: "needs_manual_launch", adapter: "manual", reason: "Manual launch" },
    };
    taskCardIds[taskId] = `AT-${spec.idx}`;
    todos.push({
      id: todoId,
      display_id: `AD-${todoId}`,
      kind: "forward",
      purpose: "assignment",
      assignment_epoch: 1,
      recipient_session_id: `session-${spec.idx}`,
      recipient_device_id: deviceId,
      project: "HistProject",
      project_id: projectId,
      agent: "Владелец",
      to: spec.agent,
      task: `Явная управляемая задача #${spec.idx}`,
      task_id: taskId,
      message: `Полный синтетический промпт управляемой задачи #${spec.idx}`,
      message_id: messageId,
      origin_device_id: deviceId,
      created: iso,
      updated: iso,
      forwarded_at: spec.forwarded ? iso : null,
      acked_at: spec.acked ? iso : null,
      done_at: spec.acked ? iso : null,
      receipt_epoch: 0,
      auto: spec.acked,
    });
  }

  for (let e = 1; e <= 500; e++) {
    const iso = new Date(Date.UTC(2026, 10, 15, 0, 0, e)).toISOString();
    events.push({
      project: "HistProject",
      agent: e % 2 === 0 ? "Carbon" : "Astra",
      state: "working",
      waiting_for: "",
      phase: "testing",
      task: `Событие #${e}`,
      session: `sess-${(e % 5) + 1}`,
      seq: e,
      event_id: `synth-ev-${e}`,
      device_id: deviceId,
      time: iso,
      received: iso,
    });
  }

  const invalidMarkerSamples = [
    ...Array.from({ length: 6 }, (_, i) => ({
      name: `bad-waiting-${i + 1}.json`,
      raw: JSON.stringify({ project: "HistProject", agent: "Astra", state: "waiting", waiting_for: `human_approval_${i + 1}`, seq: i + 1 }),
    })),
    ...Array.from({ length: 2 }, (_, i) => ({
      name: `bad-state-${i + 1}.json`,
      raw: JSON.stringify({ project: "HistProject", agent: "Opus (1)", state: i === 0 ? "completed" : "running", seq: 10 + i }),
    })),
    {
      name: "bad-device-1.json",
      raw: JSON.stringify({
        project: "HistProject",
        project_id: projectId,
        agent: "Carbon",
        state: "working",
        execution_state: "working",
        task_id: deterministicUuid("managed-task:210"),
        assignment_epoch: 1,
        session_id: "session-210",
        device_id: "9999999999999999",
        seq: 99,
      }),
    },
  ];

  return {
    state: {
      agents: {},
      todos,
      tasks,
      bindings: {},
      task_card_ids: taskCardIds,
      next_task_card_id: 217,
      events,
      seen_ids: events.map((e) => e.event_id),
      alerts: [],
      rejected: [],
      next_id: nextTodoId,
      alert_seq: 0,
      version: 1,
    },
    invalidMarkerSamples,
  };
}

/**
 * Synthetic control 3: Deterministic N-task multilingual workload (200 / 1000 tasks) for CP4 A/B benchmarks.
 */
function buildScaleWorkload(count = 200, deviceId = SYNTHETIC_DEVICES.coordinator) {
  const projects = ["AlphaDesk", "BetaPort", "GammaSync", "DeltaCore"];
  const agents = ["Carbon", "Codex", "Astra", "Hoplite", "Opus (1)", "Opus (2)"];
  const states = ["assigned", "working", "submitted", "rework", "blocked", "accepted"];
  const rows = [];
  for (let i = 0; i < count; i++) {
    const project = projects[i % projects.length];
    const projectId = deterministicUuid(`scale-project:${project}`);
    const taskId = deterministicUuid(`scale-task:${count}:${i}`);
    const agent = agents[i % agents.length];
    const state = states[i % states.length];
    const uniqueToken = `UNIQTOKEN_${count}_${String(i).padStart(4, "0")}`;
    const paragraph = [
      `Задание #${i + 1} (${project}) для ${agent} — маркер поиска ${uniqueToken}.`,
      "Русский блок: проверить целостность пересылки, идемпотентный ACK, сохранность истории и отсутствие ложных закрытий.",
      "English block: deterministic synthetic benchmark payload with structured context, UTF-8 byte budget checks, and zero external secrets.",
      "多语言测试区块：验证长提示词在高频轮询与增量同步下的字节开销、搜索响应时间与内存稳定性 🚀📦🔍.",
    ].join("\r\n");
    // ~6.5 KB per prompt (~1.3 MB for 200 tasks raw, ~3.9 MB tripled; ~19.5 MB tripled for 1000 tasks)
    const repeated = Array.from({ length: 14 }, (_, k) => `[Раздел ${k + 1}/${14}] ${paragraph}`).join("\r\n\r\n");
    rows.push({
      index: i,
      project,
      project_id: projectId,
      task_id: taskId,
      agent,
      state,
      device_id: deviceId,
      session_id: `scale-sess-${i}`,
      unique_token: uniqueToken,
      title: `Синтетическая задача масштаба #${i + 1} [${uniqueToken}]`,
      prompt: repeated,
      prompt_bytes: Buffer.byteLength(repeated, "utf8"),
    });
  }
  return rows;
}

module.exports = {
  SYNTHETIC_DEVICES,
  deterministicUuid,
  buildRetMondayCarbonScenario,
  buildHistoricalSnapshot216,
  buildScaleWorkload,
};
