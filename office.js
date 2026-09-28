/* office.js — the isometric view and the people in it.
   Geometry and routing live in floor.js; speech lives in chat.js. */
'use strict';

const TW = 64, TH = 32;
const IDLE = 90, GONE = 900;              // simulation seconds
const BREAK_OVER = 45;                    // sim seconds at the cooler before going back
const TRIP_GAP = 40;                      // sim seconds between trips away from the desk
const SPEEDS = [1, 10, 60, 300, 1800];
const FF_ABOVE = 10;                      // above this, stop animating walks (see step)
const EVENT_BUDGET = 2000;                // events applied per frame, so 1800x can't stall

const F = window.Floor, Chat = window.Chat;
const { N, E, S, W } = F;

const cv = document.getElementById('cv'), cx = cv.getContext('2d');
const el = id => document.getElementById(id);
const lerp = (a, b, t) => a + (b - a) * t;
const hash = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const iso = (x, y) => ({ x: (x - y) * TW / 2, y: (x + y) * TH / 2 });

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

const St = {
  sessions: {}, agentMeta: {}, events: [], people: {},
  t0: 0, t1: 0, clock: 0, live: true, playing: true, si: 2, scanFrom: 0, since: 0,
  cam: { x: 0, y: 0, z: .5, tx: 0, ty: 0, tz: .5 },
  focus: null, q: '', dpr: 1, userMoved: false, ff: false, wall: 0, health: null,
  catchUp: true,   // draining a backlog (reload / scrub): place people, don't animate
};

/* ---------------------------------------------------------------- data --- */
async function poll() {
  try {
    const d = await (await fetch('/api/state?since=' + St.since)).json();
    Object.assign(St.sessions, d.sessions);
    Object.assign(St.agentMeta, d.agents);
    St.health = d.health || null;
    if (!St.t0) { St.t0 = d.start; St.clock = d.now; }
    St.t1 = d.now;
    if (d.events.length) {
      St.since = Math.max(St.since, d.events[d.events.length - 1].t);
      St.events.push(...d.events);
      St.events.sort((a, b) => a.t - b.t);
      rewind();     // a late event may have landed behind where we have scanned
    }
    if (St.events.length) St.t0 = St.events[0].t - 60;
  } catch (e) { /* server gone: keep animating what we have */ }
}

const deptHue = proj => DEPT_HUES[hash(proj) % DEPT_HUES.length];

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
  const meta = e.aid
    ? (St.agentMeta[e.sid + '/' + e.aid] || St.agentMeta[e.aid] || {})
    : s;
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
  Chat.say(p, p.saying, e.kind === 'prompt', St.wall, e.t, !St.ff);
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
  Chat.clear();
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

  const c = St.cam, k = 1 - Math.exp(-6 * dt);
  c.x = lerp(c.x, c.tx, k); c.y = lerp(c.y, c.ty, k); c.z = lerp(c.z, c.tz, k);
}

function exit(p) {
  F.releaseSpots(p.room, p.key);
  if (!p.boss && p.aid) F.releaseDesk(p.room, p.aid);   // clocked out: free the desk
  delete St.people[p.key];
}

/* -------------------------------------------------------------- drawing --- */
const shade = (h, s, l, a = 1) => `hsla(${h} ${s}% ${l}% / ${a})`;

function tile(x, y, fill, stroke) {
  const p = iso(x, y);
  cx.beginPath();
  cx.moveTo(p.x, p.y); cx.lineTo(p.x + TW / 2, p.y + TH / 2);
  cx.lineTo(p.x, p.y + TH); cx.lineTo(p.x - TW / 2, p.y + TH / 2);
  cx.closePath();
  if (fill) { cx.fillStyle = fill; cx.fill(); }
  if (stroke) { cx.strokeStyle = stroke; cx.lineWidth = 1; cx.stroke(); }
}

function box(x, y, w, d, h, top, left, right) {
  const a = iso(x, y), b = iso(x + w, y), c = iso(x + w, y + d), e = iso(x, y + d);
  const up = v => ({ x: v.x, y: v.y - h });
  const A = up(a), B = up(b), C = up(c), D = up(e);
  cx.beginPath(); cx.moveTo(e.x, e.y); cx.lineTo(c.x, c.y); cx.lineTo(C.x, C.y); cx.lineTo(D.x, D.y);
  cx.closePath(); cx.fillStyle = right; cx.fill();
  cx.beginPath(); cx.moveTo(a.x, a.y); cx.lineTo(e.x, e.y); cx.lineTo(D.x, D.y); cx.lineTo(A.x, A.y);
  cx.closePath(); cx.fillStyle = left; cx.fill();
  cx.beginPath(); cx.moveTo(A.x, A.y); cx.lineTo(B.x, B.y); cx.lineTo(C.x, C.y); cx.lineTo(D.x, D.y);
  cx.closePath(); cx.fillStyle = top; cx.fill();
}

