"""HTTP server: static page plus cached JSON endpoints.

Every endpoint answers {"ok", "updated", "age", "error", "data"}. A failed refresh keeps
serving the previous data (ok=false, error set) so tiles can show "stale" instead of going blank.
"""

import asyncio
import contextlib
import re
from datetime import datetime, timezone
from urllib.parse import urlencode, urljoin, urlsplit
import hashlib
import json
import logging
import time
from pathlib import Path

import httpx
import uvicorn
from starlette.background import BackgroundTask
from starlette.applications import Starlette
from starlette.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import config, sources
from .qr import qr_svg

log = logging.getLogger("dashboard")
STATIC = Path(__file__).parent / "static"


class RevalidatedStatic(StaticFiles):
    """Static files the browser must revalidate (cheap 304s), so a deploy's reload gets new code."""

    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


class Cached:
    def __init__(self, name: str, ttl: float, fetch, retry: float = 60):
        self.name, self.ttl, self.fetch, self.retry = name, ttl, fetch, retry
        self.data = None
        self.updated = 0.0
        self.tried = 0.0
        self.error: str | None = None
        self.lock = asyncio.Lock()

    def fresh(self) -> bool:
        now = time.time()
        if self.error:
            return now - self.tried < self.retry
        return now - self.updated < self.ttl

    async def get(self) -> dict:
        if not self.fresh():
            async with self.lock:
                if not self.fresh():
                    self.tried = time.time()
                    try:
                        self.data = await self.fetch()
                        self.updated = time.time()
                        self.error = None
                    except Exception as e:  # noqa: BLE001 - any source failure is reported, not raised
                        self.error = f"{type(e).__name__}: {e}"
                        log.warning("%s: %s", self.name, self.error)
        return {
            "ok": self.error is None,
            "updated": self.updated or None,
            "age": round(time.time() - self.updated) if self.updated else None,
            "error": self.error,
            "data": self.data,
        }


