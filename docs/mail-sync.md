# Local mailbox replication

`core/mail.js` exports the dependency-free CommonJS `MailStore` class and
`MAIL_LIMITS`. It performs **file replication**, not SMTP/IMAP. It does not open
network connections, read home configuration, change watch configuration, or
persist Desk state itself.

## Integration

```js
const { MailStore } = require('./mail');
const mail = new MailStore(desk); // config and state must already be loaded
if (mail.scan()) desk._saveState(); // Desk owns durable state persistence
const payload = mail.payload();   // { roots, files, errors, mode }
const manifest = mail.manifest(); // [{ project, path, sha256, size, previous_hash? }]
const part = mail.readChunk({ project, path, sha256, offset: 0 });
const result = mail.acceptChunk(peer, { project, path, sha256, previous_hash,
  offset: part.offset, total: part.total, data: part.data });
```

`peer` is a stable device-id string or an object containing `device_id`/`id`.
Only pass authenticated peer identities: this module is not a transport or an
authorization boundary. The parent must encrypt/authenticate manifests and chunks,
validate manifests before requesting files, and never transmit `payload().roots`
(local absolute paths), Desk config or secret values to peers.

`readChunk` returns `{data, offset, total, sha256, next}`. Raw chunks are at most
64 KiB. `acceptChunk` returns `{ok:true, complete:false, next, total, sha256}` while
staging, then `{ok:true, complete:true, next, total, sha256, path, conflict,
backup?}` after full hash verification and durable publication. A conflict is a
successful preservation of the remote bytes, **not replacement of the original**;
use returned `path` and visible errors. All validation/disk errors throw with a
`code`; do not send an affirmative receipt on exceptions. Chunk acknowledgments
are independent of task/board ACKs. Parents may resume interrupted transfers at
`next` or replay identical earlier chunks; changed or overlapping retry bytes are
rejected, including after a transfer is already installed. Completed retries recheck
provided bytes, fsync the installed file again, and consume any matching leftover
staging before acknowledging success. The same transfer tuple resumes from durable
staging across restarts.

`scan`, `manifest` and `payload` refresh only `desk.state.mail_index` metadata.
They never call `_saveState` or emit changes. Parent persistence/notifications must
follow its integration contract. Callers get copies of manifest/payload rows.
An observed local content change advertises the prior SHA-256 as `previous_hash`.
Removing files or roots only removes manifest metadata; no deletion is replicated.

## Roots and safety

An explicitly present `config.mail_roots` takes precedence, including `[]` (off).
Each row is `{project, path}` with a nonempty project and an absolute existing
plain directory. A project maps to one root; duplicates are deduplicated, while
ambiguous/overlapping rows produce visible configuration errors and are skipped.
Without `mail_roots`, inference considers only existing `monitor/inbox` watch
paths and their existing `../../mail` sibling. It never creates inferred roots.
For a paired incoming manifest, `ensureIncomingRoot(project, fileMetadata)` may
create a bounded root under `desk.dataDir/mail/project-<hash>` only when no explicit
`mail_roots` is set. Project/path/hash/size are validated before creation; symlinked
ancestors are rejected. These app-owned mappings are stored in local
`state.mail_incoming_roots`, not replicated config. Desk persists them with state.
The local-only `/api/mail/config` action `{automatic:true}` explicitly restores
this automatic mode; peers cannot override an owner's manual list or opt-out.
`diagnostics()` is the peer-safe view: mode, project names, file count and error
codes, without absolute paths. Configuration errors remain visible locally in
`payload().errors`.

Only regular files with safe relative POSIX paths are shared. Path depth/length,
Windows device names and alternate streams, encoded separators, traversal,
controls, hidden/system/temp files and secret-like filenames/extensions are
rejected. Every ancestor is checked for symlinks/junctions; regular-file opens and
hash/read operations check file identity and concurrent stat changes. Filename
filters are conservative heuristics, **not content-based secret detection**:
configure a dedicated mailbox, not a repository/home/configuration directory.

Limits: 20 roots, 2,000 advertised files, 10,000 enumerated entries, 16 path
segments, 1,024 path characters, 240 characters per filename, 8 MiB per file,
32 incomplete transfers/64 MiB staged bytes per root, and 128 recoverable
backups/64 MiB backup bytes per root. Incoming new/conflict files and updates
fail closed when their corresponding quotas are reached. No new dependencies
are required on Node >=20.

## Durability and conflicts

Internal state lives below each mailbox's hidden `.agentdesk-mail-sync` directory:
`chunks/<SHA-256-of-transfer-tuple>.part` and
`backups/<SHA-256-of-project-and-path>-<preimage-SHA-256>.bak`.
Chunks are fsynced before acknowledgments. Files are fully SHA-256 verified before
publication. New files use an atomic no-clobber hard link from same-volume staging;
updates retain an independent copied/fsynced backup, recheck the destination, and
atomically rename staging over it **only if** the current content equals the
remote declared `previous_hash`. Windows file fsync uses writable descriptors.
Directory fsync is used where the OS supports it; Node on Windows cannot provide
the POSIX directory-fsync guarantee. Filesystems must support same-volume hard
links and atomic rename; unsupported operations throw rather than fall back to a
non-atomic or destructive copy.

Without a matching preimage, preserve the original and publish a deterministic
`<name>.conflict-<full-remote-sha256><extension>` file. The name is bounded, and an
exceptionally long relative prefix falls back to a deterministic root-level
conflict filename. Existing conflict bytes are never overwritten. Conflicts are
visible in errors and rediscovered after restart by their filename. No mail/user
file or recoverable backup is deleted. Hash-mismatched staging and successfully
consumed staging are the only files this module removes.

As with standard Node path-based filesystem APIs, checks cannot eliminate a
malicious same-user process racing a directory/leaf replacement precisely between
check and syscall. Root directories must not be controlled by untrusted OS users;
cooperative writers should use atomic writes. Tests cover destination changes
while transferring and during backup. A power failure during Windows directory
metadata publication cannot be tested here. Abandoned staging/backups are retained
rather than silently garbage-collected; when a quota is exhausted, local owner
review/cleanup (while replication is stopped) is required.

## Tests

```text
node --test agent-desk/core/test/mail.test.js
```

All tests use synthetic OS-temp roots and an in-memory mock Desk. No real mail,
`~/AgentDesk`, installed project inbox, pairing or outbound traffic is involved.
The focused suite covers inference/opt-out, restart manifests and staging,
traversal/secret/system/symlink rejection, exact chunk/file limits, strict canonical
base64, ordering and duplicate bytes (including completed retries), full hash
mismatch, safe backups, concurrent conflicts, file/staging/backup quotas,
disk/fsync failures and retry recovery, and non-deletion.
