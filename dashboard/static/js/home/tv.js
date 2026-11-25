/* Live TV tile (hls.js, global from vendor/hls.min.js). Click toggles sound.
   Leaving the scene stops a muted channel (saves CPU); with sound on it keeps playing. */
import { $, getJSON, hhmm, poll, MIN } from "../core.js";

export const tv = {
  hls: null, url: null, epg: [], lastTime: 0, stuckSince: 0, shownTitle: null, hideTimer: 0, suspended: false,

  start(url) {
    const v = $("tv-video");
    this.url = url;
    this.stop();
    this.suspended = false;
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
    if (!this.url || this.suspended) return;
    console.warn("tv restart:", why);
    this.start(this.url);
  },
  suspend() {
    if (!this.url || !$("tv-video").muted) return;  // sound on: keep playing in the background
    this.suspended = true;
    this.stop();
  },
  resume() {
    if (this.suspended) this.start(this.url);  // rejoins the live edge
  },
  watchdog() {
    const v = $("tv-video");
    if (!this.url || this.suspended) return;
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
  if (ch.url !== tv.url && !tv.suspended) tv.start(ch.url);
  else if (ch.url !== tv.url) tv.url = ch.url;
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

export function initTv(scene, onSceneChange) {
  $("tv").addEventListener("click", () => {
    const v = $("tv-video");
    v.muted = !v.muted;
    $("tv-mute").classList.toggle("on", !v.muted);
    showOverlay(8000);
  });
  onSceneChange((name, entering) => {
    if (name !== scene) return;
    if (entering) tv.resume(); else tv.suspend();
  });
  poll(loadTv, 15 * MIN, scene);
  setInterval(renderEpg, 30000);
  setInterval(() => tv.watchdog(), 5000);
  setInterval(() => showOverlay(10000), 10 * MIN);
}
