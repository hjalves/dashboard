#!/bin/bash
# Deploy to asus-arch (or $HOST): copies the committed tree, syncs the uv env, installs the
# user service, the kiosk launcher and its autostart entry, then restarts the server.
# The open page reloads itself when the static files change.
set -euo pipefail
HOST=${HOST:-dk@asus-arch.local}
cd "$(dirname "$0")/.."
git diff --quiet HEAD -- . || echo "warning: uncommitted changes are NOT deployed" >&2

git archive --format=tar HEAD | ssh "$HOST" '
  set -e
  APP=~/apps/dashboard
  rm -rf "$APP.new" && mkdir -p "$APP.new" && tar -x -C "$APP.new"
  [ -d "$APP/.venv" ] && mv "$APP/.venv" "$APP.new/.venv"
  rm -rf "$APP" && mv "$APP.new" "$APP"
  cd "$APP"
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
'
