# TaskService integration

`agent-desk/core/tasks.js` exports `{ TaskService }` (CommonJS, Node >=20, built-in modules only). The existing Node test runner and built-in `crypto`, `fs`, `path`, and `child_process` are sufficient; no package dependency is needed. The service does not launch runtimes or execute checkpoint commands.

## Wiring

Construct `desk.tasks = new TaskService(desk)` **after** `desk.config` and `desk.state` have loaded, and before using their task/binding maps. The constructor initializes missing `state.tasks`/`state.bindings` object maps without saving. Keep both maps in durable snapshots/sync; never derive tasks from reminder closure.

- `observe(ev, todo?)`: call only for a validated/canonicalized, non-stale marker. Returns the task (or `null` for stale/empty ACK-only/idle markers), adds `task_id`/`project_id` to the marker and optional todo, and updates the maps. It **does not** save or emit. Parent owns marker validation, identity authentication, persistence, journal deduplication, and archive ordering. Validate/catch service errors before marking a marker seen or irreversibly applying reminder/agent mutations. A report rejected for a retired binding must not be acknowledged or archived as successful.
- `list(filters = {})`: detached task snapshots; filters `task_id`, `project_id`, `project`, `state`, `agent`, `device_id`, `session_id`, `role`.
- `get(task_id)`: detached task snapshot; invalid UUID => 400, missing UUID => 404.
- `assign(body)`, `transition(body)`, `handoff(body)`: synchronous owner mutations. Validate first, update maps, call `desk._saveState()`, then `desk.emit('change')`. Save failure throws and restores the **complete state snapshot (including journal events, hashes, Lamport versions, seen IDs and desk dirty flag)**; there is no successful response or change event. Desk remains responsible for its own broader dirty/version bookkeeping.
- `context(task_id)`: `{text, task, checks}`; read-only, no state save, no network, no launch.

Task routes should return the task itself or `{ok:true, task}`. Preserve `error.status` for JSON HTTP errors (400 invalid input, 403 wrong project/recipient/device or unauthorized review, 404 unknown task, 409 stale assignment/state/coordinator conflict). Owner auth and agent-key/loopback auth are the HTTP layer's responsibility; **a body-supplied coordinator_device_id is not authority**.

For packaging/tests, parent must include `core/tasks.js` in Electron builder files and `core/test/tasks.test.js` in the test script. This child intentionally did not edit package/desk/peer/UI files.

## Task shape

```js
{
  task_id, project_id, project, title,
  state: 'assigned|working|submitted|accepted|rework|blocked',
  coordinator_device_id,
  assignment: {agent, device_id, session_id, epoch, role, adapter},
  checkpoint: {repo?, branch?, commit?, report?, manifest?, next_step?, constraints?, skills?},
  artifacts: [{path, sha256?, status?, size?}],
  history: [{time, kind, from_state, state, agent, device_id, session_id,
             assignment_epoch, event_id?, seq?, note?, actor?, previous_assignment?}],
  binding_id, managed_assignment, created, updated,
  launch: {status:'needs_manual_launch', adapter, reason}
}
```

All generated task/project/binding IDs use `crypto.randomUUID()`. Device/session identifiers allow bounded letters, digits, `.`, `_`, `:`, `-` (compatible with current hex device IDs and ordinary session IDs). Roles/agent names are bounded text; desk canonicalization is used when available. Project names reuse a known project UUID; conflicting/ambiguous project identity requires explicit resolution.

Binding map entries are `{id, project, agent, role, device_id, session_id, adapter}`. Bindings are reusable immutable metadata and retained for history, **not an active execution authority**. The current task assignment/epoch is authoritative. Do not show every historical binding as a running agent.

## Mutation bodies

### Assign a new task

```json
{"project":"Synthetic","title":"Review the feature","agent":"Worker","device_id":"desktop-a","session_id":"session-a","role":"worker","adapter":"manual"}
```

`task_id` omitted creates a task; supplying an unknown `task_id` is 404 (only observed validated marker IDs can import a new explicit identity). Optional `project_id` must be a UUID. `device_id` defaults to the local device. Agent and nonempty target session are required; `to` is an agent alias. Nested `assignment:{agent,device_id,session_id,role,adapter}` is also supported. `title` aliases `task`.

