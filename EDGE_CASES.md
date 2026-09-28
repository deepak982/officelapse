# Edge cases

What officelapse does when the logs, the floor or the GPU are not tidy. Every ✅ below is
either pinned by a named check in one of the suites or was actually reproduced — none is
assumed. Anything unhandled is listed as plainly as anything handled, and a row with no check
behind it says so.

Run the suites with:

```bash
node test_floor.js && node test_runtime.js && node test_sim.js && node test_view3d.mjs && \
python3 test_reader.py && python3 test_labels.py && python3 test_tree.py
```

| Suite | Covers |
|---|---|
| `test_floor.js` | static geometry, desk orientation, path validity on a fresh floor |
| `test_runtime.js` | live churn — oversize teams, desk recycling, queueing, interleaved growth |
| `test_sim.js` | who is on the floor: seating, clock-out, rebuilds, trips to the band, gestures |
| `test_view3d.mjs` | the 3D layer without a GPU — prop geometry, chair facing, camera basis, scene reconciliation, the characters, and 2D-vs-3D agreement |
| `test_reader.py` | sections A, B, C, D against synthetic fixtures |
| `test_labels.py` | tool call → what a worker says |
| `test_tree.py` | the boss → teammate tree against your real logs |

`init()` and `render()` are the only two entry points no suite calls: node has no WebGL.
Everything else in `view3d/` runs headless, including the real rig, which `test_view3d.mjs`
parses out of the `.glb` without a browser.

---

## A. Finding and reading the logs

| # | Case | Status |
|---|---|---|
| A1 | Log directory does not exist (machine has never run Claude Code) | ✅ empty floor, no crash; banner says where it looked |
| A2 | Log directory exists but is empty | ✅ empty floor |
| A3 | `CLAUDE_CONFIG_DIR` relocates `~/.claude` | ✅ honoured; `OFFICELAPSE_ROOT` overrides both |
| A4 | **Very large session file** — hundreds of MB is normal | ✅ any unread tail over 8MB is skipped to its last 8MB, each pass capped at 4MB. The same rule recovers a page left closed while the log ran away, which a first-read-only jump could never catch up with |
| A5 | File being appended while it is read | ✅ parses only up to the last `\n`; resumes mid-line next poll |
| A6 | File truncated or rotated under us | ✅ offset resets and it re-reads; appends are idempotent, keyed on the row's own uuid, so the re-read cannot double-count |
| A7 | Malformed / partial JSON line | ✅ skipped per line, rest of the file still parses |
| A8 | Zero-byte file | ✅ size == offset, skipped |
| A9 | Symlinked log files | ✅ `glob` + `os.stat` follow them normally |
| A10 | `agent-*.jsonl` at the top level rather than in `subagents/` | ✅ read as a session, not lost |
| A11 | Unreadable file (permissions) | ✅ **was a crash** — `os.stat` succeeds on a mode-000 file, so the open threw and one bad file 500'd the whole API. Now caught and counted; the scan continues |

## B. Sessions (the boss)

| # | Case | Status |
|---|---|---|
| B1 | Session with no `aiTitle` | ✅ tries `customTitle` next (a real rename — sessions titled only that way showed the fallback), then branch, then project name |
| B2 | Session with no `cwd` | ✅ project taken from the directory name |
| B3 | Session with no `gitBranch` | ✅ field simply omitted from plate and card |
| B4 | Session resumed later (same id, file appended) | ✅ incremental read picks up from the stored offset |
| B5 | Several concurrent sessions in one project | ✅ one room each, grouped into that department |
| B6 | Session with no subagents at all | ✅ boss alone in the room; panel says so |
| B7 | Session whose only activity predates the window | ✅ no events, so no room is created |
| B8 | Very long session title | ✅ truncated on the plate, shown in full on hover |
| B9 | **Session metadata that never arrives** | ✅ an event whose session has no project is held, not applied — filing it would open a `?` department a whole `DEPT_PITCH` from the team it belongs to, and rooms never move. Dropped after `IDLE` so it cannot pin the scan head forever. `test_sim.js` S15, `test_view3d.mjs` Z3 |

## C. Subagents (the teammates)