function chair(x, y, dir) {
  box(x + .28, y + .28, .44, .44, 7, '#2a3042', '#1b1f2c', '#222736');
  const bx = dir === N ? [x + .22, y + .66] : dir === S ? [x + .22, y + .18]
           : dir === W ? [x + .66, y + .22] : [x + .18, y + .22];
  box(bx[0], bx[1], dir === E || dir === W ? .14 : .56, dir === E || dir === W ? .56 : .14,
      15, '#333a4f', '#1f2431', '#272d3d');
}

function drawDesk(d, on, big) {
  const w = big ? 1.7 : .98, dp = .76;
  box(d.x + .02, d.y + .1, w, dp, 13, '#3b4259', '#242a3b', '#2f3549');
  // monitor sits on the far side of the desk, so the occupant faces it
  const m = { x: d.x + w / 2 - .22, y: d.y + .14 };
  box(m.x, m.y, .46, .08, on ? 17 : 15, on ? '#8bd9fb' : '#1c2130',
      on ? '#3d7fa0' : '#141824', on ? '#5aa8cc' : '#191e2c');
  if (on) {
    const g0 = iso(m.x + .23, m.y);
    const g = cx.createRadialGradient(g0.x, g0.y - 16, 2, g0.x, g0.y - 16, 44);
    g.addColorStop(0, 'rgba(125,211,252,.22)'); g.addColorStop(1, 'rgba(125,211,252,0)');
    cx.fillStyle = g; cx.beginPath(); cx.arc(g0.x, g0.y - 16, 44, 0, 7); cx.fill();
  }
}

function drawProp(pr) {
  switch (pr.type) {
    case 'table':
      box(pr.x + .05, pr.y + .05, pr.w - .1, pr.h - .1, 13, '#3a3350', '#221d31', '#2c2640');
      break;
    case 'cabinet':
      box(pr.x + .1, pr.y + .15, pr.w - .2, .65, 32, '#454e68', '#262c3c', '#333a4f');
      break;
    case 'cooler':
      box(pr.x + .28, pr.y + .28, .45, .45, 40, '#59808f', '#22323c', '#2e4653');
      break;
    case 'sofa':
      box(pr.x + .08, pr.y + .2, pr.w - .16, .6, 11, '#414a66', '#232838', '#2f3549');
      box(pr.x + .08, pr.y + .66, pr.w - .16, .14, 24, '#4a5578', '#252b3d', '#333b54');
      break;
    case 'lowtable':
      box(pr.x + .22, pr.y + .22, .56, .56, 8, '#4a3f33', '#2a231c', '#372f26');
      break;
    case 'printer':
      box(pr.x + .15, pr.y + .2, .7, .6, 18, '#464f68', '#252b3b', '#323a4e');
      box(pr.x + .28, pr.y + .3, .44, .4, 22, '#d8dee9', '#8d95a6', '#aab2c2');
      break;
    case 'shelf':
      box(pr.x + .12, pr.y + .1, .72, pr.h - .2, 40, '#4a3d30', '#281f18', '#372c22');
      for (let i = 0; i < 3; i++) {
        const b = iso(pr.x + .5, pr.y + .4 + i * .5);
        cx.fillStyle = ['#6b8fb5', '#b56b6b', '#7fb56b'][i];
        cx.fillRect(b.x - 9, b.y - 30 + i * 9, 18, 5);
      }
      break;
    case 'board': {
      const w0 = iso(pr.x + .5, pr.y + .5);
      box(pr.x + .3, pr.y + .1, .12, .8, 34, '#333a4f', '#1f2431', '#272d3d');
      cx.fillStyle = '#e8edf5';
      cx.fillRect(w0.x - 3, w0.y - 46, 22, 26);
      cx.fillStyle = '#9aa4b8';
      for (let i = 0; i < 3; i++) cx.fillRect(w0.x + 1, w0.y - 41 + i * 6, 14 - i * 4, 2);
      break;
    }
    case 'plant': {
      const c0 = iso(pr.x + .5, pr.y + .5);
      box(pr.x + .3, pr.y + .3, .4, .4, 11, '#5b4636', '#33261c', '#432f23');
      cx.fillStyle = '#3f7d4f';
      for (let i = 0; i < 5; i++) {
        cx.beginPath();
        cx.ellipse(c0.x + Math.cos(i * 1.3) * 8, c0.y - 19 + Math.sin(i * 1.7) * 6, 7, 4.5, i, 0, 7);
        cx.fill();
      }
      break;
    }
  }
}

