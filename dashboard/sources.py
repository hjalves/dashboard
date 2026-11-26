"""Data sources. Each fetch_* coroutine returns plain JSON-able data or raises."""

import asyncio
import csv
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
UA = "home-dashboard/0.1"
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


async def _ubus(c: httpx.AsyncClient, url: str, method: str, args: dict | None = None,
                obj: str = "weather", timeout: float = 8):
    """Anonymous read through the router's uhttpd /ubus (rpcd ACLs allow it for these objects)."""
    body = {"jsonrpc": "2.0", "id": 1, "method": "call", "params": ["0" * 32, obj, method, args or {}]}
    r = await c.post(url, json=body, timeout=timeout)
    r.raise_for_status()
    res = r.json()["result"]
    if res[0] != 0:
        raise RuntimeError(f"ubus {obj}.{method}: status {res[0]}")
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
        # A few samples from about 3 h ago, for the pressure trend (barometer tendency).
        then = latest["time"] - 3 * 3600
        past = (await _ubus(c, url, "query", {"from": then - 300, "to": then + 300, "tier": "fine", "limit": 12}))
        past = [x for x in past.get("samples", []) if x.get("press") is not None]
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
        "hum_in": latest.get("hum_in"),
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
        # hPa change over the last 3 h (relative pressure), None without history.
        "press_3h": round((latest["press"] - min(past, key=lambda x: abs(x["time"] - then))["press"]) * 0.1, 1)
        if past and latest.get("press") is not None else None,
    }


def _carry_forward(rows: list[dict], fields: tuple[str, ...]) -> None:
    """IPMA's hourly rows hold some values only every 3 hours; -99 means "same as before"."""
    last: dict = {}
    for x in rows:
        for f in fields:
            v = _num(x.get(f))
            if v is None and f in last:
                x[f] = last[f]
            elif v is not None:
                last[f] = v


async def fetch_ipma(location: int, hours: int) -> dict:
    async with client() as c:
        await ipma_static.ensure(c)
        r = await c.get(IPMA_FORECAST.format(id=location))
        r.raise_for_status()
        rows = r.json()
    loc = ipma_static.locations.get(location, {})
    lat, lon = float(loc.get("latitude", 38.7)), float(loc.get("longitude", -9.1))
    now = datetime.now(TZ).replace(minute=0, second=0, microsecond=0)

    hourly = []
    hrows = sorted((x for x in rows if x.get("idPeriodo") == 1), key=lambda x: x["dataPrev"])
    _carry_forward(hrows, ("tMed", "probabilidadePrecipita", "ffVento", "hR"))
    for x in hrows:
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
        "source": "ipma",
        "credit": "IPMA",
        "location": loc.get("local"),
        "updated": rows[0].get("dataUpdate") if rows else None,
        "hourly": hourly,
        "daily": daily[:5],
        "sunrise": rise.astimezone(TZ).isoformat(),
        "sunset": sset.astimezone(TZ).isoformat(),
    }


# ---------------------------------------------------------------- network (router)

async def fetch_lan(url: str) -> dict:
    """lanwatch on the router: online devices only, newly seen ones first, then by address."""
    async with client() as c:
        status = await _ubus(c, url, "status", obj="lanwatch")
        devs = (await _ubus(c, url, "devices", obj="lanwatch")).get("devices", [])

    def ip_key(d):
        try:
            return tuple(int(p) for p in d.get("ip", "").split("."))
        except ValueError:
            return (999,)

    online = sorted((d for d in devs if d.get("online")), key=lambda d: (not d.get("new"), ip_key(d)))
    keep = ("mac", "ip", "name", "vendor", "info", "wifi_signal", "new", "private_mac", "first_seen", "last_seen")
    return {
        "online": len(online), "known": status.get("devices"), "new": status.get("new"),
        "last_sweep": status.get("last_sweep"), "sweep_interval": status.get("sweep_interval"),
        "devices": [{k: d.get(k) for k in keep} for d in online],
    }


