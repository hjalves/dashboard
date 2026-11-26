/* Weather "now" tile and the forecast tile (next hours + two days); right-click either to pick
   the forecast source. */
import { $, esc, getJSON, postJSON, ago, hhmm, deg, fmtMM, poll, MIN } from "../core.js";
import { showBack, hideBack, onRightClick } from "../backs.js";
import { weatherIcon } from "../icons.js";

let forecast = null;
let useStation = true;  // preference: the router's weather station for "now", or the forecast
let step = 1;  // hours per chart column: 1 or 3 (preference, chosen on the tiles' back)

const isWet = (h) => (h.rain_mm !== undefined ? h.rain_mm > 0 : h.rain_prob >= 30);
const wetness = (h) => (h.rain_mm !== undefined ? h.rain_mm || 0 : h.rain_prob || 0);

/* Three-hour periods aligned to the clock (00, 03, 06 …), built from the hourly forecast:
   average temperature, total rain (mm) or the highest chance, the wettest hour's symbol if any
   rain is expected (else the middle hour's), and day/night from the middle hour. */
function threeHourly(hourly) {
  const groups = new Map();
  for (const h of hourly) {
    const t = new Date(h.time);
    const start = new Date(t);
    start.setHours(t.getHours() - (t.getHours() % 3), 0, 0, 0);
    const key = start.getTime();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h);
  }
  return [...groups.entries()].map(([key, hs]) => {
    const mid = hs[Math.floor(hs.length / 2)];
    const wet = hs.filter(isWet);
    const rep = wet.length ? wet.reduce((a, b) => (wetness(b) > wetness(a) ? b : a)) : mid;
    const temps = hs.map((h) => h.temp).filter((v) => v != null);
    const mm = hs.map((h) => h.rain_mm).filter((v) => v != null);
    const probs = hs.map((h) => h.rain_prob).filter((v) => v != null);
    const g = {
      time: new Date(key).toISOString(), span: 3,
      temp: temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null,
      symbol: rep.symbol, type: rep.type, desc: rep.desc, day: mid.day,
      wind_kmh: Math.max(...hs.map((h) => h.wind_kmh ?? 0)),
    };
    if (hs[0].rain_mm !== undefined) g.rain_mm = mm.length ? Math.round(mm.reduce((a, b) => a + b, 0) * 10) / 10 : null;
    else g.rain_prob = probs.length ? Math.max(...probs) : null;
    return g;
  });
}

