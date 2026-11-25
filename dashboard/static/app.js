"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const MIN = 60e3;

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(url + ": HTTP " + r.status);
  return r.json();
}

function ago(t) {
  const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : d + " days ago";
}
const hhmm = (t) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const deg = (v) => (v == null ? "--" : Math.round(v)) + "°";

/* Polls fn every `every` ms; also on demand via refreshAll() (after sleep/resume). */
const pollers = [];
function poll(fn, every) {
  const run = () => fn().catch((e) => console.warn(e));
  pollers.push(run);
  run();
  setInterval(run, every);
}
const refreshAll = () => pollers.forEach((p) => p());

/* ---------------------------------------------------------------- clock */

let lastTick = Date.now();
function tick() {
  const now = new Date();
  $("hh").textContent = String(now.getHours()).padStart(2, "0");
  $("mm").textContent = String(now.getMinutes()).padStart(2, "0");
  $("date").textContent = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })
    .replace(/^(\w+) (\d+) (\w+)$/, "$1, $3 $2");
  // A big gap between ticks means the machine slept: refresh everything.
  if (Date.now() - lastTick > 2 * MIN) { refreshAll(); tv.restart("resumed"); }
  lastTick = Date.now();
}

/* ---------------------------------------------------------------- weather */

let forecast = null;

async function loadWeather() {
  const w = await getJSON("/api/weather");
  const f = w.forecast.data, st = w.station && w.station.data;
  forecast = f;
  const first = f && f.hourly[0];
  const today = f && f.daily.find((d) => d.date === new Date().toLocaleDateString("sv-SE"));

  $("w-temp").textContent = deg(st ? st.temp : first && first.temp);
  $("w-desc").textContent = first ? first.desc || "" : "";
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
    if (st.today_rain) facts.push(`<span>rain today <b>${st.today_rain}</b> mm</span>`);
  }
  $("w-facts").innerHTML = facts.join("");

  const stationAge = st ? (Date.now() / 1000 - st.time) : null;
  $("w-stale").textContent = !w.forecast.ok ? "forecast offline"
    : stationAge != null && stationAge > 900 ? "station " + ago(st.time * 1000)
    : w.station && !w.station.ok ? "station offline" : "";
  $("w-where").textContent = f && f.location ? "· " + f.location : "";
  renderDays(f);
  drawChart();
}

/* Tomorrow and the day after, from IPMA's daily forecast. */
function renderDays(f) {
  const todayStr = new Date().toLocaleDateString("sv-SE");
  const days = f ? f.daily.filter((d) => d.date > todayStr).slice(0, 2) : [];
  $("w-days").innerHTML = days.map((d) => {
    const name = new Date(d.date + "T12:00").toLocaleDateString("en-GB", { weekday: "long" }).toLowerCase();
    return `<div class="day"><div class="label">${name}</div>
      <div class="hi">${deg(d.max)}<span class="lo">${deg(d.min)}</span></div>
      <div class="ddesc">${esc(d.desc || "")}</div>
      <div class="drain">rain <b>${d.rain_prob != null ? Math.round(d.rain_prob) + "%" : "--"}</b></div></div>`;
  }).join("");
}

function nextSunrise(rise) {
  return Date.now() > rise ? new Date(rise.getTime() + 86400e3) : rise;
}

function drawChart() {
  const svg = $("w-chart");
  if (!forecast || !svg.clientWidth) return;
  const W = svg.clientWidth, H = svg.clientHeight;
  const n = Math.max(4, Math.min(forecast.hourly.length, Math.floor(W / 62)));
  const hrs = forecast.hourly.slice(0, n);
  const col = W / n;
  const x = (i) => col * i + col / 2;

  // Bands: temperature labels+line on top, rain-probability bars below, hour labels at the bottom.
  const hourY = H - 2, rainBot = H - 24, rainTop = rainBot - 34, lineTop = 28, lineBot = rainTop - 30;
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
      // Label every other hour (and the first) so values never collide.
      if (i % 2 === 0 || n <= 8) out += `<text class="t" x="${x(i)}" y="${y(h.temp) - 11}" text-anchor="middle">${Math.round(h.temp)}°</text>`;
    }
    const bw = Math.min(26, col - 14), bh = rainBot - rainTop;
    out += `<rect class="base" x="${x(i) - bw / 2}" y="${rainBot - 1}" width="${bw}" height="1"/>`;
    if (h.rain_prob) {
      const ph = Math.max(2, (h.rain_prob / 100) * bh);
      out += `<rect class="bar" x="${x(i) - bw / 2}" y="${rainBot - ph}" width="${bw}" height="${ph}" rx="2"/>`;
      if (h.rain_prob >= 30) out += `<text class="p" x="${x(i)}" y="${rainTop - 4}" text-anchor="middle">${Math.round(h.rain_prob)}%</text>`;
    }
    out += `<text class="hour" x="${x(i)}" y="${hourY}" text-anchor="middle">${String(t.getHours()).padStart(2, "0")}</text>`;
    const tip = `${hhmm(t)} · ${h.temp != null ? Math.round(h.temp) + "°" : "--"} · ${h.desc || ""} · rain ${h.rain_prob ?? "?"}% · wind ${h.wind_kmh ?? "?"} km/h ${h.wind_dir || ""}`;
    out += `<rect x="${col * i}" y="0" width="${col}" height="${H}" fill="transparent"><title>${esc(tip)}</title></rect>`;
  });
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = out;
}

