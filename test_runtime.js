#!/usr/bin/env node
/* test_runtime.js — runtime / churn edge cases for floor.js.
   Plain node + assert. No framework, no deps.   Run:  node test_runtime.js

   Covers the EDGE_CASES.md rows that only show up once the floor is LIVE:
   oversized teams, desks recycling, rooms appearing while people are seated,
   queue contention, and paths around the furniture added after test_floor.js.
   test_floor.js owns the static geometry and the raw pathfinding; nothing here
   repeats it.                                                                */
'use strict';

const assert = require('assert');
const Floor = require('./floor.js');
const { ROOM_W, ROOM_H, SLOT_W, DEPT_COLS, DEPT_PITCH, CORRIDOR_H } = Floor;

/* ------------------------------------------------------------- helpers --- */

const key = (p) => `${p.x},${p.y}`;
const rooms = () => Object.values(Floor.state.rooms);

const rectsOverlap = (a, b) =>
  a.gx < b.gx + ROOM_W && b.gx < a.gx + ROOM_W &&
  a.gy < b.gy + ROOM_H && b.gy < a.gy + ROOM_H;

/* deterministic — a flaky churn test is worse than no churn test */
function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/* every tile a person can be sent to inside a room */
function stations(r) {
  return [
    ...r.desks.map((d, i) => ({ what: `desk${i}.seat`, x: d.seat.x, y: d.seat.y })),
    { what: 'boss.seat', x: r.boss.seat.x, y: r.boss.seat.y },
    ...r.meet.map((p, i) => ({ what: `meet${i}`, x: p.x, y: p.y })),
    ...r.break.map((p, i) => ({ what: `break${i}`, x: p.x, y: p.y })),
    ...r.archive.map((p, i) => ({ what: `archive${i}`, x: p.x, y: p.y })),
  ];
}

/* the desk bookkeeping must agree with itself at every instant */
function assertClaimsConsistent(room, where) {
  const owned = room.desks.filter(d => d.by !== null);
  const ids = owned.map(d => d.by);
  assert.strictEqual(new Set(ids).size, ids.length,
    `${where}: a desk is double-owned (${ids.length} owners, ${new Set(ids).size} distinct)`);
  const claimKeys = Object.keys(room.claims);
  assert.strictEqual(claimKeys.length, owned.length,
    `${where}: claims has ${claimKeys.length} entries but ${owned.length} desks are occupied`);
  const seen = new Set();
  for (const aid of claimKeys) {
    const i = room.claims[aid];
    assert.ok(room.desks[i], `${where}: claim ${aid} -> desk index ${i} does not exist`);
    assert.strictEqual(room.desks[i].by, aid,
      `${where}: claim ${aid} -> desk ${i} but that desk is held by ${room.desks[i].by}`);
    assert.ok(!seen.has(i), `${where}: desk index ${i} claimed twice`);
    seen.add(i);
  }
}

/* -------------------------------------------------------- segment walk --- */
/* EXACT traversal, written here independently of floor.js's own lineClear so a
   bug in that function cannot certify itself. A fixed-stride sample misses any
   slice of a blocked tile thinner than the stride, and smooth() tries the
   LONGEST legs first, which is exactly where those slivers live. So: cut the
   segment at every integer x and y boundary it crosses and take the tile under
   the midpoint of each resulting interval. That is every tile the leg truly
   enters, sliver or not. */
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

function legCrossesBlocked(a, b) {
  for (const t of tilesAlong(a, b)) if (!Floor.walkable(t.x, t.y)) return t;
  return null;
}

/* consecutive entered tiles differing on BOTH axes = the leg went through a
   lattice corner; if either shoulder is furniture the walker clips it */
function legCutsCorner(a, b) {
  const ts = tilesAlong(a, b);
  for (let i = 1; i < ts.length; i++) {
    const p = ts[i - 1], c = ts[i];
    if (p.x === c.x || p.y === c.y) continue;
    if (!Floor.walkable(p.x, c.y) || !Floor.walkable(c.x, p.y))
      return { from: p, to: c };
  }
  return null;
}