export async function loadWeather() {
  const w = await getJSON("/api/weather");
  const f = w.forecast.data, st = w.station_enabled !== false && w.station && w.station.data;
  $("w-src").textContent = st ? "· station" : "· forecast";
  forecast = f;
  const first = f && f.hourly[0];
  const today = f && f.daily.find((d) => d.date === new Date().toLocaleDateString("sv-SE"));

  $("w-temp").textContent = deg(st ? st.temp : first && first.temp);
  $("w-desc").textContent = first ? first.desc || "" : "";
  $("w-icon").innerHTML = first ? weatherIcon(first.symbol ?? first.type, first.day) : "";
  const hi = st && st.today_high != null ? st.today_high : today && today.max;
  const lo = st && st.today_low != null ? st.today_low : today && today.min;
  const hilo = [];
  if (lo != null) hilo.push(`low ${deg(lo)}`);
  if (hi != null) hilo.push(`high ${deg(hi)}`);
  if (f) {
    const now = Date.now(), rise = new Date(f.sunrise), set = new Date(f.sunset);
    hilo.push(now < set && now > rise ? `sunset ${hhmm(set)}` : `sunrise ${hhmm(nextSunrise(rise))}`);
  }
  $("w-hilo").textContent = hilo.join(" · ");

  const facts = [];
  if (st) {
    if (st.hum != null) facts.push(`<span>humidity <b>${st.hum}%</b></span>`);
    if (st.wind_kmh != null) facts.push(`<span>wind <b>${Math.round(st.wind_kmh)}</b> km/h</span>`);
    if (st.today_rain) facts.push(`<span>rain <b>${st.today_rain}</b> mm</span>`);
    if (st.press != null) {
      // Barometer tendency over 3 h: ±1 hPa or more counts as rising/falling.
      const d = st.press_3h, arrow = d == null ? "" : d >= 1 ? " ↗" : d <= -1 ? " ↘" : " →";
      const tip = d == null ? "" : ` title="${d > 0 ? "+" : ""}${d} hPa in 3 h"`;
      facts.push(`<span${tip}><b>${Math.round(st.press)}</b> hPa${arrow}</span>`);
    }
    // The console's own sensor, indoors: fixed slot before UV (which hides at night).
    if (st.temp_in != null) facts.push(`<span>inside <b>${deg(st.temp_in)}</b>${st.hum_in != null ? ` · <b>${st.hum_in}%</b>` : ""}</span>`);
    if (st.uv != null && f && isDaytime(f)) facts.push(`<span>UV <b>${st.uv}</b></span>`);
    else if (f && w.moon) facts.push(moonFact(w.moon));
  } else if (first) {
    // Station off: the forecast's current hour.
    if (first.hum != null) facts.push(`<span>humidity <b>${Math.round(first.hum)}%</b></span>`);
    if (first.wind_kmh != null) facts.push(`<span>wind <b>${Math.round(first.wind_kmh)}</b> km/h</span>`);
    if (first.rain_mm) facts.push(`<span>rain this hour <b>${fmtMM(first.rain_mm)}</b> mm</span>`);
    else if (first.rain_prob >= 30) facts.push(`<span>rain chance <b>${Math.round(first.rain_prob)}%</b></span>`);
    if (!isDaytime(f) && w.moon) facts.push(moonFact(w.moon));
  }
  $("w-facts").innerHTML = facts.join("");

  const stationAge = st ? (Date.now() / 1000 - st.time) : null;
  $("w-stale").textContent = !w.forecast.ok ? "forecast offline"
    : !useStation ? ""
    : stationAge != null && stationAge > 900 ? "station " + ago(st.time * 1000)
    : w.station && !w.station.ok ? "station offline" : "";
  $("w-where").textContent = f && f.location ? "· " + f.location : "";
  const mm = f && f.source === "metno";
  $("w-key").textContent = mm ? "rain, mm" : "rain chance";
  $("w-credit").textContent = f && f.credit ? "data: " + f.credit : "";
  renderDays(f);
  drawChart();
}

/* Tomorrow and the day after. */
function renderDays(f) {
  const todayStr = new Date().toLocaleDateString("sv-SE");
  const days = f ? f.daily.filter((d) => d.date > todayStr).slice(0, 2) : [];
  $("w-days").innerHTML = days.map((d) => {
    const name = new Date(d.date + "T12:00").toLocaleDateString("en-GB", { weekday: "long" }).toLowerCase();
    return `<div class="day"><div class="label">${name}</div>${weatherIcon(d.symbol ?? d.type, true)}
      <div class="hi">${deg(d.max)}<span class="lo">${deg(d.min)}</span></div>
      <div class="ddesc">${esc(d.desc || "")}</div>
      <div class="drain">rain <b>${d.rain_mm != null ? fmtMM(d.rain_mm) + " mm" : d.rain_prob != null ? Math.round(d.rain_prob) + "%" : "--"}</b></div></div>`;
  }).join("");
}

/* The moon at night (MET Norway): phase icon, how much is lit, and when it sets if it's up, or
   when it rises if not. Phase angle: 0 new, 90 first quarter, 180 full, 270 last quarter. */
const MOON_PHASES = ["new", "waxing-crescent", "first-quarter", "waxing-gibbous", "full", "waning-gibbous", "last-quarter", "waning-crescent"];
function moonFact(m) {
  if (m.phase == null) return "";
  const phase = MOON_PHASES[Math.round(m.phase / 45) % 8];
  const now = Date.now(), next = (m.events || []).find((e) => new Date(e.time).getTime() > now);
  const when = next ? `${next.kind === "set" ? "sets" : "rises"} ${hhmm(next.time)}` : "";
  const tip = `${phase.replace("-", " ")} · ${m.lit}% lit` + (m.events || []).filter((e) => new Date(e.time).getTime() > now - 12 * 3600e3)
    .slice(0, 3).map((e) => ` · ${e.kind === "set" ? "sets" : "rises"} ${hhmm(e.time)}`).join("");
  return `<span class="moon" title="${esc(tip)}"><i class="wi" style="--icon:url(/static/icons/moon-${phase}.svg)"></i>` +
    `<b>${m.lit}%</b>${when ? " · " + when : ""}</span>`;
}

