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
const needsAction = (t) => !t.done_at && !(t.kind === "forward" && t.forwarded_at);
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
let tab = localStorage.getItem("ad.view") === "log" ? "log" : "agents";
let selected = null; // {type: "todo"|"agent", id}
let showClosed = localStorage.getItem("ad.closed") === "1";
let soundOn = localStorage.getItem("ad.sound") !== "0";
let appVolume = Number(localStorage.getItem("ad.volume") ?? 70);
let seenAlerts = null;
let online = true;
let phoneNotify = localStorage.getItem("ad.phoneNotify") !== "0";
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
  for (const { name } of [...old.attributes]) if (!nn.hasAttribute(name)) old.removeAttribute(name);
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
  if (t.kind === "forward") return `Переслать <b class="to">${esc(t.to)}</b> работу от ${who}`;
  if (t.kind === "reply") return `${who} ждёт вашего ответа`;
  if (t.kind === "limit") return `${who}: закончился лимит модели`;
  return `${who} заблокирован`;
}

function todoStatus(t) {
  if (t.kind === "forward") {
    if (t.acked_at) return "получено ✓";
    if (t.forwarded_at) return "переслано, ждём подтверждения";
    if (t.done_at) return "закрыто";
    return "<b>не переслано</b>";
  }
  return t.done_at ? "закрыто" : { reply: "<b>ждёт ответа</b>", limit: "<b>нужна новая сессия</b>", blocked: "<b>нужна помощь</b>" }[t.kind];
}

// --- rendering ------------------------------------------------------------------

