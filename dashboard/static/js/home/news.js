/* Kagi News tile: rotating stories; click for the next one, right-click to choose categories. */
import { $, esc, getJSON, postJSON, poll, swapIn, MIN } from "../core.js";
import { showBack, hideBack, isBack, onRightClick } from "../backs.js";

const news = { stories: [], i: -1, timer: 0 };
const picker = { available: [], selected: [], filters: [], suggest: [], tab: "cats", hidden: 0 };

async function loadNews() {
  applyNews(await getJSON("/api/news"));
}

function applyNews(r) {
  if (!r.data) return;
  picker.hidden = r.data.categories.reduce((n, c) => n + (c.hidden || 0), 0);
  // Round-robin across categories so the tile alternates topics.
  const cats = r.data.categories.filter((c) => c.stories.length);
  const flat = [];
  for (let k = 0; cats.some((c) => k < c.stories.length); k++)
    cats.forEach((c) => { if (k < c.stories.length) flat.push({ ...c.stories[k], cat: c.name, k, total: c.stories.length, edition: c.timestamp }); });
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
    // Kagi publishes once a day: the edition date says how fresh the stories are.
    const ed = s.edition ? new Date(s.edition * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
    $("news-cat").innerHTML = esc(s.cat) + (ed ? `<span class="edition"> · Kagi, ${esc(ed)}</span>` : "");
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
  picker.suggest = suggestions(news.stories[news.i]);
  try {
    const [r, f] = await Promise.all([getJSON("/api/news/categories"), getJSON("/api/news/filters")]);
    picker.available = r.available;
    picker.selected = r.selected.slice();
    picker.filters = f.keywords.slice();
    $("picker-msg").textContent = r.error ? "list may be out of date" : "";
  } catch (e) {
    $("picker-msg").textContent = "couldn't load the settings";
  }
  setTab(picker.tab);
}

/* Words worth filtering on, from the story on the tile: its topic, its place, and the names in its
   headline (runs of capitalised words, plus each of their words). */
function suggestions(s) {
  if (!s) return [];
  const out = [];
  const add = (w) => { w = (w || "").trim(); if (w.length >= 2 && !out.some((o) => o.toLowerCase() === w.toLowerCase())) out.push(w); };
  add(s.topic);
  (s.location || "").split(",").forEach(add);
  for (const m of (s.title || "").matchAll(/\p{Lu}[\p{L}\p{N}’'.&-]*(?:\s+\p{Lu}[\p{L}\p{N}’'.&-]*)*/gu)) {
    add(m[0]);
    const parts = m[0].split(/\s+/);
    if (parts.length > 1) parts.forEach((p) => { if (p.length >= 3) add(p); });
  }
  return out.slice(0, 14);
}

function setTab(tab) {
  picker.tab = tab;
  document.querySelectorAll("#news-pivot span").forEach((el) => el.classList.toggle("on", el.dataset.tab === tab));
  $("picker-grid").hidden = tab !== "cats";
  $("filters-pane").hidden = tab !== "filters";
  if (tab === "cats") renderPicker(); else renderFilters();
}

function renderFilters() {
  const has = (w) => picker.filters.some((f) => f.toLowerCase() === w.toLowerCase());
  $("f-current").innerHTML = picker.filters.length
    ? picker.filters.map((k) => `<span class="chip on" data-k="${esc(k)}">${esc(k)}</span>`).join("")
    : `<span class="none">nothing hidden</span>`;
  const sug = picker.suggest.filter((w) => !has(w));
  $("f-suggest").innerHTML = sug.length
    ? sug.map((w) => `<span class="chip" data-w="${esc(w)}">${esc(w)}</span>`).join("")
    : `<span class="none">no suggestions</span>`;
  $("picker-sub").textContent = picker.filters.length
    ? `${picker.filters.length} keyword${picker.filters.length === 1 ? "" : "s"} · ${picker.hidden} stor${picker.hidden === 1 ? "y" : "ies"} hidden now`
    : "hide stories whose headline, summary or topic contains a word (whole words, any case)";
  $("picker-save").disabled = !picker.selected.length;
}

function addFilter(w) {
  w = w.trim();
  if (w && !picker.filters.some((f) => f.toLowerCase() === w.toLowerCase())) picker.filters.push(w);
  renderFilters();
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
  $("news-pivot").addEventListener("click", (e) => { const t = e.target.closest("[data-tab]"); if (t) setTab(t.dataset.tab); });
  $("f-current").addEventListener("click", (e) => {
    const c = e.target.closest("[data-k]");
    if (!c) return;
    picker.filters = picker.filters.filter((f) => f !== c.dataset.k);
    renderFilters();
  });
  $("f-suggest").addEventListener("click", (e) => { const c = e.target.closest("[data-w]"); if (c) addFilter(c.dataset.w); });
  $("f-add-btn").addEventListener("click", () => { addFilter($("f-input").value); $("f-input").value = ""; });
  $("f-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { addFilter(e.target.value); e.target.value = ""; } });
  $("picker-cancel").addEventListener("click", hideBack);
  $("picker-save").addEventListener("click", async () => {
    $("picker-save").disabled = true;
    $("picker-msg").textContent = "saving…";
    try {
      await postJSON("/api/news/categories", { selected: picker.selected });
      const j = await postJSON("/api/news/filters", { keywords: picker.filters });
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
