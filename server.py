#!/usr/bin/env python3
"""officelapse — serves your Claude Code sessions as a boss -> team tree.

On disk:
  ~/.claude/projects/<proj>/<sessionId>.jsonl                      the boss
  ~/.claude/projects/<proj>/<sessionId>/subagents/agent-<id>.jsonl one per teammate

Stdlib only.  Run:  python3 server.py   ->  http://localhost:8777
"""
import glob, http.server, json, os, re, socketserver, threading, time, urllib.parse
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
_HOSTS = frozenset(f"{h}:{PORT}" for h in ("127.0.0.1", "localhost", "[::1]"))
MAX_EVENTS = 40000
# Session logs reach hundreds of MB. Never slurp a whole one: whenever the unread
# tail is larger than this, skip to the last FIRST_READ_MAX bytes -- on first sight
# of a big file, and again when the page was closed long enough for the log to run
# away from us. CHUNK_MAX then only ever has an <=8MB backlog to drain.
FIRST_READ_MAX = 8 * 1024 * 1024
CHUNK_MAX = 4 * 1024 * 1024
GLOB_TTL = 15           # seconds a directory listing is reused for
SCAN_TTL = 1            # seconds before a poll re-scans rather than reusing the last

_off = {}       # file path -> bytes already parsed
_ev = []        # events, kept sorted by .t
_seen = set()   # identity of every event in _ev, so a re-read cannot double-count
_ses = {}       # session id -> boss metadata
_agents = {}    # agent id  -> teammate metadata
_seq = [0]      # monotonic cursor -- see _tick()
_lock = threading.Lock()          # scan() mutates every global above
_listed = [0.0, [], [], 0, None]  # when, boss paths, agent paths, session dirs, root
_scanned = [0.0]                  # when the last scan ran
# Drift watch: a renamed field leaves us reading files and recognising nothing,
# which looks exactly like "no sessions yet". Reset per scan, so a verdict is current.
_health = {"files": 0, "unreadable_files": 0, "lines": 0, "unrecognised": 0,
           "assistant_rows": 0, "tool_blocks": 0, "session_dirs": 0, "agent_files": 0}

# One fact, several names across releases: the first name a row carries wins.
# custom-title rows already needed this.
FIELDS = {"cwd": ("cwd",), "branch": ("gitBranch",),
          "title": ("aiTitle", "customTitle")}


def _tick():
    """Next value of the cursor the client polls with.

    `since` cannot be a timestamp. A tail seek or a CHUNK_MAX stop publishes rows
    whose own timestamps are older than ones already sent, and a timestamp filter
    drops those forever. A sequence is assigned on arrival instead, so a late row
    always carries a new high, reaches the client, and is sorted into place there.
    """
    _seq[0] += 1
    return _seq[0]


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


def _ident(e):
    return e.get("uid") or (e["t"], e["sid"], e["aid"], e["tool"], e["say"])


def _add(e):
    """Append an event at most once, stamped with its arrival sequence.

    A rotated or truncated file resets its offset to 0 and is read again from the
    top, so rows already in the timeline arrive a second time. Identity is the
    row's own uuid plus the tool's index within it -- every user/assistant row on
    a real machine carries one, and those are the only rows that get here. The
    (time, session, agent, tool, label) tuple is the fallback for rows without.
    Trimmed with _ev in scan(), so it stays bounded by MAX_EVENTS.
    """
    k = _ident(e)
    if k not in _seen:
        _seen.add(k)
        e["seq"] = _tick()
        _ev.append(e)


