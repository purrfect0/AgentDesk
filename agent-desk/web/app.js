"use strict";

const STATE_LABEL = {
  working: "работает",
  waiting: "ждёт ответа",
  done: "закончил",
  blocked: "заблокирован",
  idle: "свободен",
};
const STATE_ICON = {
  working: "application_hourglass-1",
  waiting: "msg_question-2",
  done: "check-1",
  blocked: "msg_error-2",
  idle: "computer-1",
  stale: "msg_warning-2",
};
const WAIT_LABEL = {
  owner_input: "ждёт вашего ответа",
  owner_forward: "ждёт пересылки",
  reviewer: "ждёт ревью",
  coordinator_review: "ждёт приёмки ведущим",
  resource: "ждёт телефон/сервер",
  model_limit: "закончился лимит модели",
};
const TODO_ICON = { forward: "envelope_closed-1", reply: "msg_question-2", blocked: "msg_error-2", limit: "msg_warning-2" };
const stateLabel = (a) => (a.state === "waiting" && WAIT_LABEL[a.waiting_for]) || STATE_LABEL[a.state] || a.state;
// Forwarded-but-unconfirmed reminders stay visible but no longer need the owner.
// Delivery/ACK receipts are quiet telemetry, never owner actions or task acceptance.
const needsAction = (t) => !t.done_at && !t.superseded_by && !t.quiet && !["receipt", "ack", "delivery"].includes(t.kind) && !(t.kind === "forward" && (t.forwarded_at || t.acked_at || (t.delivery_target && data?.device_id && t.delivery_target !== data.device_id)));
const isForwardPending = (t) => t && !t.done_at && t.kind === "forward";
const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
// Accent animations: --ph keeps the blink phase tied to the clock (12 s fits the 1 s and 2.4 s
// cycles), --age starts the "flash 8 times" from the moment the thing appeared, so the 2 s redraws
// do not restart them.
const accent = (sinceIso) => {
  const now = Date.now();
  const since = Date.parse(sinceIso) || now;
  return `--ph:-${now % 12000}ms;--age:-${Math.max(0, now - since)}ms`;
};
// An agent that needs the owner or is not reachable: blocked, out of model limit, silent too long, waiting for you.
const agentNeedsYou = (a) => a.state === "blocked" || (a.state === "waiting" && ["owner_input", "owner_forward", "model_limit"].includes(a.waiting_for));

let data = null;
let project = localStorage.getItem("ad.project") || "*";
let tab = ["agents", "log", "tasks", "mail"].includes(localStorage.getItem("ad.view")) ? localStorage.getItem("ad.view") : "agents";
let selected = (() => {
  try {
    const raw = localStorage.getItem("ad.selected");
    const parsed = raw && JSON.parse(raw);
    return parsed && typeof parsed === "object" && ["todo", "agent"].includes(parsed.type) ? parsed : null;
  } catch { return null; }
})(); // {type: "todo"|"agent", id, message_id?, task_id?}
let showClosed = localStorage.getItem("ad.closed") === "1";
let soundOn = localStorage.getItem("ad.sound") !== "0";
let appVolume = Number(localStorage.getItem("ad.volume") ?? 70);
let seenAlerts = null;
let online = true;
let lastUpdated = null;
let dialogReturnFocus = null;
let phoneNotify = localStorage.getItem("ad.phoneNotify") !== "0";
let todoFilter = "action";
let todoSearch = "";
let todoMenuId = null;
let taskFilter = "all";
let taskSearch = "";
let taskRenderLimit = 60;
const promptDrafts = new Map();
const todoHasCopyableText = (t) => Boolean(t && (t.message || t.has_message));
let serverSearchState = { q: "", todoIds: null, taskIds: null };
let searchAbort = null;
function utf8Bytes(str) {
  const s = String(str ?? "");
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s).length;
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}
function estimatePromptEnvelopeBytes(rawPrompt, t) {
  const cpJson = t?.checkpoint ? JSON.stringify(t.checkpoint) : "{}";
  return utf8Bytes(JSON.stringify(String(rawPrompt ?? ""))) + utf8Bytes(cpJson) + 950;
}
const plain = (html) => { const d = document.createElement("div"); d.innerHTML = html; return d.textContent; };

const $ = (sel) => document.querySelector(sel);
const icon = (name) => `icons/${name}.png`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// --- in-place redraw ------------------------------------------------------------
// The tables are redrawn every 2 s. Replacing them through innerHTML recreated every <img>, and
// the icons blinked while they loaded again. patch() compares the new markup with the page and
// touches only what changed. Rows are matched by data-key. An element whose data-since changed is
// replaced, so its accent animation starts over; otherwise its style (the animation phase) stays.
const tpl = document.createElement("template");
const ROW_PARENTS = new Set(["TABLE", "TBODY", "THEAD", "TR", "MENU", "UL", "OL"]);
const isEl = (n) => n.nodeType === Node.ELEMENT_NODE;
const isBlank = (n) => n.nodeType === Node.TEXT_NODE && !n.nodeValue.trim();
const keyOf = (n) => (isEl(n) && n.dataset.key) || "";

function patch(parent, html) {
  tpl.innerHTML = html;
  patchChildren(parent, tpl.content);
  tpl.innerHTML = "";
}

function patchChildren(parent, src) {
  const rows = ROW_PARENTS.has(parent.nodeName); // whitespace between rows and cells means nothing there
  const fresh = [...src.childNodes].filter((n) => !(rows && isBlank(n)));
  const wanted = new Set(fresh.map(keyOf).filter(Boolean));
  const keyed = new Map();
  for (const n of [...parent.childNodes]) {
    const key = keyOf(n);
    if ((rows && isBlank(n)) || (key && !wanted.has(key))) n.remove();
    else if (key) keyed.set(key, n);
  }
  let at = parent.firstChild;
  for (const nn of fresh) {
    const key = keyOf(nn);
    let old = key ? keyed.get(key) : ((at && !keyOf(at) && at.nodeName === nn.nodeName) ? at : null);
    if (key) keyed.delete(key);
    if (old && isEl(old) && old.dataset.since !== nn.dataset.since) {
      if (old === at) at = at.nextSibling;
      old.remove();
      old = null;
    }
    if (!old) {
      parent.insertBefore(nn, at);
      continue;
    }
    if (old === at) at = at.nextSibling;
    else parent.insertBefore(old, at);
    patchNode(old, nn);
  }
  while (at) {
    const next = at.nextSibling;
    at.remove();
    at = next;
  }
}

function patchNode(old, nn) {
  if (!isEl(old)) {
    if (old.nodeValue !== nn.nodeValue) old.nodeValue = nn.nodeValue;
    return;
  }
  const keepStyle = "since" in old.dataset; // data-since is the same here, the animation keeps its phase
  for (const { name, value } of [...nn.attributes]) {
    if (name === "style" && keepStyle && old.hasAttribute("style")) continue;
    // The selection belongs to applySelection(); keeping it here stops a selected row from flashing.
    const v = name === "class" && old.classList.contains("highlighted") ? `${value} highlighted`.trim() : value;
    if (old.getAttribute(name) !== v) old.setAttribute(name, v);
  }
  for (const { name } of [...old.attributes]) {
    if (old.nodeName === "DETAILS" && name === "open") continue; // disclosure belongs to the reader, not polling
    if (!nn.hasAttribute(name)) old.removeAttribute(name);
  }
  if (old.innerHTML !== nn.innerHTML) patchChildren(old, nn);
}

function ago(iso) {
  const t = Date.parse(iso);
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "только что";
  if (s < 3600) return `${Math.floor(s / 60)} мин`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч`;
  return new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}
const hhmm = (iso) => new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

function isStale(a) {
  return a.state === "working" && Date.now() - Date.parse(a.updated) > data.config.stale_minutes * 60000;
}

function todoText(t) {
  const who = `<b>${esc(t.agent)}</b>`;
  if (t.kind === "forward") {
    const handled = t.forwarded_at || t.acked_at || t.done_at || (t.delivery_target && data?.device_id && t.delivery_target !== data.device_id);
    return handled ? `Сообщение для <b class="to">${esc(t.to)}</b> от ${who}` : `Переслать <b class="to">${esc(t.to)}</b> работу от ${who}`;
  }
  if (t.kind === "reply") return `${who} ждёт вашего ответа`;
  if (t.kind === "limit") return `${who}: закончился лимит модели`;
  return `${who} заблокирован`;
}

function todoStatus(t) {
  if (t.kind === "forward" && t.acked_at) {
    const ackAge = ago(t.acked_at);
    return `получено агентом${t.to ? ` (${esc(t.to)})` : ""}${ackAge ? ` · ${esc(ackAge)}` : ""}`;
  }
  if (t.done_at) return "закрыто";
  if (t.routing) return `отправляю → «${esc(t.routing.name)}»…`;
  if (t.kind === "forward") {
    if (t.delivery_target && t.delivery_target !== data?.device_id) {
      const targetPeer = (data?.link?.peers || []).find((p) => p.id === t.delivery_target);
      const waitAge = ago(t.delivered_at || t.created);
      if (t.delivered_at) return `доставлено на другой ПК · ожидает получения${t.to ? ` (${esc(t.to)})` : ""} (нет ACK${waitAge ? `, ${esc(waitAge)}` : ""})`;
      return targetPeer?.online === false ? "компьютер не в сети · ожидает доставки" : "ожидает доставки";
    }
    if (t.forwarded_at) {
      const waitAge = ago(t.forwarded_at);
      return `переслано · ожидает получения${t.to ? ` от ${esc(t.to)}` : ""}${waitAge ? ` (${esc(waitAge)})` : ""}`;
    }
    return t.purpose === "assignment" ? "<b>не переслано задание</b>" : "<b>не переслано</b>";
  }
  const waitAge = ago(t.created);
  const tail = waitAge ? ` <span class="sub">(${esc(waitAge)})</span>` : "";
  return { reply: `<b>ждёт ответа</b>${tail}`, limit: `<b>нужна новая сессия</b>${tail}`, blocked: `<b>нужна помощь</b>${tail}` }[t.kind] || "";
}

function fromDeviceLabel(t) {
  const fd = t?.from_device;
  if (!fd) return "";
  if (fd.id && data?.device_id && fd.id === data.device_id) return "";
  if (fd.id) {
    const label = deviceLabel(fd.id);
    if (label !== "другой компьютер" && label !== "компьютер не указан") return label;
  }
  return fd.name && !/^[0-9a-f]{16}$/i.test(fd.name) ? fd.name : "другой компьютер";
}

// PC <-> laptop (core/peers.js): which computer a reminder came from, why it was not sent.
function peerNote(t) {
  const parts = [];
  const fromName = fromDeviceLabel(t);
  if (fromName) parts.push(`с «${esc(fromName)}»`);
  if (t.send_error && !t.done_at) parts.push(`<span class="bad">не отправилось: ${esc(t.send_error)}</span>`);
  return parts.length ? ` <span class="sub peer-note">· ${parts.join(" · ")}</span>` : "";
}

// --- rendering ------------------------------------------------------------------

function allProjects() {
  const names = new Set(data.config.watch.map((w) => w.project).filter(Boolean));
  taskList().forEach((t) => names.add(t.project));
  Object.values(data.agents).forEach((a) => names.add(a.project));
  data.todos.forEach((t) => names.add(t.project));
  return [...names].filter(Boolean).sort();
}

const inProject = (x) => project === "*" || x.project === project;

// In "all projects" view every project gets its own header row, so the projects never mix.
function grouped(items, cols, row) {
  if (project !== "*") return items.map(row).join("");
  return allProjects().map((p) => {
    const part = items.filter((x) => x.project === p);
    return part.length ? `<tr class="group" data-key="g:${esc(p)}"><td colspan="${cols}">${esc(p)}</td></tr>${part.map(row).join("")}` : "";
  }).join("");
}

function render() {
  if (!data) return;
  const projects = allProjects();
  if (project !== "*" && !projects.includes(project)) project = "*";
  const openIn = (p) => data.todos.filter((t) => needsAction(t) && (p === "*" || t.project === p)).length;
  const newestIn = (p) => data.todos.filter((t) => needsAction(t) && (p === "*" || t.project === p)).map((t) => t.created).sort().pop();
  const label = (name, n, p) => {
    if (!n) return esc(name);
    const since = newestIn(p);
    return `${esc(name)} <b class="attn" data-since="${esc(since)}" style="${accent(since)}">(${n})</b>`;
  };
  patch($("#project-tabs"), [["*", "Все проекты"], ...projects.map((p) => [p, p])].map(([id, name]) =>
    `<li role="tab" tabindex="${id === project ? 0 : -1}" data-key="p:${esc(id)}" data-project="${esc(id)}" aria-selected="${id === project}"><a href="#" tabindex="-1">${label(name, openIn(id), id)}</a></li>`).join(""));

  renderTodos();

  const agents = Object.entries(data.agents).map(([key, a]) => ({ ...a, _rowKey: key })).filter(inProject)
    .sort((a, b) => a.project.localeCompare(b.project) || a.first_seen.localeCompare(b.first_seen));
  const events = data.events.filter(inProject).reverse();
  patch($("#tabs"), [["agents", "Агенты"], ["log", "Журнал"], ["tasks", "Задачи"]].map(([id, name]) =>
    `<li role="tab" id="tab-${id}" tabindex="${id === tab ? 0 : -1}" data-key="v:${id}" data-tab="${id}" aria-controls="${id}-view" aria-selected="${id === tab}"><a href="#" tabindex="-1">${name}</a></li>`).join(""));

  const showLog = tab === "log";
  $("#agents-view").classList.toggle("hidden", tab !== "agents");
  $("#log-view").classList.toggle("hidden", !showLog);
  $("#tasks-view").classList.toggle("hidden", tab !== "tasks");
  $("#mail-view").classList.toggle("hidden", tab !== "mail");
  if (tab === "tasks") renderTasks();
  if (tab === "mail") renderMail();
  $("#board-offline").classList.toggle("hidden", online);
  $("#board-offline").textContent = online ? "" : `Нет связи. Показаны последние данные${lastUpdated ? ` за ${hhmm(lastUpdated)}` : ""}; изменения недоступны.`;

  if (showLog) {
    const seen = new Map(); // two events of one agent in the same millisecond still get their own rows
    const eventKey = (e) => {
      const id = `${e.event_id || e.time}|${e.project}|${e.agent}|${e.device_id || "local"}|${e.state}`;
      seen.set(id, (seen.get(id) || 0) + 1);
      return `e:${id}#${seen.get(id)}`;
    };
    patch($("#log-table tbody"), grouped(events, 5, (e) => `
      <tr data-key="${esc(eventKey(e))}"><td class="c-ico"><img src="${icon(STATE_ICON[e.state])}" alt=""></td>
      <td class="nowrap">${hhmm(e.time)} <span class="sub">${esc(ago(e.time))}</span></td>
      <td>${esc(e.agent)}${e.device_id ? `<br><span class="sub">${esc(deviceLabel(e.device_id))}</span>` : ""}</td>
      <td class="nowrap">${esc(stateLabel(e))}${e.to ? ` → ${esc(e.to)}` : ""}${e.ack?.length ? " · подтвердил получение" : ""}</td>
      <td class="task opt" title="${esc(e.task)}">${esc(e.task)}</td></tr>`));
    $("#log-empty").classList.toggle("hidden", events.length > 0);
  } else if (tab === "agents") {
    patch($("#agent-table tbody"), grouped(agents, 5, (a) => {
      const key = a._rowKey;
      const stale = isStale(a);
      const text = esc(stale ? `${stateLabel(a)}? активность не подтверждена ${ago(a.updated)}` : stateLabel(a));
      const attn = stale || agentNeedsYou(a);
      const cls = [stale && "stale", attn && "attn"].filter(Boolean).join(" ");
      return `<tr class="${cls}" tabindex="0" data-key="a:${esc(key)}" data-agent="${esc(key)}"${attn ? ` data-since="${esc(a.updated)}" style="${accent(a.updated)}"` : ""}>
        <td class="c-ico"><img src="${icon(stale ? STATE_ICON.stale : STATE_ICON[a.state])}" alt=""></td>
        <td><b>${esc(a.agent)}</b><br><span class="sub">${esc(deviceLabel(a.device_id || data.device_id))}</span></td>
        <td class="nowrap state">${text}${a.state === "done" && a.to ? ` → ${esc(a.to)}` : ""}</td>
        <td class="task opt" title="${esc(a.task)}">${esc(a.task)}</td>
        <td class="nowrap">${esc(ago(a.updated))}</td></tr>`;
    }));
    $("#agents-empty").classList.toggle("hidden", agents.length > 0);
  }

  const count = (s) => agents.filter((a) => a.state === s).length;
  const open = openIn(project);
  const where = project === "*" ? "" : ` в ${project}`;
  $("#sb-main").textContent = online ? (open ? `Нужно сделать${where}: ${open}` : `Всё под контролем${where}`) : "Нет связи с Agent Desk на ПК";
  const quietActive = Boolean(data.config?.quiet_hours?.enabled);
  const phoneOff = Boolean(data.phone_status?.last_seen_at && !data.phone_status.connected);
  const rejCount = Number(data.pipeline?.rejected ?? data.rejected?.length ?? 0);
  const sbExtras = [
    quietActive && `тихие часы (${data.config.quiet_hours.start || "23:00"}–${data.config.quiet_hours.end || "08:00"})`,
    phoneOff && "телефон отключён",
    rejCount > 0 && `отказов: ${rejCount}`,
  ].filter(Boolean);
  $("#sb-counts").textContent = `Агентов: ${agents.length} · работают: ${count("working")} · ждут: ${count("waiting")}${sbExtras.length ? ` · ${sbExtras.join(" · ")}` : ""}`;
  $("#sb-time").textContent = lastUpdated ? `Обновлено ${hhmm(lastUpdated)}` : "Загрузка…";
  const total = openIn("*");
  const title = total ? `(${total}) Agent Desk` : "Agent Desk";
  if (document.title !== title) {
    document.title = title;
    native()?.setTitle(title);
  }

  $("#sound-check").classList.toggle("on", soundOn);
  $("#notify-check").classList.toggle("on", !!data.config.notify);
  $("#closed-check").classList.toggle("on", showClosed);
  $("#autostart-check").classList.toggle("on", !!data.config.autostart);
  $("#phone-notify-check").classList.toggle("on", phoneNotify);
  const soundState = isNative ? data.config.popup_sound !== false : soundOn;
  const soundIcon = icon(soundState ? "loudspeaker_rays-0" : "loudspeaker_muted-0");
  if ($("#tb-sound").getAttribute("src") !== soundIcon) $("#tb-sound").src = soundIcon;
  $("#popup-sound-check").classList.toggle("on", data.config.popup_sound !== false);
  const live = document.querySelector("#peers-live"); // the "Другие компьютеры" dialog is open
  if (live) patch(live, peersLive(live.dataset.pair === "1"));
  applySelection();
}

function selectTodoRef(todo) {
  if (!todo) return null;
  const ref = { type: "todo", id: todo.id, message_id: todo.message_id || "", task_id: todo.task_id || "" };
  try { localStorage.setItem("ad.selected", JSON.stringify(ref)); } catch { /* ignore */ }
  return ref;
}

function resolveSelectedTodo() {
  if (selected?.type !== "todo" || !Array.isArray(data?.todos)) return null;
  let todo = (selected.message_id && data.todos.find((t) => t.message_id === selected.message_id))
    || data.todos.find((t) => t.id === selected.id)
    || null;
  if (todo?.superseded_by && !todoMatches(todo)) {
    let cur = todo;
    const seen = new Set();
    while (cur?.superseded_by && !seen.has(cur.superseded_by)) {
      seen.add(cur.superseded_by);
      const next = data.todos.find((t) => t.message_id === cur.superseded_by);
      if (!next) break;
      cur = next;
    }
    if (cur && cur !== todo) {
      todo = cur;
      selected = selectTodoRef(cur);
    }
  } else if (todo && (selected.id !== todo.id || (!selected.message_id && todo.message_id))) {
    selected = selectTodoRef(todo);
  }
  return todo;
}

// Selection only toggles classes so rows are not replaced between the clicks of a double-click.
function applySelection() {
  const todo = resolveSelectedTodo();
  document.querySelectorAll("tr[data-todo], tr[data-agent]").forEach((tr) => {
    const on = selected && (selected.type === "todo" ? tr.dataset.todo === String(selected.id) : tr.dataset.agent === selected.id);
    tr.classList.toggle("highlighted", !!on);
  });
  $("#tb-copy").disabled = !todoHasCopyableText(todo) || !!todo?.superseded_by;
  $("#tb-forwarded").disabled = !(online && isForwardPending(todo) && !todo.forwarded_at && !todo.acked_at);
  $("#tb-done").disabled = !(online && todo && !todo.done_at);
  const peers = data.link?.peers || [];
  $("#tb-send").classList.toggle("hidden", !peers.length); // shown once another computer is paired
  $("#tb-send").disabled = !(online && todo && !todo.done_at && peers.length);
  $("#tb-details").disabled = !selected;
  const agent = selected?.type === "agent" ? data.agents[selected.id] : null;
  $("#tb-forget").disabled = !agent || (!!agent.device_id && agent.device_id !== data.device_id);
}

