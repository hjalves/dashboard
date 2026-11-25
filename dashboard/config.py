"""Configuration: built-in defaults, overridden by a TOML file.

The file is $DASHBOARD_CONFIG, else ~/.config/dashboard/config.toml. Missing keys keep their defaults.
"""

import os
import tomllib
from pathlib import Path

DEFAULTS = {
    "listen": {"host": "0.0.0.0", "port": 8001},
    "weather": {
        # IPMA globalIdLocal (see https://api.ipma.pt/public-data/forecast/locations.json)
        "ipma_location": 1110600,
        "hours": 24,
        # Router's ubus endpoint for weatherd (anonymous read). Empty disables the station.
        "station_ubus": "http://192.168.0.254/ubus",
    },
    "news": {
        # Kagi News category names, as listed in https://news.kagi.com/kite.json
        "categories": ["Portugal", "World", "Linux & OSS"],
        "per_category": 8,
    },
    "github": {
        "repos": 8,
        "commits": 3,
    },
    "tv": {
        "playlist": "https://m3upt.com/iptv",
        "epg": "https://m3upt.com/epg",
        "channel": "RTP Notícias",
    },
}


def _merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def config_path() -> Path:
    env = os.environ.get("DASHBOARD_CONFIG")
    if env:
        return Path(env)
    base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "dashboard" / "config.toml"


def load() -> dict:
    path = config_path()
    if path.exists():
        with path.open("rb") as f:
            return _merge(DEFAULTS, tomllib.load(f))
    return DEFAULTS
