#!/usr/bin/env python3
"""officelapse — serves your Claude Code sessions as a boss -> team tree.

On disk:
  ~/.claude/projects/<proj>/<sessionId>.jsonl                      the boss
  ~/.claude/projects/<proj>/<sessionId>/subagents/agent-<id>.jsonl one per teammate

Stdlib only.  Run:  python3 server.py   ->  http://localhost:8777
"""
import glob, http.server, json, os, re, socketserver, time, urllib.parse
from datetime import datetime

def _find_root():
    """Where this machine keeps its Claude Code session logs.

    Claude Code honours CLAUDE_CONFIG_DIR to relocate ~/.claude, so hardcoding
    the home path breaks on any machine that uses it.
    """
    override = os.environ.get("OFFICELAPSE_ROOT")
    if override:
        return os.path.expanduser(override)
    cfg = os.environ.get("CLAUDE_CONFIG_DIR")
    if cfg:
        return os.path.join(os.path.expanduser(cfg), "projects")
    return os.path.expanduser("~/.claude/projects")


ROOT = _find_root()
HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", 8777))
WINDOW = float(os.environ.get("HOURS", 24)) * 3600
MAX_EVENTS = 40000
# Session logs reach hundreds of MB. Never slurp a whole one: on first sight of a
# large file, start from its tail (only the window matters anyway), and cap how
# much any single pass reads so a big append can't stall the loop.
FIRST_READ_MAX = 8 * 1024 * 1024
CHUNK_MAX = 4 * 1024 * 1024

_off = {}       # file path -> bytes already parsed
_ev = []        # events, kept sorted by .t
_ses = {}       # session id -> boss metadata
_agents = {}    # agent id  -> teammate metadata
# Drift watch: officelapse reads a private log format. If a release renames fields
# or moves subagents/, we still find and read the files but recognise nothing in
# them -- an empty floor that looks exactly like "no sessions yet". These counters
# ride along with the parse we already do so the two can be told apart.
_health = {"files": 0, "unreadable_files": 0, "bytes": 0, "lines": 0,
           "unrecognised": 0, "events": 0}