/* ---------------------------------------------------------------- news */

const news = { stories: [], i: -1, timer: 0 };

async function loadNews() {
  const r = await getJSON("/api/news");
  if (!r.data) return;
  // Round-robin across categories so the tile alternates topics.
  const cats = r.data.categories.filter((c) => c.stories.length);
  const flat = [];
  for (let k = 0; cats.some((c) => k < c.stories.length); k++)
    cats.forEach((c) => { if (k < c.stories.length) flat.push({ ...c.stories[k], cat: c.name, k, total: c.stories.length }); });
  const first = !news.stories.length;
  news.stories = flat;
  if (first) nextStory();
}

function nextStory() {
  clearTimeout(news.timer);
  if (!news.stories.length) return;
  news.i = (news.i + 1) % news.stories.length;
  const s = news.stories[news.i];
  const show = () => {
    const body = $("news-body");
    const old = body.firstElementChild;
    if (old) { old.classList.add("leave"); setTimeout(() => old.remove(), 700); }
    const el = document.createElement("div");
    el.className = "story enter";
    el.innerHTML = `<div class="meta">${s.emoji ? `<span class="emoji">${esc(s.emoji)}</span>` : ""}${esc(s.topic || "")}${s.location ? " · " + esc(s.location) : ""}${s.sources ? " · " + s.sources + " sources" : ""}</div>
      <h2>${esc(s.title)}</h2><p>${esc(s.summary)}</p>`;
    body.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("enter")));
    const img = $("news-img");
    img.style.opacity = 0;
    setTimeout(() => { img.style.backgroundImage = s.image ? `url("${s.image}")` : "none"; img.style.opacity = s.image ? 1 : 0; }, 400);
    $("news-cat").textContent = s.cat;
    $("news-dots").innerHTML = Array.from({ length: s.total }, (_, k) => `<i class="${k === s.k ? "on" : ""}"></i>`).join("");
    news.timer = setTimeout(nextStory, 14000);
  };
  // Preload the image so text and picture change together.
  if (s.image) { const im = new Image(); im.onload = im.onerror = show; im.src = s.image; } else show();
}

/* ---------------------------------------------------------------- github */

const gh = { repos: [], step: 0 };

async function loadGithub() {
  const r = await getJSON("/api/github");
  if (!r.data) return;
  gh.repos = r.data.repos.slice(0, 4);
  gh.repos.forEach((repo, i) => renderRepo(i, true));
}

