"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { MailStore, MAIL_LIMITS } = require("../mail");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentdesk-mail-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "mail");
  fs.mkdirSync(root);
  const desk = {
    config: { mail_roots: [{ project: "Demo", path: root }] }, state: {},
    _saveState() { assert.fail("MailStore must never persist Desk state directly"); },
    ...options,
  };
  return { directory, root, desk, store: new MailStore(desk) };
}
function put(root, relative, bytes) {
  const file = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}
function chunk(bytes, extra = {}) {
  return { project: "Demo", path: "inbox/message.txt", sha256: hash(bytes), offset: 0, total: bytes.length, data: Buffer.from(bytes).toString("base64"), ...extra };
}
function send(store, bytes, extra = {}, peer = "peer-one") {
  const content = Buffer.from(bytes);
  let result;
  for (let offset = 0; offset < content.length || (offset === 0 && content.length === 0); offset += MAIL_LIMITS.chunk) {
    result = store.acceptChunk(peer, chunk(content, { ...extra, offset, data: content.subarray(offset, offset + MAIL_LIMITS.chunk).toString("base64") }));
    if (result.complete) break;
  }
  return result;
}
function codes(store) { return store.payload().errors.map((row) => row.code); }
function rejectCode(fn, code) { assert.throws(fn, (error) => error.code === code); }

// Every path in these tests is under an OS temporary directory. No Desk instance,
// real watch directory, home configuration or network transport is used.
test("explicit roots, metadata-only scan, deterministic manifest and offline restart", (t) => {
  const { root, desk, store } = fixture(t);
  put(root, "outbox/b.txt", "beta");
  put(root, "inbox/a.json", '{"message":"hello"}');
  assert.equal(store.scan(), true);
  assert.equal(store.scan(), false);
  const rows = store.manifest();
  assert.deepEqual(rows.map((row) => row.path), ["inbox/a.json", "outbox/b.txt"]);
  assert.equal(rows[0].sha256, hash('{"message":"hello"}'));
  assert.deepEqual(store.payload().roots, [{ project: "Demo", path: root }]);
  assert.deepEqual(store.payload().errors, []);
  const restarted = new MailStore({ config: desk.config, state: JSON.parse(JSON.stringify(desk.state)) });
  assert.deepEqual(restarted.manifest(), rows);
  rows[0].path = "modified-by-caller";
  assert.equal(store.manifest()[0].path, "inbox/a.json");
  assert.equal(fs.readdirSync(root).includes(".agentdesk-mail-sync"), false);
});

test("infer only an existing monitor/inbox's sibling mail, with explicit opt-out", (t) => {
  const { directory, desk } = fixture(t);
  const inbox = path.join(directory, "project-Shared", "monitor", "inbox");
  const mail = path.join(directory, "project-Shared", "mail");
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(mail);
  put(mail, "messages/hello.txt", "hello");
  desk.config = { watch: [{ project: "Demo", path: inbox }] };
  let store = new MailStore(desk);
  assert.deepEqual(store.payload().roots, [{ project: "Demo", path: mail }]);
  assert.equal(store.manifest().length, 1);
  desk.config.mail_roots = [];
  assert.deepEqual(store.payload().roots, []);
  assert.deepEqual(store.manifest(), []);
  delete desk.config.mail_roots;
  desk.config.watch[0].path = path.join(directory, "project-Shared", "monitor");
  assert.deepEqual(store.payload().roots, []);
  desk.config.watch[0].path = path.join(directory, "missing", "monitor", "inbox");
  assert.deepEqual(store.payload().roots, []);
  assert.equal(fs.existsSync(desk.config.watch[0].path), false);
});

