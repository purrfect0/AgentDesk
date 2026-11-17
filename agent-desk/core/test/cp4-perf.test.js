"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");
const { Desk, parseMarker } = require("../desk.js");
const { buildScaleWorkload } = require("./fixtures/synthetic-program.js");

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(3));
}

function httpGetRaw(port, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: reqPath,
      headers: { host: `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const elapsedMs = performance.now() - t0;
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString("utf8")); } catch { /* ignore */ }
        resolve({ status: res.statusCode, bytes: buf.length, elapsedMs, buf, json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function populateScaleDesk(count) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ad-cp4-perf-${count}-`));
  const inbox = path.join(root, "inbox");
  fs.mkdirSync(inbox, { recursive: true });
  const desk = new Desk({
    dataDir: path.join(root, "data"),
    legacyDir: null,
    port: 0,
    lan: false,
    graceMs: 0,
    discovery: false,
    pollMs: 600000,
    log: () => {},
  });
  desk.config.watch = [{ path: inbox, project: "AlphaDesk" }];
  const rows = buildScaleWorkload(count, desk.config.device_id);
  const iso = "2026-11-18T00:00:00.000Z";
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const msgId = r.task_id.replace(/^.{8}/, String(i + 1).padStart(8, "0"));
    desk.state.tasks[r.task_id] = {
      task_id: r.task_id,
      project_id: r.project_id,
      project: r.project,
      title: r.title,
      prompt: r.prompt,
      state: r.state,
      coordinator_device_id: desk.config.device_id,
      managed_assignment: true,
      assignment_message_id: msgId,
      assignment: {
        agent: r.agent,
        device_id: desk.config.device_id,
        session_id: r.session_id,
        epoch: 1,
        role: "executor",
        adapter: "manual",
      },
      checkpoint: {
        branch: `feat/scale-${i}`,
        commit: "5a048852efd5f5b74bd3f97970d624605d82165d",
        report: `reports/scale-${i}.md`,
        next_step: `Следующий шаг для карточки #${i + 1}`,
      },
      artifacts: [],
      history: [{ time: iso, kind: "assign", state: "assigned", agent: r.agent, device_id: desk.config.device_id, session_id: r.session_id, assignment_epoch: 1 }],
      created: iso,
      updated: iso,
    };
    desk.state.task_card_ids ??= {};
    desk.state.task_card_ids[r.task_id] = `AT-${i + 1}`;
    desk.state.todos.push({
      id: i + 1,
      display_id: `AD-${i + 1}`,
      kind: "forward",
      purpose: "assignment",
      assignment_epoch: 1,
      project: r.project,
      project_id: r.project_id,
      agent: "Владелец",
      to: r.agent,
      task: r.title,
      task_id: r.task_id,
      message: r.prompt,
      message_id: msgId,
      origin_device_id: desk.config.device_id,
      recipient_device_id: desk.config.device_id,
      recipient_session_id: r.session_id,
      created: iso,
      updated: iso,
      forwarded_at: i % 3 === 0 ? iso : null,
      acked_at: i % 4 === 0 ? iso : null,
      done_at: r.state === "accepted" ? iso : null,
      receipt_epoch: 0,
      auto: false,
    });
  }
  desk.state.next_id = rows.length + 1;
  desk.state.next_task_card_id = rows.length + 1;
  return { desk, root, rows };
}

function createUiClientVm() {
  class MiniNode {
    constructor() {
      this.nodes = new Map();
      this.classes = new Set();
      this.attrs = new Map();
      this.dataset = {};
      this.style = {};
      this.classList = {
        toggle: (n, on) => { if (on ?? !this.classes.has(n)) this.classes.add(n); else this.classes.delete(n); },
        add: (n) => this.classes.add(n),
        remove: (n) => this.classes.delete(n),
        contains: (n) => this.classes.has(n),
      };
      this.innerHTML = "";
      this.textContent = "";
      this.value = "";
      this.disabled = false;
    }
    querySelector(s) { if (!this.nodes.has(s)) this.nodes.set(s, new MiniNode()); return this.nodes.get(s); }
    querySelectorAll() { return []; }
    addEventListener() {}
    setAttribute(k, v) { this.attrs.set(k, v); }
    getAttribute(k) { return this.attrs.get(k) || null; }
  }
  const root = new MiniNode();
  const ctx = vm.createContext({
    console, Date, Object, Map, Set, String, Number, JSON, Array, Promise, TextEncoder, AbortController,
    crypto: require("node:crypto").webcrypto,
    window: { addEventListener() {} },
    encodeURIComponent,
    location: { hostname: "localhost" },
    localStorage: { getItem: () => null, setItem() {} },
    document: { createElement: () => new MiniNode(), querySelector: (s) => root.querySelector(s), querySelectorAll: () => [], addEventListener() {} },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    navigator: {},
    AD_HOST: { kind: "web" },
  });
  const appJs = fs.readFileSync(path.join(__dirname, "..", "..", "web", "app.js"), "utf8").split("// --- desktop app window")[0];
  vm.runInContext(`${appJs}\nproject = "*"; online = true; patch = (n, h) => { n.innerHTML = h; }; const isNative = false; const native = () => null;`, ctx);
  return { ctx, root, run: (code) => vm.runInContext(code, ctx) };
}