const POSE = { type: 1, think: 0, file: 0, meet: 0, walk: 0, leaving: 0 };

function drawPerson(p, dim) {
  const s = iso(p.x, p.y), walk = p.state === 'walk';
  const seated = p.state === 'type';
  const bob = walk ? Math.abs(Math.sin(p.phase)) * 2.4 : Math.sin(p.bob) * .7;
  const bx = s.x, by = s.y - (seated ? 7 : 0) - bob;
  const idle = St.clock - p.last > IDLE;
  const sc = (p.boss ? 1.1 : .92) * (seated ? .94 : 1);
  const hit = !St.q || personText(p).includes(St.q);

  cx.save(); cx.translate(bx, by); cx.scale(sc, sc);
  cx.globalAlpha = dim ? .12 : (idle ? .5 : 1) * (hit ? 1 : .25);

  cx.fillStyle = 'rgba(0,0,0,.34)';
  cx.beginPath(); cx.ellipse(0, (seated ? 7 : 0) + bob, 10, 5, 0, 0, 7); cx.fill();

  const swing = walk ? Math.sin(p.phase) * 4 : 0;
  cx.fillStyle = '#2b3142';
  if (seated) {                                     // knees forward, shins down
    cx.beginPath(); cx.roundRect(-6, -12, 5, 8, 2); cx.fill();
    cx.beginPath(); cx.roundRect(1, -12, 5, 8, 2); cx.fill();
  } else {
    cx.beginPath(); cx.roundRect(-6, -13, 5, 13 + swing * .4, 2); cx.fill();
    cx.beginPath(); cx.roundRect(1, -13, 5, 13 - swing * .4, 2); cx.fill();
  }

  cx.fillStyle = shade(p.hue, idle ? 18 : 60, idle ? 34 : 50);
  cx.beginPath(); cx.roundRect(-8, -29, 16, 18, 5); cx.fill();
  if (p.boss) {
    cx.fillStyle = shade(p.hue, 80, 68);
    cx.beginPath(); cx.moveTo(0, -29); cx.lineTo(2.3, -25); cx.lineTo(0, -15); cx.lineTo(-2.3, -25);
    cx.closePath(); cx.fill();
  }

  const typing = seated ? Math.sin(p.phase * 4.5) * 2 : 0;
  cx.fillStyle = shade(p.hue, 54, 44);
  cx.beginPath(); cx.roundRect(-11, -27 + swing * .5 + typing, 4.4, seated ? 10 : 13, 2.2); cx.fill();
  cx.beginPath(); cx.roundRect(6.6, -27 - swing * .5 - typing, 4.4, seated ? 10 : 13, 2.2); cx.fill();

  cx.fillStyle = shade(p.hue, 38, idle ? 52 : 70);
  cx.beginPath(); cx.roundRect(-7, -44, 14, 15, 5); cx.fill();
  cx.fillStyle = shade(p.hue, 30, 22);
  cx.beginPath(); cx.roundRect(-7.5, -45, 15, 6, 3); cx.fill();
  if (!p.boss) {
    cx.strokeStyle = '#8891a8'; cx.lineWidth = 1.3;
    cx.beginPath(); cx.arc(0, -40, 8.3, Math.PI, 0); cx.stroke();
    cx.fillStyle = '#8891a8';
    cx.beginPath(); cx.arc(-8.3, -39, 1.8, 0, 7); cx.fill();
  }
  if (p.face !== N) {                                // eyes hidden when facing away
    cx.fillStyle = '#14171f';
    const ex = p.face === E ? 1.6 : p.face === W ? -1.6 : 0;
    cx.beginPath(); cx.arc(-3 + ex, -36, 1.4, 0, 7); cx.fill();
    cx.beginPath(); cx.arc(3 + ex, -36, 1.4, 0, 7); cx.fill();
  }

  // props that say what they are doing
  if (p.state === 'think') {                          // cup at the cooler
    cx.fillStyle = '#e8eef7';
    cx.beginPath(); cx.roundRect(8, -22, 5, 6, 1.4); cx.fill();
  } else if (p.state === 'file') {                    // folder at the cabinet
    cx.fillStyle = '#d9a441';
    cx.beginPath(); cx.roundRect(-14, -24, 9, 11, 1.5); cx.fill();
  } else if (p.state === 'meet') {                    // gesturing
    cx.fillStyle = shade(p.hue, 54, 50);
    cx.beginPath(); cx.roundRect(7, -32 + Math.sin(p.phase * 2) * 3, 4.4, 11, 2.2); cx.fill();
  }
  cx.restore();

  if (dim || St.cam.z < .5) return;            // too small to read, and they stack in a crowd
  cx.globalAlpha = hit ? 1 : .3;
  cx.font = (p.boss ? '600 ' : '') + '9px ui-monospace,Menlo,monospace';
  cx.textAlign = 'center';
  cx.fillStyle = p.boss ? shade(p.hue, 60, 72) : (idle ? '#5a6076' : '#8891a8');
  cx.fillText((p.boss ? '★ ' : '') + personName(p), bx, by + 17);
  cx.globalAlpha = 1;
}

