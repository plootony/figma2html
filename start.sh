#!/usr/bin/env bash
# Starts the site2figma server (if not already running) and opens it in the browser.
cd "$(dirname "$(readlink -f "$0")")"
PORT="${PORT:-4747}"
URL="http://localhost:$PORT"

if ! curl -s -o /dev/null "$URL"; then
  setsid nohup node server.mjs > server.log 2>&1 < /dev/null &
  for _ in $(seq 1 50); do
    curl -s -o /dev/null "$URL" && break
    sleep 0.2
  done
fi
xdg-open "$URL" >/dev/null 2>&1 &
