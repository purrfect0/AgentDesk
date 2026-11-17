"use strict";
/**
 * Single source of truth for Agent Desk marker schemas, field limits, templates,
 * preflight validation, and structured rejection diagnostics.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MARKER_STATES = Object.freeze(["working", "waiting", "done", "blocked", "idle"]);
const MARKER_WAITING_FOR = Object.freeze([
  "owner_input", "owner_forward", "reviewer", "coordinator_review", "resource", "model_limit", "assignment",
]);
const MARKER_EXECUTION_STATES = Object.freeze([
  "assigned", "working", "submitted", "accepted", "rework", "blocked", "cancelled", "archived",
]);
const MARKER_LIMITS = Object.freeze({
  message: 20000,
  note: 1000,
  result: 400,
  task: 500,
});

const MARKER_TEMPLATES = Object.freeze({
  working_ack: {
    project: "<Project>",
    project_id: "<project-UUID>",
    agent: "<Agent>",
    session_id: "<session-id>",
    device_id: "<device-id>",
    task_id: "<task-UUID>",
    assignment_epoch: 1,
    seq: 1,
    state: "working",
    execution_state: "working",
    task: "<Краткое название задачи>",
    ack: ["<assignment-message-UUID>"],
    note: "Начал выполнение по актуальному назначению",
  },
  submit_report: {
    project: "<Project>",
    project_id: "<project-UUID>",
    agent: "<Agent>",
    session_id: "<session-id>",
    device_id: "<device-id>",
    task_id: "<task-UUID>",
    assignment_epoch: 1,
    seq: 2,
    state: "done",
    execution_state: "submitted",
    to: "<CoordinatorOrReviewer>",
    task: "<Краткое название задачи>",
    message: "Краткий готовый отчёт для пересылки ведущему/ревьюеру",
    result: "docs/report.md",
  },
  owner_question: {
    project: "<Project>",
    agent: "<Agent>",
    session_id: "<session-id>",
    seq: 3,
    state: "waiting",
    waiting_for: "owner_input",
    task: "<Краткое название задачи>",
    message: "Короткий вопрос владельцу для принятия решения",
  },
  model_limit: {
    project: "<Project>",
    agent: "<Agent>",
    session_id: "<session-id>",
    seq: 4,
    state: "waiting",
    waiting_for: "model_limit",
    task: "<Краткое название задачи>",
    note: "Достигнут лимит модели; нужна смена сессии",
  },
});

function extractSafeMeta(rawText, folderProject = "") {
  let project = String(folderProject || "").trim().slice(0, 60);
  let seq = null;
  let taskId = "";
  try {
    const parsed = typeof rawText === "string" ? JSON.parse(rawText.replace(/^\uFEFF/, "")) : rawText;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (!project && typeof parsed.project === "string") project = parsed.project.trim().slice(0, 60);
      if (Number.isSafeInteger(Number(parsed.seq)) && parsed.seq !== "" && parsed.seq !== null && parsed.seq !== undefined) {
        seq = Number(parsed.seq);
      }
      if (typeof parsed.task_id === "string" && UUID_RE.test(parsed.task_id.trim())) taskId = parsed.task_id.trim().toLowerCase();
    }
  } catch { /* broken JSON */ }
  return { project, seq, task_id: taskId };
}

