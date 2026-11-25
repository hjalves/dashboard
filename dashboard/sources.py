"""Data sources. Each fetch_* coroutine returns plain JSON-able data or raises."""

import asyncio
import gzip
import io
import math
import os
import re
import shutil
import subprocess
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx

TZ = ZoneInfo("Europe/Lisbon")
UA = "dashboard/0.1 (+home dashboard)"
# Browser-like UA for the IPTV playlist/EPG hosts, which reject unknown clients.
BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:160.0) Gecko/20100101 Firefox/160.0"


def client(**kw) -> httpx.AsyncClient:
    kw.setdefault("timeout", 20)
    kw.setdefault("follow_redirects", True)
    kw.setdefault("headers", {"User-Agent": UA})
    return httpx.AsyncClient(**kw)


# ---------------------------------------------------------------- weather

IPMA_LOCATIONS = "https://api.ipma.pt/public-data/forecast/locations.json"
IPMA_FORECAST = "https://api.ipma.pt/public-data/forecast/aggregate/{id}.json"
IPMA_TYPES = "https://api.ipma.pt/open-data/weather-type-classe.json"


def _num(v):
    """IPMA sends numbers as strings and -99 for 'no data'."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f <= -99 else f


def sun_times(lat: float, lon: float, day: datetime) -> tuple[datetime, datetime]:
    """Sunrise and sunset (UTC) for a date, NOAA sunrise equation (about a minute accurate)."""
    n = day.timetuple().tm_yday
    g = 2 * math.pi / 365 * (n - 1)
    decl = (0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g)
            + 0.000907 * math.sin(2 * g) - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g))
    eqt = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g)
                    - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    la = math.radians(lat)
    cos_h = (math.cos(math.radians(90.833)) / (math.cos(la) * math.cos(decl))) - math.tan(la) * math.tan(decl)
    ha = math.degrees(math.acos(max(-1, min(1, cos_h))))
    midnight = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    rise = midnight + timedelta(minutes=720 - 4 * (lon + ha) - eqt)
    sset = midnight + timedelta(minutes=720 - 4 * (lon - ha) - eqt)
    return rise, sset


def is_day(lat: float, lon: float, when: datetime) -> bool:
    rise, sset = sun_times(lat, lon, when.astimezone(timezone.utc))
    return rise <= when <= sset


class IpmaStatic:
    """Location list and weather-type descriptions: change rarely, cached for a day."""

    def __init__(self):
        self.loaded = 0.0
        self.locations: dict[int, dict] = {}
        self.types: dict[int, str] = {}

    async def ensure(self, c: httpx.AsyncClient):
        if time.time() - self.loaded < 86400 and self.locations:
            return
        locs, types = await asyncio.gather(c.get(IPMA_LOCATIONS), c.get(IPMA_TYPES))
        locs.raise_for_status()
        types.raise_for_status()
        self.locations = {x["globalIdLocal"]: x for x in locs.json()}
        self.types = {x["idWeatherType"]: x["descWeatherTypeEN"] for x in types.json()["data"]}
        self.loaded = time.time()


ipma_static = IpmaStatic()


async def _ubus(c: httpx.AsyncClient, url: str, method: str, args: dict | None = None):
    body = {"jsonrpc": "2.0", "id": 1, "method": "call",
            "params": ["0" * 32, "weather", method, args or {}]}
    r = await c.post(url, json=body, timeout=8)
    r.raise_for_status()
    res = r.json()["result"]
    if res[0] != 0:
        raise RuntimeError(f"ubus weather.{method}: status {res[0]}")
    return res[1] if len(res) > 1 else {}


async def fetch_station(url: str) -> dict:
    """Current conditions plus today's extremes and rain from the router's weatherd."""
    now = datetime.now(TZ)
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    hour = now.replace(minute=0, second=0, microsecond=0)
    async with client() as c:
        latest = (await _ubus(c, url, "latest"))["sample"]
        # Completed hours of today from the hourly tier, the current hour from the fine tier:
        # keeps the request small for the router.
        coarse = await _ubus(c, url, "query", {"from": int(midnight.timestamp()), "to": int(hour.timestamp()) - 1,
                                                "tier": "coarse", "limit": 30})
        fine = await _ubus(c, url, "query", {"from": int(hour.timestamp()), "tier": "fine", "limit": 200})
    samples = coarse.get("samples", []) + fine.get("samples", [])
    highs = [s.get("temp_max", s.get("temp")) for s in samples] + [latest.get("temp")]
    lows = [s.get("temp_min", s.get("temp")) for s in samples] + [latest.get("temp")]
    highs = [h for h in highs if h is not None]
    lows = [v for v in lows if v is not None]

    def sc(v, f):
        return None if v is None else round(v * f, 2)

    return {
        "time": latest["time"],
        "temp": sc(latest.get("temp"), 0.1),
        "temp_in": sc(latest.get("temp_in"), 0.1),
        "hum": latest.get("hum"),
        "press": sc(latest.get("press"), 0.1),
        "wind_kmh": sc(latest.get("wind"), 0.36),
        "gust_kmh": sc(latest.get("gust"), 0.36),
        "dir": latest.get("dir"),
        "rain_rate": sc(latest.get("rain_rate"), 0.1),
        "uv": latest.get("uv"),
        "solar": latest.get("solar"),
        "today_high": sc(max(highs), 0.1) if highs else None,
        "today_low": sc(min(lows), 0.1) if lows else None,
        "today_rain": round(sum(s.get("rain", 0) for s in samples) * 0.01, 1),
    }


async def fetch_forecast(location: int, hours: int) -> dict:
    async with client() as c:
        await ipma_static.ensure(c)
        r = await c.get(IPMA_FORECAST.format(id=location))
        r.raise_for_status()
        rows = r.json()
    loc = ipma_static.locations.get(location, {})
    lat, lon = float(loc.get("latitude", 38.7)), float(loc.get("longitude", -9.1))
    now = datetime.now(TZ).replace(minute=0, second=0, microsecond=0)

    hourly = []
    for x in sorted((x for x in rows if x.get("idPeriodo") == 1), key=lambda x: x["dataPrev"]):
        t = datetime.fromisoformat(x["dataPrev"]).replace(tzinfo=TZ)
        if t < now:
            continue
        wt = x.get("idTipoTempo")
        hourly.append({
            "time": t.isoformat(),
            "temp": _num(x.get("tMed")),
            "rain_prob": _num(x.get("probabilidadePrecipita")),
            "wind_kmh": _num(x.get("ffVento")),
            "wind_dir": x.get("ddVento"),
            "hum": _num(x.get("hR")),
            "type": wt,
            "desc": ipma_static.types.get(wt),
            "day": is_day(lat, lon, t),
        })
        if len(hourly) >= hours:
            break

    daily = []
    for x in sorted((x for x in rows if x.get("idPeriodo") == 24), key=lambda x: x["dataPrev"]):
        wt = x.get("idTipoTempo")
        daily.append({
            "date": x["dataPrev"][:10],
            "min": _num(x.get("tMin")),
            "max": _num(x.get("tMax")),
            "rain_prob": _num(x.get("probabilidadePrecipita")),
            "type": wt,
            "desc": ipma_static.types.get(wt),
        })

    today = datetime.now(TZ).date()
    rise, sset = sun_times(lat, lon, datetime(today.year, today.month, today.day))
    return {
        "location": loc.get("local"),
        "updated": rows[0].get("dataUpdate") if rows else None,
        "hourly": hourly,
        "daily": daily[:5],
        "sunrise": rise.astimezone(TZ).isoformat(),
        "sunset": sset.astimezone(TZ).isoformat(),
    }


# ---------------------------------------------------------------- news

KAGI = "https://news.kagi.com/"
# Kagi's text cites sources inline as "[example.com#1]"; the tile has no room for them.
_CITE = re.compile(r"\s*\[[^\]\s]+#\d+\]")


def _uncite(text):
    return _CITE.sub("", text).strip() if text else text


async def fetch_news(categories: list[str], per_category: int) -> dict:
    async with client() as c:
        index = (await c.get(KAGI + "kite.json")).raise_for_status().json()
        files = {cat["name"]: cat["file"] for cat in index["categories"]}
        wanted = [(name, files.get(name)) for name in categories]
        missing = [n for n, f in wanted if not f]
        resps = await asyncio.gather(*(c.get(KAGI + f) for _, f in wanted if f), return_exceptions=True)

    out = []
    for (name, _), r in zip([w for w in wanted if w[1]], resps):
        if isinstance(r, Exception) or r.status_code != 200:
            missing.append(name)
            continue
        d = r.json()
        stories = []
        for cl in d.get("clusters", [])[:per_category]:
            img = cl.get("primary_image") or {}
            stories.append({
                "title": _uncite(cl.get("title")),
                "summary": _uncite(cl.get("short_summary")),
                "emoji": cl.get("emoji"),
                "topic": cl.get("category"),
                "location": cl.get("location"),
                "sources": cl.get("unique_domains"),
                "image": img.get("url") or None,
                "link": (cl.get("articles") or [{}])[0].get("link"),
            })
        out.append({"name": name, "timestamp": d.get("timestamp"), "stories": stories})
    return {"categories": out, "missing": missing}


# ---------------------------------------------------------------- github

GQL = """
query($repos: Int!, $commits: Int!) {
  viewer {
    login
    repositories(first: $repos, orderBy: {field: PUSHED_AT, direction: DESC}, ownerAffiliations: OWNER) {
      nodes {
        name isPrivate pushedAt url description
        primaryLanguage { name color }
        defaultBranchRef { name target { ... on Commit {
          history(first: $commits) { totalCount nodes { messageHeadline committedDate abbreviatedOid } }
        } } }
      }
    }
  }
}
"""

_token_cache: dict = {}


def github_token() -> str:
    tok = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if tok:
        return tok
    if _token_cache.get("t") and time.time() - _token_cache["at"] < 3600:
        return _token_cache["t"]
    gh = shutil.which("gh")
    if not gh:
        raise RuntimeError("no GITHUB_TOKEN and no gh CLI")
    tok = subprocess.run([gh, "auth", "token"], capture_output=True, text=True, timeout=10, check=True).stdout.strip()
    _token_cache.update(t=tok, at=time.time())
    return tok


async def fetch_github(repos: int, commits: int) -> dict:
    tok = await asyncio.to_thread(github_token)
    async with client() as c:
        r = await c.post("https://api.github.com/graphql",
                         headers={"Authorization": f"bearer {tok}", "User-Agent": UA},
                         json={"query": GQL, "variables": {"repos": repos, "commits": commits}})
        r.raise_for_status()
        d = r.json()
    if d.get("errors"):
        raise RuntimeError(d["errors"][0].get("message", "GraphQL error"))
    v = d["data"]["viewer"]
    out = []
    for n in v["repositories"]["nodes"]:
        ref = n.get("defaultBranchRef") or {}
        hist = ((ref.get("target") or {}).get("history")) or {}
        out.append({
            "name": n["name"],
            "private": n["isPrivate"],
            "pushed": n["pushedAt"],
            "description": n.get("description"),
            "language": (n.get("primaryLanguage") or {}).get("name"),
            "language_color": (n.get("primaryLanguage") or {}).get("color"),
            "branch": ref.get("name"),
            "commit_count": hist.get("totalCount"),
            "commits": [{"message": h["messageHeadline"], "date": h["committedDate"], "sha": h["abbreviatedOid"]}
                        for h in hist.get("nodes", [])],
        })
    return {"login": v["login"], "repos": out}


# ---------------------------------------------------------------- tv

_ATTR = re.compile(r'([\w-]+)="([^"]*)"')


def parse_m3u(text: str) -> list[dict]:
    chans, cur = [], None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("#EXTINF"):
            head, _, name = line.partition(",")
            cur = dict(_ATTR.findall(head))
            cur["name"] = name.strip()
        elif line and not line.startswith("#") and cur is not None:
            cur["url"] = line
            chans.append(cur)
            cur = None
    return chans


def _xmltv_time(s: str) -> datetime:
    # "20261125180000 +0000"
    return datetime.strptime(s.strip(), "%Y%m%d%H%M%S %z")


def parse_epg(gz: bytes, channel_id: str, hours: int = 30) -> list[dict]:
    """Programmes for one channel from now-1h to now+hours, streamed from gzipped XMLTV."""
    now = datetime.now(timezone.utc)
    lo, hi = now - timedelta(hours=1), now + timedelta(hours=hours)
    progs = []
    for _, el in ET.iterparse(gzip.GzipFile(fileobj=io.BytesIO(gz)), events=("end",)):
        if el.tag == "programme":
            if el.get("channel") == channel_id:
                start, stop = _xmltv_time(el.get("start")), _xmltv_time(el.get("stop"))
                if stop >= lo and start <= hi:
                    progs.append({"start": start.isoformat(), "stop": stop.isoformat(),
                                  "title": el.findtext("title"), "desc": el.findtext("desc")})
            el.clear()
        elif el.tag == "channel":
            el.clear()
    progs.sort(key=lambda p: p["start"])
    return progs


async def fetch_tv(playlist: str, channel: str) -> dict:
    async with client(headers={"User-Agent": BROWSER_UA}) as c:
        r = await c.get(playlist)
        r.raise_for_status()
    chans = parse_m3u(r.text)
    match = next((ch for ch in chans if ch["name"].casefold() == channel.casefold()), None)
    if not match:
        raise RuntimeError(f"channel {channel!r} not in playlist")
    return {
        "name": match["name"],
        "url": match["url"],
        "logo": match.get("tvg-logo"),
        "tvg_id": match.get("tvg-id"),
        "channels": [ch["name"] for ch in chans if ch.get("group-title") == match.get("group-title")],
    }


async def fetch_epg(epg_url: str, tvg_id: str) -> list[dict]:
    async with client(headers={"User-Agent": BROWSER_UA}, timeout=120) as c:
        r = await c.get(epg_url)
        r.raise_for_status()
    return await asyncio.to_thread(parse_epg, r.content, tvg_id)