function isDaytime(f) {
  const now = Date.now();
  return now > new Date(f.sunrise) && now < new Date(f.sunset);
}

function nextSunrise(rise) {
  return Date.now() > rise ? new Date(rise.getTime() + 86400e3) : rise;
}

export function drawChart() {
  const svg = $("w-chart");
  if (!forecast || !svg.clientWidth) return;
  const W = svg.clientWidth, H = svg.clientHeight;
  const series = step === 3 ? threeHourly(forecast.hourly) : forecast.hourly;
  const n = Math.max(4, Math.min(series.length, Math.floor(W / 62)));
  const hrs = series.slice(0, n);
  const col = W / n;
  const x = (i) => col * i + col / 2;

  // Bands, top to bottom: temperature labels + line, weather icons, rain bars, hour labels.
  const hourY = H - 2, rainBot = H - 24, barMax = 22, rainTop = rainBot - 34;
  const iconTop = rainTop - 36, lineTop = 26, lineBot = iconTop - 8;
  const temps = hrs.map((h) => h.temp).filter((t) => t != null);
  const tmin = Math.min(...temps), tmax = Math.max(...temps);
  const span = Math.max(3, tmax - tmin);
  const y = (t) => lineBot - ((t - tmin) / span) * (lineBot - lineTop);

  let out = "";
  // Night hours as one band per run, so there are no seams between columns.
  for (let i = 0; i < n; i++) {
    if (hrs[i].day) continue;
    let j = i;
    while (j + 1 < n && !hrs[j + 1].day) j++;
    out += `<rect class="night" x="${col * i}" y="0" width="${col * (j - i + 1)}" height="${H}"/>`;
    i = j;
  }

  const pts = hrs.map((h, i) => (h.temp == null ? null : [x(i), y(h.temp)])).filter(Boolean);
  if (pts.length > 1) {
    const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join("");
    out += `<path class="line" d="${d}"/>`;
  }
  hrs.forEach((h, i) => {
    const t = new Date(h.time);
    if (h.temp != null) {
      out += `<circle class="dot" cx="${x(i)}" cy="${y(h.temp)}" r="3"/>`;
      if (i % 2 === 0 || n <= 8) out += `<text class="t" x="${x(i)}" y="${y(h.temp) - 11}" text-anchor="middle">${Math.round(h.temp)}°</text>`;
    }
    const bw = Math.min(26, col - 14), bh = barMax;
    out += `<rect class="base" x="${x(i) - bw / 2}" y="${rainBot - 1}" width="${bw}" height="1"/>`;
    // Rain: MET Norway amounts (full bar = 4 mm/h, labelled from 0.2 mm), or IPMA probability.
    const mmode = h.rain_mm !== undefined;
    const frac = mmode ? Math.min(1, (h.rain_mm || 0) / (4 * (h.span || 1))) : (h.rain_prob || 0) / 100;
    if (frac > 0) {
      const ph = Math.max(2, frac * bh);
      out += `<rect class="bar" x="${x(i) - bw / 2}" y="${rainBot - ph}" width="${bw}" height="${ph}" rx="2"/>`;
      const label = mmode ? (h.rain_mm >= 0.2 ? fmtMM(h.rain_mm) : "") : (h.rain_prob >= 30 ? Math.round(h.rain_prob) + "%" : "");
      if (label) out += `<text class="p" x="${x(i)}" y="${rainBot - ph - 4}" text-anchor="middle">${label}</text>`;
    }
    out += `<text class="hour" x="${x(i)}" y="${hourY}" text-anchor="middle">${String(t.getHours()).padStart(2, "0")}</text>`;
    const rainTxt = h.rain_mm !== undefined ? `${h.rain_mm ?? "?"} mm` : `${h.rain_prob ?? "?"}%`;
    const when = h.span ? `${hhmm(t)}–${hhmm(t.getTime() + h.span * 3600e3)}` : hhmm(t);
    const tip = `${when} · ${h.temp != null ? Math.round(h.temp) + "°" : "--"} · ${h.desc || ""} · rain ${rainTxt} · wind ${h.wind_kmh ?? "?"} km/h`;
    out += `<rect x="${col * i}" y="0" width="${col}" height="${H}" fill="transparent"><title>${esc(tip)}</title></rect>`;
  });
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = out;
  $("w-span").textContent = step === 3 ? `next ${n * 3} hours` : "next hours";
  $("w-hicons").innerHTML = hrs.map((h, i) =>
    weatherIcon(h.symbol ?? h.type, h.day).replace('style="', `style="left:${x(i)}px;top:${iconTop}px;`)).join("");
}