/* =========================================================== C2 ========== */
/* A team far larger than the room. The bug being guarded against: dozens of
   teammates stacked on the boss's chair. */
function checkC2() {
  Floor.reset();
  const room = Floor.ensureRoom('s-big', 'alpha');
  Floor.claimBoss(room, 's-big');

  const nDesks = room.desks.length;
  const TEAM = 135;
  assert.ok(TEAM > nDesks, `fixture broken: ${TEAM} agents is not larger than ${nDesks} desks`);

  const seated = [], hot = [];
  for (let i = 0; i < TEAM; i++) {
    const aid = `agent-${i}`;
    const spot = Floor.claimDesk(room, aid) || Floor.hotDesk(room, aid);
    assert.ok(spot, `${aid} got neither a desk nor a hot-desk`);
    (spot.hot ? hot : seated).push({ aid, spot });
  }

  assert.strictEqual(seated.length, nDesks,
    `${seated.length} agents got real desks, expected exactly ${nDesks}`);
  assert.strictEqual(hot.length, TEAM - nDesks,
    `${hot.length} agents hot-desked, expected ${TEAM - nDesks}`);
  for (const h of hot)
    assert.strictEqual(h.spot.hot, true, `${h.aid}'s overflow spot is not marked hot:true`);

  /* real desks are one per person */
  const deskKeys = seated.map(s => key(s.spot));
  assert.strictEqual(new Set(deskKeys).size, nDesks, 'two teammates got the same real desk');
  assertClaimsConsistent(room, 'C2');

  /* THE ONE THAT MATTERS: nobody sits in the boss's chair */
  const bs = room.boss.seat;
  for (const p of seated.concat(hot))
    assert.ok(!(p.spot.seat.x === bs.x && p.spot.seat.y === bs.y),
      `${p.aid} was placed on the boss's chair at ${key(bs)}`);

  /* overflow stands in the break / meeting areas, on tiles you can stand on */
  const pool = new Set(room.break.concat(room.meet).map(key));
  for (const h of hot) {
    assert.ok(pool.has(key(h.spot.seat)),
      `${h.aid} hot-desked to ${key(h.spot.seat)}, which is not a break or meeting spot`);
    assert.ok(Floor.walkable(h.spot.seat.x, h.spot.seat.y),
      `${h.aid} hot-desked onto blocked tile ${key(h.spot.seat)}`);
  }
  /* and hot-desking is stable: same agent, same spot */
  for (const h of hot.slice(0, 20))
    assert.strictEqual(key(Floor.hotDesk(room, h.aid).seat), key(h.spot.seat),
      `${h.aid}'s hot-desk spot moved between calls`);

  console.log(`PASS  C2     team larger than the room — ${TEAM} agents: ${nDesks} desks + ` +
    `${hot.length} hot-desks over ${pool.size} break/meeting spots, nobody on the boss's chair`);
}

