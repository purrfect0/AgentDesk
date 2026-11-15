"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const { TaskService } = require("../tasks.js");

function fixture(extra = {}) {
  const desk = new EventEmitter();
  desk.config = { device_id: "desktop-a", ...extra };
  desk.state = { todos: [], tasks: {}, bindings: {} };
  desk.saved = 0;
  desk.changes = 0;
  desk.trace = [];
  desk._saveState = () => { desk.trace.push("save"); desk.saved++; };
  desk.on("change", () => { desk.trace.push("change"); desk.changes++; });
  return { desk, service: new TaskService(desk) };
}
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-desk-tasks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const marker = (extra = {}) => ({ project: "Synthetic", agent: "Worker", task: "Build synthetic feature", state: "working", session: "session-a", seq: 1, ...extra });
function assigned(service, extra = {}) {
  return service.assign({ project: "Synthetic", title: "Build synthetic feature", agent: "Worker", session_id: "session-a", ...extra });
}
const reporter = (task, extra = {}) => ({ task_id: task.task_id, project: task.project, project_id: task.project_id, agent: task.assignment.agent, device_id: task.assignment.device_id, session_id: task.assignment.session_id, assignment_epoch: task.assignment.epoch, ...extra });
const status = (code) => (error) => error.status === code;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function git(repo, ...args) {
  const result = spawnSync("git", args, { cwd: repo, shell: false, windowsHide: true, timeout: 5000, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
  assert.equal(result.error, undefined, `git ${args[0]} failed to run`);
  assert.equal(result.status, 0, `git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function repository(t) {
  const root = temporary(t);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.name", "Synthetic Test");
  git(repo, "config", "user.email", "synthetic@example.invalid");
  fs.writeFileSync(path.join(repo, "artifact.txt"), "synthetic artifact\n");
  git(repo, "add", "--", "artifact.txt");
  git(repo, "commit", "-m", "Synthetic initial state");
  return { root, repo, commit: git(repo, "rev-parse", "HEAD") };
}

test("constructor normalizes missing object maps and never writes", () => {
  const { desk } = fixture();
  desk.state.tasks = [];
  desk.state.bindings = null;
  new TaskService(desk);
  assert.deepEqual(desk.state.tasks, {});
  assert.deepEqual(desk.state.bindings, {});
  assert.equal(desk.saved, 0);
});

test("owner assignment generates UUID task/project/binding and saves before emitting", () => {
  const { desk, service } = fixture();
  const task = assigned(service, { adapter: "unknown-runtime" });
  for (const id of [task.task_id, task.project_id, task.binding_id]) assert.match(id, /^[a-f0-9]{8}-[a-f0-9-]{27}$/);
  assert.equal(task.state, "assigned");
  assert.equal(task.assignment.epoch, 1);
  assert.equal(task.coordinator_device_id, "desktop-a");
  assert.equal(task.launch.status, "needs_manual_launch");
  assert.equal(task.launch.adapter, "unknown-runtime");
  assert.equal(Object.values(desk.state.bindings)[0].session_id, "session-a");
  assert.deepEqual(desk.trace, ["save", "change"]);
  assert.equal(task.checkpoint.repo, undefined);
});

test("list filters and get return detached snapshots; project identities are reused", () => {
  const { service } = fixture();
  const first = assigned(service);
  const second = assigned(service, { agent: "Reviewer", session_id: "review-session", role: "reviewer" });
  assert.equal(first.project_id, second.project_id);
  assert.equal(service.list({ project: "Synthetic", agent: "Worker", session_id: "session-a" }).length, 1);
  assert.equal(service.list({ role: "reviewer" })[0].task_id, second.task_id);
  assert.equal(service.list({ project: "Other" }).length, 0);
  first.assignment.agent = "Tampered";
  service.get(second.task_id).history.push({ malicious: true });
  assert.equal(service.get(first.task_id).assignment.agent, "Worker");
  assert.equal(service.get(second.task_id).history.length, 1);
  assert.throws(() => service.get("not-a-uuid"), status(400));
  assert.throws(() => service.get(crypto.randomUUID()), status(404));
});

test("legacy working/done markers are one task lifecycle and never persist independently", () => {
  const { desk, service } = fixture();
  const todo = { done_at: null, acked_at: null };
  const ev = marker();
  const first = service.observe(ev, todo);
  assert.equal(first.state, "working");
  assert.equal(todo.task_id, first.task_id);
  assert.equal(ev.task_id, first.task_id);
  const second = service.observe(marker({ state: "done", seq: 2 }), { done_at: "closed-by-receipt", acked_at: "receipt" });
  assert.equal(second.task_id, first.task_id);
  assert.equal(second.state, "submitted");
  assert.equal(service.list().length, 1);
  assert.equal(desk.saved, 0);
  assert.equal(desk.changes, 0);
  assert.equal(todo.done_at, null);
});

test("empty ACK/idle-only markers do not create tasks, receipt closure never accepts", () => {
  const { service } = fixture();
  assert.equal(service.observe(marker({ task: "", state: "idle", ack: [crypto.randomUUID()] })), null);
  const task = service.observe(marker({ state: "done" }));
  service.observe(marker({ state: "waiting", seq: 2, ack: [crypto.randomUUID()] }), { done_at: "closed", acked_at: "received" });
  assert.equal(service.get(task.task_id).state, "submitted");
  assert.equal(service.list().length, 1);
});

test("legacy parser blank optional identity fields remain compatible", () => {
  const { service } = fixture();
  const task = service.observe(marker({ task_id: "", project_id: "", device_id: "desktop-a", execution_state: "" }));
  assert.equal(task.state, "working");
  const done = service.observe(marker({ task_id: "", project_id: "", device_id: "desktop-a", execution_state: "", state: "done", seq: 2 }));
  assert.equal(done.task_id, task.task_id);
  assert.equal(done.state, "submitted");
});

test("legacy ambiguous text matching creates a separate task instead of guessing", () => {
  const { service } = fixture();
  assigned(service);
  assigned(service);
  const third = service.observe(marker());
  assert.equal(third.state, "working");
  assert.equal(service.list().length, 3);
});

test("legacy matching honors canonical agent names when provided by desk", () => {
  const { desk, service } = fixture();
  desk.canonical = (_project, value) => value.toLowerCase().replace(/\s/g, "") === "worker" ? "Worker" : value;
  const first = service.observe(marker({ agent: "WORKER" }));
  const second = service.observe(marker({ agent: "worker", state: "done", seq: 2 }));
  assert.equal(second.task_id, first.task_id);
  assert.equal(second.assignment.agent, "Worker");
});

test("observed explicit IDs require epoch/session and validate project identity", () => {
  const { desk, service } = fixture();
  const taskId = crypto.randomUUID();
  assert.throws(() => service.observe(marker({ task_id: taskId })), status(400));
  const task = service.observe(marker({ task_id: taskId, project_id: crypto.randomUUID(), device_id: "desktop-a", assignment_epoch: 1 }));
  assert.equal(task.task_id, taskId);
  assert.throws(() => service.observe(marker({ task_id: taskId, project: "Wrong", assignment_epoch: 1, device_id: "desktop-a" })), status(403));
  assert.throws(() => service.observe(marker({ task_id: taskId, project_id: crypto.randomUUID(), assignment_epoch: 1, device_id: "desktop-a" })), status(403));
  assert.equal(desk.saved, 0);
});

test("explicit assignment disables legacy missing-epoch reports", () => {
  const { service } = fixture();
  assigned(service);
  assert.throws(() => service.observe(marker()), status(400));
  assert.equal(service.list()[0].state, "assigned");
});

test("transition enforces binding, project, epoch, and lifecycle without mutating on failures", () => {
  const { desk, service } = fixture();
  const task = assigned(service);
  assert.throws(() => service.transition(reporter(task, { assignment_epoch: 2, state: "working" })), status(409));
  assert.throws(() => service.transition(reporter(task, { session_id: "old-session", state: "working" })), status(409));
  assert.throws(() => service.transition(reporter(task, { device_id: "desktop-b", state: "working" })), status(403));
  assert.throws(() => service.transition(reporter(task, { agent: "Stranger", state: "working" })), status(403));
  assert.throws(() => service.transition(reporter(task, { project: "Wrong", state: "working" })), status(403));
  assert.throws(() => service.transition(reporter(task, { assignment_epoch: undefined, state: "working" })), status(400));
  assert.throws(() => service.transition(reporter(task, { state: "accepted" })), status(409));
  assert.throws(() => service.transition(reporter(task, { state: "fake-launched" })), status(400));
  assert.equal(service.get(task.task_id).state, "assigned");
  assert.equal(desk.saved, 1);
  service.transition(reporter(task, { state: "working" }));
  service.transition(reporter(task, { execution_state: "submitted" }));
  service.transition(reporter(task, { state: "rework" }));
  service.transition(reporter(task, { state: "working" }));
  service.transition(reporter(task, { state: "submitted" }));
  const accepted = service.transition(reporter(task, { state: "accepted" }));
  assert.equal(accepted.state, "accepted");
  assert.throws(() => service.transition(reporter(task, { state: "working" })), status(409));
});

test("handoff is coordinator-only, increments epoch, preserves checkpoints, and rejects retired reports", () => {
  const { desk, service } = fixture();
  const task = assigned(service, { checkpoint: { next_step: "Review the synthetic implementation", constraints: ["Synthetic data only"] } });
  const handed = service.handoff({ task_id: task.task_id, assignment_epoch: 1, previous_session_id: "session-a", session_id: "session-b", adapter: "openclaw" });
  assert.equal(handed.task_id, task.task_id);
  assert.equal(handed.assignment.epoch, 2);
  assert.equal(handed.assignment.session_id, "session-b");
  assert.deepEqual(handed.checkpoint, task.checkpoint);
  assert.equal(handed.launch.status, "needs_manual_launch");
  assert.equal(handed.history.at(-1).previous_assignment.session_id, "session-a");
  assert.throws(() => service.transition(reporter(task, { state: "working" })), status(409));
  assert.throws(() => service.observe(marker({ task_id: task.task_id, device_id: "desktop-a", assignment_epoch: 1, seq: 99 })), status(409));
  assert.throws(() => service.handoff({ task_id: task.task_id, assignment_epoch: 1, session_id: "session-c" }), status(409));
  assert.throws(() => service.handoff({ task_id: task.task_id, assignment_epoch: 2, session_id: "session-b" }), status(409));
  desk.config.device_id = "desktop-b";
  assert.throws(() => service.assign({ task_id: task.task_id, assignment_epoch: 2, agent: "Worker", session_id: "session-c", coordinator_device_id: "desktop-b" }), status(409));
  assert.throws(() => service.handoff({ task_id: task.task_id, assignment_epoch: 2, session_id: "session-c", coordinator_device_id: "desktop-b" }), status(409));
});

test("reassigning existing task uses CAS and preserves retired binding metadata", () => {
  const { desk, service } = fixture();
  const first = assigned(service);
  const second = service.assign({ task_id: first.task_id, project_id: first.project_id, assignment_epoch: 1, agent: "Reviewer", device_id: "desktop-b", session_id: "review-session", role: "reviewer" });
  assert.equal(second.assignment.epoch, 2);
  assert.equal(second.state, "assigned");
  assert.equal(Object.keys(desk.state.bindings).length, 2);
  assert.throws(() => service.assign({ task_id: first.task_id, assignment_epoch: 1, agent: "Worker", session_id: "session-c" }), status(409));
});

test("duplicate event IDs survive snapshots and stale seq/parent stale flag cannot regress", () => {
  const { desk, service } = fixture();
  const first = service.observe(marker({ event_id: "synthetic-event" }));
  const restartedDesk = fixture().desk;
  restartedDesk.state = JSON.parse(JSON.stringify(desk.state));
  const restarted = new TaskService(restartedDesk);
  const duplicate = restarted.observe(marker({ event_id: "synthetic-event" }));
  assert.equal(duplicate.task_id, first.task_id);
  assert.equal(duplicate.history.length, 1);
  assert.throws(() => restarted.observe(marker({ seq: 1 })), status(409));
  assert.equal(restarted.observe(marker({ stale: true, seq: 3, state: "done" })), null);
  assert.equal(restarted.get(first.task_id).state, "working");
});

test("save failure throws, emits no change, rolls back task and binding maps", () => {
  const { desk, service } = fixture();
  const first = assigned(service);
  const before = JSON.stringify(desk.state);
  const saves = desk.saved;
  desk._saveState = () => { throw new Error("synthetic disk full"); };
  assert.throws(() => service.handoff({ task_id: first.task_id, assignment_epoch: 1, session_id: "session-b" }), /disk full/);
  assert.equal(JSON.stringify(desk.state), before);
  assert.equal(desk.changes, saves);
  assert.throws(() => assigned(service, { agent: "Other", session_id: "other" }), /disk full/);
  assert.equal(JSON.stringify(desk.state), before);
});

test("metadata is structured, bounded, non-secret; rejected input is transactional", () => {
  const { desk, service } = fixture();
  for (const cp of [
    { command: "curl https://example.invalid" }, { env: { token: "fake" } },
    { next_step: "curl https://example.invalid" }, { next_step: "git fetch origin && echo unsafe" },
    { report: "powershell -Command unsafe" }, { constraints: ["rm -rf example"] },
    { repo: "C:\\approved\\repo:stream" }, { skills: ["C:\\approved\\SKILL.md:secret.md"] },
    { next_step: "api_key=synthetic-secret-value" }, { next_step: JSON.stringify({ api_key: "synthetic-json-secret" }) },
    { report: JSON.stringify({ password: "synthetic-json-password" }) }, { report: "Bearer synthetic-secret-value" },
    { commit: "HEAD; echo unsafe" }, { repo: "../outside" }, { branch: "--upload-pack=evil" },
    { skills: ["../outside/SKILL.md"] }, { skills: ["credentials.json"] },
    { manifest: [{ path: "../outside.txt" }] }, { manifest: [{ path: ".env" }] },
    { manifest: [{ path: "file.txt" }, { path: "file.txt" }] },
    { constraints: Array(33).fill("Bounded") }, { skills: Array(9).fill("SKILL.md") },
  ]) assert.throws(() => assigned(service, { checkpoint: cp }), status(400));
  assert.throws(() => assigned(service, { artifacts: [{ path: "safe.txt", hash: "bad" }] }), status(400));
  assert.throws(() => assigned(service, { artifacts: [{ path: "C:\\outside.txt" }] }), status(400));
  assert.throws(() => assigned(service, { artifacts: [{ path: "safe.txt", size: 8 * 1024 * 1024 + 1 }] }), status(400));
  assert.throws(() => assigned(service, { session_id: "s; shell" }), status(400));
  assert.equal(service.list().length, 0);
  assert.equal(desk.saved, 0);
});

test("context without approvals never reads arbitrary repo or selected skill files", (t) => {
  const root = temporary(t);
  const skill = path.join(root, "SKILL.md");
  fs.writeFileSync(skill, "SYNTHETIC-PRIVATE-CONTENT");
  const { desk, service } = fixture();
  const task = assigned(service, { checkpoint: { repo: root, skills: [skill], report: "report.txt", next_step: "Review", constraints: ["Offline only"] } });
  const before = JSON.stringify(desk.state);
  const output = service.context(task.task_id);
  assert.equal(output.checks.repo.status, "blocked");
  assert.equal(output.checks.skills[0].status, "blocked");
  assert.equal(output.checks.report.status, "metadata_only");
  assert.equal(output.text.includes("SYNTHETIC-PRIVATE-CONTENT"), false);
  assert.match(output.text, /assignment_epoch: 1/);
  assert.match(output.text, /needs_manual_launch/);
  assert.equal(JSON.stringify(desk.state), before);
  assert.equal(desk.saved, 1);
});

test("approved repo checks are read-only and hash artifacts, never invent remote push", (t) => {
  const { root, repo, commit } = repository(t);
  const { desk, service } = fixture({ task_repo_roots: [{ project: "Synthetic", path: root }] });
  const expected = digest("synthetic artifact\n");
  const task = assigned(service, { checkpoint: { repo, branch: "main", commit, manifest: [{ path: "artifact.txt", sha256: expected }] }, artifacts: [{ path: "artifact.txt", hash: expected, status: "expected" }] });
  const indexBefore = fs.readFileSync(path.join(repo, ".git", "index"));
  const stateBefore = JSON.stringify(desk.state);
  const output = service.context(task.task_id);
  assert.deepEqual(output.checks.repo, { status: "verified", head: commit, branch: "main", clean_tracked: true, branch_matches: true, commit_present: true, commit_matches_head: true });
  assert.equal(output.checks.artifacts.length, 1);
  assert.equal(output.checks.artifacts[0].status, "verified");
  assert.equal(output.checks.remote_push.status, "unverified");
  assert.deepEqual(fs.readFileSync(path.join(repo, ".git", "index")), indexBefore);
  assert.equal(JSON.stringify(desk.state), stateBefore);
  fs.writeFileSync(path.join(repo, "artifact.txt"), "changed\n");
  const changed = service.context(task.task_id);
  assert.equal(changed.checks.repo.clean_tracked, false);
  assert.equal(changed.checks.artifacts[0].status, "mismatch");
});

test("remote-tracking proof is explicitly cached local evidence and no network fetch", (t) => {
  const { repo, commit } = repository(t);
  git(repo, "config", "remote.origin.url", "https://user:synthetic-password@example.invalid/repo.git");
  git(repo, "update-ref", "refs/remotes/origin/main", commit);
  const { service } = fixture({ approved_repo_roots: [repo] });
  const task = assigned(service, { checkpoint: { repo, commit } });
  const output = service.context(task.task_id);
  assert.equal(output.checks.remote_push.status, "local_remote_tracking_evidence");
  assert.deepEqual(output.checks.remote_push.refs, ["refs/remotes/origin/main"]);
  assert.match(output.checks.remote_push.reason, /freshness\/push is not verified/);
  assert.equal(JSON.stringify(output).includes("synthetic-password"), false);
});

test("detached HEAD and checkpoint branch/commit mismatch are truthful", (t) => {
  const { repo, commit } = repository(t);
  git(repo, "checkout", "--detach", commit);
  const { service } = fixture({ task_repo_roots: [repo] });
  const task = assigned(service, { checkpoint: { repo, branch: "other", commit: "a".repeat(40) } });
  const output = service.context(task.task_id);
  assert.equal(output.checks.repo.status, "verified");
  assert.equal(output.checks.repo.branch, null);
  assert.equal(output.checks.repo.branch_matches, false);
  assert.equal(output.checks.repo.commit_present, false);
  assert.equal(output.checks.remote_push.status, "unverified");
});

test("repository sibling prefix and project-specific root mismatch fail closed", (t) => {
  const root = temporary(t);
  const approved = path.join(root, "repo");
  const other = path.join(root, "repo-secret");
  fs.mkdirSync(approved);
  fs.mkdirSync(other);
  const { service } = fixture({ task_repo_roots: [approved], task_skill_roots: [{ project: "Other", path: root }] });
  fs.writeFileSync(path.join(root, "SKILL.md"), "DO NOT INCLUDE");
  const task = assigned(service, { checkpoint: { repo: other, skills: [path.join(root, "SKILL.md")] } });
  const output = service.context(task.task_id);
  assert.equal(output.checks.repo.status, "blocked");
  assert.equal(output.checks.skills[0].status, "blocked");
  assert.equal(output.text.includes("DO NOT INCLUDE"), false);
});

test("selected skills only, pinned hashes, bounds, redaction including private-key blocks", (t) => {
  const root = temporary(t);
  const skills = path.join(root, ".agents", "skills");
  fs.mkdirSync(skills, { recursive: true });
  const raw = "# Synthetic skill\nUse synthetic fixtures.\napi_key=synthetic-credential\n{\"api_key\":\"synthetic-json-credential\"}\n-----BEGIN OPENSSH PRIVATE KEY-----\nSYNTHETICKEYMATERIAL\n-----END OPENSSH PRIVATE KEY-----\nEnd.\n";
  fs.writeFileSync(path.join(skills, "SKILL.md"), raw);
  fs.writeFileSync(path.join(skills, "UNSELECTED.md"), "UNSELECTED-PRIVATE-CONTENT");
  fs.writeFileSync(path.join(skills, "LARGE.md"), "x".repeat(32 * 1024 + 1));
  const { desk, service } = fixture({ task_skill_roots: [{ project: "Synthetic", path: skills }] });
  const task = assigned(service, { checkpoint: { skills: [{ path: path.join(skills, "SKILL.md"), sha256: digest(raw) }, "LARGE.md"] } });
  const before = JSON.stringify(desk.state);
  const output = service.context(task.task_id);
  assert.equal(output.checks.skills[0].status, "redacted");
  assert.equal(output.checks.skills[1].status, "blocked");
  assert.match(output.text, /Use synthetic fixtures/);
  for (const secret of ["synthetic-credential", "synthetic-json-credential", "SYNTHETICKEYMATERIAL", "UNSELECTED-PRIVATE-CONTENT"]) assert.equal(JSON.stringify(output).includes(secret), false);
  assert.equal(JSON.stringify(desk.state), before);
  service.transition(reporter(task, { state: "working", checkpoint: { skills: [{ path: "SKILL.md", sha256: "f".repeat(64) }] } }));
  const mismatch = service.context(task.task_id);
  assert.equal(mismatch.checks.skills[0].status, "mismatch");
  assert.equal(mismatch.text.includes("Use synthetic fixtures"), false);
});

test("relative skill selection refuses ambiguous roots", (t) => {
  const root = temporary(t);
  const a = path.join(root, "a"), b = path.join(root, "b");
  fs.mkdirSync(a); fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, "SKILL.md"), "SOURCE A");
  fs.writeFileSync(path.join(b, "SKILL.md"), "SOURCE B");
  const { service } = fixture({ task_skill_roots: [a, b] });
  const task = assigned(service, { checkpoint: { skills: ["SKILL.md"] } });
  const output = service.context(task.task_id);
  assert.equal(output.checks.skills[0].status, "blocked");
  assert.equal(output.text.includes("SOURCE A"), false);
});

test("link/junction escape and artifact symlink are rejected", (t) => {
  const { root, repo } = repository(t);
  const external = path.join(root, "outside");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "SKILL.md"), "OUTSIDE-LINK-CONTENT");
  const link = path.join(repo, "linked");
  fs.symlinkSync(external, link, process.platform === "win32" ? "junction" : "dir");
  const { service } = fixture({ task_repo_roots: [repo], task_skill_roots: [repo] });
  const task = assigned(service, { checkpoint: { repo, skills: [path.join(link, "SKILL.md")] }, artifacts: [{ path: "linked/SKILL.md" }] });
  const output = service.context(task.task_id);
  assert.equal(output.checks.artifacts[0].status, "blocked");
  assert.equal(output.checks.skills[0].status, "blocked");
  assert.equal(output.text.includes("OUTSIDE-LINK-CONTENT"), false);
  const linkedRepoTask = assigned(service, { checkpoint: { repo: link } });
  assert.equal(service.context(linkedRepoTask.task_id).checks.repo.status, "blocked");
});

test("Git worktree redirect and hard-linked selected files fail closed", (t) => {
  const root = temporary(t);
  const repo = path.join(root, "worktree");
  const skills = path.join(root, "skills");
  fs.mkdirSync(repo); fs.mkdirSync(skills);
  fs.writeFileSync(path.join(repo, ".git"), `gitdir: ${path.join(root, "outside")}\n`);
  const source = path.join(root, "external.md");
  fs.writeFileSync(source, "HARDLINK-PRIVATE-CONTENT");
  fs.linkSync(source, path.join(skills, "SKILL.md"));
  const { service } = fixture({ task_repo_roots: [repo], task_skill_roots: [skills] });
  const task = assigned(service, { checkpoint: { repo, skills: ["SKILL.md"] } });
  const output = service.context(task.task_id);
  assert.equal(output.checks.repo.status, "blocked");
  assert.equal(output.checks.skills[0].status, "blocked");
  assert.equal(output.text.includes("HARDLINK-PRIVATE-CONTENT"), false);
});

test("context revalidates peer checkpoint metadata before filesystem access", () => {
  const { desk, service } = fixture();
  const task = assigned(service);
  desk.state.tasks[task.task_id].checkpoint = { command: "unsafe" };
  assert.throws(() => service.context(task.task_id), status(400));
  desk.state.tasks[task.task_id].checkpoint = {};
  desk.state.tasks[task.task_id].title = "token=synthetic-peer-secret";
  desk.state.tasks[task.task_id].history.push({ password: "synthetic-history-secret" });
  const output = service.context(task.task_id);
  assert.equal(JSON.stringify(output).includes("synthetic-peer-secret"), false);
  assert.equal(JSON.stringify(output).includes("synthetic-history-secret"), false);
});

test("blocked report resumes without reassignment and coordinator review marker is bound", () => {
  const { desk, service } = fixture();
  const task = service.observe(marker({ state: "blocked" }));
  assert.equal(task.state, "blocked");
  service.observe(marker({ seq: 2, state: "working" }));
  service.observe(marker({ seq: 3, state: "done" }));
  assigned(service, { title: "Register coordinator binding", role: "coordinator" });
  const accepted = service.observe(marker({ task_id: task.task_id, assignment_epoch: 1, device_id: "desktop-a", seq: 4, state: "done", execution_state: "accepted" }));
  assert.equal(accepted.state, "accepted");
  const remote = assigned(service, { title: "Remote work", device_id: "desktop-b", session_id: "remote-session" });
  service.transition(reporter(remote, { state: "submitted" }));
  assert.throws(() => service.observe(marker({ task_id: remote.task_id, task: "Remote work", device_id: "desktop-b", session: "remote-session", assignment_epoch: 1, execution_state: "accepted" })), status(403));
  desk.config.device_id = "desktop-b";
  assert.throws(() => service.transition(reporter(remote, { state: "accepted" })), status(403));
});

test("contradictory artifact/manifest pins are reported and unpinned row inherits manifest pin", (t) => {
  const { repo } = repository(t);
  const { service } = fixture({ task_repo_roots: [repo] });
  const task = assigned(service, { checkpoint: { repo, manifest: [{ path: "artifact.txt", sha256: "a".repeat(64) }] }, artifacts: [{ path: "artifact.txt", sha256: "b".repeat(64) }] });
  const conflict = service.context(task.task_id);
  assert.equal(conflict.checks.artifacts[0].status, "conflicting_metadata");
  assert.equal(conflict.checks.artifacts[0].sha256, undefined);
  service.transition(reporter(task, { state: "working", artifacts: [{ path: "artifact.txt" }] }));
  assert.equal(service.context(task.task_id).checks.artifacts[0].status, "mismatch");
});

test("aggregate selected skill reads are bounded to 128 KiB", (t) => {
  const root = temporary(t);
  const selection = [];
  for (let n = 0; n < 5; n++) {
    const name = `skill-${n}.md`;
    selection.push(name);
    fs.writeFileSync(path.join(root, name), "x".repeat(32 * 1024));
  }
  const { service } = fixture({ task_skill_roots: [root] });
  const task = assigned(service, { checkpoint: { skills: selection } });
  const output = service.context(task.task_id);
  assert.deepEqual(output.checks.skills.map((s) => s.status), ["present_unpinned", "present_unpinned", "present_unpinned", "present_unpinned", "blocked"]);
});

test("failed save rolls back journal capture, versions and hashes, not just task maps", () => {
  const { desk, service } = fixture();
  desk.state.version = 5;
  desk.state.sync = { events: [], hashes: {}, versions: {}, clock: 1 };
  desk.dirty = false;
  const before = JSON.stringify(desk.state);
  desk._saveState = () => {
    const task = Object.values(desk.state.tasks)[0];
    desk.state.sync.events.push({ type: "task", data: structuredClone(task) });
    desk.state.sync.hashes[task.task_id] = "captured";
    desk.state.sync.versions[task.task_id] = ++desk.state.sync.clock;
    desk.state.version++;
    desk.state.seen_ids = ["mutated-by-save"];
    desk.dirty = true;
    throw new Error("synthetic disk error after capture");
  };
  assert.throws(() => assigned(service), /disk error/);
  assert.equal(JSON.stringify(desk.state), before);
  assert.equal(desk.dirty, false);
  assert.equal(desk.changes, 0);
});

test("complete UTF-8 task event budget rejects oversized valid checkpoint before journal save", () => {
  const { desk, service } = fixture();
  const manifest = Array.from({ length: 64 }, (_, n) => ({ path: `files/${"x".repeat(680)}${n}.txt` }));
  assert.throws(() => assigned(service, { checkpoint: { manifest, constraints: Array(32).fill("x".repeat(500)) } }), status(400));
  assert.throws(() => assigned(service, { checkpoint: { constraints: Array(32).fill("文".repeat(999)) } }), status(400));
  assert.equal(desk.saved, 0);
  assert.equal(service.list().length, 0);
});

test("coordinator review uses its own explicitly bound actor, not remote worker identity", () => {
  const { service } = fixture();
  assigned(service, { title: "Coordinator role registration", agent: "Lead", session_id: "lead-session", role: "coordinator" });
  const worker = assigned(service, { title: "Remote worker task", device_id: "desktop-b", session_id: "worker-session" });
  service.transition(reporter(worker, { state: "submitted" }));
  const actor = { agent: "Lead", device_id: "desktop-a", session_id: "lead-session" };
  const accepted = service.transition({ task_id: worker.task_id, assignment_epoch: 1, state: "accepted", actor });
  assert.equal(accepted.assignment.device_id, "desktop-b");
  assert.equal(accepted.history.at(-1).actor.agent, "Lead");
  assert.equal(accepted.history.at(-1).actor.session_id, "lead-session");
  const second = assigned(service, { title: "Another remote worker task", device_id: "desktop-b", session_id: "worker-session" });
  service.transition(reporter(second, { state: "submitted" }));
  const ev = { ...marker(), task_id: second.task_id, task: second.title, assignment_epoch: 1, agent: "Lead", device_id: "desktop-a", session: "lead-session", execution_state: "accepted", seq: 10 };
  const reviewed = service.observe(ev);
  assert.equal(reviewed.state, "accepted");
  assert.equal(reviewed.history.at(-1).actor.agent, "Lead");
  assert.equal(reviewed.assignment.agent, "Worker");
  assert.throws(() => service.observe({ ...ev, event_id: "new-event", seq: 11, session: "retired-lead-session" }), status(403));
});

test("Git metadata redirects/includes/internal links and executable filters fail closed", (t) => {
  const { root, repo } = repository(t);
  const { service } = fixture({ task_repo_roots: [repo] });
  const task = assigned(service, { checkpoint: { repo } });
  const directory = path.join(repo, ".git");
  const alternate = path.join(directory, "objects", "info", "alternates");
  fs.writeFileSync(alternate, path.join(root, "outside-objects"));
  assert.equal(service.context(task.task_id).checks.repo.status, "blocked");
  fs.unlinkSync(alternate);
  fs.writeFileSync(path.join(directory, "commondir"), path.join(root, "outside-common"));
  assert.equal(service.context(task.task_id).checks.repo.status, "blocked");
  fs.unlinkSync(path.join(directory, "commondir"));
  const original = fs.readFileSync(path.join(directory, "config"), "utf8");
  fs.appendFileSync(path.join(directory, "config"), `\n[include]\n\tpath = ${path.join(root, "outside-config").replace(/\\/g, "/")}\n`);
  assert.equal(service.context(task.task_id).checks.repo.status, "blocked");
  fs.writeFileSync(path.join(directory, "config"), original);
  fs.appendFileSync(path.join(directory, "config"), "\n[filter \"unsafe\"]\n\tclean = node would-execute.js\n\tprocess = node would-execute.js\n");
  fs.writeFileSync(path.join(repo, "would-execute.js"), 'require("node:fs").writeFileSync("filter-side-effect", "unsafe");');
  fs.writeFileSync(path.join(repo, ".gitattributes"), "artifact.txt filter=unsafe\n");
  fs.writeFileSync(path.join(repo, "artifact.txt"), "changed\n");
  assert.equal(service.context(task.task_id).checks.repo.status, "blocked");
  assert.equal(fs.existsSync(path.join(repo, "filter-side-effect")), false);
  fs.writeFileSync(path.join(directory, "config"), original);
  const objects = path.join(directory, "objects");
  const moved = path.join(root, "moved-objects");
  fs.renameSync(objects, moved);
  fs.symlinkSync(moved, objects, process.platform === "win32" ? "junction" : "dir");
  assert.equal(service.context(task.task_id).checks.repo.status, "blocked");
});

test("Git execution ignores inherited redirection and stays shell-free/read-only", (t) => {
  const { repo, commit } = repository(t);
  const old = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(repo, "missing-redirection");
  t.after(() => { if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old; });
  const { service } = fixture({ task_repo_roots: [repo] });
  const task = assigned(service, { checkpoint: { repo, commit } });
  const output = service.context(task.task_id);
  assert.equal(output.checks.repo.status, "verified");
  assert.equal(output.checks.repo.head, commit);
});
