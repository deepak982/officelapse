#!/usr/bin/env node
/* test_floor.js — invariant checks for floor.js.
   Plain node + assert. No framework, no deps.   Run:  node test_floor.js
   Known floor.js bugs these checks expose are written up at the bottom.        */
'use strict';

const assert = require('assert');
const Floor = require('./floor.js');
const { ROOM_W, ROOM_H, SLOT_W, DEPT_COLS, DEPT_PITCH, N, E, S, W } = Floor;

const PROJ = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];

/* build counts[i] rooms for PROJ[i], in project order; returns creation order */
function build(counts) {
  const out = [];
  counts.forEach((c, i) => {
    for (let k = 0; k < c; k++) out.push(Floor.ensureRoom(`${PROJ[i]}:s${k}`, PROJ[i]));
  });
  return out;
}

const rooms = () => Object.keys(Floor.state.rooms).map(s => Floor.state.rooms[s]);

const rectsOverlap = (a, b) =>
  a.gx < b.gx + ROOM_W && b.gx < a.gx + ROOM_W &&
  a.gy < b.gy + ROOM_H && b.gy < a.gy + ROOM_H;

/* every tile a person is ever asked to stand on inside a room */
const stations = (r) => [
  ...r.desks.map((d, i) => ({ what: `desk${i}.seat`, x: d.seat.x, y: d.seat.y })),
  { what: 'boss.seat', x: r.boss.seat.x, y: r.boss.seat.y },
  ...r.meet.map((p, i) => ({ what: `meet${i}`, x: p.x, y: p.y })),
  ...r.break.map((p, i) => ({ what: `break${i}`, x: p.x, y: p.y })),
  ...r.archive.map((p, i) => ({ what: `archive${i}`, x: p.x, y: p.y })),
];

const fingerprint = (r) =>
  r.desks.map(d => `${d.x},${d.y}|${d.seat.x},${d.seat.y}|${d.dir}`).join(' ') +
  ` B${r.boss.x},${r.boss.y} D${r.door.x},${r.door.y}` +
  ` M${r.meet.map(p => `${p.x},${p.y}`).join('/')}`;

/* ---------------------------------------------------------- segment walk --- */
/* EXACT, not sampled. Sampling a segment at a fixed stride is unsound: a leg can
   slice a sliver of a blocked tile thinner than the stride and be missed — which
   is precisely the bug floor.js's own lineClear() has. So: find every t where the
   segment crosses an integer x or y boundary, and take the tile at the midpoint
   of each resulting interval. That enumerates every tile the segment truly enters. */
function tilesAlong(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const cuts = new Set([0, 1]);
  const addCuts = (p0, d) => {
    if (!d) return;
    const lo = Math.min(p0, p0 + d), hi = Math.max(p0, p0 + d);
    for (let v = Math.ceil(lo); v <= Math.floor(hi); v++) {
      const t = (v - p0) / d;
      if (t > 0 && t < 1) cuts.add(t);
    }
  };
  addCuts(a.x, dx); addCuts(a.y, dy);
  const ts = [...cuts].sort((p, q) => p - q);
  const out = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const m = (ts[i] + ts[i + 1]) / 2;
    out.push({ x: Math.floor(a.x + dx * m), y: Math.floor(a.y + dy * m) });
  }
  return out;
}

/* does the leg enter the interior of a blocked tile? */
function legCrossesBlocked(a, b) {
  for (const t of tilesAlong(a, b)) if (!Floor.walkable(t.x, t.y)) return t;
  return null;
}

/* does the leg slip diagonally past a blocked corner?
   consecutive entered tiles differing in BOTH axes = the segment went through a
   lattice corner; if either shoulder there is furniture, the walker clips it. */
function legCutsCorner(a, b) {
  const ts = tilesAlong(a, b);
  for (let i = 1; i < ts.length; i++) {
    const p = ts[i - 1], c = ts[i];
    if (p.x === c.x || p.y === c.y) continue;
    if (!Floor.walkable(p.x, c.y) || !Floor.walkable(c.x, p.y))
      return { from: p, to: c, shoulders: [{ x: p.x, y: c.y }, { x: c.x, y: p.y }] };
  }
  return null;
}