test("invalid roots never create directories; duplicate roots are deduplicated and project ambiguity is visible", (t) => {
  const { directory, root, desk, store } = fixture(t);
  const missing = path.join(directory, "not-created");
  desk.config.mail_roots = [{ project: "Demo", path: missing }, { project: "Other", path: "relative" }];
  assert.deepEqual(store.payload().roots, []);
  assert.equal(fs.existsSync(missing), false);
  rejectCode(() => send(store, "x"), "MAIL_ROOT");
  desk.config.mail_roots = [{ project: "Demo", path: root }, { project: "Demo", path: root }];
  assert.equal(store.payload().roots.length, 1);
  const other = path.join(directory, "other");
  fs.mkdirSync(other);
  desk.config.mail_roots.push({ project: "Demo", path: other });
  assert.equal(store.payload().roots.length, 1);
  assert.ok(codes(store).includes("MAIL_ROOT"));
  desk.config.mail_roots = "invalid";
  assert.deepEqual(store.payload().roots, []);
  assert.ok(codes(store).includes("MAIL_ROOT"));
});

test("overlapping roots and same directory aliases cannot create competing namespaces", (t) => {
  const { root, desk, store } = fixture(t);
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  desk.config.mail_roots.push({ project: "Other", path: nested }, { project: "Third", path: root });
  assert.equal(store.payload().roots.length, 1);
  assert.ok(codes(store).includes("MAIL_ROOT"));
});

test("hidden, system, temporary and secret-like files are not advertised or served", (t) => {
  const { root, store } = fixture(t);
  for (const relative of [".env", ".git/config", "secrets.json", "credentials.json", "api_key.txt", "token.json", "password.txt", "id_rsa", "private.pem", "draft.tmp", "draft.bak", "desktop.ini", "Thumbs.db", "~$draft.txt", "folder/.hidden.txt", "secret/note.txt"]) {
    put(root, relative, "never shared");
    rejectCode(() => store.readChunk({ project: "Demo", path: relative, sha256: hash("never shared"), offset: 0 }), "MAIL_PATH");
    rejectCode(() => send(store, "other", { path: relative }), "MAIL_PATH");
  }
  put(root, "inbox/ordinary.txt", "share me");
  assert.deepEqual(store.manifest().map((row) => row.path), ["inbox/ordinary.txt"]);
});

test("strict remote paths reject traversal, separators, absolute/ADS/reserved/encoded paths", (t) => {
  const { directory, store } = fixture(t);
  const malicious = ["../escape.txt", "a/../../escape.txt", "/absolute.txt", "C:/absolute.txt", "C:\\absolute.txt", "\\\\server\\share\\x", "a\\..\\x", "a//x", "./x", "a/./x", "a/../x", "a%2f..%2fx", "x\0.txt", "x:stream", "NUL.txt", "COM1", "LPT0.txt", "trailing. ", "trailing.", "trailing ", "a/", "", "x".repeat(241), "a/".repeat(17) + "x"];
  for (const relative of malicious) {
    rejectCode(() => send(store, "malicious", { path: relative }), "MAIL_PATH");
    rejectCode(() => store.readChunk({ project: "Demo", path: relative, sha256: hash("x"), offset: 0 }), "MAIL_PATH");
  }
  assert.equal(fs.existsSync(path.join(directory, "escape.txt")), false);
});

test("project mismatch cannot read or write a different configured root", (t) => {
  const { root, store } = fixture(t);
  put(root, "inbox/message.txt", "local");
  rejectCode(() => send(store, "remote", { project: "Other" }), "MAIL_ROOT");
  rejectCode(() => store.readChunk({ project: "Other", path: "inbox/message.txt", sha256: hash("local"), offset: 0 }), "MAIL_ROOT");
  rejectCode(() => send(store, "remote", { project: "../Demo" }), "MAIL_PROJECT");
  assert.equal(fs.readFileSync(path.join(root, "inbox", "message.txt"), "utf8"), "local");
});

function makeLink(t, target, link, directory) {
  try { fs.symlinkSync(target, link, directory && process.platform === "win32" ? "junction" : directory ? "dir" : "file"); }
  catch (e) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(e.code)) { t.skip(`OS does not permit this synthetic symlink: ${e.code}`); return false; }
    throw e;
  }
  return true;
}