function agentAliasesFor(proj, agentName) {
  if (!agentName || !data?.config?.aliases) return [];
  const target = String(agentName).toLocaleLowerCase();
  const merged = { ...(data.config.aliases["*"] || {}), ...(proj ? (data.config.aliases[proj] || {}) : {}) };
  const out = [];
  for (const [alias, canonical] of Object.entries(merged)) {
    if (String(canonical).toLocaleLowerCase() === target || String(alias).toLocaleLowerCase() === target) {
      out.push(alias, canonical);
    }
  }
  return out;
}

function matchesSearch(query, values) {
  const haystack = values.filter(Boolean).join(" ").toLocaleLowerCase();
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).every(word => haystack.includes(word));
}
function todoMatches(t) {
  if (todoSearch.trim()) {
    if (data?.compact && serverSearchState.q === todoSearch.trim() && serverSearchState.todoIds?.has(t.id)) return true;
    const task = currentTask(t.task_id);
    const devId = t.recipient_device_id || t.origin_device_id || t.from_device?.id || "";
    return matchesSearch(todoSearch, [
      t.display_id, `AD-${t.id}`, t.message_id, t.task_id, t.project_id, t.ref,
      task?.card_id, task?.state, task && TASK_LABEL[task.state],
      t.task, t.project, t.agent, ...agentAliasesFor(t.project, t.agent),
      t.to, ...agentAliasesFor(t.project, t.to),
      devId, devId && deviceLabel(devId), t.from_device?.name,
      t.kind, todoStatus(t).replace(/<[^>]*>/g, " "), t.note, t.result, t.message ?? t.message_preview,
    ]);
  }
  if (!inProject(t)) return false;
  if (showClosed) return true;
  if (todoFilter === "action") return needsAction(t);
  if (todoFilter === "waiting") return !t.done_at && !t.acked_at && !needsAction(t);
  return true;
}
function ownerActionItems() {
  const todos = (data?.todos || []).filter((t) => inProject(t) && needsAction(t));
  const assignTodos = todos.filter((t) => t.kind === "forward" && t.purpose === "assignment");
  const reportTodos = todos.filter((t) => t.kind === "forward" && t.purpose !== "assignment");
  const replyTodos = todos.filter((t) => t.kind === "reply");
  const submittedTasks = taskList().filter((t) => inProject(t) && t.state === "submitted");
  const resourceAgents = Object.entries(data?.agents || {}).map(([k, a]) => ({ ...a, _rowKey: k }))
    .filter((a) => inProject(a) && a.state === "waiting" && a.waiting_for === "resource");
  return { assignTodos, reportTodos, replyTodos, submittedTasks, resourceAgents };
}
function renderOwnerActions() {
  const box = $("#owner-actions");
  if (!box || !data) return;
  const { assignTodos, reportTodos, replyTodos, submittedTasks, resourceAgents } = ownerActionItems();
  const btns = [];
  const cnt = (n) => (n > 1 ? ` (${n})` : "");
  if (assignTodos.length) btns.push(`<button type="button" data-action="quick-forward-assignment">Переслать задание${cnt(assignTodos.length)}</button>`);
  if (reportTodos.length) btns.push(`<button type="button" data-action="quick-forward-report">Переслать отчёт${cnt(reportTodos.length)}</button>`);
  if (replyTodos.length) btns.push(`<button type="button" data-action="quick-reply"${online ? "" : " disabled"}>Ответить${cnt(replyTodos.length)}</button>`);
  if (submittedTasks.length) btns.push(`<button type="button" data-action="quick-review"${online ? "" : " disabled"}>Проверить сдачу${cnt(submittedTasks.length)}</button>`);
  if (resourceAgents.length) btns.push(`<button type="button" data-action="quick-resource">Освободить ресурс${cnt(resourceAgents.length)}</button>`);
  box.classList.toggle("hidden", btns.length === 0);
  patch(box, btns.length ? `<span class="sub">Доступно:</span>${btns.join("")}` : "");
}
function cardAge(created) {
  const time = Date.parse(created);
  if (!Number.isFinite(time)) return "—";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (!minutes) return "только что";
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} ч${minutes % 60 ? ` ${minutes % 60} мин` : ""}` : `${Math.floor(hours / 24)} д${hours % 24 ? ` ${hours % 24} ч` : ""}`;
}
function todoRowTitle(t) {
  if (t.task) return t.task;
  if (t.kind === "reply") return `${t.agent} ждёт вашего ответа`;
  if (t.kind === "limit") return `${t.agent}: закончился лимит модели`;
  if (t.kind === "blocked") return `${t.agent} заблокирован`;
  if (t.kind === "forward") {
    return t.purpose === "assignment" ? `Назначение для ${t.to}` : `Переслать ${t.to} от ${t.agent}`;
  }
  return "Сообщение";
}
function renderTodos() {
  renderOwnerActions();
  const todos = data.todos.filter(todoMatches)
    .sort((a, b) => (needsAction(b) - needsAction(a)) || (!!a.done_at - !!b.done_at) || b.created.localeCompare(a.created));
  const open = data.todos.filter(t => inProject(t) && needsAction(t)).length;
  const searching = !!todoSearch.trim();
  $("#todo-filter").value = todoFilter;
  $("#todo-search-hint").hidden = !searching;
  $("#clear-todo-search").hidden = !searching;
  const name = searching ? `Найдено сообщений: ${todos.length}` : todoFilter === "waiting" ? "Ждём получения" : todoFilter === "all" || showClosed ? "Все сообщения" : project === "*" ? "Нужно сделать" : `Нужно сделать — ${project}`;
  const legend = $("#todo-legend");
  const legendText = !searching && todoFilter === "action" && !showClosed && open ? `${name} (${open})` : name;
  if (legend.textContent !== legendText) legend.textContent = legendText;
  const since = open ? todos.filter(needsAction).map((t) => t.created).sort().pop() : "";
  if (legend.dataset.since !== since) {
    // Only a newer reminder restarts the flashing; ordinary redraws leave it running.
    legend.dataset.since = since;
    legend.classList.remove("attn");
    legend.style.cssText = since ? accent(since) : "";
    if (since) {
      void legend.offsetWidth; // restart the animation
      legend.classList.add("attn");
    }
  }
  patch($("#todo-table tbody"), todos.map(t => {
    const act = needsAction(t);
    const cls = t.done_at ? "closed" : act ? `attn${t.kind === "forward" ? " attn-forward" : ""}` : "pending";
    const ico = t.kind === "forward" && t.forwarded_at ? "envelope_open_sheet-1" : TODO_ICON[t.kind];
    const task = currentTask(t.task_id);
    const card = t.purpose === "assignment" && task ? taskCardNumber(task) : t.display_id || `AD-${t.id}`;
    return `<tr class="${cls}" tabindex="0" data-key="t:${t.id}" data-todo="${t.id}" aria-haspopup="menu" aria-controls="todo-context-menu" aria-expanded="${todoMenuId === t.id}"${act ? ` data-since="${esc(t.created)}" style="${accent(t.created)}"` : ""}>
      <td class="c-ico"><img src="${icon(ico)}" alt=""></td>
      <td><code class="card-id">${esc(card)}</code><b>${esc(todoRowTitle(t))}</b><br><span class="sub">${esc(t.project)} · ${t.purpose === "assignment" ? `Назначение №${esc(t.assignment_epoch)}` : esc(t.agent)}${t.to ? ` → ${esc(t.to)}` : ""}</span>${peerNote(t)}</td>
      <td class="status">${todoStatus(t)}</td>
      <td class="todo-age"><time datetime="${esc(t.created)}" title="${esc(new Date(t.created).toLocaleString("ru-RU"))}">${esc(cardAge(t.created))}</time></td></tr>`;
  }).join(""));
  $("#todo-empty").textContent = searching ? "Ничего не найдено. Попробуйте номер карточки, имя агента или слова из задания." : todoFilter === "waiting" ? "Нет сообщений, ожидающих получения." : "Нет действий для владельца. Пересланные задания доступны в «Ждём получения», остальные — через поиск.";
  $("#todo-table").classList.toggle("hidden", todos.length === 0);
  $("#todo-empty").classList.toggle("hidden", todos.length > 0);
  if (todoMenuId !== null) {
    const todo = todos.find(t => t.id === todoMenuId);
    if (todo) renderTodoMenu(todo);
    else closeTodoMenu();
  }
}

function renderTodoMenu(todo) {
  const menu = $("#todo-context-menu");
  const copy = menu.querySelector('[data-action="copy-message"]');
  copy.disabled = !todoHasCopyableText(todo) || !!todo.superseded_by;
  copy.querySelector("span").textContent = todo.forwarded_at || todo.acked_at || todo.done_at
    ? "Переслать снова (копировать)"
    : todo.kind === "forward" && todo.purpose === "assignment"
      ? "Переслать задание (копировать)"
      : todo.kind === "forward"
        ? "Переслать отчёт (копировать)"
        : "Копировать промпт";
  menu.querySelector('[data-action="mark-forwarded"]').disabled = !(online && isForwardPending(todo) && !todo.forwarded_at && !todo.acked_at && !todo.superseded_by);
  menu.querySelector('[data-action="done-selected"]').disabled = !online || !!todo.done_at;
  for (const action of ["copy-message", "mark-forwarded", "done-selected", "todo-details"]) menu.querySelector(`[data-action="${action}"]`).dataset.todoId = String(todo.id);
}
function closeTodoMenu(restoreFocus = false) {
  if (todoMenuId === null) return;
  const row = document.querySelector(`tr[data-todo="${todoMenuId}"]`);
  $("#todo-context-menu").classList.add("hidden");
  todoMenuId = null;
  row?.setAttribute("aria-expanded", "false");
  if (restoreFocus) row?.focus({ preventScroll: true });
}
function openTodoMenu(row, x, y) {
  const todo = data?.todos.find(t => t.id === Number(row.dataset.todo));
  if (!todo) return;
  closeTodoMenu();
  document.querySelectorAll(".menu.open").forEach(menu => menu.classList.remove("open"));
  selected = selectTodoRef(todo);
  applySelection();
  row.focus({ preventScroll: true });
  todoMenuId = todo.id;
  row.setAttribute("aria-expanded", "true");
  renderTodoMenu(todo);
  const menu = $("#todo-context-menu");
  menu.style.left = "0px"; menu.style.top = "0px";
  menu.classList.remove("hidden");
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4))}px`;
  menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}
async function copySelectedTodo(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || (e.code !== "KeyC" && e.key.toLowerCase() !== "c")) return;
  if (!$("#modal-layer").classList.contains("hidden") || e.target.closest("input, textarea, select, [contenteditable]")) return;
  const selection = document.getSelection?.();
  if (selection && !selection.isCollapsed) return;
  const todo = resolveSelectedTodo();
  if (!todoHasCopyableText(todo) || todo.superseded_by || !todoMatches(todo)) return;
  e.preventDefault();
  closeTodoMenu(true);
  await ACTIONS["copy-message"]();
}

