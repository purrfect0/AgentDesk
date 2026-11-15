"use strict";
/**
 * Local mailbox files under configured/inferred roots or bounded app-owned incoming roots.
 * No transport, config persistence or state writes: Desk owns those.
 * All remote file paths stay relative to validated mailbox roots.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const LIMITS = Object.freeze({
  chunk: 64 * 1024, file: 8 * 1024 * 1024, roots: 20, files: 2000,
  entries: 10000, depth: 16, path: 1024, transfers: 32, staging: 64 * 1024 * 1024,
  backups: 128, backupBytes: 64 * 1024 * 1024,
});
const INTERNAL = ".agentdesk-mail-sync";
const HEX = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const SECRET = /(?:^|[._-])(?:secrets?|credentials?|passwords?|passwd|tokens?|api[-_]?keys?|private[-_]?keys?|auth)(?:[._-]|$)/i;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const keyFor = (project, relative) => digest(JSON.stringify([project, relative]));
const sameStat = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const absent = (e) => e.code === "ENOENT";
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function projectName(value) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 60
    || /[\x00-\x1f\x7f/\\]/.test(value)) throw fail("MAIL_PROJECT", "Invalid mailbox project");
  return value;
}
function safeSegment(value) {
  return value.length > 0 && value.length <= 240 && !/^[.]/.test(value)
    && !/[\x00-\x1f\x7f<>:"|?*\\%]/.test(value) && !/[. ]$/.test(value)
    && !RESERVED.test(value) && value !== "..";
}
function excluded(value) {
  return /^\./.test(value) || /^~\$/.test(value) || SECRET.test(value)
    || /^(?:desktop\.ini|thumbs\.db|id_(?:rsa|dsa|ecdsa|ed25519))(?:$|\.)/i.test(value)
    || /\.(?:tmp|temp|part|swp|bak|pem|key|p12|pfx|keystore)$/i.test(value);
}
function relativePath(value) {
  if (typeof value !== "string" || !value || value.length > LIMITS.path
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw fail("MAIL_PATH", "Mailbox paths must be bounded relative paths");
  }
  const parts = value.split("/");
  if (parts.length > LIMITS.depth || parts.some((part) => !safeSegment(part) || excluded(part))) {
    throw fail("MAIL_PATH", "Unsafe, hidden, system or secret-like mailbox path");
  }
  return parts;
}
function lstatMaybe(file) {
  try { return fs.lstatSync(file); } catch (e) { if (absent(e)) return null; throw e; }
}
/** Check every ancestor, including ancestors outside the configured root. */
function directorySafe(directory) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail("MAIL_SYMLINK", "Mailbox directory is not a plain directory");
  }
  // On Windows lstat identifies junctions; realpath additionally catches aliases.
  const actual = fs.realpathSync.native(absolute);
  const compare = (s) => process.platform === "win32" ? s.toLowerCase() : s;
  if (compare(actual) !== compare(absolute)) throw fail("MAIL_SYMLINK", "Mailbox root resolves through an alias");
  return actual;
}
function syncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch (e) {
    // Node/Windows cannot open/fsync directories. File data is always fsynced.
    if (process.platform !== "win32" || !["EPERM", "EACCES", "EINVAL", "EISDIR", "ENOTSUP"].includes(e.code)) throw e;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function openRegular(file, flags = fs.constants.O_RDONLY) {
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink() || !before.isFile()) throw fail("MAIL_SYMLINK", "Only regular mailbox files are allowed");
  const fd = fs.openSync(file, flags | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    const after = fs.lstatSync(file);
    if (!opened.isFile() || after.isSymbolicLink() || !sameStat(before, opened) || !sameStat(after, opened)) {
      throw fail("MAIL_CHANGED", "Mailbox file changed while opening");
    }
    return { fd, stat: opened };
  } catch (e) { fs.closeSync(fd); throw e; }
}
function hashFile(file, limit = LIMITS.file) {
  const { fd, stat } = openRegular(file);
  try {
    if (stat.size > limit) throw fail("MAIL_LIMIT", "Mailbox file exceeds its size limit");
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.alloc(LIMITS.chunk);
    let offset = 0;
    while (offset < stat.size) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (!count) throw fail("MAIL_CHANGED", "Mailbox file was truncated while reading");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fs.lstatSync(file);
    if (!sameStat(stat, fs.fstatSync(fd)) || after.isSymbolicLink() || !sameStat(stat, after)) {
      throw fail("MAIL_CHANGED", "Mailbox file changed while hashing");
    }
    return { sha256: hash.digest("hex"), size: stat.size, stat };
  } finally { fs.closeSync(fd); }
}
function writeAll(fd, buffer, position) {
  let written = 0;
  while (written < buffer.length) {
    const count = fs.writeSync(fd, buffer, written, buffer.length - written, position + written);
    if (!count) throw fail("MAIL_IO", "Mailbox staging write made no progress");
    written += count;
  }
}

