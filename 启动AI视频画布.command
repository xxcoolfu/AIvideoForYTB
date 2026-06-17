#!/bin/zsh
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="4173"
PID_FILE="$APP_DIR/.server.pid"
LOG_FILE="$APP_DIR/server.log"
URL="http://127.0.0.1:$PORT/"
HEALTH_URL="http://127.0.0.1:$PORT/api/health"

cd "$APP_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先安装 Node.js，再重新双击启动。"
  read -r "?按回车关闭窗口。"
  exit 1
fi

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" >/dev/null 2>&1; then
    kill "$OLD_PID" >/dev/null 2>&1 || true
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

for PID in $(lsof -ti tcp:$PORT 2>/dev/null || true); do
  kill "$PID" >/dev/null 2>&1 || true
done

nohup node server.js > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

READY=""
for _ in {1..30}; do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    READY="1"
    break
  fi
  if ! kill -0 "$(cat "$PID_FILE" 2>/dev/null)" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if [ -z "$READY" ]; then
  echo "AI 视频画布服务没有按时启动，浏览器暂不打开，避免空白页。"
  echo "请查看日志文件：$LOG_FILE"
  tail -n 20 "$LOG_FILE" 2>/dev/null || true
  read -r "?按回车关闭窗口。"
  exit 1
fi

open "$URL"

echo "AI 视频画布已启动：$URL"
echo "日志文件：$LOG_FILE"
echo "可以关闭这个窗口，服务会继续在后台运行。"
