#!/usr/bin/env node
/* test_sim.js — the world, without a browser.   Run:  node test_sim.js

   sim.js owns who is on the floor, which desk they took, when they clock out and
   what a scrub rebuilds. None of that was testable while it lived inside the
   renderer. floor.js's own geometry and pathfinding are covered by test_floor.js
   and test_runtime.js; nothing here repeats them.                             */
'use strict';

const assert = require('assert');
const Floor = require('./floor.js');
const Sim = require('./sim.js');
const { St } = Sim;

/* ------------------------------------------------------------- harness --- */
const FAILS = [];
function check(id, what, fn) {
  try { fn(); console.log('PASS  %s  %s', id, what); }
  catch (e) { FAILS.push(id); console.log('FAIL  %s  %s  ->  %s', id, what, e.message); }
}

let seq = 0;
function fresh() {
  Floor.reset();
  seq = 0;
  Object.assign(St, {
    sessions: {}, agentMeta: {}, events: [], people: {},
    t0: 0, t1: 1e12, clock: 0, live: false, playing: true, si: 0,
    scanFrom: 0, since: 0, q: '', ff: false, catchUp: false, focus: null, wall: 0,
    beat: -1,
  });
  Sim.hooks.say = () => {};
  Sim.hooks.reset = () => {};
}

const session = (sid, proj, title = '', branch = '') =>
  (St.sessions[sid] = { sid, proj, title, branch, cwd: '', model: '', agents: [] });

const ev = (t, sid, aid, tool = 'Read', say = 'reading retry.ts') =>
  ({ t, sid, aid, kind: 'tool', tool, say, seq: ++seq });

/* run the clock to `to` and let the sim apply whatever came due */
function runTo(to, frames = 1, dt = 1 / 60) {
  St.clock = to;
  for (let i = 0; i < frames; i++) Sim.advance(dt);
}

const deskOf = (room, aid) => room.desks.findIndex(d => d.by === aid);
const snapshot = () => Object.keys(St.people).sort().map(k => {
  const p = St.people[k];
  return `${k}@${p.x.toFixed(3)},${p.y.toFixed(3)}:${p.state}:${p.desk === p.room.boss ? 'boss' : deskOf(p.room, p.aid)}` +
         `:${p.fac ? p.fac.kind : '-'}`;
}).join('|');

/* "cafeteria:seats:2" for every shared seat this person is currently holding.
   Reads the same bookkeeping takeSpot writes, so a leak shows up here. */
function heldSeats(key) {
  const out = [];
  for (const a of Floor.state.amenities)
    for (const z in (a._held || {}))
      if (a._held[z][key] !== undefined) out.push(`${a.kind}:${z}:${a._held[z][key]}`);
  return out;
}
const atFacility = () => Object.values(St.people).filter(p => p.fac);
/* rate 60 is above FF_ABOVE, so goTo places people instead of walking them:
   the tests care where a trip ends, not about the 25 seconds in the corridor */
const placeInstantly = () => { St.si = 2; };

/* Seat everyone in the shared band, then drop to exactly FF_ABOVE. The trips need
   60x to place instead of walk, but small talk is suppressed while St.ff is on, so
   the two phases cannot run at one speed. */
function seatEveryone() {
  placeInstantly();
  runTo(150);
  runTo(100 + Sim.IDLE + 2);          // past IDLE: the break trip fires
  St.si = 1;                          // SPEEDS[1] is 10, and ff is `rate > 10`
}
function idleFloor(n = 10) {
  fresh();
  session('s1', 'alpha', 'Invoice PDF rewrite');
  St.events = Array.from({ length: n }, (_, i) => ev(100, 's1', 'a' + i));
  seatEveryone();
}
/* every ambient line said over a window, as strings, so two replays can be compared */
function chatOver(from, to) {
  const out = [];
  Sim.hooks.say = (p, text, kind, simNow) => {
    if (kind === 'chat') out.push(Math.round(simNow) + ' ' + p.key + ' ' + text);
  };
  for (let t = from; t <= to; t += 2) runTo(t);
  Sim.hooks.say = () => {};
  return out;
}
const faceAt = (p, q) => {
  const dx = q.x - p.x, dy = q.y - p.y;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? Floor.E : Floor.W) : (dy > 0 ? Floor.S : Floor.N);
};

/* --------------------------------------------------------------- tests --- */