/* ------------------------------------------------------------ the scene --- */
function drawRoomShell(r, dim) {
  const hue = deptHue(r.proj);
  const busy = St.clock - (r.lastT || 0) < IDLE;
  cx.globalAlpha = dim ? .1 : 1;

  for (let x = 1; x < F.ROOM_W - 1; x++) for (let y = 1; y < F.ROOM_H - 1; y++) {
    const z = r.zones, gx = r.gx + x, gy = r.gy + y;
    const inZone = zz => gx >= zz.x && gx < zz.x + zz.w && gy >= zz.y && gy < zz.y + zz.h;
    let l = 19, sat = 10;
    if (inZone(z.boss)) { l = 23; sat = 24; }
    else if (inZone(z.break) || inZone(z.lounge)) { l = 22; sat = 30; }
    else if (inZone(z.archive)) { l = 20; sat = 16; }
    else if (inZone(z.aisle)) { l = 25; sat = 6; }
    tile(gx, gy, shade(hue, sat, l + ((x + y) % 2 ? 1.8 : 0)), 'rgba(255,255,255,.025)');
  }
  // walls, with the doorway left open
  for (let x = 0; x < F.ROOM_W; x++) {
    if (r.gx + x === r.door.x) continue;
    box(r.gx + x, r.gy, 1, .16, 26, shade(hue, 14, 30), shade(hue, 14, 21), shade(hue, 14, 26));
  }
  for (let y = 0; y < F.ROOM_H; y++)
    box(r.gx, r.gy + y, .16, 1, 26, shade(hue, 14, 30), shade(hue, 14, 24), shade(hue, 14, 19));
  // door frame
  box(r.door.x - .06, r.gy, .12, .16, 30, shade(hue, 40, 46), shade(hue, 40, 34), shade(hue, 40, 40));
  box(r.door.x + .94, r.gy, .12, .16, 30, shade(hue, 40, 46), shade(hue, 40, 34), shade(hue, 40, 40));

  if (St.cam.z > .45) {                       // zone signage, once you're close enough
    cx.font = '600 10px ui-monospace,Menlo,monospace'; cx.textAlign = 'center';
    for (const zk in r.zones) {
      const z = r.zones[zk];
      if (!z.label) continue;
      const c = iso(z.x + z.w / 2, z.y + z.h / 2);
      cx.fillStyle = shade(hue, 40, 52, .5);
      cx.fillText(z.label, c.x, c.y + 4);
    }
  }

  const s = St.sessions[r.sid] || {};
  const label = roomName(r) + (s.agents && s.agents.length ? '  ×' + s.agents.length : '');
  const n = iso(r.gx + F.ROOM_W / 2, r.gy - 1.2);
  cx.font = '600 12px ui-monospace,Menlo,monospace'; cx.textAlign = 'center';
  const w = cx.measureText(label).width + 22;
  cx.fillStyle = 'rgba(8,10,16,.92)';
  cx.beginPath(); cx.roundRect(n.x - w / 2, n.y - 30, w, 21, 5); cx.fill();
  cx.strokeStyle = busy ? shade(hue, 70, 58) : '#333a4f'; cx.lineWidth = 1.1; cx.stroke();
  cx.fillStyle = busy ? shade(hue, 85, 74) : '#6d7488';
  cx.fillText(label, n.x, n.y - 15);
  cx.globalAlpha = 1;
}

