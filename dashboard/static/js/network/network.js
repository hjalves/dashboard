/* Network scene: internet latency/loss, LTE signal, powerline link and traffic from the router's
   huawei-trafficd; online devices from lanwatch. All values are shown as the devices report them. */
import { $, esc, getJSON, ago, hhmm, poll, swapIn } from "../core.js";

let traffic = null;
const devs = { list: [], page: 0, perPage: 0 };

/* ---------------------------------------------------------------- formatting */

const num = (v, d = 0) => (v == null ? "--" : Number(v).toFixed(d));
const rate = (v) => (v == null ? "--" : v >= 10 ? v.toFixed(0) : v.toFixed(1));
function bytes(n) {
  if (n == null) return "--";
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e11 ? 0 : 1) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(0) + " MB";
  return (n / 1e3).toFixed(0) + " kB";
}
function duration(s) {
  if (s == null) return "";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

/* ---------------------------------------------------------------- internet */

async function loadInternet() {
  const r = await getJSON("/api/internet");
  traffic = r.data;
  if (!traffic) return;
  const L = traffic.latest, now = traffic.now, ten = traffic.last_10_min;
  const stale = !r.ok ? " · router offline" : L.time && Date.now() / 1000 - L.time > 300 ? ` · data from ${ago(L.time * 1000)}` : "";

  $("n-rtt").textContent = num(now.rtt_ms ?? L.rtt_avg);
  $("n-ping-sub").textContent = `${num(ten.loss_pct, ten.loss_pct ? 1 : 0)}% loss · 10 min avg ${num(ten.rtt_ms)} ms`;
  $("n-ping-foot").textContent = (traffic.targets || []).join(" · ") + stale;

  $("n-down").textContent = rate(now.down_mbps);
  $("n-rate-sub").textContent = `up ${rate(now.up_mbps)} Mbit/s · 10 min ↓ ${rate(ten.down_mbps)} ↑ ${rate(ten.up_mbps)}`;
  $("n-rate-foot").textContent = `today ↓ ${bytes(traffic.today.down_bytes)} ↑ ${bytes(traffic.today.up_bytes)}`;

  $("n-sinr").textContent = num(L.sinr);
  $("n-lte-sub").textContent = `RSRP ${num(L.rsrp)} dBm · RSRQ ${num(L.rsrq)} dB · RSSI ${num(L.rssi)} dBm`;
  // ECI = eNodeB (cell site) × 256 + sector.
  const cell = L.cell_id != null ? `site ${Math.floor(L.cell_id / 256)} · sector ${L.cell_id % 256}` : "";
  $("n-lte-foot").textContent = [cell, L.uptime != null ? "session " + duration(L.uptime) : ""].filter(Boolean).join(" · ");

  $("n-plc-rate").textContent = num(L.plc_down);
  $("n-plc-sub").textContent = `${num(L.plc_down)} down · ${num(L.plc_up)} up (PHY rate)`;
  $("n-plc-foot").textContent = `hop to the Huawei ${num(L.gw_rtt_avg)} ms` + (L.gw_lost ? ` · ${L.gw_lost}/${L.gw_sent} lost` : "");

  drawLatency();
  drawTraffic();
}

/* Nice round step for an axis reaching `max`. */
function niceStep(max, lines = 3) {
  const raw = max / lines, p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
}

function timeAxis(W, H, x, buckets) {
  let out = "";
  buckets.forEach((b, i) => {
    const d = new Date(b.t * 1000);
    if (d.getMinutes() === 0 && d.getHours() % 3 === 0)
      out += `<text class="ax" x="${x(i)}" y="${H - 2}" text-anchor="middle">${String(d.getHours()).padStart(2, "0")}</text>`;
  });
  return out;
}

function drawLatency() {
  const svg = $("n-lat-svg");
  if (!traffic || !svg.clientWidth) return;
  const B = traffic.buckets, W = svg.clientWidth, H = svg.clientHeight;
  const left = 46, bottom = 22, top = 8, plotH = H - bottom - top, n = B.length, col = (W - left) / n;
  const x = (i) => left + col * i + col / 2;
  const avgs = B.map((b) => b.rtt).filter((v) => v != null);
  // Scale to the averages (spikes in the max band are clipped, not allowed to flatten the line).
  const top_ = Math.max(60, Math.max(...avgs, 0) * 1.6), step = niceStep(top_), ymax = Math.ceil(top_ / step) * step;
  const y = (v) => top + plotH - (Math.min(v, ymax) / ymax) * plotH;

  let out = "";
  for (let v = step; v <= ymax; v += step)
    out += `<line class="grid" x1="${left}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${left - 8}" y="${y(v) + 5}" text-anchor="end">${v}</text>`;
  out += `<text class="ax" x="${left - 8}" y="${y(0) + 5}" text-anchor="end">0</text>`;
  // Outages (no target answered) and loss: status marks along the bottom.
  B.forEach((b, i) => {
    if (b.outage) out += `<rect class="outage" x="${left + col * i}" y="${top}" width="${col + 0.5}" height="${plotH}"/>`;
    if (b.loss > 0) {
      const h = Math.max(3, Math.min(1, b.loss / 20) * 20);
      out += `<rect class="loss" x="${x(i) - col / 2 + 1}" y="${y(0) - h}" width="${Math.max(2, col - 2)}" height="${h}"/>`;
    }
  });
  // Max band, then the average line.
  let band = "", line = "";
  B.forEach((b, i) => { if (b.rtt_max != null && b.rtt != null) band += `<line class="maxband" x1="${x(i)}" x2="${x(i)}" y1="${y(b.rtt)}" y2="${y(b.rtt_max)}"/>`; });
  const pts = B.map((b, i) => (b.rtt == null ? null : `${x(i).toFixed(1)},${y(b.rtt).toFixed(1)}`));
  let seg = [];
  pts.concat([null]).forEach((p) => {
    if (p) seg.push(p);
    else if (seg.length) { line += `<polyline class="rtt" points="${seg.join(" ")}"/>`; seg = []; }
  });
  out += band + line + `<line class="base" x1="${left}" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>`;
  out += timeAxis(W, H, x, B);
  B.forEach((b, i) => {
    const tip = `${hhmm(b.t * 1000)}: ${b.rtt ?? "--"} ms average, ${b.rtt_max ?? "--"} ms max, ${b.loss ?? "--"}% loss${b.outage ? ", outage" : ""}`;
    out += `<rect x="${left + col * i}" y="0" width="${col}" height="${H}" fill="transparent"><title>${tip}</title></rect>`;
  });
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = out;
  const lossy = B.filter((b) => b.loss > 0).length, outages = B.filter((b) => b.outage).length;
  $("n-lat-key").innerHTML = `<i class="sw rtt"></i>average <i class="sw max"></i>max · ms` +
    (lossy ? ` <i class="sw loss"></i>loss` : "") + (outages ? ` <i class="sw outage"></i>outage` : "");
}

function drawTraffic() {
  const svg = $("n-traffic-svg");
  if (!traffic || !svg.clientWidth) return;
  const B = traffic.buckets, W = svg.clientWidth, H = svg.clientHeight;
  const left = 46, bottom = 22, top = 8, n = B.length, col = (W - left) / n;
  // Download grows up from the baseline, upload down from it; one scale for both.
  const plotH = H - bottom - top, base = top + plotH * 0.88;
  const peak = Math.max(1, ...B.map((b) => b.down || 0)), step = niceStep(peak, 3), ymax = Math.ceil(peak / step) * step;
  const k = (base - top) / ymax;
  const x = (i) => left + col * i + col / 2;

  let out = "";
  for (let v = step; v <= ymax; v += step)
    out += `<line class="grid" x1="${left}" x2="${W}" y1="${base - v * k}" y2="${base - v * k}"/><text class="ax" x="${left - 8}" y="${base - v * k + 5}" text-anchor="end">${v}</text>`;
  const bw = Math.max(1, col - 2);
  let hi = -1;
  B.forEach((b, i) => {
    if (b.down) out += `<rect class="down" x="${x(i) - bw / 2}" y="${base - b.down * k}" width="${bw}" height="${Math.max(1, b.down * k)}"/>`;
    if (b.up) out += `<rect class="up" x="${x(i) - bw / 2}" y="${base + 1}" width="${bw}" height="${Math.max(1, Math.min(b.up * k, H - bottom - base - 2))}"/>`;
    if (b.down != null && (hi < 0 || b.down > B[hi].down)) hi = i;
  });
  out += `<line class="base" x1="${left}" x2="${W}" y1="${base}" y2="${base}"/>`;
  if (hi >= 0) {  // label the busiest quarter-hour only
    const b = B[hi], lx = Math.min(Math.max(x(hi), left + 30), W - 30);
    out += `<text class="val" x="${lx}" y="${base - b.down * k - 6}" text-anchor="middle">${rate(b.down)}</text>`;
  }
  out += timeAxis(W, H, x, B);
  B.forEach((b, i) => {
    const tip = `${hhmm(b.t * 1000)}: ↓ ${b.down ?? "--"} Mbit/s (peak minute ${b.down_peak ?? "--"}), ↑ ${b.up ?? "--"} Mbit/s`;
    out += `<rect x="${left + col * i}" y="0" width="${col}" height="${H}" fill="transparent"><title>${tip}</title></rect>`;
  });
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = out;
}

/* ---------------------------------------------------------------- devices */

async function loadDevices() {
  const r = await getJSON("/api/lan");
  if (!r.data) return;
  devs.list = r.data.devices;
  $("n-devs-count").textContent = `· ${r.data.online} online` + (r.data.new ? ` · ${r.data.new} new` : "") + (r.ok ? "" : " · router offline");
  showDevicePage(false);
}

function deviceCard(d) {
  const title = d.name || d.vendor || d.mac;
  const what = [d.name ? d.vendor : null, d.info].filter(Boolean).join(" · ") || (d.private_mac ? "private MAC address" : "");
  const sig = d.wifi_signal != null ? ` · wifi ${d.wifi_signal} dBm` : "";
  return `<div class="dev${d.new ? " new" : ""}">
    <div class="dev-name">${esc(title)}${d.new ? '<span class="badge">new</span>' : ""}</div>
    <div class="dev-what">${esc(what)}</div>
    <div class="dev-addr">${esc(d.ip || d.mac)}${sig}</div></div>`;
}

/* Fits as many cards as the tile holds; more than that pages every 12 s. */
function showDevicePage(advance) {
  const box = $("n-devs-pages");
  if (!box.clientHeight) return;
  const per = Math.max(2, Math.floor((box.clientHeight + 8) / (84 + 8)) * 2);
  const pages = Math.max(1, Math.ceil(devs.list.length / per));
  devs.page = advance ? (devs.page + 1) % pages : Math.min(devs.page, pages - 1);
  const html = `<div class="dev-grid">${devs.list.slice(devs.page * per, devs.page * per + per).map(deviceCard).join("")}</div>`;
  if (advance && pages > 1) swapIn(box, "dev-page", html);
  else box.innerHTML = `<div class="dev-page">${html}</div>`;
  $("n-devs-dots").innerHTML = pages > 1 ? Array.from({ length: pages }, (_, i) => `<i class="${i === devs.page ? "on" : ""}"></i>`).join("") : "";
}

export function initNetwork(scene, onSceneChange) {
  poll(loadInternet, 60e3, scene);
  poll(loadDevices, 30e3, scene);
  setInterval(() => { if (devs.list.length) showDevicePage(true); }, 12000);
  const redraw = () => { drawLatency(); drawTraffic(); showDevicePage(false); };
  window.addEventListener("resize", redraw);
  // Charts measure their box, which is only laid out once the scene has been shown.
  onSceneChange((name, entering) => { if (name === scene && entering) setTimeout(redraw, 50); });
}
