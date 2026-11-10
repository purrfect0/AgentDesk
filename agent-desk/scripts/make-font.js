#!/usr/bin/env node
"use strict";
// Draws the Cyrillic letters and the few signs that the 98.css "Pixelated MS Sans Serif" font lacks,
// on the same 11 px pixel grid, and writes them to web/fonts/:
//   ad-cyrillic.woff, ad-cyrillic-bold.woff  the glyphs (outlines made of whole pixels only)
//   fonts.css                               @font-face rules that add them to the 98.css family
//                                           through unicode-range
// so Russian text is drawn by the same Win98 pixel font as English text (before, it fell back to
// Arial on Windows and Roboto on Android).
//
// A glyph is [TOP, "rows"]: pixel rows separated by "/", "#" is ink. TOP is the row of the first
// line: 8 = top of capitals, 5 = top of lowercase, 0 = the baseline row, -1/-2 = descender.
// A one pixel gap is added on the right, as in the original font. Letters that also exist in Latin
// (А В Е К М Н О Р С Т Х а е о р с у х) are copied pixel for pixel. Bold = regular smeared one pixel
// to the right and one pixel wider: that is exactly how the 98.css bold relates to its regular.
//
// Usage: node scripts/make-font.js           write the files (the output is committed)
//        node scripts/make-font.js --check   fail if the committed files are stale or if the UI
//                                            uses a character that neither font has (CI)

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "web", "fonts");
const UPM = 2048;
const PX = UPM / 11; // one font pixel at font-size 11px
const ASC = 1862, DESC = -412; // vertical metrics of the 98.css font
const DATE = BigInt(Date.UTC(2026, 10, 10) / 1000 + 2082844800); // fixed, so the output is stable
// What the 98.css font itself covers (its cmap).
const W98 = [[0x20, 0x3b], [0x3d, 0x3d], [0x3f, 0x5f], [0x61, 0x7b], [0x7d, 0x7e], [0xa0, 0xa0], [0xad, 0xad],
  [0x2000, 0x200a], [0x2010, 0x2014], [0x2018, 0x2019], [0x201c, 0x201d], [0x202f, 0x202f], [0x205f, 0x205f], [0x25fc, 0x25fc]];