function drawDepartments() {
  for (const proj in F.state.depts) {
    const d = F.state.depts[proj], hue = deptHue(proj);
    cx.globalAlpha = St.focus && St.focus.proj !== proj ? .25 : St.focus ? .5 : 1;
    const rs = d.rooms.map(sid => F.state.rooms[sid]);
    if (!rs.length) continue;
    const x0 = Math.min(...rs.map(r => r.gx)) - 1.4;
    const y0 = Math.min(...rs.map(r => r.gy)) - 1.4;
    const x1 = Math.max(...rs.map(r => r.gx + F.ROOM_W)) + 1.4;
    const y1 = Math.max(...rs.map(r => r.gy + F.ROOM_H)) + 1.4;
    const a = iso(x0, y0), b = iso(x1, y0), c = iso(x1, y1), e = iso(x0, y1);
    cx.beginPath(); cx.moveTo(a.x, a.y); cx.lineTo(b.x, b.y); cx.lineTo(c.x, c.y); cx.lineTo(e.x, e.y);
    cx.closePath();
    cx.fillStyle = shade(hue, 30, 9, .55); cx.fill();
    cx.strokeStyle = shade(hue, 45, 32, .55); cx.lineWidth = 1.5; cx.stroke();

    const sign = iso((x0 + x1) / 2, y0 - .6);
    cx.font = '700 15px ui-monospace,Menlo,monospace'; cx.textAlign = 'center';
    const w = cx.measureText(proj.toUpperCase()).width + 30;
    cx.fillStyle = shade(hue, 40, 13);
    cx.beginPath(); cx.roundRect(sign.x - w / 2, sign.y - 26, w, 24, 6); cx.fill();
    cx.strokeStyle = shade(hue, 60, 44); cx.lineWidth = 1.4; cx.stroke();
    cx.fillStyle = shade(hue, 75, 72);
    cx.fillText(proj.toUpperCase(), sign.x, sign.y - 9);
  }
  cx.globalAlpha = 1;
}

function render() {
  const Wp = cv.clientWidth, Hp = cv.clientHeight;
  cx.setTransform(St.dpr, 0, 0, St.dpr, 0, 0);
  cx.fillStyle = '#0b0d13'; cx.fillRect(0, 0, Wp, Hp);
  cx.save();
  cx.translate(Wp / 2, Hp / 2); cx.scale(St.cam.z, St.cam.z); cx.translate(-St.cam.x, -St.cam.y);

  drawDepartments();

  const rooms = Object.values(F.state.rooms);
  const vis = r => !((St.focus && St.focus !== r) || !roomHit(r));
  for (const r of rooms.sort((a, b) => (a.gx + a.gy) - (b.gx + b.gy))) drawRoomShell(r, !vis(r));

  // ONE depth-sorted pass over furniture and people together, so a person
  // standing behind a desk is occluded by it instead of painted over it
  const draws = [];
  for (const r of rooms) {
    const dim = !vis(r);
    // desks hold a bare agent id, but people are keyed session|agent (ids repeat
    // across sessions) — resolve through the room, or no monitor ever lights up
    const occupant = d => d === r.boss
      ? St.people[r.sid + '|']
      : (d.by ? St.people[r.sid + '|' + d.by] : null);
    const on = d => { const p = occupant(d); return !!p && St.clock - p.last < IDLE; };
    for (const d of r.desks) {
      draws.push({ z: d.x + d.y, f: () => { cx.globalAlpha = dim ? .1 : 1; drawDesk(d, on(d), false); } });
      draws.push({ z: d.seat.x + d.seat.y - .01,
                   f: () => { cx.globalAlpha = dim ? .1 : (d.by ? 1 : .5); chair(d.seat.x, d.seat.y, d.dir); } });
    }
    draws.push({ z: r.boss.x + r.boss.y, f: () => { cx.globalAlpha = dim ? .1 : 1; drawDesk(r.boss, on(r.boss), true); } });
    draws.push({ z: r.boss.seat.x + r.boss.seat.y - .01,
                 f: () => { cx.globalAlpha = dim ? .1 : 1; chair(r.boss.seat.x, r.boss.seat.y, r.boss.dir); } });
    for (const pr of r.props) if (pr.type !== 'pod' && pr.type !== 'bossdesk')
      draws.push({ z: pr.x + pr.y, f: () => { cx.globalAlpha = dim ? .1 : 1; drawProp(pr); } });
  }
  for (const k in St.people) {
    const p = St.people[k], dim = !vis(p.room);
    draws.push({ z: p.x + p.y, f: () => drawPerson(p, dim) });
  }
  draws.sort((a, b) => a.z - b.z);
  for (const d of draws) d.f();
  cx.globalAlpha = 1;
  cx.restore();
}