class TrafficHistory:
    """The last 24 h of huawei-trafficd samples, kept here so the router (a small TL-WR841N) only
    sends the full day once (~600 KB); after that each refresh asks only for newer samples."""

    SPAN = 86400

    def __init__(self, url: str):
        self.url = url
        self.samples: list[dict] = []

    async def refresh(self) -> dict:
        async with client() as c:
            if self.samples:
                args = {"from": self.samples[-1]["time"] + 1, "tier": "fine", "limit": 2000}
            else:
                args = {"from": -self.SPAN, "tier": "fine", "limit": 2000}
            new = (await _ubus(c, self.url, "query", args, obj="huawei.traffic", timeout=30)).get("samples", [])
            status = await _ubus(c, self.url, "status", obj="huawei.traffic")
        self.samples.extend(new)
        cutoff = time.time() - self.SPAN
        self.samples = [x for x in self.samples if x["time"] >= cutoff]
        return summarize_traffic(self.samples, status)


def summarize_traffic(samples: list[dict], status: dict, bucket: int = 900) -> dict:
    """Current state plus 15-minute buckets over the last 24 h. Throughput comes from the session
    byte counters between consecutive samples (they reset when the LTE session reconnects)."""
    rates = []  # (time, seconds, down_bytes, up_bytes)
    for a, b in zip(samples, samples[1:]):
        dt = b["time"] - a["time"]
        dd, du = b.get("download", 0) - a.get("download", 0), b.get("upload", 0) - a.get("upload", 0)
        if 0 < dt <= 300 and dd >= 0 and du >= 0:
            rates.append((b["time"], dt, dd, du))

    def mbps(byte_count, seconds):
        return round(byte_count * 8 / seconds / 1e6, 2) if seconds else None

    def window(seconds):
        lo = time.time() - seconds
        r = [x for x in rates if x[0] >= lo]
        s = [x for x in samples if x["time"] >= lo]
        secs = sum(x[1] for x in r)
        sent = sum(x.get("ping_sent", 0) for x in s)
        lost = sum(x.get("ping_lost", 0) for x in s)
        rtts = [(x["rtt_avg"], x.get("ping_sent", 0) - x.get("ping_lost", 0)) for x in s if "rtt_avg" in x]
        w = sum(n for _, n in rtts)
        return {
            "down_mbps": mbps(sum(x[2] for x in r), secs), "up_mbps": mbps(sum(x[3] for x in r), secs),
            "loss_pct": round(100 * lost / sent, 1) if sent else None,
            "rtt_ms": round(sum(v * n for v, n in rtts) / w) if w else None,
        }

    midnight = datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    today = [x for x in rates if x[0] > midnight]

    buckets = []
    if samples:
        end = int(time.time()) // bucket * bucket + bucket
        for start in range(end - 86400, end, bucket):
            s = [x for x in samples if start <= x["time"] < start + bucket]
            r = [x for x in rates if start <= x[0] < start + bucket]
            sent = sum(x.get("ping_sent", 0) for x in s)
            lost = sum(x.get("ping_lost", 0) for x in s)
            rtts = [x["rtt_avg"] for x in s if "rtt_avg" in x]
            secs = sum(x[1] for x in r)
            buckets.append({
                "t": start,
                "rtt": round(sum(rtts) / len(rtts)) if rtts else None,
                "rtt_max": max((x["rtt_max"] for x in s if "rtt_max" in x), default=None),
                "loss": round(100 * lost / sent, 1) if sent else None,
                "outage": any(x.get("ping_sent", 0) and not x.get("ping_ok") for x in s),
                "down": mbps(sum(x[2] for x in r), secs), "up": mbps(sum(x[3] for x in r), secs),
                "down_peak": max((mbps(x[2], x[1]) for x in r), default=None),
            })

    last = samples[-1] if samples else {}
    keep = ("time", "uptime", "rsrp", "rsrq", "sinr", "rssi", "cell_id", "conn_status", "net_type",
            "rtt_avg", "gw_rtt_avg", "gw_lost", "gw_sent", "plc_down", "plc_up")
    return {
        "latest": {k: last.get(k) for k in keep if k in last},
        "now": window(180),  # the last few samples
        "last_10_min": window(600),
        "today": {"down_bytes": sum(x[2] for x in today), "up_bytes": sum(x[3] for x in today)},
        "targets": (status.get("latency") or {}).get("targets"),
        "failures": status.get("failures"),
        "last_success": status.get("last_success"),
        "buckets": buckets,
        "bucket_seconds": bucket,
    }


# ---------------------------------------------------------------- met.no

