# Edge cases

What officelapse does when the logs are not tidy. Every ✅ below was checked against real
logs on a live machine or pinned by a test — none is assumed. Counts in *italics* are what was
actually found on the machine this was developed against (194 session files, 578 agent files).

Run the suites with:

```bash
node test_floor.js && node test_runtime.js && \
python3 test_reader.py && python3 test_labels.py && python3 test_tree.py
```

| Suite | Covers |
|---|---|
| `test_floor.js` | static geometry, desk orientation, path validity on a fresh floor |
| `test_runtime.js` | live churn — oversize teams, desk recycling, queueing, interleaved growth |
| `test_reader.py` | sections A, B, C1/C4/C5/C6, D1/D2/D4 against synthetic fixtures |
| `test_labels.py` | tool call → what a worker says |
| `test_tree.py` | the boss → teammate tree against your real logs |

---

## A. Finding and reading the logs

| # | Case | Status |
|---|---|---|
| A1 | Log directory does not exist (machine has never run Claude Code) | ✅ empty floor, no crash; banner says where it looked |
| A2 | Log directory exists but is empty | ✅ empty floor |
| A3 | `CLAUDE_CONFIG_DIR` relocates `~/.claude` | ✅ honoured; `OFFICELAPSE_ROOT` overrides both |
| A4 | **Very large session file** — *576MB and 445MB found* | ✅ first read starts from the tail (8MB), each pass capped at 4MB. Parses in 0.02s |
| A5 | File being appended while it is read | ✅ parses only up to the last `\n`; resumes mid-line next poll |
| A6 | File truncated or rotated under us | ⚠️ offset resets and it re-reads without crashing, but events already in the timeline are re-appended, so a rotation duplicates them |
| A7 | Malformed / partial JSON line | ✅ skipped per line, rest of the file still parses |
| A8 | Zero-byte file | ✅ *0 found*; size == offset, skipped |
| A9 | Symlinked log files | ✅ *0 found*; `glob` + `os.stat` follow them normally |
| A10 | `agent-*.jsonl` at the top level rather than in `subagents/` | ✅ *0 found*; such a file would be read as a session, not lost |
| A11 | Unreadable file (permissions) | ✅ **was a crash** — `os.stat` succeeds on a mode-000 file, so the open threw and one bad file 500'd the whole API. Now caught and counted; scan continues |

## B. Sessions (the boss)

| # | Case | Status |
|---|---|---|
| B1 | Session with no `aiTitle` | ✅ falls back to branch, then project name |
| B2 | Session with no `cwd` | ✅ project taken from the directory name |
| B3 | Session with no `gitBranch` | ✅ field simply omitted from plate and card |
| B4 | Session resumed later (same id, file appended) | ✅ incremental read picks up from the stored offset |
| B5 | Several concurrent sessions in one project | ✅ one room each, grouped into that department |
| B6 | Session with no subagents at all | ✅ boss alone in the room; panel says so |
| B7 | Session whose only activity predates the window | ✅ no events, so no room is created |
| B8 | Very long session title | ✅ truncated on the plate, shown in full on hover |

## C. Subagents (the teammates)

| # | Case | Status |
|---|---|---|
| C1 | **Agent id reused across different sessions** — *118 found* | ✅ people, metadata and desk claims are keyed by `session + agent`, not by agent id |
| C2 | **Team larger than the room** — *sessions with 135, 90, 72, 34, 30 agents* | ✅ 24 desks, overflow hot-desks in the break and meeting areas; nobody lands on the boss's chair |
| C3 | **Desks leak as agents finish** | ✅ a desk is released on clock-out and on timeline scrub, so it recycles |
| C4 | Agent with no opening brief (no job title) | ✅ *0 found*; falls back to the short agent id |
| C5 | Agent that made zero tool calls | ✅ *3 found*; never walks in, but still counted in the room's all-time `×N` |
| C6 | Agent whose parent session file is missing | ✅ *0 found*; the session record is created from the agent's own rows |
| C7 | Agent that goes quiet then returns | ✅ clocks out, and is re-created at the door on its next event |
| C8 | Nested subagents (an agent spawning its own team) | ⚠️ *0 exist today*; the reader is one level deep and would miss grandchildren |
| C9 | Inline `isSidechain` rows inside a main session file (older format) | ⚠️ *0 found*; on an older install these would be attributed to the boss |