def build_app(cfg: dict) -> Starlette:
    w, n, g, t = cfg["weather"], cfg["news"], cfg["github"], cfg["tv"]

    station = Cached("station", 60, lambda: sources.fetch_station(w["station_ubus"])) if w["station_ubus"] else None
    # Settings changed from the page (right-click a tile) live in state.json and override config.toml.
    state = config.load_state()
    SOURCES = ("metno", "ipma")

    def weather_source() -> str:
        src = state.get("weather_source") or w["source"]
        return src if src in SOURCES else "metno"

    async def fetch_forecast():
        if weather_source() == "ipma":
            return await sources.fetch_ipma(int(w["ipma_location"]), int(w["hours"]))
        # MET Norway asks clients not to poll more often than the data's Expires (about 30 min).
        return await sources.fetch_metno(float(w["latitude"]), float(w["longitude"]), w["place"], int(w["hours"]))

    forecast = Cached("forecast", 1800, fetch_forecast)
    moon = Cached("moon", 3 * 3600, lambda: sources.fetch_moon(float(w["latitude"]), float(w["longitude"])), retry=600)

    # Network scene: the router's lanwatch and huawei-trafficd (anonymous ubus reads).
    router = cfg["network"]["router_ubus"]
    lan = Cached("lan", 30, lambda: sources.fetch_lan(router))
    traffic_history = sources.TrafficHistory(router)
    internet = Cached("internet", 55, traffic_history.refresh)

    def news_categories() -> list[str]:
        return list(state.get("news_categories") or n["categories"])

    def news_filters() -> list[str]:
        return list(state.get("news_filters") or [])

    news = Cached("news", 1800, lambda: sources.fetch_news(news_categories()))

    async def news_filtered() -> dict:
        r = await news.get()
        if r["data"]:
            r = {**r, "data": sources.filter_news(r["data"], news_filters(), int(n["per_category"]))}
        return r
    kagi_categories = Cached("kagi-categories", 86400, sources.fetch_kagi_categories, retry=120)
    cal_cfg = cfg["calendar"]
    tk = cfg["tasks"]
    tasks = Cached("tasks", 300, lambda: sources.fetch_tasks(tk["url"], tk["token"])) if tk["url"] else None
    calendar = Cached("calendar", 600, lambda: sources.fetch_calendar(list(cal_cfg["calendars"]), int(cal_cfg["days"])))
    github = Cached("github", 300, lambda: sources.fetch_github(int(g["repos"]), int(g["commits"])))
    # TV: the configured channels; the one on screen is chosen by right-clicking the tile (state).
    tv = Cached("tv", 6 * 3600, lambda: sources.fetch_tv(t["playlist"], list(t["channels"])), retry=300)

    async def epg_fetch():
        info = (await tv.get())["data"]
        ids = {ch["tvg_id"] for ch in (info or {}).get("channels", []) if ch.get("tvg_id")}
        return await sources.fetch_epg(t["epg"], ids) if ids else {}

    epg = Cached("epg", 6 * 3600, epg_fetch, retry=900)

    async def weather(_):
        # With the station turned off (right-click the "now" tile) it isn't even queried.
        use_station = station is not None and prefs()["weather_station"]
        parts = await asyncio.gather(forecast.get(), station.get() if use_station else asyncio.sleep(0, None),
                                     moon.get())
        return JSONResponse({"forecast": parts[0], "station": parts[1], "station_enabled": use_station,
                             "moon": parts[2]["data"]})

    # Calendars hidden from the agenda (right-click the tile); still fetched, so un-hiding is instant.
    def calendar_hidden() -> list[str]:
        return list(state.get("calendar_hidden") or [])

    async def calendar_ep(_):
        r, t = await asyncio.gather(calendar.get(), tasks.get() if tasks else asyncio.sleep(0, None))
        hidden = set(calendar_hidden())
        sources_ = [{"name": c["name"], "color": c.get("color")} for c in cal_cfg["calendars"]]
        if tasks:
            sources_.append({"name": tk["name"], "color": tk["color"]})
        cals = [{**c, "hidden": c["name"] in hidden} for c in sources_]
        data = r["data"]
        if data:
            data = {**data, "events": [e for e in data["events"] if e["calendar"] not in hidden],
                    "errors": [e for e in data["errors"] if e.split(":")[0] not in hidden]}
            if t is not None:
                if t["data"] is not None and tk["name"] not in hidden:
                    data["tasks"] = [{**x, "calendar": tk["name"], "color": tk["color"]} for x in t["data"]]
                if t["error"] and tk["name"] not in hidden:
                    data["errors"] = data["errors"] + [f"{tk['name']}: unavailable"]
        return JSONResponse({**r, "data": data, "calendars": cals})

    async def calendar_visible_ep(req):
        if not csrf_ok(req):
            return JSONResponse({"error": "missing X-Dashboard header"}, status_code=403)
        hidden = (await req.json()).get("hidden")
        names = {c["name"] for c in cal_cfg["calendars"]} | ({tk["name"]} if tasks else set())
        if not isinstance(hidden, list) or not all(isinstance(h, str) and h in names for h in hidden):
            return JSONResponse({"error": "hidden must list configured calendar names"}, status_code=400)
        state["calendar_hidden"] = hidden
        config.save_state(state)
        log.info("calendars hidden: %s", hidden)
        return await calendar_ep(req)

    async def lan_ep(_):
        return JSONResponse(await lan.get())

    async def internet_ep(_):
        return JSONResponse(await internet.get())

    async def news_ep(_):
        return JSONResponse(await news_filtered())

    async def news_filters_ep(req):
        if req.method == "POST":
            if not csrf_ok(req):
                return JSONResponse({"error": "missing X-Dashboard header"}, status_code=403)
            kws = (await req.json()).get("keywords")
            if not isinstance(kws, list) or len(kws) > 100 or \
                    not all(isinstance(k, str) and 0 < len(k.strip()) <= 60 for k in kws):
                return JSONResponse({"error": "keywords: up to 100 strings of 1-60 characters"}, status_code=400)
            # Keep the first spelling of each keyword, case-insensitively.
            seen, clean = set(), []
            for k in (k.strip() for k in kws):
                if k.casefold() not in seen:
                    seen.add(k.casefold())
                    clean.append(k)
            state["news_filters"] = clean
            config.save_state(state)
            log.info("news filters set to %s", clean)
            return JSONResponse(await news_filtered())
        return JSONResponse({"keywords": news_filters()})

    def csrf_ok(req) -> bool:
        # Custom header: a plain cross-site form or fetch can't send it.
        return req.headers.get("x-dashboard") == "1"

    async def weather_source_ep(req):
        if req.method == "POST":
            if not csrf_ok(req):
                return JSONResponse({"error": "missing X-Dashboard header"}, status_code=403)
            src = (await req.json()).get("source")
            if src not in SOURCES:
                return JSONResponse({"error": f"source must be one of {SOURCES}"}, status_code=400)
            if src != weather_source():
                state["weather_source"] = src
                config.save_state(state)
                forecast.updated = 0.0  # refetch from the new source
                forecast.error = None
                forecast.data = None
                log.info("forecast source set to %s", src)
        return JSONResponse({"source": weather_source(), "available": list(SOURCES)})

    # Simple display preferences changed from the page (right-click), with their types and defaults.
    # name: (type, default, allowed values or None)
    PREFS = {"clock_seconds": (bool, False, None), "forecast_step": (int, 1, (1, 3)),
             "news_qr": (bool, False, None), "weather_station": (bool, True, None)}

    def prefs() -> dict:
        saved = state.get("prefs", {})
        return {k: saved.get(k, default) for k, (_, default, _) in PREFS.items()}

    def pref_ok(k, v) -> bool:
        if k not in PREFS:
            return False
        typ, _, allowed = PREFS[k]
        return type(v) is typ and (allowed is None or v in allowed)

    async def prefs_ep(req):
        if req.method == "POST":
            if not csrf_ok(req):
                return JSONResponse({"error": "missing X-Dashboard header"}, status_code=403)
            body = await req.json()
            bad = [k for k, v in body.items() if not pref_ok(k, v)]
            if bad or not body:
                return JSONResponse({"error": f"unknown or mistyped preferences: {bad}"}, status_code=400)
            state["prefs"] = {**state.get("prefs", {}), **body}
            config.save_state(state)
            log.info("preferences set: %s", body)
        return JSONResponse(prefs())

    # Night scene schedule (right-click the night scene): off by default.
    def night_settings() -> dict:
        return {"auto": False, "start": 23, "end": 7, **state.get("night", {})}

    async def night_ep(req):
        if req.method == "POST":
            if not csrf_ok(req):
                return JSONResponse({"error": "missing X-Dashboard header"}, status_code=403)
            body = await req.json()
            auto, start, end = body.get("auto"), body.get("start"), body.get("end")
            if not isinstance(auto, bool) or not all(isinstance(h, int) and 0 <= h <= 23 for h in (start, end)) \
                    or start == end:
                return JSONResponse({"error": "need auto (bool) and two different hours 0-23"}, status_code=400)
            state["night"] = {"auto": auto, "start": start, "end": end}
            config.save_state(state)
            log.info("night schedule set to %s", state["night"])
        return JSONResponse(night_settings())

    async def news_categories_ep(req):
        if req.method == "POST":
            if not csrf_ok(req):
                return JSONResponse({"error": "missing X-Dashboard header"}, status_code=403)
            body = await req.json()
            available = (await kagi_categories.get())["data"] or []
            chosen = body.get("selected")
            if not isinstance(chosen, list) or not chosen or len(chosen) > 30:
                return JSONResponse({"error": "pick 1 to 30 categories"}, status_code=400)
            unknown = [c for c in chosen if c not in available]
            if unknown:
                return JSONResponse({"error": f"unknown categories: {unknown}"}, status_code=400)
            state["news_categories"] = list(dict.fromkeys(chosen))
            config.save_state(state)
            news.updated = 0.0  # refetch with the new list on the next request
            news.error = None
            log.info("news categories set to %s", state["news_categories"])
            return JSONResponse(await news_filtered())
        avail = await kagi_categories.get()
        return JSONResponse({"available": avail["data"] or [], "selected": news_categories(),
                             "error": avail["error"]})

    async def github_ep(_):
        return JSONResponse(await github.get())

    def tv_channels() -> list[dict]:
        return ((tv.data or {}).get("channels")) or []

    def current_channel() -> dict | None:
        chans = tv_channels()
        want = (state.get("tv_channel") or t["channel"]).casefold()
        return next((c for c in chans if c["name"].casefold() == want), chans[0] if chans else None)

    def play_url(ch: dict) -> str:
        if not ch["proxy"]:
            return ch["url"]
        return "/api/tvproxy?" + urlencode({"c": ch["name"], "u": ch["url"]})

    def now_title(progs: list[dict]) -> str | None:
        now = datetime.now(timezone.utc).isoformat()
        return next((p["title"] for p in progs if p["start"] <= now < p["stop"]), None)

    async def tv_ep(_):
        info, guide = await asyncio.gather(tv.get(), epg.get())
        ch = current_channel()
        guides = guide["data"] or {}
        channel = {**info, "data": None}
        if ch:
            channel["data"] = {"name": ch["name"], "url": play_url(ch), "logo": ch["logo"], "tvg_id": ch["tvg_id"],
                               "proxied": ch["proxy"]}
        return JSONResponse({
            "channel": channel,
            "epg": {**guide, "data": guides.get(ch["tvg_id"], []) if ch else []},
            "lineup": [{"name": c["name"], "logo": c["logo"], "now": now_title(guides.get(c["tvg_id"], [])),
                        "current": ch is not None and c["name"] == ch["name"]} for c in tv_channels()],
        })

    async def tv_channel_ep(req):
        if not csrf_ok(req):
            return JSONResponse({"error": "missing X-Dashboard header"}, status_code=403)
        name = (await req.json()).get("name")
        await tv.get()
        if not any(c["name"] == name for c in tv_channels()):
            return JSONResponse({"error": f"unknown channel {name!r}"}, status_code=400)
        state["tv_channel"] = name
        config.save_state(state)
        log.info("tv channel set to %s", name)
        return await tv_ep(req)

    # Proxy for channels whose servers refuse web pages (e.g. they need their own Origin/Referer):
    # fetches with the playlist's headers, only from that channel's host, and rewrites playlists
    # so their segments come through here too.
    proxy_client = httpx.AsyncClient(timeout=20, follow_redirects=True)

    async def tvproxy_ep(req):
        name, url = req.query_params.get("c", ""), req.query_params.get("u", "")
        ch = next((c for c in tv_channels() if c["name"] == name and c["proxy"]), None)
        if not ch or urlsplit(url).scheme not in ("http", "https") or \
                urlsplit(url).hostname != urlsplit(ch["url"]).hostname:
            return Response("not a proxied channel URL", status_code=403)
        headers = {"User-Agent": sources.BROWSER_UA, **ch["headers"]}
        upstream = await proxy_client.send(proxy_client.build_request("GET", url, headers=headers), stream=True)
        ctype = upstream.headers.get("content-type", "")
        if upstream.status_code != 200:
            await upstream.aclose()
            return Response(status_code=upstream.status_code)
        if "mpegurl" in ctype.lower() or urlsplit(url).path.endswith(".m3u8"):
            text = (await upstream.aread()).decode("utf-8", "replace")
            await upstream.aclose()
            base = str(upstream.url)

            def wrap(u: str) -> str:
                return "/api/tvproxy?" + urlencode({"c": name, "u": urljoin(base, u)})

            out = []
            for line in text.splitlines():
                if line and not line.startswith("#"):
                    line = wrap(line.strip())
                elif 'URI="' in line:
                    line = re.sub(r'URI="([^"]+)"', lambda m: f'URI="{wrap(m.group(1))}"', line)
                out.append(line)
            return Response("\n".join(out) + "\n", media_type="application/vnd.apple.mpegurl",
                            headers={"Cache-Control": "no-cache"})
        return StreamingResponse(upstream.aiter_bytes(), media_type=ctype or "video/mp2t",
                                 background=BackgroundTask(upstream.aclose))

    # Changes whenever a static file changes, so open pages reload themselves after a deploy.
    digest = hashlib.sha256()
    for f in sorted(STATIC.rglob("*")):
        if f.is_file() and "vendor" not in f.parts and "fonts" not in f.parts:
            digest.update(f.read_bytes())
    build = digest.hexdigest()[:12]

    async def version(_):
        return JSONResponse({"version": build})

    # Playback stats the page reports every minute (browser, decoder, dropped frames).
    client_stats: dict = {}

    async def stats(req):
        if req.method == "POST":
            body = await req.json()
            body["received"] = time.time()
            client_stats.clear()
            client_stats.update(body)
            return Response(status_code=204)
        return JSONResponse(client_stats)

    # QR codes for story links, made here (no third-party service sees what's being read).
    qr_cache: dict[str, bytes] = {}

    async def qr_ep(req):
        text = req.query_params.get("text", "")
        if not text.startswith(("https://", "http://")) or len(text) > 600:
            return Response("http(s) URL of up to 600 characters only", status_code=400)
        if text not in qr_cache:
            if len(qr_cache) > 200:
                qr_cache.clear()
            qr_cache[text] = qr_svg(text)
        return Response(qr_cache[text], media_type="image/svg+xml", headers={"Cache-Control": "max-age=86400"})

    # Remote control for open pages (e.g. tools/snapshot.py switching scenes): pages listen on
    # /api/events (server-sent events); POST /api/control pushes a command to all of them.
    listeners: set[asyncio.Queue] = set()

    async def events_ep(req):
        q: asyncio.Queue = asyncio.Queue(maxsize=20)
        listeners.add(q)

        async def stream():
            try:
                yield "retry: 5000\n\n"
                while True:
                    try:
                        msg = await asyncio.wait_for(q.get(), timeout=25)
                        yield f"data: {json.dumps(msg)}\n\n"
                    except asyncio.TimeoutError:
                        yield ": keep-alive\n\n"
                    if await req.is_disconnected():
                        break
            finally:
                listeners.discard(q)

        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    async def control_ep(req):
        if not csrf_ok(req):
            return JSONResponse({"error": "missing X-Dashboard header"}, status_code=403)
        body = await req.json()
        if not isinstance(body.get("scene"), str):
            return JSONResponse({"error": "expected {\"scene\": name}"}, status_code=400)
        for q in list(listeners):
            with contextlib.suppress(asyncio.QueueFull):
                q.put_nowait({"scene": body["scene"]})
        return JSONResponse({"sent_to": len(listeners)})

    async def index(_):
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})

    async def warm():
        # Fetch everything once at start so the first page load is quick; EPG last (biggest).
        await asyncio.gather(forecast.get(), news.get(), github.get(), tv.get(),
                             *( [station.get()] if station else [] ), return_exceptions=True)
        await epg.get()

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        task = asyncio.create_task(warm())
        yield
        task.cancel()

    return Starlette(
        routes=[
            Route("/", index),
            Route("/api/weather", weather),
            Route("/api/weather/source", weather_source_ep, methods=["GET", "POST"]),
            Route("/api/night", night_ep, methods=["GET", "POST"]),
            Route("/api/prefs", prefs_ep, methods=["GET", "POST"]),
            Route("/api/events", events_ep),
            Route("/api/control", control_ep, methods=["POST"]),
            Route("/api/qr", qr_ep),
            Route("/api/calendar", calendar_ep),
            Route("/api/calendar/visible", calendar_visible_ep, methods=["POST"]),
            Route("/api/lan", lan_ep),
            Route("/api/internet", internet_ep),
            Route("/api/news", news_ep),
            Route("/api/news/categories", news_categories_ep, methods=["GET", "POST"]),
            Route("/api/news/filters", news_filters_ep, methods=["GET", "POST"]),
            Route("/api/github", github_ep),
            Route("/api/tv", tv_ep),
            Route("/api/tv/channel", tv_channel_ep, methods=["POST"]),
            Route("/api/tvproxy", tvproxy_ep),
            Route("/api/version", version),
            Route("/api/stats", stats, methods=["GET", "POST"]),
            Mount("/static", RevalidatedStatic(directory=STATIC), name="static"),
        ],
        lifespan=lifespan,
    )


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    cfg = config.load()
    uvicorn.run(build_app(cfg), host=cfg["listen"]["host"], port=int(cfg["listen"]["port"]),
                log_level="warning", proxy_headers=False,
                timeout_graceful_shutdown=3)  # open /api/events streams mustn't stall restarts


if __name__ == "__main__":
    main()