// --- linked tasks and project files ----------------------------------------------
// Preserve the established 98.css windows, inset panels, controls and quiet typography.
const TASK_LABEL = { assigned: "назначена", working: "в работе", submitted: "сдана на проверку", accepted: "принята", rework: "на доработке", blocked: "заблокирована", cancelled: "отменена", archived: "в архиве" };
const TASK_NEXT = { assigned: ["working", "submitted", "blocked", "cancelled", "archived"], working: ["submitted", "blocked", "cancelled"], submitted: ["accepted", "rework", "blocked", "cancelled"], accepted: ["rework", "archived"], rework: ["working", "submitted", "blocked", "cancelled"], blocked: ["assigned", "working", "submitted", "rework", "cancelled", "archived"], cancelled: ["rework", "archived"], archived: ["rework"] };
const listValues = (value) => Array.isArray(value) ? value : Object.values(value || {});
function taskList() {
  // Replication can briefly include duplicate snapshots; identity is never the display title.
  const byId = new Map();
  for (const t of listValues(data?.tasks)) {
    if (!t?.task_id) continue;
    const old = byId.get(t.task_id);
    if (!old || String(t.updated || "") >= String(old.updated || "")) byId.set(t.task_id, t);
  }
  return [...byId.values()];
}
const canCoordinate = (t) => online && !!data?.device_id && (!t || t.coordinator_device_id === data.device_id);
const deviceLabel = (id) => id === data?.device_id ? (data.link?.name || "этот компьютер") : (data?.link?.peers || []).find((p) => p.id === id)?.name || (id ? "другой компьютер" : "компьютер не указан");
function sessionLabel(item) {
  const a = item.assignment || item;
  const session = a.session_id || a.session;
  if (!session) return "сессия не привязана";
  const known = Object.values(data?.agents || {}).find(agent => agent.project === item.project && agent.agent === a.agent && agent.device_id === a.device_id && (agent.session_id || agent.session) === session);
  return known?.state === "working" && !isStale(known) ? `активна · ${a.agent || "агент"}` : `привязана · ${a.agent || "агент"}`;
}
function technicalDetails(item) {
  const a = item.assignment || item;
  const rows = [["task_id",item.task_id],["message_id",item.message_id],["project_id",item.project_id],["device_id",a.device_id],["session_id",a.session_id || a.session],["coordinator_device_id",item.coordinator_device_id],["assignment_epoch",a.epoch]];
  return `<details class="technical-details"><summary>Технические данные</summary><dl class="kv">${rows.filter(([,v]) => v !== undefined && v !== null && v !== "").map(([k,v]) => `<dt>${esc(k)}</dt><dd><code>${esc(v)}</code></dd>`).join("")}</dl></details>`;
}
const roleLabel = role => ({ executor: "исполнитель", reviewer: "ревьюер", coordinator: "ведущий", lead: "ведущий", legacy: "прежнее назначение" }[role] || role || "роль не задана");
const currentTask = (id) => taskList().find((t) => t.task_id === id);
const taskEpoch = (t) => Number(t?.assignment?.epoch ?? t?.assignment_epoch ?? 0);
const taskReceiptRows = (t) => (data?.todos || []).filter((r) => r.task_id === t.task_id);
function taskCardNumber(t) {
  if (t.card_id) return t.card_id;
  const row = taskReceiptRows(t).sort((a, b) => (a.id || 0) - (b.id || 0))[0];
  return row ? (row.display_id || `AD-${row.id}`) : `ID ${String(t.task_id).slice(0, 8)}`;
}
function receiptsMarkup(t) {
  const rows = taskReceiptRows(t);
  if (!rows.length) return '<span class="sub">Сообщений и квитанций пока нет.</span>';
  return rows.map((r) => `<li><code>${esc(r.display_id || `AD-${r.id}`)}</code>${r.to ? ` → ${esc(r.to)}` : ""} · ${[
    ["delivered_at", "доставлено на доску"], ["launch_dispatched_at", "отправлено в адаптер (до ACK)"], ["forwarded_at", "переслано"], ["acked_at", "ACK: получено"], ["done_at", "напоминание закрыто"]
  ].filter(([k]) => r[k]).map(([k, title]) => `<span title="${esc(r[k])}">${title}</span>`).join(" · ") || "ожидает доставки"}</li>`).join("");
}
function assignmentMessage(t) {
  return (data?.todos || []).find(r => r.message_id === t.assignment_message_id && !r.superseded_by && r.assignment_epoch === taskEpoch(t));
}
async function ensureFullTodo(todo) {
  if (!todo || todo.message !== undefined || !todo.has_message || !online) return todo;
  const r = await api(`/api/item?todo=${encodeURIComponent(todo.id)}`);
  if (r?.todo) Object.assign(todo, r.todo);
  return todo;
}
async function ensureFullTask(task) {
  if (!task || !online) return task;
  const needPrompt = task.has_prompt && task.prompt === undefined;
  const needHistory = task.history_count && (task.history || []).length < task.history_count;
  if (!needPrompt && !needHistory) return task;
  const r = await api(`/api/item?task=${encodeURIComponent(task.task_id)}`);
  if (r?.task) Object.assign(task, r.task);
  return task;
}
function scheduleServerSearch(rawQuery, onReady) {
  const q = String(rawQuery || "").trim();
  if (searchAbort) { searchAbort.abort(); searchAbort = null; }
  if (!q || !data?.compact || !online) {
    if (!q) serverSearchState = { q: "", todoIds: null, taskIds: null };
    return;
  }
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  searchAbort = ctrl;
  (async () => {
    try {
      const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
      if (ctrl?.signal?.aborted) return;
      serverSearchState = { q, todoIds: new Set(r.todo_ids || []), taskIds: new Set(r.task_ids || []) };
      onReady?.();
    } catch { /* offline or cancelled */ }
  })();
}
async function copyTaskPrompt(t, button) {
  const message = assignmentMessage(t);
  if (message) {
    try { await ensureFullTodo(message); } catch (error) { alertBox("Копирование задания", error.message, "msg_warning-2"); return false; }
    return copyPromptText(forwardText(message), button, t.assignment?.agent);
  }
  try {
    const context = await api(`/api/tasks/context?id=${encodeURIComponent(t.task_id)}`);
    if (typeof context.text !== "string" || !context.text.trim()) throw new Error("Текст задания отсутствует");
    return copyPromptText(context.text, button, t.assignment?.agent);
  } catch (error) { alertBox("Копирование задания", error.message, "msg_warning-2"); }
}
function taskOriginKind(t) {
  if (t.origin_kind) return t.origin_kind;
  if (t.managed_assignment) return "managed";
  return t.assignment?.role === "legacy" ? "migrated" : "observed";
}
function isTaskActiveUi(t) {
  if (typeof t.active_work === "boolean") return t.active_work;
  if (["accepted", "cancelled", "archived", "submitted"].includes(t.state)) return false;
  const origin = taskOriginKind(t);
  if (origin === "managed" || t.managed_assignment === undefined) return ["assigned", "working", "rework", "blocked"].includes(t.state);
  const hasOpen = taskReceiptRows(t).some(r => !r.done_at && !r.superseded_by);
  if (origin === "migrated") return t.state === "blocked" && hasOpen;
  return t.state === "assigned" ? hasOpen : ["working", "rework", "blocked"].includes(t.state);
}
const ARTIFACT_AVAILABILITY_LABEL = {
  available_verified: "доступен на этом ПК, SHA совпал ✓",
  available_unpinned: "доступен на этом ПК (без SHA)",
  hash_mismatch: "SHA не совпадает на этом ПК",
  missing_on_device: "отсутствует на этом ПК",
  other_device: "на другом компьютере",
  unapproved_root: "путь вне разрешённых папок контекста",
  unverified: "локально не проверен",
};
function artifactAvailabilityBadge(a) {
  const code = a?.local_availability || "unverified";
  const label = ARTIFACT_AVAILABILITY_LABEL[code] || a?.status || "не проверен";
  const cls = code === "available_verified" ? "artifact-badge ok" : ["hash_mismatch", "missing_on_device"].includes(code) ? "artifact-badge bad" : "artifact-badge";
  return `<span class="${cls}" data-availability="${esc(code)}">${esc(label)}</span>`;
}
function boundAgentForTask(t) {
  const a = t?.assignment;
  if (!a?.agent) return null;
  return Object.values(data?.agents || {}).find((ag) => {
    if (ag.project !== t.project || ag.agent !== a.agent) return false;
    if (a.device_id && (ag.device_id || data?.device_id) !== a.device_id) return false;
    const agSess = ag.session_id || ag.session || "";
    if (a.session_id && agSess && agSess !== a.session_id) return false; // fresh session never inherits old session's state
    return true;
  }) || null;
}
function taskLastSignal(t) {
  const ag = boundAgentForTask(t);
  if (ag) {
    const stale = isStale(ag);
    const base = `${stateLabel(ag)}${ag.updated ? ` · ${ago(ag.updated)}` : ""}`;
    return stale ? `${base} (нет новых маркеров > ${data?.config?.stale_minutes || 20} мин — активность не подтверждена)` : base;
  }
  const lastHist = (t.history || []).at(-1);
  if (lastHist) return `${TASK_LABEL[lastHist.state] || lastHist.kind || lastHist.state || "обновлено"}${lastHist.time ? ` · ${ago(lastHist.time)}` : ""}`;
  return t.updated ? `обновлено ${ago(t.updated)}` : "сигналов пока нет";
}
function taskReviewerLabel(t) {
  const a = t?.assignment || {};
  if (a.role === "reviewer" && a.agent) return `${a.agent} (ревьюер)`;
  const reportRow = taskReceiptRows(t).findLast((r) => r.kind === "forward" && r.purpose !== "assignment" && r.to);
  const coord = `ведущий на «${deviceLabel(t.coordinator_device_id)}»`;
  return reportRow?.to ? `${reportRow.to} · ${coord}` : coord;
}
function taskReportSummary(t) {
  const cp = t?.checkpoint || {};
  const arts = listValues(t?.artifacts);
  const parts = [];
  if (cp.report) parts.push(`<code>${esc(cp.report)}</code>`);
  if (cp.commit) parts.push(`SHA <code>${esc(String(cp.commit).slice(0, 12))}</code>`);
  if (cp.branch) parts.push(`ветка <code>${esc(cp.branch)}</code>`);
  if (arts.length) {
    const first = arts[0];
    parts.push(`${!cp.report ? `<code>${esc(first.path)}</code> ` : ""}${artifactAvailabilityBadge(first)}${arts.length > 1 ? ` (+${arts.length - 1})` : ""}`);
  }
  return parts.join(" · ");
}
function taskNextStep(t) {
  if (t?.checkpoint?.next_step) return t.checkpoint.next_step;
  const msg = assignmentMessage(t);
  if (t.state === "submitted") return "Проверить сдачу и принять задачу или вернуть на доработку";
  if (msg && !msg.forwarded_at && !msg.acked_at && !msg.done_at) return `Переслать задание агенту ${t.assignment?.agent || "исполнителю"}`;
  if (msg && msg.forwarded_at && !msg.acked_at) return `Ожидается ACK получения от ${t.assignment?.agent || "исполнителя"}`;
  if (t.state === "blocked") return "Разобрать причину блокировки или переназначить";
  if (t.state === "rework") return "Исполнитель дорабатывает замечания";
  return "";
}
function releaseResourceDialog(agentItem) {
  if (!agentItem) return;
  const resumeText = `[Agent Desk] Ресурс свободен — можно продолжать работу (${agentItem.project}${agentItem.task ? ` · ${agentItem.task}` : ""}).`;
  dialog("Освободить ресурс для агента", `<div class="msg"><img src="${icon("computer-1")}" alt=""><div>
    <p>Агент <b>${esc(agentItem.agent)}</b> (${esc(agentItem.project)}) ожидает телефон/сервер${agentItem.updated ? ` (${esc(ago(agentItem.updated))})` : ""}.</p>
    ${agentItem.task ? `<p>Задача: <b>${esc(agentItem.task)}</b></p>` : ""}
    ${agentItem.note ? `<p class="sub">Примечание: ${esc(agentItem.note)}</p>` : ""}
    <p class="sub">Скопируйте сообщение в сессию агента, когда устройство или сервер снова свободны. Agent Desk не ставит принудительных блокировок.</p>
    <textarea id="resource-resume-text" class="short-text" readonly></textarea>
    <p id="resource-copy-status" class="sub" role="status"></p></div></div>
    <div class="buttons"><button id="resource-copy">Копировать сообщение агенту</button><button data-close>Закрыть</button></div>`, (node) => {
    const ta = node.querySelector("#resource-resume-text");
    ta.value = resumeText;
    node.querySelector("#resource-copy").onclick = async () => {
      const ok = await copyText(ta.value);
      node.querySelector("#resource-copy-status").textContent = ok ? "Скопировано. Вставьте в чат агента." : "Выделите текст и нажмите Ctrl+C.";
      if (!ok) { ta.focus(); ta.select(); }
    };
  });
}
function taskMatches(t) {
  const q = taskSearch.trim();
  const messages = taskReceiptRows(t);
  if (q && !(data?.compact && serverSearchState.q === q && serverSearchState.taskIds?.has(t.task_id)) && !matchesSearch(q, [
    taskCardNumber(t), t.task_id, t.project_id, t.assignment_message_id,
    t.title, t.task, t.project,
    t.assignment?.agent, ...agentAliasesFor(t.project, t.assignment?.agent),
    t.assignment?.device_id, deviceLabel(t.assignment?.device_id),
    t.coordinator_device_id, deviceLabel(t.coordinator_device_id),
    t.state, TASK_LABEL[t.state], t.status_reason,
    t.checkpoint?.branch, t.checkpoint?.commit, t.checkpoint?.report, t.checkpoint?.next_step,
    t.prompt ?? t.prompt_preview,
    ...messages.flatMap((r) => [r.display_id, r.message_id, r.to, r.message ?? r.message_preview]),
  ])) return false;
  if (taskFilter === "active") return isTaskActiveUi(t);
  if (taskFilter === "submitted") return t.state === "submitted";
  if (taskFilter === "blocked") return ["blocked", "rework"].includes(t.state);
  if (taskFilter === "accepted") return t.state === "accepted";
  if (taskFilter === "cancelled") return ["cancelled", "archived"].includes(t.state);
  if (taskFilter === "legacy") return taskOriginKind(t) !== "managed" && !isTaskActiveUi(t);
  return true;
}
function renderTasks() {
  const supported = data.tasks !== undefined;
  $("#tasks-unavailable").classList.toggle("hidden", supported);
  $("#task-new").disabled = !supported || !canCoordinate();
  const localOwner = isLocal && AD_HOST.kind !== "mobile";
  $("#task-context-roots").classList.toggle("hidden", !localOwner);
  $("#task-context-roots").disabled = !online || data.config.task_repo_roots === undefined || data.config.task_skill_roots === undefined;
  const filterSel = $("#task-filter");
  if (filterSel && filterSel.value !== taskFilter) filterSel.value = taskFilter;
  const searchInp = $("#task-search");
  if (searchInp && searchInp.value !== taskSearch) searchInp.value = taskSearch;
  const all = taskList().filter(t => taskSearch.trim() || inProject(t)).sort((a, b) => String(b.updated || "").localeCompare(String(a.updated || "")));
  const tasks = all.filter(taskMatches);
  const shown = tasks.slice(0, taskRenderLimit);
  const countEl = $("#task-count");
  if (countEl) countEl.textContent = all.length ? `${tasks.length === all.length ? `карточек: ${tasks.length}` : `${tasks.length} из ${all.length}`}` : "";
  patch($("#task-list"), shown.length ? shown.map((t) => {
    const a = t.assignment || {};
    const coordinator = canCoordinate(t);
    const message = assignmentMessage(t);
    const boundAg = boundAgentForTask(t);
    const repeat = message && (message.forwarded_at || message.acked_at || message.done_at);
    const copy = !message ? "Копировать контекст" : repeat ? "Переслать снова" : `Копировать задание для ${a.agent || "агента"}`;
    const readonly = !online ? "Нет связи — только просмотр" : !coordinator ? "Назначение и передача — на компьютере ведущего" : "";
    const repSummary = taskReportSummary(t);
    const nextStep = taskNextStep(t);
    const histRows = (t.history || []).slice(-6).reverse();
    return `<article class="task-card" data-key="task:${esc(t.task_id)}">
      <header><h2><code aria-label="Номер карточки">${esc(taskCardNumber(t))}</code> — ${esc(t.title || t.task || "Без названия")}</h2><b class="task-badge task-${esc(Object.hasOwn(TASK_LABEL, t.state) ? t.state : "unknown")}">${esc(TASK_LABEL[t.state] || t.state || "неизвестно")}</b></header>
      <p class="sub">${esc(t.project)} · ${esc(ago(t.updated))}</p>
      <dl class="task-meta"><dt>Исполнитель</dt><dd>${esc(a.agent || "не назначен")} · ${esc(roleLabel(a.role))}</dd><dt>Компьютер</dt><dd>${esc(deviceLabel(a.device_id))} · ${esc(sessionLabel(t))}</dd><dt>Последний сигнал</dt><dd>${esc(taskLastSignal(t))}</dd><dt>Проверяет</dt><dd>${esc(taskReviewerLabel(t))}</dd>${repSummary ? `<dt>Отчёт / SHA</dt><dd>${repSummary}</dd>` : ""}${nextStep ? `<dt>Следующий шаг</dt><dd>${esc(nextStep)}</dd>` : ""}${t.status_reason ? `<dt>Причина статуса</dt><dd>${esc(t.status_reason)}</dd>` : ""}</dl>
      ${t.conflict ? `<p class="peer-warn">Конфликт задания: ${esc(typeof t.conflict === "string" ? t.conflict : "нужна сверка ведущим")}</p>` : ""}
      <details><summary>Сообщения и квитанции (${taskReceiptRows(t).length})</summary><ul class="receipt-list">${receiptsMarkup(t)}</ul><p class="sub">ACK подтверждает только получение, а не выполнение или приёмку.</p></details>
      ${histRows.length ? `<details><summary>История действий (${t.history.length})</summary><ul class="receipt-list">${histRows.map((h) => `<li>${esc(h.time ? `${hhmm(h.time)} · ${ago(h.time)}` : "")} · ${esc(TASK_LABEL[h.state] || h.kind || h.state || "событие")}${h.actor?.agent ? ` · ${esc(h.actor.agent)}` : h.agent ? ` · ${esc(h.agent)}` : ""}${h.device_id ? ` (${esc(deviceLabel(h.device_id))})` : ""}${h.note ? ` — ${esc(h.note)}` : ""}</li>`).join("")}</ul></details>` : ""}
      ${technicalDetails(t)}
      <div class="task-actions"><button data-task-action="copy" data-task-id="${esc(t.task_id)}"${message || online ? "" : " disabled"}>${esc(copy)}</button>${message && !message.forwarded_at && !message.acked_at && !message.done_at ? `<button data-action="mark-forwarded" data-todo-id="${message.id}"${online ? "" : " disabled"}>Переслал</button>` : ""}${a.adapter && a.adapter !== "manual" && t.state === "assigned" ? `<button data-task-action="launch" data-task-id="${esc(t.task_id)}"${coordinator ? "" : " disabled"}>Запустить (${esc(a.adapter)})</button>` : ""}${t.state === "submitted" ? `<button data-task-action="review" data-task-id="${esc(t.task_id)}"${coordinator ? "" : " disabled"}>Проверить сдачу…</button>` : ""}${boundAg?.state === "waiting" && boundAg?.waiting_for === "resource" ? `<button data-task-action="release-resource" data-task-id="${esc(t.task_id)}">Освободить ресурс…</button>` : ""}<button data-task-action="details" data-task-id="${esc(t.task_id)}">Подробно…</button><button data-task-action="context" data-task-id="${esc(t.task_id)}"${online ? "" : " disabled"}>Контекст / копировать…</button><button data-task-action="assign" data-task-id="${esc(t.task_id)}"${coordinator ? "" : " disabled"}>Назначить…</button><button data-task-action="transition" data-task-id="${esc(t.task_id)}"${online ? "" : " disabled"}>Состояние…</button><button data-task-action="handoff" data-task-id="${esc(t.task_id)}"${coordinator ? "" : " disabled"}>Передать…</button></div>
      ${readonly ? `<p class="sub">${readonly}</p>` : ""}</article>`;
  }).join("") + (tasks.length > shown.length ? `<div class="tasks-more"><button data-action="tasks-show-all">Показать все карточки (${tasks.length})</button></div>` : "")
    : `<p class="empty">${supported ? (all.length ? "Ничего не найдено по фильтру или поиску." : "Задач пока нет. Назначьте первую задачу; номер карточки сохранится при смене сессии.") : "Ожидается сервер с поддержкой задач."}</p>`);
}
function taskDetails(t) {
  const cp = t.checkpoint || {};
  const kv = (k, v) => v === undefined || v === null || v === "" ? "" : `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`;
  const kvList = (k, items) => Array.isArray(items) && items.length ? `<dt>${esc(k)}</dt><dd><ul class="kv-list">${items.map(s => `<li>${esc(typeof s === "string" ? s : (s?.name ? `${s.name} (${s.path})` : s?.path || JSON.stringify(s)))}</li>`).join("")}</ul></dd>` : "";
  const originLabel = { managed: "явное назначение", observed: "наблюдаемый маркер", migrated: "исторический импорт" }[taskOriginKind(t)] || "";
  const cpRows = [kv("Репозиторий", cp.repo), kv("Ветка", cp.branch), kv("Коммит", cp.commit), kv("Отчёт", cp.report), kv("Следующий шаг", cp.next_step), kvList("Ограничения", cp.constraints), kvList("Выбранные skills", cp.skills), kvList("Манифест", cp.manifest)].join("");
  const promptBlock = (t.prompt || t.has_prompt) ? '<h3>Промпт задания</h3><div id="task-prompt-body" class="msg-body"></div>' : "";
  const history = (t.history || []).slice(-12).reverse();
  dialog("Задача — подробности", `<h2 class="task-title"><code>${esc(taskCardNumber(t))}</code> — ${esc(t.title || t.task)}</h2><dl class="kv">${kv("Карточка", taskCardNumber(t))}${kv("Состояние", TASK_LABEL[t.state] || t.state)}${kv("Источник", originLabel)}${kv("Причина статуса", t.status_reason)}${kv("Исполнитель", t.assignment?.agent)}${kv("Компьютер", deviceLabel(t.assignment?.device_id))}${kv("Сессия", sessionLabel(t))}${kv("Последний сигнал", taskLastSignal(t))}${kv("Проверяет", taskReviewerLabel(t))}${kv("Ведущий", deviceLabel(t.coordinator_device_id))}${cpRows}</dl>
    ${technicalDetails(t)}${promptBlock}<h3>Артефакты</h3>${listValues(t.artifacts).length ? `<ul class="receipt-list">${listValues(t.artifacts).map((a) => `<li><code>${esc(a.path)}</code> · ${artifactAvailabilityBadge(a)}<br><code class="sub" title="${esc(a.hash || a.sha256 || "")}">SHA-256: ${esc((a.hash || a.sha256 || "не указан").slice(0, 16))}${(a.hash || a.sha256) ? "…" : ""}</code></li>`).join("")}</ul>` : "<p>Артефактов пока нет.</p>"}
    <h3>История задачи</h3><ul class="receipt-list">${history.map((h) => `<li>${esc(h.time ? `${hhmm(h.time)} · ${ago(h.time)}` : (h.at || ""))} · ${esc(TASK_LABEL[h.state] || h.action || h.state || "событие")}${h.actor?.agent ? ` · ${esc(h.actor.agent)}` : h.agent ? ` · ${esc(h.agent)}` : ""}${h.note ? ` · ${esc(h.note)}` : ""}</li>`).join("") || "<li>Истории пока нет.</li>"}</ul><div class="buttons"><button data-close>Закрыть</button></div>`, (node) => {
    const pb = node.querySelector("#task-prompt-body");
    if (pb) {
      if (t.prompt !== undefined) pb.textContent = t.prompt;
      else { pb.textContent = "Загружаю промпт…"; ensureFullTask(t).then(() => { if (node.isConnected) pb.textContent = t.prompt || ""; }).catch(() => {}); }
    }
  }, { wide: true });
}
function checksMarkup(checks) {
  if (!checks || (typeof checks === "object" && !Object.keys(checks).length)) return "Проверки не предоставлены сервером — состояние репозитория не подтверждено.";
  return typeof checks === "string" ? checks : JSON.stringify(checks, null, 2);
}
function checksSummaryHtml(checks) {
  if (!checks) return "<p>Проверки не предоставлены сервером — состояние репозитория не подтверждено.</p>";
  if (typeof checks === "string") return `<p>${esc(checks)}</p>`;
  const lines = [];
  const repo = checks.repo || {};
  if (repo.status === "verified") lines.push(`Репозиторий: проверен локально${repo.branch ? ` · ветка ${esc(repo.branch)}` : " · detached HEAD"}${repo.clean_tracked === false ? " · есть незакоммиченные изменения" : ""}${repo.commit_matches_head === false ? " · checkpoint-коммит не совпадает с HEAD" : ""}`);
  else if (repo.status === "blocked") lines.push(`Репозиторий: проверка заблокирована (${esc(repo.reason || "путь не разрешён")})`);
  else lines.push("Репозиторий: проверка не запрашивалась");
  const rp = checks.remote_push || {};
  if (rp.status === "local_remote_tracking_evidence") lines.push(`Push: только кэшированные локальные remote-tracking refs (${(rp.refs || []).map(esc).join(", ")}); удалённый push не подтверждён`);
  else lines.push("Push: не проверен (без fetch/push)");
  const arts = listValues(checks.artifacts || []);
  if (arts.length) lines.push(`Артефакты: ${arts.map(a => `${esc(a.path)} — ${esc(a.status)}${a.reason ? ` (${esc(a.reason)})` : ""}`).join("; ")}`);
  const skills = listValues(checks.skills || []);
  if (skills.length) lines.push(`Skills: ${skills.map(s => `${esc(s.path)} — ${esc(s.status)}${s.reason ? ` (${esc(s.reason)})` : ""}`).join("; ")}`);
  if (checks.report?.status) lines.push(`Отчёт: ${esc(checks.report.status)} (содержимое не читалось)`);
  const launchStatus = typeof checks.launch === "object" ? checks.launch?.status : checks.launch;
  if (launchStatus === "needs_manual_launch") lines.push("Запуск: вручную — скопируйте контекст в сессию агента, автозапуск не выполняется");
  else if (launchStatus) lines.push(`Запуск: ${esc(launchStatus)}`);
  const extra = Object.entries(checks).filter(([k]) => !["repo", "remote_push", "artifacts", "skills", "report", "launch"].includes(k));
  if (extra.length) lines.push(...extra.map(([k, v]) => `${esc(k)}: ${esc(typeof v === "object" ? JSON.stringify(v) : v)}`));
  return `<ul>${lines.map(l => `<li>${l}</li>`).join("")}</ul>`;
}
function contextDialog(t, result, title = "Контекст задачи — локальные проверки") {
  dialog(title, `<p>Карточка <code>${esc(taskCardNumber(t))}</code>. Проверки выполняются сервером только локально; копирование не запускает агента.</p>
    <div class="context-checks-summary">${checksSummaryHtml(result.checks)}</div>
    <details class="technical-details"><summary>Технические данные проверок (JSON)</summary><pre id="context-checks" class="context-checks" tabindex="0">${esc(checksMarkup(result.checks))}</pre></details>
    <label for="task-context">Контекст для новой сессии</label><textarea id="task-context" readonly></textarea><p id="context-result" role="status"></p><div class="buttons wrap"><button id="copy-context"${typeof result.text === "string" && result.text.trim() ? "" : " disabled"}>Копировать контекст</button><button type="button" id="copy-handoff-json"${online ? "" : " disabled"}>JSON handoff</button><button type="button" id="copy-handback-tpl"${online ? "" : " disabled"}>Шаблон handback</button><button data-close>Закрыть</button></div>`, (node) => {
    const ta = node.querySelector("#task-context"); ta.value = typeof result.text === "string" ? result.text : "";
    const statusNode = node.querySelector("#context-result");
    node.querySelector("#copy-context").onclick = async () => {
      const ok = await copyText(ta.value);
      statusNode.textContent = ok ? "Контекст скопирован. Запустите/подключите новую сессию вручную, если адаптер не поддерживает запуск." : "Буфер обмена недоступен: выделите контекст и скопируйте вручную.";
      if (!ok) { ta.focus(); ta.select(); }
    };
    const copyPkgPart = async (mode) => {
      try {
        const pkg = await api(`/api/tasks/handoff-json?id=${encodeURIComponent(t.task_id)}`);
        const textOut = JSON.stringify(mode === "handback" ? pkg.handback_template : pkg, null, 2);
        const ok = await copyText(textOut);
        if (!ok) { ta.value = textOut; ta.focus(); ta.select(); }
        statusNode.textContent = ok
          ? (mode === "handback" ? "Шаблон handback JSON скопирован." : "Пакет JSON handoff для внешнего агента скопирован.")
          : "Буфер обмена недоступен: JSON показан в поле ниже, нажмите Ctrl+C.";
      } catch (err) {
        statusNode.textContent = `Не удалось получить JSON: ${err.message}`;
      }
    };
    node.querySelector("#copy-handoff-json").onclick = () => copyPkgPart("handoff");
    node.querySelector("#copy-handback-tpl").onclick = () => copyPkgPart("handback");
  }, { wide: true });
}
async function fetchTaskContext(t) {
  dialog("Контекст задачи", '<p role="status">Проверяю локальный checkpoint…</p><div class="buttons"><button data-close>Отмена</button></div>');
  const node = $("#modal-layer").firstElementChild;
  try {
    const result = await api(`/api/tasks/context?id=${encodeURIComponent(t.task_id)}`);
    if (node.isConnected) contextDialog(result.task || t, result);
  } catch (e) {
    if (node.isConnected) alertBox("Контекст недоступен", `${e.message}. Проверьте связь и разрешённые пути checkpoint.`, "msg_error-0");
  }
}
function contextRootsDialog() {
  if (!isLocal || AD_HOST.kind === "mobile") { alertBox("Папки контекста", "Разрешённые пути можно настроить только локально на компьютере Agent Desk."); return; }
  if (!online) { alertBox("Папки контекста", "Нет связи: настройка сейчас недоступна."); return; }
  if (data.config.task_repo_roots === undefined || data.config.task_skill_roots === undefined) { alertBox("Папки контекста", "Эта версия сервера ещё не поддерживает явные разрешения контекста."); return; }
  // Read the existing approvals first; replace only these two fields, never the whole config.
  const current = { task_repo_roots: [...data.config.task_repo_roots], task_skill_roots: [...data.config.task_skill_roots] };
  dialog("Папки контекста — только этот компьютер", '<p>Проверка checkpoint читает только явно разрешённые локальные папки. Укажите узкие папки репозиториев и выбранных skills, не домашнюю папку целиком. Пути не подбираются автоматически и не передаются другим устройствам.</p><form id="context-roots-form"><div class="field-row-stacked"><label for="context-repo-roots">Репозитории — один существующий абсолютный путь на строку</label><textarea id="context-repo-roots" class="short-text" maxlength="30000" spellcheck="false" autocapitalize="off"></textarea></div><div class="field-row-stacked"><label for="context-skill-roots">Skills — один существующий абсолютный путь на строку</label><textarea id="context-skill-roots" class="short-text" maxlength="30000" spellcheck="false" autocapitalize="off"></textarea></div><p class="sub">Не более 20 папок в каждом списке. Пустой список снимает разрешения: соответствующая проверка контекста останется закрытой. Настройки папок маркеров и общей почты не меняются.</p><p id="context-roots-error" class="bad" role="status" aria-live="polite"></p><div class="buttons"><button type="submit" id="context-roots-save">Сохранить разрешения</button><button type="button" data-close>Отмена</button></div></form>', (node) => {
    node.querySelector("#context-repo-roots").value = current.task_repo_roots.join("\n");
    node.querySelector("#context-skill-roots").value = current.task_skill_roots.join("\n");
    const collect = (id) => [...new Set(node.querySelector(id).value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
    node.querySelector("#context-roots-form").onsubmit = async (e) => {
      e.preventDefault();
      const save = node.querySelector("#context-roots-save"), err = node.querySelector("#context-roots-error");
      if (save.disabled) return;
      if (!online) { err.textContent = "Нет связи: изменения не отправлены."; return; }
      const body = { task_repo_roots: collect("#context-repo-roots"), task_skill_roots: collect("#context-skill-roots") };
      if (body.task_repo_roots.length > 20 || body.task_skill_roots.length > 20) { err.textContent = "Не более 20 папок в каждом списке."; return; }
      save.disabled = true; err.textContent = "Сохраняю локальные разрешения…";
      try {
        await api("/api/config", body);
        Object.assign(data.config, body);
        await poll();
        if (node.isConnected) closeDialog();
      } catch (error) { if (node.isConnected) err.textContent = `Не сохранено: ${error.message}. Нужны существующие обычные папки с абсолютными путями.`; }
      finally { if (node.isConnected) save.disabled = false; }
    };
    node.querySelector("#context-repo-roots").focus();
  });
}

function assignmentFields(t) {
  const a = t?.assignment || {};
  const bindings = listValues(data.bindings).filter((b) => !t || b.project === t.project);
  const field = (key, label, value, required = true) => `<div class="field-row-stacked"><label for="assign-${key}">${label}</label><input id="assign-${key}" name="${key}" type="text" value="${esc(value)}"${required ? " required" : ""} autocomplete="off" spellcheck="false" maxlength="240"></div>`;
    const devices = new Map([[data.device_id, data.link?.name || "этот компьютер"], ...(data.link?.peers || []).map(p => [p.id, p.name || "другой компьютер"])]);
  if (a.device_id && !devices.has(a.device_id)) devices.set(a.device_id, "ранее привязанный компьютер");
  const deviceSelect = `<div class="field-row-stacked"><label for="assign-device_id">Компьютер</label><select id="assign-device_id" name="device_id">${[...devices].map(([id,name]) => `<option value="${esc(id)}"${id === (a.device_id || data.device_id) ? " selected" : ""}>${esc(name)}</option>`).join("")}</select></div>`;
  return `${bindings.length ? `<div class="field-row-stacked"><label for="assign-binding">Сохранённая привязка</label><select id="assign-binding"><option value="">Введите вручную</option>${bindings.map((b, i) => `<option value="${i}">${esc(`${b.agent} · ${deviceLabel(b.device_id)} · ${b.role || "без роли"} · привязка ${i + 1}`)}</option>`).join("")}</select></div>` : ""}<div class="assignment-grid">${field("agent", "Имя агента", a.agent)}${deviceSelect}</div><details><summary>Привязка сессии и роль</summary><p class="sub">Для ручной пересылки сессия создаётся автоматически и добавляется в промпт. Если агент уже подключён, выберите его сохранённую привязку.</p><div class="assignment-grid">${field("session_id", "Привязка сессии агента", a.session_id)}${field("role", "Роль (executor / reviewer / coordinator)", a.role || "executor")}${field("adapter", "Адаптер запуска", a.adapter || "manual", false)}</div></details>`;
}
function taskMutationDialog(mode, t, presetState = "") {
  if (!online || (mode !== "transition" && !canCoordinate(t))) return;
  const creating = !t;
  const label = { assign: creating ? "Назначить новую задачу" : "Изменить назначение", handoff: "Передать задачу в новую сессию", transition: presetState === "accepted" ? "Проверить сдачу задачи" : "Состояние задачи" }[mode];
  const reviewBanner = mode === "transition" && t?.state === "submitted" && taskReportSummary(t) ? `<p class="sub">Сдано исполнителем <b>${esc(t.assignment?.agent || "")}</b>: ${taskReportSummary(t)}</p>` : "";
  const newFields = creating ? '<div class="field-row-stacked"><label for="task-project">Проект</label><input type="text" id="task-project" required maxlength="160"></div><div class="field-row-stacked"><label for="task-title">Название задачи</label><input type="text" id="task-title" required maxlength="500"></div>' : `<p><code>${esc(taskCardNumber(t))}</code> · ${esc(t.title || t.task)}</p>${reviewBanner}`;
  const selectedState = presetState && (TASK_NEXT[t?.state] || []).includes(presetState) && (!["accepted", "rework"].includes(presetState) || canCoordinate(t)) ? presetState : t?.state;
  const lifecycle = mode === "transition" ? `<div class="field-row-stacked"><label for="task-state">Новое состояние (отдельно от ACK)</label><select id="task-state">${Object.entries(TASK_LABEL).map(([k, v]) => `<option value="${k}"${k === selectedState ? " selected" : ""}${k !== t.state && (!(TASK_NEXT[t.state] || []).includes(k) || (["accepted", "rework"].includes(k) && !canCoordinate(t))) ? " disabled" : ""}>${v}</option>`).join("")}</select></div><div class="field-row-stacked"><label for="task-note">Пояснение / причина (обязательно для отмены)</label><input type="text" id="task-note" maxlength="1000"></div>` : assignmentFields(t);
  const promptFields = mode !== "transition" ? '<div class="field-row-stacked"><label for="task-prompt">Промпт для агента</label><textarea id="task-prompt" rows="7" aria-describedby="task-prompt-help task-prompt-stats" placeholder="Что сделать, какой результат нужен, ограничения и ссылки на материалы…"></textarea><div class="draft-row hidden" id="task-draft-row"><span class="sub" id="task-draft-notice">Восстановлен несохранённый черновик промпта.</span><button type="button" id="task-draft-reset">Сбросить черновик</button></div><p class="sub" id="task-prompt-stats" role="status" aria-live="polite"></p><p class="sub" id="task-prompt-help">Копируется целиком с сохранением отступов и строк вместе с реквизитами задания. До 20 000 символов и 58 000 Б UTF-8 пакета; при превышении текст останется в форме.</p></div>' : "";
  const checkpointFields = mode === "handoff" ? `<details><summary>Checkpoint: репозиторий, ветка, commit, OUT, отчёт</summary>${["repo", "branch", "commit", "out_dir", "report"].map((k) => `<div class="field-row-stacked"><label for="checkpoint-${k}">${esc(k)}</label><input type="text" id="checkpoint-${k}" value="${esc(t.checkpoint?.[k])}" autocomplete="off" spellcheck="false" maxlength="1024"></div>`).join("")}<p class="sub">Проверяются только явно разрешённые локальные пути. Список выбранных skills и артефакты сохраняются; содержимое файлов здесь не читается.</p></details>` : "";
  const handoff = mode === "handoff" ? '<p>Сохраняется текущий checkpoint и артефакты. После передачи получите контекст с результатами локальных проверок. Проверочные команды передаются только как текст для исполнителя (без автозапуска).</p><div class="field-row-stacked"><label for="handoff-next">Следующий шаг</label><textarea id="handoff-next" class="short-text" maxlength="4000"></textarea></div><div class="field-row-stacked"><label for="handoff-verify">Проверочные команды (текст для исполнителя, по одной на строку)</label><textarea id="handoff-verify" class="short-text" maxlength="4000"></textarea></div><div class="field-row-stacked"><label for="handoff-constraints">Ограничения / запреты (по одному на строку)</label><textarea id="handoff-constraints" class="short-text" maxlength="4000"></textarea></div>' : "";
  dialog(label, `<form id="task-form">${newFields}${promptFields}${lifecycle}${checkpointFields}${handoff}<p id="task-error" class="bad" role="status" aria-live="polite"></p><p class="sub">Старое назначение не принимается: при конфликте обновите карточку. Неизвестный адаптер требует ручного запуска.</p><div class="buttons"><button type="submit" id="task-save">${mode === "handoff" ? "Передать и получить контекст" : "Сохранить"}</button><button type="button" data-close>Отмена</button></div></form>`, (node) => {
    if (creating) node.querySelector("#task-project").value = project === "*" ? "" : project;
    const dKey = t ? `${mode}:${t.task_id}` : "assign:new";
    if (mode === "transition") {
      node.querySelector("#task-state").value = selectedState;
    } else {
      const ta = node.querySelector("#task-prompt");
      const statsEl = node.querySelector("#task-prompt-stats");
      const draftRow = node.querySelector("#task-draft-row");
      const basePrompt = t?.prompt || (t && assignmentMessage(t)?.message) || "";
      const savedDraft = promptDrafts.has(dKey) ? promptDrafts.get(dKey) : null;
      if (savedDraft !== null && savedDraft !== basePrompt) {
        ta.value = savedDraft;
        draftRow.classList.remove("hidden");
      } else {
        ta.value = basePrompt;
      }
      const updatePromptStats = () => {
        const val = ta.value || "";
        const chars = val.length;
        const bytes = utf8Bytes(val);
        const envBytes = estimatePromptEnvelopeBytes(val, t);
        const over = chars > 20000 || envBytes > 58000;
        statsEl.textContent = `Символов: ${chars.toLocaleString("ru-RU")} / 20 000 · UTF-8: ${bytes.toLocaleString("ru-RU")} Б (пакет: ${envBytes.toLocaleString("ru-RU")} / 58 000 Б)`;
        statsEl.classList.toggle("bad", over);
      };
      updatePromptStats();
      ta.oninput = () => {
        promptDrafts.set(dKey, ta.value);
        draftRow.classList.toggle("hidden", ta.value === basePrompt);
        updatePromptStats();
      };
      ta.addEventListener("input", ta.oninput);
      node.querySelector("#task-draft-reset").onclick = () => {
        promptDrafts.delete(dKey);
        ta.value = basePrompt;
        draftRow.classList.add("hidden");
        updatePromptStats();
        ta.focus();
      };
    }
    if (creating || mode === "handoff") node.querySelector("#assign-session_id").value = `manual-${Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, "0")).join("")}`;
    if (mode === "handoff") {
      for (const k of ["repo", "branch", "commit", "out_dir", "report"]) node.querySelector(`#checkpoint-${k}`).value = t.checkpoint?.[k] || "";
      node.querySelector("#handoff-next").value = t.checkpoint?.next_step || "";
      node.querySelector("#handoff-verify").value = Array.isArray(t.checkpoint?.verification_steps) ? t.checkpoint.verification_steps.join("\n") : "";
      node.querySelector("#handoff-constraints").value = Array.isArray(t.checkpoint?.constraints) ? t.checkpoint.constraints.join("\n") : String(t.checkpoint?.constraints || "");
    }
    const bindings = listValues(data.bindings).filter((b) => !t || b.project === t.project);
    node.querySelector("#assign-binding")?.addEventListener("change", (e) => {
      const b = bindings[Number(e.target.value)]; if (e.target.value === "" || !b) return;
      for (const k of ["agent", "device_id", "session_id", "role", "adapter"]) node.querySelector(`#assign-${k}`).value = b[k] || "";
    });
    node.querySelector("#task-form").onsubmit = async (e) => {
      e.preventDefault();
      const save = node.querySelector("#task-save"), err = node.querySelector("#task-error");
      if (save.disabled || !node.querySelector("#task-form").reportValidity()) return;
      if (!online) { err.textContent = "Нет связи: изменения не отправлены."; return; }
      const body = { task_id: t?.task_id, project: creating ? node.querySelector("#task-project").value.trim() : t.project, project_id: t?.project_id, assignment_epoch: taskEpoch(t) };
      if (mode === "transition") { body.state = node.querySelector("#task-state").value; body.note = node.querySelector("#task-note").value.trim(); body.agent = t.assignment?.agent; body.device_id = t.assignment?.device_id; body.session_id = t.assignment?.session_id; }
      else {
        body.assignment = Object.fromEntries(["agent", "device_id", "session_id", "role", "adapter"].map((k) => [k, node.querySelector(`#assign-${k}`).value.trim()]));
        if (!body.assignment.adapter) body.assignment.adapter = "manual";
        Object.assign(body, body.assignment); // flat fields are accepted by the additive TaskService contract too
        if (creating) body.title = node.querySelector("#task-title").value.trim();
        const rawPrompt = node.querySelector("#task-prompt").value;
        const prompt = rawPrompt.trim() ? rawPrompt : "";
        const bytes = utf8Bytes(rawPrompt);
        const envBytes = estimatePromptEnvelopeBytes(prompt, t);
        if (rawPrompt.length > 20000) {
          promptDrafts.set(dKey, rawPrompt);
          err.textContent = `В промпте ${rawPrompt.length.toLocaleString("ru-RU")} символов (${bytes.toLocaleString("ru-RU")} Б UTF-8), максимум 20 000 символов (превышение на ${(rawPrompt.length - 20000).toLocaleString("ru-RU")}). Текст сохранён в форме и черновике: сократите его или вынесите материалы в файл.`;
          node.querySelector("#task-prompt").focus();
          return;
        }
        if (envBytes > 58000) {
          promptDrafts.set(dKey, rawPrompt);
          err.textContent = `Переполнение UTF-8 пакета синхронизации: ${envBytes.toLocaleString("ru-RU")} Б при лимите 58 000 Б (промпт ${bytes.toLocaleString("ru-RU")} Б). Текст сохранён в форме и черновике: сократите промпт или передайте материалы через артефакт.`;
          node.querySelector("#task-prompt").focus();
          return;
        }
        if (prompt || !creating) body.prompt = prompt;
        if (mode === "handoff") {
          const outDirVal = node.querySelector("#checkpoint-out_dir").value.trim();
          const verifySteps = node.querySelector("#handoff-verify").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          body.checkpoint = {
            ...t.checkpoint,
            ...Object.fromEntries(["repo", "branch", "commit", "report"].map((k) => [k, node.querySelector(`#checkpoint-${k}`).value.trim()])),
            ...(outDirVal ? { out_dir: outDirVal } : {}),
            ...(verifySteps.length ? { verification_steps: verifySteps } : {}),
            next_step: node.querySelector("#handoff-next").value.trim(),
            constraints: node.querySelector("#handoff-constraints").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
          };
        }
      }
      save.disabled = true; err.textContent = "Сохраняю…";
      let handoffSaved = false;
      try {
        const result = await api(`/api/tasks/${mode}`, body);
        promptDrafts.delete(dKey);
        handoffSaved = mode === "handoff";
        await poll();
        if (!node.isConnected) return;
        if (mode === "handoff") {
          const assigned = result.task || currentTask(t.task_id) || t;
          // Always fetch after the durable handoff: never copy unchecked client-built context.
          const context = await api(`/api/tasks/context?id=${encodeURIComponent(t.task_id)}`);
          if (node.isConnected) contextDialog(context.task || assigned, context, "Передача сохранена — контекст новой сессии");
        } else closeDialog();
      } catch (error) {
        if (mode !== "transition") promptDrafts.set(dKey, node.querySelector("#task-prompt").value);
        if (node.isConnected) err.textContent = `${error.status === 409 ? "Назначение изменилось или действие доступно только ведущему (ваш черновик сохранён). " : ""}${error.message}${mode === "handoff" ? " Если передача уже сохранена, откройте «Контекст» в обновлённой карточке; не отправляйте её повторно." : ""}`;
      } finally { if (node.isConnected) { save.disabled = handoffSaved; if (handoffSaved) save.textContent = "Передача сохранена"; } }
    };
    node.querySelector(creating ? "#task-project" : mode === "transition" ? "#task-state" : "#assign-agent")?.focus();
  });
}
function syncDescription() {
  const sync = data.link?.sync;
  if (!online) return "Нет связи с этим Agent Desk. Показан последний сохранённый список файлов.";
  if (!sync) return "Статус синхронизации не предоставлен. Передача файлов не подтверждена.";
  if (typeof sync === "string") return sync;
  const pieces = [];
  if (sync.enabled !== undefined) pieces.push(sync.enabled ? `Синхронизация включена${sync.protocol ? ` (протокол ${sync.protocol})` : ""}` : "Синхронизация выключена");
  if (sync.events !== undefined) pieces.push(`событий в журнале: ${sync.events}`);
  if (sync.status || sync.state) pieces.push(String(sync.status || sync.state));
  if (sync.last_sync || sync.last_at || sync.updated) pieces.push(`последняя сверка: ${ago(sync.last_sync || sync.last_at || sync.updated)}`);
  if (sync.pending !== undefined) pieces.push(`в очереди: ${sync.pending}`);
  if (sync.error) pieces.push(String(sync.error));
  const peers = data.link?.peers || [];
  const unavailable = peers.filter((p) => p.online === false || p.sync?.status === "unsupported" || (p.protocol && p.protocol < 3));
  if (unavailable.length) pieces.push(unavailable.map((p) => `${p.name}: ${p.sync?.status === "unsupported" || (p.protocol && p.protocol < 3) ? "старая версия, ручная пересылка" : "не в сети"}`).join("; "));
  return pieces.join(" · ") || "Сверка подключённых устройств; подробный статус пока не предоставлен.";
}
function relativeMailPath(path) {
  const text = String(path || "");
  return !text || /^(?:[A-Za-z]:|[\\/])/.test(text) || text.split(/[\\/]/).includes("..") ? "Небезопасный путь скрыт" : text;
}
function renderMail() {
  const mail = data.mail;
  $("#file-toggle").disabled = !online || !isLocal || AD_HOST.kind === "mobile";
  $("#file-toggle").textContent = mail?.enabled ? "Выключить" : "Включить";
  $("#mail-roots").disabled = !online || !isLocal || AD_HOST.kind === "mobile" || !mail;
  $("#mail-refresh").disabled = !online || !mail;
  $("#mail-sync").textContent = syncDescription();
  const syncErrors = Object.entries(data.link?.sync?.errors || {}).map(([id, error]) => ({ project: (data.link?.peers || []).find((p) => p.id === id)?.name || "Устройство", message: typeof error === "string" ? error : "ошибка синхронизации" }));
  patch($("#mail-errors"), [...(mail?.errors || []), ...syncErrors].map((e) => `<p class="peer-warn">${esc(typeof e === "string" ? e : `${e.project || "Проект"}: ${e.error || e.message || e.status || "ошибка сканирования"}`)}${e.path ? ` · <code>${esc(relativeMailPath(e.path))}</code>` : ""}</p>`).join(""));
  patch($("#mail-peers"), (data.link?.peers || []).map((p) => `<p class="sub" data-key="sync-peer:${esc(p.id)}">${esc(p.name)} · ${esc(p.synced ? `последняя сверка ${ago(p.synced)}` : "сверка пока не подтверждена")}${p.mail?.mode === "disabled" ? " · файловая почта выключена" : p.mail ? ` · папок почты: ${Array.isArray(p.mail.projects) ? p.mail.projects.length : 0}, файлов: ${esc(p.mail.files ?? "—")}` : " · диагностика почты ещё не получена"}${p.error ? ` · ${esc(p.error)}` : ""}</p>`).join(""));
  if (!mail) { patch($("#mail-list"), '<p class="empty">Сервер ещё не поддерживает общие файлы проектов.</p>'); return; }
  const files = (mail.files || []).filter(inProject);
  const roots = (mail.roots || []).filter(inProject);
  const projects = [...new Set([...roots, ...files].map((r) => r.project))].sort();
  patch($("#mail-list"), projects.length ? projects.map((p) => {
    const rows = files.filter((f) => f.project === p).sort((a, b) => String(a.path).localeCompare(String(b.path)));
    return `<section class="mail-project" data-key="mail:${esc(p)}"><h2>${esc(p)} <small>· папок: ${roots.filter((r) => r.project === p).length}</small></h2>${rows.length ? `<table class="mail-table"><thead><tr><th>Файл (относительно общей папки)</th><th>SHA-256 / статус</th><th>Размер</th></tr></thead><tbody>${rows.map((f) => `<tr data-key="file:${esc(`${f.project}/${f.path}`)}"><td><code>${esc(relativeMailPath(f.path))}</code></td><td><code class="file-hash">${esc(f.sha256 || "SHA не указан")}</code><span class="sub">${esc(f.status || "в локальном индексе; получение другим устройством не подтверждено")}</span></td><td>${esc(f.size ?? "—")} Б</td></tr>`).join("")}</tbody></table>` : '<p class="empty">В общей папке пока нет подходящих файлов. Секреты, скрытые и системные файлы исключаются.</p>'}</section>`;
  }).join("") : `<p class="empty">${mail.mode === "disabled" ? "Файловая почта выключена. В «Папки…» включите автоматический приём или выберите папку проекта." : mail.mode === "auto" ? "Папка приёма будет создана автоматически при получении файлов от связанного компьютера." : "Общие папки не настроены или недоступны. Проверьте настройку «Папки…» и локальные пути."}</p>`);
}
function mailRootsDialog() {
  if (!online || !isLocal || AD_HOST.kind === "mobile") { alertBox("Папки общей почты", "Эта настройка доступна только локально на компьютере Agent Desk."); return; }
  if (!data.mail) { alertBox("Папки общей почты", "Сервер ещё не поддерживает настройку общих файлов."); return; }
  dialog("Общие папки — только этот компьютер", '<p>Настройка локальных путей не передаётся другим устройствам. Выбирайте только папку общих файлов проекта, не домашнюю папку целиком. Это не SMTP/IMAP. Сохранение пустого списка отключает явно заданные папки.</p><form id="mail-roots-form"><div class="field-row"><input type="checkbox" id="mail-auto"><label for="mail-auto">Автоматически принимать почту новых проектов в папку AgentDesk</label></div><fieldset id="mail-manual"><legend>Папки, заданные вручную</legend><div id="mail-root-rows"></div><button type="button" id="mail-root-add">Добавить папку</button></fieldset><p id="mail-root-error" class="bad" role="status"></p><div class="buttons"><button type="submit" id="mail-root-save">Сохранить</button><button type="button" data-close>Отмена</button></div></form>', (node) => {
    let rowId = 0;
    const automatic = node.querySelector("#mail-auto");
    automatic.checked = data.mail.mode === "auto";
    const toggle = () => { node.querySelector("#mail-manual").disabled = automatic.checked; node.querySelector("#mail-manual").classList.toggle("hidden", automatic.checked); };
    automatic.onchange = toggle; toggle();
    const add = (root = {}) => {
      const i = rowId++;
      node.querySelector("#mail-root-rows").insertAdjacentHTML("beforeend", `<fieldset class="mail-root-row"><legend>Общая папка</legend><div class="field-row-stacked"><label for="mail-project-${i}">Проект</label><input id="mail-project-${i}" data-root-project type="text" required maxlength="160" value="${esc(root.project)}"></div><div class="field-row-stacked"><label for="mail-path-${i}">Локальный абсолютный путь</label><input id="mail-path-${i}" data-root-path type="text" required value="${esc(root.path)}" autocomplete="off" spellcheck="false"></div><button type="button" data-root-remove>Убрать из настройки</button></fieldset>`);
    };
    (data.mail.roots || []).forEach(add);
    node.querySelector("#mail-root-add").onclick = () => { add({ project: project === "*" ? "" : project }); node.querySelector(".mail-root-row:last-child input").focus(); };
    node.addEventListener("click", (e) => { e.target.closest("[data-root-remove]")?.closest(".mail-root-row").remove(); });
    node.querySelector("#mail-roots-form").onsubmit = async (e) => {
      e.preventDefault(); const btn = node.querySelector("#mail-root-save"), err = node.querySelector("#mail-root-error");
      if (btn.disabled || !node.querySelector("#mail-roots-form").reportValidity()) return;
      if (!online) { err.textContent = "Нет связи: настройка не отправлена."; return; }
      const roots = [...node.querySelectorAll(".mail-root-row")].map((r) => ({ project: r.querySelector("[data-root-project]").value.trim(), path: r.querySelector("[data-root-path]").value.trim() }));
      btn.disabled = true; err.textContent = "Сохраняю локальную настройку…";
      try { await api("/api/mail/config", automatic.checked ? { automatic: true } : { roots }); await poll(); if (node.isConnected) closeDialog(); }
      catch (error) { if (node.isConnected) err.textContent = `Не сохранено: ${error.message}`; }
      finally { if (node.isConnected) btn.disabled = false; }
    };
  });
}

// --- alerts on this device ------------------------------------------------------

let audioCtx = null;
function chime(volume = appVolume) {
  if (volume <= 0) return;
  try {
    audioCtx = audioCtx || new AudioContext();
    const t0 = audioCtx.currentTime;
    [[880, 0], [1318.5, 0.12]].forEach(([f, dt]) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "triangle";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.4 * volume / 100, t0 + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.5);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0 + dt);
      o.stop(t0 + dt + 0.55);
    });
  } catch { /* audio not allowed until the first tap */ }
  if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.([120, 60, 120]); // before the first tap Chrome blocks it and logs an error
}
document.addEventListener("pointerdown", () => { if (audioCtx?.state === "suspended") audioCtx.resume(); }, { passive: true });

