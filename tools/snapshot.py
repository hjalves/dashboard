#!/usr/bin/env python3
"""Devlog snapshot: capture each scene from the real kiosk screen and add them to docs/devlog.

Run from the repo: `uv run --with pillow tools/snapshot.py [--host dk@192.168.0.2] [--scenes home network night]`

On the host, it switches the open page to each scene through POST /api/control, takes a screenshot
with grim (the Wayland compositor's own capture: real Firefox rendering, no cursor), crops off the
desktop panel, and finally puts the page back on the scene it was showing. Here it saves
docs/devlog/YYYY-MM-DD-<scene>.webp and adds a dated entry with the current commit to
docs/devlog/README.md, with a TODO line for you to describe what changed.
"""
import argparse
import datetime as dt
import io
import json
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parent.parent
DEVLOG = REPO / "docs" / "devlog"
SETTLE = {"home": 10, "network": 6, "night": 4}  # seconds for data, video and slide to settle


def ssh(host: str, cmd: str, binary: bool = False):
    r = subprocess.run(["ssh", host, cmd], capture_output=True, check=True)
    return r.stdout if binary else r.stdout.decode()


def api(host: str, path: str, body: dict | None = None) -> dict:
    if body is None:
        return json.loads(ssh(host, f"curl -s localhost:8001{path}"))
    data = json.dumps(body).replace("'", "'\\''")
    return json.loads(ssh(host, f"curl -s -X POST localhost:8001{path} -H 'X-Dashboard: 1' "
                                f"-H 'Content-Type: application/json' -d '{data}'"))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--host", default="dk@192.168.0.2")
    ap.add_argument("--scenes", nargs="+", default=["home", "network", "night"])
    ap.add_argument("--quality", type=int, default=82, help="WebP quality")
    args = ap.parse_args()

    stats = api(args.host, "/api/stats")
    start_scene = stats.get("scene") or "home"
    vp = stats.get("viewport") or {}
    if not vp:
        sys.exit("the page hasn't reported its viewport yet (wait 30 s after a reload)")

    today = dt.date.today().isoformat()
    commit = subprocess.run(["git", "-C", str(REPO), "log", "-1", "--format=%h %s"],
                            capture_output=True, text=True, check=True).stdout.strip()
    DEVLOG.mkdir(parents=True, exist_ok=True)
    saved = []
    try:
        for scene in args.scenes:
            sent = api(args.host, "/api/control", {"scene": scene})["sent_to"]
            if not sent:
                sys.exit("no page is listening on /api/events")
            time.sleep(SETTLE.get(scene, 6))
            png = ssh(args.host, "WAYLAND_DISPLAY=wayland-0 grim -", binary=True)
            img = Image.open(io.BytesIO(png)).convert("RGB")
            # The page fills the bottom of the screen; above it is the desktop panel.
            top = max(0, img.height - int(vp["height"] * img.height / vp.get("screen_height", img.height)))
            img = img.crop((0, top, img.width, img.height))
            name = f"{today}-{scene}.webp"
            n = 2
            while (DEVLOG / name).exists():
                name, n = f"{today}-{scene}-{n}.webp", n + 1
            img.save(DEVLOG / name, "WEBP", quality=args.quality, method=6)
            saved.append((scene, name))
            print(f"{scene}: docs/devlog/{name} ({(DEVLOG / name).stat().st_size // 1024} KB)")
    finally:
        api(args.host, "/api/control", {"scene": start_scene})

    readme = DEVLOG / "README.md"
    head = "# Devlog\n\nScreenshots of the dashboard on asus-arch's monitor as it changes, newest first.\n" \
           "Taken with `tools/snapshot.py`.\n\n"
    old = readme.read_text().split("\n\n", 2)[2] if readme.exists() else ""
    entry = f"## {today} · `{commit}`\n\n- TODO: what changed\n\n" + \
            "".join(f"![{scene}]({name})\n" for scene, name in saved) + "\n"
    readme.write_text(head + entry + old)
    print("added an entry to docs/devlog/README.md: fill in its TODO line")


if __name__ == "__main__":
    main()
