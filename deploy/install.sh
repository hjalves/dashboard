#!/bin/bash
# Deploy to asus-arch (or $HOST). ~/apps/dashboard there is a git clone of the GitHub repo:
# this pulls the pushed main (fast-forward only, refusing if the checkout has local changes),
# syncs the uv env, installs the user service, the browser launcher and its autostart entry,
# then restarts the server. The open page reloads itself when the static files change.
set -euo pipefail
HOST=${HOST:-dk@asus-arch.local}
REPO=${REPO:-git@github.com:hjalves/dashboard.git}
cd "$(dirname "$0")/.."

git fetch -q origin
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    echo "warning: local HEAD is not origin/main; deploying origin/main ($(git rev-parse --short origin/main))" >&2
fi

ssh "$HOST" REPO="$REPO" bash -s <<'EOF'
set -euo pipefail
APP=~/apps/dashboard
if [ ! -d "$APP/.git" ]; then
    # First deploy, or converting an old snapshot install: clone, keep the existing .venv.
    rm -rf "$APP.new"
    git clone -q "$REPO" "$APP.new"
    if [ -d "$APP/.venv" ]; then mv "$APP/.venv" "$APP.new/.venv"; fi
    rm -rf "$APP"
    mv "$APP.new" "$APP"
fi
cd "$APP"
if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "error: $APP has local changes; commit or discard them first:" >&2
    git status --short >&2
    exit 1
fi
git pull -q --ff-only
echo "deployed $(git log -1 --format='%h %s')"
UV_PYTHON_PREFERENCE=only-managed uv sync --frozen --no-dev -q
install -Dm644 deploy/dashboard.service ~/.config/systemd/user/dashboard.service
install -Dm755 deploy/dashboard-kiosk ~/.local/bin/dashboard-kiosk
mkdir -p ~/.config/autostart
# Absolute path: the XFCE session PATH has no ~/.local/bin
sed "s|@HOME@|$HOME|" deploy/dashboard-kiosk.desktop > ~/.config/autostart/dashboard-kiosk.desktop
mkdir -p ~/.config/dashboard
[ -f ~/.config/dashboard/config.toml ] || cp config.example.toml ~/.config/dashboard/config.toml
systemctl --user daemon-reload
systemctl --user enable -q dashboard.service
systemctl --user restart dashboard.service
sleep 2
systemctl --user --no-pager --lines=5 status dashboard.service | head -12
EOF