const GLYPHS = {
  // Capitals: 9 rows, from the top (row 8) down to the baseline (row 0).
  "А": [8, "...#.../...#.../..#.#../..#.#../.#...#./.#...#./.#####./#.....#/#.....#"],
  "Б": [8, "#####/#..../#..../#..../####./#...#/#...#/#...#/####."],
  "В": [8, "####./#...#/#...#/#...#/####./#...#/#...#/#...#/####."],
  "Г": [8, "#####/#..../#..../#..../#..../#..../#..../#..../#...."],
  "Д": [8, "..####./..#..#./..#..#./..#..#./.#...#./.#...#./.#...#./#....#./#######/#.....#"],
  "Е": [8, "#####/#..../#..../#..../####./#..../#..../#..../#####"],
  "Ё": [10, ".#.#./...../#####/#..../#..../#..../####./#..../#..../#..../#####"],
  "Ж": [8, "#...#...#/#...#...#/.#..#..#./..#.#.#../...###.../..#.#.#../.#..#..#./#...#...#/#...#...#"],
  "З": [8, ".###./#...#/....#/....#/..##./....#/....#/#...#/.###."],
  "И": [8, "#....#/#...##/#...##/#..#.#/#..#.#/#.#..#/##...#/##...#/#....#"],
  "Й": [10, ".#..#./..##../#....#/#...##/#...##/#..#.#/#..#.#/#.#..#/##...#/##...#/#....#"],
  "К": [8, "#...#./#..#../#.#.../##..../##..../#.#.../#..#../#...#./#....#"],
  "Л": [8, "..####/..#..#/..#..#/..#..#/..#..#/..#..#/.#...#/.#...#/#....#"],
  "М": [8, "#.....#/#.....#/##...##/##...##/#.#.#.#/#.#.#.#/#..#..#/#..#..#/#.....#"],
  "Н": [8, "#....#/#....#/#....#/#....#/######/#....#/#....#/#....#/#....#"],
  "О": [8, ".####./#....#/#....#/#....#/#....#/#....#/#....#/#....#/.####."],
  "П": [8, "######/#....#/#....#/#....#/#....#/#....#/#....#/#....#/#....#"],
  "Р": [8, "#####./#....#/#....#/#....#/#####./#...../#...../#...../#....."],
  "С": [8, ".####./#....#/#...../#...../#...../#...../#...../#....#/.####."],
  "Т": [8, "#####/..#../..#../..#../..#../..#../..#../..#../..#.."],
  "У": [8, "#.....#/#.....#/.#...#./.#...#./..#.#../..#.#../...#.../..#..../##....."],
  "Ф": [8, "...#.../.#####./#..#..#/#..#..#/#..#..#/#..#..#/.#####./...#.../...#..."],
  "Х": [8, "#.....#/#.....#/.#...#./..#.#../...#.../..#.#../.#...#./#.....#/#.....#"],
  "Ц": [8, "#....#./#....#./#....#./#....#./#....#./#....#./#....#./#....#./#######/......#"],
  "Ч": [8, "#....#/#....#/#....#/#...##/.###.#/.....#/.....#/.....#/.....#"],
  "Ш": [8, "#..#..#/#..#..#/#..#..#/#..#..#/#..#..#/#..#..#/#..#..#/#..#..#/#######"],
  "Щ": [8, "#..#..#./#..#..#./#..#..#./#..#..#./#..#..#./#..#..#./#..#..#./#..#..#./########/.......#"],
  "Ъ": [8, "##..../.#..../.#..../.#..../.####./.#...#/.#...#/.#...#/.####."],
  "Ы": [8, "#.....#/#.....#/#.....#/#.....#/####..#/#...#.#/#...#.#/#...#.#/####..#"],
  "Ь": [8, "#..../#..../#..../#..../####./#...#/#...#/#...#/####."],
  "Э": [8, ".####./#....#/.....#/.....#/..####/.....#/.....#/#....#/.####."],
  "Ю": [8, "#..###./#.#...#/#.#...#/#.#...#/###...#/#.#...#/#.#...#/#.#...#/#..###."],
  "Я": [8, ".#####/#....#/#....#/#....#/.#####/..#..#/.#...#/.#...#/#....#"],
  // Lowercase: 6 rows from row 5; ascenders start at row 8, descenders go down to rows -1/-2.
  "а": [5, ".###./....#/.####/#...#/#...#/.####"],
  "б": [8, "..###/.#.../#..../####./#...#/#...#/#...#/#...#/.###."],
  "в": [5, "####./#...#/####./#...#/#...#/####."],
  "г": [5, "####/#.../#.../#.../#.../#..."],
  "д": [5, "..###./..#.#./..#.#./.#..#./.#..#./######/#....#"],
  "е": [5, ".###./#...#/#####/#..../#...#/.###."],
  "ё": [7, ".#.#./...../.###./#...#/#####/#..../#...#/.###."],
  "ж": [5, "#..#..#/.#.#.#./..###../.#.#.#./#..#..#/#..#..#"],
  "з": [5, ".###./#...#/..##./....#/#...#/.###."],
  "и": [5, "#...#/#..##/#.#.#/#.#.#/##..#/#...#"],
  "й": [8, "#...#/.###./...../#...#/#..##/#.#.#/#.#.#/##..#/#...#"],
  "к": [5, "#..#./#.#../##.../#.#../#..#./#...#"],
  "л": [5, "..###/..#.#/..#.#/..#.#/.#..#/#...#"],
  "м": [5, "#...#/##.##/#.#.#/#...#/#...#/#...#"],
  "н": [5, "#...#/#...#/#####/#...#/#...#/#...#"],
  "о": [5, ".###./#...#/#...#/#...#/#...#/.###."],
  "п": [5, "#####/#...#/#...#/#...#/#...#/#...#"],
  "р": [5, "####./#...#/#...#/#...#/#...#/####./#..../#...."],
  "с": [5, ".###./#...#/#..../#..../#...#/.###."],
  "т": [5, "#####/..#../..#../..#../..#../..#.."],
  "у": [5, "#..#/#..#/#..#/#..#/.##./.#../.#../#..."],
  "ф": [8, "..#../..#../..#../.###./#.#.#/#.#.#/#.#.#/#.#.#/.###./..#../..#.."],
  "х": [5, "#..#/#..#/.##./.##./#..#/#..#"],
  "ц": [5, "#...#./#...#./#...#./#...#./#...#./######/.....#"],
  "ч": [5, "#...#/#...#/#..##/.##.#/....#/....#"],
  "ш": [5, "#..#..#/#..#..#/#..#..#/#..#..#/#..#..#/#######"],
  "щ": [5, "#..#..#./#..#..#./#..#..#./#..#..#./#..#..#./########/.......#"],
  "ъ": [5, "##.../.#.../.###./.#..#/.#..#/.###."],
  "ы": [5, "#....#/#....#/###..#/#..#.#/#..#.#/###..#"],
  "ь": [5, "#.../#.../###./#..#/#..#/###."],
  "э": [5, ".###./#...#/..###/....#/#...#/.###."],
  "ю": [5, "#..##./#.#..#/###..#/#.#..#/#.#..#/#..##."],
  "я": [5, ".####/#...#/#...#/.####/.#..#/#...#"],
  // Signs the UI uses (or people type) that 98.css lacks.
  "№": [8, "#...#...../##..#...../##..#..##./#.#.#.#..#/#.#.#.#..#/#..##..##./#..##...../#...#.####/#...#....."],
  "«": [4, ".#..#/#..#./.#..#"],
  "»": [4, "#..#./.#..#/#..#."],
  "…": [0, "#.#.#"],
  "·": [3, ".#"],
  "→": [5, "....#../.....#./#######/.....#./....#.."],
  "←": [5, "..#..../.#...../#######/.#...../..#...."],
  "✓": [6, "......#/.....##/#...###/##.###./#####../.###.../..#...."],
  "<": [7, "...#/..#./.#../#.../.#../..#./...#"],
  ">": [7, "#.../.#../..#./...#/..#./.#../#..."],
  "|": [8, "#/#/#/#/#/#/#/#/#/#/#"],
  "`": [8, "#./.#"],
  "°": [8, ".#./#.#/.#."],
  "×": [5, "#...#/.#.#./..#../.#.#./#...#"],
};