| # | Case | Status |
|---|---|---|
| C1 | **Agent id reused across different sessions** | ✅ people, metadata and desk claims are keyed by `session + agent`, never by agent id. `test_sim.js` S2 |
| C2 | **Team larger than the room** | ✅ 24 desks, then the band's 16 hot desks, then standing room in the break and meeting areas; nobody lands on the boss's chair. Pinned at 135 agents by `test_runtime.js` C2 and `test_sim.js` S16 |
| C3 | **Desks leak as agents finish** | ✅ a desk is released on clock-out and on timeline scrub, so it recycles. `test_runtime.js` C3/C3b, `test_sim.js` S3 |
| C4 | Agent with no opening brief (no job title) | ✅ falls back to the short agent id |
| C5 | Agent that made zero tool calls | ✅ never walks in, but still counted in the room's all-time `×N` |
| C6 | Agent whose parent session file is missing | ✅ the session record is created from the agent's own rows |
| C7 | Agent that goes quiet then returns | ✅ clocks out, and is re-created at the door on its next event. `test_runtime.js` C7 |
| C8 | Nested subagents (an agent spawning its own team) | ✅ discovery is depth-independent; a grandchild flattens into its session's team rather than being lost |
| C9 | Inline `isSidechain` rows inside a main session file (older format) | ✅ credited to a stand-in teammate rather than inflating the boss. Guarded so it cannot invent agents where none exist |

## D. Time and replay

| # | Case | Status |
|---|---|---|
| D1 | **Bogus timestamps before 2020** | ✅ dropped by the window cutoff before they reach the scrubber |
| D2 | Unparseable timestamp | ✅ treated as 0, therefore dropped |
| D3 | Timestamps in the future | ✅ clamped by `Math.min(clock, t1)` during replay |
| D4 | **Many events sharing one timestamp** — the majority of them, on a busy machine | ✅ the sort is by time only; ties keep file order, which is fine |
| D5 | No events at all | ✅ scrubber spans the raw window; no division by zero |
| D6 | Activity occupying a tiny slice of the window | ✅ scrubber spans the *events*, not the empty window |
| D7 | Replay at 1800× | ✅ fast-forward: walks and bubbles skipped, chat still recorded. The 3D layer freezes its mixers on the same flag and keeps a correct roster. `test_view3d.mjs` K4, Z5 |
| D8 | Event burst at high speed | ✅ a per-frame event budget stops the loop stalling |
| D9 | An older event arriving after the cursor passed it | ✅ two halves. The server hands out a **sequence**, not a timestamp, so a row read from a tail seek carries a new high and is not filtered out for being old — a timestamp cursor dropped those permanently. Client-side, "applied" is a flag on the event, not an index into an array that gets re-sorted every poll |
| D10 | **Scrubbing backwards** | ✅ `rebuild()` wipes people, frees every zone, facility seat and hot desk, and clears each room's activity stamp; replaying to the same clock rebuilds the identical floor, because every per-person choice is a bit slice of `hash(p.key)` and never `Math.random`. `test_sim.js` S4/S5/S6/S12, `test_view3d.mjs` Z5 |

## E. Floor and rendering (2D)

| # | Case | Status |
|---|---|---|
| E1 | New session appears while running | ✅ new room; existing rooms never move. `test_runtime.js` E1/E2 |
| E2 | Team grows while running | ✅ the room never resizes or re-packs, so nobody teleports |
| E3 | Two people routed to the same station | ✅ numbered queue spots, no double-booking. `test_runtime.js` E3 |
| E4 | People converging on one aisle | ✅ per-person lane offsets plus `dt`-scaled separation |
| E5 | Path would cross furniture or clip a corner | ✅ exact grid traversal, both shoulders checked. `test_floor.js` 5/5b, `test_runtime.js` E5b |
| E6 | Window resized / zoomed right out | ✅ re-fits; labels and bubbles hide when too small to read |
| E7 | Server goes away while the page is open | ✅ the fetch failure is swallowed; the floor keeps animating |
| E8 | Many rooms | ✅ departments wrap; rooms keep their permanent slots. `test_runtime.js` E8 |
| E9 | A prop type the renderer has no case for | ✅ both views warn **once** per type and draw a magenta marker, rather than silently leaving an invisible obstacle over a blocked tile. `test_view3d.mjs` N1, X1 |
| E10 | **A person standing in the band whose own room is off-screen** | ✅ **was a bug** — they were culled against their team room and vanished the moment you zoomed onto the cafeteria. Culling is now against whichever rect they are actually standing in. `test_view3d.mjs` X4 |

## F. Deliberately out of scope