test("directory symlinks/junctions are never scanned, read or written through", (t) => {
  const { directory, root, store } = fixture(t);
  const outside = path.join(directory, "outside");
  fs.mkdirSync(outside);
  put(outside, "mail.txt", "outside");
  if (!makeLink(t, outside, path.join(root, "linked"), true)) return;
  assert.deepEqual(store.manifest(), []);
  assert.ok(codes(store).includes("MAIL_SYMLINK"));
  rejectCode(() => send(store, "remote", { path: "linked/mail.txt" }), "MAIL_SYMLINK");
  rejectCode(() => store.readChunk({ project: "Demo", path: "linked/mail.txt", sha256: hash("outside"), offset: 0 }), "MAIL_SYMLINK");
  assert.equal(fs.readFileSync(path.join(outside, "mail.txt"), "utf8"), "outside");
});

test("file symlinks are never followed", (t) => {
  const { directory, root, store } = fixture(t);
  const outside = put(directory, "outside.txt", "outside");
  if (!makeLink(t, outside, path.join(root, "link.txt"), false)) return;
  assert.deepEqual(store.manifest(), []);
  rejectCode(() => send(store, "remote", { path: "link.txt" }), "MAIL_SYMLINK");
  rejectCode(() => store.readChunk({ project: "Demo", path: "link.txt", sha256: hash("outside"), offset: 0 }), "MAIL_SYMLINK");
  assert.equal(fs.readFileSync(outside, "utf8"), "outside");
});

test("root symlink or symlink ancestor is rejected even when explicitly configured", (t) => {
  const { directory, root, desk, store } = fixture(t);
  const alias = path.join(directory, "alias");
  if (!makeLink(t, root, alias, true)) return;
  desk.config.mail_roots[0].path = alias;
  assert.deepEqual(store.payload().roots, []);
  rejectCode(() => send(store, "remote"), "MAIL_ROOT");
  fs.mkdirSync(path.join(root, "sub"));
  desk.config.mail_roots[0].path = path.join(alias, "sub");
  assert.deepEqual(store.payload().roots, []);
});

