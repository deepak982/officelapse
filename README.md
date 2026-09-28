# officelapse

Your Claude Code sessions, as an isometric office you can walk through — and rewind.

![The floor](docs/floor.png)

Every Claude Code session on your machine becomes a **team room**. The session itself is the
boss at the head desk; every subagent it spawns is a **teammate** with their own desk, their
own job title, and their own chair. Tool calls drive what they do — they type at their desk,
walk to the filing cabinet to grep, report to the boss, wander up to the cafeteria, and walk
out when the session goes quiet.

They are animated characters in a real 3D office: eleven shared facilities across the top of
the floor — reception, cafeteria, washrooms, lounge, boardroom, huddle rooms, phone booths,
print bay, quiet room, IT, and a hot-desk bank for teams that outgrow their room — and a
monitor that lights up when its owner is working.

It reads your existing session logs. There is nothing to install into Claude Code.

---

## Why another agent office

There are several pixel-office visualisers for Claude Code. Three things make this one different:

**1. Nothing to install into Claude Code.** No hooks, no wrapper command, no websocket, no
config. It reads `~/.claude/projects` directly, read-only. Point it at your machine and it
works — including on sessions that finished days ago.

**2. Replay, not just live.** Scrub back through the window and watch the whole day play out
at up to 1800×. Live visualisers show you the present; this shows you what your agents
actually did while you were away.

**3. The real subagent tree.** Subagents don't live in the session file — they each get their
own `subagents/agent-<id>.jsonl`, and the parent link is the directory name. A session that
spawned 18 agents renders as 18 distinct people, each with their own desk and their own task,
not one anonymous "helper". On a busy day that is ~85% of all tool calls, which a
session-file-only reader throws away.

---

## Run it

```bash
git clone https://github.com/deepak982/officelapse.git
cd officelapse
./run.sh
```

**No package manager, no build step.** The server is Python standard library only. The browser
side vendors three.js into `vendor/` and its CC0 character assets into `assets/`, both
committed — so a clone runs offline and `pip`/`npm` have nothing to do. It opens
<http://localhost:8777>.

```bash
PORT=9000 HOURS=72 ./run.sh     # different port, wider time window
```

`PORT` defaults to `8777`, `HOURS` to `24`. Logs go to `$TMPDIR/officelapse.<uid>.log`, mode
`600`. Running it again restarts the previous instance; if the port belongs to something
that is not officelapse it says so and stops rather than killing it.

It finds your session logs on its own, in this order:

1. `OFFICELAPSE_ROOT`, if you set it
2. `$CLAUDE_CONFIG_DIR/projects`, if Claude Code's config dir has been relocated
3. `~/.claude/projects`

No configuration needed on a normal install — every project and session on the machine is
discovered automatically, and new ones appear as new rooms while it runs (it re-reads every
two seconds). A machine that has never run Claude Code simply shows an empty floor.

**Platforms.** macOS and Linux. On Windows use WSL or Git Bash, or run `python3 server.py`
directly and open the URL yourself — `run.sh` is only a convenience wrapper.

**Claude Code versions.** The reader is built against the session-log layout of Claude Code
2.1.x (`<sessionId>.jsonl` plus `<sessionId>/subagents/agent-<id>.jsonl`). Older versions that
predate the `subagents/` directory will still render bosses, just without teammates.

---

## Controls

![Inside a room](docs/room.png)

| | |
|---|---|
| **Hover anyone** | full detail — task, agent id, who they report to, branch, model, desk, last active |
| **Click a room** | step inside; the side panel shows the boss → teammate tree and that room's chat |
| **Drag / scroll** | pan and zoom · **Fit** resets the view and clears the search |
| **`/`** | search — matches department, session, branch, teammate and task text; Enter jumps to the first hit |
| **Esc** | back out of a room |
| **LIVE** | follow the present · **⏸** pause · **1×…1800×** replay speed · **scrubber** jump anywhere in the window |

Above 10× it switches to fast-forward: walks are skipped and poses freeze, since nobody can
walk thirty simulated minutes in one real second. The room chat keeps recording every line.

A **lit monitor** is the signal worth learning. Dark means nobody holds that desk; slate means
its owner is logged on but has been quiet; bright cyan with a halo means they were working in
the last 90 seconds — and it follows the *owner*, so a screen stays on while they are up at
the cafeteria.

---

## How the data maps

```
~/.claude/projects/<proj>/<sessionId>.jsonl                        → a boss, in their own room
~/.claude/projects/<proj>/<sessionId>/subagents/agent-<id>.jsonl   → one teammate each
```

| In the logs | On the floor |
|---|---|
| project (working directory) | a **department** — its own carpet colour and sign |
| session | a **team room** |
| the session's title | the room's name, e.g. *Invoice PDF rewrite* |
| subagent | a **teammate**; their first brief becomes their job title |
| `Read` / `Edit` / `Write` / `Bash` | typing at their desk |
| `Grep` / `Glob` | a trip to the filing cabinet |
| `Task` / `Agent` / `SendMessage` | walking over to the boss desk |
| `WebFetch` / `WebSearch` | thinking — at the cooler, the lounge or the quiet room |
| quiet for 90s | a break: the room's cooler, the cafeteria or the lounge |
| quiet for 5 min | some of them take a washroom run |
| more teammates than desks | hot-desking up in the shared **HOT DESKS** room |
| quiet for 15 min | clocks out and leaves through the door |

Which break a given teammate takes is a hash of who they are, never random — so scrubbing back
to the same moment rebuilds the same floor, down to who was standing where.

---

## How it works