check('S1', 'an event seats a person, keyed session|agent', () => {
  fresh();
  session('s1', 'alpha', 'Checkout retry bug');
  St.events = [ev(100, 's1', null), ev(101, 's1', 'a1')];
  runTo(150);

  const boss = St.people['s1|'], mate = St.people['s1|a1'];
  assert(boss && mate, 'expected both a boss and a teammate: ' + Object.keys(St.people));
  assert.strictEqual(boss.boss, true);
  assert.strictEqual(mate.boss, false);
  assert.strictEqual(boss.room, mate.room, 'same session must share a room');
  assert.strictEqual(boss.desk, boss.room.boss, 'boss did not take the head desk');
  assert(deskOf(mate.room, 'a1') >= 0, 'teammate never claimed a desk');
  assert.strictEqual(boss.room.proj, 'alpha');
});

check('S2', 'one agent id in two sessions stays two people', () => {
  fresh();
  session('s1', 'alpha');
  session('s2', 'beta');
  St.events = [ev(100, 's1', 'a1'), ev(101, 's2', 'a1')];
  runTo(150);

  const one = St.people['s1|a1'], two = St.people['s2|a1'];
  assert(one && two, 'agent id collapsed across sessions: ' + Object.keys(St.people));
  assert.notStrictEqual(one.room, two.room, 'two sessions shared one room');
  assert.notStrictEqual(one.desk, two.desk, 'two sessions shared one desk');
});

check('S3', 'going quiet past GONE clocks out and frees the desk', () => {
  fresh();
  session('s1', 'alpha');
  St.events = [ev(100, 's1', 'a1')];
  St.ff = true;                    // skip the walk to the door; we want the ending
  runTo(150);
  const room = St.people['s1|a1'].room;
  assert(deskOf(room, 'a1') >= 0, 'never sat down in the first place');

  runTo(150 + Sim.GONE + 1);
  assert(!St.people['s1|a1'], 'still on the floor long after going quiet');
  assert.strictEqual(deskOf(room, 'a1'), -1, 'desk never came back');
  assert(room.desks.some(d => d.by === null), 'no desk was released');
});

check('S4', 'a rebuild puts the same teammate back at the same desk', () => {
  fresh();
  session('s1', 'alpha');
  St.events = [ev(100, 's1', 'a1'), ev(101, 's1', 'a2'), ev(102, 's1', 'a3')];
  runTo(150);
  const room = St.people['s1|a1'].room;
  const before = ['a1', 'a2', 'a3'].map(a => deskOf(room, a));
  assert(before.every(i => i >= 0), 'not everyone got a desk: ' + before);

  Sim.rebuild(150);
  runTo(150);
  const after = ['a1', 'a2', 'a3'].map(a => deskOf(room, a));
  assert.deepStrictEqual(after, before, `desks moved across a rebuild: ${before} -> ${after}`);
});

check('S5', 'a rebuild clears the room activity stamp', () => {
  fresh();
  session('s1', 'alpha');
  St.events = [ev(100, 's1', 'a1')];
  runTo(150);
  const room = St.people['s1|a1'].room;
  assert.strictEqual(room.lastT, 100, 'lastT never recorded');

  Sim.rebuild(50);
  assert.strictEqual(room.lastT, undefined,
    'lastT survived the rewind — the room reports activity in the future');
});

check('S6', 'two rebuilds to the same clock give the same floor', () => {
  fresh();
  session('s1', 'alpha', 'Invoice PDF rewrite');
  session('s2', 'beta', 'Search relevance');
  St.events = [
    ev(100, 's1', null), ev(101, 's1', 'a1', 'Grep', 'grepping margin'),
    ev(103, 's2', 'b1'), ev(105, 's1', 'a2', 'WebFetch', 'looking it up online'),
    ev(107, 's2', null), ev(109, 's1', 'a1', 'Bash', 'running pytest'),
  ];
  // Note the comparison is rebuild against rebuild, not live against rebuild:
  // a rebuild sets catchUp, which places people instead of walking them, so the
  // two modes legitimately differ mid-walk. Scrubbing to the same point twice is
  // the property that has to hold.
  runTo(150, 4);
  Sim.rebuild(150); runTo(150, 4);
  const first = snapshot();
  assert(first.length, 'nobody on the floor to compare');
  assert(!/:walk:/.test(first), 'a drained backlog left someone mid-walk: ' + first);

  Sim.rebuild(150); runTo(150, 4);
  assert.strictEqual(snapshot(), first, 'replay is not deterministic');

  Sim.rebuild(150); runTo(150, 4);
  assert.strictEqual(snapshot(), first, 'replay drifted by the third pass');
});

