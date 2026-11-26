/* GitHub tiles: most recently pushed repos, each cycling through its latest commits. */
import { $, esc, getJSON, ago, poll, swapIn, MIN } from "../core.js";

const gh = { repos: [], step: 0 };

async function loadGithub() {
  const r = await getJSON("/api/github");
  if (!r.data) return;
  gh.repos = r.data.repos.slice(0, document.querySelectorAll(".gh").length);
  gh.repos.forEach((repo, i) => renderRepo(i, true));
}

function renderRepo(i, full) {
  const repo = gh.repos[i], tile = $("gh" + i);
  if (!repo) { tile.innerHTML = ""; return; }
  const c = repo.commits[gh.step % Math.max(1, repo.commits.length)] || {};
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
  swapIn(tile.querySelector(".commit-wrap"), "commit", commitHTML);
  tile.querySelector(".when").textContent = ago(repo.pushed);
}

export function initGithub(scene, activeScene) {
  poll(loadGithub, 2 * MIN, scene);
  setInterval(() => {
    if (activeScene() !== scene) return;
    gh.step++;
    // Stagger the tiles like Metro live tiles.
    gh.repos.forEach((r, i) => { if (r.commits.length > 1) setTimeout(() => renderRepo(i, false), i * 1800); });
  }, 9000);
}