/* =========================================================== C3 ========== */
/* Desks recycle when teammates clock out. */
function checkC3() {
  Floor.reset();
  const room = Floor.ensureRoom('s-recycle', 'alpha');
  const nDesks = room.desks.length;

  for (let i = 0; i < nDesks; i++)
    assert.ok(Floor.claimDesk(room, `a${i}`), `a${i} should have got a real desk`);
  assert.strictEqual(Floor.claimDesk(room, 'a-late'), null,
    'a full room still handed out a desk');

  const leaving = ['a0', 'a7', 'a13', 'a23'];
  const freed = leaving.map(aid => room.desks[room.claims[aid]]);
  leaving.forEach(aid => Floor.releaseDesk(room, aid));

  freed.forEach((d, i) => {
    assert.strictEqual(d.by, null, `${leaving[i]}'s desk still reads by=${d.by} after release`);
    assert.strictEqual(room.claims[leaving[i]], undefined,
      `${leaving[i]} still has a claim entry after release`);
  });
  assertClaimsConsistent(room, 'C3 after release');

  /* releasing someone who never claimed must not throw or disturb anything */
  const before = room.desks.map(d => d.by).join('|');
  const nBefore = Object.keys(room.claims).length;
  assert.doesNotThrow(() => Floor.releaseDesk(room, 'never-worked-here'),
    'releaseDesk threw for an agent that never claimed');
  assert.doesNotThrow(() => Floor.releaseDesk(room, 'a0'),
    'releaseDesk threw on a double release');
  assert.strictEqual(room.desks.map(d => d.by).join('|'), before,
    'releasing an unknown agent changed desk ownership');
  assert.strictEqual(Object.keys(room.claims).length, nBefore,
    'releasing an unknown agent changed the claim count');

  /* the freed desks go to the next arrivals */
  const freedKeys = new Set(freed.map(key));
  const arrivals = ['b0', 'b1', 'b2', 'b3'];
  for (const aid of arrivals) {
    const d = Floor.claimDesk(room, aid);
    assert.ok(d, `${aid} got no desk although ${leaving.length} were freed`);
    assert.strictEqual(d.hot, undefined, `${aid} got a hot-desk instead of a real desk`);
    assert.ok(freedKeys.has(key(d)), `${aid} got desk ${key(d)}, not one of the freed desks`);
  }
  assert.strictEqual(Floor.claimDesk(room, 'b-late'), null,
    'the room handed out a desk after being refilled to capacity');
  assertClaimsConsistent(room, 'C3 after refill');

  console.log(`PASS  C3     desks recycle — ${nDesks} claimed, ${leaving.length} released ` +
    `and reused, unknown release is a no-op`);
}

/* =========================================================== C3b ========= */
/* Release / reclaim churn: the bookkeeping must never drift. */
function checkC3b() {
  Floor.reset();
  const room = Floor.ensureRoom('s-churn', 'alpha');
  const rand = rng(20260928);
  const live = [];
  let claimed = 0, released = 0, refused = 0;

  for (let step = 0; step < 4000; step++) {
    if (live.length && rand() < 0.45) {
      const i = Math.floor(rand() * live.length);
      const aid = live[i];
      live[i] = live[live.length - 1]; live.pop();
      Floor.releaseDesk(room, aid);
      released++;
      assert.strictEqual(room.claims[aid], undefined, `${aid} kept a claim after release`);
    } else {
      const aid = `w${step}`;
      const d = Floor.claimDesk(room, aid);
      if (d) { live.push(aid); claimed++; assert.strictEqual(d.by, aid, `${aid}'s desk reads by=${d.by}`); }
      else { refused++; assert.strictEqual(room.claims[aid], undefined, `${aid} got a claim but no desk`); }
    }
    assertClaimsConsistent(room, `C3b step ${step}`);
    assert.strictEqual(Object.keys(room.claims).length, live.length,
      `C3b step ${step}: ${live.length} agents are clocked in but claims holds ` +
      `${Object.keys(room.claims).length}`);
  }
  assert.ok(refused > 0, 'churn never hit a full room — the test is not exercising overflow');
  assert.ok(released > 100, 'churn barely released anything');

  console.log(`PASS  C3b    churn stays consistent — 4000 cycles, ${claimed} claims, ` +
    `${released} releases, ${refused} refusals, no desk ever double-owned`);
}

/* =========================================================== C7 ========== */
/* An agent that clocks out and comes back. */
function checkC7() {
  Floor.reset();
  const room = Floor.ensureRoom('s-return', 'alpha');

  const first = Floor.claimDesk(room, 'wanderer');
  assert.ok(first, 'wanderer got no desk on arrival');
  const firstIdx = room.claims['wanderer'];

  Floor.releaseDesk(room, 'wanderer');
  assert.strictEqual(first.by, null, 'the vacated desk still reads as occupied');
  assert.strictEqual(room.claims['wanderer'], undefined, 'the claim survived clock-out');

  /* the floor keeps running while they are away, and someone takes the desk */
  for (let i = 0; i < 5; i++) assert.ok(Floor.claimDesk(room, `other${i}`));
  assert.strictEqual(room.desks[firstIdx].by, 'other0',
    'the vacated desk was not handed to the next arrival');

  const back = Floor.claimDesk(room, 'wanderer');
  assert.ok(back, 'a returning agent got no desk although the room had room');
  assert.strictEqual(back.hot, undefined, 'a returning agent was hot-desked despite free desks');
  assert.ok(room.desks.includes(back), 'a returning agent got a desk not belonging to the room');
  assert.strictEqual(back.by, 'wanderer', `returned desk reads by=${back.by}`);
  assert.strictEqual(room.desks[room.claims['wanderer']], back, 'claim points at a different desk');
  assert.ok(Floor.walkable(back.seat.x, back.seat.y), 'returned desk seat is a blocked tile');
  assert.strictEqual(Floor.claimDesk(room, 'wanderer'), back, 're-claiming moved a seated agent');
  assertClaimsConsistent(room, 'C7');

  console.log(`PASS  C7     clock out and return — desk ${firstIdx} recycled to another agent, ` +
    `returning agent re-seated at desk ${room.claims['wanderer']}`);
}