/* ------------------------------------------------------------- camera --- */
function bounds(rs) {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const r of rs) {
    const X0 = r.gx - 2, X1 = r.gx + F.ROOM_W + 2, Y0 = r.gy - 3, Y1 = r.gy + F.ROOM_H + 2;
    for (const [a, b] of [[X0, Y0], [X1, Y0], [X0, Y1], [X1, Y1]]) {
      const p = iso(a, b);
      x0 = Math.min(x0, p.x - TW); x1 = Math.max(x1, p.x + TW);
      y0 = Math.min(y0, p.y - TH); y1 = Math.max(y1, p.y + TH);
    }
  }
  return { x0, x1, y0: y0 - 70, y1 };
}
function frameTo(rs, pad = .9, maxZ = 1.4) {
  if (!rs.length) return;
  const b = bounds(rs);
  const Wp = cv.clientWidth - (St.focus ? 360 : 0), Hp = cv.clientHeight;
  St.cam.tz = Math.min(maxZ, Math.max(.1, Math.min(Wp / (b.x1 - b.x0), Hp / (b.y1 - b.y0)) * pad));
  St.cam.tx = (b.x0 + b.x1) / 2 + (St.focus ? 180 / St.cam.tz : 0);
  St.cam.ty = (b.y0 + b.y1) / 2;
}
const fitAll = () => frameTo(Object.values(F.state.rooms), .92, 1.0);

function focusRoom(r) {
  St.focus = r;
  if (!r) { el('panel').classList.remove('open'); Chat.renderLog(null); fitAll(); return; }
  el('panel').classList.add('open');
  frameTo([r], .86, 1.5);
}

/* ---------------------------------------------------------------- loop --- */
let prev = performance.now(), dragging = false, panning = null, roomCount = 0;
const hhmmss = t => new Date(t * 1000).toLocaleTimeString();

function frame(now) {
  const dt = Math.min((now - prev) / 1000, .1); prev = now;
  St.wall = now / 1000;
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

  step(St.ff ? dt : dt);
  render();

  if (Object.keys(F.state.rooms).length !== roomCount) {
    roomCount = Object.keys(F.state.rooms).length;
    if (!St.focus && !St.userMoved) fitAll();
  }

  Chat.sync(St.people, (x, y) => {
    const s = iso(x, y), Wp = cv.clientWidth, Hp = cv.clientHeight;
    const sx = (s.x - St.cam.x) * St.cam.z + Wp / 2, sy = (s.y - St.cam.y) * St.cam.z + Hp / 2;
    return { x: sx, y: sy, off: sx < -160 || sx > Wp + 160 || sy < -80 || sy > Hp + 80 };
  }, St.wall, p => (!St.focus || St.focus === p.room) && roomHit(p.room) && !St.ff,
     St.cam.z > .42);

  let act = 0, team = 0;
  for (const k in St.people) {
    const p = St.people[k];
    if (St.clock - p.last < IDLE) { act++; if (!p.boss) team++; }
  }
  el('nactive').textContent = act;
  el('nteam').textContent = Object.keys(F.state.rooms).length;
  el('nsub').textContent = team;
  el('dot').classList.toggle('on', act > 0);
  const emptyEl = el('empty');
  emptyEl.style.display = roomCount ? 'none' : 'grid';
  if (!roomCount) {
    const h = St.health;
    emptyEl.className = 'empty' + (h && h.code === 'unreadable_format' ? ' bad' : '');
    emptyEl.textContent = h && !h.ok ? h.message
      : 'no sessions in the window — start a Claude session and watch';
  }
  el('clock').textContent = hhmmss(St.clock);
  el('ff').classList.toggle('on', St.ff);
  if (St.t1 > St.t0 && !dragging)
    el('scrub').value = Math.round((St.clock - St.t0) / (St.t1 - St.t0) * 1000);
  if (St.focus) { paintPanel(St.focus); Chat.renderLog(St.focus, hhmmss); }
  requestAnimationFrame(frame);
}

const esc = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
function paintPanel(r) {
  const s = St.sessions[r.sid] || {};
  const mine = Object.values(St.people).filter(p => p.room === r);
  const boss = mine.find(p => p.boss), team = mine.filter(p => !p.boss);
  el('pname').textContent = r.proj + ' · ' + r.sid.slice(0, 8);
  el('pmeta').textContent = `${team.length} teammate${team.length === 1 ? '' : 's'} on the floor` +
    (s.branch ? ' · ⎇ ' + s.branch : '');
  const row = (p, kid) => {
    const idle = St.clock - p.last > IDLE;
    return `<div class="row ${kid ? 'kid' : 'boss'}${idle ? ' off' : ''}">
      <span class="sw" style="background:hsl(${p.hue} 62% 52%)"></span>
      <div class="rt"><b>${kid ? esc(personName(p)) : '★ ' + esc(personName(p))}</b>
        <span>${esc(kid ? (p.name || '') : (p.aid || p.sid))}</span>
        <i>${esc(p.saying || (idle ? 'idle' : p.state))}</i></div></div>`;
  };
  el('plist').innerHTML =
    (boss ? row(boss, false) : `<div class="row boss off"><div class="rt"><b>BOSS · ${esc(r.sid.slice(0, 8))}</b><span>${esc(s.title || '')}</span><i>away</i></div></div>`) +
    (team.map(p => row(p, true)).join('') ||
      '<div class="row kid off"><div class="rt"><b>no teammates</b><span>this boss works alone right now</span></div></div>');
}