## D. Time and replay

| # | Case | Status |
|---|---|---|
| D1 | **Bogus timestamps before 2020** — *2 found* | ✅ dropped by the window cutoff before they reach the scrubber |
| D2 | Unparseable timestamp | ✅ treated as 0, therefore dropped |
| D3 | Timestamps in the future | ✅ *0 found*; clamped by `Math.min(clock, t1)` during replay |
| D4 | **Many events sharing one timestamp** — *173k of 329k* | ✅ sort is by time only; ties keep file order, which is fine |
| D5 | No events at all | ✅ scrubber spans the raw window; no division by zero |
| D6 | Activity occupying a tiny slice of the window | ✅ scrubber spans the *events*, not the empty window |
| D7 | Replay at 1800× | ✅ fast-forward: walks and bubbles skipped, chat still recorded |
| D8 | Event burst (139 in one minute) at high speed | ✅ per-frame event budget stops the loop stalling |
| D9 | An older event arriving after the cursor passed it | ✅ "applied" is a flag on the event, not an index into an array that gets re-sorted every poll, so a late insert behind the scan position is still picked up (browser-verified, not headlessly pinned) |

## E. Floor and rendering

| # | Case | Status |
|---|---|---|
| E1 | New session appears while running | ✅ new room; existing rooms never move |
| E2 | Team grows while running | ✅ room never resizes or re-packs, so nobody teleports |
| E3 | Two people routed to the same station | ✅ numbered queue spots, no double-booking |
| E4 | People converging on one aisle | ✅ per-person lane offsets plus `dt`-scaled separation |
| E5 | Path would cross furniture or clip a corner | ✅ exact grid traversal, both shoulders checked; pinned by `test_floor.js` |
| E6 | Window resized / zoomed right out | ✅ re-fits; labels and bubbles hide when too small to read |
| E7 | Server goes away while the page is open | ✅ fetch failure is swallowed; the floor keeps animating |
| E8 | Many rooms | ✅ departments wrap; rooms keep their permanent slots |

## F. Deliberately out of scope

| # | Case | Why |
|---|---|---|
| F1 | Cloud and remote sessions | Not on local disk |
| F2 | Other users on the same machine | Reads only the invoking user's home |
| F3 | Agent teams messaging across sessions | Rendered as separate rooms; the link between them is not drawn |
| F4 | Windows without WSL | `run.sh` is bash; `python3 server.py` still works |

## H. Regressions worth naming

| # | Case | Status |
|---|---|---|
| H1 | Keying people by bare agent id (broken by C1's fix) | ✅ desks store an agent id while people are keyed `session|agent`; the monitor-glow lookup missed and **no desk ever lit up**. Now resolved through the room |
| H2 | Agent briefs arrive as markdown | ✅ stripped once where the brief enters, so labels, chat, panel and hover card are all clean |

## G. Format drift

officelapse reads Claude Code's private on-disk format (verified against 2.1.x:
`<sessionId>.jsonl` plus `<sessionId>/subagents/agent-<id>.jsonl`, fields `timestamp`,
`sessionId`, `cwd`, `gitBranch`, `aiTitle`, `message.content[].tool_use`). Nothing guarantees
this is stable across releases.

If files are present but none of their lines are recognised, the server says so on startup, the
`/api/state` response carries a `health` object (`ok`, `code`, `message`, counts), and the page
shows the reason in place of the empty-floor message. The three verdicts are `ok`, `no_logs`
and `unreadable_format`.

Note the discriminator is *recognised lines*, not event count — a machine whose activity all
predates the window parses perfectly and yields zero events, and must not be accused of drift.