function checkAlerts() {
  const open = data.todos.filter(needsAction);
  const key = (t) => `${t.id}:${t.created}`;
  const fresh = seenAlerts ? open.filter((t) => !seenAlerts.has(key(t))) : [];
  seenAlerts = new Set(open.map(key));
  // Phone app: Win98 windows while the app is on screen; while it is hidden, the background
  // watcher (AD_HOST.watch) shows Android notifications with the same chime.
  if (AD_HOST.kind === "mobile") return phoneToasts();
  if (!fresh.length) return;
  // On the PC the popups have their own sound; the window chimes only when popups are off.
  if (soundOn && (!isNative || !data.config.notify)) chime();
}

// Phone app on screen: a Win98 message window slides in at the top for each new alert of the PC
// (data.alerts: what happened and what to do). A tap opens the reminder, the cross closes it.
let toastSeq = null;
let resyncToasts = false; // back on screen: what came meanwhile was an Android notification already
function phoneToasts() {
  const seq = Number(data.alert_seq) || 0;
  const fresh = toastSeq === null || seq < toastSeq ? [] : (data.alerts || []).filter((a) => a.id > toastSeq);
  toastSeq = seq;
  if (!fresh.length || document.hidden) return;
  let box = $("#toasts");
  if (!box) {
    box = document.createElement("div");
    box.id = "toasts";
    document.body.append(box);
  }
  for (const a of fresh.slice(-3)) {
    const el = document.createElement("div");
    el.className = "window toast";
    el.innerHTML = `<div class="title-bar"><div class="title-bar-text">Agent Desk${a.project ? ` — ${esc(a.project)}` : ""}</div>
      <div class="title-bar-controls"><button aria-label="Close" data-toast-close></button></div></div>
      <div class="window-body"><img src="${icon(a.icon || "msg_information-0")}" alt="">
      <div><b>${esc(a.title)}</b>${a.action ? `<p>${esc(a.action)}</p>` : ""}${a.body ? `<p class="sub">${esc(a.body)}</p>` : ""}</div></div>`;
    el.addEventListener("click", (e) => {
      el.remove();
      if (!e.target.closest("[data-toast-close]")) window.abFocus(a.project, Number.isInteger(a.todo) ? a.todo : null);
    });
    box.prepend(el);
    setTimeout(() => el.remove(), 20000);
  }
  while (box.children.length > 3) box.lastElementChild.remove();
  if (soundOn) chime();
}