/* ------------------------------------------------------------ controls --- */
function resize() {
  St.dpr = Math.min(devicePixelRatio || 1, 2);
  cv.width = cv.clientWidth * St.dpr; cv.height = cv.clientHeight * St.dpr;
  St.focus ? frameTo([St.focus], .86, 1.5) : fitAll();
}
addEventListener('resize', resize);

function pick(mx, my) {
  const Wp = cv.clientWidth, Hp = cv.clientHeight;
  const wx = (mx - Wp / 2) / St.cam.z + St.cam.x, wy = (my - Hp / 2) / St.cam.z + St.cam.y;
  const ty = (wy / (TH / 2) - wx / (TW / 2)) / 2, tx = wy / (TH / 2) - ty;
  for (const r of Object.values(F.state.rooms))
    if (tx >= r.gx && tx <= r.gx + F.ROOM_W && ty >= r.gy && ty <= r.gy + F.ROOM_H) return r;
  return null;
}
function toScreen(x, y) {
  const s = iso(x, y);
  return { x: (s.x - St.cam.x) * St.cam.z + cv.clientWidth / 2,
           y: (s.y - St.cam.y) * St.cam.z + cv.clientHeight / 2 };
}

function hitPerson(mx, my) {
  let best = null, bestZ = -1e9;
  for (const k in St.people) {
    const p = St.people[k];
    if ((St.focus && St.focus !== p.room) || !roomHit(p.room)) continue;
    const s = toScreen(p.x, p.y), z = St.cam.z;
    const hw = Math.max(13, 20 * z), ht = Math.max(32, 54 * z), hb = Math.max(9, 12 * z);
    if (mx < s.x - hw || mx > s.x + hw || my < s.y - ht || my > s.y + hb) continue;
    if (p.x + p.y > bestZ) { bestZ = p.x + p.y; best = p; }
  }
  return best;
}

const ago = t => {
  const d = Math.max(0, St.clock - t);
  return d < 60 ? Math.round(d) + 's ago'
       : d < 3600 ? Math.round(d / 60) + 'm ago' : (d / 3600).toFixed(1) + 'h ago';
};
const row = (k, v) => v ? `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>` : '';

function tipFor(p, r) {
  if (p) {
    const s = St.sessions[p.sid] || {};
    const seat = p.boss ? 'boss desk' : (p.room.claims[p.aid] !== undefined ? 'desk #' + (p.room.claims[p.aid] + 1) : 'hot desk');
    return `<div class="tk">${p.boss ? 'Boss · this session' : 'Teammate · subagent'}</div>
      <h3>${esc(p.boss ? clean(s.title) || 'untitled session' : (p.display || personName(p)))}</h3>
      <dl>
        ${p.boss ? '' : row('task', p.name)}
        ${row(p.boss ? 'session' : 'agent id', p.boss ? p.sid : p.aid)}
        ${p.boss ? '' : row('reports to', (s.title ? shortLabel(s.title, 26) + ' · ' : '') + p.sid.slice(0, 8))}
        ${row('department', p.room.proj)}
        ${row('branch', s.branch)}
        ${row('model', p.model)}
        ${row('seat', seat)}
        ${row('doing', p.state === 'type' ? 'at their desk' : p.state === 'walk' ? 'walking over'
             : p.state === 'think' ? 'on a break' : p.state === 'file' ? 'at the cabinet'
             : p.state === 'meet' ? 'with the boss' : p.state)}
        ${row('last active', ago(p.last))}
      </dl>
      ${p.saying ? `<div class="now">${esc(p.saying)}</div>` : ''}`;
  }
  const s = St.sessions[r.sid] || {};
  const here = Object.values(St.people).filter(q => q.room === r);
  return `<div class="tk">Team room</div>
    <h3>${esc(clean(s.title) || 'untitled session')}</h3>
    <dl>
      ${row('session', r.sid)}
      ${row('department', r.proj)}
      ${row('branch', s.branch)}
      ${row('folder', s.cwd)}
      ${row('teammates', (s.agents || []).length + ' all-time · ' + here.filter(q => !q.boss).length + ' here now')}
      ${row('desks', Object.keys(r.claims).length + ' claimed of ' + r.desks.length)}
      ${row('last activity', r.lastT ? ago(r.lastT) : '—')}
    </dl>`;
}