test("symlinked internal staging directory cannot redirect transfer writes", (t) => {
  const { directory, root, store } = fixture(t);
  const outside = path.join(directory, "outside");
  fs.mkdirSync(outside);
  if (!makeLink(t, outside, path.join(root, ".agentdesk-mail-sync"), true)) return;
  rejectCode(() => send(store, "remote"), "MAIL_SYMLINK");
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("full SHA-256 chunk exchange, durable staging, atomic visibility and duplicate idempotency", (t) => {
  const { root, store } = fixture(t);
  const bytes = crypto.randomBytes(MAIL_LIMITS.chunk * 2 + 17);
  const source = put(root, "source.bin", bytes);
  const manifest = store.manifest().find((row) => row.path === "source.bin");
  let offset = 0;
  let first;
  const destination = path.join(root, "inbox", "message.txt");
  while (offset < bytes.length) {
    const read = store.readChunk({ ...manifest, offset });
    assert.equal(read.offset, offset);
    assert.equal(read.total, bytes.length);
    assert.ok(Buffer.from(read.data, "base64").length <= MAIL_LIMITS.chunk);
    const input = { ...read, project: "Demo", path: "inbox/message.txt" };
    const result = store.acceptChunk({ device_id: "peer-one" }, input);
    if (offset === 0) {
      first = input;
      assert.equal(result.complete, false);
      assert.equal(fs.existsSync(destination), false);
      assert.deepEqual(store.acceptChunk("peer-one", first), result);
    }
    offset = read.next;
    assert.equal(result.next, offset);
    assert.equal(result.complete, offset === bytes.length);
  }
  assert.deepEqual(fs.readFileSync(destination), bytes);
  assert.deepEqual(fs.readFileSync(source), bytes);
  assert.equal(store.acceptChunk("peer-one", first).complete, true);
  assert.equal(fs.readdirSync(path.join(root, ".agentdesk-mail-sync", "chunks")).length, 0);
  assert.equal(store.manifest().length, 2);
});

test("zero-length regular files can be exchanged and verified", (t) => {
  const { root, store } = fixture(t);
  put(root, "empty.txt", "");
  const read = store.readChunk({ project: "Demo", path: "empty.txt", sha256: hash(""), offset: 0 });
  assert.deepEqual(read, { data: "", offset: 0, total: 0, sha256: hash(""), next: 0 });
  assert.equal(send(store, "").complete, true);
  assert.equal(fs.statSync(path.join(root, "inbox", "message.txt")).size, 0);
});

test("chunk ordering, duplicate byte integrity and overlapping retries are strict", (t) => {
  const { root, store } = fixture(t);
  const bytes = Buffer.from("abcdef");
  rejectCode(() => store.acceptChunk("peer", chunk(bytes, { offset: 2, data: "Y2Q=" })), "MAIL_ORDER");
  const first = chunk(bytes, { data: "YWI=" });
  assert.equal(store.acceptChunk("peer", first).next, 2);
  rejectCode(() => store.acceptChunk("peer", { ...first, data: "eno=" }), "MAIL_DUPLICATE");
  rejectCode(() => store.acceptChunk("peer", chunk(bytes, { offset: 1, data: "YmNk" })), "MAIL_ORDER");
  rejectCode(() => store.acceptChunk("peer", chunk(bytes, { offset: 3, data: "ZGU=" })), "MAIL_ORDER");
  assert.equal(store.acceptChunk("peer", first).next, 2);
  assert.equal(store.acceptChunk("peer", chunk(bytes, { offset: 2, data: "Y2RlZg==" })).complete, true);
  assert.equal(fs.readFileSync(path.join(root, "inbox", "message.txt"), "utf8"), "abcdef");
});

test("staging resumes after a process restart and is isolated by peer and previous hash", (t) => {
  const { root, desk, store } = fixture(t);
  const bytes = Buffer.from("abcdef");
  const first = chunk(bytes, { data: "YWI=" });
  store.acceptChunk("peer-a", first);
  const restarted = new MailStore(desk);
  rejectCode(() => restarted.acceptChunk("peer-b", chunk(bytes, { offset: 2, data: "Y2RlZg==" })), "MAIL_ORDER");
  rejectCode(() => restarted.acceptChunk("peer-a", chunk(bytes, { offset: 2, data: "Y2RlZg==", previous_hash: hash("old") })), "MAIL_ORDER");
  assert.equal(restarted.acceptChunk("peer-a", chunk(bytes, { offset: 2, data: "Y2RlZg==" })).complete, true);
  assert.equal(fs.readFileSync(path.join(root, "inbox", "message.txt"), "utf8"), "abcdef");
});

test("base64, hashes, peer identities, offsets and bounded lengths are validated before writing", (t) => {
  const { root, store } = fixture(t);
  for (const data of ["$!", "YQ", "YQ=", "YQ===", "Y Q==", "YQ==\n", "YR==", "====", ""]) {
    rejectCode(() => store.acceptChunk("peer", chunk("a", { data })), "MAIL_CHUNK");
  }
  for (const extra of [{ offset: -1 }, { offset: 0.5 }, { offset: "0" }, { offset: 2 }, { total: -1 }, { total: "1" }, { total: MAIL_LIMITS.file + 1 }, { sha256: "f".repeat(63) }, { sha256: "A".repeat(64) }, { previous_hash: "bad" }, { previous_hash: null }]) {
    rejectCode(() => store.acceptChunk("peer", chunk("a", extra)), "MAIL_CHUNK");
  }
  rejectCode(() => store.acceptChunk("peer", chunk(Buffer.alloc(MAIL_LIMITS.chunk + 1))), "MAIL_CHUNK");
  for (const peer of ["", null, {}, "x".repeat(121), "bad\0peer"]) rejectCode(() => store.acceptChunk(peer, chunk("a")), "MAIL_PEER");
  assert.deepEqual(fs.readdirSync(root), []);
});

test("complete hash mismatch never installs bytes and clears only private staging", (t) => {
  const { root, store } = fixture(t);
  const local = put(root, "inbox/message.txt", "local");
  rejectCode(() => send(store, "invalid", { sha256: hash("expected") }), "MAIL_HASH");
  assert.equal(fs.readFileSync(local, "utf8"), "local");
  assert.equal(fs.readdirSync(path.join(root, ".agentdesk-mail-sync", "chunks")).length, 0);
  assert.equal(send(store, "expected").complete, true);
  assert.equal(fs.readFileSync(local, "utf8"), "local");
});

test("readChunk detects stale hashes, malformed offsets, oversize and directory files", (t) => {
  const { root, store } = fixture(t);
  put(root, "message.txt", "current");
  rejectCode(() => store.readChunk({ project: "Demo", path: "message.txt", sha256: hash("old"), offset: 0 }), "MAIL_CHANGED");
  for (const offset of [-1, 0.5, "0", 8]) {
    rejectCode(() => store.readChunk({ project: "Demo", path: "message.txt", sha256: hash("current"), offset }), "MAIL_CHUNK");
  }
  assert.equal(store.readChunk({ project: "Demo", path: "message.txt", sha256: hash("current"), offset: 7 }).data, "");
  fs.mkdirSync(path.join(root, "directory"));
  rejectCode(() => store.readChunk({ project: "Demo", path: "directory", sha256: hash(""), offset: 0 }), "MAIL_PATH");
  const big = put(root, "big.bin", "");
  fs.truncateSync(big, MAIL_LIMITS.file + 1);
  assert.equal(store.manifest().some((row) => row.path === "big.bin"), false);
  assert.ok(codes(store).includes("MAIL_LIMIT"));
  rejectCode(() => store.readChunk({ project: "Demo", path: "big.bin", sha256: hash(""), offset: 0 }), "MAIL_LIMIT");
});

test("declared previous hash safely updates a file and retains an independent recoverable backup", (t) => {
  const { root, store } = fixture(t);
  const file = put(root, "inbox/message.txt", "old");
  store.scan();
  const result = send(store, "new", { previous_hash: hash("old") });
  assert.equal(result.complete, true);
  assert.equal(result.conflict, false);
  assert.equal(result.backup, true);
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  const directory = path.join(root, ".agentdesk-mail-sync", "backups");
  const backups = fs.readdirSync(directory);
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(directory, backups[0]), "utf8"), "old");
  fs.writeFileSync(file, "user edit");
  assert.equal(fs.readFileSync(path.join(directory, backups[0]), "utf8"), "old");
  assert.equal(store.manifest().some((row) => row.path.includes("backups")), false);
});