def _ts(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def _base(p):
    p = str(p or "")
    return os.path.basename(p.rstrip("/")) or p or "?"


def label(tool, inp):
    """Tool call -> what the worker would say they're doing."""
    inp = inp if isinstance(inp, dict) else {}
    if tool == "Bash":
        c = str(inp.get("command", "")).strip()
        for _ in range(4):                       # peel "cd x && ", "VAR=... ", "( "
            m = re.match(r"\s*(?:cd\s+\S+\s*&&\s*|[A-Za-z_]\w*=\S*\s+|\(\s*)", c)
            if not m or not m.end():
                break
            c = c[m.end():]
        w = c.split()[0] if c.split() else ""
        return "running " + (_base(w)[:18] if w else "a command")
    if tool in ("Read", "Edit", "Write", "NotebookEdit"):
        verb = {"Read": "reading", "Edit": "editing",
                "Write": "writing", "NotebookEdit": "editing"}[tool]
        return f"{verb} {_base(inp.get('file_path') or inp.get('notebook_path'))}"
    if tool == "Grep":
        return "grepping " + str(inp.get("pattern", ""))[:24]
    if tool == "Glob":
        return "hunting " + str(inp.get("pattern", ""))[:24]
    if tool in ("Task", "Agent"):
        return "briefing " + str(inp.get("description") or inp.get("subagent_type", "a teammate"))[:28]
    if tool in ("WebFetch", "WebSearch"):
        return "looking it up online"
    if tool == "TodoWrite":
        return "updating the plan"
    if tool == "AskUserQuestion":
        return "asking the boss"
    if tool in ("ExitPlanMode", "EnterPlanMode"):
        return "drawing up a plan"
    if tool == "SendMessage":
        return "messaging " + str(inp.get("to", "a teammate"))[:18]
    if tool == "Skill":
        return "reading the " + str(inp.get("skill", "manual"))[:24] + " manual"
    if tool in ("Artifact", "ArtifactData"):
        return "publishing a page"
    if tool.startswith("mcp__"):
        return "calling " + tool.split("__")[1]
    return tool


def _clean_task(text):
    """First line of a teammate's brief -> a short job title."""
    t = str(text or "").strip().split("\n")[0]
    t = re.sub(r"^(you are|your task is to|please)\s+", "", t, flags=re.I)
    return t[:52] or "a task"


def _session(sid, d, proj):
    s = _ses.get(sid)
    if s is None:
        s = _ses[sid] = {"sid": sid, "proj": proj, "title": "", "cwd": "",
                         "branch": "", "model": "", "agents": []}
    for src, dst in (("cwd", "cwd"), ("gitBranch", "branch"), ("aiTitle", "title")):
        if d.get(src):
            s[dst] = d[src]
    if s["cwd"]:
        s["proj"] = _base(s["cwd"])
    return s


def _parse(path, sid, aid, proj, cutoff):
    """Incrementally read one jsonl. aid=None for a boss file."""
    try:
        st = os.stat(path)
    except OSError:
        return
    if st.st_mtime < cutoff:
        return
    off = _off.get(path, 0)
    if st.st_size < off:            # truncated or rotated
        off = 0
    if st.st_size == off:
        return
    try:
        with open(path, "rb") as f:
            if off == 0 and st.st_size > FIRST_READ_MAX:
                f.seek(st.st_size - FIRST_READ_MAX)
                f.readline()        # discard the partial line we landed mid-way into
                off = f.tell()
            else:
                f.seek(off)
            chunk = f.read(CHUNK_MAX)
    except OSError:                 # unreadable (permissions) or gone since the stat
        _health["unreadable_files"] += 1
        return                      # skip this file, keep scanning the rest
    nl = chunk.rfind(b"\n")          # whole lines only; resume mid-write next poll
    if nl < 0:
        return
    _off[path] = off + nl + 1
    _health["bytes"] += nl + 1

    for raw in chunk[:nl].split(b"\n"):
        if not raw.strip():
            continue
        _health["lines"] += 1
        try:
            d = json.loads(raw)
        except Exception:
            _health["unrecognised"] += 1
            continue
        s = _session(sid, d, proj)
        key = f"{sid}/{aid}" if aid else None
        if aid:
            a = _agents.get(key)
            if a is None:
                a = _agents[key] = {"aid": aid, "key": key, "sid": sid, "name": "", "model": ""}
                if aid not in s["agents"]:
                    s["agents"].append(aid)
        t = _ts(d.get("timestamp"))
        kind, msg = d.get("type"), (d.get("message") or {})
        if kind not in ("user", "assistant"):
            _health["unrecognised"] += 1

        if kind == "user":
            c = msg.get("content")
            if isinstance(c, str) and c.strip():
                if aid:
                    if not _agents[key]["name"]:          # first brief = the job title
                        _agents[key]["name"] = _clean_task(c)
                elif t >= cutoff:
                    _ev.append({"t": t, "sid": sid, "aid": None, "kind": "prompt",
                                "tool": "", "say": c.strip().split("\n")[0][:70]})
        elif kind == "assistant":
            if msg.get("model"):
                (_agents[key] if aid else s)["model"] = msg["model"]
            if t < cutoff:
                continue
            for c in (msg.get("content") or []):
                if isinstance(c, dict) and c.get("type") == "tool_use":
                    _ev.append({"t": t, "sid": sid, "aid": aid, "kind": "tool",
                                "tool": c.get("name", "?"),
                                "say": label(c.get("name", "?"), c.get("input"))})


def scan():
    cutoff = time.time() - WINDOW
    n = len(_ev)
    _health["files"] = _health["unreadable_files"] = 0
    for path in glob.glob(os.path.join(ROOT, "*", "*.jsonl")):          # bosses
        _health["files"] += 1
        proj = _base(os.path.dirname(path)).split("-")[-1]
        _parse(path, _base(path)[:-6], None, proj, cutoff)
    for path in glob.glob(os.path.join(ROOT, "*", "*", "subagents", "agent-*.jsonl")):
        _health["files"] += 1
        sid = _base(os.path.dirname(os.path.dirname(path)))             # dir name == parent
        proj = _base(os.path.dirname(os.path.dirname(os.path.dirname(path)))).split("-")[-1]
        _parse(path, sid, _base(path)[6:-6], proj, cutoff)
    _health["events"] += len(_ev) - n
    if len(_ev) != n:
        _ev.sort(key=lambda e: e["t"])
        if len(_ev) > MAX_EVENTS:
            del _ev[:len(_ev) - MAX_EVENTS]


def health():
    """Did the last scan actually understand the logs? Reads counters only."""
    h = dict(_health, root=ROOT)
    if not h["files"]:
        code = "no_logs"
        msg = (f"no session logs found under {ROOT} — the floor stays empty until a"
               " Claude Code session writes there. Set OFFICELAPSE_ROOT if your logs"
               " live elsewhere.")
    elif h["lines"] and h["lines"] == h["unrecognised"]:
        code = "unreadable_format"
        msg = (f"read {h['lines']} lines from {h['files']} log file(s) under {ROOT} and"
               " recognised none of them. officelapse reads Claude Code's private log"
               " format (verified against 2.1.x); your Claude Code version may write a"
               " newer one. Check OFFICELAPSE_ROOT points at the right directory.")
    else:
        code = "ok"
        msg = (f"{h['files']} log file(s), {h['lines']} lines read,"
               f" {h['events']} events")
    if h["unreadable_files"]:       # worth saying, but never changes the verdict
        msg += f" ({h['unreadable_files']} file(s) could not be read)"
    return dict(h, ok=code == "ok", code=code, message=msg)


class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/state":
            scan()
            since = float(urllib.parse.parse_qs(u.query).get("since", ["0"])[0])
            body = json.dumps({
                "now": time.time(),
                "start": time.time() - WINDOW,
                "sessions": _ses,
                "agents": _agents,
                "events": [e for e in _ev if e["t"] > since],
                "health": health(),
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.path = "/index.html" if u.path == "/" else u.path
        return super().do_GET()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    os.chdir(HERE)
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H) as s:
        print(f"officelapse -> http://localhost:{PORT}  (last {WINDOW/3600:g}h)")
        print(f"  reading {ROOT}")
        if not os.path.isdir(ROOT):
            print("  note: that directory does not exist yet — the floor stays empty"
                  " until a Claude Code session writes there."
                  " Set OFFICELAPSE_ROOT if your logs live elsewhere.")
        scan()
        h = health()
        if os.path.isdir(ROOT):          # the note above already covers a missing dir
            print(f"  {'reading' if h['ok'] else h['code']}: {h['message']}")
        s.serve_forever()