/* =========================================================== E3 ========== */
/* Queue spots: numbered, never double-booked, released, overflow survivable. */
function checkE3() {
  Floor.reset();
  const room = Floor.ensureRoom('s-queue', 'alpha');
  let total = 0;

  for (const zone of ['meet', 'break', 'archive']) {
    const spots = room[zone];
    const n = spots.length;
    assert.ok(n > 0, `zone ${zone} has no spots`);
    total += n;

    const got = [];
    for (let i = 0; i < n; i++) {
      const s = Floor.takeSpot(room, zone, `${zone}-k${i}`);
      assert.ok(s, `${zone}-k${i} got no spot although ${n} exist`);
      got.push(s);
    }
    assert.strictEqual(new Set(got.map(key)).size, n,
      `${zone}: ${n} distinct keys shared spots — ${got.map(key).join(' ')}`);

    /* same key twice = same spot */
    for (let i = 0; i < n; i++)
      assert.strictEqual(Floor.takeSpot(room, zone, `${zone}-k${i}`), got[i],
        `${zone}-k${i} was moved on its second request`);

    /* overflow: more keys than spots, degrade but never throw */
    for (let i = 0; i < 5; i++) {
      let over;
      assert.doesNotThrow(() => { over = Floor.takeSpot(room, zone, `${zone}-over${i}`); },
        `${zone}: takeSpot threw once the zone was full`);
      assert.ok(over, `${zone}: overflow key ${i} got nothing back`);
      assert.ok(Floor.walkable(over.x, over.y), `${zone}: overflow spot ${key(over)} is blocked`);
      assert.strictEqual(key(over), key(spots[n - 1]),
        `${zone}: overflow did not fall back to the last spot`);
    }

    /* releasing frees the numbered spot for the next arrival */
    Floor.releaseSpots(room, `${zone}-k0`);
    const reuse = Floor.takeSpot(room, zone, `${zone}-newcomer`);
    assert.strictEqual(key(reuse), key(got[0]),
      `${zone}: the released spot ${key(got[0])} was not reissued (got ${key(reuse)})`);
    /* and the rest of the queue did not shuffle */
    for (let i = 1; i < n; i++)
      assert.strictEqual(Floor.takeSpot(room, zone, `${zone}-k${i}`), got[i],
        `${zone}: releasing one key moved ${zone}-k${i}`);

    assert.doesNotThrow(() => Floor.releaseSpots(room, 'was-never-here'),
      `${zone}: releasing an unknown key threw`);
  }

  assert.strictEqual(Floor.takeSpot(room, 'no-such-zone', 'k'), null,
    'takeSpot did not return null for an unknown zone');

  console.log(`PASS  E3     queue spots never double-book — meet/break/archive, ` +
    `${total} spots, reissue + overflow verified`);
}