test("local modifications advertise previous_hash without changing bytes or deleting other files", (t) => {
  const { root, store } = fixture(t);
  const file = put(root, "message.txt", "old");
  put(root, "keep.txt", "keep");
  const old = store.manifest().find((row) => row.path === "message.txt");
  assert.equal(old.previous_hash, undefined);
  fs.writeFileSync(file, "new");
  const row = store.manifest().find((item) => item.path === "message.txt");
  assert.equal(row.previous_hash, hash("old"));
  assert.equal(row.sha256, hash("new"));
  assert.deepEqual(store.manifest().find((item) => item.path === "message.txt"), row);
  fs.unlinkSync(file); // Synthetic local user deletion, not a MailStore operation.
  assert.deepEqual(store.manifest().map((item) => item.path), ["keep.txt"]);
  assert.equal(fs.readFileSync(path.join(root, "keep.txt"), "utf8"), "keep");
});

test("missing or wrong previous hash preserves both versions with deterministic visible conflict", (t) => {
  const { root, desk, store } = fixture(t);
  const file = put(root, "inbox/message.txt", "local");
  const first = send(store, "remote");
  assert.equal(first.conflict, true);
  assert.match(first.path, /message\.conflict-[a-f0-9]{64}\.txt$/);
  assert.equal(fs.readFileSync(file, "utf8"), "local");
  assert.equal(fs.readFileSync(path.join(root, ...first.path.split("/")), "utf8"), "remote");
  const second = send(store, "remote", { previous_hash: hash("not-local") }, "different-peer");
  assert.equal(second.path, first.path);
  assert.equal(store.manifest().length, 2);
  assert.ok(codes(store).includes("MAIL_CONFLICT"));
  assert.ok(codes(new MailStore(desk)).includes("MAIL_CONFLICT"));
});

