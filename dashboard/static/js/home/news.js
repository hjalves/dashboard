/* Kagi News tile: rotating stories; click for the next one, right-click to choose categories. */
import { $, esc, getJSON, postJSON, poll, swapIn, MIN } from "../core.js";
import { showBack, hideBack, isBack, onRightClick } from "../backs.js";

const news = { stories: [], i: -1, timer: 0 };
const picker = { available: [], selected: [] };

async function loadNews() {
  applyNews(await getJSON("/api/news"));
}

function applyNews(r) {
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
    swapIn($("news-body"), "story", `<div class="meta">${s.emoji ? `<span class="emoji">${esc(s.emoji)}</span>` : ""}${esc(s.topic || "")}${s.location ? " · " + esc(s.location) : ""}${s.sources ? " · " + s.sources + " sources" : ""}</div>
      <h2>${esc(s.title)}</h2><p>${esc(s.summary)}</p>`);
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

async function openPicker() {
  clearTimeout(news.timer);  // hold the current story while the tile is turned over
  $("picker-msg").textContent = "loading…";
  $("picker-grid").innerHTML = "";
  showBack($("news"), () => { clearTimeout(news.timer); news.timer = setTimeout(nextStory, 8000); });
  try {
    const r = await getJSON("/api/news/categories");
    picker.available = r.available;
    picker.selected = r.selected.slice();
    $("picker-msg").textContent = r.error ? "list may be out of date" : "";
  } catch (e) {
    $("picker-msg").textContent = "couldn't load categories";
  }
  renderPicker();
}

function renderPicker() {
  // Tiles stay in Kagi's order so nothing moves under the mouse; numbers give the rotation order.
  $("picker-grid").innerHTML = picker.available.map((c) => {
    const k = picker.selected.indexOf(c);
    return `<div class="chip${k >= 0 ? " on" : ""}" data-c="${esc(c)}">${esc(c)}${k >= 0 ? `<span class="n">${k + 1}</span>` : ""}</div>`;
  }).join("");
  $("picker-save").disabled = !picker.selected.length;
  $("picker-sub").textContent = picker.selected.length
    ? "showing, in order: " + picker.selected.join(" · ")
    : "pick at least one category";
}

export function initNews(scene) {
  $("picker-grid").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const c = chip.dataset.c, k = picker.selected.indexOf(c);
    if (k >= 0) picker.selected.splice(k, 1); else picker.selected.push(c);
    renderPicker();
  });
  $("picker-cancel").addEventListener("click", hideBack);
  $("picker-save").addEventListener("click", async () => {
    $("picker-save").disabled = true;
    $("picker-msg").textContent = "saving…";
    try {
      const j = await postJSON("/api/news/categories", { selected: picker.selected });
      hideBack();
      news.stories = [];
      news.i = -1;
      applyNews(j);
    } catch (e) {
      $("picker-msg").textContent = "not saved: " + e.message;
      $("picker-save").disabled = false;
    }
  });
  onRightClick($("news"), openPicker);
  $("news").addEventListener("click", () => { if (!isBack($("news"))) nextStory(); });
  poll(loadNews, 10 * MIN, scene);
}