const u = (v) => Math.round(v * PX);

function bitmap([top, rows], bold) {
  let lines = rows.split("/");
  const w = Math.max(...lines.map((l) => l.length));
  lines = lines.map((l) => l.padEnd(w, "."));
  if (!bold) return { top, w, lines };
  const smear = (l) => [...l + "."].map((c, i) => (c === "#" || l[i - 1] === "#" ? "#" : ".")).join("");
  return { top, w: w + 1, lines: lines.map(smear) };
}

// Whole-pixel rectangles: a run of ink that repeats in the next row grows downwards.
function rects(b) {
  const out = [];
  let prev = [];
  b.lines.forEach((line, i) => {
    const y = b.top - i, cur = [];
    for (let x = 0; x < line.length; x++) {
      if (line[x] !== "#") continue;
      let e = x;
      while (line[e] === "#") e++;
      const same = prev.find((r) => r.x0 === x && r.x1 === e);
      if (same) { same.y0 = y; cur.push(same); }
      else { const r = { x0: x, x1: e, y0: y, y1: y + 1 }; out.push(r); cur.push(r); }
      x = e;
    }
    prev = cur;
  });
  return out;
}

// TrueType simple glyph: one clockwise 4-point contour per rectangle, like in the 98.css font.
function encode(rs) {
  if (!rs.length) return null;
  const pts = [];
  for (const r of rs) pts.push([u(r.x0), u(r.y0)], [u(r.x0), u(r.y1)], [u(r.x1), u(r.y1)], [u(r.x1), u(r.y0)]);
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const buf = Buffer.alloc(12 + 2 * rs.length + 5 * pts.length);
  let p = buf.writeInt16BE(rs.length, 0);
  for (const v of box) p = buf.writeInt16BE(v, p);
  rs.forEach((_, i) => { p = buf.writeUInt16BE(4 * i + 3, p); });
  p = buf.writeUInt16BE(0, p); // no instructions
  buf.fill(1, p, p + pts.length); // on-curve points, 16-bit deltas
  p += pts.length;
  let last = 0;
  for (const x of xs) { p = buf.writeInt16BE(x - last, p); last = x; }
  last = 0;
  for (const y of ys) { p = buf.writeInt16BE(y - last, p); last = y; }
  return { buf, box, points: pts.length, contours: rs.length };
}