def _session(sid, d, proj):
    s = _ses.get(sid)
    if s is None:
        s = _ses[sid] = {"sid": sid, "proj": proj, "title": "", "cwd": "",
                         "branch": "", "model": "", "agents": [], "_m": _tick()}
    for dst, names in FIELDS.items():
        for src in names:
            if d.get(src):
                if s[dst] != d[src]:
                    s[dst], s["_m"] = d[src], _tick()
                break
    if s["cwd"] and s["proj"] != _base(s["cwd"]):
        s["proj"], s["_m"] = _base(s["cwd"]), _tick()
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
            # Gated on the size of the unread tail, not on off == 0: a page closed
            # overnight leaves an offset that CHUNK_MAX alone would take minutes to
            # walk forward, showing an idle room the whole way.
            if st.st_size - off > FIRST_READ_MAX:
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
        # Older Claude Code wrote a teammate's turns inline in the boss's own file,
        # flagged isSidechain, instead of in subagents/. Credit those to a stand-in
        # teammate so they do not inflate the boss.
        raid = aid
        if raid is None and d.get("isSidechain"):
            raid = str(d.get("agentId") or "inline")
        key = f"{sid}/{raid}" if raid else None
        if raid:
            a = _agents.get(key)
            if a is None:
                a = _agents[key] = {"aid": raid, "key": key, "sid": sid, "model": "",
                                    "name": "" if aid else "inline teammate",
                                    "_m": _tick()}
                if raid not in s["agents"]:
                    s["agents"].append(raid)
                    s["_m"] = _tick()
        t = _ts(d.get("timestamp"))
        if not t:               # unparseable timestamp: the row is dropped by the
            _health["unrecognised"] += 1        # cutoff below, so count it as drift

        kind, msg = d.get("type"), (d.get("message") or {})
        if kind == "user":
            c = msg.get("content")
            if isinstance(c, str) and c.strip():
                if raid:
                    if _agents[key]["name"] in ("", "inline teammate"):   # first brief = job title
                        _agents[key]["name"] = _clean_task(c)
                        _agents[key]["_m"] = _tick()
                elif t >= cutoff:
                    _add({"t": t, "sid": sid, "aid": None, "kind": "prompt",
                          "tool": "", "say": c.strip().split("\n")[0][:70],
                          "uid": d.get("uuid")})
        elif kind == "assistant":
            if msg.get("model"):
                tgt = _agents[key] if raid else s
                if tgt["model"] != msg["model"]:
                    tgt["model"], tgt["_m"] = msg["model"], _tick()
            if t < cutoff:
                continue
            _health["assistant_rows"] += 1
            uu = d.get("uuid")
            for ci, c in enumerate(msg.get("content") or []):
                if isinstance(c, dict) and c.get("type") == "tool_use":
                    _health["tool_blocks"] += 1
                    _add({"t": t, "sid": sid, "aid": raid, "kind": "tool",
                          "tool": c.get("name", "?"),
                          "say": label(c.get("name", "?"), c.get("input")),
                          "uid": "%s#%d" % (uu, ci) if uu else None})


def _listing():
    """Boss files, agent files and session-directory count, re-globbed every GLOB_TTL.

    Listing the tree costs more than reading the handful of files inside the window,
    and it is the same answer 7 polls running. A session that appears mid-interval
    shows up late by at most GLOB_TTL seconds.
    """
    if _listed[4] != ROOT or time.time() - _listed[0] > GLOB_TTL:
        # Any depth: a teammate may itself spawn a team. A grandchild flattens into
        # the same session's roster -- cheap, and nothing is silently dropped.
        _listed[1] = glob.glob(os.path.join(ROOT, "*", "*.jsonl"))
        _listed[2] = glob.glob(os.path.join(ROOT, "**", "subagents", "agent-*.jsonl"),
                               recursive=True)
        # Session directories exist whatever is inside them, so they stay a valid
        # denominator even if subagents/ is renamed out from under us.
        _listed[3] = len(glob.glob(os.path.join(ROOT, "*", "*", "")))
        _listed[0], _listed[4] = time.time(), ROOT
    return _listed[1], _listed[2], _listed[3]


def scan():
    cutoff = time.time() - WINDOW
    n = len(_ev)
    for k in _health:
        _health[k] = 0
    bosses, agents, dirs = _listing()
    _health["session_dirs"] = dirs
    _health["agent_files"] = len(agents)
    _health["files"] = len(bosses) + len(agents)
    for path in bosses:
        proj = _base(os.path.dirname(path)).split("-")[-1]
        _parse(path, _base(path)[:-6], None, proj, cutoff)
    for path in agents:
        rel = os.path.relpath(path, ROOT).split(os.sep)   # <proj>/<sid>/.../agent-*.jsonl
        if len(rel) < 4:
            continue                                      # no session directory above it
        _parse(path, rel[1], _base(path)[6:-6], rel[0].split("-")[-1], cutoff)
    if len(_ev) != n:
        _ev.sort(key=lambda e: e["t"])
        if len(_ev) > MAX_EVENTS:
            for e in _ev[:len(_ev) - MAX_EVENTS]:
                _seen.discard(_ident(e))
            del _ev[:len(_ev) - MAX_EVENTS]