async function runDeterministicBenchmark(count) {
  const { desk, root, rows } = populateScaleDesk(count);
  await desk.start();
  const port = desk.boundPort;
  const updatesCount = 10;

  const assignedRows = rows.filter((r) => r.state === "assigned");
  try {
    // --- Variant A: Baseline full /api/state?since=<v> ---
    const baseInit = await httpGetRaw(port, "/api/state");
    assert.equal(baseInit.status, 200);
    let baseVer = baseInit.json.version;
    const baseEmpty = await httpGetRaw(port, `/api/state?since=${baseVer}`);
    assert.equal(baseEmpty.json.unchanged, true);

    const baseLatencies = [];
    let baseUpdateBytesTotal = 0;
    const baseVisLatencies = [];
    for (let u = 0; u < updatesCount; u++) {
      const evStart = performance.now();
      const target = assignedRows[u];
      desk.applyEvent(parseMarker(JSON.stringify({
        project: target.project,
        project_id: target.project_id,
        agent: target.agent,
        session_id: target.session_id,
        device_id: desk.config.device_id,
        task_id: target.task_id,
        assignment_epoch: 1,
        seq: u + 1,
        state: "working",
        execution_state: "working",
        note: `Baseline step ${u + 1}`,
      }), target.project));
      desk._saveState();
      const r = await httpGetRaw(port, `/api/state?since=${baseVer}`);
      const visMs = performance.now() - evStart;
      assert.equal(r.status, 200);
      baseVer = r.json.version;
      baseLatencies.push(r.elapsedMs);
      baseVisLatencies.push(visMs);
      baseUpdateBytesTotal += r.bytes;
    }
    const baselineSampleTodo = baseInit.json.todos[count - 1];
    const baselineSampleTask = baseInit.json.tasks.find((t) => t.task_id === rows[count - 1].task_id);

    // --- Variant B: Compact + Delta /api/state?compact=1&since=<v> + /api/item + /api/search ---
    const compInit = await httpGetRaw(port, "/api/state?compact=1");
    assert.equal(compInit.status, 200);
    assert.equal(compInit.json.compact, true);
    assert.equal(compInit.json.delta, false);
    let compVer = compInit.json.version;

    const ui = createUiClientVm();
    ui.ctx.__init = compInit.json;
    ui.run("applyStateUpdate(__init); render();");

    const compEmpty = await httpGetRaw(port, `/api/state?compact=1&since=${compVer}`);
    assert.equal(compEmpty.json.unchanged, true);
    assert.ok(compEmpty.bytes < 128);

    const compLatencies = [];
    const compVisLatencies = [];
    let compUpdateBytesTotal = 0;
    for (let u = 0; u < updatesCount; u++) {
      const evStart = performance.now();
      const target = assignedRows[updatesCount + u];
      desk.applyEvent(parseMarker(JSON.stringify({
        project: target.project,
        project_id: target.project_id,
        agent: target.agent,
        session_id: target.session_id,
        device_id: desk.config.device_id,
        task_id: target.task_id,
        assignment_epoch: 1,
        seq: u + 1,
        state: "working",
        execution_state: "working",
        note: `Compact delta step ${u + 1}`,
      }), target.project));
      desk._saveState();
      const r = await httpGetRaw(port, `/api/state?compact=1&since=${compVer}`);
      assert.equal(r.status, 200);
      assert.equal(r.json.delta, true);
      ui.ctx.__delta = r.json;
      ui.run("applyStateUpdate(__delta); render();");
      const visMs = performance.now() - evStart;
      compVer = r.json.version;
      compLatencies.push(r.elapsedMs);
      compVisLatencies.push(visMs);
      compUpdateBytesTotal += r.bytes;
    }

    assert.equal(ui.run("taskList().length"), count);
    assert.equal(ui.run("data.todos.length"), count);

    // Byte-for-byte full prompt equality via /api/item
    const itemRes = await httpGetRaw(port, `/api/item?todo=${baselineSampleTodo.id}&task=${encodeURIComponent(baselineSampleTask.task_id)}`);
    assert.equal(itemRes.status, 200);
    assert.equal(
      Buffer.compare(Buffer.from(itemRes.json.todo.forward_text, "utf8"), Buffer.from(baselineSampleTodo.forward_text, "utf8")),
      0,
      "forward_text must match byte-for-byte"
    );
    assert.equal(
      Buffer.compare(Buffer.from(itemRes.json.todo.message, "utf8"), Buffer.from(baselineSampleTodo.message, "utf8")),
      0,
      "todo.message must match byte-for-byte"
    );
    assert.equal(
      Buffer.compare(Buffer.from(itemRes.json.task.prompt, "utf8"), Buffer.from(baselineSampleTask.prompt, "utf8")),
      0,
      "task.prompt must match byte-for-byte"
    );

    // Search latency (server deep prompt scan + UI render)
    const token = rows[count - 1].unique_token;
    const searchStart = performance.now();
    const searchRes = await httpGetRaw(port, `/api/search?q=${encodeURIComponent(token)}`);
    const serverSearchMs = performance.now() - searchStart;
    assert.equal(searchRes.status, 200);
    assert.deepEqual(searchRes.json.task_ids, [rows[count - 1].task_id]);
    assert.deepEqual(searchRes.json.todo_ids, [count]);

    ui.ctx.__searchRes = searchRes.json;
    ui.ctx.__token = token;
    const uiSearchStart = performance.now();
    ui.run(`
      serverSearchState = { q: __token, todoIds: new Set(__searchRes.todo_ids), taskIds: new Set(__searchRes.task_ids) };
      todoSearch = __token; renderTodos();
      taskSearch = __token; renderTasks();
    `);
    const uiSearchMs = performance.now() - uiSearchStart;
    assert.match(ui.root.querySelector("#task-list").innerHTML, new RegExp(token));
    assert.match(ui.root.querySelector("#todo-table tbody").innerHTML, new RegExp(`data-todo="${count}"`));

    const mem = process.memoryUsage();
    baseLatencies.sort((a, b) => a - b);
    compLatencies.sort((a, b) => a - b);
    baseVisLatencies.sort((a, b) => a - b);
    compVisLatencies.sort((a, b) => a - b);

    const avgBaseUpdateBytes = Math.round(baseUpdateBytesTotal / updatesCount);
    const avgCompUpdateBytes = Math.round(compUpdateBytesTotal / updatesCount);
    const updateSavingsPct = Number(((1 - avgCompUpdateBytes / avgBaseUpdateBytes) * 100).toFixed(2));
    const initialSavingsPct = Number(((1 - compInit.bytes / baseInit.bytes) * 100).toFixed(2));

    assert.ok(updateSavingsPct >= 80, `Expected >=80% body savings on updates, got ${updateSavingsPct}%`);
    assert.ok(initialSavingsPct >= 80, `Expected >=80% body savings on initial compact load, got ${initialSavingsPct}%`);

    return {
      tasks_count: count,
      updates_measured: updatesCount,
      baseline: {
        initial_bytes: baseInit.bytes,
        avg_update_bytes: avgBaseUpdateBytes,
        total_10_updates_bytes: baseUpdateBytesTotal,
        empty_poll_bytes: baseEmpty.bytes,
        requests_count: 2 + updatesCount,
        p50_ms: percentile(baseLatencies, 50),
        p95_ms: percentile(baseLatencies, 95),
        event_to_visibility_p50_ms: percentile(baseVisLatencies, 50),
      },
      compact_delta: {
        initial_bytes: compInit.bytes,
        avg_update_bytes: avgCompUpdateBytes,
        total_10_updates_bytes: compUpdateBytesTotal,
        empty_poll_bytes: compEmpty.bytes,
        item_on_demand_bytes: itemRes.bytes,
        requests_count: 2 + updatesCount,
        p50_ms: percentile(compLatencies, 50),
        p95_ms: percentile(compLatencies, 95),
        event_to_visibility_p50_ms: percentile(compVisLatencies, 50),
        server_search_ms: Number(serverSearchMs.toFixed(3)),
        ui_search_render_ms: Number(uiSearchMs.toFixed(3)),
      },
      savings: {
        initial_body_reduction_pct: initialSavingsPct,
        normal_update_body_reduction_pct: updateSavingsPct,
        byte_exact_prompt_verified: true,
      },
      memory_mb: {
        rss: Number((mem.rss / (1024 * 1024)).toFixed(2)),
        heap_used: Number((mem.heapUsed / (1024 * 1024)).toFixed(2)),
      },
    };
  } finally {
    await desk.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("CP4 Perf: deterministic A/B on 200 and 1000 multilingual tasks achieves >=80% body savings and byte-identical prompt reads", async () => {
  const m200 = await runDeterministicBenchmark(200);
  const m1000 = await runDeterministicBenchmark(1000);

  if (process.env.AD_CP4_METRICS_OUT) {
    fs.mkdirSync(path.dirname(process.env.AD_CP4_METRICS_OUT), { recursive: true });
    fs.writeFileSync(process.env.AD_CP4_METRICS_OUT, JSON.stringify({
      generated_at: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      benchmarks: { scale_200: m200, scale_1000: m1000 },
    }, null, 2));
  }
});

test("CP4 Perf resilience: slow client, request cancellation, server restart reconnect, and version reset fallback", async () => {
  const { desk, root, rows } = populateScaleDesk(200);
  await desk.start();
  let port = desk.boundPort;

  try {
    // 1. Slow client reading slowly does not block fast concurrent client
    const slowPromise = new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method: "GET", path: "/api/state?compact=1", headers: { host: `127.0.0.1:${port}` } }, (res) => {
        res.pause();
        const chunks = [];
        setTimeout(() => {
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).length));
          res.resume();
        }, 600);
      });
      req.on("error", reject);
      req.end();
    });

    const fastRes = await httpGetRaw(port, "/api/state?compact=1");
    assert.equal(fastRes.status, 200);
    assert.ok(fastRes.elapsedMs < 500, `Fast client must not wait on paused slow client (took ${fastRes.elapsedMs}ms)`);
    const slowBytes = await slowPromise;
    assert.equal(slowBytes, fastRes.bytes);

    // 2. Aborted request under load does not crash or corrupt server state
    await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, method: "GET", path: "/api/state", headers: { host: `127.0.0.1:${port}` } }, (res) => {
        res.once("data", () => { req.destroy(); resolve(); });
      });
      req.on("error", () => resolve());
      req.end();
    });

    const afterAbort = await httpGetRaw(port, `/api/state?compact=1&since=${fastRes.json.version}`);
    assert.equal(afterAbort.json.unchanged, true);

    // 3. Version higher than server (e.g. after backup restore / cache reset) falls back to full compact snapshot
    const futureSince = await httpGetRaw(port, `/api/state?compact=1&since=${fastRes.json.version + 500}`);
    assert.equal(futureSince.status, 200);
    assert.equal(futureSince.json.compact, true);
    assert.equal(futureSince.json.delta, false);
    assert.equal(futureSince.json.tasks.length, 200);

    // 4. Server restart -> client reconnects with pre-restart version -> receives clean full compact snapshot
    const stateDir = desk.dataDir;
    desk._saveState();
    const preRestartVer = desk.state.version;
    await desk.stop();

    const restarted = new Desk({ dataDir: stateDir, legacyDir: null, port: 0, lan: false, graceMs: 0, discovery: false, pollMs: 600000, log: () => {} });
    await restarted.start();
    port = restarted.boundPort;
    try {
      const reconn = await httpGetRaw(port, `/api/state?compact=1&since=${preRestartVer - 1}`);
      assert.equal(reconn.status, 200);
      assert.equal(reconn.json.delta, false, "Pre-boot version must trigger clean full compact resync");
      assert.equal(reconn.json.tasks.length, 200);

      // Next incremental update after reconnect uses delta: true again
      const target = rows[0];
      restarted.applyEvent(parseMarker(JSON.stringify({
        project: target.project, project_id: target.project_id, agent: target.agent,
        session_id: target.session_id, device_id: restarted.config.device_id,
        task_id: target.task_id, assignment_epoch: 1, seq: 99, state: "working", execution_state: "working",
      }), target.project));
      restarted._saveState();
      const postReconnDelta = await httpGetRaw(port, `/api/state?compact=1&since=${reconn.json.version}`);
      assert.equal(postReconnDelta.json.delta, true);
      assert.equal(postReconnDelta.json.tasks_upsert.length, 1);
    } finally {
      await restarted.stop();
    }
  } finally {
    await desk.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
