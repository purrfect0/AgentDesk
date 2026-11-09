"use strict";
// Win98-style popup of the desktop app (desktop/main.js opens popup.html?id=..&sound=..&volume=..).
const ICON = { forward: "envelope_closed-0", reply: "msg_question-0", blocked: "msg_error-0", limit: "msg_warning-0", done: "check-0", bad: "msg_error-0" };
const q = new URLSearchParams(location.search);
const send = (what) => window.agentDesk?.popup(what);

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

fetch(`/api/alert?id=${encodeURIComponent(q.get("id") || "")}`).then((r) => r.json()).then((a) => {
  if (a.error) return;
  document.getElementById("caption").textContent = `Agent Desk — ${a.project}`;
  document.getElementById("title").textContent = a.title;
  document.getElementById("title").title = a.title;
  document.getElementById("body").textContent = a.body;
  document.getElementById("icon").src = `icons/${ICON[a.kind] || "msg_information-0"}.png`;
}).catch(() => {});

if (q.get("sound") === "1") chime(Number(q.get("volume") ?? 80));

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-do]");
  if (b) send(b.dataset.do);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter") send("open");
  if (e.key === "Escape") send("close");
});