check('S7', 'the sim speaks only through its hooks', () => {
  fresh();
  session('s1', 'alpha');
  const said = [];
  let resets = 0;
  Sim.hooks.say = (p, text, isTask, simNow) => said.push([p.key, text, isTask, simNow]);
  Sim.hooks.reset = () => resets++;

  St.events = [ev(100, 's1', 'a1', 'Bash', 'running pytest'),
               { t: 101, sid: 's1', aid: null, kind: 'prompt', tool: '', say: 'fix the retry', seq: ++seq }];
  runTo(150);

  assert.strictEqual(said.length, 2, 'wrong number of lines spoken: ' + said.length);
  assert.deepStrictEqual(said[0], ['s1|a1', 'running pytest', false, 100]);
  assert.strictEqual(said[1][2], true, 'a prompt should be flagged as one');
  assert(said[1][1].includes('fix the retry'), 'prompt text lost: ' + said[1][1]);

  Sim.rebuild(150);
  assert.strictEqual(resets, 1, 'rebuild did not tell the view to clear');
});

check('S8', 'search matches a title, a branch and a teammate brief', () => {
  fresh();
  session('s1', 'alpha', 'Invoice PDF rewrite', 'feat/pdf-margins');
  St.agentMeta['s1/a1'] = { aid: 'a1', key: 's1/a1', sid: 's1', name: 'Trace the margin regression', model: '' };
  St.events = [ev(100, 's1', null), ev(101, 's1', 'a1')];
  runTo(150);
  const room = St.people['s1|'].room;

  St.q = '';               assert(Sim.roomHit(room), 'empty search should match everything');
  St.q = 'invoice';        assert(Sim.roomHit(room), 'title did not match');
  St.q = 'pdf-margins';    assert(Sim.roomHit(room), 'branch did not match');
  St.q = 'regression';     assert(Sim.roomHit(room), 'teammate brief did not match');
  St.q = 'alpha';          assert(Sim.roomHit(room), 'project did not match');
  St.q = 'nothingdoing';   assert(!Sim.roomHit(room), 'matched something it should not have');
  St.q = '';
});

check('S9', 'late metadata renames someone already on the floor', () => {
  fresh();
  session('s1', 'alpha');
  St.events = [ev(100, 's1', 'a1')];
  runTo(150);
  const p = St.people['s1|a1'];
  const wasDisplay = p.display;

  // the brief lands on a later row, long after the first tool call drew them
  St.agentMeta['s1/a1'] = { aid: 'a1', key: 's1/a1', sid: 's1',
                            name: 'Port the header block', model: 'claude-opus-5' };
  Sim.relabel();
  assert.strictEqual(p.name, 'Port the header block', 'name never updated');
  assert.notStrictEqual(p.display, wasDisplay, 'display name was not recomputed');
  assert.strictEqual(p.model, 'opus', 'model never updated: ' + p.model);
});

check('S10', 'a break walks people to the shared band, one seat each, given back after', () => {
  fresh();
  placeInstantly();
  session('s1', 'alpha', 'Invoice PDF rewrite');
  // twelve keys, because two thirds of any set walk out: a smaller sample can
  // legitimately contain nobody who stays behind
  const ids = Array.from({ length: 12 }, (_, i) => 'a' + i);
  St.events = ids.map(a => ev(100, 's1', a));
  runTo(150);
  assert(atFacility().length === 0, 'someone was in a facility before ever going idle');

  runTo(100 + Sim.IDLE + 2);                 // past IDLE: the break trip fires
  const out = atFacility();
  assert(out.length, 'nobody left their room on a break — the floor is still a set of cells');
  assert(out.length < ids.length, 'everybody left: the in-room cooler is never used');

  const tiles = new Set();
  for (const p of out) {
    const i = p.fac.seats.findIndex(s => s.x === p.dest.x && s.y === p.dest.y);
    assert.deepStrictEqual(heldSeats(p.key), [`${p.fac.kind}:seats:${i}`],
      `${p.key} should hold exactly one seat, the one it walked to: ${heldSeats(p.key)}`);
    assert.strictEqual(p.state, 'think', `${p.key} is ${p.state} at the ${p.fac.kind}`);
    tiles.add(p.dest.x + ',' + p.dest.y);
  }
  assert.strictEqual(tiles.size, out.length, 'two people were handed the same tile');
  // and the ones who stayed behind hold a room spot, not a facility one
  for (const p of Object.values(St.people)) if (!p.fac)
    assert.deepStrictEqual(heldSeats(p.key), [], p.key + ' holds a facility seat without a facility');

  runTo(100 + Sim.IDLE + Sim.BREAK_OVER + 20);          // break over, back to work
  for (const k of ids.map(a => 's1|' + a))
    assert.deepStrictEqual(heldSeats(k), [], k + ' walked off still holding a seat');
  assert.strictEqual(atFacility().length, 0, 'p.fac survived the walk back to the desk');
});