function showTip(mx, my) {
  const tip = el('tip');
  if (panning) { tip.classList.remove('on'); return; }
  const p = hitPerson(mx, my);
  const r = p ? null : pick(mx, my);
  if (!p && !r) { tip.classList.remove('on'); cv.style.cursor = 'default'; return; }
  cv.style.cursor = 'pointer';
  const key = p ? p.key : 'room:' + r.sid;
  if (tip.dataset.key !== key) { tip.dataset.key = key; tip.innerHTML = tipFor(p, r); }
  tip.classList.add('on');
}
cv.addEventListener('mousemove', e => showTip(e.offsetX, e.offsetY));
cv.addEventListener('mouseleave', () => el('tip').classList.remove('on'));

cv.addEventListener('mousedown', e => { panning = { x: e.clientX, y: e.clientY, moved: 0 }; el('tip').classList.remove('on'); });
addEventListener('mousemove', e => {
  if (!panning) return;
  const dx = e.clientX - panning.x, dy = e.clientY - panning.y;
  panning.moved += Math.abs(dx) + Math.abs(dy);
  if (panning.moved > 6) St.userMoved = true;
  St.cam.tx -= dx / St.cam.z; St.cam.ty -= dy / St.cam.z;
  St.cam.x = St.cam.tx; St.cam.y = St.cam.ty;
  panning.x = e.clientX; panning.y = e.clientY;
});
addEventListener('mouseup', e => {
  const p = panning; panning = null;
  if (!p || p.moved > 6) return;
  const r = pick(e.offsetX ?? 0, e.offsetY ?? 0);
  focusRoom(r && r !== St.focus ? r : null);
});
cv.addEventListener('wheel', e => {
  e.preventDefault(); St.userMoved = true;
  St.cam.tz = Math.max(.08, Math.min(2.2, St.cam.tz * (e.deltaY > 0 ? .9 : 1.11)));
}, { passive: false });
addEventListener('keydown', e => {
  if (e.key === 'Escape') { el('q').blur(); focusRoom(null); }
  if (e.key === '/' && document.activeElement !== el('q')) { e.preventDefault(); el('q').focus(); }
});

el('q').addEventListener('input', ev => {
  St.q = ev.target.value.trim().toLowerCase();
  const hits = Object.values(F.state.rooms).filter(roomHit);
  el('hits').textContent = St.q ? hits.length + ' hit' + (hits.length === 1 ? '' : 's') : '';
  if (St.q && hits.length) frameTo(hits, .86, 1.4);
  else if (!St.q && !St.focus) fitAll();
});
el('q').addEventListener('keydown', ev => {
  if (ev.key !== 'Enter') return;
  const hits = Object.values(F.state.rooms).filter(roomHit);
  if (hits.length) focusRoom(hits[0]);
});
el('close').addEventListener('click', () => focusRoom(null));
el('fit').addEventListener('click', () => {
  St.q = ''; el('q').value = ''; el('hits').textContent = ''; St.userMoved = false; focusRoom(null);
});
el('scrub').addEventListener('input', ev => {
  dragging = true; St.live = false; el('live').classList.remove('on');
  const to = St.t0 + (St.t1 - St.t0) * (ev.target.value / 1000);
  if (to < St.clock) rebuild(to);
  St.clock = to;
});
el('scrub').addEventListener('change', () => { dragging = false; });
el('play').addEventListener('click', () => {
  St.playing = !St.playing; St.live = false;
  el('live').classList.remove('on');
  el('play').textContent = St.playing ? '⏸' : '▶';
});
el('live').addEventListener('click', () => {
  St.live = St.playing = true;
  el('play').textContent = '⏸'; el('live').classList.add('on');
  rebuild(Date.now() / 1000);
});
el('speed').addEventListener('click', () => {
  St.si = (St.si + 1) % SPEEDS.length;
  el('speed').textContent = SPEEDS[St.si] + '×';
});
el('speed').textContent = SPEEDS[St.si] + '×';

(async () => {
  Chat.init(el('bubbles'), el('chatlog'), el('jump'));
  resize();
  await poll();
  rebuild(Date.now() / 1000);
  St.clock = St.t1;
  setInterval(poll, 2000);
  requestAnimationFrame(frame);
})();
