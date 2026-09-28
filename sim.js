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
  const t = String(str || '').replace(/[`"'“”*_]/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  // a brief that names its worker ("Nikhil, role: tester, ...") — use the name
  const named = t.match(/^([A-Z][a-z]{2,15})\s*,\s*(?:role|a|an|the)\b/);
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

function personFor(e) {
  const key = pkey(e);
  let p = St.people[key];
  if (p) return p;
  const s = St.sessions[e.sid] || { proj: '?', agents: [] };
  const room = F.ensureRoom(e.sid, s.proj || '?');
  const boss = !e.aid;
  const desk = boss ? F.claimBoss(room, e.sid)
                    : (F.claimDesk(room, e.aid) || F.hotDesk(room, e.aid));
  const meta = e.aid ? (St.agentMeta[e.sid + '/' + e.aid] || {}) : s;
  const h = hash(key);
  p = St.people[key] = {
    key, sid: e.sid, aid: e.aid, boss, room,
    desk,
    hue: boss ? deptHue(s.proj || '?') : (h % 360),
    x: room.door.x + .5, y: room.door.y + .5,
    path: null, pi: 0, dest: null, speed: 2.0 + (h % 40) / 100,
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

/* where a tool sends someone, and which way they end up looking */
function station(p, tool) {
  const r = p.room;
  // someone who greps twenty times a minute does not walk to the cabinet twenty
  // times — they do it from their desk. Trips are occasional, not per tool call.
  const canTrip = St.clock - p.tripAt > TRIP_GAP;
  if (!canTrip) { F.releaseSpots(r, p.key); return [p.desk.seat.x, p.desk.seat.y, 'type', p.desk.dir]; }
  if (tool === 'Grep' || tool === 'Glob') {
    const sp = F.takeSpot(r, 'archive', p.key);
    return [sp.x, sp.y, 'file', N];
  }
  if (!p.boss && (tool === 'Task' || tool === 'Agent' || tool === 'SendMessage')) {
    const sp = F.takeSpot(r, 'meet', p.key);          // a boss never walks to meet himself
    return [sp.x, sp.y, 'meet', N];
  }
  if (tool === 'WebFetch' || tool === 'WebSearch') {
    const sp = F.takeSpot(r, 'break', p.key);
    return [sp.x, sp.y, 'think', N];
  }
  F.releaseSpots(r, p.key);
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
  if (p.state === 'leaving') return;                  // one-shot: cannot be overridden
  const [tx, ty, act, face] = station(p, e.tool);
  if (!p.dest || p.dest.x !== tx || p.dest.y !== ty) goTo(p, tx, ty, act, face);
  p.last = e.t;
  p.room.lastT = e.t;
  p.display = personName(p);
  p.saying = e.kind === 'prompt' ? '“' + e.say + '”' : e.say;
  hooks.say(p, p.saying, e.kind === 'prompt', e.t);
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
    F.releaseSpots(p.room, k);
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
      F.releaseSpots(p.room, p.key);
      p.state = 'leaving';
      goTo(p, p.room.door.x, p.room.door.y, 'leaving', N);
      p.state = p.path ? 'walk' : 'leaving';
      p.act = 'leaving';
    } else if (p.state === 'think' && St.clock - p.breakAt > BREAK_OVER) {
      goTo(p, p.desk.seat.x, p.desk.seat.y, 'type', p.desk.dir);   // break over, back to work
    } else if (age > IDLE && age <= GONE && p.state === 'type' && p.breakAt < p.last) {
      p.breakAt = St.clock;
      const sp = F.takeSpot(p.room, 'break', p.key);
      goTo(p, sp.x, sp.y, 'think', N);
    }

    p.phase += dt * (p.state === 'walk' ? 8.5 : 2.6);
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
  F.releaseSpots(p.room, p.key);
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
    e.done = true; budget--; applied++;
    apply(e);
  }
  while (St.scanFrom < St.events.length && St.events[St.scanFrom].done) St.scanFrom++;
  // backlog drained once we are back to at most one event per frame: animate again
  if (St.catchUp && applied <= 1) St.catchUp = false;

  step(dt);
  return applied;
}

const Sim = {
  St, hooks, SPEEDS, IDLE, GONE, FF_ABOVE,
  poll, relabel, advance, step, apply, rebuild, rewind, personFor, exit,
  roomHit, roomText, personText,
  roomName, personName, taskLabel, shortLabel, clean, deptHue, hash, pkey,
};

if (typeof module !== 'undefined' && module.exports) module.exports = Sim;
else root.Sim = Sim;
})(typeof globalThis !== 'undefined' ? globalThis : this);