class MailStore {
  constructor(desk) {
    if (!desk || !desk.config || !desk.state) throw new TypeError("MailStore requires a loaded desk config and state");
    this.desk = desk;
    this.errors = [];
    this.notices = [];
    this.roots = [];
    this._scanErrors = [];
  }

  _notice(error) {
    const signature = JSON.stringify(error);
    if (!this.notices.some((row) => JSON.stringify(row) === signature)) this.notices.push(error);
    this.notices = this.notices.slice(-100);
  }

  _configuredRoots() {
    const config = this.desk.config;
    let candidates;
    const errors = [];
    if (Object.prototype.hasOwnProperty.call(config, "mail_roots")) {
      if (!Array.isArray(config.mail_roots)) {
        return { roots: [], errors: [{ code: "MAIL_ROOT", message: "mail_roots must be an array" }] };
      }
      candidates = config.mail_roots;
    } else {
      candidates = [];
      for (const watcher of (Array.isArray(config.watch) ? config.watch : []).slice(0, LIMITS.roots)) {
        if (!watcher || typeof watcher.path !== "string" || !path.isAbsolute(watcher.path)) continue;
        const inbox = path.resolve(watcher.path);
        if (path.basename(inbox).toLowerCase() !== "inbox"
          || path.basename(path.dirname(inbox)).toLowerCase() !== "monitor") continue;
        try {
          directorySafe(inbox);
          const mail = path.resolve(inbox, "..", "..", "mail");
          if (lstatMaybe(mail)) candidates.push({ project: watcher.project, path: mail });
        } catch (e) {
          errors.push({ code: e.code || "MAIL_ROOT", project: watcher.project || "", message: "Unsafe inferred mailbox root" });
        }
      }
      for (const generated of (Array.isArray(this.desk.state.mail_incoming_roots) ? this.desk.state.mail_incoming_roots : []).slice(0, LIMITS.roots)) {
        try {
          const project = projectName(generated.project);
          const expected = path.join(path.resolve(this.desk.dataDir), "mail", `project-${digest(project).slice(0, 16)}`);
          const normalize = value => process.platform === "win32" ? value.toLowerCase() : value;
          if (normalize(path.resolve(generated.path || "")) !== normalize(expected)) throw fail("MAIL_ROOT", "Unexpected incoming mailbox root");
          if (!candidates.some(root => root.project === project)) candidates.push({ project, path: expected });
        } catch (e) { errors.push({ code: e.code || "MAIL_ROOT", message: "Unsafe incoming mailbox root" }); }
      }
    }
    if (candidates.length > LIMITS.roots) errors.push({ code: "MAIL_LIMIT", message: "Too many mailbox roots" });
    const roots = [];
    for (const candidate of candidates.slice(0, LIMITS.roots)) {
      try {
        if (!candidate || typeof candidate.path !== "string" || !path.isAbsolute(candidate.path)) {
          throw fail("MAIL_ROOT", "Mailbox roots must be absolute existing directories");
        }
        const project = projectName(candidate.project);
        const directory = directorySafe(candidate.path);
        const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
        if (roots.some((root) => root.project === project && samePath(root.path, directory))) continue;
        // One namespace per project; overlapping paths and aliases cause duplicate/confused writes.
        if (roots.some((root) => root.project === project || samePath(root.path, directory)
          || directory.startsWith(root.path + path.sep) || root.path.startsWith(directory + path.sep))) {
          throw fail("MAIL_ROOT", "Mailbox projects and roots must be unique and non-overlapping");
        }
        roots.push({ project, path: directory });
      } catch (e) {
        errors.push({ code: e.code || "MAIL_ROOT", project: typeof candidate?.project === "string" ? candidate.project.slice(0, 60) : "", message: e.message });
      }
    }
    return { roots, errors };
  }

