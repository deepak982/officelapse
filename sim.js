/* sim.js — the world: who is on the floor, where they are going, and when.

   Nothing in here touches the DOM or a canvas, so it runs under node and can be
   tested without a browser. It talks to the outside through two hooks (`hooks.say`
   for speech, `hooks.reset` when a rebuild wipes the floor), which default to
   no-ops. Geometry and routing are floor.js; drawing is office.js.

   The clock is the only thing that drives it: advance(dt) moves it, applies every
   event that has come due, and steps everyone. Feed it the same events and the
   same clock and you get the same floor. */
(function (root) {
'use strict';

const F = root.Floor || (typeof require === 'function' ? require('./floor.js') : null);
if (!F) throw new Error('sim.js needs floor.js loaded first');
const { N, E, S, W } = F;

const IDLE = 90, GONE = 900;              // simulation seconds
const LONG_IDLE = 300;                    // quiet this long and the break becomes a washroom run
const BREAK_OVER = 45;                    // sim seconds at the cooler before going back
const TRIP_GAP = 40;                      // sim seconds between trips away from the desk
const SPEEDS = [1, 10, 60, 300, 1800];
const FF_ABOVE = 10;                      // above this, stop animating walks (see step)
const EVENT_BUDGET = 2000;                // events applied per frame, so 1800x can't stall

const hash = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

/* the view supplies these; a headless sim happily says nothing to nobody */
const hooks = { say: () => {}, reset: () => {} };

/* a hash is not a name: trim a title or a task brief to something a human reads */
function shortLabel(s, n = 20) {
  s = String(s || '').replace(/[`"'“”*_]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length <= n) return s;
  const cut = s.slice(0, n), sp = cut.lastIndexOf(' ');
  return (sp > 9 ? cut.slice(0, sp) : cut).replace(/[ ,.:;-]+$/, '') + '…';
}
/* briefs arrive as markdown; clean them at the door so no consumer has to */
const clean = t => String(t || '').replace(/[*_`]|[“”]/g, '').replace(/\s+/g, ' ').trim();

const roomName = r => {
  const s = St.sessions[r.sid] || {};
  return shortLabel(s.title, 26) || (s.branch ? '⎇ ' + shortLabel(s.branch, 20) : '') || r.proj;
};
function taskLabel(str, n = 22) {
  let t = String(str || '').replace(/[`"'“”*_]/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  // "You are Priya, Senior Backend Engineer" is how a brief usually opens, and the
  // name is the useful half — strip the preamble before looking for it
  // note the apostrophe is already stripped above, so "You're" arrives as "Youre"
  t = t.replace(/^(?:you(?:'?re| are)|your name is)\s+/i, '');
  /* A brief that names its worker: "Nikhil, role: tester", "Farah, a QA engineer",
     "Anjali, Lighting & Art Direction Engineer". What follows the comma has to be
     "role", "a"/"an", or a capitalised word — deliberately NOT "the", because
     "Trace, the margin regression" is a task and would read as a person called
     Trace. Failing to shorten a name is a truncated label; the other way round
     invents a teammate who does not exist. */
  const named = t.match(/^([A-Z][a-z]{2,15})\s*,\s*(?:(?:role|an?)\b|(?=[A-Z0-9]))/);
  if (named) return named[1];
  const words = t.split(' ');
  // an identifier beats a bare acronym: "MR" matches earlier than "!2798" but
  // says nothing, and every sibling agent shares it
  const idish = w => /[!#]\d{2,}/.test(w) || /^\d{3,}$/.test(w) ||
                     /\.(ts|tsx|js|jsx|py|md|json|html|css|vue)$/.test(w);
  let i = words.findIndex((w, k) => k > 0 && idish(w));
  if (i < 0) i = words.findIndex((w, k) => k > 0 && /^[A-Z]{2,}$/.test(w));
  if (i > 0) {
    const key = words[i].includes('/') ? words[i].split('/').pop() : words[i];
    const ctx = words[i - 1];
    return shortLabel(/^(MR|PR|issue|ticket)$/i.test(ctx) ? `${words[0]} ${ctx} ${key}`
                                                          : `${words[0]} ${key}`, n);
  }
  return shortLabel(t, n);
}
const personName = p => p.boss
  ? (shortLabel((St.sessions[p.sid] || {}).title, 18) || 'boss')
  : (taskLabel(p.name, 20) || p.aid.slice(1, 7));

/* a fixed department palette beats a raw hue hash (two projects could collide) */
const DEPT_HUES = [199, 152, 41, 280, 12, 326, 96, 255];
const deptHue = proj => DEPT_HUES[hash(proj) % DEPT_HUES.length];

const St = {
  sessions: {}, agentMeta: {}, events: [], people: {},
  t0: 0, t1: 0, clock: 0, live: true, playing: true, si: 2, scanFrom: 0, since: 0,
  cam: { x: 0, y: 0, z: .5, tx: 0, ty: 0, tz: .5 },
  focus: null, q: '', dpr: 1, userMoved: false, ff: false, wall: 0, health: null,
  catchUp: true,   // draining a backlog (reload / scrub): place people, don't animate
};

/* ---------------------------------------------------------------- data --- */
let polling = false;
async function poll() {
  if (polling) return;   // a scan slower than the interval must not stack requests
  polling = true;
  try {
    const d = await (await fetch('/api/state?since=' + St.since)).json();
    Object.assign(St.sessions, d.sessions);
    Object.assign(St.agentMeta, d.agents);
    St.health = d.health || null;
    if (!St.t0) { St.t0 = d.start; St.clock = d.now; }
    St.t1 = d.now;
    // A title or model can land on a row long after its owner is already on the
    // floor, and both arrive as metadata, never as an event.
    if (d.sessions || d.agents) relabel();
    if (d.events.length) {
      // seq, not t: the server stamps it on arrival, so a row read from a tail
      // seek still carries a new high and is not filtered out for being old.
      for (const e of d.events) St.since = Math.max(St.since, e.seq);
      St.events.push(...d.events);
      St.events.sort((a, b) => a.t - b.t);
      rewind();     // a late event may have landed behind where we have scanned
    }
    if (St.events.length) St.t0 = St.events[0].t - 60;
  } catch (e) { /* server gone: keep animating what we have */
  } finally { polling = false; }
}

/* late metadata -> the name already drawn over someone's head */
function relabel() {
  for (const k in St.people) {
    const p = St.people[k];
    const m = p.boss ? (St.sessions[p.sid] || {})
                     : (St.agentMeta[p.sid + '/' + p.aid] || {});
    const name = clean(p.boss ? m.title : m.name);
    if (name && name !== p.name) { p.name = name; p.display = personName(p); }
    if (!p.model && m.model) p.model = m.model.replace(/^claude-/, '').split('-')[0] || '';
  }
}

/* -------------------------------------------------------------- people --- */
const pkey = e => e.sid + '|' + (e.aid || '');     // agent ids repeat across sessions

/* No desk left in your own room. The shared band has a bank of hot desks whose
   entries are desk-shaped on purpose, so claimDesk/releaseDesk work on them
   unchanged — and they give a real facing, which a bare seat does not. Keyed by
   p.key, never the bare agent id: agent ids repeat across sessions and this
   amenity is shared by all of them. Returns null when it is full or not built,
   and the caller falls back to the room's own standing room. */
function coworkDesk(key) {
  const a = (F.state.amenities || []).find(x => x.kind === 'coworking');
  if (!a || !a.desks || !a.desks.length) return null;
  const d = F.claimDesk(a, key);
  return d ? { fac: a, desk: d } : null;
}

function personFor(e) {
  const key = pkey(e);
  let p = St.people[key];
  if (p) return p;
  // An event can beat its own session's metadata onto the wire. Building the room
  // now would file it under project '?', which ensureRoom gives a department of its
  // own — a whole DEPT_PITCH away from the team it belongs to, and rooms never
  // move. Better to appear a poll late than to sit marooned all session.
  const s = St.sessions[e.sid];
  if (!s || !s.proj) return null;
  const room = F.ensureRoom(e.sid, s.proj);
  const boss = !e.aid;
  let desk, cowork = null;
  if (boss) desk = F.claimBoss(room, e.sid);
  else {
    desk = F.claimDesk(room, e.aid);
    if (!desk) {
      const cw = coworkDesk(key);
      if (cw) { desk = cw.desk; cowork = cw.fac; }
      else desk = F.hotDesk(room, e.aid);
    }
  }
  const meta = e.aid ? (St.agentMeta[e.sid + '/' + e.aid] || {}) : s;
  const h = hash(key);
  p = St.people[key] = {
    key, sid: e.sid, aid: e.aid, boss, room,
    desk, h, cowork,                    // h also decides which facilities they use
    fac: null,                          // the amenity whose seat they are holding
    gesture: '',                        // tool-level one-shot for the 3D layer
    hue: boss ? deptHue(s.proj) : (h % 360),
    x: room.door.x + .5, y: room.door.y + .5,
    /* Tiles per second, and a tile is a metre, so this has to BE a walking speed:
       the 3D layer plays its walk clip at speed / 0.975, so the old 2.00-2.39 ran the
       whole office at 2.45x. The boss's band sits strictly below everyone else's, not
       at a multiple of it — a gait you can pick out of a room has to be the slowest. */
    path: null, pi: 0, dest: null,
    speed: boss ? .86 + (h % 14) / 100 : 1.06 + (h % 44) / 100,
    lane: ((h % 5) - 2) * .17,          // keep to your own side of the aisle
    state: 'walk', act: 'type', face: S, arriveFace: S,
    phase: (h % 628) / 100, bob: (h % 314) / 100,
    last: 0, breakAt: 0, tripAt: -1e9,
    name: clean(boss ? (s.title || e.sid.slice(0, 8)) : (meta.name || e.aid.slice(0, 9))),
    model: (meta.model || '').replace(/^claude-/, '').split('-')[0] || '',
  };
  p.display = personName(p);          // cached: it is 3 regex scans and a split
  return p;
}

/* -------------------------------------------------------------- routing --- */
/* A one-shot played over the base clip, so it says what the tool was, not just
   what the body is doing. Anything not listed clears it. */
const GESTURES = {
  Read: 'point', Edit: 'typefast', Write: 'typefast', Bash: 'headscratch',
  Task: 'handoff', Agent: 'handoff', SendMessage: 'handoff',
  WebFetch: 'lookup', WebSearch: 'lookup',
};

/* Which shared facility each kind of trip can end in. '' means "keep to your own
   room", and it is one of the options on purpose: if everybody walked out the
   corridor would be a parade and the rooms would be empty. */
const AWAY = {
  break: ['', 'cafeteria', 'lounge'],
  lookup: ['', 'lounge', 'wellness'],
  // A one-entry list is not a choice: `% 1` is always 0, so every single person
  // took the washroom run the moment they crossed LONG_IDLE. Two blanks make it the
  // minority trip it reads as, off the same hash slice as the other two.
  washroom: ['', '', 'washrooms'],
};
/* independent bit slices of one hash, so the three decisions do not correlate */
const AWAY_BIT = { break: 3, lookup: 9, washroom: 15 };
/* ...but only once the hash is mixed. hash() is a plain *31 rolling hash and sibling
   keys ('s1|a0' .. 's1|a13') differ only in their last character, so every slice above
   bit ~8 is IDENTICAL across a whole room: `lookup` picked one facility per session,
   not per person, and the washroom slice was constant. One multiply spreads the low
   bits over the word. Still a pure function of p.h, so a rebuild replays it. */
const KNUTH = 2654435761;

/* Everyone leaving a claimed spot frees BOTH sides: the room's zones and the
   shared facility they may have walked to. Facility seats live on the amenity,
   not on the room, so releasing only the room leaks them (EDGE_CASES C3). */
function freeSpots(p) {
  F.releaseSpots(p.room, p.key);
  if (p.fac) { F.releaseSpots(p.fac, p.key); p.fac = null; }
}

/* A hot desk is held for the whole visit, not just for one trip, so only the two
   paths that end someone's day give it back. Leaking it is the desk leak one
   level up (EDGE_CASES C3), just in the shared band instead of a team room. */
function freeAll(p) {
  freeSpots(p);
  if (p.cowork) { F.releaseDesk(p.cowork, p.key); p.cowork = null; }
}

/* A trip up to the shared band, or null to use the room's own zone.
   The pick is bits of hash(p.key) and never Math.random: scrubbing back to the
   same clock has to rebuild the same floor (test S6). floor.js may not have built
   a given kind yet, and a facility with no free seat is no use either — both
   return null and the caller falls back in-room. */
function trip(p, why, act) {
  const opts = AWAY[why];
  const kind = opts[((Math.imul(p.h, KNUTH) >>> 0) >>> AWAY_BIT[why]) % opts.length];
  const a = kind && (F.state.amenities || []).find(x => x.kind === kind);
  if (!a || !a.seats || !a.seats.length) return null;
  // Full is a refusal. takeSpot's documented overflow shares the last spot, which in
  // a facility means ten people standing inside one another on one washroom tile —
  // what the room's own zone is the fallback for. Reads the bookkeeping takeSpot writes.
  const held = (a._held && a._held.seats) || {};
  if (held[p.key] === undefined && Object.keys(held).length >= a.seats.length) return null;
  const sp = F.takeSpot(a, 'seats', p.key);
  if (!sp) return null;
  if (p.fac && p.fac !== a) F.releaseSpots(p.fac, p.key);
  F.releaseSpots(p.room, p.key);        // not in the room any more
  p.fac = a;
  return [sp.x, sp.y, act, N];
}

/* where a tool sends someone, and which way they end up looking */
function station(p, tool) {
  const r = p.room;
  // someone who greps twenty times a minute does not walk to the cabinet twenty
  // times — they do it from their desk. Trips are occasional, not per tool call.
  const canTrip = St.clock - p.tripAt > TRIP_GAP;
  if (!canTrip) return atDesk(p);
  if (tool === 'Grep' || tool === 'Glob') {
    freeSpots(p);
    const sp = F.takeSpot(r, 'archive', p.key);
    return [sp.x, sp.y, 'file', N];
  }
  if (!p.boss && (tool === 'Task' || tool === 'Agent' || tool === 'SendMessage')) {
    freeSpots(p);
    const sp = F.takeSpot(r, 'meet', p.key);          // a boss never walks to meet himself
    return [sp.x, sp.y, 'meet', N];
  }
  if (tool === 'WebFetch' || tool === 'WebSearch') {
    const out = trip(p, 'lookup', 'think');           // the lounge or the quiet room
    if (out) return out;
    const sp = F.takeSpot(r, 'break', p.key);
    return [sp.x, sp.y, 'think', N];
  }
  return atDesk(p);
}

function atDesk(p) {
  freeSpots(p);
  return [p.desk.seat.x, p.desk.seat.y, 'type', p.desk.dir];
}

function goTo(p, tx, ty, act, face) {
  p.act = act; p.arriveFace = face; p.dest = { x: tx, y: ty };
  if (St.ff || St.catchUp) { p.x = tx + .5; p.y = ty + .5; p.path = null; arrive(p); return; }
  if (Math.abs(p.x - (tx + .5)) < .1 && Math.abs(p.y - (ty + .5)) < .1) { arrive(p); return; }
  const pts = F.path(p.x, p.y, tx, ty);
  if (!pts || pts.length < 2) { p.x = tx + .5; p.y = ty + .5; arrive(p); return; }
  p.path = pts.map(t => ({ x: t.x + .5, y: t.y + .5 }));
  p.pi = 1;
  p.state = 'walk';
}

function arrive(p) {
  p.state = p.act || 'type';
  p.face = p.arriveFace;
  p.path = null;
  if (p.state === 'think') p.breakAt = St.clock;
  if (p.state !== 'type') p.tripAt = St.clock;      // just been out; settle for a while
}

function apply(e) {
  const p = personFor(e);
  if (!p) return false;                               // session metadata not in yet
  if (p.state === 'leaving') return true;             // one-shot: cannot be overridden
  const [tx, ty, act, face] = station(p, e.tool);
  if (!p.dest || p.dest.x !== tx || p.dest.y !== ty) goTo(p, tx, ty, act, face);
  p.gesture = GESTURES[e.tool] || '';                 // unlisted tool clears the last one
  p.last = e.t;
  p.room.lastT = e.t;
  p.display = personName(p);
  p.saying = e.kind === 'prompt' ? '“' + e.say + '”' : e.say;
  hooks.say(p, p.saying, e.kind === 'prompt', e.t);
  return true;
}

/* "applied" lives on the event, not on an index, because the array is re-sorted
   on every poll — an index would silently skip an event inserted behind it. */
function rewind() {
  St.scanFrom = 0;
  while (St.scanFrom < St.events.length && St.events[St.scanFrom].done) St.scanFrom++;
}

function rebuild(to) {
  for (const k in St.people) {
    const p = St.people[k];
    freeAll(p);
    if (!p.boss && p.aid) F.releaseDesk(p.room, p.aid);
  }
  St.people = {};
  hooks.reset();
  // lastT drives the room's busy glow and its "last active" line. Left standing it
  // reports activity in the future for every room you scrub back past.
  for (const k in F.state.rooms) delete F.state.rooms[k].lastT;
  for (const e of St.events) e.done = e.t <= to - GONE;
  rewind();
  St.catchUp = true;      // the backlog about to replay must not be walked out
}

/* --------------------------------------------------------------- search --- */
const personText = p => (p.name + ' ' + p.key + ' ' + p.model).toLowerCase();
function roomText(r) {
  const s = St.sessions[r.sid] || {};
  return (r.proj + ' ' + r.sid + ' ' + (s.title || '') + ' ' + (s.branch || '')).toLowerCase();
}
function roomHit(r) {
  if (!St.q) return true;
  if (roomText(r).includes(St.q)) return true;
  for (const k in St.people) if (St.people[k].room === r && personText(St.people[k]).includes(St.q)) return true;
  return false;
}

/* ---------------------------------------------------------------- step --- */
function step(dt) {
  const ppl = Object.values(St.people);
  for (const p of ppl) {
    const age = St.clock - p.last;

    if (age > GONE && p.state !== 'leaving') {
      freeSpots(p);
      p.gesture = '';                                 // on the way out, not mid-tool
      p.state = 'leaving';
      goTo(p, p.room.door.x, p.room.door.y, 'leaving', N);
      p.state = p.path ? 'walk' : 'leaving';
      p.act = 'leaving';
    } else if (p.state === 'think' && St.clock - p.breakAt > BREAK_OVER) {
      freeSpots(p);                                   // hand the seat back before walking off
      goTo(p, p.desk.seat.x, p.desk.seat.y, 'type', p.desk.dir);   // break over, back to work
    // A long quiet spell earns a second trip — the washroom run. The clause is
    // `breakAt < p.last + LONG_IDLE` so it fires exactly once, never on a loop.
    } else if (age > IDLE && age <= GONE && p.state === 'type' &&
               (p.breakAt < p.last || (age > LONG_IDLE && p.breakAt < p.last + LONG_IDLE))) {
      // Which trip, by what they have already had — not by age. A reloaded page
      // replays its backlog with the clock jumping, so the first time step() sees
      // most people they are already past LONG_IDLE: keyed off age, they all went
      // straight to the washrooms and nobody ever saw the cafeteria.
      const why = p.breakAt < p.last ? 'break' : 'washroom';
      p.breakAt = St.clock;
      p.gesture = '';
      const out = trip(p, why, 'think');
      if (out) { goTo(p, out[0], out[1], out[2], out[3]); }
      else {
        const sp = F.takeSpot(p.room, 'break', p.key);
        goTo(p, sp.x, sp.y, 'think', N);
      }
    }

    /* Both views swing a leg on sin(p.phase), so this is tied to ground speed, not a
       fixed rate: the clip covers 1.3 u in two steps, so pi per .65 u = 4.83 rad/u. */
    p.phase += dt * (p.state === 'walk' ? p.speed * 4.83 : 2.6);
    p.bob += dt * 1.9;

    if (p.state === 'walk' && p.path) {
      const wp = p.path[p.pi];
      if (!wp) { p.act === 'leaving' ? exit(p) : arrive(p); continue; }
      let aimX = wp.x, aimY = wp.y;
      if (p.pi < p.path.length - 1) {            // lane offset on the way, never on the seat
        const from = p.path[p.pi - 1] || { x: p.x, y: p.y };
        const sx = wp.x - from.x, sy = wp.y - from.y, sl = Math.hypot(sx, sy);
        if (sl > .001) {
          const ox = -sy / sl * p.lane, oy = sx / sl * p.lane;
          if (F.walkable(wp.x + ox, wp.y + oy)) { aimX += ox; aimY += oy; }
        }
      }
      const dx = aimX - p.x, dy = aimY - p.y, d = Math.hypot(dx, dy);
      if (d < .14) {
        p.pi++;
        if (p.pi >= p.path.length) { p.act === 'leaving' ? exit(p) : arrive(p); }
      } else {
        const v = Math.min(p.speed * dt, d);
        p.x += dx / d * v; p.y += dy / d * v;
        p.face = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? E : W) : (dy > 0 ? S : N);
      }
    } else if (p.state === 'leaving') { exit(p); }
    else if (p.state === 'walk') { arrive(p); }      // no path left: settle, never idle in 'walk'
  }

  // personal space. This MUST be scaled by dt and capped: unscaled it applied ~1.5
  // tiles/s of sideways shove at 60fps, which overpowered walking and meant nobody
  // ever reached their desk.
  for (let i = 0; i < ppl.length; i++) for (let j = i + 1; j < ppl.length; j++) {
    const a = ppl[i], b = ppl[j];
    if (a.room !== b.room) continue;
    const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
    if (d2 > .72 || d2 < 1e-6) continue;
    const d = Math.sqrt(d2);
    const push = Math.min((.85 - d) * 2.5 * dt, .03);
    const ux = dx / d * push, uy = dy / d * push;
    if (F.walkable(a.x - ux, a.y - uy)) { a.x -= ux; a.y -= uy; }
    if (F.walkable(b.x + ux, b.y + uy)) { b.x += ux; b.y += uy; }
  }
}

function exit(p) {
  freeAll(p);                                           // zone, facility seat and hot desk
  if (!p.boss && p.aid) F.releaseDesk(p.room, p.aid);   // clocked out: free the desk
  delete St.people[p.key];
}

/* --------------------------------------------------------------- clock --- */
/* One tick of the world: move the clock, apply whatever came due, step everyone.
   Returns how many events were applied, which is what tells the caller whether a
   backlog is still draining. */
function advance(dt) {
  const rate = St.live ? 1 : SPEEDS[St.si];
  St.ff = !St.live && rate > FF_ABOVE;

  if (St.live) St.clock = Date.now() / 1000;
  else if (St.playing) St.clock = Math.min(St.clock + dt * rate, St.t1);

  let i = St.scanFrom, budget = EVENT_BUDGET, applied = 0;
  while (i < St.events.length && St.events[i].t <= St.clock && budget > 0) {
    const e = St.events[i++];
    if (e.done) continue;
    // Its session's name may not have arrived yet; apply() refuses rather than
    // file the room under '?'. Hold the event and retry on the next frame — but
    // bound it: a held event pins the scan head, and a poll is 2 seconds, so a
    // name still missing after IDLE is not coming. Drop it and move on.
    if (!apply(e)) { if (St.clock - e.t > IDLE) e.done = true; continue; }
    e.done = true; budget--; applied++;
  }
  while (St.scanFrom < St.events.length && St.events[St.scanFrom].done) St.scanFrom++;
  // backlog drained once we are back to at most one event per frame: animate again
  if (St.catchUp && applied <= 1) St.catchUp = false;

  step(dt);
  return applied;
}

const Sim = {
  St, hooks, SPEEDS, IDLE, LONG_IDLE, GONE, FF_ABOVE, BREAK_OVER,
  poll, relabel, advance, step, apply, rebuild, rewind, personFor, exit,
  roomHit, roomText, personText,
  roomName, personName, taskLabel, shortLabel, clean, deptHue, hash, pkey,
};

if (typeof module !== 'undefined' && module.exports) module.exports = Sim;
else root.Sim = Sim;
})(typeof globalThis !== 'undefined' ? globalThis : this);