// Reads an encoded glyph back and fills pixel centres by the non-zero rule, as a rasterizer does.
function verify(ch, g, b) {
  const { buf } = g, nc = buf.readInt16BE(0);
  const ends = Array.from({ length: nc }, (_, i) => buf.readUInt16BE(10 + 2 * i));
  const n = ends[nc - 1] + 1;
  let p = 12 + 2 * nc + n, x = 0, y = 0;
  const pts = [];
  for (let i = 0; i < n; i++, p += 2) pts.push([(x += buf.readInt16BE(p))]);
  for (let i = 0; i < n; i++, p += 2) pts[i].push((y += buf.readInt16BE(p)));
  b.lines.forEach((line, i) => {
    const py = (b.top - i + 0.5) * PX;
    for (let col = 0; col < b.w; col++) {
      const px = (col + 0.5) * PX;
      let wind = 0, start = 0;
      for (const end of ends) {
        for (let k = start; k <= end; k++) {
          const [x0, y0] = pts[k], [x1, y1] = pts[k === end ? start : k + 1];
          const side = (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0);
          if (y0 <= py && y1 > py && side > 0) wind++;
          else if (y0 > py && y1 <= py && side < 0) wind--;
        }
        start = end + 1;
      }
      if ((wind !== 0) !== (line[col] === "#")) throw new Error(`glyph ${ch}: pixel ${col},${b.top - i} is wrong`);
    }
  });
}

class W {
  constructor() { this.parts = []; }
  put(n, fn) { const b = Buffer.alloc(n); fn(b); this.parts.push(b); return this; }
  u16(v) { return this.put(2, (b) => b.writeUInt16BE(v & 0xffff)); }
  i16(v) { return this.put(2, (b) => b.writeInt16BE(v)); }
  u32(v) { return this.put(4, (b) => b.writeUInt32BE(v >>> 0)); }
  u64(v) { return this.put(8, (b) => b.writeBigUInt64BE(v)); }
  raw(b) { this.parts.push(b); return this; }
  get buf() { return Buffer.concat(this.parts); }
}

const pad4 = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
function checksum(b) {
  let s = 0;
  for (let i = 0; i < b.length; i += 4) s = (s + b.readUInt32BE(i)) >>> 0;
  return s;
}

function cmapTable(codes) {
  const segs = [];
  for (const [c, g] of codes) {
    const s = segs[segs.length - 1];
    if (s && c === s.end + 1 && g - c === s.delta) s.end = c;
    else segs.push({ start: c, end: c, delta: g - c });
  }
  segs.push({ start: 0xffff, end: 0xffff, delta: 1 });
  const n = segs.length, range = 2 * 2 ** Math.floor(Math.log2(n));
  const w = new W().u16(0).u16(1).u16(3).u16(1).u32(12) // one record: Windows, Unicode BMP
    .u16(4).u16(16 + 8 * n).u16(0).u16(2 * n).u16(range).u16(Math.log2(range / 2)).u16(2 * n - range);
  for (const s of segs) w.u16(s.end);
  w.u16(0);
  for (const s of segs) w.u16(s.start);
  for (const s of segs) w.u16(s.delta);
  for (let i = 0; i < n; i++) w.u16(0);
  return w.buf;
}

function nameTable(style) {
  const names = {
    0: "Agent Desk - Cyrillic for the 98.css pixel font. MIT License.",
    1: "AD Pixel Cyrillic", 2: style, 3: `AD Pixel Cyrillic ${style} 1.0`,
    4: `AD Pixel Cyrillic ${style}`, 5: "Version 1.0", 6: `ADPixelCyrillic-${style}`,
  };
  const ids = Object.keys(names).map(Number);
  const strs = ids.map((id) => Buffer.from(names[id], "utf16le").swap16());
  const w = new W().u16(0).u16(ids.length).u16(6 + 12 * ids.length);
  let off = 0;
  ids.forEach((id, i) => { w.u16(3).u16(1).u16(0x409).u16(id).u16(strs[i].length).u16(off); off += strs[i].length; });
  return w.raw(Buffer.concat(strs)).buf;
}