  ensureIncomingRoot(project, file) {
    project = projectName(project);
    if (file) {
      relativePath(file.path);
      if (!HEX.test(file.sha256 || "") || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > LIMITS.file) throw fail("MAIL_CHUNK", "Invalid incoming mailbox manifest");
    }
    const configured = this._configuredRoots();
    const existing = configured.roots.find(root => root.project === project);
    if (existing) return existing;
    // Explicit settings, including [], are an owner decision, never overridden by a peer.
    if (Object.prototype.hasOwnProperty.call(this.desk.config, "mail_roots")) {
      if (this.desk.config.mail_roots?.length) this._notice({ code: "MAIL_NOT_CONFIGURED", project, message: "No receiving root for this shared project; configure Mail folders" });
      return null;
    }
    if (configured.roots.length >= LIMITS.roots) throw fail("MAIL_LIMIT", "Too many incoming mailbox projects");
    const data = directorySafe(this.desk.dataDir);
    const parent = path.join(data, "mail");
    if (!lstatMaybe(parent)) { fs.mkdirSync(parent, { mode: 0o700 }); syncDirectory(data); }
    directorySafe(parent);
    const destination = path.join(parent, `project-${digest(project).slice(0, 16)}`);
    if (!lstatMaybe(destination)) { fs.mkdirSync(destination, { mode: 0o700 }); syncDirectory(parent); }
    directorySafe(destination);
    const generated = Array.isArray(this.desk.state.mail_incoming_roots) ? this.desk.state.mail_incoming_roots : [];
    this.desk.state.mail_incoming_roots = [...generated.filter(root => root.project !== project), { project, path: destination }].slice(-LIMITS.roots);
    const root = this._configuredRoots().roots.find(row => row.project === project);
    if (!root) throw fail("MAIL_ROOT", "Incoming mailbox root could not be validated");
    return root;
  }

  diagnostics() {
    const p = this.payload();
    const explicit = Object.prototype.hasOwnProperty.call(this.desk.config, "mail_roots");
    return { mode: explicit ? (Array.isArray(this.desk.config.mail_roots) && this.desk.config.mail_roots.length === 0 ? "disabled" : "configured") : "auto",
      projects: p.roots.map(root => root.project), files: p.files.length,
      errors: p.errors.map(e => ({ code: String(e.code || "MAIL_ERROR").slice(0, 40), project: String(e.project || "").slice(0, 60) })) };
  }

  _root(project) {
    projectName(project);
    const { roots } = this._configuredRoots();
    const root = roots.find((row) => row.project === project);
    if (!root) throw fail("MAIL_ROOT", "No safe configured mailbox root for this project");
    directorySafe(root.path);
    return root;
  }

