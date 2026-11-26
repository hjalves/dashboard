/* The moon from MET Norway's sunrise API (via /api/weather): phase angle (0 new, 90 first
   quarter, 180 full, 270 last quarter), % lit, and rise/set times for today and tomorrow. */
import { hhmm } from "./core.js";

const PHASES = ["new", "waxing-crescent", "first-quarter", "waxing-gibbous", "full", "waning-gibbous", "last-quarter", "waning-crescent"];

export function moonInfo(m) {
  if (!m || m.phase == null) return null;
  const phase = PHASES[Math.round(m.phase / 45) % 8];
  const now = Date.now(), events = m.events || [];
  const next = events.find((e) => new Date(e.time).getTime() > now);
  const fmt = (e) => {
    const past = new Date(e.time).getTime() <= now;
    return `${e.kind === "set" ? (past ? "set" : "sets") : (past ? "rose" : "rises")} ${hhmm(e.time)}`;
  };
  return {
    phase,
    name: phase.replace("-", " ") + (phase === "new" || phase === "full" ? " moon" : ""),
    lit: m.lit,
    icon: `/static/icons/moon-${phase}.svg`,
    when: next ? fmt(next) : "",
    tip: [phase.replace("-", " "), `${m.lit}% lit`, ...events.filter((e) => new Date(e.time).getTime() > now - 12 * 3600e3).slice(0, 3).map(fmt)].join(" · "),
  };
}