test("destination created or edited while chunks are in flight causes preservation, not overwrite", (t) => {
  const { root, store } = fixture(t);
  const bytes = Buffer.from("remote");
  store.acceptChunk("peer", chunk(bytes, { data: "cmVt", previous_hash: hash("old") }));
  const file = put(root, "inbox/message.txt", "concurrent user edit");
  const result = store.acceptChunk("peer", chunk(bytes, { offset: 3, data: "b3Rl", previous_hash: hash("old") }));
  assert.equal(result.conflict, true);
  assert.equal(fs.readFileSync(file, "utf8"), "concurrent user edit");
  assert.equal(fs.readFileSync(path.join(root, ...result.path.split("/")), "utf8"), "remote");
});

test("concurrent user mutation during backup is detected and never acknowledged as installed", (t) => {
  const { root, store } = fixture(t);
  const file = put(root, "inbox/message.txt", "old");
  const copy = fs.copyFileSync;
  fs.copyFileSync = (...args) => {
    copy(...args);
    fs.writeFileSync(file, "concurrent edit");
  };
  try {
    const result = send(store, "remote", { previous_hash: hash("old") });
    assert.equal(result.conflict, true);
  } finally { fs.copyFileSync = copy; }
  assert.equal(fs.readFileSync(file, "utf8"), "concurrent edit");
});

test("corrupt deterministic conflict destination cannot be overwritten", (t) => {
  const { root, store } = fixture(t);
  put(root, "inbox/message.txt", "local");
  const name = `inbox/message.conflict-${hash("remote")}.txt`;
  put(root, name, "different existing bytes");
  rejectCode(() => send(store, "remote"), "MAIL_CONFLICT");
  assert.equal(fs.readFileSync(path.join(root, ...name.split("/")), "utf8"), "different existing bytes");
  assert.equal(fs.readFileSync(path.join(root, "inbox", "message.txt"), "utf8"), "local");
});

test("remote retries cannot claim a false total for already installed content", (t) => {
  const { root, store } = fixture(t);
  put(root, "inbox/message.txt", "content");
  rejectCode(() => send(store, "content", { total: 8 }), "MAIL_CHUNK");
});

test("disk failure during staging must throw, with no successful receipt or visible target", (t) => {
  const { root, store } = fixture(t);
  const write = fs.writeSync;
  fs.writeSync = () => { const error = new Error("synthetic full disk"); error.code = "ENOSPC"; throw error; };
  try { rejectCode(() => send(store, "remote"), "ENOSPC"); }
  finally { fs.writeSync = write; }
  assert.equal(fs.existsSync(path.join(root, "inbox", "message.txt")), false);
  assert.equal(send(store, "remote").complete, true);
});

test("disk failure during atomic update retains original and durable backup, then can retry", (t) => {
  const { root, store } = fixture(t);
  const file = put(root, "inbox/message.txt", "old");
  const rename = fs.renameSync;
  fs.renameSync = () => { const error = new Error("synthetic write denial"); error.code = "EACCES"; throw error; };
  try { rejectCode(() => send(store, "remote", { previous_hash: hash("old") }), "EACCES"); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(file, "utf8"), "old");
  const directory = path.join(root, ".agentdesk-mail-sync", "backups");
  assert.equal(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), "utf8"), "old");
  assert.equal(send(store, "remote", { previous_hash: hash("old") }).complete, true);
});

test("file fsync failure cannot produce a successful receipt", (t) => {
  const { root, store } = fixture(t);
  const sync = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isFile()) { const error = new Error("synthetic fsync failure"); error.code = "EIO"; throw error; }
    return sync(fd);
  };
  try { rejectCode(() => send(store, "remote"), "EIO"); }
  finally { fs.fsyncSync = sync; }
  assert.equal(fs.existsSync(path.join(root, "inbox", "message.txt")), false);
});

test("bounded staging transfer count prevents unbounded incomplete file creation", (t) => {
  const { root, store } = fixture(t);
  for (let i = 0; i < MAIL_LIMITS.transfers; i++) {
    assert.equal(store.acceptChunk("peer", chunk("x", { path: `file-${i}.txt`, sha256: hash(`promised-${i}`), total: 2 })).complete, false);
  }
  rejectCode(() => store.acceptChunk("peer", chunk("x", { path: "one-too-many.txt", total: 2 })), "MAIL_LIMIT");
  assert.equal(fs.readdirSync(path.join(root, ".agentdesk-mail-sync", "chunks")).length, MAIL_LIMITS.transfers);
  assert.deepEqual(store.manifest(), []);
});


