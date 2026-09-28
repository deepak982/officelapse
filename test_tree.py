#!/usr/bin/env python3
"""Checks the boss -> teammate tree server.scan() builds from the REAL logs
under ~/.claude/projects.  Reads the filesystem, takes a few seconds.

Run: python3 test_tree.py
"""
import os

import server


def main():
    server.WINDOW = 72 * 3600          # generous window so there is data to test
    server.scan()

    ses, agents, ev = server._ses, server._agents, server._ev
    assert isinstance(ses, dict) and isinstance(agents, dict)
    # This suite reads whatever is really on the machine, so a clean clone, a CI
    # runner or a quiet week has nothing to assert against. That is not a failure.
    if not ses:
        print("SKIP: no Claude Code sessions under %s in the last 72h" % server.ROOT)
        return
    print("scanned: %d sessions, %d agents, %d events" % (len(ses), len(agents), len(ev)))

    # every session keys itself consistently and carries the expected shape
    for sid, s in ses.items():
        assert s["sid"] == sid, (sid, s["sid"])
        assert isinstance(s["agents"], list), sid

    # Agent ids are NOT globally unique -- 118 of them recur across sessions on a
    # real machine -- so _agents is keyed "sid/aid". Assert that keying holds.
    for key, a in agents.items():
        assert a["key"] == key, (key, a["key"])
        assert key == "%s/%s" % (a["sid"], a["aid"]), key
        assert a["sid"] in ses, "agent %s points at unknown session %s" % (key, a["sid"])

    # no dangling ids: every id a session lists resolves under that session's key
    for sid, s in ses.items():
        for aid in s["agents"]:
            k = "%s/%s" % (sid, aid)
            assert k in agents, "session %s lists unknown agent %s" % (sid, aid)

    # a (session, agent) pair is unique, even though a bare agent id is not
    pairs = [(sid, aid) for sid, s in ses.items() for aid in s["agents"]]
    assert len(pairs) == len(set(pairs)), "a session lists the same agent twice"
    shared = len(pairs) - len({aid for _, aid in pairs})
    for sid, aid in pairs:
        assert agents["%s/%s" % (sid, aid)]["sid"] == sid

    # every agent got a derived job title: short, non-empty, single line
    for key, a in agents.items():
        n = a["name"]
        assert isinstance(n, str) and n.strip(), "agent %s has no job title" % key
        assert len(n) <= 52, "job title too long on %s: %r" % (key, n)
        assert "\n" not in n, "job title spans lines on %s: %r" % (key, n)

    # events always resolve: known session, and a known agent when attributed
    for e in ev:
        assert e["sid"] in ses, "event points at unknown session %s" % e["sid"]
        if e["aid"] is not None:
            k = "%s/%s" % (e["sid"], e["aid"])
            assert k in agents, "event points at unknown agent %s" % k

    # the tree is the point: somebody should have teammates
    staffed = [s for s in ses.values() if s["agents"]]
    if not staffed:
        print("SKIP: no session in the last 72h has any teammate — tree links untested")
    else:
        print("%d of %d sessions have teammates (largest: %d)"
              % (len(staffed), len(ses), max(len(s["agents"]) for s in staffed)))
        print("%d agent id(s) are reused across sessions -- kept distinct by the sid/aid key"
              % shared)

    print("tree ok")


if __name__ == "__main__":
    main()
