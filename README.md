# dashboard

A Metro-style always-on dashboard for asus-arch's monitor: clock, weather, Kagi News headlines,
recent GitHub activity and a live TV channel. One small Python server (`dashboard`, port 8001)
fetches and caches every source; the page is plain HTML/CSS/JS shown fullscreen by Firefox in kiosk mode.

| Tile | Source | Refresh |
|---|---|---|
| clock | browser | every second |
| weather now | WS2900 station via the router's weatherd (`/ubus`, anonymous read) | 1 min |
| next hours | IPMA hourly forecast (`aggregate/<id>.json`) + IPMA's own weather-type text | 30 min |
| news | Kagi News (`news.kagi.com/<category>.json`), categories rotate every 14 s | 30 min |
| github | GraphQL: your repos by last push, with their latest commits | 5 min |
| tv | M3UPT playlist (channel looked up by name) + its XMLTV EPG; plays with hls.js | 6 h |

Every `/api/*` answer is `{ok, updated, age, error, data}`: a failed refresh keeps the last data, so
a tile goes "stale" instead of blank. The page polls `/api/version` and reloads itself after a deploy;
a big jump in the clock (suspend/resume) refreshes everything and restarts the video.

## Input

No keyboard needed. With a mouse: click the TV to toggle sound, click the news to skip ahead. The
cursor hides after 3 s.

## Layout

12-column grid, three rows; 1 rem = 1/108 of the screen height, so it scales to any 16:9 monitor.
Fonts: Selawik (Microsoft's open Segoe UI substitute, OFL, vendored in `static/fonts`).
No weather icons on purpose: IPMA's icons are colourful/skeuomorphic and a home-made icon set would
need an id→icon table, so the tile shows IPMA's description text and a temperature/rain-chance chart.

## Develop

```bash
uv sync
uv run dashboard            # http://localhost:8001, config from ~/.config/dashboard/config.toml
```

## Deploy (asus-arch)

```bash
deploy/install.sh           # commit first: it deploys HEAD
```

Installs to `~/.local/share/dashboard/app` (uv env with uv-managed Python), the user unit
`dashboard.service`, `~/.local/bin/dashboard-kiosk` and its autostart entry
(`~/.config/autostart/dashboard-kiosk.desktop`). The kiosk uses its own Firefox profile in
`~/.local/share/dashboard/firefox` with `deploy/user.js`.

Notes:
- RTP answers `204` to requests with a foreign `Referer`, so the page sets `referrer=no-referrer`.
- The GitHub token comes from `gh auth token` (keyring) unless `GITHUB_TOKEN` is set in the unit.