/* ========================================================= E1/E2 ========= */
/* Rooms appear and teams grow while people are already seated. Nothing moves. */
function checkE1E2() {
  Floor.reset();
  const PROJ = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
  const origins = {};
  const seating = {};          // sid -> { aid: deskIndex }

  const remember = (r) => {
    origins[r.sid] = { gx: r.gx, gy: r.gy };
    seating[r.sid] = {};
  };
  const seat = (r, from, count) => {
    for (let i = from; i < from + count; i++) {
      const aid = `${r.sid}-a${i}`;
      const d = Floor.claimDesk(r, aid);
      if (d) seating[r.sid][aid] = r.claims[aid];
    }
  };

  /* first intake */
  for (let i = 0; i < 6; i++) {
    const r = Floor.ensureRoom(`early-${i}`, PROJ[i % 3]);
    remember(r); seat(r, 0, 9);
  }

  /* then the floor keeps filling up, interleaved with people arriving */
  for (let i = 0; i < 30; i++) {
    const r = Floor.ensureRoom(`later-${i}`, PROJ[i % PROJ.length]);
    remember(r); seat(r, 0, 4);
    /* and an existing room grows at the same time */
    const grow = Floor.state.rooms[`early-${i % 6}`];
    seat(grow, 9 + i, 2);

    for (const sid in origins) {
      const o = origins[sid], cur = Floor.state.rooms[sid];
      assert.strictEqual(cur.gx, o.gx,
        `${sid} moved horizontally (${o.gx} -> ${cur.gx}) when later-${i} was created`);
      assert.strictEqual(cur.gy, o.gy,
        `${sid} moved vertically (${o.gy} -> ${cur.gy}) when later-${i} was created`);
    }
  }

  const rs = rooms();
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++)
      assert.ok(!rectsOverlap(rs[i], rs[j]),
        `${rs[i].sid} at ${rs[i].gx},${rs[i].gy} overlaps ${rs[j].sid} at ${rs[j].gx},${rs[j].gy}`);

  /* every claim made before the growth still points at the same desk */
  let kept = 0;
  for (const sid in seating) {
    const r = Floor.state.rooms[sid];
    for (const aid in seating[sid]) {
      assert.strictEqual(r.claims[aid], seating[sid][aid],
        `${aid} was re-seated from desk ${seating[sid][aid]} to ${r.claims[aid]}`);
      assert.strictEqual(r.desks[r.claims[aid]].by, aid, `${aid}'s desk forgot them`);
      kept++;
    }
    assertClaimsConsistent(r, `E1/E2 ${sid}`);
  }

  console.log(`PASS  E1/E2  growth never disturbs the floor — ${rs.length} rooms, ` +
    `${kept} desk claims survived 30 interleaved room creations`);
}

/* =========================================================== E8 ========== */
/* Many rooms: departments wrap, rooms keep their slots, the building stays
   navigable end to end. */
function checkE8() {
  Floor.reset();
  const PROJ = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
  const made = [];
  for (const p of PROJ) for (let k = 0; k < 7; k++) made.push(Floor.ensureRoom(`${p}-s${k}`, p));
  assert.strictEqual(made.length, 42, `expected 42 rooms, built ${made.length}`);

  const rs = rooms();
  assert.strictEqual(rs.length, 42, `state holds ${rs.length} rooms, expected 42`);

  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++)
      assert.ok(!rectsOverlap(rs[i], rs[j]),
        `${rs[i].sid} at ${rs[i].gx},${rs[i].gy} overlaps ${rs[j].sid} at ${rs[j].gx},${rs[j].gy}`);

  const bandW = DEPT_COLS * SLOT_W;
  for (const r of rs) {
    const lo = r.dept.idx * DEPT_PITCH, hi = lo + bandW;
    assert.ok(r.gx >= lo && r.gx + ROOM_W <= hi,
      `${r.sid} (dept ${r.proj} #${r.dept.idx}) spans x ${r.gx}..${r.gx + ROOM_W}, ` +
      `outside its band ${lo}..${hi}`);
    assert.ok(r.gy >= CORRIDOR_H, `${r.sid} sits on top of the corridor (gy ${r.gy})`);
    assert.ok(r.gx + ROOM_W <= Floor.state.gw && r.gy + ROOM_H <= Floor.state.gh,
      `${r.sid} falls off the grid (${Floor.state.gw}x${Floor.state.gh})`);
  }

  const a = made[0], b = made[made.length - 1];
  const p = Floor.path(a.door.x, a.door.y, b.door.x, b.door.y);
  assert.ok(p, `no route from ${a.sid}'s door to ${b.sid}'s door across 42 rooms`);
  assert.strictEqual(key(p[0]), key(a.door), 'route does not start at the first door');
  assert.strictEqual(key(p[p.length - 1]), key(b.door), 'route does not end at the last door');
  for (let i = 0; i + 1 < p.length; i++) {
    const hit = legCrossesBlocked(p[i], p[i + 1]);
    assert.ok(!hit, `the cross-building route walks through blocked tile ${key(hit || {})}`);
  }

  console.log(`PASS  E8     many rooms — 42 rooms over ${PROJ.length} departments, all in band, ` +
    `${a.sid} -> ${b.sid} routes in ${p.length - 1} legs`);
}

