# dashboard

A Metro-style always-on dashboard for asus-arch's monitor: clock, weather, Kagi News headlines,
recent GitHub activity and a live TV channel. One small Python server (`dashboard`, port 8001)
fetches and caches every source; the page is plain HTML/CSS/JS shown fullscreen by Firefox in kiosk mode.

| Tile | Source | Refresh |
|---|---|---|
| clock | browser | every second |
| weather now | WS2900 station via the router's weatherd (`/ubus`, anonymous read) | 1 min |
| forecast | MET Norway Locationforecast 2.0 (`complete`, by coordinates): hourly temperature, rain in mm and symbol; the two day columns are summed from it (min/max, total mm, the 06–18 h symbol). Symbol names from MET's `legend.csv`. Or IPMA (`source = "ipma"`), where `-99` means "same as the previous hour" | 30 min |
| news | Kagi News (`news.kagi.com/<category>.json`), categories rotate every 14 s | 30 min |
| github | GraphQL: your repos by last push, with their latest commits | 5 min |
| tv | M3UPT playlist (channel looked up by name) + its XMLTV EPG; plays with hls.js | 6 h |

Every `/api/*` answer is `{ok, updated, age, error, data}`: a failed refresh keeps the last data, so
a tile goes "stale" instead of blank. The page polls `/api/version` and reloads itself after a deploy;
a big jump in the clock (suspend/resume) refreshes everything and restarts the video.

## Input

No keyboard needed. With a mouse: click the TV to toggle sound, click the news to skip ahead,
**right-click the news to turn the tile over** (Metro style) and choose its Kagi categories on
the back: click to add/remove, the numbers are the rotation order, save; cancel, a second
right-click or a click outside turns it back unchanged. The choice is stored in `~/.local/state/dashboard/state.json` and
overrides `[news] categories` in config.toml (delete the file to go back to the config). Saving
needs the `X-Dashboard: 1` header, so other web pages can't change it. The cursor hides after 3 s.

## Layout

12-column grid, three rows; 1 rem = 1/108 of the screen height, so it scales to any 16:9 monitor.
Fonts: Selawik (Microsoft's open Segoe UI substitute, OFL, vendored in `static/fonts`).
Weather icons: Meteocons' monochrome set (MIT, Bas Milius, vendored in `static/icons`, only the
40 used), tinted with the text colour via CSS masks. `static/icons.js` maps MET Norway symbol codes
(day/night comes with the symbol) and IPMA weather-type numbers to Meteocons names by hand.
Symbols not in a table show text only.

MET Norway's data is CC BY 4.0, so the tile shows "data: MET Norway". Their terms ask for an
identifying User-Agent and no more than one request per Expires period (~30 min); the server sends
a generic `home-dashboard/0.1` and refreshes every 30 min.

## Develop

```bash
uv sync
uv run dashboard            # http://localhost:8001, config from ~/.config/dashboard/config.toml
```

## Deploy (asus-arch)

```bash
git push && deploy/install.sh   # deploys what's on GitHub (origin/main)
```

`~/apps/dashboard` on asus-arch is a git clone of this repo: install.sh runs `git pull --ff-only`
there (and refuses if the checkout has local changes), so `git log -1` there shows what's deployed.
It also syncs the uv env (uv-managed Python) and installs the user unit `dashboard.service`, `~/.local/bin/dashboard-kiosk` and its autostart entry
(`~/.config/autostart/dashboard-kiosk.desktop`). The browser uses its own Firefox profile in
`~/.local/share/dashboard/firefox` with `deploy/user.js` and `deploy/userChrome.css`.

The browser is a normal window, not `--kiosk`, so the XFCE panel stays visible: its Wayland app_id
is `dashboard`, and this rule in `~/.config/xfce4/labwc/rc.xml` (added by hand, not by install.sh)
maximizes it without a titlebar:

```xml
<windowRules>
  <windowRule identifier="dashboard" serverDecoration="no">
    <action name="Maximize"/>
  </windowRule>
</windowRules>
```

Notes:
- RTP answers `204` to requests with a foreign `Referer`, so the page sets `referrer=no-referrer`.
- The GitHub token comes from `gh auth token` (keyring) unless `GITHUB_TOKEN` is set in the unit.

## Browser choice

Measured on asus-arch (i5-2450M, HD 3000, `libva-intel-driver`) on 2026-11-25 with
`tools/browser-bench.sh`: 45–60 s warm-up, then 120 s with the dashboard and RTP Notícias playing,
the window maximized below the panel in every case. No frames were dropped in any run.

| Browser | Video decode | Whole system CPU (4 threads) | Browser memory (PSS) | Video |
|---|---|---|---|---|
| **Firefox 161** (`media.ffmpeg.vaapi.enabled`) | GPU (VA-API) | **20.6 %** | 835 MiB | 720p |
| Chromium 158, default | software | 24.2 % | 584 MiB | 720p |
| Chromium 158 + `AcceleratedVideoDecodeLinuxGL` etc. | GPU (VA-API) | 19.0–22.8 % | ~615 MiB | 360–504p (ABR picked lower) |

Firefox stays: the lowest CPU at full 720p. Chromium only matches it with extra feature flags and
then picked lower video quality; it uses ~250 MiB less memory, which doesn't matter with 7.5 GB.
Chromium's `--app` window (app_id `chrome-localhost__-Default`, `--start-maximized`, profile pref
`browser.custom_chrome_frame=false`) would avoid the userChrome.css trick if Firefox ever regresses.