check('S11', 'a long quiet spell adds one washroom run, for some people, only once', () => {
  fresh();
  placeInstantly();
  session('s1', 'alpha');
  // 12 keys: enough that at least one hashes to a facility for both trip kinds
  const ids = Array.from({ length: 12 }, (_, i) => 'a' + i);
  St.events = ids.map(a => ev(100, 's1', a));
  runTo(150);

  const seen = {};
  for (let t = 151; t < 100 + Sim.GONE; t += 5) {
    runTo(t);
    for (const p of atFacility()) (seen[p.key] = seen[p.key] || []).push(p.fac.kind);
  }
  const kinds = k => [...new Set(seen[k] || [])];
  const wc = ids.map(a => 's1|' + a).filter(k => kinds(k).includes('washrooms'));
  assert(wc.length, 'no washroom run over 900 quiet seconds: ' + JSON.stringify(Object.keys(seen)));
  // AWAY.washroom used to be a one-entry list, so `% 1` was always 0 and the whole
  // floor filed into the toilets together the moment it crossed LONG_IDLE.
  assert(wc.length < ids.length,
    `every single person took the washroom run (${wc.length} of ${ids.length})`);
  for (const k of wc) {
    // once, not on a loop: two visits would show as two runs of samples
    const runs = (seen[k] || []).join(',').split(/,?(?:cafeteria|lounge|wellness),?/)
      .filter(s => s.includes('washrooms')).length;
    assert.strictEqual(runs, 1, `${k} kept going back to the washrooms (${runs} runs)`);
  }
});

check('S12', 'the facility choice is identical across two rebuilds to one clock', () => {
  fresh();
  placeInstantly();
  session('s1', 'alpha', 'Invoice PDF rewrite');
  session('s2', 'beta', 'Search relevance');
  St.events = [
    ev(100, 's1', null), ev(101, 's1', 'a1', 'WebFetch', 'looking it up online'),
    ev(101, 's2', 'b1', 'WebSearch', 'looking it up online'),
    ev(102, 's1', 'a2', 'WebFetch', 'looking it up online'),
    ev(103, 's1', 'a3', 'WebSearch', 'looking it up online'),
    ev(104, 's2', 'b2', 'WebFetch', 'looking it up online'),
  ];
  Sim.rebuild(150); runTo(150, 4);
  const first = snapshot();
  assert(/:(cafeteria|lounge|wellness|washrooms)/.test(first),
    'no WebFetch reached a shared facility, so this pins nothing: ' + first);
  const held = Object.keys(St.people).sort().map(k => k + '=' + heldSeats(k)).join('|');

  Sim.rebuild(150); runTo(150, 4);
  assert.strictEqual(snapshot(), first, 'the facility a person uses changed on replay');
  assert.strictEqual(Object.keys(St.people).sort().map(k => k + '=' + heldSeats(k)).join('|'), held,
    'the seat within the facility changed on replay');

  Sim.rebuild(150); runTo(150, 4);
  assert.strictEqual(snapshot(), first, 'the floor drifted by the third pass');
});

check('S13', 'clocking out gives a facility seat back', () => {
  fresh();
  placeInstantly();
  session('s1', 'alpha');
  // hunt for one key that routes a lookup out of the room, then clock it out
  let key = null;
  for (let i = 0; i < 40 && !key; i++) {
    fresh(); placeInstantly(); session('s1', 'alpha');
    St.events = [ev(100, 's1', 'a' + i, 'WebFetch', 'looking it up online')];
    runTo(150);
    if (St.people['s1|a' + i].fac) key = 's1|a' + i;
  }
  assert(key, 'no key in 40 routes a lookup to a facility — the hash is broken');
  const p = St.people[key], fac = p.fac;
  assert.strictEqual(heldSeats(key).length, 1, 'never claimed the seat: ' + heldSeats(key));

  runTo(100 + Sim.GONE + 2, 40);
  assert(!St.people[key], key + ' is still on the floor long past GONE');
  assert.deepStrictEqual(heldSeats(key), [], 'seat leaked on clock-out — EDGE_CASES C3');
  assert(!Object.values(fac._held.seats || {}).length ||
         !Object.keys(fac._held.seats).includes(key), 'the facility still lists them');

  // and a rebuild must clear them too, not just a clean exit
  fresh(); placeInstantly(); session('s1', 'alpha');
  St.events = [ev(100, 's1', 'a1'), ev(100, 's1', 'a2'), ev(100, 's1', 'a3')];
  runTo(100 + Sim.IDLE + 2);
  const away = atFacility().map(q => q.key);
  assert(away.length, 'nobody went out, so the rebuild path is untested');
  Sim.rebuild(150);
  for (const k of away) assert.deepStrictEqual(heldSeats(k), [], k + ' leaked a seat across a rebuild');
});

