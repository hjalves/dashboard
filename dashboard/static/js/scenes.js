/* Scenes: full-screen grids side by side; one is on screen. Switch by clicking a title at the top
   or with the mouse wheel. The current scene is kept in the URL hash, so reloads stay on it. */
import { $, esc } from "./core.js";
import { anyBack, hideBack } from "./backs.js";

const els = [...document.querySelectorAll(".scene")];
const names = els.map((el) => el.dataset.scene);
const listeners = [];
let current = Math.max(0, names.indexOf(location.hash.slice(1)));

export const activeScene = () => names[current];
/* fn(name, entering) for every switch. */
export const onSceneChange = (fn) => listeners.push(fn);

function render(animate) {
  const strip = $("scenes");
  strip.classList.toggle("instant", !animate);
  strip.style.transform = `translateX(${-100 * current}vw)`;
  els.forEach((el, i) => el.setAttribute("aria-hidden", i !== current));
  document.body.dataset.scene = names[current];
  $("scene-nav").innerHTML = names.map((n, i) =>
    `<span class="${i === current ? "on" : ""}" data-i="${i}">${esc(els[i].dataset.title || n)}</span>`).join("");
}

export function goTo(i) {
  i = (i + names.length) % names.length;
  if (i === current) return;
  if (anyBack()) hideBack();
  const prev = names[current];
  current = i;
  history.replaceState(null, "", "#" + names[current]);
  render(true);
  listeners.forEach((fn) => { fn(prev, false); fn(names[current], true); });
}

export const goToScene = (name) => { const i = names.indexOf(name); if (i >= 0) goTo(i); };

$("scene-nav").addEventListener("click", (e) => {
  const t = e.target.closest("[data-i]");
  if (t) goTo(+t.dataset.i);
});

// Wheel: one scene per gesture. Scrollable lists (e.g. a tile's settings) keep the wheel.
let wheelLock = 0;
window.addEventListener("wheel", (e) => {
  if (e.target.closest(".scrollable") || anyBack()) return;
  e.preventDefault();
  const now = Date.now();
  if (now < wheelLock) { wheelLock = now + 250; return; }
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (Math.abs(d) < 4) return;
  wheelLock = now + 700;
  goTo(current + (d > 0 ? 1 : -1));
}, { passive: false });

render(false);