| # | Case | Why |
|---|---|---|
| F1 | Cloud and remote sessions | Not on local disk |
| F2 | Other users on the same machine | Reads only the invoking user's home |
| F3 | Agent teams messaging across sessions | Rendered as separate rooms; the link between them is not drawn |
| F4 | Windows without WSL | `run.sh` is bash; `python3 server.py` still works |
| F5 | Real-time shadow maps | Budgeted out above 20 characters, and sessions reach 135. A blob under each person is the only contact cue |
| F6 | Orbiting the 3D camera | Locked to the dimetric angle on both axes so no input path can leave it — the two views have to look like one product. `test_view3d.mjs` C4 |
| F7 | A `rug` prop | In the contract vocabulary, implemented in neither view. With `w`/`h` it would block, and a rug that blocks is wrong. `test_view3d.mjs` P4, X1 |
| F8 | A `pod` or `bossdesk` prop | Markers, not furniture: both shells already build the desks they stand for, so both views skip them. `test_view3d.mjs` P3 |

## G. Format drift

officelapse reads Claude Code's private on-disk format (verified against 2.1.x:
`<sessionId>.jsonl` plus `<sessionId>/subagents/agent-<id>.jsonl`, fields `timestamp`,
`sessionId`, `cwd`, `gitBranch`, `aiTitle`/`customTitle`, `message.content[].tool_use`).
Nothing guarantees this is stable across releases. Names that have already moved once are
listed together in `FIELDS`, so absorbing the next rename is a one-word edit.

The server says so on startup, the `/api/state` response carries a `health` object (`ok`,
`code`, `message`, counts), and the page shows the reason in place of the empty-floor message.
The five verdicts:

| Verdict | Fires when |
|---|---|
| `no_logs` | no `.jsonl` found under the root at all |
| `unreadable_format` | over 90% of the lines read this scan failed to parse or had no usable timestamp |
| `no_tool_calls` | assistant turns in the window, but not one `tool_use` block among them — everyone on the floor is driven by tool calls, so the rooms would look asleep |
| `no_subagents` | session directories exist but not one `subagents/agent-*.jsonl` inside any of them |
| `ok` | none of the above |

Each verdict is a ratio against what *this scan* read — the counters reset every scan, so a
long-running server cannot mask a drift that starts mid-session behind hours of good lines.

Note the discriminator is never event count — a machine whose activity all predates the window
parses perfectly and yields zero events, and must not be accused of drift. `no_tool_calls` and
`no_subagents` are the two partial drifts that used to pass as `ok`: each has a denominator
(assistant turns, session directories) that is present on a healthy machine whatever the window
holds, so neither can fire on a quiet one.

## H. Regressions worth naming