check('S14', 'the gesture follows the tool and clears when it stops applying', () => {
  fresh();
  placeInstantly();          // a break must actually start, not be one frame of a walk
  session('s1', 'alpha');
  const want = {
    Read: 'point', Edit: 'typefast', Write: 'typefast', Bash: 'headscratch',
    Task: 'handoff', Agent: 'handoff', SendMessage: 'handoff',
    WebFetch: 'lookup', WebSearch: 'lookup',
    Grep: '', Glob: '', TodoWrite: '', '': '',
  };
  let t = 100;
  for (const tool in want) {
    St.events.push(ev(t, 's1', 'a1', tool, 'doing ' + tool));
    runTo(t += 2);
    assert.strictEqual(St.people['s1|a1'].gesture, want[tool],
      `${tool || '(none)'} -> ${St.people['s1|a1'].gesture}, expected ${want[tool] || '(empty)'}`);
  }

  // a break is not a tool call: the last gesture must not still be playing
  St.events.push(ev(t, 's1', 'a2', 'Bash', 'running pytest'));
  runTo(t + 1);
  assert.strictEqual(St.people['s1|a2'].gesture, 'headscratch');
  runTo(t + Sim.IDLE + 2);
  assert.strictEqual(St.people['s1|a2'].gesture, '', 'gesture survived into a break');

  // nor on the way out of the building
  runTo(t + Sim.GONE + 2);
  const gone = St.people['s1|a2'];
  assert(!gone || gone.gesture === '', 'someone is leaving mid-gesture');
});

check('S15', 'an event ahead of its session metadata never opens a "?" department', () => {
  fresh();
  // no session() call: the tool call arrives first, exactly as it can off the wire
  St.events = [ev(100, 's1', 'a1')];
  runTo(150);
  assert.strictEqual(Floor.state.depts['?'], undefined,
    'built a department literally called "?" — that room is a DEPT_PITCH from its team');
  assert.deepStrictEqual(Object.keys(Floor.state.rooms), [], 'placed a room with no project name');
  assert(!St.people['s1|a1'], 'seated someone whose team is not known yet');

  // the name lands a poll later: now they appear, in the right department
  session('s1', 'alpha', 'Checkout retry bug');
  runTo(151);
  const p = St.people['s1|a1'];
  assert(p, 'never appeared once the session name arrived');
  assert.strictEqual(p.room.proj, 'alpha');
  assert.strictEqual(p.room.dept, Floor.state.depts.alpha, 'room filed under the wrong department');
  assert.strictEqual(Floor.state.depts['?'], undefined, '"?" department appeared anyway');

  // an empty project name is the same hole — a session whose cwd has not been read
  fresh();
  session('s2', '');
  St.events = [ev(100, 's2', 'b1')];
  runTo(150);
  assert.deepStrictEqual(Object.keys(Floor.state.rooms), [], 'an empty proj still placed a room');

  // and a held event must not wedge the queue for ever
  fresh();
  St.events = [ev(100, 's3', 'c1')];
  runTo(100 + Sim.IDLE + 2);
  assert.strictEqual(St.scanFrom, St.events.length,
    'an event whose session never arrived is still pinning the scan head');
});

check('S16', 'overflow works from the shared hot desks, and hands them back', () => {
  // the band is only built when the first room opens, so look it up after the run
  const hotDesks = () => (Floor.state.amenities.find(a => a.kind === 'coworking') || {}).desks || [];
  const seatedAt = key => hotDesks().findIndex(d => d.by === key);
  const ids = Array.from({ length: 45 }, (_, i) => 'a' + i);   // 24 room desks + 16 hot desks + 5
  const seat45 = () => {
    fresh();
    placeInstantly();
    session('s1', 'alpha');
    St.events = ids.map(a => ev(100, 's1', a));
    runTo(150);
    return ids.map(a => St.people['s1|' + a]);
  };

  let ppl = seat45();
  const cw = hotDesks();
  assert(cw.length, 'floor.js has no coworking desks to overflow into');
  const out = ppl.filter(p => p.cowork);
  assert.strictEqual(out.length, cw.length,
    `expected every hot desk taken, got ${out.length} of ${cw.length}`);

  const taken = new Set();
  for (const p of out) {
    const i = seatedAt(p.key);
    assert(i >= 0, p.key + ' has p.cowork but no desk booked in their name');
    assert.strictEqual(p.desk, cw[i], p.key + ' is not standing at the desk they booked');
    assert.notStrictEqual(p.desk.hot, true, 'took room standing room while a hot desk was free');
    taken.add(i);
  }
  assert.strictEqual(taken.size, out.length, 'two people booked one hot desk');

  // past 24 + 16 the old fallback still catches the rest
  const spare = ppl.filter(p => !p.cowork && p.desk.hot);
  assert.strictEqual(spare.length, ids.length - 24 - cw.length,
    'the hotDesk() fallback stopped catching overflow: ' + spare.length);

  // clock-out gives the hot desk back
  const key = out[0].key, where = seatedAt(key);
  runTo(100 + Sim.GONE + 2, 40);
  assert(!St.people[key], key + ' never clocked out');
  assert.strictEqual(hotDesks()[where].by, null, 'hot desk leaked on clock-out — EDGE_CASES C3');

  // so does a rebuild, and the replay books the same desks again
  ppl = seat45();
  const before = Object.keys(St.people).sort().map(k => k + '=' + seatedAt(k)).join('|');
  assert(/=1[0-5]\b/.test(before), 'nobody reached the hot desks on the second pass: ' + before);
  Sim.rebuild(150);
  assert(hotDesks().every(d => d.by === null), 'a rebuild left hot desks booked to nobody');
  runTo(150);
  assert.strictEqual(Object.keys(St.people).sort().map(k => k + '=' + seatedAt(k)).join('|'), before,
    'hot desks moved across a rebuild');
});

