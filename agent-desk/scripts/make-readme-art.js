#!/usr/bin/env node
"use strict";
// Draws the Windows 98 pictures of the GitHub page (README.md in the repository root):
// a window header, download buttons and section title bars. SVG with the MS Sans Serif font
// and the app icons embedded, so GitHub shows them exactly as drawn.
// Needs web/vendor and web/icons (npm run assets). Output: ../.github/readme/*.svg
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "..", ".github", "readme");
const b64 = (file) => fs.readFileSync(path.join(ROOT, "web", file)).toString("base64");
const icon = (name) => `data:image/png;base64,${b64(`icons/${name}.png`)}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Cyrillic and a few signs: the pixel faces of the app (web/fonts/fonts.css, scripts/make-font.js).
const CYR = fs.readFileSync(path.join(ROOT, "web", "fonts", "fonts.css"), "utf8").split("unicode-range:")[1].split(";")[0].trim();
const VERSION = require(path.join(ROOT, "package.json")).version.split(".").slice(0, 2).join(".");
const FONT = `<style>@font-face{font-family:W98;src:url(data:font/woff2;base64,${b64("vendor/ms_sans_serif.woff2")}) format("woff2")}
@font-face{font-family:W98;font-weight:bold;src:url(data:font/woff2;base64,${b64("vendor/ms_sans_serif_bold.woff2")}) format("woff2")}
@font-face{font-family:W98;unicode-range:${CYR};src:url(data:font/woff;base64,${b64("fonts/ad-cyrillic.woff")}) format("woff")}
@font-face{font-family:W98;font-weight:bold;unicode-range:${CYR};src:url(data:font/woff;base64,${b64("fonts/ad-cyrillic-bold.woff")}) format("woff")}
text{font-family:W98,Tahoma,"MS Sans Serif",sans-serif;font-size:11px}</style>`;
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${FONT}${body}</svg>\n`;
const img = (href, x, y, size) => `<image href="${href}" x="${x}" y="${y}" width="${size}" height="${size}" style="image-rendering:pixelated"/>`;

// Raised Win98 frame (window or button): white/light top-left, grey/black bottom-right.
function raised(x, y, w, h) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#0a0a0a"/>
<rect x="${x}" y="${y}" width="${w - 1}" height="${h - 1}" fill="#dfdfdf"/>
<rect x="${x + 1}" y="${y + 1}" width="${w - 2}" height="${h - 2}" fill="#808080"/>
<rect x="${x + 1}" y="${y + 1}" width="${w - 3}" height="${h - 3}" fill="#fff"/>
<rect x="${x + 2}" y="${y + 2}" width="${w - 4}" height="${h - 4}" fill="#c0c0c0"/>`;
}

function titleBar(x, y, w, text, ico, id) {
  const btn = (bx, glyph) => `${raised(bx, y + 2, 16, 14)}${glyph}`;
  const r = x + w;
  return `<defs><linearGradient id="${id}" x1="0" x2="1"><stop offset="0" stop-color="#000080"/><stop offset="1" stop-color="#1084d0"/></linearGradient></defs>
<rect x="${x}" y="${y}" width="${w}" height="18" fill="url(#${id})"/>
${img(ico, x + 3, y + 1, 16)}
<text x="${x + 23}" y="${y + 13}" fill="#fff" font-weight="bold">${esc(text)}</text>
${btn(r - 54, `<rect x="${r - 50}" y="${y + 11}" width="6" height="2" fill="#000"/>`)}
${btn(r - 38, `<rect x="${r - 35}" y="${y + 5}" width="9" height="8" fill="none" stroke="#000"/><rect x="${r - 35}" y="${y + 5}" width="9" height="2" fill="#000"/>`)}
${btn(r - 20, `<path d="M${r - 16} ${y + 6}l7 7M${r - 9} ${y + 6}l-7 7" stroke="#000" stroke-width="1.6" shape-rendering="auto"/>`)}`;
}

function header() {
  const W = 840;
  const H = 128;
  return svg(W, H, `${raised(0, 0, W, H)}
${titleBar(3, 3, W - 6, "Agent Desk", icon("network_normal_two_pcs-1"), "tb")}
${img(icon("network_normal_two_pcs-0"), 20, 40, 64)}
<text x="104" y="58" font-weight="bold" style="font-size:22px">Agent Desk ${VERSION}</text>
<text x="104" y="80" style="font-size:13px">Табло ИИ-агентов: кто работает, кто ждёт ответа и что нужно переслать.</text>
<text x="104" y="100" style="font-size:13px" fill="#404040">Windows (.exe) · Android (.apk) · ПК, ноутбук и телефон в одной Wi-Fi сети · MIT</text>
<rect x="6" y="${H - 22}" width="${W - 12}" height="16" fill="#808080"/><rect x="7" y="${H - 21}" width="${W - 13}" height="15" fill="#fff"/><rect x="7" y="${H - 21}" width="${W - 14}" height="14" fill="#c0c0c0"/>
<text x="12" y="${H - 10}">Готово</text>`);
}

function button(text, ico) {
  const W = 300;
  const H = 40;
  return svg(W, H, `${raised(0, 0, W, H)}<rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#000"/>
${img(icon(ico), 12, 4, 32)}
<text x="54" y="25" font-weight="bold" style="font-size:13px">${esc(text)}</text>`);
}

function bar(text, ico, id) {
  return svg(840, 24, `${raised(0, 0, 840, 24)}${titleBar(3, 3, 834, text, icon(ico), id)}`);
}

fs.mkdirSync(OUT, { recursive: true });
const files = {
  "header.svg": header(),
  "download-windows.svg": button("Скачать для Windows (.exe)", "computer-1"),
  "download-android.svg": button("Скачать для Android (.apk)", "world-0"),
  "bar-about.svg": bar("Что это", "help_book_small-1", "b1"),
  "bar-features.svg": bar("Возможности", "notepad-1", "b2"),
  "bar-install.svg": bar("Установка", "directory_closed-1", "b3"),
  "bar-phone.svg": bar("Подключение телефона", "world-1", "b4"),
  "bar-agents.svg": bar("Агентам", "users-0", "b5"),
  "bar-build.svg": bar("Сборка", "application_hourglass-1", "b6"),
  "bar-look.svg": bar("Как это выглядит", "computer-1", "b7"),
  "bar-link.svg": bar("Связь ПК и ноутбука", "network_normal_two_pcs-1", "b8"),
  "bar-notify.svg": bar("Уведомления на телефоне", "envelope_closed-1", "b9"),
  "bar-new.svg": bar(`Что нового в ${VERSION}`, "check-1", "b10"),
};
for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), content);
console.log(`readme art: ${Object.keys(files).length} files in ${OUT}`);
