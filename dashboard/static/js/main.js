/* Entry point: wires the scenes and their tiles together. */
import { $, getJSON, poll, startPolling, refreshAll, catchUp, MIN } from "./core.js";
import { activeScene, onSceneChange } from "./scenes.js";
import { initClock } from "./home/clock.js";
import { initWeather } from "./home/weather.js";
import { initNews } from "./home/news.js";
import { initGithub } from "./home/github.js";
import { initTv, tv } from "./home/tv.js";
import { initNetwork } from "./network/network.js";

initClock(() => {  // resumed from sleep
  refreshAll(activeScene());
  tv.restart("resumed");
});
initWeather("home");
initNews("home");
initGithub("home", activeScene);
initTv("home", onSceneChange);
initNetwork("network", onSceneChange);

// A scene that comes back on screen fetches whatever it missed while hidden.
onSceneChange((name, entering) => { if (entering) catchUp(name); });

/* Cursor hides after 3 s without movement. */
let idleTimer = 0;
document.addEventListener("mousemove", () => {
  document.body.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add("idle"), 3000);
});
document.body.classList.add("idle");

/* Health: playback stats for /api/stats. */
const started = Date.now();
function reportStats() {
  const v = $("tv-video"), q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : {};
  const level = tv.hls && tv.hls.levels[tv.hls.currentLevel];
  const body = {
    ua: navigator.userAgent, uptime: Math.round((Date.now() - started) / 1000), scene: activeScene(),
    video: { width: v.videoWidth, height: v.videoHeight, time: v.currentTime, paused: v.paused, muted: v.muted, suspended: tv.suspended,
      total_frames: q.totalVideoFrames, dropped_frames: q.droppedVideoFrames,
      bitrate: level ? level.bitrate : null, codecs: level ? level.videoCodec : null },
  };
  fetch("/api/stats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
}
setInterval(reportStats, 30000);

/* Self-update: reload when the server's static files change (after a deploy). */
let version = null;
poll(async () => {
  const r = await getJSON("/api/version");
  if (version && r.version !== version) location.reload();
  version = r.version;
}, MIN);

startPolling(activeScene);
// A full reload once a day keeps a long-running browser tidy.
setTimeout(() => location.reload(), 24 * 60 * MIN + Math.random() * 10 * MIN);