  /** Resolve beneath a root and optionally create plain directories, never the root. */
  _resolve(root, parts, create = false, internal = false, allowDirectory = false) {
    directorySafe(root.path);
    let current = root.path;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if ((!internal && (!safeSegment(part) || excluded(part))) || part === ".." || part.includes(path.sep)) {
        throw fail("MAIL_PATH", "Unsafe mailbox segment");
      }
      current = path.join(current, part);
      let stat = lstatMaybe(current);
      if (!stat && i < parts.length - 1 && create) {
        try { fs.mkdirSync(current, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
        stat = fs.lstatSync(current);
        syncDirectory(path.dirname(current));
      }
      if (stat?.isSymbolicLink()) throw fail("MAIL_SYMLINK", "Mailbox path contains a symlink or junction");
      if (i < parts.length - 1) {
        if (stat && !stat.isDirectory()) throw fail("MAIL_PATH", "Mailbox parent is not a directory");
        if (!stat && !create) return current + path.sep + parts.slice(i + 1).join(path.sep);
        if (stat) directorySafe(current);
      } else if (stat && !stat.isFile() && !(allowDirectory && stat.isDirectory())) {
        throw fail("MAIL_PATH", "Mailbox destination is not a regular file");
      }
    }
    return current;
  }

  scan() {
    const configured = this._configuredRoots();
    this.roots = configured.roots;
    const errors = [...configured.errors];
    const files = [];
    let entries = 0;
    let stopped = false;
    const old = this.desk.state.mail_index;
    const previous = old && typeof old === "object" && !Array.isArray(old) ? old : {};
    const walk = (root, directory, prefix, depth) => {
      if (stopped) return;
      if (depth >= LIMITS.depth) {
        errors.push({ code: "MAIL_LIMIT", project: root.project, path: prefix, message: "Mailbox nesting limit reached" });
        return;
      }
      let handle;
      const children = [];
      try {
        directorySafe(directory);
        handle = fs.opendirSync(directory);
        let item;
        while ((item = handle.readSync())) {
          if (++entries > LIMITS.entries) {
            stopped = true;
            errors.push({ code: "MAIL_LIMIT", message: "Mailbox entry limit reached" });
            break;
          }
          children.push(item.name);
        }
      } catch (e) {
        errors.push({ code: e.code || "MAIL_SCAN", project: root.project, path: prefix, message: e.message });
        return;
      } finally { if (handle) handle.closeSync(); }
      children.sort();
      for (const name of children) {
        if (files.length >= LIMITS.files) {
          stopped = true;
          errors.push({ code: "MAIL_LIMIT", message: "Mailbox file count limit reached" });
          return;
        }
        if (!safeSegment(name) || excluded(name)) continue;
        const relative = prefix ? `${prefix}/${name}` : name;
        if (relative.length > LIMITS.path) continue;
        try {
          const full = this._resolve(root, relativePath(relative), false, false, true);
          const stat = fs.lstatSync(full);
          if (stat.isSymbolicLink()) throw fail("MAIL_SYMLINK", "Skipped mailbox symlink");
          if (stat.isDirectory()) { walk(root, full, relative, depth + 1); continue; }
          if (!stat.isFile()) continue;
          const hashed = hashFile(full);
          const row = { project: root.project, path: relative, sha256: hashed.sha256, size: hashed.size };
          const prior = previous[keyFor(root.project, relative)];
          if (prior?.sha256 && HEX.test(prior.sha256)) {
            if (prior.sha256 !== row.sha256) row.previous_hash = prior.sha256;
            else if (HEX.test(prior.previous_hash || "")) row.previous_hash = prior.previous_hash;
          }
          files.push(row);
          if (/\.conflict-[a-f0-9]{64}(?:\.|$)/.test(name)) {
            errors.push({ code: "MAIL_CONFLICT", project: root.project, path: relative, message: "Preserved divergent mailbox file" });
          }
        } catch (e) {
          errors.push({ code: e.code || "MAIL_SCAN", project: root.project, path: relative, message: e.message });
        }
      }
    };
    for (const root of this.roots) walk(root, root.path, "", 0);
    files.sort((a, b) => a.project < b.project ? -1 : a.project > b.project ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const next = {};
    for (const file of files) next[keyFor(file.project, file.path)] = file;
    const changed = JSON.stringify(previous) !== JSON.stringify(next);
    this.desk.state.mail_index = next;
    this._scanErrors = errors.slice(0, 100);
    this.errors = [...this._scanErrors, ...this.notices].slice(-100);
    return changed;
  }

  payload() {
    this.scan();
    return { roots: this.roots.map((root) => ({ ...root })), files: this._rows(), errors: this.errors.map((error) => ({ ...error })),
      mode: Object.prototype.hasOwnProperty.call(this.desk.config, "mail_roots") ? (Array.isArray(this.desk.config.mail_roots) && this.desk.config.mail_roots.length === 0 ? "disabled" : "configured") : "auto" };
  }

  _rows() {
    return Object.values(this.desk.state.mail_index || {}).map((row) => ({ ...row }));
  }

  manifest() {
    this.scan();
    return this._rows();
  }

  readChunk({ project, path: relative, sha256, offset } = {}) {
    const parts = relativePath(relative);
    if (typeof sha256 !== "string" || !HEX.test(sha256) || !Number.isSafeInteger(offset) || offset < 0) {
      throw fail("MAIL_CHUNK", "Invalid mailbox hash or offset");
    }
    const root = this._root(project);
    const file = this._resolve(root, parts);
    const hashed = hashFile(file);
    if (hashed.sha256 !== sha256) throw fail("MAIL_CHANGED", "Requested mailbox hash is no longer current");
    if (offset > hashed.size) throw fail("MAIL_CHUNK", "Mailbox offset exceeds file size");
    const { fd, stat } = openRegular(file);
    try {
      if (!sameStat(stat, hashed.stat)) throw fail("MAIL_CHANGED", "Mailbox file changed before chunk read");
      const data = Buffer.alloc(Math.min(LIMITS.chunk, hashed.size - offset));
      let count = 0;
      while (count < data.length) {
        const n = fs.readSync(fd, data, count, data.length - count, offset + count);
        if (!n) throw fail("MAIL_CHANGED", "Mailbox file truncated during chunk read");
        count += n;
      }
      const after = fs.lstatSync(file);
      if (after.isSymbolicLink() || !sameStat(stat, fs.fstatSync(fd)) || !sameStat(stat, after)) {
        throw fail("MAIL_CHANGED", "Mailbox file changed during chunk read");
      }
      return { data: data.toString("base64"), offset, total: hashed.size, sha256, next: offset + count };
    } finally { fs.closeSync(fd); }
  }

  _chunk(peer, chunk) {
    const id = typeof peer === "string" ? peer : peer?.device_id || peer?.id;
    if (typeof id !== "string" || !id || id.length > 120 || /[\x00-\x1f\x7f]/.test(id)) {
      throw fail("MAIL_PEER", "Mailbox peer must have a bounded stable identity");
    }
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) throw fail("MAIL_CHUNK", "Invalid mailbox chunk");
    const { project, path: relative, sha256, previous_hash, offset, total, data } = chunk;
    projectName(project);
    const parts = relativePath(relative);
    if (typeof sha256 !== "string" || !HEX.test(sha256)
      || (previous_hash !== undefined && (typeof previous_hash !== "string" || !HEX.test(previous_hash)))) {
      throw fail("MAIL_CHUNK", "Mailbox hashes must be lowercase SHA-256 values");
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(total) || total < 0 || total > LIMITS.file
      || offset > total || typeof data !== "string" || data.length > Math.ceil(LIMITS.chunk / 3) * 4 || !BASE64.test(data)) {
      throw fail("MAIL_CHUNK", "Invalid mailbox chunk offset, size or base64");
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data || bytes.length > LIMITS.chunk || offset + bytes.length > total
      || (total > 0 && bytes.length === 0)) throw fail("MAIL_CHUNK", "Invalid or non-canonical mailbox chunk");
    return { id, project, relative, parts, sha256, previous_hash, offset, total, bytes };
  }

  _stagingPath(root, c, create) {
    const name = digest(JSON.stringify([c.id, c.project, c.relative, c.sha256, c.previous_hash || null, c.total]));
    return this._resolve(root, [INTERNAL, "chunks", `${name}.part`], create, true);
  }

  _staging(root, c) {
    const file = this._stagingPath(root, c, true);
    const directory = path.dirname(file);
    let handle;
    let count = 0;
    let size = 0;
    try {
      handle = fs.opendirSync(directory);
      let row;
      while ((row = handle.readSync())) {
        if (!/^[a-f0-9]{64}\.part$/.test(row.name)) throw fail("MAIL_STAGING", "Unexpected mailbox staging entry");
        const stat = fs.lstatSync(path.join(directory, row.name));
        if (stat.isSymbolicLink() || !stat.isFile()) throw fail("MAIL_SYMLINK", "Unsafe mailbox staging entry");
        if (++count > LIMITS.transfers || (size += stat.size) > LIMITS.staging) {
          throw fail("MAIL_LIMIT", "Mailbox staging quota reached");
        }
      }
    } finally { if (handle) handle.closeSync(); }
    const existing = lstatMaybe(file);
    if (!existing && (count >= LIMITS.transfers || size + c.bytes.length > LIMITS.staging)) {
      throw fail("MAIL_LIMIT", "Mailbox staging quota reached");
    }
    if (existing && size + Math.max(0, c.offset + c.bytes.length - existing.size) > LIMITS.staging) {
      throw fail("MAIL_LIMIT", "Mailbox staging quota reached");
    }
    return file;
  }

  _capacity() {
    this.scan();
    if (Object.keys(this.desk.state.mail_index).length >= LIMITS.files
      || this._scanErrors.some((error) => error.code === "MAIL_LIMIT" && !error.project)) {
      throw fail("MAIL_LIMIT", "Mailbox file or enumeration capacity reached");
    }
  }

  _backupCapacity(directory, additional) {
    let handle;
    let count = 0;
    let bytes = 0;
    try {
      directorySafe(directory);
      handle = fs.opendirSync(directory);
      let entry;
      while ((entry = handle.readSync())) {
        if (!/^[a-f0-9]{64}-[a-f0-9]{64}\.bak$/.test(entry.name)) throw fail("MAIL_STAGING", "Unexpected mailbox backup entry");
        const stat = fs.lstatSync(path.join(directory, entry.name));
        if (stat.isSymbolicLink() || !stat.isFile()) throw fail("MAIL_SYMLINK", "Unsafe mailbox backup entry");
        if (++count >= LIMITS.backups || (bytes += stat.size) + additional > LIMITS.backupBytes) {
          throw fail("MAIL_LIMIT", "Recoverable mailbox backup quota reached");
        }
      }
    } finally { if (handle) handle.closeSync(); }
    if (additional > LIMITS.backupBytes) throw fail("MAIL_LIMIT", "Mailbox backup exceeds quota");
  }

  _conflict(root, c, stage) {
    const name = c.parts[c.parts.length - 1];
    const extension = path.posix.extname(name).slice(0, 20);
    const base = name.slice(0, name.length - path.posix.extname(name).length).slice(0, 145);
    const conflictName = `${base}.conflict-${c.sha256}${extension}`;
    let parts = [...c.parts.slice(0, -1), conflictName];
    if (parts.join("/").length > LIMITS.path) parts = [`message-${keyFor(c.project, c.relative).slice(0, 16)}.conflict-${c.sha256}${extension}`];
    const relative = parts.join("/");
    const destination = this._resolve(root, parts, true);
    const existing = lstatMaybe(destination);
    if (existing) {
      if (hashFile(destination).sha256 !== c.sha256) throw fail("MAIL_CONFLICT", "Deterministic conflict name already has different content");
    } else {
      this._capacity();
      try { fs.linkSync(stage, destination); } catch (e) {
        if (e.code !== "EEXIST" || hashFile(destination).sha256 !== c.sha256) throw e;
      }
      syncDirectory(path.dirname(destination));
    }
    this._notice({ code: "MAIL_CONFLICT", project: c.project, path: c.relative, conflict_path: relative, message: "Destination changed; both mailbox versions were preserved" });
    return { path: relative, conflict: true };
  }

  _install(root, c, stage) {
    const destination = this._resolve(root, c.parts, true);
    const existing = lstatMaybe(destination);
    if (!existing) {
      this._capacity();
      // A hard link is an atomic no-clobber publication, unlike rename on POSIX.
      try {
        fs.linkSync(stage, destination);
        syncDirectory(path.dirname(destination));
        return { path: c.relative, conflict: false };
      } catch (e) { if (e.code !== "EEXIST") throw e; }
    }
    const current = hashFile(destination);
    if (current.sha256 === c.sha256) return { path: c.relative, conflict: false };
    if (!c.previous_hash || current.sha256 !== c.previous_hash) return this._conflict(root, c, stage);
    const backup = this._resolve(root, [INTERNAL, "backups", `${keyFor(c.project, c.relative)}-${current.sha256}.bak`], true, true);
    if (!lstatMaybe(backup)) {
      this._backupCapacity(path.dirname(backup), current.size);
      // Copy, rather than a hard link: subsequent in-place user edits cannot mutate the backup.
      fs.copyFileSync(destination, backup, fs.constants.COPYFILE_EXCL);
      const opened = openRegular(backup, fs.constants.O_RDWR);
      try { fs.fsyncSync(opened.fd); } finally { fs.closeSync(opened.fd); }
      syncDirectory(path.dirname(backup));
    }
    if (hashFile(backup).sha256 !== current.sha256) throw fail("MAIL_CHANGED", "Mailbox changed while saving its recoverable backup");
    const recheck = hashFile(this._resolve(root, c.parts));
    if (recheck.sha256 !== current.sha256 || !sameStat(current.stat, recheck.stat)) return this._conflict(root, c, stage);
    // Staging is on the same volume; publication is atomic, and the preimage is retained.
    fs.renameSync(stage, destination);
    syncDirectory(path.dirname(destination));
    return { path: c.relative, conflict: false, backup: true };
  }

  acceptChunk(peer, chunk) {
    const c = this._chunk(peer, chunk);
    const root = this._root(c.project);
    const destination = this._resolve(root, c.parts);
    const present = lstatMaybe(destination);
    if (present) {
      const installed = hashFile(destination);
      if (installed.sha256 === c.sha256) {
        if (installed.size !== c.total) throw fail("MAIL_CHUNK", "Transfer total does not match the installed file");
        const opened = openRegular(destination, fs.constants.O_RDWR);
        try {
          if (!sameStat(opened.stat, installed.stat)) throw fail("MAIL_CHANGED", "Installed mailbox file changed before retry verification");
          const bytes = Buffer.alloc(c.bytes.length);
          let count = 0;
          while (count < bytes.length) {
            const n = fs.readSync(opened.fd, bytes, count, bytes.length - count, c.offset + count);
            if (!n) throw fail("MAIL_CHANGED", "Installed mailbox file was truncated during retry");
            count += n;
          }
          if (!bytes.equals(c.bytes)) throw fail("MAIL_DUPLICATE", "Completed mailbox retry has different bytes");
          fs.fsyncSync(opened.fd);
          const after = fs.lstatSync(destination);
          if (after.isSymbolicLink() || !sameStat(opened.stat, fs.fstatSync(opened.fd)) || !sameStat(opened.stat, after)) {
            throw fail("MAIL_CHANGED", "Installed mailbox file changed during retry verification");
          }
        } finally { fs.closeSync(opened.fd); }
        syncDirectory(path.dirname(destination));
        const staleStage = this._stagingPath(root, c, false);
        if (lstatMaybe(staleStage)) {
          fs.unlinkSync(staleStage);
          syncDirectory(path.dirname(staleStage));
        }
        this.scan();
        return { ok: true, complete: true, next: c.total, total: c.total, sha256: c.sha256, path: c.relative, conflict: false };
      }
    }
    const stage = this._staging(root, c);
    let fd;
    try {
      const exists = lstatMaybe(stage);
      if (!exists) {
        if (c.offset !== 0) throw fail("MAIL_ORDER", "First mailbox chunk must start at zero");
        fd = fs.openSync(stage, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0), 0o600);
        syncDirectory(path.dirname(stage));
      } else {
        const opened = openRegular(stage, fs.constants.O_RDWR);
        fd = opened.fd;
      }
      let size = fs.fstatSync(fd).size;
      if (size > c.total) throw fail("MAIL_STAGING", "Mailbox staging size exceeds transfer size");
      if (c.offset > size) throw fail("MAIL_ORDER", "Mailbox chunks must arrive in order");
      if (c.offset < size) {
        if (c.offset + c.bytes.length > size) throw fail("MAIL_ORDER", "Mailbox duplicate chunk overlaps new data");
        const previous = Buffer.alloc(c.bytes.length);
        if (fs.readSync(fd, previous, 0, previous.length, c.offset) !== previous.length || !previous.equals(c.bytes)) {
          throw fail("MAIL_DUPLICATE", "Mailbox duplicate chunk has different bytes");
        }
      } else {
        writeAll(fd, c.bytes, c.offset);
        size += c.bytes.length;
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      if (size < c.total) return { ok: true, complete: false, next: size, total: c.total, sha256: c.sha256 };
      const hashed = hashFile(stage);
      if (hashed.sha256 !== c.sha256 || hashed.size !== c.total) {
        fs.unlinkSync(stage); // Only our private, verified staging path; never a user file.
        syncDirectory(path.dirname(stage));
        throw fail("MAIL_HASH", "Complete mailbox file failed SHA-256 verification");
      }
      const result = this._install(root, c, stage);
      // rename consumed staging for updates; link publication leaves it to remove.
      if (lstatMaybe(stage)) fs.unlinkSync(stage);
      syncDirectory(path.dirname(stage));
      this.scan();
      return { ok: true, complete: true, next: c.total, total: c.total, sha256: c.sha256, ...result };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
}

module.exports = { MailStore, MAIL_LIMITS: LIMITS };