// --- data -----------------------------------------------------------------------

async function api(path, body, server) {
  const headers = server ? { "X-Agent-Desk-Key": server.key } : { ...AD_HOST.headers() };
  const opts = { headers, cache: "no-store" };
  if (body !== undefined) {
    opts.method = "POST";
    headers["Content-Type"] = "application/json";
    headers["X-Agent-Desk"] = "1"; // writes need it: a foreign page cannot send it without asking first
    opts.body = JSON.stringify(body);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  opts.signal = ctrl.signal;
  let r;
  try {
    r = await fetch((server ? server.base : AD_HOST.base()) + path, opts);
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json()).error || msg; } catch { /* not json */ }
    const e = new Error(msg);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

function applyStateUpdate(next) {
  if (!next.delta || !data) {
    if (data) {
      const prevTodos = new Map((data.todos || []).map((t) => [t.id, t]));
      if (Array.isArray(next.todos)) {
        next.todos = next.todos.map((t) => {
          const old = prevTodos.get(t.id);
          if (old && old.message !== undefined && t.message === undefined && old.updated === t.updated && old.message_id === t.message_id) {
            return { ...t, message: old.message, forward_text: old.forward_text };
          }
          return t;
        });
      }
      const prevTasks = new Map(taskList().map((t) => [t.task_id, t]));
      if (Array.isArray(next.tasks)) {
        next.tasks = next.tasks.map((t) => {
          const old = prevTasks.get(t.task_id);
          if (old && old.prompt !== undefined && t.prompt === undefined && old.updated === t.updated) {
            return { ...t, prompt: old.prompt };
          }
          return t;
        });
      }
    }
    data = next;
    return;
  }
  const removeTasks = new Set(next.tasks_remove || []);
  const upsertTasks = new Map((next.tasks_upsert || []).map((t) => [t.task_id, t]));
  const mergedTasks = [];
  for (const old of taskList()) {
    if (removeTasks.has(old.task_id)) continue;
    if (upsertTasks.has(old.task_id)) {
      const fresh = upsertTasks.get(old.task_id);
      upsertTasks.delete(old.task_id);
      if (old.prompt !== undefined && fresh.prompt === undefined && old.updated === fresh.updated) mergedTasks.push({ ...fresh, prompt: old.prompt });
      else mergedTasks.push(fresh);
    } else mergedTasks.push(old);
  }
  for (const fresh of upsertTasks.values()) mergedTasks.push(fresh);

  const removeTodos = new Set(next.todos_remove || []);
  const upsertTodos = new Map((next.todos_upsert || []).map((t) => [t.id, t]));
  const mergedTodos = [];
  for (const old of (data.todos || [])) {
    if (removeTodos.has(old.id)) continue;
    if (upsertTodos.has(old.id)) {
      const fresh = upsertTodos.get(old.id);
      upsertTodos.delete(old.id);
      if (old.message !== undefined && fresh.message === undefined && old.updated === fresh.updated && old.message_id === fresh.message_id) {
        mergedTodos.push({ ...fresh, message: old.message, forward_text: old.forward_text });
      } else mergedTodos.push(fresh);
    } else mergedTodos.push(old);
  }
  for (const fresh of upsertTodos.values()) mergedTodos.push(fresh);

  const { delta: _d, base_version: _bv, tasks_upsert: _tu, tasks_remove: _tr, todos_upsert: _mu, todos_remove: _mr, events_unchanged, ...rest } = next;
  data = {
    ...data,
    ...rest,
    tasks: mergedTasks,
    todos: mergedTodos,
    events: events_unchanged ? data.events : (next.events ?? data.events),
  };
}

let lastVersion = -1;
let polling = false;
async function poll() {
  if (polling) return;
  if (AD_HOST.kind === "mobile" && !AD_HOST.server) {
    online = false;
    showStatus();
    connectDialog();
    return;
  }
  polling = true;
  try {
    // ?compact=1&since: incremental compact delta while active, {unchanged} while idle.
    const next = await api(data ? `/api/state?compact=1&since=${lastVersion}` : "/api/state?compact=1");
    online = true;
    lastUpdated = new Date().toISOString();
    if (!next.unchanged) {
      applyStateUpdate(next);
      lastVersion = next.version;
      if (resyncToasts) toastSeq = Number(next.alert_seq) || 0;
      checkAlerts();
      if (todoSearch.trim()) scheduleServerSearch(todoSearch, renderTodos);
      if (taskSearch.trim()) scheduleServerSearch(taskSearch, renderTasks);
    }
    resyncToasts = false;
  } catch (e) {
    online = false;
    if (e.status === 403 && AD_HOST.kind === "mobile") connectDialog("Ключ не подошёл: на ПК его могли сменить. Вставьте новую ссылку.");
  } finally {
    polling = false;
  }
  render();
  showStatus();
}

function showStatus() {
  if (data) return;
  $("#sb-main").textContent = AD_HOST.kind === "mobile" && !AD_HOST.server ? "Телефон не подключён к ПК"
    : online ? "Загрузка…" : "Нет связи с Agent Desk на ПК";
}

// Phone app: the background watcher runs while the phone is paired and "Уведомления на телефоне"
// is on. After the first pairing the settings dialog shows what Android may still block.
async function startWatch(explain) {
  if (AD_HOST.kind !== "mobile" || !AD_HOST.server || !AD_HOST.watch.available) return;
  try {
    await AD_HOST.watch.start();
    const st = await AD_HOST.watch.status();
    if (explain && st && !(st.notifications && st.unrestricted) && !localStorage.getItem("ad.bgHint")) {
      localStorage.setItem("ad.bgHint", "1");
      ACTIONS["phone-notify"]();
    }
  } catch { /* refused by the native part: the settings dialog shows the reason */ }
}

function closeDialog() {
  $("#modal-layer").classList.add("hidden");
  $("#modal-layer").innerHTML = "";
  if (dialogReturnFocus?.isConnected) dialogReturnFocus.focus();
  dialogReturnFocus = null;
}

// Phone app: the PC address and key come from the pairing link.
function connectDialog(reason) {
  if (document.querySelector("#pair-link")) return;
  const cur = AD_HOST.server;
  dialog("Подключение к ПК", `<div class="msg"><img src="${icon("world-0")}" alt=""><div>
    ${reason ? `<p><b>${esc(reason)}</b></p>` : ""}
    <p>На ПК откройте Agent Desk → Файл → «Подключить телефон…» и отсканируйте QR-код. Или отправьте ссылку себе (например, в «Избранное» мессенджера), скопируйте её здесь и вставьте в поле.</p>
    <p>Телефон и ПК должны быть в одной Wi-Fi сети.</p>
    <div class="field-row-stacked"><label for="pair-link">Ссылка подключения</label>
    <input type="text" id="pair-link" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="http://192.168.1.10:8098/?key=…" value="${esc(cur ? `${cur.base}/?key=${cur.key}` : "")}"></div>
    <p id="pair-error"></p></div></div>
    <div class="buttons">${scanner() ? '<button id="pair-scan">Сканировать QR-код</button>' : ""}<button id="pair-ok" class="default">Подключить</button><button id="pair-paste">Вставить</button>${cur ? '<button id="pair-forget">Отключить</button>' : ""}<button data-close>Отмена</button></div>`,
  (node) => {
    const input = node.querySelector("#pair-link");
    const err = node.querySelector("#pair-error");
    const ok = node.querySelector("#pair-ok");
    node.querySelector("#pair-paste").onclick = async () => {
      try { input.value = await navigator.clipboard.readText(); } catch { input.focus(); err.textContent = "Не удалось прочитать буфер обмена: вставьте ссылку долгим нажатием."; }
    };
    node.querySelector("#pair-forget")?.addEventListener("click", () => {
      AD_HOST.forgetServer();
      data = null;
      lastVersion = -1;
      closeDialog();
      poll();
    });
    const connect = async () => {
      const s = AD_HOST.parseLink(input.value);
      if (!s) { err.textContent = "Это не ссылка подключения: в ней должен быть адрес ПК и ключ (…/?key=…)."; return; }
      ok.disabled = true;
      err.textContent = "Проверяю…";
      try {
        await api("/api/state?since=-2", undefined, s);
        AD_HOST.setServer(s);
        data = null;
        lastVersion = -1;
        seenAlerts = null;
        toastSeq = null;
        closeDialog();
        poll();
        if (phoneNotify) startWatch(true);
      } catch (e) {
        err.textContent = e.status === 403 ? "Ключ не подошёл. Скопируйте ссылку на ПК заново."
          : "ПК не отвечает. Проверьте: Agent Desk запущен, телефон в той же Wi-Fi сети, на ПК включён доступ из Wi-Fi и Agent Desk разрешён в брандмауэре.";
      } finally {
        ok.disabled = false;
      }
    };
    ok.onclick = connect;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
    node.querySelector("#pair-scan")?.addEventListener("click", async (e) => {
      const s = scanner();
      e.target.disabled = true;
      err.textContent = "";
      try {
        // Google code scanner: the camera screen comes from Google Play services, no camera permission needed.
        const { available } = await s.isGoogleBarcodeScannerModuleAvailable();
        if (!available) {
          await s.installGoogleBarcodeScannerModule();
          err.textContent = "Загружаю модуль сканера от Google Play… Нажмите «Сканировать» ещё раз через несколько секунд.";
          return;
        }
        const { barcodes } = await s.scan({ formats: ["QR_CODE"] });
        const text = barcodes?.[0]?.rawValue || barcodes?.[0]?.displayValue;
        if (!text) return;
        input.value = text;
        connect();
      } catch (x) {
        const m = String(x?.message || x);
        err.textContent = /cancel/i.test(m) ? "" : `Сканер не запустился: ${m}. Вставьте ссылку вручную.`;
      } finally {
        e.target.disabled = false;
      }
    });
  });
}

// The QR scanner plugin of the Android app (missing in a browser).
function scanner() {
  return window.Capacitor?.Plugins?.BarcodeScanner || null;
}

async function act(path, body) {
  try { await api(path, body); } catch (e) { alertBox("Ошибка", `Не получилось: ${e.message}`, "msg_error-0"); }
  await poll();
}

// --- dialogs --------------------------------------------------------------------

function dialog(title, html, onMount, opts = {}) {
  const layer = $("#modal-layer");
  if (layer.classList.contains("hidden")) dialogReturnFocus = document.activeElement;
  const node = $("#tpl-dialog").content.firstElementChild.cloneNode(true);
  node.setAttribute("role", "dialog");
  node.setAttribute("aria-modal", "true");
  node.setAttribute("aria-label", title);
  if (opts.wide) node.classList.add("dialog-wide");
  node.querySelector(".title-bar-text").textContent = title;
  node.querySelector(".window-body").innerHTML = html;
  const close = closeDialog;
  node.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); });
  layer.innerHTML = "";
  layer.appendChild(node);
  layer.classList.remove("hidden");
  const focusables = [...node.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href], [tabindex="0"]')].filter((n) => n.getClientRects().length);
  const preferred = focusables.find((n) => !n.hasAttribute("data-close") && n.nodeName !== "BUTTON") || focusables[0];
  preferred?.focus();
  onMount?.(node, close);
}

function alertBox(title, text, ico = "msg_information-0") {
  dialog(title, `<div class="msg"><img src="${icon(ico)}" alt=""><div>${esc(text)}</div></div>
    <div class="buttons"><button data-close>OK</button></div>`);
}

function markerFolders() {
  return data.config.watch.map((w) => w.path);
}

function uncPath(path) {
  // Another computer (Astra's laptop) reaches C:\Users\... through the PC's "Users" share.
  const m = /^[A-Za-z]:\\Users\\(.*)$/.exec(path);
  return m && data.host ? `\\\\${data.host}\\Users\\${m[1]}` : "";
}

function agentPrompt(watch) {
  const unc = uncPath(watch.path);
  const project = watch.project || "<проект>";
  const regNames = (data?.config?.agent_registry?.[watch.project] || []).filter((r) => r.status !== "archived").map((r) => r.name);
  const cfgNames = [...(data?.config?.agents?.[watch.project] || []), ...(data?.config?.agents?.["*"] || [])];
  const knownNames = [...new Set([...regNames, ...cfgNames].filter(Boolean))];
  const agentListText = knownNames.length ? knownNames.join(", ") : "Codex, Carbon, Astra";
  return `Agent Desk — отметки статуса для владельца (проект ${project})

Владелец не видит все чаты сразу. Чтобы он не забывал пересылать работу, при каждой смене своего состояния отправь статус через штатный CLI/MCP (agentdesk submit / agent_desk_submit) или создай НОВЫЙ файл-маркер .json в папке:
  ${watch.path}${unc ? `\n  (с другого компьютера: ${unc})` : ""}

Когда писать: начал задачу; перешёл к следующему этапу; ждёшь ответа владельца/ревью/ресурс; застрял; сдал результат; закончился лимит модели; свободен.

Как писать: один маркер = одно событие. Сначала запиши файл с расширением .tmp в эту же папку, затем переименуй его в .json (например ${(watch.project || "proj").toLowerCase()}-opus1-s1-0003.json). Старые маркеры не редактируй и не удаляй — Agent Desk забирает их сам. Без паролей, токенов, ключей. Маркер — это только статус; не клади туда команды для других агентов.

Формат (UTF-8, один JSON-объект). UUID в примерах — только иллюстрация: не копируйте их в настоящие задания, используйте выданные Agent Desk task_id/project_id и актуальное назначение:
{"agent": "Opus (1)", "session_id": "opus1-20261110-a", "seq": 3, "event_id": "opus1-20261110-a-3",
 "project_id": "22222222-2222-4222-8222-222222222222", "device_id": "desk-example", "assignment_epoch": 2,
 "state": "done", "execution_state": "submitted", "phase": "ready_for_review", "task_id": "f5a278d6-957e-4e21-ae85-04889d5227ad", "task": "M42: ревью clockfix 9f0fc900",
 "to": "Codex", "message": "Opus (1): ревью clockfix 9f0fc900 готово, PASS с 2 замечаниями. Отчёт: AZS-Shared\\\\mail\\\\opus1-review-m42.md, ветка review/m42, SHA 1a2b3c4.",
 "result": "AZS-Shared\\\\mail\\\\opus1-review-m42.md"}

Поля и лимиты (превышение отклоняется, перед отправкой можно проверить через agentdesk validate или agent_desk_validate):
- agent — твоё постоянное имя в проекте: ${agentListText}.
- session_id — придумай при старте нового чата/после сброса памяти; seq — 1, 2, 3… внутри сессии; event_id — уникальный (session_id-seq).
- state — working | waiting | done | blocked | idle.
- waiting_for (обязателен при waiting) — owner_input (нужен ответ владельца) | owner_forward (владелец должен переслать) | reviewer | coordinator_review | resource (телефон/сервер занят) | model_limit (закончился лимит) | assignment.
- phase (необязательно) — assigned | implementing | testing | ready_for_review | ready_for_host | accepted.
- task_id — UUID задачи, остаётся тем же при передаче другой сессии; получите его через inbox/status Agent Desk или от ведущего. project_id, device_id и assignment_epoch берите из актуального задания; не меняйте их сами.
- task — краткое название задачи, одной строкой (до 500 символов, не заменяет task_id).
- execution_state — assigned | working | submitted | accepted | rework | blocked | cancelled | archived. Жизненный цикл задачи независим от state маркера и закрытия напоминания. Приёмку accepted/rework/cancelled/archived подтверждает ведущий; сдача результата — submitted.
- checkpoint — структурированные repo, branch, commit, report, manifest, next_step, verification_steps, out_dir, constraints, skills; artifacts — список path/hash/status. Только разрешённые пути, без секретов и произвольных команд.
- to — кому владелец должен переслать результат (имя агента). Указывай, когда сдал работу или ждёшь ревью/приёмки.
- message — готовый короткий текст для пересылки адресату (до 20000 символов, общий конверт <= 58000 Б UTF-8): что сделано, ветка/SHA, путь к отчёту, что нужно от адресата.
- message_id — глобальный UUID сообщения, не локальный display_id AD-n. При ответе используйте неизменный task_id задания.
- ack — если переслали «[Agent Desk] message_id: <UUID>», в первом маркере working укажите "ack": "<этот UUID>" (несколько — списком UUID). Это только квитанция получения: ACK не означает принятие задачи, выполнение или приёмку. Старые локальные AD-n/AB-n поддерживаются для совместимости, но не используйте их для новых сообщений между компьютерами.
- note (до 1000 символов), result (до 400 символов — только краткий итог или путь к отчёту).

Примеры одной строкой:
{"agent":"Hoplite","session_id":"hop-m41-a","seq":1,"event_id":"hop-m41-a-1","state":"working","execution_state":"working","phase":"assigned","project_id":"22222222-2222-4222-8222-222222222222","device_id":"desk-example","assignment_epoch":2,"task_id":"f5a278d6-957e-4e21-ae85-04889d5227ad","task":"M41: офлайн-сверка O6","ack":"4922e0e3-c28f-4cfa-8a76-2bc264c39cf8"}
{"agent":"Opus (2)","session_id":"o2-v7-b","seq":5,"event_id":"o2-v7-b-5","state":"waiting","waiting_for":"owner_input","task":"v7: откатывать PR #41 или чинить?"}
{"agent":"Astra","session_id":"astra-1110","seq":2,"event_id":"astra-1110-2","state":"waiting","waiting_for":"model_limit","task":"Ревью clockfix","note":"лимит до 03:00"}`;
}