function sfnt(tables) {
  const tags = Object.keys(tables).sort();
  const es = 2 ** Math.floor(Math.log2(tags.length));
  const dir = new W().u32(0x10000).u16(tags.length).u16(es * 16).u16(Math.log2(es)).u16(tags.length * 16 - es * 16);
  let off = 12 + 16 * tags.length;
  const body = [];
  for (const tag of tags) {
    const data = tables[tag];
    dir.raw(Buffer.from(tag, "latin1")).u32(checksum(pad4(data))).u32(off).u32(data.length);
    body.push(pad4(data));
    off += pad4(data).length;
  }
  const font = Buffer.concat([dir.buf, ...body]);
  const headAt = font.readUInt32BE(12 + 16 * tags.indexOf("head") + 8);
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headAt + 8);
  return font;
}

function woff(font) {
  const n = font.readUInt16BE(4);
  const dir = new W(), body = [];
  let off = 44 + 20 * n;
  for (let i = 0; i < n; i++) {
    const p = 12 + 16 * i, at = font.readUInt32BE(p + 8), len = font.readUInt32BE(p + 12);
    const data = font.subarray(at, at + len), z = zlib.deflateSync(data, { level: 9 });
    const use = z.length < data.length ? z : data;
    dir.raw(font.subarray(p, p + 4)).u32(off).u32(use.length).u32(len).u32(font.readUInt32BE(p + 4));
    body.push(pad4(use));
    off += pad4(use).length;
  }
  const head = new W().raw(Buffer.from("wOFF", "latin1")).u32(0x10000).u32(off).u16(n).u16(0).u32(font.length)
    .u16(1).u16(0).u32(0).u32(0).u32(0).u32(0).u32(0);
  return Buffer.concat([head.buf, dir.buf, ...body]);
}

const CHARS = Object.keys(GLYPHS).sort((a, b) => a.codePointAt(0) - b.codePointAt(0));

function build(bold) {
  const glyphs = [{ ch: ".notdef", b: { top: 0, w: 5, lines: [] } }, ...CHARS.map((ch) => ({ ch, b: bitmap(GLYPHS[ch], bold) }))];
  const glyf = [], loca = new W(), hmtx = new W();
  let off = 0, maxPoints = 0, maxContours = 0, advMax = 0, minLsb = 0, minRsb = 0, extent = 0, sum = 0;
  const box = [0, 0, 0, 0];
  for (const { ch, b } of glyphs) {
    const g = encode(rects(b)), adv = u(b.w + 1);
    loca.u32(off);
    hmtx.u16(adv).i16(g ? g.box[0] : 0);
    advMax = Math.max(advMax, adv);
    sum += adv;
    if (!g) continue;
    verify(ch, g, b);
    glyf.push(pad4(g.buf));
    off += pad4(g.buf).length;
    maxPoints = Math.max(maxPoints, g.points);
    maxContours = Math.max(maxContours, g.contours);
    minLsb = Math.min(minLsb, g.box[0]);
    minRsb = Math.min(minRsb, adv - g.box[2]);
    extent = Math.max(extent, g.box[2]);
    for (let i = 0; i < 4; i++) box[i] = (i < 2 ? Math.min : Math.max)(box[i], g.box[i]);
  }
  loca.u32(off);
  const n = glyphs.length, style = bold ? "Bold" : "Regular";
  const codes = CHARS.map((ch, i) => [ch.codePointAt(0), i + 1]);
  const tables = {
    head: new W().u32(0x10000).u32(0x10000).u32(0).u32(0x5f0f3cf5).u16(0x000b).u16(UPM).u64(DATE).u64(DATE)
      .i16(box[0]).i16(box[1]).i16(box[2]).i16(box[3]).u16(bold ? 1 : 0).u16(8).i16(2).i16(1).i16(0).buf,
    hhea: new W().u32(0x10000).i16(ASC).i16(DESC).i16(0).u16(advMax).i16(minLsb).i16(minRsb).i16(extent)
      .i16(1).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).u16(n).buf,
    maxp: new W().u32(0x10000).u16(n).u16(maxPoints).u16(maxContours).u16(0).u16(0).u16(2)
      .u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).buf,
    "OS/2": new W().u16(4).i16(Math.round(sum / n)).u16(bold ? 700 : 400).u16(5).u16(0)
      .i16(1331).i16(1229).i16(0).i16(287).i16(1331).i16(1229).i16(0).i16(942).i16(u(1)).i16(u(4)).i16(0)
      .raw(Buffer.alloc(10))
      .u32((1 << 0) | (1 << 1) | (1 << 9) | (1 << 31)).u32((1 << 3) | (1 << 5)).u32(1 << 29).u32(0) // Latin, Cyrillic, punctuation, №, arrows, ✓
      .raw(Buffer.from("NONE", "latin1")).u16(bold ? 0x20 : 0x40).u16(codes[0][0]).u16(codes[codes.length - 1][0])
      .i16(1638).i16(-410).i16(0).u16(ASC).u16(-DESC).u32(0b101).u32(0) // code pages 1252, 1251
      .i16(u(6)).i16(u(9)).u16(0).u16(32).u16(0).buf,
    hmtx: hmtx.buf,
    cmap: cmapTable(codes),
    loca: loca.buf,
    glyf: Buffer.concat(glyf),
    name: nameTable(style),
    post: new W().u32(0x30000).u32(0).i16(-u(1.5)).i16(u(1)).u32(0).u32(0).u32(0).u32(0).u32(0).buf,
  };
  return woff(sfnt(tables));
}