METNO = "https://api.met.no/weatherapi/locationforecast/2.0/complete?lat={lat:.4f}&lon={lon:.4f}"
# MET Norway's own English names for its symbol codes (MIT, github.com/metno/weathericons).
METNO_LEGEND = "https://raw.githubusercontent.com/metno/weathericons/main/weather/legend.csv"
_metno_legend: dict = {"at": 0.0, "names": {}}


async def _metno_names(c: httpx.AsyncClient) -> dict[str, str]:
    if time.time() - _metno_legend["at"] > 86400 or not _metno_legend["names"]:
        try:
            r = await c.get(METNO_LEGEND)
            r.raise_for_status()
            names = {row["Symbol ID"].strip(): row["English"].strip()
                     for row in csv.DictReader(io.StringIO(r.text))}
            _metno_legend.update(names=names, at=time.time())
        except Exception:  # noqa: BLE001 - text is optional; keep the old names or none
            _metno_legend["at"] = time.time() - 86400 + 600  # retry in 10 min
    return _metno_legend["names"]


def _symbol(block: dict | None) -> tuple[str | None, bool | None]:
    """'partlycloudy_night' → ('partlycloudy', False); variants: _day, _night, _polartwilight."""
    code = ((block or {}).get("summary") or {}).get("symbol_code")
    if not code:
        return None, None
    base, _, variant = code.partition("_")
    return base, variant != "night"


async def fetch_metno(lat: float, lon: float, place: str, hours: int) -> dict:
    """MET Norway Locationforecast: hourly for ~2.5 days, then 6-hourly. Rain as amounts (mm)."""
    async with client() as c:
        r = await c.get(METNO.format(lat=lat, lon=lon))
        r.raise_for_status()
        props = r.json()["properties"]
        names = await _metno_names(c)
    series = props["timeseries"]
    now = datetime.now(TZ).replace(minute=0, second=0, microsecond=0)

    # One row per hour: hourly steps directly, 6-hourly steps spread over their 6 hours
    # (temperature from the 6-hour min/max, rain split evenly), so days can be summed.
    timeline = []
    for i, x in enumerate(series):
        t = datetime.fromisoformat(x["time"].replace("Z", "+00:00")).astimezone(TZ)
        d = x["data"]
        inst = d["instant"]["details"]
        n1, n6 = d.get("next_1_hours"), d.get("next_6_hours")
        if n1:
            sym, day = _symbol(n1)
            timeline.append({"t": t, "temp": inst.get("air_temperature"), "tmin": inst.get("air_temperature"),
                             "tmax": inst.get("air_temperature"),
                             "rain": (n1.get("details") or {}).get("precipitation_amount"),
                             "inst": inst, "symbol": sym, "day": day, "hourly": True, "d": d})
        elif n6:
            det = n6.get("details") or {}
            mm = det.get("precipitation_amount")
            for h in range(6):
                timeline.append({"t": t + timedelta(hours=h), "temp": None,
                                 "tmin": det.get("air_temperature_min"), "tmax": det.get("air_temperature_max"),
                                 "rain": None if mm is None else mm / 6, "hourly": False, "d": d})

    hourly = []
    for row in timeline:
        if row["t"] < now or not row["hourly"]:
            continue
        inst = row["inst"]
        hourly.append({
            "time": row["t"].isoformat(),
            "temp": row["temp"],
            "rain_mm": row["rain"],
            "wind_kmh": None if inst.get("wind_speed") is None else round(inst["wind_speed"] * 3.6, 1),
            "wind_dir": inst.get("wind_from_direction"),
            "hum": inst.get("relative_humidity"),
            "cloud": inst.get("cloud_area_fraction"),
            "symbol": row["symbol"],
            "desc": names.get(row["symbol"]),
            "day": row["day"],
        })
        if len(hourly) >= hours:
            break

    daily = []
    today = datetime.now(TZ).date()
    for k in range(0, 4):
        date = today + timedelta(days=k)
        rows = [r for r in timeline if r["t"].date() == date]
        if len(rows) < 24:
            continue  # only whole days (today's past hours are gone, the last day is cut off)
        lows = [r["tmin"] for r in rows if r["tmin"] is not None]
        highs = [r["tmax"] for r in rows if r["tmax"] is not None]
        rain = [r["rain"] for r in rows if r["rain"] is not None]
        # The day's symbol: MET's 12-hour summary starting 06:00 (the daytime half).
        sym = None
        for r in rows:
            if r["t"].hour == 6:
                sym, _ = _symbol(r["d"].get("next_12_hours") or r["d"].get("next_6_hours"))
                break
        daily.append({"date": date.isoformat(), "min": min(lows) if lows else None,
                      "max": max(highs) if highs else None,
                      "rain_mm": round(sum(rain), 1) if rain else None,
                      "symbol": sym, "desc": names.get(sym), "day": True})

    rise, sset = sun_times(lat, lon, datetime(today.year, today.month, today.day))
    return {
        "source": "metno",
        "credit": "MET Norway",
        "location": place,
        "updated": props["meta"].get("updated_at"),
        "hourly": hourly,
        "daily": daily,
        "sunrise": rise.astimezone(TZ).isoformat(),
        "sunset": sset.astimezone(TZ).isoformat(),
    }


