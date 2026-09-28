#!/usr/bin/env bash
set -euo pipefail

export PORT=${PORT:-8777}
export HOURS=${HOURS:-24}
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The process argv is just "server.py", so `pkill -f officelapse/server.py`
# never matches it. Kill whatever owns the port instead. lsof is missing on some
# minimal Linux images, so fall back to fuser, then just carry on.
if command -v lsof >/dev/null; then
  lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null || true
elif command -v fuser >/dev/null; then
  fuser -k "$PORT"/tcp >/dev/null 2>&1 || true
fi

if ! command -v python3 >/dev/null; then
  echo "officelapse needs python3 on PATH" >&2; exit 1
fi

nohup python3 server.py >/tmp/officelapse.log 2>&1 &

for _ in $(seq 50); do
  # quote the URL: the `?` is a glob character in zsh/bash
  if curl -fsS "http://localhost:$PORT/api/state?since=0" >/dev/null 2>&1; then
    echo "officelapse -> http://localhost:$PORT  (last ${HOURS}h)"
    if command -v open >/dev/null; then open "http://localhost:$PORT"
    elif command -v xdg-open >/dev/null; then xdg-open "http://localhost:$PORT" >/dev/null 2>&1 || true
    fi
    exit 0
  fi
  sleep 0.2
done

echo "officelapse: nothing answered on port $PORT after 10s" >&2
tail -20 /tmp/officelapse.log >&2
exit 1
