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

/* ---------------------------------------------------------------- done --- */
if (FAILS.length) {
  console.log('\n%d check(s) failed: %s', FAILS.length, FAILS.join(', '));
  process.exit(1);
}
console.log('sim ok');