// The PC builds the text (sender, addressee, message_id), so every device copies the same thing.
function forwardText(t) {
  return t.forward_text || t.message;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Plain-http pages on the phone have no Clipboard API.
    const focus = document.activeElement;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (focus?.isConnected) focus.focus();
    return ok;
  }
}

async function copyPromptText(text, button, recipient) {
  const ok = await copyText(text);
  if (!ok) {
    dialog("Скопируйте задание вручную", '<p>Буфер обмена недоступен. Текст выделен целиком — нажмите Ctrl+C.</p><textarea id="manual-copy" readonly aria-label="Полный промпт"></textarea><div class="buttons"><button data-close>Закрыть</button></div>', node => {
      const field = node.querySelector("#manual-copy"); field.value = text; field.focus(); field.select();
    }, { wide: true });
    return false;
  }
  $("#copy-status").textContent = `Скопировано${recipient ? ` для ${recipient}` : ""}. Вставьте в чат агента. Копирование не отмечает доставку или получение.`;
  if (button) {
    const label = button.querySelector("span") || button, previous = label.textContent;
    label.textContent = "Скопировано";
    setTimeout(() => { if (label.isConnected) label.textContent = previous; }, 1500);
  }
  return true;
}

// --- other computers of the Wi-Fi (core/peers.js) -------------------------------

// The changing part of the "Другие компьютеры" dialog: render() redraws it in place while it is open.
function peersLive(canPair) {
  const link = data.link;
  if (!link) return '<p class="peer-warn" data-key="old">На ПК старая версия Agent Desk: обновите её, чтобы связать компьютеры.</p>';
  const btn = (action, label, id, extra = "") => (canPair ? `<button data-peer="${action}" data-id="${esc(id)}"${extra}>${label}</button>` : "");
  const row = (key, ico, text, buttons = "") =>
    `<div class="peer-row" data-key="${esc(key)}"><img src="${icon(ico)}" alt=""><div class="peer-text">${text}</div>${buttons}</div>`;
  const box = (key, title, rows) => `<fieldset class="peer-box" data-key="${key}"><legend>${title}</legend>${rows}</fieldset>`;
  const agentsOf = (p) => [...new Set(Object.values(p.agents || {}).flat())];
  const state = (p) => {
    const parts = [];
    if (p.online === null) parts.push("проверяю связь…");
    else if (!p.online) parts.push(`<span class="bad">не в сети</span>${p.error ? ` <span class="sub">(${esc(p.error)})</span>` : ""}`);
    else {
      const n = agentsOf(p).length;
      parts.push(`<span class="ok">в сети</span>${n ? `, агентов: ${n}` : ""}`);
    }
    if (p.last_connected_at || p.synced) parts.push(`связь: ${esc(ago(p.last_connected_at || p.synced))}`);
    if (p.pending_events) parts.push(`в очереди: ${esc(p.pending_events)}`);
    if (p.compat_reason) parts.push(`<span class="bad">${esc(p.compat_reason)}</span>`);
    if (Array.isArray(p.conflicts) && p.conflicts.length) parts.push(`<span class="bad">конфликт: ${esc(p.conflicts.at(-1).reason)}</span>`);
    return parts.join(" · ");
  };
  const out = [];
  if (!link.lan) {
    out.push(`<p class="peer-warn" data-key="lan"><b>Доступ из Wi-Fi выключен</b> — другие компьютеры не видят этот.${canPair ? ' <button data-peer="lan">Включить</button>' : ""}</p>`);
  }
  if (link.requests?.length) {
    out.push(box("req", "Просят подключиться", link.requests.map((r) => row(`r:${r.id}`, "msg_question-2",
      `<b>«${esc(r.name)}»</b> <span class="sub">${esc(r.ip)}</span><br>Код <b class="peer-code">${esc(r.code)}</b> — разрешайте, только если там показан этот же код`,
      btn("accept", "Разрешить", r.id) + btn("reject", "Отклонить", r.id))).join("")));
  }
  if (link.outgoing?.length) {
    out.push(box("out", "Ждут разрешения", link.outgoing.map((o) => row(`o:${o.id}`, "application_hourglass-1",
      `<b>«${esc(o.name)}»</b><br>Код <b class="peer-code">${esc(o.code)}</b> — на том компьютере нажмите «Разрешить»`,
      btn("cancel", "Отменить", o.id))).join("")));
  }
  const peers = link.peers || [];
  out.push(box("peers", "Подключённые компьютеры", peers.length
    ? peers.map((p) => row(`p:${p.id}`, p.online === false ? "msg_warning-2" : "network_normal_two_pcs-1",
      `<b>«${esc(p.name)}»</b> <span class="sub">${esc(String(p.base || "").replace("http://", ""))}</span><br><span title="${esc(agentsOf(p).join(", "))}">${state(p)}</span>`,
      btn("sync", "Сверить", p.id) + btn("remove", "Отключить", p.id))).join("")
    : '<p class="sub" data-key="none">Пока нет. Запустите Agent Desk на другом компьютере этой Wi-Fi сети и подключите его здесь.</p>'));
  if (canPair && link.lan) {
    const near = link.nearby || [];
    out.push(box("near", "Найдены в Wi-Fi", near.length
      ? near.map((n) => row(`n:${n.id}`, "computer-1", `<b>«${esc(n.name)}»</b> <span class="sub">${esc(n.ip)}</span>`,
        btn("connect", "Подключить", n.id, ` data-address="${esc(`${n.ip}:${n.port}`)}"`))).join("")
      : `<p class="sub" data-key="none">${link.discovery ? "Ищу… На другом компьютере тоже включите доступ из Wi-Fi. Если он не находится, введите его адрес ниже." : "Поиск выключен: введите адрес другого компьютера ниже."}</p>`));
  }
  return out.join("");
}

function notifySettingsDialog() {
  if (!online) { alertBox("Тихие часы и проекты", "Нет связи: настройка сейчас недоступна."); return; }
  const qh = data.config?.quiet_hours || { enabled: false, start: "23:00", end: "08:00" };
  const np = data.config?.notify_projects || {};
  const ps = data.phone_status || {};
  const projects = allProjects();
  const phoneText = ps.connected
    ? `<span class="ok">подключён ✓</span> (активных опросов: ${esc(ps.waiting_pollers ?? 0)}${ps.last_seen_at ? `, сигнал ${esc(ago(ps.last_seen_at))}` : ""})`
    : ps.last_seen_at
      ? `<span class="bad">телефон отключён</span> (последний опрос: ${esc(hhmm(ps.last_seen_at))} · ${esc(ago(ps.last_seen_at))}) — уведомления ждут на ПК без повторов`
      : "телефон ещё не обращался к ПК в этой сессии";
  const projRows = projects.length
    ? projects.map((p, i) => `<div class="field-row"><input type="checkbox" id="notify-proj-${i}"${np[p] !== false ? " checked" : ""}><label for="notify-proj-${i}">${esc(p)}</label></div>`).join("")
    : '<p class="sub">Проектов пока нет; новые проекты получают уведомления по умолчанию.</p>';
  dialog("Тихие часы и уведомления по проектам", `<form id="notify-settings-form">
    <p><b>Состояние телефона:</b> ${phoneText}</p>
    <fieldset><legend>Тихие часы (ПК и телефон)</legend>
      <div class="field-row"><input type="checkbox" id="qh-enabled"${qh.enabled ? " checked" : ""}><label for="qh-enabled">Подавлять всплывающие окна и звуковые сигналы по расписанию</label></div>
      <div class="quiet-grid"><label for="qh-start">С:</label><input type="time" id="qh-start" value="${esc(qh.start || "23:00")}"><label for="qh-end">До:</label><input type="time" id="qh-end" value="${esc(qh.end || "08:00")}"></div>
      <p class="sub">Карточки и события сохраняются на доске как обычно; одинаковые напоминания по открытой карточке дедуплицируются.</p>
    </fieldset>
    <fieldset><legend>Уведомления по проектам</legend>${projRows}</fieldset>
    <p id="notify-settings-error" class="bad" role="status"></p>
    <div class="buttons"><button type="submit" id="notify-settings-save">Сохранить</button><button type="button" data-close>Отмена</button></div>
  </form>`, (node) => {
    node.querySelector("#qh-enabled").checked = Boolean(qh.enabled);
    node.querySelector("#qh-start").value = qh.start || "23:00";
    node.querySelector("#qh-end").value = qh.end || "08:00";
    projects.forEach((p, i) => { node.querySelector(`#notify-proj-${i}`).checked = np[p] !== false; });
    node.querySelector("#notify-settings-form").onsubmit = async (e) => {
      e.preventDefault();
      const save = node.querySelector("#notify-settings-save"), err = node.querySelector("#notify-settings-error");
      if (save.disabled) return;
      const start = node.querySelector("#qh-start").value || "23:00";
      const end = node.querySelector("#qh-end").value || "08:00";
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(end)) {
        err.textContent = "Время должно быть в формате ЧЧ:ММ (00:00–23:59).";
        return;
      }
      const nextProjects = { ...np };
      projects.forEach((p, i) => { nextProjects[p] = Boolean(node.querySelector(`#notify-proj-${i}`).checked); });
      const body = { quiet_hours: { enabled: Boolean(node.querySelector("#qh-enabled").checked), start, end }, notify_projects: nextProjects };
      save.disabled = true; err.textContent = "Сохраняю…";
      try {
        await api("/api/config", body);
        Object.assign(data.config, body);
        await poll();
        if (node.isConnected) closeDialog();
      } catch (error) {
        if (node.isConnected) err.textContent = `Не сохранено: ${error.message}`;
      } finally {
        if (node.isConnected) save.disabled = false;
      }
    };
  });
}

function diagnosticsDialog() {
  const p = data?.pipeline || {
    pending: 0,
    queued: (data?.link?.peers || []).reduce((s, x) => s + (x.pending_events || 0), 0),
    rejected: (data?.rejected || []).length,
    applied: (data?.events || []).length,
    acked: (data?.todos || []).filter((t) => t.acked_at).length,
  };
  const rejected = [...(data?.rejected || [])].reverse();
  const rowsHtml = rejected.length ? `<div class="sunken-panel diag-panel"><table class="diag-table"><thead><tr><th>Файл / проект / seq</th><th>Поле / ожидание</th><th>Режим / подсказка</th></tr></thead><tbody>${rejected.map((r, idx) => `<tr data-key="rej:${idx}">
    <td><code>${esc(r.file || "marker.json")}</code><br><span class="sub">проект: ${esc(r.project || "не указан")} · seq: ${esc(r.seq ?? "—")}${r.time ? ` · ${esc(hhmm(r.time))}` : ""}</span></td>
    <td><b>${esc(r.field || "marker")}</b> <span class="sub">(${esc(r.code || "MARKER_REJECTED")})</span><br><span class="sub">ожидается: ${esc(Array.isArray(r.expected) && r.expected.length ? r.expected.join(" | ") : "см. схему маркера")}</span></td>
    <td><span class="${r.retryable ? "ok" : "bad"}">${r.retryable ? "временно" : "постоянно"}</span><br>${esc(r.hint || r.error || "")}</td>
  </tr>`).join("")}</tbody></table></div>` : '<p class="sub">Отклонённых маркеров нет.</p>';
  dialog("Диагностика конвейера и отказы маркеров", `<p>Стадии прохождения событий (раздельно от приёмки задач):</p>
    <div class="pipeline-bar" role="region" aria-label="Стадии обработки маркеров">
      <span class="pipeline-chip">Не обработано: <b>${esc(p.pending ?? 0)}</b></span>
      <span class="pipeline-chip">В очереди: <b>${esc(p.queued ?? 0)}</b></span>
      <span class="pipeline-chip${(p.rejected || 0) > 0 ? " bad" : ""}">Отклонено: <b>${esc(p.rejected ?? 0)}</b></span>
      <span class="pipeline-chip">Применено: <b>${esc(p.applied ?? 0)}</b></span>
      <span class="pipeline-chip">ACK: <b>${esc(p.acked ?? 0)}</b></span>
    </div>
    <h3>Отклонённые маркеры</h3>
    ${rowsHtml}
    <p class="sub">Отклонённый маркер хранится в архиве <code>bad/</code> без изменений; исправление всегда записывается отдельным новым событием со следующим <code>seq</code>. Проверка до записи: <code>agentdesk validate --file marker.json</code>.</p>
    <h3>Безопасный диагностический экспорт</h3>
    <p class="sub">Содержит только агрегаты и коды отказов; ключи, промпты и локальные корни по умолчанию скрыты.</p>
    <textarea id="diag-json" class="short-text" readonly placeholder="Нажмите «Сформировать и скопировать экспорт»…"></textarea>
    <p id="diag-status" class="sub" role="status"></p>
    <div class="buttons wrap"><button type="button" id="diag-export"${online ? "" : " disabled"}>Сформировать и скопировать экспорт</button>${rejected.length && isLocal && AD_HOST.kind !== "mobile" ? `<button type="button" id="diag-clear"${online ? "" : " disabled"}>Очистить список отказов</button>` : ""}<button type="button" data-close>Закрыть</button></div>`, (node) => {
    node.querySelector("#diag-export").onclick = async () => {
      const st = node.querySelector("#diag-status"), ta = node.querySelector("#diag-json");
      st.textContent = "Запрашиваю сводку…";
      try {
        const exp = await api("/api/diagnostics");
        ta.value = JSON.stringify(exp, null, 2);
        const ok = await copyText(ta.value);
        st.textContent = ok ? "Безопасный диагностический JSON скопирован в буфер обмена." : "Экспорт сформирован: выделите JSON и нажмите Ctrl+C.";
        if (!ok) { ta.focus(); ta.select(); }
      } catch (err) {
        st.textContent = `Не удалось получить экспорт: ${err.message}`;
      }
    };
    const clearBtn = node.querySelector("#diag-clear");
    if (clearBtn) clearBtn.onclick = async () => {
      await act("/api/rejected/clear", {});
      if (node.isConnected) diagnosticsDialog();
    };
  }, { wide: true });
}

async function launchTaskAdapter(t) {
  if (!online || !canCoordinate(t)) return;
  try {
    const res = await api("/api/tasks/launch", {
      task_id: t.task_id,
      project: t.project,
      project_id: t.project_id,
      assignment_epoch: taskEpoch(t),
      adapter: t.assignment?.adapter || "mock-dry-run",
      request_id: `ui-launch-${t.task_id.slice(0, 8)}-e${taskEpoch(t)}`,
    });
    await poll();
    const rec = res.receipt || {};
    alertBox("Квитанция адаптера запуска", `${rec.reason || "Запуск отправлен."}\nАдаптер: ${rec.adapter || ""}${rec.duplicate ? " (повтор — идемпотентно)" : ""}\nЭто только квитанция отправки: задача перейдёт в работу только после фактического ACK агента.`, "msg_information-0");
  } catch (err) {
    alertBox("Запуск недоступен", err.message, "msg_warning-2");
  }
}

function agentRegistryDialog() {
  const resMap = data?.resources || {};
  const adapters = listValues(data?.adapters);
  const regMap = data?.config?.agent_registry || {};
  const canEdit = online && isLocal && AD_HOST.kind !== "mobile";
  const curProj = project === "*" ? (allProjects()[0] || "Demo") : project;
  const entries = regMap[curProj] || [];
  const resLine = (label, r) => {
    if (!r) return `<li><b>${label}:</b> <code>UNKNOWN</code> (источник не подключён · только чтение)</li>`;
    const fresh = r.freshness_sec !== null && r.freshness_sec !== undefined ? `свежесть: ${r.freshness_sec} с` : "свежесть неизвестна";
    return `<li><b>${label}:</b> <code>${esc(r.status || "UNKNOWN")}</code>${r.holder ? ` · занято: <b>${esc(r.holder)}</b>` : ""} · источник: <code>${esc(r.source || "unconfigured")}</code> · ${esc(fresh)}${r.reason ? ` <span class="sub">(${esc(r.reason)})</span>` : ""}</li>`;
  };
  const regRows = entries.length ? `<div class="sunken-panel diag-panel"><table class="diag-table"><thead><tr><th>Агент / алиасы</th><th>Профиль / канал / устройство</th><th>Статус / сессия</th></tr></thead><tbody>${entries.map((r, i) => `<tr data-key="reg:${i}">
    <td><b>${esc(r.name)}</b>${r.aliases?.length ? `<br><span class="sub">алиасы: ${esc(r.aliases.join(", "))}</span>` : ""}</td>
    <td>${r.capabilities?.length ? esc(r.capabilities.join(", ")) : '<span class="sub">возможности не заявлены (не угадываются)</span>'}<br><span class="sub">канал: ${esc(r.verified_channel || "не подтверждён")} · ПК: ${esc(deviceLabel(r.device_id))}</span></td>
    <td><code>${esc(r.status)}</code>${r.session_id ? `<br><span class="sub">сессия привязана</span>` : ""}${canEdit && r.status === "active" ? `<br><button type="button" data-rotate-agent="${esc(r.name)}" data-rotate-proj="${esc(curProj)}">Сменить сессию</button>` : ""}</td>
  </tr>`).join("")}</tbody></table></div>` : `<p class="sub">В проекте «${esc(curProj)}» пока нет записей реестра. Возможности агентов никогда не выдумываются из имени провайдера.</p>`;

  dialog("Реестр агентов, адаптеры и ресурсы", `<h3>Ресурсы (только чтение, без захвата блокировок)</h3>
    <ul class="receipt-list">${resLine("Телефон", resMap.phone)}${resLine("Сервер", resMap.server)}</ul>
    <h3>Адаптеры запуска</h3>
    <ul class="receipt-list">${adapters.length ? adapters.map((ad) => `<li><code>${esc(ad.adapter)}</code> (${esc(ad.mode)}): <span class="${ad.available ? "ok" : "bad"}">${ad.available ? "доступен" : "отключён"}</span> — ${esc(ad.reason || "")}</li>`).join("") : "<li><code>manual</code>: ручной режим по умолчанию</li>"}</ul>
    <h3>Реестр агентов — проект «${esc(curProj)}»</h3>
    ${regRows}
    ${canEdit ? `<form id="reg-form"><fieldset><legend>Добавить / обновить агента в проекте</legend>
      <div class="assignment-grid">
        <div class="field-row-stacked"><label for="reg-proj">Проект</label><input type="text" id="reg-proj" value="${esc(curProj)}" required maxlength="60"></div>
        <div class="field-row-stacked"><label for="reg-name">Имя агента</label><input type="text" id="reg-name" required maxlength="60" placeholder="Carbon"></div>
      </div>
      <div class="assignment-grid">
        <div class="field-row-stacked"><label for="reg-aliases">Алиасы (через запятую)</label><input type="text" id="reg-aliases" maxlength="240" placeholder="карбон, carbon-1"></div>
        <div class="field-row-stacked"><label for="reg-caps">Подтверждённые возможности (через запятую)</label><input type="text" id="reg-caps" maxlength="240" placeholder="cli, review"></div>
      </div>
      <div class="assignment-grid">
        <div class="field-row-stacked"><label for="reg-status">Статус в проекте</label><select id="reg-status"><option value="active">active (активен)</option><option value="paused">paused (пауза)</option><option value="archived">archived (архив)</option></select></div>
        <div class="field-row-stacked"><label for="reg-adapter">Адаптер</label><select id="reg-adapter"><option value="manual">manual (вручную)</option><option value="mock-dry-run">mock-dry-run (локальный тест)</option></select></div>
      </div>
      <p id="reg-msg" class="sub" role="status"></p>
      <div class="buttons"><button type="submit" id="reg-save">Сохранить агента</button><button type="button" data-close>Закрыть</button></div>
    </fieldset></form>` : '<div class="buttons"><button type="button" data-close>Закрыть</button></div>'}`, (node) => {
    node.addEventListener?.("click", async (e) => {
      const btn = e.target?.closest?.("[data-rotate-agent]");
      if (!btn) return;
      btn.disabled = true;
      try {
        await api("/api/agents/rotate-session", { project: btn.dataset.rotateProj, agent: btn.dataset.rotateAgent });
        await poll();
        if (node.isConnected) agentRegistryDialog();
      } catch (err) {
        const msg = node.querySelector("#reg-msg");
        if (msg) msg.textContent = `Ошибка смены сессии: ${err.message}`;
        btn.disabled = false;
      }
    });
    const form = node.querySelector("#reg-form");
    if (form) form.onsubmit = async (e) => {
      e.preventDefault();
      const save = node.querySelector("#reg-save"), msg = node.querySelector("#reg-msg");
      const entry = {
        name: node.querySelector("#reg-name").value.trim(),
        aliases: node.querySelector("#reg-aliases").value.split(",").map((s) => s.trim()).filter(Boolean),
        capabilities: node.querySelector("#reg-caps").value.split(",").map((s) => s.trim()).filter(Boolean),
        status: node.querySelector("#reg-status").value || "active",
        adapter: node.querySelector("#reg-adapter").value || "manual",
        device_id: data.device_id,
      };
      save.disabled = true;
      try {
        await api("/api/agents/registry", { project: node.querySelector("#reg-proj").value.trim(), entry });
        await poll();
        if (node.isConnected) agentRegistryDialog();
      } catch (err) {
        msg.textContent = `Не сохранено: ${err.message}`;
      } finally {
        if (node.isConnected) save.disabled = false;
      }
    };
  }, { wide: true });
}