const hex = (c) => c.toString(16).toUpperCase().padStart(4, "0");
function unicodeRange(codes) {
  const out = [];
  for (const c of codes) {
    const r = out[out.length - 1];
    if (r && r[1] === c - 1) r[1] = c;
    else out.push([c, c]);
  }
  return out.map(([a, b]) => `U+${hex(a)}${a === b ? "" : `-${hex(b)}`}`).join(", ");
}

const range = unicodeRange(CHARS.map((ch) => ch.codePointAt(0)));
const face = (weight, file) => `@font-face {
  font-family: "Pixelated MS Sans Serif";
  font-style: normal;
  font-weight: ${weight};
  src: url(${file}) format("woff");
  unicode-range: ${range};
}
`;
const CSS = `/* Generated by scripts/make-font.js - do not edit by hand.
   Cyrillic and a few signs that the 98.css pixel font lacks, drawn on its 11 px grid. Load this file
   after 98.css: for these characters the browser then takes these faces, Latin stays with 98.css. */
${face(400, "ad-cyrillic.woff")}${face(700, "ad-cyrillic-bold.woff")}`;

const files = { "ad-cyrillic.woff": build(false), "ad-cyrillic-bold.woff": build(true), "fonts.css": Buffer.from(CSS) };
const check = process.argv.includes("--check");
let failed = false;
for (const [name, data] of Object.entries(files)) {
  const file = path.join(OUT, name);
  const same = fs.existsSync(file) && fs.readFileSync(file).equals(data);
  if (check) {
    if (!same) { console.error(`web/fonts/${name} is stale: run node scripts/make-font.js`); failed = true; }
  } else if (!same) {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(file, data);
  }
  if (!check) console.log(`${same ? "unchanged" : "wrote"} web/fonts/${name} (${data.length} B)`);
}
if (check) {
  // Every character of the UI texts must be in one of the two fonts, or it is drawn by a fallback font.
  const has = (c) => GLYPHS[String.fromCodePoint(c)] || W98.some(([a, b]) => c >= a && c <= b);
  for (const f of ["app.js", "popup.js", "index.html", "popup.html", "host.js"]) {
    const text = fs.readFileSync(path.join(ROOT, "web", f), "utf8");
    const missing = [...new Set([...text].filter((ch) => ch.codePointAt(0) > 0x7e && !has(ch.codePointAt(0))))];
    if (missing.length) { console.error(`web/${f} uses characters the pixel fonts lack: ${missing.join(" ")}`); failed = true; }
  }
  if (failed) process.exit(1);
  console.log(`fonts are up to date: ${CHARS.length} glyphs (${range})`);
}