check('S17', 'a backlog that replays past LONG_IDLE still takes the normal break first', () => {
  // The reload case: the events land at t=100 and the very first step() that sees
  // anyone is already 350 quiet seconds later, which is what draining a backlog
  // under catchUp looks like. Keyed off age alone, every one of them went straight
  // to the washrooms and the cafeteria was never used on a live page at all.
  fresh();
  placeInstantly();
  session('s1', 'alpha', 'Invoice PDF rewrite');
  const ids = Array.from({ length: 14 }, (_, i) => 'a' + i);
  St.events = ids.map(a => ev(100, 's1', a));
  runTo(100 + Sim.LONG_IDLE + 50);

  const kinds = atFacility().map(p => p.fac.kind);
  assert(kinds.length, 'nobody took any break at all: ' + JSON.stringify(
    Object.values(St.people).map(p => p.state)));
  assert(!kinds.includes('washrooms'),
    'went straight to the washrooms without ever taking a normal break: ' + kinds.join(','));
  assert(kinds.some(k => k === 'cafeteria' || k === 'lounge'),
    'no break facility reached on the replay path: ' + kinds.join(','));

  // one trip, then back to the desk and settled. Someone whose quiet spell was
  // already this old gets the break and nothing else: the second trip is gated on
  // the break having happened EARLY in the spell, so it cannot loop. A washroom run
  // on the live path — a spell that crosses IDLE and then LONG_IDLE while the page
  // is watching — is S11's job.
  for (let t = 100 + Sim.LONG_IDLE + 55; t < 100 + Sim.GONE; t += 5) {
    runTo(t);
    for (const q of atFacility())
      assert.notStrictEqual(q.fac.kind, 'washrooms',
        `t=${t}: ${q.key} went on to the washrooms after a replayed break`);
  }
  for (const q of Object.values(St.people))
    assert.strictEqual(q.state, 'type', q.key + ' never settled back at their desk');
});

check('S18', 'no facility ever holds more people than it has seats', () => {
  // takeSpot's overflow shares the LAST spot, so an unchecked trip stacked ten
  // people on one washroom tile — the heap the bug report called "stuck".
  fresh();
  placeInstantly();
  session('s1', 'alpha', 'Invoice PDF rewrite');
  const ids = Array.from({ length: 14 }, (_, i) => 'a' + i);
  St.events = [ev(100, 's1', null), ...ids.map(a => ev(100, 's1', a))];
  runTo(150);

  let peak = 0;
  for (let t = 151; t < 100 + Sim.GONE; t += 5) {
    runTo(t);
    const here = new Map();
    for (const q of atFacility()) here.set(q.fac, (here.get(q.fac) || []).concat(q));
    for (const [a, ppl] of here) {
      assert(ppl.length <= a.seats.length,
        `t=${t}: ${ppl.length} people in the ${a.label} for ${a.seats.length} seats`);
      const tiles = new Set(ppl.map(q => q.dest.x + ',' + q.dest.y));
      assert.strictEqual(tiles.size, ppl.length,
        `t=${t}: ${ppl.length} people in the ${a.label} on ${tiles.size} tiles`);
      if (a.kind === 'washrooms') peak = Math.max(peak, ppl.length);
    }
  }
  // the guard has to have actually bitten, or this pins nothing: more people hash
  // to the washrooms than it has seats, so it must fill exactly and refuse the rest
  const wash = Floor.state.amenities.find(a => a.kind === 'washrooms');
  assert.strictEqual(peak, wash.seats.length,
    `the washrooms never filled (peak ${peak} of ${wash.seats.length}), so the cap is untested`);
});

