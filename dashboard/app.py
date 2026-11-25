"""HTTP server: static page plus cached JSON endpoints.

Every endpoint answers {"ok", "updated", "age", "error", "data"}. A failed refresh keeps
serving the previous data (ok=false, error set) so tiles can show "stale" instead of going blank.
"""

import asyncio
import contextlib
import hashlib
import logging
import time
from pathlib import Path

import uvicorn
from starlette.applications import Starlette
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import config, sources

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

    # Network scene: the router's lanwatch and huawei-trafficd (anonymous ubus reads).
    router = cfg["network"]["router_ubus"]
    lan = Cached("lan", 30, lambda: sources.fetch_lan(router))
    traffic_history = sources.TrafficHistory(router)
    internet = Cached("internet", 55, traffic_history.refresh)

    def news_categories() -> list[str]:
        return list(state.get("news_categories") or n["categories"])

    news = Cached("news", 1800, lambda: sources.fetch_news(news_categories(), int(n["per_category"])))
    kagi_categories = Cached("kagi-categories", 86400, sources.fetch_kagi_categories, retry=120)
    github = Cached("github", 300, lambda: sources.fetch_github(int(g["repos"]), int(g["commits"])))
    tv = Cached("tv", 6 * 3600, lambda: sources.fetch_tv(t["playlist"], t["channel"]), retry=300)

    async def epg_fetch():
        info = (await tv.get())["data"]
        if not info or not info.get("tvg_id"):
            return []
        return await sources.fetch_epg(t["epg"], info["tvg_id"])

    epg = Cached("epg", 6 * 3600, epg_fetch, retry=900)

    async def weather(_):
        parts = await asyncio.gather(forecast.get(), station.get() if station else asyncio.sleep(0, None))
        return JSONResponse({"forecast": parts[0], "station": parts[1]})

    async def lan_ep(_):
        return JSONResponse(await lan.get())

    async def internet_ep(_):
        return JSONResponse(await internet.get())

    async def news_ep(_):
        return JSONResponse(await news.get())

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
            return JSONResponse(await news.get())
        avail = await kagi_categories.get()
        return JSONResponse({"available": avail["data"] or [], "selected": news_categories(),
                             "error": avail["error"]})

    async def github_ep(_):
        return JSONResponse(await github.get())

    async def tv_ep(_):
        info, guide = await asyncio.gather(tv.get(), epg.get())
        return JSONResponse({"channel": info, "epg": guide})

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
            Route("/api/lan", lan_ep),
            Route("/api/internet", internet_ep),
            Route("/api/news", news_ep),
            Route("/api/news/categories", news_categories_ep, methods=["GET", "POST"]),
            Route("/api/github", github_ep),
            Route("/api/tv", tv_ep),
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
                log_level="warning", proxy_headers=False)


if __name__ == "__main__":
    main()