const ACTIONS = {
  "task-new"() { taskMutationDialog("assign", null); },
  "task-context-roots"() { contextRootsDialog(); },
  "tasks-show-all"() { taskRenderLimit = Number.MAX_SAFE_INTEGER; renderTasks(); },
  "agent-registry"() { agentRegistryDialog(); },
  "notify-settings"() { notifySettingsDialog(); },
  diagnostics() { diagnosticsDialog(); },
  async "quick-forward-assignment"(e) {
    const { assignTodos } = ownerActionItems();
    const cur = resolveSelectedTodo();
    const target = (cur && assignTodos.some((x) => x.id === cur.id) ? cur : assignTodos[0]) || null;
    if (!target) return;
    selected = selectTodoRef(target);
    applySelection();
    await ensureFullTodo(target);
    await copyPromptText(forwardText(target), e?.target?.closest("button"), target.to);
  },
  async "quick-forward-report"(e) {
    const { reportTodos } = ownerActionItems();
    const cur = resolveSelectedTodo();
    const target = (cur && reportTodos.some((x) => x.id === cur.id) ? cur : reportTodos[0]) || null;
    if (!target) return;
    selected = selectTodoRef(target);
    applySelection();
    await ensureFullTodo(target);
    await copyPromptText(forwardText(target), e?.target?.closest("button"), target.to);
  },
  "quick-reply"() {
    const { replyTodos } = ownerActionItems();
    const cur = resolveSelectedTodo();
    const target = (cur && replyTodos.some((x) => x.id === cur.id) ? cur : replyTodos[0]) || null;
    if (!target) return;
    selected = selectTodoRef(target);
    applySelection();
    ACTIONS.details();
  },
  "quick-review"() {
    const { submittedTasks } = ownerActionItems();
    if (!submittedTasks.length) return;
    tab = "tasks";
    taskFilter = "submitted";
    render();
    if (canCoordinate(submittedTasks[0])) taskMutationDialog("transition", submittedTasks[0], "accepted");
  },
  "quick-resource"() {
    const { resourceAgents } = ownerActionItems();
    if (resourceAgents.length) releaseResourceDialog(resourceAgents[0]);
  },
  "file-tools"() { tab = "mail"; render(); },
  "mail-roots"() { mailRootsDialog(); },
  async "file-toggle"() {
    try { await api("/api/mail/config", { enabled: !data.mail?.enabled }); await poll(); renderMail(); }
    catch (error) { alertBox("Файлы проектов", error.message); }
  },
  async "mail-refresh"(e) {
    const btn = e?.target?.closest("button");
    if (btn) btn.disabled = true;
    try { data.mail = await api("/api/mail"); renderMail(); }
    catch (error) { $("#mail-sync").textContent = `Не удалось обновить список: ${error.message}. Показаны последние данные.`; }
    finally { if (btn) btn.disabled = !online; }
  },
  about() {
    dialog("О программе", `<div class="msg"><img src="${icon("network_normal_two_pcs-0")}" alt="">
      <div><b>Agent Desk ${esc(data.app?.version || "")}</b><br>Кто из агентов работает, кто ждёт ответа и что нужно переслать.<br><br>
      Агенты появляются сами после первого маркера. Папки: ${esc(markerFolders().join("; "))}</div></div>
      <div class="buttons"><button data-close>OK</button></div>`);
  },
  howto() {
    const watches = data.config.watch;
    if (!watches.length) { alertBox("Инструкция для агентов", "Сначала добавьте папку с маркерами через Файл → Папки с маркерами."); return; }
    const tabs = watches.map((w, i) => `<li role="tab" data-howto="${i}" aria-selected="${i === 0}"><a href="#">${esc(w.project || w.path)}</a></li>`).join("");
    dialog("Инструкция для агентов", `<p>Отправьте этот текст каждому агенту проекта один раз (или попросите ведущего разослать). У каждого проекта своя папка.</p>
      <menu role="tablist">${tabs}</menu>
      <div class="window" role="tabpanel"><div class="window-body"><textarea readonly id="prompt-text"></textarea></div></div>
      <div class="buttons"><button id="copy-prompt">Копировать</button><button data-close>Закрыть</button></div>`,
    (node) => {
      const ta = node.querySelector("#prompt-text");
      const show = (i) => {
        ta.value = agentPrompt(watches[i]);
        node.querySelectorAll("[data-howto]").forEach((li) => li.setAttribute("aria-selected", li.dataset.howto === String(i)));
      };
      show(0);
      node.addEventListener("click", (e) => {
        const li = e.target.closest("[data-howto]");
        if (li) { e.preventDefault(); e.stopPropagation(); show(Number(li.dataset.howto)); }
      });
      node.querySelector("#copy-prompt").onclick = async (e) => {
        e.target.textContent = (await copyText(ta.value)) ? "Скопировано" : "Не удалось";
      };
    });
  },
  async pair() {
    const p = await api("/api/pairing");
    const links = p.urls.length ? p.urls : [p.url];
    dialog("Подключить телефон", `<div class="msg"><img src="${icon("world-0")}" alt=""><div>
      ${p.lan ? "" : "<p><b>Доступ из Wi-Fi выключен</b> — телефон не увидит ПК. Включите его кнопкой ниже.</p>"}
      <p>1. Установите на телефон приложение Agent Desk (файл AgentDesk-*.apk).<br>
      2. В приложении нажмите «Сканировать QR-код» и наведите камеру на код. Или отправьте себе ссылку, скопируйте на телефоне и вставьте в приложении.</p>
      <div class="qr-row"><div class="qr hidden" id="pair-qr"><img alt="QR-код ссылки подключения"></div>
      <div class="qr-links">${links.map((u, i) => `<p class="select-all${i ? "" : " on"}" data-link="${i}" title="Показать QR-код этой ссылки">${esc(u)}</p>`).join("")}
      ${links.length > 1 ? "<p class=\"sub\">Адресов несколько: если код не подключается, нажмите на другой адрес.</p>" : ""}</div></div>
      <p>Телефон и ПК должны быть в одной Wi-Fi сети. Ссылку можно открыть и в браузере телефона, без приложения.
      В ссылке ключ доступа — не пересылайте её другим. Если телефон не подключается, разрешите Agent Desk в брандмауэре Windows для частной сети.</p></div></div>
      <div class="buttons">${p.lan ? "" : '<button id="pair-lan">Включить доступ из Wi-Fi</button>'}<button id="pair-copy">Копировать</button><button id="pair-rotate">Сменить ключ</button><button data-close>OK</button></div>`,
    (node) => {
      let chosen = 0;
      const qrBox = node.querySelector("#pair-qr");
      const showQr = async (i) => {
        chosen = i;
        node.querySelectorAll("[data-link]").forEach((el) => el.classList.toggle("on", Number(el.dataset.link) === i));
        if (!window.agentDesk?.qr) return; // QR codes are drawn by the PC app
        try {
          const svg = await window.agentDesk.qr(links[i]);
          if (!svg) return;
          qrBox.querySelector("img").src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
          qrBox.classList.remove("hidden");
        } catch { /* no QR: the link text is still there */ }
      };
      node.querySelectorAll("[data-link]").forEach((el) => el.addEventListener("click", () => showQr(Number(el.dataset.link))));
      showQr(0);
      node.querySelector("#pair-copy").onclick = async (e) => { e.target.textContent = (await copyText(links[chosen])) ? "Скопировано" : "Не удалось"; };
      node.querySelector("#pair-rotate").onclick = async () => {
        if (!confirm("Старая ссылка перестанет работать на всех телефонах. Сменить ключ?")) return;
        await act("/api/pairing/rotate", {});
        ACTIONS.pair();
      };
      node.querySelector("#pair-lan")?.addEventListener("click", async () => {
        await act("/api/config", { lan: true });
        closeDialog();
        setTimeout(() => ACTIONS.pair(), 1500); // the PC app re-opens the port for the network
      });
    });
  },
  connect() { connectDialog(); },
  // PC <-> laptop (core/peers.js): Agent Desks of one Wi-Fi find each other, are paired once
  // (the same code on both screens), then send reminders to each other.
  peers() {
    const canPair = isLocal && AD_HOST.kind !== "mobile"; // pairing only on the PC itself
    const link = data.link || {};
    dialog("Другие компьютеры", `<div class="msg"><img src="${icon("network_normal_two_pcs-0")}" alt=""><div class="peers">
      <p>Agent Desk на другом компьютере этой же Wi-Fi сети (например, на ноутбуке) принимает задачи отсюда и присылает свои: выберите задачу и нажмите «Отправить».</p>
      <div id="peers-live" data-pair="${canPair ? 1 : 0}">${peersLive(canPair)}</div>
      ${canPair ? `<div class="field-row"><label for="peer-addr">Адрес:</label><input type="text" id="peer-addr" placeholder="192.168.1.20 или laptop:8098" autocomplete="off" autocapitalize="off" spellcheck="false"><button id="peer-add">Подключить</button></div>
      <fieldset><legend>Этот компьютер</legend>
        <div class="field-row"><label for="peer-name">Имя:</label><input type="text" id="peer-name" maxlength="60" value="${esc(link.name)}"><button id="peer-name-save">Сохранить</button></div>
        <div class="field-row"><input type="checkbox" id="peer-auto"${link.auto ? " checked" : ""}><label for="peer-auto">Пересылку агенту с другого компьютера отправлять туда самому</label></div>
      </fieldset>
      <p class="sub">Брандмауэр Windows должен пропускать Agent Desk в частной сети (TCP 8098 и UDP 8099).</p>` : '<p class="sub">Подключать компьютеры можно только на самом ПК, отправлять задачи — и с телефона.</p>'}
      <p id="peer-msg"></p></div></div>
      <div class="buttons"><button data-close class="default">OK</button></div>`,
    (node) => {
      const msg = node.querySelector("#peer-msg");
      const say = (text, bad = false) => { msg.textContent = text; msg.classList.toggle("bad", bad); };
      const run = async (action, body, btn) => {
        say("");
        if (btn) btn.disabled = true;
        try {
          const r = await api(`/api/peers/${action}`, body);
          await poll();
          return r || {};
        } catch (e) {
          say(e.message, true);
          return null;
        } finally {
          if (btn) btn.disabled = false;
        }
      };
      const connect = async (address, btn) => {
        const r = await run("connect", { address }, btn);
        if (r) say(`Запрос отправлен на «${r.name}». Там нажмите «Разрешить», если показан код ${r.code}.`);
      };
      node.addEventListener("click", async (e) => {
        const b = e.target.closest("[data-peer]");
        if (!b) return;
        const { peer: action, id, address } = b.dataset;
        if (action === "lan") { await act("/api/config", { lan: true }); return; }
        if (action === "connect") { connect(address, b); return; }
        if (action === "remove" && !confirm("Отключить этот компьютер? Задачи между ними больше не будут отправляться.")) return;
        const r = await run(action, { id }, b);
        if (r && action === "accept") say(`«${r.name}» подключён: выберите задачу и нажмите «Отправить».`);
      });
      const addr = node.querySelector("#peer-addr");
      const add = node.querySelector("#peer-add");
      add?.addEventListener("click", () => connect(addr.value, add));
      addr?.addEventListener("keydown", (e) => { if (e.key === "Enter") connect(addr.value, add); });
      node.querySelector("#peer-name-save")?.addEventListener("click", async (e) => {
        const name = node.querySelector("#peer-name").value.trim();
        if (await run("settings", { name }, e.target)) say("Имя сохранено: под ним этот компьютер видят другие.");
      });
      node.querySelector("#peer-auto")?.addEventListener("change", (e) => run("settings", { auto: e.target.checked }));
    });
  },
  "send-to-peer"() {
    const todo = selected?.type === "todo" && data.todos.find((t) => t.id === selected.id);
    const peers = data.link?.peers || [];
    if (!todo || todo.done_at || !peers.length) return;
    dialog("Отправить задачу", `<div class="msg"><img src="${icon("network_normal_two_pcs-0")}" alt=""><div>
      <p>${todoText(todo)}${todo.task ? `: ${esc(todo.task)}` : ""}</p>
      <p>На какой компьютер отправить? Там сообщение появится на доске. Доставка и ACK — только квитанции; задача не завершится и не будет принята автоматически. Для передачи исполнения используйте вкладку «Задачи» → «Передать…».</p>
      <p id="send-error" class="bad"></p></div></div>
      <div class="buttons wrap">${peers.map((p, i) => `<button data-send="${i}"${i ? "" : ' class="default"'}>«${esc(p.name)}»${p.online === false ? " — не в сети" : ""}</button>`).join("")}<button data-close>Отмена</button></div>`,
    (node, close) => {
      const buttons = [...node.querySelectorAll("[data-send]")];
      node.addEventListener("click", async (e) => {
        const b = e.target.closest("[data-send]");
        if (!b) return;
        buttons.forEach((x) => { x.disabled = true; });
        try {
          await api("/api/peers/send", { peer: peers[Number(b.dataset.send)].id, todos: [todo.id] });
          close();
          await poll();
        } catch (err) {
          node.querySelector("#send-error").textContent = `Не отправилось: ${err.message}`;
          buttons.forEach((x) => { x.disabled = false; });
        }
      });
    });
  },
  "toggle-autostart"() { act("/api/config", { autostart: !data.config.autostart }); },
  async "phone-notify"() {
    const st = (await AD_HOST.watch.status().catch(() => null)) || {};
    const mark = (ok, good, bad) => `<span class="${ok ? "ok" : "bad"}">${ok ? good : bad}</span>`;
    const last = st.lastOk ? `ПК ответил в ${hhmm(new Date(st.lastOk).toISOString())}` : "ПК пока не ответил";
    const link = !phoneNotify ? mark(false, "", "выключена")
      : st.running ? mark(!st.lastError, `работает, ${last}`, "нет связи с ПК") : mark(false, "", "не запущена");
    dialog("Уведомления на телефоне", `<div class="msg"><img src="${icon("envelope_closed-0")}" alt=""><div>
      <p>Когда Agent Desk свёрнут или экран выключен, телефон держит связь с ПК и показывает уведомление в стиле Windows 98 со звуком приложения: что случилось и что сделать.</p>
      <ul class="checklist">
        <li>Фоновая связь: ${link}${st.lastError ? ` <span class="sub">(${esc(st.lastError)})</span>` : ""}</li>
        <li>Уведомления: ${mark(st.notifications, "разрешены", "запрещены — нажмите «Уведомления…»")}</li>
        <li>Батарея: ${mark(st.unrestricted, "без ограничений", "Android может усыпить связь — нажмите «Батарея…»")}</li>
      </ul>
      <p class="sub">Nubia, RedMagic, Xiaomi и другие оболочки усыпляют фоновые приложения сильнее обычного Android. В «О приложении…» включите <b>Автозапуск</b> и выберите для батареи <b>Без ограничений</b>; в списке недавних приложений закрепите Agent Desk замком.</p>
    </div></div>
    <div class="buttons wrap"><button id="pn-toggle">${phoneNotify ? "Выключить" : "Включить"}</button><button id="pn-test"${phoneNotify ? "" : " disabled"}>Проверить</button><button id="pn-notif">Уведомления…</button><button id="pn-battery">Батарея…</button><button id="pn-app">О приложении…</button><button data-close class="default">OK</button></div>`,
    (node, close) => {
      node.querySelector("#pn-toggle").onclick = async () => {
        phoneNotify = !phoneNotify;
        localStorage.setItem("ad.phoneNotify", phoneNotify ? "1" : "0");
        try { await (phoneNotify ? AD_HOST.watch.start() : AD_HOST.watch.stop()); } catch { /* the dialog shows the state */ }
        close();
        render();
        setTimeout(() => ACTIONS["phone-notify"](), 400);
      };
      node.querySelector("#pn-test").onclick = async (e) => {
        e.target.disabled = true;
        await AD_HOST.watch.test(10);
        e.target.textContent = "Выключите экран: 10 с";
      };
      node.querySelector("#pn-notif").onclick = () => AD_HOST.watch.openNotifications();
      node.querySelector("#pn-battery").onclick = () => AD_HOST.watch.openBattery();
      node.querySelector("#pn-app").onclick = () => AD_HOST.watch.openApp();
    });
  },
  folders() {
    const rows = data.config.watch.map((w, i) => `<div class="field-row">
      <input type="text" data-i="${i}" data-f="path" value="${esc(w.path)}" style="flex:3">
      <input type="text" data-i="${i}" data-f="project" value="${esc(w.project)}" placeholder="проект" style="flex:1">
      <button data-remove="${i}">Удалить</button></div>`).join("");
    dialog("Папки с маркерами", `<p>Agent Desk следит за этими папками. Если агенту нельзя писать вне папки проекта, добавьте папку внутри проекта (например <code>D:\\AZS\\.agent-board</code>) и укажите проект.</p>
      <div id="watch-rows">${rows}</div>
      <div class="field-row"><button id="add-watch">Добавить папку</button></div>
      <div class="buttons"><button id="save-watch">OK</button><button data-close>Отмена</button></div>`,
    (node, close) => {
      const collect = () => {
        const watch = [];
        node.querySelectorAll("#watch-rows .field-row").forEach((row) => {
          const [path, project] = row.querySelectorAll("input");
          if (path.value.trim()) watch.push({ path: path.value.trim(), project: project.value.trim() });
        });
        return watch;
      };
      node.addEventListener("click", (e) => {
        const rm = e.target.closest("[data-remove]");
        if (rm) rm.closest(".field-row").remove();
      });
      node.querySelector("#add-watch").onclick = () => {
        node.querySelector("#watch-rows").insertAdjacentHTML("beforeend", `<div class="field-row">
          <input type="text" placeholder="C:\\путь\\к\\папке" style="flex:3"><input type="text" placeholder="проект" style="flex:1">
          <button data-remove>Удалить</button></div>`);
      };
      node.querySelector("#save-watch").onclick = async () => { close(); await act("/api/config", { watch: collect() }); };
    });
  },
  details() {
    if (!selected) return;
    let item, history;
    if (selected.type === "todo") {
      item = data.todos.find((t) => t.id === selected.id);
    } else {
      item = data.agents[selected.id];
    }
    if (!item) return;
    history = data.events.filter((e) => e.project === item.project && e.agent === item.agent && (!item.device_id || (e.device_id ? e.device_id === item.device_id : item.device_id === data.device_id))).slice(-8).reverse();
    const kv = (k, v) => (v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : "");
    const when = (iso) => iso && `${hhmm(iso)} · ${ago(iso)}`;
    const isTodo = selected.type === "todo";
    const linkedTask = isTodo && item.task_id ? currentTask(item.task_id) : null;
    const taskCard = linkedTask ? taskCardNumber(linkedTask) : "";
    const cardLabel = item.display_id || `AD-${item.id}`;
    const head = isTodo
      ? `${kv("Задача", item.task)}${kv("Кому переслать", item.to)}${kv("Заметка", item.note)}${kv("Результат", item.result)}
         ${kv("Карточка", cardLabel)}${taskCard && taskCard !== cardLabel ? kv("Карточка задачи", taskCard) : ""}${item.superseded_by ? kv("Версия сообщения", "заменено новым сообщением — копируйте актуальную карточку") : ""}${kv("Доставлено", when(item.delivered_at))}${kv("Переслано", when(item.forwarded_at))}${kv("Получено агентом", when(item.acked_at))}
         ${kv("Пришло с компьютера", fromDeviceLabel(item))}${kv("Отправлено на", item.sent_to && `«${item.sent_to.name}», ${when(item.sent_to.at)}${item.sent_to.auto ? " (само)" : ""}`)}${kv("Не отправилось", !item.done_at && item.send_error)}`
      : `${kv("Состояние", stateLabel(item))}${kv("Этап", item.phase)}${kv("Задача", item.task)}${kv("Кому переслать", item.to)}
         ${kv("Заметка", item.note)}${kv("Результат", item.result)}${kv("Устройство", deviceLabel(item.device_id || data.device_id))}${kv("Сессия", sessionLabel(item))}${kv("Обновлено", when(item.updated))}`;
    const hasMsg = isTodo && todoHasCopyableText(item);
    const msgBlock = hasMsg ? `<h3>Сообщение</h3><div class="msg-body"></div><p class="sub">${item.superseded_by ? "Это сообщение заменено новым: его копирование отключено, чтобы не отправить устаревший текст." : "«Копировать» добавляет заголовок Agent Desk и message_id для квитанции агента."}</p>` : "";
    const historyBlock = history.length ? `<h3>Последние события</h3><div class="sunken-panel" style="max-height:160px"><table><thead><tr><th>Время</th><th>Событие</th><th>Задача</th></tr></thead><tbody>
      ${history.map((e) => `<tr><td class="nowrap">${hhmm(e.time)}</td><td class="nowrap">${esc(stateLabel(e))}${e.to ? ` → ${esc(e.to)}` : ""}</td><td>${esc(e.task)}</td></tr>`).join("")}
      </tbody></table></div>` : "";
    const todoBtns = [];
    if (hasMsg) todoBtns.push(`<button data-action="copy-message" data-todo-id="${item.id}"${item.superseded_by ? " disabled" : ""}>Копировать</button>`);
    if (isTodo && !item.done_at && !item.superseded_by && item.kind === "forward" && !item.forwarded_at && !item.acked_at) todoBtns.push(`<button data-action="mark-forwarded" data-todo-id="${item.id}"${online ? "" : " disabled"}>Переслал</button>`);
    if (isTodo && item.kind === "limit" && !item.done_at && isLocal && AD_HOST.kind !== "mobile") todoBtns.push(`<button data-action="rotate-limit-session" data-todo-id="${item.id}"${online ? "" : " disabled"}>Сменить сессию</button>`);
    if (isTodo && !item.done_at) todoBtns.push(`<button data-action="done-selected" data-todo-id="${item.id}"${online ? "" : " disabled"}>Закрыть</button>`);
    if (isTodo && item.done_at && !item.superseded_by) todoBtns.push(`<button data-action="reopen-todo" data-todo-id="${item.id}"${online ? "" : " disabled"}>Вернуть в очередь</button>`);
    dialog(`${isTodo ? `${cardLabel} — ` : ""}${item.agent} — ${item.project}`, `<dl class="kv">${head}</dl>${technicalDetails(item)}${msgBlock}${historyBlock}
      <div class="buttons">${todoBtns.join("")}<button data-close>OK</button></div>`,
    (node) => {
      const mb = node.querySelector(".msg-body");
      if (mb) {
        if (item.message !== undefined) mb.textContent = item.message;
        else { mb.textContent = "Загружаю сообщение…"; ensureFullTodo(item).then(() => { if (node.isConnected) mb.textContent = item.message || ""; }).catch(() => {}); }
      }
    }, { wide: true });
  },
  async "rotate-limit-session"(e) {
    const button = e?.target?.closest("button");
    const id = button?.dataset.todoId ? Number(button.dataset.todoId) : selected?.type === "todo" ? selected.id : null;
    const todo = data.todos.find((t) => t.id === id);
    if (!online || !todo) return;
    closeDialog();
    await act("/api/agents/rotate-session", { project: todo.project, agent: todo.agent, task_id: todo.task_id });
  },
  "reopen-todo"(e) {
    const button = e?.target?.closest("button");
    const id = button?.dataset.todoId ? Number(button.dataset.todoId) : selected?.type === "todo" ? selected.id : null;
    const todo = data.todos.find(t => t.id === id);
    if (online && todo && !todo.superseded_by) { closeDialog(); act(`/api/todo/${id}/undo`, {}); }
  },
  async "copy-message"(e) {
    const button = e?.target?.closest("button");
    const id = button?.dataset.todoId ? Number(button.dataset.todoId) : selected?.type === "todo" ? selected.id : null;
    const todo = data.todos.find(t => t.id === id);
    if (!todoHasCopyableText(todo) || todo.superseded_by) return;
    await ensureFullTodo(todo);
    if (!todo.message) return;
    await copyPromptText(forwardText(todo), button, todo.to);
  },
  "todo-details"(e) {
    selected = { type: "todo", id: Number(e.target.closest("button").dataset.todoId) };
    ACTIONS.details();
  },
  "clear-todo-search"() {
    todoSearch = ""; $("#todo-search").value = ""; renderTodos(); $("#todo-search").focus();
  },
  "mark-forwarded"(e) {
    const button = e?.target?.closest("button");
    const id = button?.dataset.todoId ? Number(button.dataset.todoId) : selected?.type === "todo" ? selected.id : null;
    if (id !== null && online) act(`/api/todo/${id}/forwarded`, {});
  },
  "done-selected"(e) {
    const button = e?.target?.closest("button");
    const id = button?.dataset.todoId ? Number(button.dataset.todoId) : selected?.type === "todo" ? selected.id : null;
    const todo = data.todos.find(t => t.id === id);
    if (online && todo && !todo.done_at) act(`/api/todo/${id}/done`, {});
  },
  forget() {
    if (selected?.type !== "agent") return;
    const a = data.agents[selected.id];
    if (!a || (a.device_id && a.device_id !== data.device_id)) return;
    dialog("Убрать агента", `<div class="msg"><img src="${icon("msg_question-0")}" alt="">
      <div>Убрать «${esc(a.agent)}» (${esc(a.project)}) из списка? Он вернётся после следующего маркера.</div></div>
      <div class="buttons"><button id="yes">Да</button><button data-close>Нет</button></div>`,
    (node, close) => {
      node.querySelector("#yes").onclick = () => { close(); selected = null; act("/api/agent/forget", { project: a.project, agent: a.agent }); };
    });
  },
  "clear-done"() {
    showClosed = false;
    localStorage.setItem("ad.closed", "0");
    render();
  },
  "toggle-sound"() {
    soundOn = !soundOn;
    localStorage.setItem("ad.sound", soundOn ? "1" : "0");
    if (soundOn) chime();
    render();
  },
  "toggle-popup-sound"() { act("/api/config", { popup_sound: !data.config.popup_sound }); },
  volume() {
    // Laid out like the Windows 98 "Volume Control": one column per sound, vertical slider + mute.
    const column = (id, title, hint, value, muted) => `
      <div class="vol-col">
        <b>${title}</b>
        <div class="vol-hint">${hint}</div>
        <div class="vol-label">Громкость:</div>
        <div class="vol-slider"><input type="range" id="${id}-range" min="0" max="100" step="5" value="${value}" class="has-box-indicator" aria-label="${title}"></div>
        <div class="vol-value" id="${id}-value">${value}%</div>
        <input type="checkbox" id="${id}-mute"${muted ? " checked" : ""}><label for="${id}-mute">Выкл.</label>
      </div>`;
    dialog("Громкость", `<div class="vol-panel">
        ${column("vol-popup", "Уведомления", "всплывающие окна на ПК", data.config.popup_volume ?? 80, data.config.popup_sound === false)}
        ${column("vol-app", "Приложение", isNative ? "окно Agent Desk" : "это устройство", appVolume, !soundOn)}
      </div>
      <div class="buttons"><button data-close>Закрыть</button></div>`,
    (node) => {
      const bind = (id, onChange) => {
        const range = node.querySelector(`#${id}-range`);
        const mute = node.querySelector(`#${id}-mute`);
        range.addEventListener("input", () => { node.querySelector(`#${id}-value`).textContent = `${range.value}%`; });
        range.addEventListener("change", () => onChange(Number(range.value), mute.checked, !mute.checked));
        mute.addEventListener("change", () => onChange(Number(range.value), mute.checked, !mute.checked));
      };
      bind("vol-popup", async (v, muted, preview) => {
        await act("/api/config", { popup_volume: v, popup_sound: !muted });
        if (preview) chime(v);
      });
      bind("vol-app", (v, muted, preview) => {
        appVolume = v;
        soundOn = !muted;
        localStorage.setItem("ad.volume", String(v));
        localStorage.setItem("ad.sound", muted ? "0" : "1");
        if (preview) chime(v);
        render();
      });
    });
  },
  "toggle-notify"() { act("/api/config", { notify: !data.config.notify }); },
  "toggle-closed"() {
    showClosed = !showClosed;
    localStorage.setItem("ad.closed", showClosed ? "1" : "0");
    render();
  },
};

