#!/usr/bin/env python3
"""Checks the boss -> teammate tree server.scan() builds from the REAL logs
under ~/.claude/projects.  Reads the filesystem, takes a few seconds.

Run: python3 test_tree.py
"""
import server


def main():
    server.WINDOW = 72 * 3600          # generous window so there is data to test
    server.scan()

    ses, agents, ev = server._ses, server._agents, server._ev
    assert isinstance(ses, dict) and isinstance(agents, dict)
    assert ses, "scan() found no sessions under %s in the last 72h" % server.ROOT
    print("scanned: %d sessions, %d agents, %d events" % (len(ses), len(agents), len(ev)))

    # every session keys itself consistently and carries the expected shape
    for sid, s in ses.items():
        assert s["sid"] == sid, (sid, s["sid"])
        assert isinstance(s["agents"], list), sid

    # no orphan teammates: every agent hangs off a session we know about
    for aid, a in agents.items():
        assert a["aid"] == aid, (aid, a["aid"])          # ids are unique + self-consistent
        assert a["sid"] in ses, "agent %s points at unknown session %s" % (aid, a["sid"])

    # no dangling ids: every id a session lists resolves to a real agent
    for sid, s in ses.items():
        for aid in s["agents"]:
            assert aid in agents, "session %s lists unknown agent %s" % (sid, aid)

    # an agent is claimed by exactly one session
    listed = [aid for s in ses.values() for aid in s["agents"]]
    assert len(listed) == len(set(listed)), "an agent id is listed by two sessions"
    for aid in listed:
        assert agents[aid]["sid"] in ses

    # every agent got a derived job title: short, non-empty, single line
    for aid, a in agents.items():
        n = a["name"]
        assert isinstance(n, str) and n.strip(), "agent %s has no job title" % aid
        assert len(n) <= 52, "job title too long on %s: %r" % (aid, n)
        assert "\n" not in n, "job title spans lines on %s: %r" % (aid, n)

    # events always resolve: known session, and a known agent when attributed
    for e in ev:
        assert e["sid"] in ses, "event points at unknown session %s" % e["sid"]
        if e["aid"] is not None:
            assert e["aid"] in agents, "event points at unknown agent %s" % e["aid"]

    # the tree is the point: somebody should have teammates
    staffed = [s for s in ses.values() if s["agents"]]
    if not staffed:
        print("SKIP: no session in the last 72h has any teammate — tree links untested")
    else:
        print("%d of %d sessions have teammates (largest: %d)"
              % (len(staffed), len(ses), max(len(s["agents"]) for s in staffed)))

    print("tree ok")


if __name__ == "__main__":
    main()
