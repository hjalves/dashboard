/* Night scene: a calm, dim screen with the clock and the weather. Right-click it to set an automatic
   schedule (off by default): it switches here at the start hour and back to the previous scene at
   the end hour. Switching away by hand during the night is respected until the next night. */
import { $, esc, getJSON, postJSON, deg, fmtMM, poll, MIN } from "../core.js";
import { showBack, hideBack, onRightClick } from "../backs.js";
import { weatherIcon } from "../icons.js";

let settings = { auto: false, start: 23, end: 7 };
let draft = null;
// Automatic switching: which night we already switched for (or the user left), and where we came from.
const auto = { handledNight: null, returnTo: "home", active: false };

const pad = (n) => String(n).padStart(2, "0");

function tick() {
  const now = new Date();
  $("nt-hh").textContent = pad(now.getHours());
  $("nt-mm").textContent = pad(now.getMinutes());
  $("nt-date").textContent = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })
    .replace(/^(\w+) (\d+) (\w+)$/, "$1, $3 $2").toLowerCase();
}

async function loadWeather() {
  const w = await getJSON("/api/weather");
  const f = w.forecast.data, st = w.station && w.station.data;
  const first = f && f.hourly[0];
  const temp = st ? st.temp : first && first.temp;
  const lohi = st && st.today_low != null ? ` · low ${deg(st.today_low)} high ${deg(st.today_high)}` : "";
  $("nt-now").innerHTML = first || temp != null
    ? `${first ? weatherIcon(first.symbol ?? first.type, first.day) : ""}<span class="nt-temp">${deg(temp)}</span>
       <span class="nt-desc">${esc(first ? first.desc || "" : "")}${lohi}</span>`
    : "";
  const hrs = f ? f.hourly.slice(1, 9) : [];
  $("nt-hours").innerHTML = hrs.map((h) => {
    const rain = h.rain_mm != null ? (h.rain_mm >= 0.2 ? fmtMM(h.rain_mm) + " mm" : "")
      : h.rain_prob >= 30 ? Math.round(h.rain_prob) + "%" : "";
    return `<div class="nh"><div class="nh-h">${pad(new Date(h.time).getHours())}</div>
      ${weatherIcon(h.symbol ?? h.type, h.day)}<div class="nh-t">${deg(h.temp)}</div><div class="nh-r">${rain}</div></div>`;
  }).join("");
  const todayStr = new Date().toLocaleDateString("sv-SE");
  const tm = f && f.daily.find((d) => d.date > todayStr);
  $("nt-tomorrow").textContent = tm
    ? `tomorrow ${deg(tm.max)} / ${deg(tm.min)} · ${(tm.desc || "").toLowerCase()}` +
      (tm.rain_mm != null ? ` · ${fmtMM(tm.rain_mm)} mm` : tm.rain_prob != null ? ` · rain ${Math.round(tm.rain_prob)}%` : "")
    : "";
}

/* A few pixels of drift every minute, so nothing sits on the same pixels all night. */
function drift() {
  const r = () => Math.round((Math.random() * 2 - 1) * 14);
  $("night-inner").style.transform = `translate(${r()}px, ${r()}px)`;
}

/* ---------------------------------------------------------------- schedule */

const inWindow = (h, s) => (s.start < s.end ? h >= s.start && h < s.end : h >= s.start || h < s.end);
/* The night a moment belongs to, named by the date it started on (so 02:00 belongs to yesterday's). */
function nightKey(now, s) {
  const d = new Date(now);
  if (s.start > s.end && now.getHours() < s.end) d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("sv-SE");
}

function checkSchedule(scene, activeScene, goToScene) {
  if (!settings.auto) return;
  const now = new Date(), inside = inWindow(now.getHours(), settings);
  if (inside) {
    const key = nightKey(now, settings);
    if (auto.handledNight !== key) {
      auto.handledNight = key;
      if (activeScene() !== scene) { auto.returnTo = activeScene(); auto.active = true; goToScene(scene); }
    }
  } else if (auto.active) {
    auto.active = false;
    if (activeScene() === scene) goToScene(auto.returnTo);
  }
}

function hourChips(id, hours, value) {
  $(id).innerHTML = hours.map((h) => `<span class="chip${h === value ? " on" : ""}" data-h="${h}">${pad(h)}:00</span>`).join("");
}
function renderBack() {
  $("nb-auto").innerHTML = [["off", false], ["on", true]]
    .map(([t, v]) => `<span class="chip${draft.auto === v ? " on" : ""}" data-auto="${v}">${t}</span>`).join("");
  hourChips("nb-start", [20, 21, 22, 23, 0, 1], draft.start);
  hourChips("nb-end", [5, 6, 7, 8, 9], draft.end);
  document.querySelectorAll("#nb-start .chip, #nb-end .chip").forEach((c) => c.classList.toggle("dim", !draft.auto));
}

export function initNight(scene, activeScene, onSceneChange, goToScene) {
  tick();
  setInterval(() => { if (activeScene() === scene) tick(); }, 1000);
  setInterval(() => { if (activeScene() === scene) drift(); }, MIN);
  poll(loadWeather, 5 * MIN, scene);
  poll(async () => { settings = await getJSON("/api/night"); }, 10 * MIN);
  setInterval(() => checkSchedule(scene, activeScene, goToScene), 20e3);
  // Leaving the night scene by hand ends the automatic stay (no switching back in the morning).
  onSceneChange((name, entering) => { if (name === scene && !entering) auto.active = false; if (entering && name === scene) tick(); });

  onRightClick($("night"), () => {
    draft = { ...settings };
    $("nb-msg").textContent = "";
    renderBack();
    showBack($("night"));
  });
  $("night-back").addEventListener("click", (e) => {
    const c = e.target.closest(".chip");
    if (!c) return;
    if (c.dataset.auto) draft.auto = c.dataset.auto === "true";
    else if (c.parentElement.id === "nb-start") draft.start = +c.dataset.h;
    else if (c.parentElement.id === "nb-end") draft.end = +c.dataset.h;
    renderBack();
  });
  $("nb-cancel").addEventListener("click", hideBack);
  $("nb-save").addEventListener("click", async () => {
    try {
      settings = await postJSON("/api/night", draft);
      // Applying it now counts as "handled" for tonight: no surprise jump if we're already inside.
      if (settings.auto && inWindow(new Date().getHours(), settings)) {
        auto.handledNight = nightKey(new Date(), settings);
        auto.active = activeScene() === scene;
      }
      hideBack();
    } catch (err) {
      $("nb-msg").textContent = "not saved: " + err.message;
    }
  });
}
