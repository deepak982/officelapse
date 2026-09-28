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
  return `${k}@${p.x.toFixed(3)},${p.y.toFixed(3)}:${p.state}:${p.desk === p.room.boss ? 'boss' : deskOf(p.room, p.aid)}`;
}).join('|');

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

/* ---------------------------------------------------------------- done --- */
if (FAILS.length) {
  console.log('\n%d check(s) failed: %s', FAILS.length, FAILS.join(', '));
  process.exit(1);
}
console.log('sim ok');
