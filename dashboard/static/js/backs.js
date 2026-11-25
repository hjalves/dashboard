/* Right-click turns a tile over (Metro style) to show its settings; one tile at a time.
   Cancel, a second right-click or a click outside the tile turns it back. */

let backTile = null;  // { el, onClose }

function flipTile(tile, toBack) {
  tile.classList.add("flip-out");
  setTimeout(() => {
    tile.classList.toggle("flipped", toBack);
    tile.classList.remove("flip-out");
    tile.classList.add("flip-in");
    setTimeout(() => tile.classList.remove("flip-in"), 240);
  }, 180);
}
export function showBack(el, onClose) {
  if (backTile) hideBack();
  backTile = { el, onClose };
  flipTile(el, true);
}
export function hideBack() {
  if (!backTile) return;
  const t = backTile;
  backTile = null;
  flipTile(t.el, false);
  if (t.onClose) t.onClose();
}
export const isBack = (el) => !!backTile && backTile.el === el;
export const anyBack = () => !!backTile;
export function onRightClick(el, open) {
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (isBack(el)) hideBack(); else open();
  });
}
document.addEventListener("mousedown", (e) => {
  if (backTile && !backTile.el.contains(e.target)) hideBack();
});
// No browser context menu anywhere: this is a kiosk; tiles with settings handle right-click.
document.addEventListener("contextmenu", (e) => e.preventDefault());
