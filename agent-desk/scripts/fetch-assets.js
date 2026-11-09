#!/usr/bin/env node
"use strict";
// Downloads the Win98 look into web/ (replaces fetch_assets.py): 98.css + fonts -> web/vendor/,
// icons -> web/icons/. Needs internet once; files that are already there are kept.
// Usage: node scripts/fetch-assets.js [--force]
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const WEB = path.join(__dirname, "..", "web");
const VENDOR = path.join(WEB, "vendor");
const ICONS = path.join(WEB, "icons");
const FORCE = process.argv.includes("--force");

const CSS_URL = "https://registry.npmjs.org/98.css/-/98.css-0.1.21.tgz";
const CSS_SHA256 = "bffc701cd55c38688c9eba5bf4cd34f26158f5895904166356cc156742082d74";
const CSS_FILES = ["98.css", "ms_sans_serif.woff", "ms_sans_serif.woff2", "ms_sans_serif_bold.woff", "ms_sans_serif_bold.woff2"];
const ICON_URL = (name) => `https://win98icons.alexmeub.com/icons/png/${name}.png`;
const ICON_NAMES = [
  "application_hourglass-1", "check-0", "check-1", "computer-1", "directory_closed-1", "envelope_closed-0",
  "envelope_closed-1", "envelope_open_sheet-1", "help_book_small-0", "help_book_small-1", "loudspeaker_muted-0",
  "loudspeaker_rays-0", "loudspeaker_rays-1", "msg_error-0", "msg_error-2", "msg_information-0", "msg_question-0",
  "msg_question-2", "msg_warning-0", "msg_warning-2", "network_normal_two_pcs-0", "network_normal_two_pcs-1",
  "notepad-1", "notepad_file-0", "recycle_bin_full-0", "users-0", "world-0", "world-1",
];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function download(url, tries = 4) {
  let last;
  for (let i = 1; i <= tries; i += 1) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      last = e;
      await new Promise((ok) => setTimeout(ok, 1000 * i));
    }
  }
  throw new Error(`${url}: ${last.message}`);
}

/** Minimal ustar reader: {name -> Buffer}. */
function untar(buf) {
  const out = new Map();
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const name = (str(345, 500) ? `${str(345, 500)}/` : "") + str(0, 100);
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    off += 512;
    if (type === "0") out.set(name, buf.subarray(off, off + size));
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, data);
  fs.renameSync(`${file}.tmp`, file);
};
const have = (file) => !FORCE && fs.existsSync(file) && fs.statSync(file).size > 0;

async function css() {
  if (CSS_FILES.every((f) => have(path.join(VENDOR, f)))) return console.log("98.css: уже есть");
  const tgz = await download(CSS_URL);
  const sum = crypto.createHash("sha256").update(tgz).digest("hex");
  if (sum !== CSS_SHA256) throw new Error(`98.css: неверная контрольная сумма ${sum}`);
  const files = untar(zlib.gunzipSync(tgz));
  for (const f of CSS_FILES) {
    const data = files.get(`package/dist/${f}`);
    if (!data) throw new Error(`98.css: в архиве нет ${f}`);
    write(path.join(VENDOR, f), data);
  }
  console.log("98.css: готово");
}

async function icons() {
  const todo = ICON_NAMES.filter((n) => !have(path.join(ICONS, `${n}.png`)));
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const name = todo[i++];
      const data = await download(ICON_URL(name));
      if (!data.subarray(0, 8).equals(PNG)) throw new Error(`${name}: это не PNG`);
      write(path.join(ICONS, `${name}.png`), data);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  console.log(`значки: ${ICON_NAMES.length - todo.length} уже было, ${todo.length} скачано`);
}

(async () => {
  await css();
  await icons();
})().catch((e) => {
  console.error(`Ошибка: ${e.message}`);
  process.exit(1);
});
