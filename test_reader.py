#!/usr/bin/env python3
"""Edge-case self-check for server.py's log reader.  Run: python3 test_reader.py

Plain asserts, no pytest.  Each check builds throwaway fixtures under a temp
ROOT, so the real ~/.claude/projects is never touched or read.
Ids match the rows in EDGE_CASES.md.
"""
import json, os, shutil, sys, tempfile, time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server as sv

FAILS = []
TMPS = []


# --- fixture helpers --------------------------------------------------------

def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z")


def tool_row(t, sid, tool="Read", inp=None, model="claude-boss"):
    return {"type": "assistant", "timestamp": iso(t), "sessionId": sid,
            "message": {"model": model,
                        "content": [{"type": "tool_use", "name": tool,
                                     "input": inp if inp is not None else {"file_path": "/a/b.txt"}}]}}


def user_row(t, sid, text, **extra):
    d = {"type": "user", "timestamp": iso(t), "sessionId": sid,
         "message": {"content": text}}
    d.update(extra)
    return d


def write(path, rows, mode="w", newline=True):
    """Rows may be dicts or raw strings (for malformed / partial lines)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    body = "".join((r if isinstance(r, str) else json.dumps(r)) + "\n" for r in rows)
    if not newline and body.endswith("\n"):
        body = body[:-1]
    with open(path, mode) as f:
        f.write(body)
    return path


def newroot():
    d = tempfile.mkdtemp(prefix="officelapse-test-")
    TMPS.append(d)
    return d


def reset(root):
    """Point the module at a throwaway ROOT and wipe every cache it keeps."""
    sv.ROOT = root
    sv._off.clear()
    sv._ev.clear()
    sv._seen.clear()
    sv._ses.clear()
    sv._agents.clear()
    # the directory listing is cached at poll rate in normal use; these tests write
    # files between scans, so they need to see the disk as it is right now
    sv.GLOB_TTL = 0
    sv._listed[:] = [0.0, [], [], 0, None]
    return root


def says():
    return [e["say"] for e in sv._ev]


def tools():
    return [e["tool"] for e in sv._ev]


def check(cid, desc, fn):
    try:
        fn()
    except Exception as e:
        FAILS.append((cid, desc, e))
        print(f"FAIL {cid} {desc}  ->  {type(e).__name__}: {e}")
    else:
        print(f"PASS {cid} {desc}")


# --- A. finding and reading the logs ---------------------------------------

def a1():
    root = reset(os.path.join(newroot(), "does", "not", "exist"))
    assert not os.path.isdir(root)
    sv.scan()
    assert sv._ev == [] and sv._ses == {} and sv._agents == {}, "expected nothing found"


def a2():
    reset(newroot())
    sv.scan()
    assert sv._ev == [] and sv._ses == {} and sv._agents == {}, "expected nothing found"


def a4():
    root = reset(newroot())
    now = time.time()
    p = os.path.join(root, "-Users-t-big", "sbig.jsonl")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    # a RECENT event at byte 0: if the head were read, it would show up.
    head = json.dumps(tool_row(now - 60, "sbig", "Read", {"file_path": "/head_marker.txt"})) + "\n"
    pad = json.dumps({"type": "assistant", "timestamp": iso(now - 86400 * 400),
                      "sessionId": "sbig", "message": {"model": "m", "content": []},
                      "pad": "x" * 180}) + "\n"
    tail = "".join(json.dumps(tool_row(now - 30 + i, "sbig", n, {"pattern": "tailmark"}))
                   + "\n" for i, n in enumerate(("Grep", "Glob")))
    with open(p, "w") as f:
        f.write(head)
        f.write(pad * int((9.5 * 1024 * 1024) / len(pad)))
        f.write(tail)
    size = os.path.getsize(p)
    assert size > sv.FIRST_READ_MAX, size

    t0 = time.time()
    sv.scan()
    first_off = sv._off.get(p, 0)
    for _ in range(8):                      # each pass is capped at CHUNK_MAX
        if sv._off.get(p) == size:
            break
        sv.scan()
    elapsed = time.time() - t0

    assert first_off >= size - sv.FIRST_READ_MAX, \
        f"first read did not start from the tail: off={first_off} size={size}"
    assert sv._off.get(p) == size, f"offset never reached EOF: {sv._off.get(p)} != {size}"
    assert "reading head_marker.txt" not in says(), "head of a huge file was read"
    assert says().count("grepping tailmark") == 1, says()[:5]
    assert says().count("hunting tailmark") == 1, says()[:5]
    assert elapsed < 5.0, f"too slow: {elapsed:.2f}s"


def a5():
    root = reset(newroot())
    now = time.time()
    p = os.path.join(root, "-Users-t-app", "s5.jsonl")
    write(p, [tool_row(now - 300, "s5", "Read", {"file_path": "/one.txt"})])
    sv.scan()
    assert says() == ["reading one.txt"], says()
    write(p, [tool_row(now - 200, "s5", "Edit", {"file_path": "/two.txt"}),
              tool_row(now - 100, "s5", "Write", {"file_path": "/three.txt"})], mode="a")
    sv.scan()
    assert says() == ["reading one.txt", "editing two.txt", "writing three.txt"], says()
    sv.scan()                                # a third poll must add nothing
    assert says() == ["reading one.txt", "editing two.txt", "writing three.txt"], says()


def a5b():
    root = reset(newroot())
    now = time.time()
    p = os.path.join(root, "-Users-t-app", "s5b.jsonl")
    partial = json.dumps(tool_row(now - 100, "s5b", "Write", {"file_path": "/half.txt"}))
    cut = len(partial) - 25
    write(p, [tool_row(now - 300, "s5b", "Read", {"file_path": "/one.txt"}), partial[:cut]],
          newline=False)
    sv.scan()
    assert says() == ["reading one.txt"], f"partial line was parsed: {says()}"
    with open(p, "a") as f:                  # the rest of that same line lands
        f.write(partial[cut:] + "\n")
    sv.scan()
    assert says() == ["reading one.txt", "writing half.txt"], says()
    sv.scan()
    assert says().count("writing half.txt") == 1, says()


def a6():
    root = reset(newroot())
    now = time.time()
    p = os.path.join(root, "-Users-t-app", "s6.jsonl")
    write(p, [tool_row(now - 300, "s6", "Read", {"file_path": "/one.txt"}),
              tool_row(now - 290, "s6", "Read", {"file_path": "/two.txt"})])
    sv.scan()
    big = sv._off[p]
    assert big > 0
    write(p, [tool_row(now - 60, "s6", "Grep", {"pattern": "rotated"})])   # truncate + rewrite
    assert os.path.getsize(p) < big, "fixture must shrink below the stored offset"
    sv.scan()
    assert sv._off[p] == os.path.getsize(p), sv._off[p]
    assert "grepping rotated" in says(), says()


def a6b():
    root = reset(newroot())
    now = time.time()
    p = os.path.join(root, "-Users-t-app", "s6b.jsonl")
    old = [tool_row(now - 300 + i * 10, "s6b", "Read", {"file_path": "/one%d.txt" % i})
           for i in range(4)]
    write(p, old)
    sv.scan()
    assert says() == ["reading one%d.txt" % i for i in range(4)], says()
    big = sv._off[p]
    # rotated: the first two rows come back verbatim, the rest is new, and the
    # whole file is now shorter than the stored offset
    write(p, old[:2] + [tool_row(now - 60, "s6b", "Grep", {"pattern": "afterturn"})])
    assert os.path.getsize(p) < big, "fixture must shrink below the stored offset"
    sv.scan()
    assert says().count("reading one0.txt") == 1, says()
    assert says().count("reading one1.txt") == 1, says()
    assert says().count("grepping afterturn") == 1, says()
    assert len(sv._ev) == 5, says()          # 4 from before + 1 genuinely new


def a7():
    root = reset(newroot())
    now = time.time()
    p = os.path.join(root, "-Users-t-app", "s7.jsonl")
    write(p, [tool_row(now - 300, "s7", "Read", {"file_path": "/one.txt"}),
              '{"type":"assistant","timestamp":"2026',          # torn JSON
              "not json at all",
              tool_row(now - 100, "s7", "Read", {"file_path": "/two.txt"})])
    sv.scan()
    assert says() == ["reading one.txt", "reading two.txt"], says()


def a8():
    root = reset(newroot())
    p = os.path.join(root, "-Users-t-app", "empty.jsonl")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w").close()
    sv.scan()
    assert sv._ev == [] and sv._ses == {}, "zero-byte file produced state"


def a10():
    root = reset(newroot())
    now = time.time()
    # agent-*.jsonl directly in the project dir, NOT under <sid>/subagents/
    p = os.path.join(root, "-Users-t-app", "agent-stray.jsonl")
    write(p, [tool_row(now - 100, "agent-stray", "Read", {"file_path": "/stray.txt"})])
    sv.scan()
    assert "agent-stray" in sv._ses, f"stray agent file dropped: {list(sv._ses)}"
    assert says() == ["reading stray.txt"], says()
    assert [e["aid"] for e in sv._ev] == [None], "should be read as a session, not a teammate"


def a11():
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        print("  (a11 skipped: running as root, chmod 000 is still readable)")
        return
    root = reset(newroot())
    now = time.time()
    good = os.path.join(root, "-Users-t-app", "sgood.jsonl")
    bad = os.path.join(root, "-Users-t-app", "sbad.jsonl")
    write(good, [tool_row(now - 100, "sgood", "Read", {"file_path": "/ok.txt"})])
    write(bad, [tool_row(now - 100, "sbad", "Read", {"file_path": "/nope.txt"})])
    os.chmod(bad, 0o000)
    try:
        with open(bad, "rb"):
            print("  (a11 skipped: this filesystem still reads a chmod 000 file)")
            return
    except OSError:
        pass
    try:
        sv.scan()                            # must not raise
    finally:
        os.chmod(bad, 0o644)
    assert says() == ["reading ok.txt"], says()


# --- B. sessions ------------------------------------------------------------

def b123():
    root = reset(newroot())
    now = time.time()
    # no aiTitle, no cwd, no gitBranch anywhere in the file
    p = os.path.join(root, "-Users-t-bare", "sbare.jsonl")
    write(p, [user_row(now - 200, "sbare", "do the thing"),
              tool_row(now - 100, "sbare", "Read", {"file_path": "/bare.txt"})])
    sv.scan()
    s = sv._ses.get("sbare")
    assert s is not None, f"session not recorded: {list(sv._ses)}"
    assert s["title"] == "" and s["cwd"] == "" and s["branch"] == "", s
    assert s["proj"] == "bare", s            # falls back to the directory name
    assert "reading bare.txt" in says(), says()


def b4():
    root = reset(newroot())
    now = time.time()
    p = os.path.join(root, "-Users-t-app", "s4.jsonl")
    write(p, [tool_row(now - 600, "s4", "Read", {"file_path": "/first.txt"})])
    sv.scan()
    assert len(sv._ev) == 1, says()
    assert sv._ses["s4"]["branch"] == ""
    r = tool_row(now - 60, "s4", "Read", {"file_path": "/later.txt"})
    r["gitBranch"] = "develop"
    r["aiTitle"] = "Resumed run"
    write(p, [r], mode="a")
    sv.scan()
    assert says() == ["reading first.txt", "reading later.txt"], says()
    assert sv._ses["s4"]["branch"] == "develop" and sv._ses["s4"]["title"] == "Resumed run"


def b7():
    root = reset(newroot())
    old = time.time() - sv.WINDOW - 3600
    p = os.path.join(root, "-Users-t-app", "sold.jsonl")
    write(p, [user_row(old, "sold", "ancient prompt"),
              tool_row(old + 5, "sold", "Read", {"file_path": "/old.txt"})])
    sv.scan()
    assert sv._ev == [], f"events outside the window were kept: {says()}"
    assert "sold" in sv._ses, "session should still be recorded"


# --- C. subagents -----------------------------------------------------------

def c1():
    root = reset(newroot())
    now = time.time()
    aid = "shared01"
    for sid, name, model, f in (("sesA", "You are Nikhil, the tester", "claude-a", "/a.txt"),
                                ("sesB", "You are Vikram, the builder", "claude-b", "/b.txt")):
        p = os.path.join(root, "-Users-t-app", sid, "subagents", f"agent-{aid}.jsonl")
        r = tool_row(now - 100, sid, "Read", {"file_path": f})
        r["message"]["model"] = model
        write(p, [user_row(now - 200, sid, name), r])
    sv.scan()
    ka, kb = f"sesA/{aid}", f"sesB/{aid}"
    assert set(sv._agents) == {ka, kb}, f"agent id collapsed across sessions: {list(sv._agents)}"
    assert sv._agents[ka]["name"] == "Nikhil, the tester", sv._agents[ka]
    assert sv._agents[kb]["name"] == "Vikram, the builder", sv._agents[kb]
    assert sv._agents[ka]["model"] == "claude-a", sv._agents[ka]
    assert sv._agents[kb]["model"] == "claude-b", sv._agents[kb]
    assert sv._agents[ka]["sid"] == "sesA" and sv._agents[kb]["sid"] == "sesB"
    assert sv._ses["sesA"]["agents"] == [aid] and sv._ses["sesB"]["agents"] == [aid]
    pairs = sorted((e["sid"], e["aid"], e["say"]) for e in sv._ev)
    assert pairs == [("sesA", aid, "reading a.txt"), ("sesB", aid, "reading b.txt")], pairs


def c4():
    root = reset(newroot())
    now = time.time()
    p = os.path.join(root, "-Users-t-app", "sesC", "subagents", "agent-noname.jsonl")
    write(p, [tool_row(now - 100, "sesC", "Read", {"file_path": "/x.txt"})])
    sv.scan()
    a = sv._agents.get("sesC/noname")
    assert a is not None, f"agent not registered: {list(sv._agents)}"
    assert a["name"] == "", a
    assert says() == ["reading x.txt"], says()


def c5():
    root = reset(newroot())
    now = time.time()
    p = os.path.join(root, "-Users-t-app", "sesD", "subagents", "agent-quiet.jsonl")
    write(p, [user_row(now - 200, "sesD", "Please audit the config"),
              {"type": "assistant", "timestamp": iso(now - 100), "sessionId": "sesD",
               "message": {"model": "claude-q", "content": []}}])
    sv.scan()
    a = sv._agents.get("sesD/quiet")
    assert a is not None, f"silent agent not registered: {list(sv._agents)}"
    assert a["name"] == "audit the config", a
    assert a["model"] == "claude-q", a
    assert sv._ev == [], f"expected no events: {says()}"


def c6():
    root = reset(newroot())
    now = time.time()
    p = os.path.join(root, "-Users-t-app", "orphan-sid", "subagents", "agent-lone.jsonl")
    write(p, [user_row(now - 200, "orphan-sid", "You are the researcher"),
              tool_row(now - 100, "orphan-sid", "Grep", {"pattern": "needle"})])
    assert not os.path.exists(os.path.join(root, "-Users-t-app", "orphan-sid.jsonl"))
    sv.scan()
    assert "orphan-sid" in sv._ses, f"parentless agent lost its session: {list(sv._ses)}"
    assert sv._ses["orphan-sid"]["agents"] == ["lone"], sv._ses["orphan-sid"]
    assert [(e["sid"], e["aid"]) for e in sv._ev] == [("orphan-sid", "lone")], sv._ev


def c8():
    root = reset(newroot())
    now = time.time()
    sub = os.path.join(root, "-Users-t-app", "sesN", "subagents")
    write(os.path.join(sub, "agent-A.jsonl"),
          [user_row(now - 300, "sesN", "You are the child"),
           tool_row(now - 250, "sesN", "Read", {"file_path": "/child.txt"})])
    write(os.path.join(sub, "agent-A", "subagents", "agent-B.jsonl"),
          [user_row(now - 200, "sesN", "You are the grandchild"),
           tool_row(now - 100, "sesN", "Grep", {"pattern": "deep"})])
    sv.scan()
    assert "sesN/B" in sv._agents, "grandchild never read: %s" % list(sv._agents)
    assert sv._agents["sesN/B"]["sid"] == "sesN", sv._agents["sesN/B"]
    assert sv._agents["sesN/B"]["name"] == "the grandchild", sv._agents["sesN/B"]
    assert sorted(sv._ses["sesN"]["agents"]) == ["A", "B"], sv._ses["sesN"]
    seen = sorted((e["sid"], e["aid"], e["say"]) for e in sv._ev)
    assert seen == [("sesN", "A", "reading child.txt"),
                    ("sesN", "B", "grepping deep")], seen


def c9():
    root = reset(newroot())
    now = time.time()
    p = os.path.join(root, "-Users-t-app", "s9.jsonl")
    named = tool_row(now - 200, "s9", "Grep", {"pattern": "sidework"}, model="claude-side")
    named["isSidechain"] = True
    named["agentId"] = "ghost"
    anon = tool_row(now - 190, "s9", "Glob", {"pattern": "nameless"}, model="claude-side")
    anon["isSidechain"] = True                      # no id of its own
    write(p, [user_row(now - 300, "s9", "boss prompt"),
              tool_row(now - 250, "s9", "Read", {"file_path": "/boss.txt"}),
              user_row(now - 210, "s9", "You are the inline helper",
                       isSidechain=True, agentId="ghost"),
              named, anon,
              tool_row(now - 100, "s9", "Write", {"file_path": "/boss2.txt"})])
    sv.scan()
    boss = [e["say"] for e in sv._ev if e["aid"] is None]
    assert boss == ["boss prompt", "reading boss.txt", "writing boss2.txt"], boss
    side = [(e["aid"], e["say"]) for e in sv._ev if e["aid"] is not None]
    assert side == [("ghost", "grepping sidework"),
                    ("inline", "hunting nameless")], side
    assert sorted(sv._ses["s9"]["agents"]) == ["ghost", "inline"], sv._ses["s9"]
    assert sv._agents["s9/ghost"]["name"] == "the inline helper", sv._agents["s9/ghost"]
    assert sv._agents["s9/inline"]["name"] == "inline teammate", sv._agents["s9/inline"]
    # the sidechain's model must not be written onto the boss
    assert sv._agents["s9/ghost"]["model"] == "claude-side", sv._agents["s9/ghost"]
    assert sv._ses["s9"]["model"] == "claude-boss", sv._ses["s9"]


# --- D. time ----------------------------------------------------------------

def d1():
    root = reset(newroot())
    now = time.time()
    p = os.path.join(root, "-Users-t-app", "sd1.jsonl")
    write(p, [tool_row(datetime(2001, 9, 9, tzinfo=timezone.utc).timestamp(), "sd1",
                       "Read", {"file_path": "/bogus.txt"}),
              tool_row(now - 100, "sd1", "Read", {"file_path": "/fine.txt"})])
    sv.scan()
    assert says() == ["reading fine.txt"], f"pre-2020 event survived: {says()}"


def d2():
    root = reset(newroot())
    now = time.time()
    p = os.path.join(root, "-Users-t-app", "sd2.jsonl")
    bad = tool_row(now - 100, "sd2", "Read", {"file_path": "/bad.txt"})
    bad["timestamp"] = "not-a-timestamp"
    worse = tool_row(now - 100, "sd2", "Read", {"file_path": "/worse.txt"})
    del worse["timestamp"]
    write(p, [bad, worse, tool_row(now - 100, "sd2", "Read", {"file_path": "/fine.txt"})])
    assert sv._ts("not-a-timestamp") == 0.0 and sv._ts(None) == 0.0
    sv.scan()
    assert says() == ["reading fine.txt"], f"unparseable timestamp survived: {says()}"


def d4():
    root = reset(newroot())
    now = time.time()
    tie = now - 300
    p = os.path.join(root, "-Users-t-app", "sd4.jsonl")
    rows = [tool_row(now - 400, "sd4", "Read", {"file_path": "/before.txt"})]
    rows += [tool_row(tie, "sd4", "Read", {"file_path": f"/tie{i}.txt"}) for i in range(5)]
    rows += [tool_row(now - 60, "sd4", "Read", {"file_path": "/after.txt"})]
    write(p, rows)
    sv.scan()
    assert len(sv._ev) == 7, says()
    assert says() == ["reading before.txt"] + [f"reading tie{i}.txt" for i in range(5)] \
        + ["reading after.txt"], says()
    assert len({e["t"] for e in sv._ev if e["say"].startswith("reading tie")}) == 1


def dmax():
    root = reset(newroot())
    now = time.time()
    keep = sv.MAX_EVENTS
    sv.MAX_EVENTS = 5
    try:
        p = os.path.join(root, "-Users-t-app", "sdmax.jsonl")
        write(p, [tool_row(now - 1000 + i * 10, "sdmax", "Read", {"file_path": f"/n{i}.txt"})
                  for i in range(12)])
        sv.scan()
        assert len(sv._ev) == 5, len(sv._ev)
        assert says() == [f"reading n{i}.txt" for i in range(7, 12)], says()
    finally:
        sv.MAX_EVENTS = keep


def main():
    checks = [
        ("A1", "missing ROOT -> scan succeeds, nothing found", a1),
        ("A2", "empty ROOT -> scan succeeds, nothing found", a2),
        ("A4", "file > FIRST_READ_MAX -> tail only, fast, recent events found", a4),
        ("A5", "appended while read -> new events appear exactly once", a5),
        ("A5b", "partial final line -> held back, then parsed exactly once", a5b),
        ("A6", "truncated/rotated -> offset resets and re-reads", a6),
        ("A6b", "rotated file re-read -> overlapping events stay single", a6b),
        ("A7", "malformed JSON line -> skipped, neighbours still parse", a7),
        ("A8", "zero-byte file -> skipped, no crash", a8),
        ("A10", "agent-*.jsonl at project top level -> read as a session", a10),
        ("A11", "unreadable file (chmod 000) -> skipped, scan succeeds", a11),
        ("B1/B2/B3", "session with no aiTitle/cwd/gitBranch -> still recorded", b123),
        ("B4", "session resumed -> events accumulate, no duplicates", b4),
        ("B7", "all activity predates the window -> no events kept", b7),
        ("C1", "same agent id in two sessions -> two entries, neither overwritten", c1),
        ("C4", "agent with no opening brief -> no crash, name stays empty", c4),
        ("C5", "agent with zero tool calls -> no events, still registered", c5),
        ("C6", "agent whose parent session file is absent -> still attributed", c6),
        ("C8", "subagent nested under a subagent -> found, joins the same session", c8),
        ("C9", "inline isSidechain rows -> credited to a stand-in, not the boss", c9),
        ("D1", "timestamp before 2020 -> event dropped", d1),
        ("D2", "unparseable timestamp -> event dropped", d2),
        ("D4", "many events on one timestamp -> all kept, order stable", d4),
        ("MAX_EVENTS", "over the cap -> trimmed to the newest events", dmax),
    ]
    for cid, desc, fn in checks:
        check(cid, desc, fn)
    for d in TMPS:
        shutil.rmtree(d, ignore_errors=True)
    if FAILS:
        print(f"\n{len(FAILS)} check(s) failed: " + ", ".join(c for c, _, _ in FAILS))
        return 1
    print("reader ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