function eachLeg(pts, fn) {
  let n = 0;
  for (let i = 0; i + 1 < pts.length; i++) { fn(pts[i], pts[i + 1], i); n++; }
  return n;
}

/* the standard path sample set: worth building once per check */
function samplePaths(rs, pick) {
  const out = [];
  for (const r of pick) {
    const st = stations(r);
    for (const s of st) {
      const p = Floor.path(r.door.x, r.door.y, s.x, s.y);
      if (p) out.push([`${r.sid} door->${s.what}`, p]);
    }
    for (let i = 0; i < st.length; i += 3) for (let j = 1; j < st.length; j += 5) {
      if (i === j) continue;
      const p = Floor.path(st[i].x, st[i].y, st[j].x, st[j].y);
      if (p) out.push([`${r.sid} ${st[i].what}->${st[j].what}`, p]);
    }
  }
  for (const a of pick) for (const b of pick) {
    if (a === b) continue;
    for (const [pa, pb] of [[a.door, b.door], [a.desks[0].seat, b.desks[23].seat],
                            [a.break[0], b.archive[2]], [a.boss.seat, b.meet[0]]]) {
      const p = Floor.path(pa.x, pa.y, pb.x, pb.y);
      if (p) out.push([`${a.sid}->${b.sid}`, p]);
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 1 ------ */
function checkNoRoomOverlap() {
  Floor.reset();
  const rs = build([4, 3, 3, 2]);
  assert.strictEqual(rs.length, 12);
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++)
      assert.ok(!rectsOverlap(rs[i], rs[j]),
        `${rs[i].sid} (${rs[i].gx},${rs[i].gy}) overlaps ${rs[j].sid} (${rs[j].gx},${rs[j].gy})`);
  console.log(`PASS   1  no room overlaps — ${rs.length} rooms across 4 departments`);
}

/* ---------------------------------------------------------------- 2 ------ */
/* THE teleport regression: a placed room must never move, ever. */
function checkRoomsNeverMove() {
  Floor.reset();
  build([2, 2, 1]);
  const before = {};
  for (const r of rooms())
    before[r.sid] = { gx: r.gx, gy: r.gy, fp: fingerprint(r), deptIdx: r.dept.idx };

  Floor.ensureRoom('alpha:new', 'alpha');          // new session, existing project
  Floor.ensureRoom('beta:new', 'beta');
  Floor.ensureRoom('gamma:new', 'gamma');
  Floor.ensureRoom('delta:s0', 'delta');           // brand-new department
  Floor.ensureRoom('epsilon:s0', 'epsilon');
  for (let k = 0; k < 6; k++)                      // spill onto a second dept row
    Floor.ensureRoom(`alpha:x${k}`, 'alpha');

  for (const sid in before) {
    const r = Floor.state.rooms[sid], b = before[sid];
    assert.strictEqual(r.gx, b.gx, `${sid} TELEPORTED in x: ${b.gx} -> ${r.gx}`);
    assert.strictEqual(r.gy, b.gy, `${sid} TELEPORTED in y: ${b.gy} -> ${r.gy}`);
    assert.strictEqual(r.dept.idx, b.deptIdx, `${sid} changed department index`);
    assert.strictEqual(fingerprint(r), b.fp, `${sid} furniture moved under its people`);
  }
  const a0 = Floor.state.rooms['alpha:s0'];
  assert.strictEqual(Floor.ensureRoom('alpha:s0', 'alpha'), a0, 'ensureRoom re-placed a known sid');
  assert.strictEqual(Floor.ensureRoom('alpha:s0', 'different-project'), a0,
    'a known sid was re-homed when the project string changed');
  console.log(`PASS   2  rooms never move — ${Object.keys(before).length} rooms fixed after 11 later rooms`);
}

/* ---------------------------------------------------------------- 3 ------ */
function checkDeptsSeparated() {
  Floor.reset();
  build([4, 3, 3, 2]);
  const band = (i) => ({ lo: i * DEPT_PITCH, hi: i * DEPT_PITCH + DEPT_COLS * SLOT_W });
  const depts = Object.keys(Floor.state.depts).map(p => Floor.state.depts[p]);
  assert.strictEqual(new Set(depts.map(d => d.idx)).size, depts.length, 'duplicate department index');

  for (const r of rooms()) {
    const own = band(r.dept.idx);
    assert.ok(r.gx >= own.lo && r.gx + ROOM_W <= own.hi,
      `${r.sid} at gx=${r.gx} escapes its own band [${own.lo},${own.hi})`);
    for (const d of depts) {
      if (d.idx === r.dept.idx) continue;
      const b = band(d.idx);
      assert.ok(r.gx + ROOM_W <= b.lo || r.gx >= b.hi,
        `${r.sid} (${r.proj}) sits inside ${d.proj}'s band [${b.lo},${b.hi})`);
    }
  }
  console.log(`PASS   3  departments separated — ${depts.length} bands, no room crosses one`);
}

/* ---------------------------------------------------------------- 4 ------ */
function checkStationsReachable() {
  Floor.reset();
  const rs = build([4, 3, 3, 2]);
  let checked = 0;
  for (const r of [rs[0], rs[3], rs[4], rs[11]]) {
    assert.ok(Floor.walkable(r.door.x, r.door.y), `${r.sid}: door tile is blocked`);
    const st = stations(r);
    // structural, not a frozen furniture count: the room's shape may gain props
    assert.strictEqual(r.desks.length, 24, `${r.sid}: expected 24 desks, got ${r.desks.length}`);
    for (const z of ['meet', 'break', 'archive'])
      assert.ok(r[z] && r[z].length, `${r.sid}: zone ${z} has no standing spots`);
    assert.strictEqual(new Set(st.map(s => `${s.x},${s.y}`)).size, st.length,
      `${r.sid}: two stations share a tile`);
    for (const s of st) {
      assert.ok(Floor.walkable(s.x, s.y), `${r.sid} ${s.what} (${s.x},${s.y}) is not walkable`);
      const p = Floor.path(r.door.x, r.door.y, s.x, s.y);
      assert.ok(p, `${r.sid}: no path from door (${r.door.x},${r.door.y}) to ${s.what} (${s.x},${s.y})`);
      assert.deepStrictEqual(p[p.length - 1], { x: s.x, y: s.y },
        `${r.sid}: path to ${s.what} ends somewhere else`);
      checked++;
    }
  }
  console.log(`PASS   4  every station reachable from its door — ${checked} paths`);
}

/* ---------------------------------------------------------------- 5 ------ */
/* smoothing must never merge waypoints across furniture */
function checkPathsAvoidBlocked() {
  Floor.reset();
  const rs = build([4, 3, 3, 2]);
  const paths = samplePaths(rs, [rs[0], rs[3], rs[6], rs[11]]);
  let legs = 0;
  for (const [label, p] of paths) {
    legs += eachLeg(p, (a, b, i) => {
      const hit = legCrossesBlocked(a, b);
      assert.ok(!hit, `${label}: leg ${i} (${a.x},${a.y})->(${b.x},${b.y}) ` +
        `passes through BLOCKED tile (${hit && hit.x},${hit && hit.y})`);
    });
  }
  console.log(`PASS   5  no path enters a blocked tile — ${paths.length} paths, ${legs} legs (exact traversal)`);
}

/* --------------------------------------------------------------- 5b ------ */
/* floor.js line 9: "paths ... never cut a blocked corner". 4-connected BFS
   guarantees it; smoothing must not give it back. */
function checkPathsDontCutCorners() {
  Floor.reset();
  const rs = build([4, 3, 3, 2]);
  const paths = samplePaths(rs, [rs[0], rs[3], rs[6], rs[11]]);
  let legs = 0;
  for (const [label, p] of paths) {
    legs += eachLeg(p, (a, b, i) => {
      const c = legCutsCorner(a, b);
      assert.ok(!c, `${label}: leg ${i} (${a.x},${a.y})->(${b.x},${b.y}) cuts the corner ` +
        `between tiles (${c && c.from.x},${c && c.from.y}) and (${c && c.to.x},${c && c.to.y}) — ` +
        `shoulder (${c && c.shoulders[0].x},${c && c.shoulders[0].y}) / ` +
        `(${c && c.shoulders[1].x},${c && c.shoulders[1].y}) is furniture`);
    });
  }
  console.log(`PASS  5b  no path cuts a blocked corner — ${paths.length} paths, ${legs} legs`);
}

/* ---------------------------------------------------------------- 6 ------ */
function checkCrossBuildingRouting() {
  Floor.reset();
  const rs = build([4, 3, 3, 2]);
  const first = rs[0], last = rs[rs.length - 1];
  assert.notStrictEqual(first.dept.idx, last.dept.idx, 'test needs two departments');
  const legs = [
    ['door->door', first.door, last.door],
    ['desk->desk', first.desks[0].seat, last.desks[23].seat],
    ['break->boss', first.break[0], last.boss.seat],
    ['back again', last.archive[0], first.meet[5]],
  ];
  for (const [what, a, b] of legs) {
    const p = Floor.path(a.x, a.y, b.x, b.y);
    assert.ok(p, `cross-building ${what}: no path ${first.proj} -> ${last.proj}`);
  }
  const far = Floor.path(first.door.x, first.door.y, last.door.x, last.door.y);
  const span = last.gx - first.gx;
  assert.ok(span > 2 * DEPT_PITCH, `departments not far apart (${span} tiles)`);
  console.log(`PASS   6  cross-building routing — ${first.proj} -> ${last.proj}, ` +
              `${span} tiles apart, ${far.length} waypoints`);
}

/* ---------------------------------------------------------------- 7 ------ */
function checkDeskClaimsStable() {
  Floor.reset();
  build([1, 1]);
  const r = Floor.state.rooms['alpha:s0'];
  const aids = ['ag1', 'ag2', 'ag3', 'ag4', 'ag5'];

  const first = aids.map(a => Floor.claimDesk(r, a));
  first.forEach((d, i) => assert.ok(d, `${aids[i]} got no desk in an empty room`));
  const seats = first.map(d => r.desks.indexOf(d));
  assert.strictEqual(new Set(seats).size, aids.length, 'two agents were handed the same desk');
  aids.forEach((a, i) => assert.strictEqual(Floor.claimDesk(r, a), first[i], `${a} moved desk on re-claim`));

  const gw0 = Floor.state.gw, gh0 = Floor.state.gh;
  for (let k = 0; k < 5; k++) Floor.ensureRoom(`gamma:s${k}`, 'gamma');
  for (let k = 0; k < 4; k++) Floor.ensureRoom(`delta:s${k}`, 'delta');
  assert.ok(Floor.state.gw > gw0 && Floor.state.gh > gh0,
    'grid did not grow — this check is not exercising regrow');

  aids.forEach((a, i) => {
    const d = Floor.claimDesk(r, a);
    assert.strictEqual(d, first[i], `${a} lost its desk after grid growth`);
    assert.strictEqual(r.claims[a], seats[i], `${a}'s desk index changed after grid growth`);
    assert.strictEqual(d.by, a, `${a}'s desk forgot its owner`);
  });
  console.log(`PASS   7  desk claims stable — ${aids.length} agents kept their desk ` +
              `across regrow to ${Floor.state.gw}x${Floor.state.gh}`);
}

/* ---------------------------------------------------------------- 8 ------ */
function checkDeskExhaustion() {
  Floor.reset();
  const r = Floor.ensureRoom('alpha:s0', 'alpha');
  const total = r.desks.length;
  assert.strictEqual(total, 24, `expected 24 desks, got ${total}`);

  const got = [];
  for (let i = 0; i < total + 12; i++) got.push(Floor.claimDesk(r, 'a' + i));

  for (let i = 0; i < total; i++) assert.ok(got[i], `agent a${i} should have been seated`);
  for (let i = total; i < got.length; i++)
    assert.strictEqual(got[i], null, `agent a${i} got a desk from a full room`);
  assert.strictEqual(new Set(got.slice(0, total)).size, total, 'a desk was handed out twice');

  const owners = r.desks.map(d => d.by);
  assert.ok(owners.every(o => o !== null), 'a desk is unclaimed in a full room');
  assert.strictEqual(new Set(owners).size, total, 'a desk records two owners');
  for (let i = total; i < got.length; i++)
    assert.strictEqual(r.claims['a' + i], undefined, `a${i} was recorded as claiming a desk`);
  console.log(`PASS   8  desk exhaustion degrades gracefully — ${total} seated, ` +
              `${got.length - total} turned away with null`);
}

/* ---------------------------------------------------------------- 9 ------ */
function checkQueueSpots() {
  Floor.reset();
  const r = Floor.ensureRoom('alpha:s0', 'alpha');

  for (const zone of ['meet', 'break', 'archive']) {
    const spots = r[zone];
    assert.ok(spots && spots.length, `${zone} has no spots`);
    const keys = spots.map((_, i) => `${zone}-k${i}`);

    const got = keys.map(k => Floor.takeSpot(r, zone, k));
    assert.strictEqual(new Set(got).size, spots.length, `${zone}: distinct keys double-booked a spot`);
    got.forEach((s, i) => assert.ok(spots.includes(s), `${zone}: ${keys[i]} got a spot outside the zone`));
    keys.forEach((k, i) => assert.strictEqual(Floor.takeSpot(r, zone, k), got[i], `${zone}: ${k} was moved`));

    const over = Floor.takeSpot(r, zone, `${zone}-overflow`);
    assert.ok(spots.includes(over), `${zone}: overflow returned ${over} instead of sharing a spot`);

    const i1 = 1 % keys.length;
    Floor.releaseSpots(r, keys[i1]);
    assert.strictEqual(Floor.takeSpot(r, zone, `${zone}-fresh`), got[i1],
      `${zone}: released spot was not handed back`);
    keys.forEach((k, i) => {
      if (i === i1) return;
      assert.strictEqual(Floor.takeSpot(r, zone, k), got[i],
        `${zone}: ${k} lost its spot when another key released`);
    });
  }

  const a = Floor.takeSpot(r, 'break', 'shared-key');
  const b = Floor.takeSpot(r, 'archive', 'shared-key');
  assert.ok(r.break.includes(a) && r.archive.includes(b), 'zone bookkeeping leaked across zones');
  assert.strictEqual(Floor.takeSpot(r, 'nosuchzone', 'x'), null, 'unknown zone should return null');
  console.log(`PASS   9  queue spots never double-book — meet/break/archive, release + reuse verified`);
}

/* --------------------------------------------------------------- 10 ------ */
function checkDeskOrientation() {
  Floor.reset();
  build([3, 2]);
  // dir = the way the occupant looks, so seat = desk + offset
  const seatOffset = { [N]: [0, 1], [E]: [-1, 0], [S]: [0, -1], [W]: [1, 0] };
  const names = { [N]: 'N', [E]: 'E', [S]: 'S', [W]: 'W' };
  let n = 0;

  for (const r of rooms()) {
    for (const [label, d] of r.desks.map((d, i) => [`desk${i}`, d]).concat([['boss', r.boss]])) {
      const dx = d.seat.x - d.x, dy = d.seat.y - d.y;
      assert.strictEqual(Math.abs(dx) + Math.abs(dy), 1,
        `${r.sid} ${label}: seat (${d.seat.x},${d.seat.y}) is not 1 tile from desk (${d.x},${d.y})`);
      assert.ok(Floor.walkable(d.seat.x, d.seat.y),
        `${r.sid} ${label}: seat (${d.seat.x},${d.seat.y}) is blocked — nobody can sit there`);
      assert.ok(!Floor.walkable(d.x, d.y),
        `${r.sid} ${label}: desk tile (${d.x},${d.y}) is walkable — people will stroll through it`);
      const want = seatOffset[d.dir];
      assert.ok(want, `${r.sid} ${label}: dir ${d.dir} is not one of N/E/S/W`);
      assert.deepStrictEqual([dx, dy], want,
        `${r.sid} ${label}: dir ${names[d.dir]} wants seat at desk+(${want}) but seat is desk+(${dx},${dy})`);
      n++;
    }
    const tiles = r.desks.map(d => `${d.x},${d.y}`).concat(`${r.boss.x},${r.boss.y}`);
    const sits = r.desks.map(d => `${d.seat.x},${d.seat.y}`).concat(`${r.boss.seat.x},${r.boss.seat.y}`);
    assert.strictEqual(new Set(tiles).size, tiles.length, `${r.sid}: two desks on one tile`);
    assert.strictEqual(new Set(sits).size, sits.length, `${r.sid}: two seats on one tile`);
    assert.strictEqual(new Set(tiles.concat(sits)).size, tiles.length + sits.length,
      `${r.sid}: a seat sits on a desk`);
  }
  console.log(`PASS  10  desk orientation sane — ${n} desks: seat adjacent, walkable, ` +
              `desk blocked, dir agrees`);
}

/* -------------------------------------------------------------------------- */
function main() {
  const checks = [
    ['1', checkNoRoomOverlap], ['2', checkRoomsNeverMove], ['3', checkDeptsSeparated],
    ['4', checkStationsReachable], ['5', checkPathsAvoidBlocked], ['5b', checkPathsDontCutCorners],
    ['6', checkCrossBuildingRouting], ['7', checkDeskClaimsStable], ['8', checkDeskExhaustion],
    ['9', checkQueueSpots], ['10', checkDeskOrientation],
  ];
  const failed = [];
  for (const [id, fn] of checks) {
    try { fn(); }
    catch (e) { failed.push([id, e]); console.log(`FAIL  ${id.padStart(2)}  ${e.message}`); }
  }
  if (!failed.length) return console.log('floor ok');
  console.log(`\n${failed.length} check(s) FAILED — these are floor.js bugs, not test bugs.`);
  console.log('See "KNOWN floor.js BUGS" at the bottom of test_floor.js.');
  process.exitCode = 1;
}

main();

/* ============================ KNOWN floor.js BUGS ==========================
   Checks 5 and 5b fail. Both are ONE root cause:

     lineClear() tests a segment by SAMPLING it at a fixed 0.25-tile stride.
     Sampling is unsound. Any crossing of a blocked tile shorter than the stride
     is invisible to it, and smooth() deliberately tries the LONGEST legs first,
     which is exactly where near-tangent slivers happen. So smoothing merges
     waypoints across furniture that the 4-connected BFS had carefully walked
     around, undoing the guarantee stated on line 9 of floor.js.

   check 5 — a smoothed leg enters the interior of a blocked tile.
     Reproduce (one room, local coords):  boss.seat (16,4) -> break[0] (3,15)
       raw bfs   24 legs, never adjacent to a prop
       smoothed   2 legs: (16,4) (4,15) (3,15)
       leg 0 slices local tile (13,5), the whiteboard: enters (14.000, 5.834),
       leaves (13.818, 6.000) — a 0.246-tile slice.
       lineClear() returns TRUE: its stride on that leg is 0.2466 tiles, wider
       than the slice, so every one of its samples lands outside the whiteboard.
       People walk through the furniture.

   check 5b — a smoothed leg cuts a blocked corner. floor.js line 9 promises this
     never happens, and avoiding it is the entire reason bfs() is 4-connected.
     Reproduce:  door (10,0) -> meet[0] (14,8)
       raw bfs   12 legs, a clean staircase
       smoothed   1 leg: (10,0) -> (14,8)
       it passes through the lattice corner at local (13,6); the shoulder tile
       local (13,5) is the whiteboard, so the walker clips its corner.
     Dozens of distinct sites per room do this, clipping desk pods, the meeting
     table, the filing cabinet and the whiteboard.

   Fix belongs in lineClear(), not in the callers: replace stride sampling with an
   exact grid traversal (supercover / Amanatides-Woo DDA) and reject a step whose
   two shoulder tiles are not BOTH free. tilesAlong() near the top of this file is
   a compact reference implementation of the traversal.

   Exact tile coordinates above are from the room layout at the time of writing;
   the mechanism is layout-independent, and each failing check prints its own
   live reproduction.
   ========================================================================== */