const SOURCE_BACK = `<div class="back-title">forecast</div>
  <div class="src-options">
    <div class="src" data-src="metno"><div class="src-name">MET Norway</div>
      <div class="src-desc">rain in mm · Norwegian Meteorological Institute</div></div>
    <div class="src" data-src="ipma"><div class="src-name">IPMA</div>
      <div class="src-desc">rain chance · Portugal's weather service</div></div>
  </div>
  <div class="picker-foot step-row"><span class="opt-row"></span>
    <span class="picker-msg"></span><button class="btn">done</button></div>`;

/* The option row differs per tile: "now" chooses the station, the forecast tile the column width. */
const OPT_ROWS = {
  "weather-now": `<span class="nb-label">station</span><span class="nb-opts step-opts">
    <span class="chip" data-station="true">on</span><span class="chip" data-station="false">off</span></span>`,
  "weather-hourly": `<span class="nb-label">next hours</span><span class="nb-opts step-opts">
    <span class="chip" data-step="1">hourly</span><span class="chip" data-step="3">3-hourly</span></span>`,
};

function showStep(back) {
  back.querySelectorAll("[data-step]").forEach((el) => el.classList.toggle("on", +el.dataset.step === step));
  back.querySelectorAll("[data-station]").forEach((el) => el.classList.toggle("on", (el.dataset.station === "true") === useStation));
}

export function initWeather(scene) {
  document.querySelectorAll(".src-back").forEach((back) => {
    back.innerHTML = SOURCE_BACK;
    const tile = back.closest(".tile"), msg = back.querySelector(".picker-msg");
    back.querySelector(".opt-row").outerHTML = OPT_ROWS[tile.id] || "";
    if (tile.id === "weather-now") back.querySelector(".back-title").textContent = "weather";
    back.querySelector(".btn").addEventListener("click", hideBack);
    back.addEventListener("click", async (e) => {
      const sta = e.target.closest("[data-station]");
      if (sta) {
        try {
          const on = sta.dataset.station === "true";
          await postJSON("/api/prefs", { weather_station: on });
          useStation = on;
          document.querySelectorAll(".src-back").forEach(showStep);
          await loadWeather();
        } catch (err) {
          msg.textContent = "not changed: " + err.message;
        }
        return;
      }
      const st = e.target.closest("[data-step]");
      if (st) {
        try {
          await postJSON("/api/prefs", { forecast_step: +st.dataset.step });
          step = +st.dataset.step;
          document.querySelectorAll(".src-back").forEach(showStep);
          drawChart();
        } catch (err) {
          msg.textContent = "not changed: " + err.message;
        }
        return;
      }
      const opt = e.target.closest(".src");
      if (!opt) return;
      msg.textContent = "switching…";
      try {
        await postJSON("/api/weather/source", { source: opt.dataset.src });
        hideBack();
        await loadWeather();
      } catch (err) {
        msg.textContent = "not changed: " + err.message;
      }
    });
    onRightClick(tile, async () => {
      msg.textContent = "";
      showStep(back);
      showBack(tile);
      try {
        const r = await getJSON("/api/weather/source");
        back.querySelectorAll(".src").forEach((el) => el.classList.toggle("on", el.dataset.src === r.source));
      } catch (e) {
        msg.textContent = "couldn't load the current source";
      }
    });
  });
  window.addEventListener("resize", drawChart);
  getJSON("/api/prefs").then((p) => {
    step = p.forecast_step === 3 ? 3 : 1;
    useStation = p.weather_station !== false;
    drawChart();
  }).catch(() => {});
  poll(loadWeather, 2 * MIN, scene);
}