Existing assignment requires `task_id` and the **current top-level** `assignment_epoch` (`epoch` alias), plus target agent/session; increments epoch even for a deliberate same-session reassignment, resets state to assigned, preserves checkpoint/artifacts unless replaced. Only the actual local coordinator desk may assign/reassign/handoff; otherwise 409 directs the user to that desk.

### Transition/report

```json
{"task_id":"<UUID>","project":"Synthetic","agent":"Worker","device_id":"desktop-a","session_id":"session-a","assignment_epoch":1,"execution_state":"submitted","checkpoint":{"next_step":"Review the synthetic changes"}}
```

`execution_state` aliases `state`; `task_id` aliases `id`. Reporter agent/device/session and current epoch are mandatory and must match the task binding. Optional project/project_id must match. Transition graph:

- assigned → working/submitted/blocked
- working → submitted/blocked
- submitted → accepted/rework/blocked
- rework → working/submitted/blocked
- blocked → assigned/working/submitted/rework
- accepted → no different state (explicit reassignment is required)

Same-state metadata updates are allowed. Acceptance/rework require execution on the coordinator desk. Worker identity fields remain accepted for the existing owner UI's compare-and-set request, but review history records a separate `actor:{agent:'owner',device_id:<coordinator>,session_id:'',role:'owner'}`, not a worker review claim.

For a real bound coordinator/reviewer actor, send `{task_id,assignment_epoch,state:'accepted',actor:{agent,device_id,session_id}}`; the actor must match an explicit project binding with role `coordinator` or `reviewer`, on the coordinator device. Coordinator review markers may use their **own** agent/device/session and current task epoch instead of the remote worker's identity; the same binding check applies. History stores the actual actor separately while preserving the worker assignment. Parent auth must ensure agent clients cannot impersonate another authenticated binding; bare body strings are not independent credentials.

### Handoff

```json
{"task_id":"<UUID>","assignment_epoch":1,"previous_session_id":"session-a","session_id":"session-b","adapter":"openclaw"}
```

Current epoch is mandatory. Optional previous_session_id/previous_device_id provide extra compare-and-set checks. Target defaults to the previous agent/device/role/adapter; nonempty target session is required. Must change agent, device, or session. Increments epoch, preserves one task identity and checkpoint/artifacts, records previous assignment, resets assigned. All old-session/epoch reports are rejected. **All adapters currently return needs_manual_launch**, including `openclaw`; no runtime is actually contacted.

All mutations may replace structured `checkpoint` and/or `artifacts`. The **complete task journal event** is limited to 60,000 UTF-8 bytes (including envelope/history/artifacts), checked before state changes/saves; oversized input is 400 with an instruction to shorten metadata. Unknown checkpoint/file fields (including commands/env/passwords) are rejected. Inputs are bounded, credential-like strings rejected, artifact paths nonsecret relative files, and hashes validated as SHA-256. `next_step`/`report`/`constraints` must be descriptive metadata, not direct shell commands or shell control syntax. Windows alternate-stream/device paths are rejected.

## Observed marker compatibility

New explicit `task_id` marker identities require an epoch and session. Existing explicit/managed task reports require assigned agent/device/session/epoch. The parent must preserve `session_id` or its existing parsed `session` alias, `device_id`, `assignment_epoch`, `task_id`, `project_id`, `execution_state`, `checkpoint`, and `artifacts` when normalizing markers.

Legacy markers without task_id match by **project + exact task title + canonical assigned agent**, only if exactly one task matches. Otherwise a separate task is created, avoiding guessed merges. Pure legacy tasks may omit epochs; session changes still require explicit handoff, and any explicit owner assignment makes epochs mandatory thereafter. Legacy state `working` maps to working, `done` to submitted, blocked to blocked; waiting/idle do not imply acceptance or reassign the task. Duplicate event IDs in history return without another lifecycle update; stale sequence is 409. Parent durable event dedup remains authoritative beyond bounded 200-row history.

## Explicit local verification approvals

No implicit home scan, watch-folder inference, network access, or remotely supplied approvals. Set local config arrays:

```js
config.task_repo_roots = [{project:'Synthetic', path:'C:\\approved\\synthetic'}];
config.task_skill_roots = [{project:'Synthetic', path:'C:\\approved\\skills'}];
```