test("incoming files cannot exceed the bounded manifest file count", (t) => {
  const { root, store } = fixture(t);
  for (let i = 0; i < MAIL_LIMITS.files; i++) put(root, `message-${i}.txt`, "");
  assert.equal(store.manifest().length, MAIL_LIMITS.files);
  rejectCode(() => send(store, "remote"), "MAIL_LIMIT");
  assert.equal(fs.existsSync(path.join(root, "inbox", "message.txt")), false);
  assert.equal(fs.readdirSync(root).filter((name) => name.startsWith("message-")).length, MAIL_LIMITS.files);
});

test("recoverable backup count has a hard limit instead of deleting old backups", (t) => {
  const { root, store } = fixture(t);
  const file = put(root, "inbox/message.txt", "old");
  const directory = path.join(root, ".agentdesk-mail-sync", "backups");
  fs.mkdirSync(directory, { recursive: true });
  for (let i = 0; i < MAIL_LIMITS.backups; i++) put(directory, `${hash(`file-${i}`)}-${hash(`old-${i}`)}.bak`, "old backup");
  rejectCode(() => send(store, "remote", { previous_hash: hash("old") }), "MAIL_LIMIT");
  assert.equal(fs.readFileSync(file, "utf8"), "old");
  assert.equal(fs.readdirSync(directory).length, MAIL_LIMITS.backups);
});

test("the full 8 MiB boundary is accepted in 64 KiB chunks", (t) => {
  const { root, store } = fixture(t);
  const bytes = Buffer.alloc(MAIL_LIMITS.file, 0x61);
  assert.equal(send(store, bytes, { path: "large.bin" }).complete, true);
  assert.equal(fs.statSync(path.join(root, "large.bin")).size, MAIL_LIMITS.file);
  assert.equal(store.manifest()[0].sha256, hash(bytes));
});

test("removing mailbox configuration never deletes any local user file", (t) => {
  const { root, desk, store } = fixture(t);
  put(root, "inbox/keep.txt", "keep");
  store.scan();
  desk.config.mail_roots = [];
  assert.deepEqual(store.manifest(), []);
  assert.equal(fs.readFileSync(path.join(root, "inbox", "keep.txt"), "utf8"), "keep");
  rejectCode(() => send(store, "remote"), "MAIL_ROOT");
});

test("completed transfer retries still reject changed duplicate bytes", (t) => {
  const { root, store } = fixture(t);
  put(root, "inbox/message.txt", "remote");
  rejectCode(() => store.acceptChunk("peer", chunk("remote", { data: Buffer.from("tamper").toString("base64") })), "MAIL_DUPLICATE");
});

test("a completed retry cannot bypass a continuing durability failure", (t) => {
  const { root, store } = fixture(t);
  put(root, "inbox/message.txt", "remote");
  const sync = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isFile()) { const error = new Error("synthetic durable-retry failure"); error.code = "EIO"; throw error; }
    return sync(fd);
  };
  try { rejectCode(() => send(store, "remote"), "EIO"); }
  finally { fs.fsyncSync = sync; }
});

test("retry after publication cleanup failure consumes only its own verified staging", (t) => {
  const { root, store } = fixture(t);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (file) => {
    if (file.endsWith(".part")) { const error = new Error("synthetic staging cleanup failure"); error.code = "EACCES"; throw error; }
    return unlink(file);
  };
  try { rejectCode(() => send(store, "remote"), "EACCES"); }
  finally { fs.unlinkSync = unlink; }
  assert.equal(fs.readFileSync(path.join(root, "inbox", "message.txt"), "utf8"), "remote");
  const directory = path.join(root, ".agentdesk-mail-sync", "chunks");
  assert.equal(fs.readdirSync(directory).length, 1);
  assert.equal(send(store, "remote").complete, true);
  assert.deepEqual(fs.readdirSync(directory), []);
});