check('S19', 'a brief that names its worker renders as that name', () => {
  /* Briefs overwhelmingly open "You are Priya, Senior Backend Engineer, ...". The
     name is the useful half — without this the plate reads "You are Priya…" and
     every sibling agent looks alike at a glance. */
  for (const [brief, want] of [
    ['You are Anjali, Lighting & Art Direction Engineer on the 3D build.', 'Anjali'],
    ['You are Priya, Senior Backend Engineer, reviewing server.py', 'Priya'],
    ["You're Dev, Performance Engineer. You own office.js.", 'Dev'],
    ['Nikhil, role: tester, files under src/', 'Nikhil'],
    ['Farah, a QA engineer working on edge cases', 'Farah'],
    ['Vikram, 2D Renderer Engineer', 'Vikram'],
  ]) assert.strictEqual(Sim.taskLabel(brief), want, 'brief: ' + brief);

  /* and the other way: a task that merely opens with a capitalised word and a comma
     must NOT be read as a person. Inventing a teammate called Trace is worse than
     failing to shorten a real name. */
  for (const brief of [
    'Trace, the margin regression in the PDF renderer',
    'Review the changed files for correctness bugs',
    'Fix the washroom pile-up in sim.js',
  ]) {
    const got = Sim.taskLabel(brief);
    assert(/[ \u2026]/.test(got), `"${brief}" collapsed to a bare name: ${JSON.stringify(got)}`);
  }
});

check('S20', 'people walk at a walking speed, and the boss walks slower than anyone', () => {
  /* p.speed IS the 3D walk's playback rate in disguise (ground / 0.975), so the range
     has to be a human one; ~1.6x is where a walk cycle stops reading as a walk. */
  // the stride from the measured manifest, not a literal: if the clip is re-authored
  // this moves with it (characters.js's walkRef is pinned to the same number)
  const REF = require('./assets/manifest.json').clips.walk.rootMotion.unitsPerSecond;
  const MAXRATE = 1.6;
  fresh();
  placeInstantly();
  session('s1', 'alpha', 'Invoice PDF rewrite');
  session('s2', 'beta', 'Ledger import');
  const ids = Array.from({ length: 14 }, (_, i) => 'a' + i);
  St.events = ['s1', 's2'].flatMap(s => [ev(100, s, null), ...ids.map(a => ev(100, s, a))]);
  runTo(150);
  const ppl = Object.values(St.people);
  assert.strictEqual(ppl.length, 30, 'the fixture lost people');

  let boss = null, slowestMate = Infinity;
  const rates = new Set();
  for (const p of ppl) {
    const rate = p.speed / REF;
    assert(rate > 0.8 && rate < MAXRATE,
      `${p.key} walks at ${p.speed.toFixed(2)} tiles/s, i.e. the clip at ` +
      `${rate.toFixed(2)}x — outside 0.8-${MAXRATE}x, which is not a walk any more`);
    rates.add(rate.toFixed(2));
    if (p.boss) boss = p; else slowestMate = Math.min(slowestMate, p.speed);
  }
  assert(boss, 'no boss in the fixture');
  assert(boss.speed < slowestMate,
    `the boss walks at ${boss.speed.toFixed(2)} and the slowest teammate at ` +
    `${slowestMate.toFixed(2)} — a boss has to be the most deliberate thing on the floor`);
  // and the spread has to be real, or every gait is the same gait
  assert(rates.size >= 8, `only ${rates.size} distinct cadences across 30 people`);

  // p.phase is tied to ground speed now; a fixed rate would undo it silently
  const fast = ppl.filter(p => !p.boss).sort((a, b) => b.speed - a.speed)[0];
  for (const p of [boss, fast]) { p.state = 'walk'; p.phase = 0; p.path = null; }
  Sim.step(1);
  assert(fast.phase > boss.phase * 1.15,
    `phase advanced ${fast.phase.toFixed(2)} for the fastest walker and ` +
    `${boss.phase.toFixed(2)} for the boss — p.phase is back on a fixed rate`);
});

check('S21', 'idle people pair off close together and turn to face each other', () => {
  idleFloor(10);
  St.beat = -1; runTo(195);                    // one beat pass, so the facing is applied

  const pairs = Sim.chatPairs().filter(([, b]) => b);
  assert(pairs.length >= 2, 'nobody paired up: ' + pairs.length + ' pairs on a full break');
  for (const [a, b] of pairs) {
    assert.strictEqual(a.state, 'think', a.key + ' is ' + a.state + ', not on a break');
    assert.strictEqual(b.state, 'think', b.key + ' is ' + b.state + ', not on a break');
    assert.strictEqual(a.fac || a.room, b.fac || b.room,
      a.key + ' and ' + b.key + ' are talking across two different venues');
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    assert(d <= Sim.NEAR, a.key + ' and ' + b.key + ' are ' + d.toFixed(2) + ' tiles apart');
    assert.strictEqual(a.face, faceAt(a, b), a.key + ' is not looking at ' + b.key);
    assert.strictEqual(b.face, faceAt(b, a), b.key + ' is not looking at ' + a.key);
    assert.notStrictEqual(a.face, b.face, a.key + ' and ' + b.key + ' face the same way');
  }
  // the whole point of the change: not one row of people all staring north
  const facing = Object.values(St.people).filter(p => p.state === 'think' && p.face !== Floor.N);
  assert(facing.length >= 4, 'only ' + facing.length + ' idle people turned away from north');
});