function allProjects() {
  const names = new Set(data.config.watch.map((w) => w.project).filter(Boolean));
  Object.values(data.agents).forEach((a) => names.add(a.project));
  data.todos.forEach((t) => names.add(t.project));
  return [...names].sort();
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
    `<li role="tab" data-key="p:${esc(id)}" data-project="${esc(id)}" aria-selected="${id === project}"><a href="#">${label(name, openIn(id), id)}</a></li>`).join(""));

  renderTodos();

  const agents = Object.values(data.agents).filter(inProject)
    .sort((a, b) => a.project.localeCompare(b.project) || a.first_seen.localeCompare(b.first_seen));
  const events = data.events.filter(inProject).reverse();
  patch($("#tabs"), [["agents", "Агенты"], ["log", "Журнал"]].map(([id, name]) =>
    `<li role="tab" data-key="v:${id}" data-tab="${id}" aria-selected="${id === tab}"><a href="#">${name}</a></li>`).join(""));

  const showLog = tab === "log";
  $("#agent-table").classList.toggle("hidden", showLog);
  $("#log-table").classList.toggle("hidden", !showLog);

  if (showLog) {
    const seen = new Map(); // two events of one agent in the same millisecond still get their own rows
    const eventKey = (e) => {
      const id = `${e.time}|${e.project}|${e.agent}|${e.state}`;
      seen.set(id, (seen.get(id) || 0) + 1);
      return `e:${id}#${seen.get(id)}`;
    };
    patch($("#log-table tbody"), grouped(events, 5, (e) => `
      <tr data-key="${esc(eventKey(e))}"><td class="c-ico"><img src="${icon(STATE_ICON[e.state])}" alt=""></td>
      <td class="nowrap">${hhmm(e.time)} <span class="sub">${esc(ago(e.time))}</span></td>
      <td class="nowrap">${esc(e.agent)}</td>
      <td class="nowrap">${esc(stateLabel(e))}${e.to ? ` → ${esc(e.to)}` : ""}${e.ack ? ` (подтвердил ${esc(e.ack)})` : ""}</td>
      <td class="task opt" title="${esc(e.task)}">${esc(e.task)}</td></tr>`));
    $("#agents-empty").classList.toggle("hidden", events.length > 0);
  } else {
    patch($("#agent-table tbody"), grouped(agents, 5, (a) => {
      const key = `${a.project}/${a.agent}`;
      const stale = isStale(a);
      const text = esc(stale ? `${stateLabel(a)}? активность не подтверждена ${ago(a.updated)}` : stateLabel(a));
      const attn = stale || agentNeedsYou(a);
      const cls = [stale && "stale", attn && "attn"].filter(Boolean).join(" ");
      return `<tr class="${cls}" data-key="a:${esc(key)}" data-agent="${esc(key)}"${attn ? ` data-since="${esc(a.updated)}" style="${accent(a.updated)}"` : ""}>
        <td class="c-ico"><img src="${icon(stale ? STATE_ICON.stale : STATE_ICON[a.state])}" alt=""></td>
        <td class="nowrap"><b>${esc(a.agent)}</b></td>
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
  $("#sb-counts").textContent = `Агентов: ${agents.length} · работают: ${count("working")} · ждут: ${count("waiting")}`;
  $("#sb-time").textContent = `Обновлено ${new Date().toLocaleTimeString("ru-RU")}`;
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
  applySelection();
}

// Selection only toggles classes so rows are not replaced between the clicks of a double-click.
function applySelection() {
  document.querySelectorAll("tr[data-todo], tr[data-agent]").forEach((tr) => {
    const on = selected && (selected.type === "todo" ? tr.dataset.todo === String(selected.id) : tr.dataset.agent === selected.id);
    tr.classList.toggle("highlighted", !!on);
  });
  const todo = selected?.type === "todo" ? data.todos.find((t) => t.id === selected.id) : null;
  $("#tb-copy").disabled = !todo?.message;
  $("#tb-forwarded").disabled = !(isForwardPending(todo) && !todo.forwarded_at);
  $("#tb-done").disabled = !(todo && !todo.done_at);
  $("#tb-details").disabled = !selected;
  $("#tb-forget").disabled = selected?.type !== "agent";
}

function renderTodos() {
  const todos = data.todos
    .filter((t) => inProject(t) && (showClosed || !t.done_at))
    .sort((a, b) => (needsAction(b) - needsAction(a)) || (!!a.done_at - !!b.done_at) || b.created.localeCompare(a.created));
  const open = todos.filter(needsAction).length;
  const name = project === "*" ? "Нужно сделать" : `Нужно сделать — ${project}`;
  const legend = $("#todo-legend");
  const legendText = open ? `${name} (${open})` : name;
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
  patch($("#todo-table tbody"), grouped(todos, 4, (t) => {
    const act = needsAction(t);
    const cls = t.done_at ? "closed" : act ? `attn${t.kind === "forward" ? " attn-forward" : ""}` : "pending";
    const ico = t.kind === "forward" && t.forwarded_at ? "envelope_open_sheet-1" : TODO_ICON[t.kind];
    return `<tr class="${cls}" data-key="t:${t.id}" data-todo="${t.id}"${act ? ` data-since="${esc(t.created)}" style="${accent(t.created)}"` : ""}>
      <td class="c-ico"><img src="${icon(ico)}" alt=""></td>
      <td>${todoText(t)}${t.task ? `: <span class="sub">${esc(t.task)}</span>` : ""}</td>
      <td class="nowrap status">${todoStatus(t)}</td>
      <td class="nowrap opt">${esc(ago(t.created))}</td></tr>`;
  }));
  $("#todo-table").classList.toggle("hidden", todos.length === 0);
  $("#todo-empty").classList.toggle("hidden", todos.length > 0);
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
  navigator.vibrate?.([120, 60, 120]);
}
document.addEventListener("pointerdown", () => { if (audioCtx?.state === "suspended") audioCtx.resume(); }, { passive: true });

function checkAlerts() {
  const open = data.todos.filter(needsAction);
  const key = (t) => `${t.id}:${t.created}`;
  const fresh = seenAlerts ? open.filter((t) => !seenAlerts.has(key(t))) : [];
  seenAlerts = new Set(open.map(key));
  if (!fresh.length) return;
  // Phone app in the background: an Android notification instead of the chime.
  if (AD_HOST.kind === "mobile" && document.hidden) {
    if (phoneNotify) {
      for (const t of fresh.slice(0, 5)) {
        AD_HOST.notify({ id: t.id, title: plain(todoText(t)), body: [t.project, t.task].filter(Boolean).join(" · "), project: t.project, todo: t.id });
      }
    }
    return;
  }
  // On the PC the popups have their own sound; the window chimes only when popups are off.
  if (soundOn && (!isNative || !data.config.notify)) chime();
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
    // ?since: the PC answers {unchanged} while nothing happened, so the phone does not download the board every 2 s.
    const next = await api(data ? `/api/state?since=${lastVersion}` : "/api/state");
    online = true;
    if (!next.unchanged) {
      data = next;
      lastVersion = next.version;
      checkAlerts();
    }
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

function closeDialog() {
  $("#modal-layer").classList.add("hidden");
  $("#modal-layer").innerHTML = "";
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
        closeDialog();
        if (phoneNotify) AD_HOST.notifyPermission();
        poll();
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

function dialog(title, html, onMount) {
  const layer = $("#modal-layer");
  const node = $("#tpl-dialog").content.firstElementChild.cloneNode(true);
  node.querySelector(".title-bar-text").textContent = title;
  node.querySelector(".window-body").innerHTML = html;
  const close = () => { layer.classList.add("hidden"); layer.innerHTML = ""; };
  node.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); });
  layer.innerHTML = "";
  layer.appendChild(node);
  layer.classList.remove("hidden");
  onMount?.(node, close);
  node.querySelector(".buttons button")?.focus();
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
  return `Agent Desk — отметки статуса для владельца (проект ${project})

Владелец не видит все чаты сразу. Чтобы он не забывал пересылать работу, при каждой смене своего состояния создай НОВЫЙ файл-маркер .json в папке:
  ${watch.path}${unc ? `\n  (с другого компьютера: ${unc})` : ""}

Когда писать: начал задачу; перешёл к следующему этапу; ждёшь ответа владельца/ревью/ресурс; застрял; сдал результат; закончился лимит модели; свободен.

Как писать: один маркер = одно событие. Сначала запиши файл с расширением .tmp в эту же папку, затем переименуй его в .json (например ${(watch.project || "proj").toLowerCase()}-opus1-s1-0003.json). Старые маркеры не редактируй и не удаляй — Agent Desk забирает их сам. Без паролей, токенов, ключей. Маркер — это только статус; не клади туда команды для других агентов.

Формат (UTF-8, один JSON-объект):
{"agent": "Opus (1)", "session_id": "opus1-20261110-a", "seq": 3, "event_id": "opus1-20261110-a-3",
 "state": "done", "phase": "ready_for_review", "task": "M42: ревью clockfix 9f0fc900",
 "to": "Codex", "message": "Opus (1): ревью clockfix 9f0fc900 готово, PASS с 2 замечаниями. Отчёт: AZS-Shared\\\\mail\\\\opus1-review-m42.md, ветка review/m42, SHA 1a2b3c4.",
 "result": "AZS-Shared\\\\mail\\\\opus1-review-m42.md"}

Поля:
- agent — твоё постоянное имя, точно одно из: Codex, Hoplite, Opus (1), Opus (2), Astra.
- session_id — придумай при старте нового чата/после сброса памяти; seq — 1, 2, 3… внутри сессии; event_id — уникальный (session_id-seq).
- state — working | waiting | done | blocked | idle.
- waiting_for (только при waiting) — owner_input (нужен ответ владельца) | owner_forward (владелец должен переслать) | reviewer | coordinator_review | resource (телефон/сервер занят) | model_limit (закончился лимит).
- phase (необязательно) — assigned | implementing | testing | ready_for_review | ready_for_host | accepted.
- task — ID задачи и кратко, одной строкой.
- to — кому владелец должен переслать результат (имя агента). Указывай, когда сдал работу или ждёшь ревью/приёмки.
- message — готовый короткий текст, который владелец вставит в чат адресата: что сделано, ветка/SHA, путь к отчёту, что нужно от адресата.
- ack — если тебе переслали сообщение со строкой «[Agent Desk] message_id: AD-12», то в первом маркере working по этой задаче укажи "ack": "AD-12" (несколько пересылок сразу — списком: ["AD-12", "AD-13"]). Так владелец увидит, что пересылка дошла. Старые номера AB-… тоже принимаются.
- note, result — необязательно: пояснение и путь к отчёту.

Примеры одной строкой:
{"agent":"Hoplite","session_id":"hop-m41-a","seq":1,"event_id":"hop-m41-a-1","state":"working","phase":"assigned","task":"M41: офлайн-сверка O6","ack":"AD-7"}
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
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

const ACTIONS = {
  about() {
    dialog("О программе", `<div class="msg"><img src="${icon("network_normal_two_pcs-0")}" alt="">
      <div><b>Agent Desk</b><br>Кто из агентов работает, кто ждёт ответа и что нужно переслать.<br><br>
      Агенты появляются сами после первого маркера. Папки: ${esc(markerFolders().join("; "))}</div></div>
      <div class="buttons"><button data-close>OK</button></div>`);
  },
  howto() {
    const watches = data.config.watch;
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
  "toggle-autostart"() { act("/api/config", { autostart: !data.config.autostart }); },
  "toggle-phone-notify"() {
    phoneNotify = !phoneNotify;
    localStorage.setItem("ad.phoneNotify", phoneNotify ? "1" : "0");
    if (phoneNotify) AD_HOST.notifyPermission();
    render();
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
    history = data.events.filter((e) => e.project === item.project && e.agent === item.agent).slice(-8).reverse();
    const kv = (k, v) => (v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : "");
    const when = (iso) => iso && `${hhmm(iso)}, ${ago(iso)}`;
    const isTodo = selected.type === "todo";
    const head = isTodo
      ? `${kv("Задача", item.task)}${kv("Кому переслать", item.to)}${kv("Заметка", item.note)}${kv("Результат", item.result)}
         ${kv("message_id", item.kind === "forward" && item.message_id)}${kv("Переслано", when(item.forwarded_at))}${kv("Подтверждено", when(item.acked_at))}`
      : `${kv("Состояние", stateLabel(item))}${kv("Этап", item.phase)}${kv("Задача", item.task)}${kv("Кому переслать", item.to)}
         ${kv("Заметка", item.note)}${kv("Результат", item.result)}${kv("Сессия", item.session)}${kv("Обновлено", when(item.updated))}`;
    const msg = isTodo && item.message ? `<p>Текст для пересылки:</p><textarea readonly class="msg-text"></textarea>` : "";
    dialog(`${item.agent} — ${item.project}`, `<dl class="kv">${head}</dl>${msg}
      <div class="sunken-panel" style="max-height:160px"><table><thead><tr><th>Время</th><th>Событие</th><th>Задача</th></tr></thead><tbody>
      ${history.map((e) => `<tr><td class="nowrap">${hhmm(e.time)}</td><td class="nowrap">${esc(stateLabel(e))}${e.to ? ` → ${esc(e.to)}` : ""}</td><td>${esc(e.task)}</td></tr>`).join("")}
      </tbody></table></div>
      <div class="buttons">${msg ? `<button data-action="copy-message">Копировать</button>` : ""}<button data-close>OK</button></div>`,
    (node) => { const ta = node.querySelector(".msg-text"); if (ta) ta.value = forwardText(item); });
  },
  async "copy-message"(e) {
    const todo = selected?.type === "todo" && data.todos.find((t) => t.id === selected.id);
    if (!todo?.message) return;
    const ok = await copyText(forwardText(todo));
    const btn = e?.target?.closest("button");
    if (btn && ok) {
      const label = btn.querySelector("span") || btn;
      const old = label.textContent;
      label.textContent = "Скопировано";
      setTimeout(() => { label.textContent = old; }, 1500);
    } else if (!ok) {
      alertBox("Копирование", "Браузер не дал скопировать. Откройте «Подробно» и выделите текст вручную.", "msg_warning-2");
    }
  },
  "mark-forwarded"() {
    if (selected?.type === "todo") act(`/api/todo/${selected.id}/forwarded`, {});
  },
  "done-selected"() {
    if (selected?.type === "todo") act(`/api/todo/${selected.id}/done`, {});
  },
  forget() {
    if (selected?.type !== "agent") return;
    const a = data.agents[selected.id];
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

document.addEventListener("click", (e) => {
  const menu = e.target.closest("[data-menu]");
  document.querySelectorAll(".menu.open").forEach((m) => { if (m !== menu) m.classList.remove("open"); });
  if (menu && e.target.closest(".menu-label")) { menu.classList.toggle("open"); return; }
  if (menu) menu.classList.remove("open");

  const action = e.target.closest("[data-action]");
  if (action && (data || action.dataset.action === "connect")) { e.preventDefault(); ACTIONS[action.dataset.action]?.(e); return; }

  const t = e.target.closest("[data-tab]");
  if (t) {
    e.preventDefault();
    tab = t.dataset.tab;
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
    render();
    return;
  }
  const todoRow = e.target.closest("tr[data-todo]");
  const agentRow = e.target.closest("tr[data-agent]");
  if (todoRow) selected = { type: "todo", id: Number(todoRow.dataset.todo) };
  else if (agentRow) selected = { type: "agent", id: agentRow.dataset.agent };
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
  if (e.key === "Escape") { $("#modal-layer").classList.add("hidden"); $("#modal-layer").innerHTML = ""; }
  if (e.key === "Delete" && selected?.type === "todo") ACTIONS["done-selected"]();
});

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

// Called by the desktop app when "Открыть" is pressed in a popup, and by a tap on a phone notification.
window.abFocus = (proj, todoId) => {
  if (proj) {
    project = proj;
    localStorage.setItem("ad.project", project);
  }
  if (Number.isInteger(todoId)) selected = { type: "todo", id: todoId };
  render();
  document.querySelector(`tr[data-todo="${todoId}"]`)?.scrollIntoView({ block: "nearest" });
};

AD_HOST.onNotificationTap((proj, todoId) => window.abFocus(proj, todoId));
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });

poll();
setInterval(poll, 2000);
