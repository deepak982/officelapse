#!/usr/bin/env bash
set -euo pipefail

export PORT=${PORT:-8777}
export HOURS=${HOURS:-24}
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The process argv is just "server.py", so `pkill -f officelapse/server.py` never
# matches it. Find whoever owns the port instead -- but only ever kill our own
# server: on a busy machine that port may belong to something you care about.
if command -v lsof >/dev/null; then
  for pid in $(lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do
    if ps -p "$pid" -o args= 2>/dev/null | grep -q '[s]erver\.py'; then
      echo "officelapse: restarting (pid $pid was on :$PORT)" >&2
      kill "$pid" 2>/dev/null || true
    else
      echo "officelapse: port $PORT is held by pid $pid, which is not officelapse:" >&2
      ps -p "$pid" -o args= >&2 || true
      echo "  run PORT=9000 ./run.sh, or stop that process yourself." >&2
      exit 1
    fi
  done
elif command -v fuser >/dev/null; then
  echo "officelapse: lsof not found; freeing port $PORT with fuser" >&2
  fuser -k "$PORT"/tcp >/dev/null 2>&1 || true
fi

if ! command -v python3 >/dev/null; then
  echo "officelapse needs python3 on PATH" >&2; exit 1
fi

# per-user path, and readable only by you: on a shared machine a fixed name in
# /tmp is both a collision and someone else's symlink waiting to be followed
LOG="${TMPDIR:-/tmp}/officelapse.$(id -u).log"
rm -f "$LOG"; : >"$LOG"; chmod 600 "$LOG"
nohup python3 server.py >>"$LOG" 2>&1 &

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
tail -20 "$LOG" >&2
exit 1