check('S22', 'a conversation replays word for word after a rebuild', () => {
  idleFloor(10);
  const first = chatOver(193, 232);
  assert(first.length > 6, 'barely anyone spoke over a 40s break: ' + JSON.stringify(first));
  // and it is a conversation, not a chorus: somebody replied on a later beat
  const byKey = {};
  for (const line of first) { const k = line.split(' ')[1]; byKey[k] = (byKey[k] || 0) + 1; }
  assert(Object.values(byKey).some(n => n >= 2), 'nobody said more than one line: ' + JSON.stringify(byKey));

  Sim.rebuild(150); seatEveryone();
  assert.deepStrictEqual(chatOver(193, 232), first, 'the conversation changed on replay');
  Sim.rebuild(150); seatEveryone();
  assert.deepStrictEqual(chatOver(193, 232), first, 'the conversation drifted by the third pass');
});

check('S23', 'invented chatter is flagged and never reaches the room log', () => {
  const Chat = require('./chat.js');
  const p = { key: 's1|a1', boss: false, aid: 'a1', display: 'Priya', name: 'n',
              hue: 200, room: { sid: 'log-test' } };
  Chat.say(p, 'running pytest', false, 0, 100, false);
  Chat.say(p, 'the printer is out of paper', 'chat', 0, 101, false);
  Chat.say(p, '“fix the retry”', true, 0, 102, false);
  assert.deepStrictEqual(Chat.logFor('log-test').msgs.map(m => m.text),
    ['running pytest', '“fix the retry”'],
    'an invented line got into the session record');

  // and the sim only ever hands the view scripted lines under that flag
  const SCRIPTED = new Set([].concat(...Sim.TALK).concat(Sim.SOLO));
  idleFloor(10);
  const said = [];
  Sim.hooks.say = (q, text, kind) => said.push([kind, text]);
  for (let t = 193; t <= 232; t += 2) runTo(t);
  Sim.hooks.say = () => {};
  const chat = said.filter(([k]) => k === 'chat');
  assert(chat.length, 'no ambient lines to check');
  for (const [, text] of chat) assert(SCRIPTED.has(text), 'unscripted ambient line: ' + text);
  for (const [k, text] of said)
    assert(k === 'chat' || typeof k === 'boolean', 'real line ' + text + ' flagged ' + k);
});

check('S24', 'nobody chats while walking, above 10x, or once they have clocked out', () => {
  idleFloor(10);
  const bad = [];
  Sim.hooks.say = (p, text, kind) => {
    if (kind !== 'chat') return;
    if (!St.people[p.key] || p.state !== 'think') bad.push(p.key + ' spoke while ' + p.state);
  };
  for (let t = 193; t <= 232; t += 2) runTo(t);
  Sim.hooks.say = () => {};
  assert.deepStrictEqual(bad, [], bad.join('; '));

  // the break ends BREAK_OVER after it started and everyone walks back. A 1/60 frame
  // at 10x covers 0.02 tiles, so they are still in the corridor for the whole window:
  // genuinely walking, which is the case that has to stay silent.
  const onFoot = chatOver(240, 300);
  const walking = Object.values(St.people).filter(p => p.state === 'walk').length;
  assert(walking >= 5, 'only ' + walking + ' people are walking back, so this pins nothing');
  assert.deepStrictEqual(onFoot, [], 'people talked on the way back to their desks');

  idleFloor(10);
  placeInstantly();                                  // 60x: St.ff, so bubbles are off too
  assert.deepStrictEqual(chatOver(193, 232), [], 'chatter fired above 10x replay');

  idleFloor(10);
  placeInstantly();
  runTo(100 + Sim.GONE + 2, 40);
  assert.strictEqual(Object.keys(St.people).length, 0, 'nobody clocked out');
  St.si = 1;
  assert.deepStrictEqual(chatOver(100 + Sim.GONE + 4, 100 + Sim.GONE + 40), [],
    'an empty floor still had a conversation');
});

/* ---------------------------------------------------------------- done --- */
if (FAILS.length) {
  console.log('\n%d check(s) failed: %s', FAILS.length, FAILS.join(', '));
  process.exit(1);
}
console.log('sim ok');