// --- events ---------------------------------------------------------------------

document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest("#todo-context-menu")) closeTodoMenu();
});
document.addEventListener("contextmenu", (e) => {
  const row = e.target.closest("tr[data-todo]");
  if (!row || !data || !$("#modal-layer").classList.contains("hidden")) { closeTodoMenu(); return; }
  e.preventDefault();
  openTodoMenu(row, e.clientX, e.clientY);
});
document.addEventListener("focusin", (e) => {
  if (!e.target.closest("#todo-context-menu")) closeTodoMenu();
});
document.addEventListener("scroll", (e) => {
  const menu = $("#todo-context-menu");
  if (menu.classList.contains("hidden")) return;
  if (e.target === document || e.target === document.documentElement || e.target === document.body) closeTodoMenu();
}, true);
window.addEventListener("resize", () => closeTodoMenu(true));
window.addEventListener("blur", () => closeTodoMenu());
document.addEventListener("click", (e) => {
  const contextAction = e.target.closest("#todo-context-menu button");
  if (contextAction) {
    e.preventDefault();
    if (!contextAction.disabled) { closeTodoMenu(true); ACTIONS[contextAction.dataset.action]?.(e); }
    return;
  }
  closeTodoMenu();
  const menu = e.target.closest("[data-menu]");
  document.querySelectorAll(".menu.open").forEach((m) => { if (m !== menu) m.classList.remove("open"); });
  if (menu && e.target.closest(".menu-label")) { menu.classList.toggle("open"); return; }
  if (menu) menu.classList.remove("open");

  const action = e.target.closest("[data-action]");
  if (action && (data || action.dataset.action === "connect")) { e.preventDefault(); if (!action.disabled) ACTIONS[action.dataset.action]?.(e); return; }

  const taskAction = e.target.closest("[data-task-action]");
  if (taskAction && data) {
    const task = currentTask(taskAction.dataset.taskId);
    if (!task || taskAction.disabled) return;
    const action = taskAction.dataset.taskAction;
    if (action === "details") taskDetails(task);
    else if (action === "context") fetchTaskContext(task);
    else if (action === "copy") copyTaskPrompt(task, taskAction);
    else if (action === "launch") launchTaskAdapter(task);
    else if (action === "review") taskMutationDialog("transition", task, "accepted");
    else if (action === "release-resource") releaseResourceDialog(boundAgentForTask(task));
    else taskMutationDialog(action, task);
    return;
  }
  const t = e.target.closest("[data-tab]");
  if (t) {
    e.preventDefault();
    tab = t.dataset.tab;
    selected = null;
    try { localStorage.setItem("ad.selected", ""); } catch { /* ignore */ }
    localStorage.setItem("ad.view", tab);
    render();
    return;
  }
  const p = e.target.closest("[data-project]");
  if (p) {
    e.preventDefault();
    project = p.dataset.project;
    localStorage.setItem("ad.project", project);
    selected = null;
    try { localStorage.setItem("ad.selected", ""); } catch { /* ignore */ }
    render();
    return;
  }
  const todoRow = e.target.closest("tr[data-todo]");
  const agentRow = e.target.closest("tr[data-agent]");
  if (todoRow) {
    const found = data?.todos?.find((x) => x.id === Number(todoRow.dataset.todo));
    selected = found ? selectTodoRef(found) : { type: "todo", id: Number(todoRow.dataset.todo) };
  } else if (agentRow) {
    selected = { type: "agent", id: agentRow.dataset.agent };
    try { localStorage.setItem("ad.selected", JSON.stringify(selected)); } catch { /* ignore */ }
  }
  if (todoRow || agentRow) applySelection();
});
document.addEventListener("dblclick", (e) => {
  if (e.target.closest("#title-text")) { ACTIONS["win-max"](); return; }
  if (selected && e.target.closest("tr[data-todo], tr[data-agent]")) ACTIONS.details();
});
document.addEventListener("mouseover", (e) => {
  // Win98 menus: once one is open, hovering another title opens it.
  const menu = e.target.closest("[data-menu]");
  if (menu && document.querySelector(".menu.open") && !menu.classList.contains("open")) {
    document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
    menu.classList.add("open");
  }
});
document.addEventListener("keydown", (e) => {
  const inDialog = !$("#modal-layer").classList.contains("hidden");
  if ((e.ctrlKey || e.metaKey) && (e.code === "KeyC" || e.key.toLowerCase() === "c")) { copySelectedTodo(e); return; }
  if (todoMenuId !== null) {
    if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); closeTodoMenu(true); return; }
    const menu = $("#todo-context-menu");
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const items = [...menu.querySelectorAll('button:not(:disabled)')];
      const current = items.indexOf(document.activeElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (current + (e.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
      items[next]?.focus(); return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault(); menu.querySelector('button:focus:not(:disabled)')?.click(); return;
    }
  }
  const menuRow = !inDialog && e.target.closest('tr[data-todo]');
  if (menuRow && (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) {
    e.preventDefault(); const rect = menuRow.getBoundingClientRect(); openTodoMenu(menuRow, rect.left + 16, rect.bottom); return;
  }
  if (!inDialog && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    e.preventDefault(); const field = $(tab === "tasks" ? "#task-search" : "#todo-search"); field.focus(); field.select(); return;
  }
  if (e.key === "Escape") {
    if (e.target === $("#todo-search") && todoSearch) { ACTIONS["clear-todo-search"](); return; }
    const openMenu = document.querySelector(".menu.open");
    if (openMenu) { openMenu.classList.remove("open"); return; }
    if (inDialog) { closeDialog(); return; }
  }
  if (inDialog && e.key === "Tab") {
    const controls = [...$("#modal-layer").querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href], [tabindex="0"]')].filter((n) => n.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (first && e.shiftKey && (document.activeElement === first || !$("#modal-layer").contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (first && !e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  const currentTab = e.target.closest('[role="tab"][data-tab], [role="tab"][data-project]');
  if (currentTab && ["ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "].includes(e.key)) {
    e.preventDefault();
    const tabs = [...currentTab.parentElement.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(currentTab);
    const next = e.key === "Home" ? tabs[0] : e.key === "End" ? tabs[tabs.length - 1] : ["Enter", " "].includes(e.key) ? currentTab : tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    next.click(); next.focus();
    return;
  }
  const row = e.target.closest?.("tr[data-todo], tr[data-agent]");
  if (row && !inDialog && !e.target.closest("button, a, input, textarea, select") && ["ArrowUp", "ArrowDown", "Enter", " "].includes(e.key)) {
    e.preventDefault();
    if (["Enter", " "].includes(e.key)) { row.click(); ACTIONS.details(); return; }
    const rows = [...row.closest("tbody").querySelectorAll("tr[data-todo], tr[data-agent]")];
    const next = rows[(rows.indexOf(row) + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length];
    next.click(); next.focus();
    return;
  }
  if (!inDialog && !e.target.closest("input, textarea, select, [contenteditable]") && e.key === "Delete" && selected?.type === "todo") ACTIONS["done-selected"]();
});
$("#todo-filter")?.addEventListener("change", (e) => { todoFilter = e.target.value; showClosed = false; renderTodos(); });
$("#todo-search")?.addEventListener("input", (e) => { todoSearch = e.target.value; renderTodos(); scheduleServerSearch(todoSearch, renderTodos); });
$("#task-filter")?.addEventListener("change", (e) => { taskFilter = e.target.value; taskRenderLimit = 60; renderTasks(); });
$("#task-search")?.addEventListener("input", (e) => { taskSearch = e.target.value; taskRenderLimit = 60; renderTasks(); scheduleServerSearch(taskSearch, renderTasks); });

// Called by the desktop app when "Открыть" is pressed in a popup, and by a tap on a phone notification.
window.abFocus = (proj, todoId) => {
  if (proj) {
    project = proj;
    localStorage.setItem("ad.project", project);
  }
  if (Number.isInteger(todoId)) {
    selected = { type: "todo", id: todoId };
    const target = data?.todos?.find((t) => t.id === todoId);
    if (todoSearch) {
      todoSearch = "";
      const sInp = $("#todo-search");
      if (sInp) sInp.value = "";
    }
    if (target && !todoMatches(target)) {
      todoFilter = "all";
      const fSel = $("#todo-filter");
      if (fSel) fSel.value = "all";
    }
  }
  render();
  document.querySelector(`tr[data-todo="${todoId}"]`)?.scrollIntoView?.({ block: "nearest" });
};

// Called by the desktop app for a popup about another computer (a pairing request, a new pair).
window.abPeers = () => { if (data && !document.querySelector("#peers-live")) ACTIONS.peers(); };
window.abNotifySettings = () => { if (data) notifySettingsDialog(); };
window.abDiagnostics = () => { if (data) diagnosticsDialog(); };

// --- desktop app window (Electron: desktop/preload.js gives window.agentDesk) -----

const desk = AD_HOST.desktop;
const isNative = !!desk;
document.body.classList.toggle("native", isNative);
document.body.classList.toggle("mobile", AD_HOST.kind === "mobile");
// Phone: the pixel font is drawn for 11 px. Font sizes are rounded so that one font pixel is a whole
// number of screen pixels (3 or 4 on a phone): text stays as crisp as on a Win98 screen instead of
// smearing between pixels. app.css uses --font-base (11 px text) and --font-ui (13 px text).
if (AD_HOST.kind === "mobile") {
  const crisp = (size) => {
    const dpr = window.devicePixelRatio || 1;
    return `${(11 * Math.max(1, Math.round((dpr * size) / 11))) / dpr}px`;
  };
  document.documentElement.style.setProperty("--font-base", crisp(11));
  document.documentElement.style.setProperty("--font-ui", crisp(13));
}
const native = () => desk;
desk?.onMaximized((maximized) => {
  $("#win-max").setAttribute("aria-label", maximized ? "Restore" : "Maximize");
  document.body.classList.toggle("maximized", maximized);
});

Object.assign(ACTIONS, {
  "win-min"() { desk?.minimize(); },
  "win-max"() { desk?.toggleMaximize(); },
  "win-close"() { desk?.close(); },
  "win-quit"() { desk?.quit(); },
});

$("#resize-grip").addEventListener("pointerdown", (e) => {
  const api = native();
  if (!api || document.body.classList.contains("maximized")) return;
  e.preventDefault();
  const grip = e.currentTarget;
  grip.setPointerCapture(e.pointerId);
  const start = { x: e.screenX, y: e.screenY, w: window.innerWidth, h: window.innerHeight };
  let pending = null;
  let busy = false;
  const flush = async () => {
    if (busy || !pending) return;
    busy = true;
    const size = pending;
    pending = null;
    try { await api.resize(size.w, size.h); } finally { busy = false; flush(); }
  };
  const move = (ev) => {
    pending = { w: start.w + ev.screenX - start.x, h: start.h + ev.screenY - start.y };
    flush();
  };
  const up = () => {
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", up);
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
});

// Splitter between "Нужно сделать" and the agents/log panel; the height is remembered per device.
(() => {
  const panel = $(".todo-panel");
  const splitter = $("#splitter");
  const apply = (h) => {
    if (!h) { panel.style.height = ""; panel.style.maxHeight = ""; return; }
    panel.style.height = `${h}px`;
    panel.style.maxHeight = "none";
  };
  apply(Number(localStorage.getItem("ad.todoHeight")) || 0);
  splitter.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add("dragging");
    const startY = e.clientY;
    const startH = panel.offsetHeight;
    const room = $(".project-window > .window-body").clientHeight;
    const move = (ev) => {
      const h = Math.round(Math.max(40, Math.min(room - 120, startH + ev.clientY - startY)));
      apply(h);
      localStorage.setItem("ad.todoHeight", String(h));
    };
    const up = () => {
      splitter.classList.remove("dragging");
      splitter.removeEventListener("pointermove", move);
      splitter.removeEventListener("pointerup", up);
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up);
  });
  splitter.addEventListener("dblclick", () => {
    localStorage.removeItem("ad.todoHeight");
    apply(0);
  });
})();

AD_HOST.onNotificationTap((proj, todoId) => window.abFocus(proj, todoId));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  resyncToasts = true;
  poll();
  // Back from the Android settings: show what has changed.
  if (document.querySelector("#pn-toggle")) { closeDialog(); ACTIONS["phone-notify"](); }
});
if (phoneNotify) startWatch(false); // also after an app update: the watcher follows the paired PC

poll();
setInterval(poll, 2000);
