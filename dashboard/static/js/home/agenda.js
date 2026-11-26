/* Agenda tile: upcoming events from the configured iCal calendars (e.g. Google Calendar), grouped
   by day, as many as fit. All-day events first in each day; an event in progress is bold. */
import { $, esc, getJSON, poll, MIN } from "../core.js";

let data = null;

const dayKey = (d) => d.toLocaleDateString("sv-SE");
function dayName(key) {
  const today = new Date(), tomorrow = new Date(Date.now() + 86400e3);
  if (key === dayKey(today)) return "today";
  if (key === dayKey(tomorrow)) return "tomorrow";
  return new Date(key + "T12:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
}

function render() {
  if (!data) return;
  const now = Date.now(), todayKey = dayKey(new Date());
  const days = new Map();
  for (const e of data.events) {
    // Multi-day all-day events (e.g. a holiday week) show on today if they're still running.
    const key = e.all_day ? (e.start < todayKey && e.end > todayKey ? todayKey : e.start) : dayKey(new Date(e.start));
    if (key < todayKey) continue;
    if (!e.all_day && new Date(e.end).getTime() < now) continue;  // finished today
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(e);
  }
  const html = [...days].map(([key, evs]) => `<div class="ag-day"><div class="ag-dayname">${esc(dayName(key))}</div>${
    evs.map((e) => {
      const running = !e.all_day && new Date(e.start).getTime() <= now && now < new Date(e.end).getTime();
      const time = e.all_day ? "all day" : new Date(e.start).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      return `<div class="ag-ev${running ? " now" : ""}" style="--c:${esc(e.color || "#888")}" title="${esc(e.calendar + (e.location ? " · " + e.location : ""))}">
        <span class="ag-time">${time}</span><span class="ag-title">${esc(e.title)}</span></div>`;
    }).join("")}</div>`).join("");
  $("ag-body").innerHTML = html || `<div class="ag-empty">nothing in the next ${data.days} days</div>`;
}

async function loadAgenda() {
  const r = await getJSON("/api/calendar");
  if (r.data) data = r.data;
  const errs = (r.data && r.data.errors) || [];
  $("ag-note").textContent = !r.ok ? "· offline" : errs.length ? "· " + errs.map((e) => e.split(":")[0]).join(", ") + " unavailable" : "";
  render();
}

export function initAgenda(scene) {
  poll(loadAgenda, 5 * MIN, scene);
  setInterval(render, MIN);  // "now" highlighting and finished events, between fetches
}
