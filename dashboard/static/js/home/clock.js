/* Home clock. Right-click it to turn seconds on or off (saved on the server as a preference). */
import { $, getJSON, postJSON } from "../core.js";
import { showBack, hideBack, onRightClick } from "../backs.js";

let seconds = false;

function render(now) {
  $("hh").textContent = String(now.getHours()).padStart(2, "0");
  $("mm").textContent = String(now.getMinutes()).padStart(2, "0");
  $("ss").textContent = seconds ? ":" + String(now.getSeconds()).padStart(2, "0") : "";
  $("date").textContent = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })
    .replace(/^(\w+) (\d+) (\w+)$/, "$1, $3 $2");
}

function setSeconds(on) {
  seconds = on;
  $("clock").classList.toggle("with-seconds", on);
  $("cb-secs").innerHTML = [["off", false], ["on", true]]
    .map(([t, v]) => `<span class="chip${on === v ? " on" : ""}" data-v="${v}">${t}</span>`).join("");
  render(new Date());
}

export function initClock(onResume) {
  let last = Date.now();
  const tick = () => {
    render(new Date());
    // A big gap between ticks means the machine slept.
    if (Date.now() - last > 2 * 60e3) onResume();
    last = Date.now();
  };
  // With seconds on, tick right after each second starts so the display doesn't lag.
  const schedule = () => setTimeout(() => { tick(); schedule(); }, 1000 - (Date.now() % 1000) + 5);
  tick();
  schedule();

  getJSON("/api/prefs").then((p) => setSeconds(!!p.clock_seconds)).catch(() => setSeconds(false));
  onRightClick($("clock"), () => { $("cb-msg").textContent = ""; showBack($("clock")); });
  $("cb-secs").addEventListener("click", async (e) => {
    const c = e.target.closest("[data-v]");
    if (!c) return;
    const on = c.dataset.v === "true";
    try {
      await postJSON("/api/prefs", { clock_seconds: on });
      setSeconds(on);
    } catch (err) {
      $("cb-msg").textContent = "not saved: " + err.message;
    }
  });
  $("cb-done").addEventListener("click", hideBack);
}
