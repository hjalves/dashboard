/* Agenda tile: upcoming events from the configured iCal calendars (e.g. Google Calendar), grouped
   by day, as many as fit. All-day events first in each day; an event in progress is bold. */
import { $, esc, getJSON, postJSON, poll, MIN } from "../core.js";
import { showBack, hideBack, onRightClick } from "../backs.js";

let data = null;
let calendars = [];  // [{name, color, hidden}]
let draft = [];      // names hidden, while the tile is turned over

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
  // Tasks: overdue and due today go first on today; future ones on their day; undated in a "to do"
  // group right after today.
  const undated = [];
  for (const t of data.tasks || []) {
    const due = t.due && (t.due < todayKey ? todayKey : t.due);
    const item = { ...t, task: true, overdue: !!t.due && t.due < todayKey, all_day: true, start: due };
    if (!due) { undated.push(item); continue; }
    if (!days.has(due)) days.set(due, []);
    days.get(due).unshift(item);
  }
  // Within a day: overdue tasks, tasks due that day, all-day events, then timed events by start.
  const rank = (e) => (e.overdue ? 0 : e.task ? 1 : e.all_day ? 2 : 3);
  for (const evs of days.values()) evs.sort((a, b) => rank(a) - rank(b) || (rank(a) === 3 ? (a.start < b.start ? -1 : 1) : 0));
  const groups = [...days].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (undated.length) {
    const at = groups.length && groups[0][0] === todayKey ? 1 : 0;
    groups.splice(at, 0, ["to do", undated]);
  }
  const html = groups.map(([key, evs]) => `<div class="ag-day"><div class="ag-dayname">${esc(key === "to do" ? key : dayName(key))}</div>${
    evs.map((e) => {
      if (e.task) {
        return `<div class="ag-ev task${e.overdue ? " overdue" : ""}" style="--c:${esc(e.color || "#888")}" title="${esc(e.list + (e.notes ? " · " + e.notes : ""))}">
          <span class="ag-time">${e.overdue ? "overdue" : "task"}</span><span class="ag-title">${esc(e.title)}</span></div>`;
      }
      const running = !e.all_day && new Date(e.start).getTime() <= now && now < new Date(e.end).getTime();
      const time = e.all_day ? "all day" : new Date(e.start).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      return `<div class="ag-ev${running ? " now" : ""}" style="--c:${esc(e.color || "#888")}" title="${esc(e.calendar + (e.location ? " · " + e.location : ""))}">
        <span class="ag-time">${time}</span><span class="ag-title">${esc(e.title)}</span></div>`;
    }).join("")}</div>`).join("");
  $("ag-body").innerHTML = html || `<div class="ag-empty">nothing in the next ${data.days} days</div>`;
}

async function loadAgenda() {
  applyAgenda(await getJSON("/api/calendar"));
}

function applyAgenda(r) {
  if (r.data) data = r.data;
  calendars = r.calendars || [];
  const errs = (r.data && r.data.errors) || [];
  $("ag-note").textContent = !r.ok ? "· offline" : errs.length ? "· " + errs.map((e) => e.split(":")[0]).join(", ") + " unavailable" : "";
  render();
}

/* Back of the tile: click a calendar to show or hide it; save applies, cancel discards. */
function renderBack() {
  $("ag-cals").innerHTML = calendars.map((c) => `<span class="ag-cal${draft.includes(c.name) ? "" : " on"}"
    data-name="${esc(c.name)}" style="--c:${esc(c.color || "#888")}">${esc(c.name)}</span>`).join("");
  $("ag-save").disabled = false;
}

export function initAgenda(scene) {
  onRightClick($("agenda"), () => {
    draft = calendars.filter((c) => c.hidden).map((c) => c.name);
    $("ag-msg").textContent = draft.length ? `${draft.length} hidden` : "";
    renderBack();
    showBack($("agenda"));
  });
  $("ag-cals").addEventListener("click", (e) => {
    const c = e.target.closest("[data-name]");
    if (!c) return;
    const n = c.dataset.name;
    draft = draft.includes(n) ? draft.filter((x) => x !== n) : [...draft, n];
    $("ag-msg").textContent = draft.length ? `${draft.length} hidden` : "";
    renderBack();
  });
  $("ag-cancel").addEventListener("click", hideBack);
  $("ag-save").addEventListener("click", async () => {
    $("ag-save").disabled = true;
    try {
      applyAgenda(await postJSON("/api/calendar/visible", { hidden: draft }));
      hideBack();
    } catch (err) {
      $("ag-msg").textContent = "not saved: " + err.message;
      $("ag-save").disabled = false;
    }
  });
  poll(loadAgenda, 5 * MIN, scene);
  setInterval(render, MIN);  // "now" highlighting and finished events, between fetches
}