No framework, no build step. Four layers, and only the last one knows what a pixel is:

| | File | Role |
|---|---|---|
| **data** | `server.py` | reads the jsonl incrementally by byte offset, serves `GET /api/state?since=<seq>`. Python stdlib only |
| **world** | `floor.js` | the building — departments, rooms, the facility band, desk claims, the walkability grid and BFS pathfinding |
| | `sim.js` | who is on the floor, where they are walking, when they clock out. No DOM at all, so it runs under node |
| **view** | `view3d/` | `scene.js` the office, `props.js` the furniture, `materials.js` the palette, `characters.js` the people, `input.js` hover and click |
| | `office.js` | the original 2D canvas renderer, kept as the fallback when WebGL will not start |
| | `chat.js` | the per-room chat log, and speech bubbles in the 2D view |

The split is the point: `floor.js` and `sim.js` know nothing about how they are drawn, which is
why a 3D renderer could be added beside the 2D one instead of replacing it. Both are driven by
the same simulation, and `test_view3d.mjs` pins that they agree about who is where.

Four details that matter if you read the code:

- **Rooms never move.** A room takes a permanent slot on first sight and keeps it. Re-packing
  the floor whenever a team grows is what makes everyone teleport.
- **Desk claims are permanent** for the life of the session, so scrubbing the timeline always
  puts the same teammate back at the same desk.
- **Paths are verified, not sampled.** `lineClear()` cuts each segment at every grid line it
  crosses and tests the tile on each interval, plus both shoulders at corner crossings. Stride
  sampling misses slices thinner than the stride, and smoothing tries the longest legs first —
  exactly where those slivers occur.
- **The whole floor is 121 draw calls**, and that does not grow with room count. Every room is
  geometrically identical, so shells, desks, chairs and props are instanced once and reused;
  only a genuinely new prop footprint adds a batch. A session with 135 teammates renders 40
  full rigs and 95 stand-ins, chosen by who you are looking at.

---

## Tests

```bash
node test_floor.js       # floor plan + pathfinding
node test_runtime.js     # desk overflow, recycling, queueing, room stability
node test_sim.js         # who is on the floor: desks, breaks, facilities, replay
node test_view3d.mjs     # the 3D layer, and that both views agree about the world
python3 test_reader.py   # log reading: huge files, partial writes, odd sessions
python3 test_labels.py   # tool call → what a worker says
python3 test_tree.py     # boss → teammate tree, against your real logs
```

`test_floor.js` pins the invariants the floor exists for: no room overlaps, rooms never move
when a team grows, every desk and station reachable from the door, no path enters a blocked
tile or cuts a blocked corner, desk claims stable across regrowth, queue spots never
double-booked.

`test_view3d.mjs` runs the 3D layer headless — node has no WebGL, so `init()` and `render()`
are the only things it cannot call. It slices `scene.js` out of its own source and runs it
against fake batches, parses the real character rig off disk, and loads `office.js` into a `vm`
to compare the two renderers directly: same prop vocabulary, same facility hues, same people at
the same tiles, same rooms dimmed behind a focus, same rule for which monitors are lit. Where
the two differ on purpose — bubbles are 2D-only, 3D labels are sprites — it says so.

**[EDGE_CASES.md](EDGE_CASES.md)** is the checklist these suites exist to cover — what happens
when the logs are not tidy, and what the floor does when the world is not. Every entry names a
check that pins it or a reproduction, and the ones that are *not* handled are listed as plainly
as the ones that are. What real data turned up, all of it still handled:

- session log files big enough that they are read from the tail, never slurped
- agent ids reused across different sessions, so people are keyed by session **and** agent
- sessions with more subagents than the room has desks — they hot-desk in the shared band, and
  desks recycle on clock-out
- timestamps predating 2020, partial final lines, and tens of thousands of events sharing one
  second

---

## Privacy

It reads `~/.claude/projects` and never writes there. The server binds to `127.0.0.1` only,
and rejects any request whose `Host` is not `localhost`/`127.0.0.1` — without that check a
page in another tab could reach it by pointing its own hostname at `127.0.0.1`. Nothing is
uploaded and there is no telemetry — everything stays on your machine.

Session logs contain your prompts, file paths and shell commands, and this page displays them.
Worth remembering before you screen-share it. There is no login: anyone with an account on
the same machine can read `/api/state` while it runs, so don't leave it up on a shared box.

---

## Requirements

**Nothing to install.** There are no third-party Python packages — `requirements.txt` is empty
and says so — no npm packages, and no build step. What matters is versions:

| | Needed | Why |
|---|---|---|
| **Python** | 3.8+ | the server. Standard library only: `glob`, `http.server`, `json`, `os`, `re`, `socketserver`, `threading`, `time`, `urllib.parse`, `datetime` |
| **Browser** | Chrome/Edge 99+, Safari 16+, **Firefox 127+**, with WebGL2 | WebGL2 for the 3D office. The 2D fallback uses canvas `roundRect`, which Firefox only shipped in 127 (June 2024) |
| **Node** | 18+ | only to run the four JS suites. Never needed to *use* officelapse |

If WebGL will not start — no GPU, a blocked context, a missing vendor file — the page says so
in the console and falls back to the 2D canvas renderer rather than showing a black rectangle.

Third-party JavaScript is **vendored, not installed**: three.js r160 (MIT) in `vendor/`, and a
CC0 character rig with its animation clips in `assets/`, both committed. The app works offline
and a clone needs no package manager. Every source, author and licence is in
[assets/CREDITS.md](assets/CREDITS.md).

## Licence

MIT