# ---------------------------------------------------------------- news

KAGI = "https://news.kagi.com/"
# Kagi's text cites sources inline as "[example.com#1]"; the tile has no room for them.
_CITE = re.compile(r"\s*\[[^\]\s]+#\d+\]")


def kagi_story_url(file: str, timestamp: int | None, cluster_number, title: str | None) -> str | None:
    """Kagi News' own page for a story, e.g. https://news.kagi.com/europe/2026112511/eu-weighs-...
    Worked out from the URLs Kagi's site uses (2026-11-26): category file name, then the edition's
    UTC date + the day's batch number (1: Kagi publishes once a day) + the story's cluster number,
    then the headline as a slug (lowercase, punctuation dropped, spaces as hyphens). Kagi finds the
    story by the number, so only the slug's first words are kept: a shorter URL makes a coarser,
    easier to scan QR code."""
    if not (timestamp and cluster_number and title):
        return None
    slug = re.sub(r"[\s_-]+", "-", re.sub(r"[^\w\s-]", "", title.lower())).strip("-")
    slug = "-".join(slug.split("-")[:2])
    day = datetime.fromtimestamp(timestamp, timezone.utc).strftime("%Y%m%d")
    return f"{KAGI}{file.removesuffix('.json')}/{day}1{cluster_number}/{slug}"


def _uncite(text):
    return _CITE.sub("", text).strip() if text else text


async def fetch_kagi_categories() -> list[str]:
    """Every category Kagi News publishes, in Kagi's own order."""
    async with client() as c:
        index = (await c.get(KAGI + "kite.json")).raise_for_status().json()
    return [cat["name"] for cat in index["categories"]]


def _keyword_re(keywords: list[str]):
    """Whole-word, case-insensitive match for any keyword ("AI" mustn't hide stories with "said")."""
    words = [k.strip() for k in keywords if k.strip()]
    if not words:
        return None
    return re.compile("|".join(rf"(?<!\w){re.escape(w)}(?!\w)" for w in words), re.IGNORECASE)


def filter_news(raw: dict, keywords: list[str], per_category: int) -> dict:
    """Drop stories mentioning a hidden keyword (headline, summary or topic), then keep the first
    `per_category` of each category, so hidden stories are replaced by the next ones."""
    rx = _keyword_re(keywords)
    cats = []
    for c in raw["categories"]:
        kept, hidden = [], 0
        for st in c["stories"]:
            text = " ".join(filter(None, (st.get("title"), st.get("summary"), st.get("topic"))))
            if rx and rx.search(text):
                hidden += 1
            else:
                kept.append(st)
        cats.append({**c, "stories": kept[:per_category], "hidden": hidden})
    return {**raw, "categories": cats}


async def fetch_news(categories: list[str]) -> dict:
    """Every story Kagi has in each category (filtering and the per-category limit are applied per
    request, so changing them doesn't need a refetch)."""
    async with client() as c:
        index = (await c.get(KAGI + "kite.json")).raise_for_status().json()
        files = {cat["name"]: cat["file"] for cat in index["categories"]}
        wanted = [(name, files.get(name)) for name in categories]
        missing = [n for n, f in wanted if not f]
        resps = await asyncio.gather(*(c.get(KAGI + f) for _, f in wanted if f), return_exceptions=True)

    out = []
    for (name, file), r in zip([w for w in wanted if w[1]], resps):
        if isinstance(r, Exception) or r.status_code != 200:
            missing.append(name)
            continue
        d = r.json()
        stories = []
        for cl in d.get("clusters", []):
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
                "kagi_url": kagi_story_url(file, d.get("timestamp"), cl.get("cluster_number"), cl.get("title")),
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
