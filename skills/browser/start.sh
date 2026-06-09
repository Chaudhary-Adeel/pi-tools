#!/usr/bin/env bash
# start.sh — launch a Chromium browser with remote debugging enabled.
# Auto-detects installed browser. Skips if CDP port is already in use.
set -euo pipefail

PORT="${1:-9222}"
PROFILE_DIR="${HOME}/.pi/browser-profile"

# ── check if port is already in use ──────────────────────────────────────
if lsof -i ":${PORT}" &>/dev/null || ss -tlnp 2>/dev/null | grep -q ":${PORT}"; then
  echo "⚠ Port ${PORT} is already in use — assuming browser is already running." >&2
  exit 0
fi

# ── find a browser ───────────────────────────────────────────────────────
BROWSER=""
for candidate in \
  "google-chrome-stable" \
  "google-chrome" \
  "brave-browser" \
  "brave-browser-stable" \
  "chromium-browser" \
  "chromium" \
  "microsoft-edge" \
  "microsoft-edge-stable" \
  "opera" \
  "vivaldi" \
  "arc"; do
  if command -v "$candidate" &>/dev/null; then
    BROWSER="$candidate"
    break
  fi
done

if [ -z "$BROWSER" ]; then
  echo "✗ No supported browser found. Install Chrome, Brave, Chromium, or Edge." >&2
  echo "  macOS:  brew install --cask google-chrome" >&2
  echo "  Linux:  sudo apt install chromium-browser" >&2
  exit 1
fi

# ── launch ───────────────────────────────────────────────────────────────
mkdir -p "$PROFILE_DIR"

echo "→ Launching $BROWSER on port $PORT (profile: $PROFILE_DIR)" >&2
"$BROWSER" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-sync \
  --disable-extensions \
  --disable-background-networking \
  &>/dev/null &
disown

echo "✓ Browser launched on port $PORT" >&2