def health():
    """Did the last scan actually understand the logs? Reads counters only.

    Every verdict below has to stay clear of one trap: a machine whose activity all
    predates the window parses perfectly and yields nothing, and must never be
    accused of drift. So each one is a ratio against what this scan actually read,
    never against how much ended up on the floor.
    """
    h = dict(_health, root=ROOT, events=len(_ev))
    if not h["files"]:
        code = "no_logs"
        msg = (f"no session logs found under {ROOT} — the floor stays empty until a"
               " Claude Code session writes there. Set OFFICELAPSE_ROOT if your logs"
               " live elsewhere.")
    elif h["lines"] and h["unrecognised"] / h["lines"] > 0.9:
        code = "unreadable_format"
        msg = (f"read {h['lines']} lines from {h['files']} log file(s) under {ROOT} and"
               " recognised almost none of them. officelapse reads Claude Code's private"
               " log format (verified against 2.1.x); your Claude Code version may write"
               " a newer one. Check OFFICELAPSE_ROOT points at the right directory.")
    elif h["assistant_rows"] > 20 and not h["tool_blocks"]:
        code = "no_tool_calls"
        msg = (f"{h['assistant_rows']} assistant turns in the window carried no tool"
               " calls at all. Everyone on the floor is driven by tool calls, so the"
               " rooms will look asleep. Claude Code has probably renamed the tool_use"
               " content block.")
    elif h["session_dirs"] and not h["agent_files"]:
        code = "no_subagents"
        msg = (f"{h['session_dirs']} session director(ies) under {ROOT} but no"
               " subagents/agent-*.jsonl inside any of them, so rooms will show a boss"
               " and no teammates. Claude Code has probably moved where subagent logs"
               " are written.")
    else:
        code = "ok"
        msg = (f"{h['files']} log file(s), {h['lines']} lines read,"
               f" {h['events']} events")
    if h["unreadable_files"]:       # worth saying, but never changes the verdict
        msg += f" ({h['unreadable_files']} file(s) could not be read)"
    return dict(h, ok=code == "ok", code=code, message=msg)


class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        # DNS rebinding: a page can point its own hostname at 127.0.0.1 and read the
        # reply as same-origin. The Host header still names it. Not a URL token —
        # those leak through history and screen-shares.
        if self.headers.get("Host") not in _HOSTS:
            self.send_error(403, "Host not allowed")
            return
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/state":
            try:
                since = float(urllib.parse.parse_qs(u.query).get("since", ["0"])[0])
            except ValueError:
                since = 0.0
            # The sequence restarts at 0 with the process, but an open page keeps
            # counting from where the last one left off. A cursor ahead of anything
            # we have ever issued can only be from an older server, and filtering
            # against it would send that page nothing for as long as it stays open.
            if since > _seq[0]:
                since = 0.0
            with _lock:                 # scan() mutates globals this then serialises
                if time.time() - _scanned[0] > SCAN_TTL:
                    scan()
                    _scanned[0] = time.time()
                body = json.dumps({
                    "now": time.time(),
                    "start": time.time() - WINDOW,
                    # Metadata is incremental too: re-sending every session and
                    # teammate on every poll was 94% of the response.
                    "sessions": {k: v for k, v in _ses.items() if v["_m"] > since},
                    "agents": {k: v for k, v in _agents.items() if v["_m"] > since},
                    "events": [e for e in _ev if e["seq"] > since],
                    "health": health(),
                }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.path = "/index.html" if u.path == "/" else u.path
        return super().do_GET()

    def do_HEAD(self):
        # same guard as do_GET: HEAD leaks no body, but it should not answer a
        # rebound origin either, and it has its own handler
        if self.headers.get("Host") not in _HOSTS:
            self.send_error(403, "Host not allowed")
            return
        return super().do_HEAD()

    def end_headers(self):
        # Everything is on localhost, so caching buys nothing and costs a whole
        # class of bug: the browser held a stale props.js against a fresh scene.js
        # and the floor rendered black with one TypeError.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

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