Strings (global explicit roots) and `{project_id, path}` entries are supported. `approved_repo_roots`/`approved_skill_roots` are fallback aliases. Parent local-admin config handling must preserve these arrays but **not replicate approvals**. No defaults are added. The service reads at most 32 configured roots per category and selected checkpoint skills only.

`context` validates replicated checkpoint/artifact metadata again before reads. Paths must remain inside approval roots, with no symlinks/junctions at any component. Git expects an ordinary repository root with a `.git` directory: linked worktrees/submodules/bare repos fail closed. Before launching Git, the service checks at most 4,096 internal metadata entries and rejects internal links/hardlinks/special files, `commondir`, object alternates, worktree redirects, config includes and executable filter/alias/submodule configuration. Metadata configurations that cannot be safely checked are blocked, rather than executed. `git` must be locally installed/on PATH; otherwise checks are blocked, never fabricated. Fixed read-only shell-free Git commands use a minimal environment that ignores inherited `GIT_*`, system/global configuration and attributes, credentials, fsmonitor and optional index locks; external attributes/excludes files are overridden and submodule status is disabled. Each spawn is bounded to 1.5 s / 256 KiB. No fetch/push, shell, hooks or arbitrary checkpoint executable.

Checks include HEAD/branch/tracked cleanliness, requested branch/commit presence/HEAD match, and locally cached remote-tracking refs containing the checkpoint commit. `remote_push.status='local_remote_tracking_evidence'` means **cached local evidence only**, not proof of current remote state or that a push was performed. `clean_tracked` excludes untracked files; named artifacts are verified separately.

Artifacts/manifest: max 64 each with unique paths; duplicate paths across artifact/manifest lists are verified once, combining their pins (contradictory pins produce `conflicting_metadata`); SHA-256/size checks, max 8 MiB per file and 32 MiB total reads. Content never included. Checkpoint report is **unread metadata**, not a claim the report exists. Files with multiple hard links, hidden relative artifact paths or credential-like names are rejected.

Skills: max eight explicitly selected `.md`/`.txt` paths, max 32 KiB each / 128 KiB aggregate; no directory scan. Relative selectors must resolve uniquely within approved roots. Hash mismatch omits content; unpinned content is clearly `present_unpinned`. Credential-like lines/private-key blocks are omitted; selected content is labeled reference data, not executable authority. Approve only trusted nonsecret skill roots; pattern redaction cannot identify every conceivable opaque secret. Context read failures are visible per-check `blocked` statuses and do not cause mutation/false verification.

## Focused verification

Run from `agent-desk`:

```text
node --test --test-reporter=spec core\test\tasks.test.js
```

All fixtures use temp directories/mock desks; no live AgentDesk directories, real repositories or network endpoints. Tests cover lifecycle/receipt separation, UUIDs, legacy ambiguity, identity/session/epoch failures, coordinator CAS and real actor review, full-state/journal rollback on disk failure, UTF-8 journal budgets, persisted event dedup, metadata bounds, explicit root approval, hashes/read-only Git index, cached remote proof, detached HEAD, quoted JSON credential/private-key omission, selected skill bounds/pinning, directory junctions/hardlinks, linked-worktree/internal-Git redirects, config includes/filter rejection, and ignored inherited Git environment.

## Parent-only integration cautions

- Incoming task snapshots must preserve immutable coordinator/project identity, enforce nondecreasing assignment epochs, validate authority for assignments versus worker lifecycle reports, and surface conflicts. A higher Lamport clock alone must never resurrect a retired assignment or change the coordinator. Binding imports must not create unauthorized coordinator roles. TaskService cannot secure a parent sync layer that replaces its state maps without these checks.
- Keep project UUID mapping consistent across owner assignment and marker parsing. The service generates/reuses project UUIDs; a parser that injects a deterministic project ID independently can conflict with an owner-created task's UUID. Preserve explicit marker IDs; otherwise use the existing task/project mapping before creating a new identity. Apply any chosen shared project mapping to **both** assignment and marker routes.
- Parent should call observe before acknowledging receipts/marking seen/archive success, or roll back its larger marker application transaction if observation fails.