function diagnoseMarker(input, folderProject = "") {
  const meta = extractSafeMeta(input, folderProject);
  let data;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input.replace(/^\uFEFF/, ""));
    } catch (e) {
      return {
        ok: false,
        not_a_marker: false,
        ...meta,
        errors: [{
          code: "INVALID_JSON",
          field: "json",
          expected: ["UTF-8 JSON object"],
          hint: "Проверьте синтаксис JSON (кавычки, запятые) и атомарную запись через .tmp -> .json.",
          retryable: false,
          message: `Некорректный JSON маркера: ${e.message}`,
        }],
      };
    }
  } else {
    data = input;
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      ok: false,
      not_a_marker: false,
      ...meta,
      errors: [{
        code: "NOT_OBJECT",
        field: "root",
        expected: ["JSON object {...}"],
        hint: "Маркер должен быть одним JSON-объектом, а не массивом или примитивом.",
        retryable: false,
        message: "маркер должен быть JSON-объектом",
      }],
    };
  }

  if (!("agent" in data) && !("state" in data)) {
    return { ok: false, not_a_marker: true, ...meta, errors: [] };
  }

  const errors = [];
  for (const [field, limit] of Object.entries(MARKER_LIMITS)) {
    if (data[field] !== undefined && data[field] !== null && (typeof data[field] !== "string" || data[field].length > limit)) {
      errors.push({
        code: "FIELD_TOO_LONG",
        field,
        expected: [`string <= ${limit} chars`],
        hint: `Сократите поле ${field} до ${limit} символов или передайте материалы отдельным файлом.`,
        retryable: false,
        message: `${field}: максимум ${limit} символов; текст не принят, сократите его или передайте файл отдельно`,
      });
    }
  }

  const project = String(folderProject || data.project || "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (!project) {
    errors.push({
      code: "MISSING_PROJECT",
      field: "project",
      expected: ["non-empty project name"],
      hint: "Укажите поле project в маркере или настройте проект у папки маркеров.",
      retryable: false,
      message: "не задан проект: укажите проект у папки («Файл → Папки с маркерами») или поле project",
    });
  }

  const agent = String(data.agent ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (!agent) {
    errors.push({
      code: "MISSING_AGENT",
      field: "agent",
      expected: ["non-empty agent name"],
      hint: "Укажите постоянное имя агента в поле agent.",
      retryable: false,
      message: "поле agent обязательно",
    });
  }

  const state = String(data.state ?? "").trim().slice(0, 20).toLowerCase();
  if (!MARKER_STATES.includes(state)) {
    errors.push({
      code: "INVALID_STATE",
      field: "state",
      expected: [...MARKER_STATES],
      hint: "Для работы используйте working, для ожидания — waiting, для сдачи результата — state='done' и execution_state='submitted'.",
      retryable: false,
      message: `state должен быть одним из: ${MARKER_STATES.join(", ")}`,
    });
  }

  const waitingFor = String(data.waiting_for ?? "").trim().slice(0, 40).toLowerCase();
  if (waitingFor && !MARKER_WAITING_FOR.includes(waitingFor)) {
    errors.push({
      code: "INVALID_WAITING_FOR",
      field: "waiting_for",
      expected: [...MARKER_WAITING_FOR],
      hint: "Используйте допустимую причину ожидания: owner_input (вопрос владельцу), owner_forward (нужна пересылка), reviewer, coordinator_review, resource или model_limit.",
      retryable: false,
      message: `waiting_for должен быть одним из: ${MARKER_WAITING_FOR.join(", ")}`,
    });
  }

  for (const idField of ["task_id", "project_id"]) {
    const val = String(data[idField] ?? "").trim();
    if (val && !UUID_RE.test(val)) {
      errors.push({
        code: "INVALID_UUID",
        field: idField,
        expected: ["RFC 4122 UUID"],
        hint: `Поле ${idField} должно содержать глобальный UUID (не локальный номер AD/AT).`,
        retryable: false,
        message: `${idField} должен быть UUID`,
      });
    }
  }

  const execState = String(data.execution_state ?? "").trim().slice(0, 30);
  if (execState && !MARKER_EXECUTION_STATES.includes(execState)) {
    errors.push({
      code: "INVALID_EXECUTION_STATE",
      field: "execution_state",
      expected: [...MARKER_EXECUTION_STATES],
      hint: "Используйте execution_state из списка: assigned, working, submitted, accepted, rework, blocked.",
      retryable: false,
      message: "неверное execution_state",
    });
  }

  if (data.assignment_epoch !== undefined && data.assignment_epoch !== null) {
    if (!Number.isSafeInteger(data.assignment_epoch) || data.assignment_epoch < 1) {
      errors.push({
        code: "INVALID_EPOCH",
        field: "assignment_epoch",
        expected: ["positive integer >= 1"],
        hint: "Укажите целое положительное число assignment_epoch из текущего задания.",
        retryable: false,
        message: "assignment_epoch must be a positive integer",
      });
    }
  }

  return {
    ok: errors.length === 0,
    not_a_marker: false,
    project: project || meta.project,
    seq: meta.seq,
    task_id: meta.task_id,
    data,
    errors,
  };
}