function renderRepo(i, full) {
  const repo = gh.repos[i], tile = $("gh" + i);
  if (!repo) { tile.innerHTML = ""; return; }
  const c = repo.commits[(gh.step + 0) % Math.max(1, repo.commits.length)] || {};
  const commitHTML = `<div class="msg">${esc(c.message || repo.description || "")}</div>
    <div class="sub">${c.sha ? esc(c.sha) + " · " + ago(c.date) : ""}</div>`;
  if (full || !tile.querySelector(".commit-wrap")) {
    tile.innerHTML = `${i === 0 ? '<div class="label-top">latest push</div>' : ""}
      <div class="top"><div class="name">${esc(repo.name)}</div><div class="when">${ago(repo.pushed)}</div></div>
      <div class="commit-wrap"><div class="commit">${commitHTML}</div></div>
      <div class="foot">${repo.language ? `<span class="lang" style="--c:${esc(repo.language_color || "#888")}">${esc(repo.language)}</span>` : ""}
        <span>${repo.private ? "private" : "public"}</span><span>${repo.commit_count ?? 0} commit${repo.commit_count === 1 ? "" : "s"}</span></div>`;
    return;
  }
  // Live-tile flip to the next commit.
  const wrap = tile.querySelector(".commit-wrap"), old = wrap.firstElementChild;
  old.classList.add("leave");
  setTimeout(() => old.remove(), 700);
  const el = document.createElement("div");
  el.className = "commit enter";
  el.innerHTML = commitHTML;
  wrap.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("enter")));
  tile.querySelector(".when").textContent = ago(repo.pushed);
}

function flipRepos() {
  gh.step++;
  // Stagger the tiles like Metro live tiles.
  gh.repos.forEach((r, i) => { if (r.commits.length > 1) setTimeout(() => renderRepo(i, false), i * 1800); });
}

/* ---------------------------------------------------------------- tv */

const tv = {
  hls: null, url: null, epg: [], lastTime: 0, stuckSince: 0, shownTitle: null, hideTimer: 0,

  start(url) {
    const v = $("tv-video");
    this.url = url;
    this.stop();
    $("tv-status").textContent = "tuning…";
    if (window.Hls && Hls.isSupported()) {
      const h = new Hls({ capLevelToPlayerSize: true, liveSyncDurationCount: 3, maxBufferLength: 20, backBufferLength: 10 });
      this.hls = h;
      h.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        console.warn("hls fatal", d.type, d.details);
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR) h.recoverMediaError();
        else setTimeout(() => this.restart(d.details), 8000);
      });
      h.loadSource(url);
      h.attachMedia(v);
    } else {
      v.src = url;
    }
    v.play().catch(() => {});
  },
  stop() {
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    const v = $("tv-video"); v.removeAttribute("src"); v.load();
  },
  restart(why) {
    if (!this.url) return;
    console.warn("tv restart:", why);
    this.start(this.url);
  },
  watchdog() {
    const v = $("tv-video");
    if (!this.url) return;
    if (v.currentTime !== this.lastTime) { this.lastTime = v.currentTime; this.stuckSince = 0; $("tv-status").textContent = ""; return; }
    if (!this.stuckSince) this.stuckSince = Date.now();
    else if (Date.now() - this.stuckSince > 25000) { this.stuckSince = 0; this.restart("stalled"); }
  },
};

async function loadTv() {
  const r = await getJSON("/api/tv");
  const ch = r.channel.data;
  if (!ch) { $("tv-status").textContent = "channel unavailable"; return; }
  $("tv-channel").textContent = ch.name;
  if (ch.url !== tv.url) tv.start(ch.url);
  tv.epg = (r.epg.data || []).map((p) => ({ ...p, s: new Date(p.start).getTime(), e: new Date(p.stop).getTime() }));
  renderEpg();
}

function showOverlay(ms) {
  const o = $("tv-overlay");
  o.classList.remove("hidden");
  clearTimeout(tv.hideTimer);
  tv.hideTimer = setTimeout(() => o.classList.add("hidden"), ms);
}

function renderEpg() {
  const now = Date.now();
  const i = tv.epg.findIndex((p) => p.s <= now && now < p.e);
  const cur = tv.epg[i], next = i >= 0 ? tv.epg[i + 1] : tv.epg.find((p) => p.s > now);
  $("tv-prog").textContent = cur ? cur.title : "";
  $("tv-bar").style.width = cur ? ((now - cur.s) / (cur.e - cur.s)) * 100 + "%" : "0";
  $("tv-next").textContent = next ? `next ${hhmm(next.s)} ${next.title}` : "";
  const title = cur ? cur.title + cur.s : null;
  if (title !== tv.shownTitle) { tv.shownTitle = title; showOverlay(20000); }
}

/* ---------------------------------------------------------------- input */

let idleTimer = 0;
document.addEventListener("mousemove", () => {
  document.body.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add("idle"), 3000);
});
$("tv").addEventListener("click", () => {
  const v = $("tv-video");
  v.muted = !v.muted;
  $("tv-mute").classList.toggle("on", !v.muted);
  showOverlay(8000);
});
$("news").addEventListener("click", nextStory);
document.body.classList.add("idle");

/* ---------------------------------------------------------------- health */

const started = Date.now();
function reportStats() {
  const v = $("tv-video"), q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : {};
  const level = tv.hls && tv.hls.levels[tv.hls.currentLevel];
  const body = {
    ua: navigator.userAgent, uptime: Math.round((Date.now() - started) / 1000),
    video: { width: v.videoWidth, height: v.videoHeight, time: v.currentTime, paused: v.paused,
      total_frames: q.totalVideoFrames, dropped_frames: q.droppedVideoFrames,
      bitrate: level ? level.bitrate : null, codecs: level ? level.videoCodec : null },
  };
  fetch("/api/stats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
}

/* ---------------------------------------------------------------- self-update */

let version = null;
async function checkVersion() {
  const r = await getJSON("/api/version");
  if (version && r.version !== version) location.reload();
  version = r.version;
}

/* ---------------------------------------------------------------- start */

tick();
setInterval(tick, 1000);
poll(loadWeather, 2 * MIN);
poll(loadNews, 10 * MIN);
poll(loadGithub, 2 * MIN);
poll(loadTv, 15 * MIN);
poll(checkVersion, MIN);
setInterval(flipRepos, 9000);
setInterval(renderEpg, 30000);
setInterval(reportStats, 30000);
setInterval(() => tv.watchdog(), 5000);
setInterval(() => showOverlay(10000), 10 * MIN);
window.addEventListener("resize", drawChart);
// A full reload once a day keeps a long-running browser tidy.
setTimeout(() => location.reload(), 24 * 60 * MIN + Math.random() * 10 * MIN);
