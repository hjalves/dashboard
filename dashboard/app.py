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
    forecast = Cached("forecast", 1800, lambda: sources.fetch_forecast(int(w["ipma_location"]), int(w["hours"])))
    news = Cached("news", 1800, lambda: sources.fetch_news(list(n["categories"]), int(n["per_category"])))
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

    async def news_ep(_):
        return JSONResponse(await news.get())

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
            Route("/api/news", news_ep),
            Route("/api/github", github_ep),
            Route("/api/tv", tv_ep),
            Route("/api/version", version),
            Route("/api/stats", stats, methods=["GET", "POST"]),
            Mount("/static", StaticFiles(directory=STATIC), name="static"),
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