function classifyRuntimeRejection(error, rawText, folderProject = "", tasksMap = {}) {
  const diag = diagnoseMarker(rawText, folderProject);
  if (!diag.ok && diag.errors.length) {
    const first = diag.errors[0];
    return {
      code: first.code,
      field: first.field,
      expected: first.expected,
      hint: first.hint,
      retryable: first.retryable,
      project: diag.project,
      seq: diag.seq,
    };
  }
  const msg = String(error?.message || error || "");
  const task = diag.task_id && tasksMap ? tasksMap[diag.task_id] : null;
  if (/bound to a different device|компьютера получателя/i.test(msg)) {
    return {
      code: "DEVICE_MISMATCH",
      field: "device_id",
      expected: task?.assignment?.device_id ? [task.assignment.device_id] : ["assigned_device_id"],
      hint: "Отправьте маркер с привязанного компьютера исполнителя или запросите передачу (handoff) на это устройство.",
      retryable: false,
      project: diag.project,
      seq: diag.seq,
    };
  }
  if (/retired or different session|другой сессии/i.test(msg)) {
    return {
      code: "SESSION_MISMATCH",
      field: "session_id",
      expected: task?.assignment?.session_id ? [task.assignment.session_id] : ["assigned_session_id"],
      hint: "Сессия устарела или не совпадает с назначением: получите актуальное задание или запросите handoff.",
      retryable: false,
      project: diag.project,
      seq: diag.seq,
    };
  }
  if (/Stale assignment_epoch|прежнему назначению|Назначение изменилось/i.test(msg)) {
    return {
      code: "STALE_EPOCH",
      field: "assignment_epoch",
      expected: task?.assignment?.epoch ? [String(task.assignment.epoch)] : ["current_assignment_epoch"],
      hint: "Версия назначения устарела: перечитайте задачу через read/inbox и используйте актуальный assignment_epoch.",
      retryable: false,
      project: diag.project,
      seq: diag.seq,
    };
  }
  if (/not the assigned recipient/i.test(msg)) {
    return {
      code: "AGENT_MISMATCH",
      field: "agent",
      expected: task?.assignment?.agent ? [task.assignment.agent] : ["assigned_agent"],
      hint: "Задача сейчас назначена другому агенту; проверьте task_id или запросите переназначение.",
      retryable: false,
      project: diag.project,
      seq: diag.seq,
    };
  }
  if (/different project|неоднозначный проект/i.test(msg)) {
    return {
      code: "PROJECT_MISMATCH",
      field: "project_id",
      expected: task?.project_id ? [task.project_id] : ["matching_project_id"],
      hint: "Проверьте совпадение project и project_id с карточкой задачи.",
      retryable: false,
      project: diag.project,
      seq: diag.seq,
    };
  }
  if (/Stale marker sequence/i.test(msg)) {
    return {
      code: "STALE_SEQ",
      field: "seq",
      expected: ["integer > previous seq"],
      hint: "Создайте новый файл маркера со следующим номером seq.",
      retryable: false,
      project: diag.project,
      seq: diag.seq,
    };
  }
  if (/Cannot transition from/i.test(msg)) {
    return {
      code: "INVALID_TRANSITION",
      field: "execution_state",
      expected: ["valid next lifecycle state"],
      hint: "Переход из текущего состояния задачи недопустим; сверьте актуальное состояние через status/read.",
      retryable: false,
      project: diag.project,
      seq: diag.seq,
    };
  }
  if (/58 000|60,000|exceeds/i.test(msg)) {
    return {
      code: "ENVELOPE_TOO_LARGE",
      field: "message",
      expected: ["<= 58000 UTF-8 bytes envelope"],
      hint: "Сократите текст сообщения/checkpoint или вынесите длинный отчёт в файл.",
      retryable: false,
      project: diag.project,
      seq: diag.seq,
    };
  }
  return {
    code: "MARKER_REJECTED",
    field: "marker",
    expected: ["valid marker matching task contract"],
    hint: "Исправьте причину отказа в новом событии маркера; отклонённый файл сохранён без изменений.",
    retryable: false,
    project: diag.project,
    seq: diag.seq,
  };
}

module.exports = {
  MARKER_STATES,
  MARKER_WAITING_FOR,
  MARKER_EXECUTION_STATES,
  MARKER_LIMITS,
  MARKER_TEMPLATES,
  diagnoseMarker,
  classifyRuntimeRejection,
};