| # | Case | Status |
|---|---|---|
| H1 | Keying people by bare agent id (broken by C1's fix) | ✅ a team room's desk stores a bare agent id while people are keyed `session|agent`; the monitor lookup missed and **no desk ever lit up**. Now resolved through the room |
| H1b | **The same mistake one level up, in the band** | ✅ a hot desk's `by` holds the **full `sid\|aid` key**, because the band is shared by every session at once and a bare agent id would hand one desk to two people. Copying the room's `St.people[r.sid + '\|' + d.by]` here gives a lookup that can never match. Both views look band occupants up by `d.by` directly |
| H2 | Agent briefs arrive as markdown | ✅ stripped once where the brief enters, so labels, chat, panel and hover card are all clean |
| H3 | An event applied before its session's metadata | ✅ see B9 — it used to open a `?` department |
| H4 | **A gesture re-fired every frame** | ✅ `p.gesture` is a **field, not an event**: the sim sets it per tool call and leaves it set for many frames. The 3D layer keeps its own last-played value and compares, or the one-shot retriggers sixty times a second and reads as a twitch. `test_sim.js` S14, `test_view3d.mjs` K3 |
| H5 | **A lit monitor as a tile-sized billboard beside the desk** | ✅ **was a bug** — a translucent quad placed from the desk tile's origin, big enough to paint over whoever was sitting there. It is now the monitor's own screen face, a third of a tile wide, opaque and depth-tested so a nearer character occludes it, with an additive halo that can only add light. `test_view3d.mjs` V10 |
| H6 | **`Color.setHSL()` in the wrong colour space** | ✅ **was a bug** — it defaults to the *working* space, which is linear, so an `l` of `.13` lands near sRGB 40% and department plates rendered **lighter** than the rooms standing on them. office.js writes plain CSS `hsl()`, i.e. sRGB, so every value copied across says `SRGBColorSpace`. `test_view3d.mjs` X8 |

## I. The facility band

Eleven facilities in two rows, 94 × 24 tiles, above the corridor. `Floor.AM_BAND` frames it and
is derived at module load, so it is correct before anything is built.

| # | Case | Status |
|---|---|---|
| I1 | **The band does not exist until the first room** | ✅ `buildAmenities()` is only called from `ensureRoom()`, so a scene built at init sees an empty `Floor.state.amenities`. Both renderers tolerate the empty array and pick the band up on a later pass; `buildAmenities()` also works standalone, with zero rooms. `test_view3d.mjs` Z1 |
| I2 | `Floor.reset()` clears the band | ✅ `amenities` emptied and the grid nulled together. `test_view3d.mjs` Z1. See K14 for what that does to the 3D scene |
| I3 | **Facilities are each a different width** | ✅ `AM_W` / `AM_SLOT` no longer exist; everything reads each facility's own `w`/`h`. 3D shares one shell per width — 8 shells for 11 facilities — and `coworking` gets its own, being the only one with desks. `test_view3d.mjs` V1 |
| I4 | A facility `kind` nobody implemented | ✅ 2D draws a plain grey box, 3D keys a shell off the width and tints it the same fallback grey. Neither throws. `test_view3d.mjs` N2, X2 |
| I5 | Every facility has its own colour | ✅ eleven distinct hues, and the 2D and 3D tables are checked to be the *same* table — a cafeteria cannot read amber in one view and cyan in the other. `test_view3d.mjs` X2 |
| I6 | A chair is sat **on**, a sofa sat **in front of** | ✅ `chair` does not block and shares its tile with the seat. Blocking it would trap the seat it exists to give. `test_view3d.mjs` W3 |
| I7 | Wall decoration on an already-blocked wall tile | ✅ `art` `logo` `menu` `mirror` `screen` `whiteboard` never call `setBlocked` again, and each resolves to the wall it sits on. `test_view3d.mjs` W1, W2 |
| I8 | A board with no wall behind it | ✅ floor.js still puts a free-standing board beside a team room's meeting table; both views give it legs rather than hanging it in mid-air. `test_view3d.mjs` W2 |
| I9 | `art` index out of the palette | ✅ nine distinct pictures for floor.js's `art: 0..8`, and anything above 8 wraps. ❌ **a negative index throws** — `(art \| 0) % 9` is `-1` and `COL.art[-1]` is undefined. floor.js never emits one, so it is latent. `test_view3d.mjs` N3 |
| I10 | A prop with no footprint | ❌ **produces NaN geometry silently**, which takes the whole instanced batch off screen rather than drawing one bad prop. floor.js always sets `w`/`h`. `test_view3d.mjs` N4 |
| I11 | A prop overhanging its own tiles | ✅ only the planter's foliage does, by under 0.3 tiles, and that is bounded so it cannot grow into the neighbour. Nothing dips below the carpet. `test_view3d.mjs` P5, P6 |

## J. Routing into the band

| # | Case | Status |
|---|---|---|
| J1 | A facility with no free seat | ✅ `takeSpot` returns null and the caller falls back to the room's own break zone, rather than stacking two people on one tile. `test_sim.js` S18 |
| J2 | A facility kind floor.js has not built yet | ✅ `trip()` returns null and the person stays in their own room |
| J3 | **Everybody walking out at once** | ✅ `''` is one of the options in every `AWAY` list on purpose: without it the corridor would be a parade and the rooms would be empty. The pick is a bit slice of `hash(p.key)`, so it survives a scrub |
| J4 | One person holding a room zone and a facility seat at once | ✅ **cannot happen** — leaving for the band releases the room's zone first. The 3D LOD rule is the one-field test `p.fac \|\| p.cowork`, which a double hold would quietly break. `test_view3d.mjs` Z4 |
| J5 | A facility seat leaking on clock-out | ✅ `freeAll()` gives back the zone, the facility seat **and** the hot desk; only the two paths that end someone's day call it. `test_sim.js` S13, S16 |
| J6 | A long quiet spell | ✅ earns exactly one washroom run, never a loop, and only for some people. `test_sim.js` S11, S17 |
| J7 | A hot desk held across a scrub | ✅ a rebuild frees all 16 and the replay books the same ones again. `test_sim.js` S16 |
| J8 | A teammate past both the room's desks and the band's hot desks | ✅ `hotDesk()` hands out a standing spot in the break or meeting area. It is desk-shaped so `claimDesk` works on it unchanged, but **nothing is built there** — so the 3D lit monitor skips `desk.hot`, or it would hang over bare carpet. `test_view3d.mjs` V11 |

## K. The 3D renderer

`view3d/` exposes `init` / `sync` / `render` / `dispose` and imports nothing from `office.js`.

| # | Case | Status |
|---|---|---|
| K1 | No WebGL, no GPU, a missing vendor file | ✅ `index.html` catches it, stays on the 2D canvas and marks the toggle `3D ✕` rather than showing a black rectangle |
| K2 | three.js not vendored | ✅ `vendor/three.module.js` plus four addons whose bare `three` specifiers were rewritten to relative paths, so no import map is needed. Recorded in `assets/manifest.json` |
| K3 | The camera angle | ✅ orthographic, azimuth 45°, elevation **asin(0.5)**. Not `atan(0.5)` and not true isometric: only `asin` projects a tile at exactly office.js's `TW/TH` = 2:1. Pinned against office.js's own constants, not against a number copied into the test. `test_view3d.mjs` C1, C2, C3 |
| K4 | Instanced meshes vanishing when the camera pans | ✅ an `InstancedMesh`'s bounding sphere is the *geometry*'s, which sits at the origin, so frustum culling is off on every batch. `test_view3d.mjs` C4 |
| K5 | Draw calls scaling with rooms | ✅ one batch per geometry, not per room: 135 teammates in one session build exactly the same static geometry as one teammate does. `test_view3d.mjs` V1, V12 |
| K6 | Zero rooms, zero people | ✅ `sync` returns on a null grid; nothing is built and nothing is framed. `test_view3d.mjs` V12, Z1 |
| K7 | Which way a chair faces | ✅ floor.js gives a chair no direction, so 3D reads it off the nearest *point* of the thing it is pulled up to — the nearest point, not the centre, or both ends of an 8-tile boardroom table face the wall. Checked against floor.js's own `d.dir` on all 16 hot desks, plus the boardroom and huddle rings. Nothing within two tiles falls back to N. `test_view3d.mjs` V4, V5, V6 |
| K8 | Every prop landing on the right tile | ✅ three conventions meet in `addProp` — translate for a floor prop, rotate-about-the-tile-centre for wall deco and for a chair — and each is checked by where the prop's own centre ends up, not by the matrix's translation. `test_view3d.mjs` V3 |
| K9 | A department gaining a room | ✅ its plate is one quad, rebuilt only on a change in room count. `test_view3d.mjs` V9 |
| K10 | Focus | ✅ the focused room keeps its department colour, every other room's shell instance is tinted `DIM`, since per-instance alpha is not a thing. `test_view3d.mjs` V7 |
| K11 | **A room that opens while another room is focused** | ❌ **stays at full brightness** among its dimmed neighbours. `syncFocus` returns early unless the focus itself changed, and `buildRoom` pushes every new instance at its department colour. 2D dims it to alpha .1. `test_view3d.mjs` V8 |
| K12 | **A search while 3D is showing** | ❌ **does nothing at all.** `St.q` dims the whole 2D floor except its hits; neither `scene.js` nor `characters.js` reads it. `test_view3d.mjs` X6 |
| K13 | A lit monitor | ✅ the monitor's own screen face, a third of a tile wide, opaque and depth-tested so a nearer character occludes it, plus an additive halo that can only add light. Refilled from scratch every frame so it cannot accumulate, dark past `IDLE`, and never on a hot-desk stand-in. `test_view3d.mjs` V10, V11 |
| K14 | `Floor.reset()` mid-run | ❌ **the teardown branch is unreachable.** `sync` returns on `!F.blocked` *before* it tests whether the room table emptied, and `Floor.reset()` clears both at once, so `clearWorld()` never fires and later rooms would land on stale instances. Nothing calls `Floor.reset()` at runtime today — only the suites do — so this is latent, and `test_view3d.mjs` Z2 fails the moment something does |
| K15 | Room and facility plates arriving late | ✅ a title lands on a session long after its owner is on the floor; a label is rebuilt only when its text actually changes |
| K16 | HSL values copied across from office.js | ✅ every one says `SRGBColorSpace`, because `setHSL` defaults to the linear working space. See H6. `test_view3d.mjs` X8 |

## L. The characters

One rig per person, one mixer per rig, driven entirely from `sim.js`'s plain data.

| # | Case | Status |
|---|---|---|
| L1 | **Every character animating in lockstep** | ✅ the usual way this ships broken. `SkeletonUtils.clone()`, never `mesh.clone()`: clips are shared data, the mixer and the skeleton are per person. Six people give six distinct skeletons. `test_view3d.mjs` K6 |
| L2 | No rig, a broken loader, a missing `.glb` | ✅ the layer always renders something: capsule stand-ins, sized from the manifest's measured bind-pose height |
| L3 | No `assets/manifest.json` | ✅ falls back to recognising clip names inside whatever `.glb` turns up; with no usable clip at all it degrades to stand-ins |
| L4 | Every `p.state` in the contract | ✅ each of the six maps to a clip, and the sim is driven over a full day to check it never produces a seventh. `test_view3d.mjs` K2, K5 |
| L5 | A gesture with no CC0 clip | ✅ three of the five are synthesised as additive layers from the rig's own measured pose; with no layer either, a short pitch pulse is the tell |
| L6 | A gesture mid-walk, mid-desk or on the way out | ✅ an additive layer is safe over any base clip; a full-body one-shot is suppressed while walking, leaving or seated, where it would stand the person up mid-stride. `test_view3d.mjs` K3 |
| L7 | A gesture on someone already removed | ✅ the avatar is dropped when its key leaves the roster; a stale gesture cannot resurrect them. `test_view3d.mjs` K1, K3 |
| L8 | A boss taking an instruction | ✅ `kind: 'prompt'` events carry no tool, so `p.gesture` stays empty — the nod is driven off the quoted `p.saying` instead |
| L9 | **135 teammates** | ✅ full rigs capped at 40, and the winning set is sorted by key so it cannot churn frame to frame. Everyone else is a capsule in one instanced batch, with a blob shadow. `test_view3d.mjs` K7 |
| L10 | Someone in the band while the focus is elsewhere | ✅ **the corrected budget rule** — the band sits under the camera at all times, so degrading someone in the cafeteria is the worst possible trade. `p.fac \|\| p.cowork` wins a rig ahead of the focused room, and wins the last slot when the cap bites. `test_view3d.mjs` K7 |
| L11 | Feet skating | ✅ the walk clip plays at *measured* ground speed over the 0.975 u/s its root motion was authored at — measured, because the personal-space shove and the slow-down into a waypoint both change it |
| L12 | A backgrounded tab, a zero dt, a negative dt, `NaN` | ✅ `dt` is clamped into `[0, 0.25]`; nobody moves and nobody is lost. `test_view3d.mjs` K4 |
| L13 | Fast-forward and catch-up | ✅ the sim teleports people on both, so mixers are frozen and the pose held — advancing them would animate a whole walk cycle across the floor in one frame. Both flags are read from `Sim.St` when no context is passed. `test_view3d.mjs` K4, Z5 |
| L14 | A frame that lands after `dispose()` | ✅ ignored, and a second `dispose()` is allowed. `test_view3d.mjs` K8 |

## M. Where the two views differ on purpose

Both views render the same world off the same `Sim` and `Floor`, and `test_view3d.mjs` section X
checks they agree on the things that matter: the prop vocabulary, the facility kinds and their
colours, which people exist and at which tiles, which rooms are dimmed behind a focus, and that
the 3D palette is written in the same colour space as office.js's. These are the differences
that are **not** bugs:

| Difference | Why |
|---|---|
| Speech bubbles are 2D-only | A bubble is screen-space text over a head; in 3D the plates are sprites and the chat log carries the words |
| Labels are canvas sprites in 3D | A `Sprite` is the only text three.js gives without a font loader. They are a fixed world size, so they grow and shrink with the camera instead of staying pin-sharp |
| 2D culls off-screen rooms; 3D draws everything | Instanced batches make culling pointless, and `frustumCulled` is off by necessity (K4). 3D is a superset, so nobody can vanish in it |
| Unfocused rooms are alpha .1 in 2D, a dark tint in 3D | Per-instance alpha is not a thing; per-instance colour is |
| Props are not dimmed in 3D | They are batched across rooms; tracking each room's prop indices to dim them costs more bookkeeping than the effect is worth |
| The boss is 1.1× in 2D, 1.06× in 3D | A rig needs less exaggeration than a 16-pixel box |
| The 3D LOD rule counts a facility seat-holder as "in the band" from the moment they claim it; 2D counts them once they have arrived | The 2D test is about culling (where are they standing), the 3D one about budget (do not degrade someone about to be under the camera) |

And two the views genuinely disagree about, both listed above as unhandled: **a search does
nothing in 3D** (K12), and **a monitor is lit for an absent owner in 2D but only for a seated
typist in 3D** (`test_view3d.mjs` X7). The second is a decision rather than obviously a bug —
dropping the `state === 'type'` test would align them.
