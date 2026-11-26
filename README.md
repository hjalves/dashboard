# dashboard

A Metro-style always-on dashboard for asus-arch's monitor: clock, weather, Kagi News headlines,
recent GitHub activity and a live TV channel. One small Python server (`dashboard`, port 8001)
fetches and caches every source; the page is plain HTML/CSS/JS shown fullscreen by Firefox in kiosk mode.

| Tile | Source | Refresh |
|---|---|---|
| clock | browser | every second |
| weather now | WS2900 station via the router's weatherd (`/ubus`, anonymous read): temperature, today's low/high and rain, humidity, wind, relative pressure with its 3-hour tendency (↗ ↘ →, ±1 hPa), indoor temperature and humidity (the console's own sensor), UV index while the sun is up | 1 min |
| forecast | MET Norway Locationforecast 2.0 (`complete`, by coordinates): hourly temperature, rain in mm and symbol; the two day columns are summed from it (min/max, total mm, the 06–18 h symbol). Symbol names from MET's `legend.csv`. Or IPMA (`source = "ipma"`), where `-99` means "same as the previous hour" | 30 min |
| news | Kagi News (`news.kagi.com/<category>.json`, published once a day; the tile shows the edition date), up to 12 stories per category, alternating categories every 14 s | 30 min |
| github | GraphQL: your repos by last push, with their latest commits | 5 min |
| tv | M3UPT playlist (channel looked up by name) + its XMLTV EPG; plays with hls.js | 6 h |

Every `/api/*` answer is `{ok, updated, age, error, data}`: a failed refresh keeps the last data, so
a tile goes "stale" instead of blank. The page polls `/api/version` and reloads itself after a deploy;
a big jump in the clock (suspend/resume) refreshes everything and restarts the video.

## Scenes

The page holds several full-screen **scenes** side by side; the strip slides between them (Metro
panorama). Switch by clicking a title at the top left (`home · network`) or with the mouse wheel;
the current scene is kept in the URL hash (`#network`), so reloads stay on it. Tiles only poll while
their scene is on screen and catch up when it comes back. The TV stops when you leave the home scene
while it's muted (saves CPU) and rejoins the live stream when you return; with sound on it keeps
playing.

| Scene | Tiles | Source | Refresh |
|---|---|---|---|
| home | see above | | |
| network | internet latency and loss, traffic now and today, LTE signal, powerline link | `huawei-trafficd` on the router (`huawei.traffic` over `/ubus`). The server fetches the last 24 h once (~600 KB) and then only newer samples | 1 min |
| | latency and traffic, last 24 h (15-min buckets) | same | 1 min |
| | online devices, newly seen first (pages every 12 s if they don't fit) | `lanwatch` on the router (`lanwatch.devices`) | 30 s |

| night | big clock, date, temperature now with icon and description, the next 8 hours, tomorrow | the same weather data as home | 5 min |

No speed tests: throughput is what's being used, from the Huawei's byte counters.

The **night** scene is pure black and dim grey, and drifts a few pixels every minute so nothing
sits on the same pixels all night. Right-click it to set the automatic schedule (off by default;
`night` in state.json): at the start hour the page switches to night, and at the end hour back to
the scene it came from. Switching away by hand during the night is respected until the next night,
and choosing night by hand means it isn't switched away in the morning.

## Input

No keyboard needed. With a mouse: click the TV to toggle sound, click the news to skip ahead,
**right-click the news to turn the tile over** (Metro style) and choose its Kagi categories on
the back. Two tabs: **categories** (click to add/remove, the numbers are the rotation order) and
**filters**: keywords that hide stories whose headline, summary or topic contains them (whole
words, any case). Without a keyboard, click the suggested words taken from the story on the tile
(its topic, place and the names in its headline); with one (e.g. the page opened on a phone), type
any keyword. Filtering happens per request on the server, before the 12-per-category cut, so hidden
stories are replaced by the next ones. A third tab, **display**, turns on a discreet QR code in
the tile's corner with the story's page on Kagi News. The feed has no URL field, so it's built the
way Kagi's site builds it: `/{category}/{YYYYMMDD}1{cluster_number}/{slug}`, assuming
one batch a day (falls back to the first source article). The code is drawn by the server (`/api/qr`, `dashboard/qr.py` on segno's matrix: deep-purple
dots with ring-and-centre finder eyes on "photo-tinted glass" (the card holds an aligned,
blurred, brightened copy of the story photo under a light wash, and the dots `multiply` into it;
plain CSS filters, because Firefox doesn't render `backdrop-filter` reliably here), 4 screen pixels per module so the gaps are
whole pixels), so no outside service sees it. The slug is cut to two words to keep the code
small; Kagi finds the story by the number anyway. Save; cancel, a second
right-click or a click outside turns it back unchanged. **Right-click either weather tile** to choose the forecast source. On the "now" tile's back you can
also turn the router's weather station off: "now" then shows the forecast's current hour
(temperature, humidity, wind, rain this hour) and the server stops querying the station; the label
says which ("weather · station" / "weather · forecast"). On the forecast tile's back choose
hourly or 3-hourly columns for the next hours (3-hourly: 8 periods = 24 h, aligned to 00/03/06…,
built from the hourly data: average temperature, total mm or highest chance, the wettest hour's
symbol if any rain, else the middle hour's) and the forecast source, MET Norway or IPMA (click one to switch). These choices are stored in
`~/.local/state/dashboard/state.json` and override `[news] categories` and `[weather] source` in
config.toml (delete the file to go back to the config). Saving
needs the `X-Dashboard: 1` header, so other web pages can't change it. **Right-click the clock** to turn seconds on or off (shown smaller after HH:MM; saved as a
preference in state.json). The browser's own right-click menu is disabled everywhere. The cursor hides after 3 s.

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

## Code layout

`dashboard/app.py` (routes, caching), `sources.py` (fetchers), `config.py`. The page is native ES
modules, no build step: `static/js/core.js` (helpers, scene-aware polling), `backs.js` (tile flip
settings), `scenes.js`, `main.js`, then one module per tile under `static/js/home/` and
`static/js/network/`.

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
