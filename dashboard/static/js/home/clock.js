import { $ } from "../core.js";

export function initClock(onResume) {
  let last = Date.now();
  const tick = () => {
    const now = new Date();
    $("hh").textContent = String(now.getHours()).padStart(2, "0");
    $("mm").textContent = String(now.getMinutes()).padStart(2, "0");
    $("date").textContent = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })
      .replace(/^(\w+) (\d+) (\w+)$/, "$1, $3 $2");
    // A big gap between ticks means the machine slept.
    if (Date.now() - last > 2 * 60e3) onResume();
    last = Date.now();
  };
  tick();
  setInterval(tick, 1000);
}
