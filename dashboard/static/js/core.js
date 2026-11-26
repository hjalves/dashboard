/* Shared helpers, scene-aware polling. */

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const MIN = 60e3;

export async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(url + ": HTTP " + r.status);
  return r.json();
}

/* POST with the X-Dashboard header the server requires for changes (CSRF guard). */
export async function postJSON(url, body) {
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Dashboard": "1" }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
  return j;
}

export function ago(t) {
  const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : d + " days ago";
}
export const hhmm = (t) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
export const deg = (v) => (v == null ? "--" : Math.round(v)) + "°";
export const fmtMM = (v) => (v === 0 ? "0" : v >= 10 ? String(Math.round(v)) : v.toFixed(1));

/* Live-tile swap: whatever is there slides up and out, the new content slides in from below.
   Every older child goes, even if several swaps overlap (fast clicks). */
export function swapIn(container, cls, html) {
  for (const old of [...container.children]) {
    if (old.classList.contains("leave")) continue;
    old.classList.add("leave");
    setTimeout(() => old.remove(), 700);
  }
  const el = document.createElement("div");
  el.className = cls + " enter";
  el.innerHTML = html;
  container.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("enter")));
  return el;
}

/* poll(fn, every, scene): runs fn every `every` ms while its scene is on screen (always, without a
   scene), and straight away when the scene comes back if it missed a run. */
const pollers = [];
export function poll(fn, every, scene) {
  const p = { fn, every, scene, last: 0 };
  p.run = () => { p.last = Date.now(); return fn().catch((e) => console.warn(e)); };
  pollers.push(p);
  return p;
}
export function startPolling(activeScene) {
  setInterval(() => {
    const now = Date.now(), active = activeScene();
    for (const p of pollers) if ((!p.scene || p.scene === active) && now - p.last >= p.every) p.run();
  }, 1000);
}
export const refreshAll = (scene) => pollers.forEach((p) => { if (!p.scene || p.scene === scene) p.run(); });
export const catchUp = (scene) => pollers.forEach((p) => { if (p.scene === scene && Date.now() - p.last >= p.every) p.run(); });
