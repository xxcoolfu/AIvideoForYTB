#!/bin/zsh
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="4173"
PID_FILE="$APP_DIR/.server.pid"

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" >/dev/null 2>&1; then
    kill "$OLD_PID" >/dev/null 2>&1 || true
  fi
  rm -f "$PID_FILE"
fi

for PID in $(lsof -ti tcp:$PORT 2>/dev/null || true); do
  kill "$PID" >/dev/null 2>&1 || true
done

echo "AI 视频画布服务已停止。"