/* ========================================================== E5b ========== */
/* Paths stay valid around the furniture added since test_floor.js was written:
   sofa, low table, printer, shelf, whiteboard and the plants. */
function checkE5b() {
  Floor.reset();
  ['alpha', 'alpha', 'beta', 'beta'].forEach((p, i) => Floor.ensureRoom(`s${i}`, p));
  const rs = rooms();

  const furniture = ['sofa', 'lowtable', 'printer', 'shelf', 'board', 'plant'];
  const kinds = new Set(rs[0].props.map(p => p.type));
  for (const f of furniture)
    assert.ok(kinds.has(f), `room has no ${f} prop — this check is not testing what it claims`);

  let paths = 0, legs = 0, tiles = 0;
  for (const r of rs) {
    for (const s of stations(r)) {
      const p = Floor.path(r.door.x, r.door.y, s.x, s.y);
      assert.ok(p, `${r.sid}: no path from the door to ${s.what} at ${s.x},${s.y}`);
      assert.strictEqual(key(p[0]), `${r.door.x},${r.door.y}`,
        `${r.sid}: path to ${s.what} does not start at the door`);
      assert.strictEqual(key(p[p.length - 1]), `${s.x},${s.y}`,
        `${r.sid}: path to ${s.what} ends at ${key(p[p.length - 1])}`);
      paths++;
      for (let i = 0; i + 1 < p.length; i++) {
        legs++;
        tiles += tilesAlong(p[i], p[i + 1]).length;
        const hit = legCrossesBlocked(p[i], p[i + 1]);
        assert.ok(!hit, `${r.sid}: door -> ${s.what}, leg ${i} ` +
          `(${key(p[i])} -> ${key(p[i + 1])}) enters blocked tile ${key(hit || {})} ` +
          `[local ${hit ? hit.x - r.gx : '?'},${hit ? hit.y - r.gy : '?'}]`);
        const cut = legCutsCorner(p[i], p[i + 1]);
        assert.ok(!cut, `${r.sid}: door -> ${s.what}, leg ${i} ` +
          `(${key(p[i])} -> ${key(p[i + 1])}) clips the blocked corner between ` +
          `${key(cut ? cut.from : {})} and ${key(cut ? cut.to : {})}`);
      }
    }
  }

  console.log(`PASS  E5b    paths clear the new furniture — ${rs.length} rooms, ${paths} paths, ` +
    `${legs} legs, ${tiles} tiles walked exactly (${furniture.join('/')})`);
}

/* -------------------------------------------------------------------------- */
function main() {
  const checks = [
    ['C2', checkC2], ['C3', checkC3], ['C3b', checkC3b], ['C7', checkC7],
    ['E3', checkE3], ['E1/E2', checkE1E2], ['E8', checkE8], ['E5b', checkE5b],
  ];
  const failed = [];
  for (const [id, fn] of checks) {
    try { fn(); }
    catch (e) { failed.push([id, e]); console.log(`FAIL  ${id.padEnd(5)}  ${e.message}`); }
  }
  if (!failed.length) return console.log('runtime ok');
  console.log(`\n${failed.length} check(s) FAILED: ${failed.map(f => f[0]).join(', ')}`);
  console.log('These are floor.js bugs, not test bugs — the checks are not to be weakened.');
  process.exit(1);
}

main();
