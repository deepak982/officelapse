/* office.js — the isometric view: painting, the camera, input and the frame loop.
   Since view3d landed this is the FALLBACK view, not the default one — see the
   #stage.three note above frame(), which is what stops it painting under the 3D view.
   The world it draws lives in sim.js; geometry and routing in floor.js; speech in
   chat.js. Everything below this header is pixels — if it does not draw, position
   or listen, it belongs in sim.js. */
'use strict';

const TW = 64, TH = 32;

const F = window.Floor, Chat = window.Chat, Sim = window.Sim;
if (!F || !Chat || !Sim)
  throw new Error('office.js needs floor.js, chat.js and sim.js loaded before it');
const { N, E, S, W } = F;
const { St, SPEEDS, IDLE, FF_ABOVE } = Sim;
const { roomHit, roomName, personName, personText, shortLabel, clean, deptHue } = Sim;

/* the sim speaks through these; wiring them is the view's job.
   The last argument is "show a bubble": suppressed above 10x replay, where nobody
   could read one anyway, and chat.js logs the line regardless. Bubbles are DOM over
   the canvas and belong to whichever view is up — the 3D loop drives Chat.sync with
   a projector built from its own camera, exactly as this one does below. */
Sim.hooks.say = (p, text, isTask, simNow) =>
  Chat.say(p, text, isTask, St.wall, simNow, !St.ff);
Sim.hooks.reset = () => Chat.clear();

const cv = document.getElementById('cv'), cx = cv.getContext('2d');
const el = id => document.getElementById(id);
const lerp = (a, b, t) => a + (b - a) * t;
const iso = (x, y) => ({ x: (x - y) * TW / 2, y: (x + y) * TH / 2 });
/* tile inside a facility. p.room is a team room even for someone standing in the
   cafeteria, so nothing about the band can be answered from the room. */
const inAm = (a, x, y) => x >= a.gx && x < a.gx + a.w && y >= a.gy && y < a.gy + a.h;

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

/* state: 0 empty, 1 occupied, 2 active. Three, not a boolean, because a person sits
   at their desk until GONE (900s) while activity only lasts IDLE (90s) — a binary
   monitor leaves someone sitting at a dead screen for 810 of those seconds, which
   reads as broken. Occupied is a muted slate, active the bright cyan plus the bloom;
   the hue difference is what separates them at a glance, not the value. Matches the
   3D view's rule exactly, and test_view3d.mjs X7 pins the two together. */
function drawDesk(d, state, big) {
  const on = state === 2;
  const w = big ? 1.7 : .98, dp = .76;
  box(d.x + .02, d.y + .1, w, dp, 13, '#3b4259', '#242a3b', '#2f3549');
  // monitor sits on the far side of the desk, so the occupant faces it
  const m = { x: d.x + w / 2 - .22, y: d.y + .14 };
  box(m.x, m.y, .46, .08, on ? 17 : 15,
      on ? '#8bd9fb' : state === 1 ? '#4f6780' : '#1c2130',
      on ? '#3d7fa0' : state === 1 ? '#2b3949' : '#141824',
      on ? '#5aa8cc' : state === 1 ? '#3b4d60' : '#191e2c');
  if (on) {
    const g0 = iso(m.x + .23, m.y);
    const g = cx.createRadialGradient(g0.x, g0.y - 16, 2, g0.x, g0.y - 16, 44);
    g.addColorStop(0, 'rgba(125,211,252,.22)'); g.addColorStop(1, 'rgba(125,211,252,0)');
    cx.fillStyle = g; cx.beginPath(); cx.arc(g0.x, g0.y - 16, 44, 0, 7); cx.fill();
  }
}

/* Props that run along a wall arrive either 1xN or Nx1 — a sink down the west wall,
   a planter wall, a bank of lockers. One screen point per cell, along the long axis,
   so the detail repeats with the run instead of once per prop. */
function runCells(pr) {
  const w = pr.w || 1, h = pr.h || 1, horiz = w >= h, out = [];
  for (let i = 0, n = Math.max(1, Math.round(Math.max(w, h))); i < n; i++)
    out.push(iso(pr.x + (horiz ? i + .5 : w / 2), pr.y + (horiz ? h / 2 : i + .5)));
  return out;
}

const noCase = new Set();               // one warning per unknown type, not per frame

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
    case 'counter':
      // one slab and a raised lip: the old second box was wider AND taller than the
      // first, so it hid it completely and cost a draw for nothing
      box(pr.x + .04, pr.y + .1, pr.w - .08, .78, 25, '#6d6250', '#3a342a', '#4b4335');
      box(pr.x + .04, pr.y + .76, pr.w - .08, .12, 27, '#7e7261', '#443d31', '#57503f');
      break;
    case 'coffee':
      box(pr.x + .2, pr.y + .22, .6, .56, 30, '#3b4257', '#20242f', '#2b3040');
      box(pr.x + .3, pr.y + .3, .4, .2, 34, '#1b1f29', '#12151c', '#161a22');
      break;
    case 'vending': {
      box(pr.x + .12, pr.y + .18, .76, .64, 46, '#3a4560', '#1f2531', '#2a3243');
      const v = iso(pr.x + .5, pr.y + .5);
      cx.fillStyle = 'rgba(160,220,255,.5)';
      cx.fillRect(v.x - 9, v.y - 44, 18, 22);      // sat 3px above the silhouette at -50
      cx.fillStyle = '#e8b04b';
      for (let i = 0; i < 3; i++) cx.fillRect(v.x - 6, v.y - 41 + i * 7, 12, 4);
      break;
    }
    case 'stall':                         // a cubicle: walls you can see over
      box(pr.x + .06, pr.y + .06, pr.w - .12, pr.h - .12, 30, '#46506b', '#252b3a', '#323a4e');
      box(pr.x + .12, pr.y + pr.h - .28, pr.w - .24, .2, 34, '#5a6688', '#2c3345', '#3d4660');
      break;
    case 'sink':                          // the run is 1xN down a wall as often as Nx1,
                                          // and the old loop over pr.w drew one basin for four
      box(pr.x + .08, pr.y + .08, pr.w - .16, pr.h - .16, 20, '#49526c', '#262c3b', '#333a4e');
      cx.fillStyle = '#c8d2e4';
      for (const c of runCells(pr)) {
        cx.beginPath(); cx.ellipse(c.x, c.y - 20, 8, 4.5, 0, 0, 7); cx.fill();
      }
      break;
    case 'booth': {                       // phone booth: glass, so it reads as a box you sit in
      box(pr.x + .12, pr.y + .1, pr.w - .24, pr.h - .2, 52, 'rgba(120,165,205,.34)',
          'rgba(40,60,85,.55)', 'rgba(70,100,135,.45)');
      const bo = iso(pr.x + pr.w / 2, pr.y + pr.h / 2);   // booths are 2x2 now, not 1xN
      cx.strokeStyle = 'rgba(190,225,255,.5)'; cx.lineWidth = 1;
      cx.strokeRect(bo.x - 11, bo.y - 56, 22, 42);
      break;
    }
    case 'art': {                         // framed picture, hung on the wall behind it
      // nine, because floor.js hands out art 0..8 and a 5-entry palette repeated
      const ART = [['#e07a5f', '#3d405b'], ['#81b29a', '#2b3a55'], ['#e8b04b', '#5b3a52'],
                   ['#6b9fd4', '#33405e'], ['#c76b8e', '#3a3350'], ['#5fbfae', '#24404a'],
                   ['#b0a05f', '#3a3a2c'], ['#8f7fd4', '#2e2c4e'], ['#d4785f', '#4a2f2c']];
      const pal = ART[(pr.art || 0) % ART.length];
      const a0 = iso(pr.x + .5, pr.y + .5);
      cx.fillStyle = '#20242f'; cx.fillRect(a0.x - 13, a0.y - 44, 26, 20);
      cx.fillStyle = pal[0]; cx.fillRect(a0.x - 11, a0.y - 42, 22, 16);
      cx.fillStyle = pal[1];
      cx.beginPath(); cx.moveTo(a0.x - 11, a0.y - 26); cx.lineTo(a0.x + 1, a0.y - 36);
      cx.lineTo(a0.x + 11, a0.y - 26); cx.closePath(); cx.fill();
      break;
    }
    case 'logo': {
      const l0 = iso(pr.x + .5, pr.y + .5);
      cx.font = '700 11px ui-monospace,Menlo,monospace'; cx.textAlign = 'center';
      cx.fillStyle = '#9fd3f0';
      cx.fillText('OFFICELAPSE', l0.x, l0.y - 32);
      break;
    }
    case 'menu': {
      const m0 = iso(pr.x + .5, pr.y + .5);
      cx.fillStyle = '#1b2029'; cx.fillRect(m0.x - 14, m0.y - 44, 28, 20);
      cx.fillStyle = '#7fb59a';
      for (let i = 0; i < 4; i++) cx.fillRect(m0.x - 11, m0.y - 40 + i * 4, 14 - i * 2, 2);
      break;
    }
    case 'mirror': {
      const r0 = iso(pr.x + .5, pr.y + .5);
      cx.fillStyle = 'rgba(200,225,250,.28)'; cx.fillRect(r0.x - 12, r0.y - 42, 24, 18);
      cx.strokeStyle = 'rgba(210,235,255,.5)'; cx.lineWidth = 1;
      cx.strokeRect(r0.x - 12, r0.y - 42, 24, 18);
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
    case 'planter': {                     // a trough, not a pot: it runs a whole wall
      box(pr.x + .1, pr.y + .1, pr.w - .2, pr.h - .2, 9, '#4b4336', '#2a251c', '#393227');
      const cells = runCells(pr);
      cells.forEach((c, i) => {
        cx.fillStyle = i % 2 ? '#3f7d4f' : '#4a8c58';
        cx.beginPath(); cx.ellipse(c.x, c.y - 13, 10, 6, 0, 0, 7); cx.fill();
      });
      break;
    }
    case 'roundtable': {                  // huddle pod: a round top on a pedestal
      const rt = iso(pr.x + pr.w / 2, pr.y + pr.h / 2);
      box(pr.x + pr.w / 2 - .17, pr.y + pr.h / 2 - .17, .34, .34, 12,
          '#3a3350', '#221d31', '#2c2640');
      cx.fillStyle = '#473e60';
      cx.beginPath(); cx.ellipse(rt.x, rt.y - 12, pr.w * 25, pr.h * 12.5, 0, 0, 7); cx.fill();
      cx.strokeStyle = '#272235'; cx.lineWidth = 1; cx.stroke();
      break;
    }
    case 'longtable':                     // boardroom slab: heavier than a meeting table
      box(pr.x + .06, pr.y + .12, pr.w - .12, pr.h - .24, 14, '#463b2e', '#281f18', '#372c22');
      box(pr.x + .3, pr.y + pr.h / 2 - .1, pr.w - .6, .2, 15, '#5a4c3a', '#31281f', '#42372a');
      break;
    case 'chair':
      // A chair is sat ON, and it does not block — so it stays low and open, or a
      // person renders standing inside their own seat. No facing arrives with it.
      box(pr.x + .3, pr.y + .3, .4, .4, 6, '#2f3547', '#1d2230', '#252b3a');
      break;
    case 'rack': {                        // server rack: tall, dark, covered in LEDs
      box(pr.x + .16, pr.y + .1, pr.w - .32, pr.h - .2, 54, '#242935', '#14171f', '#1b1f29');
      const rk = iso(pr.x + pr.w / 2, pr.y + pr.h / 2);
      for (let i = 0; i < 10; i++) {                 // by position, so racks differ
        cx.fillStyle = (pr.x + pr.y + i) % 3 ? '#4fd08a' : '#e8b04b';
        cx.fillRect(rk.x - 7 + (i % 2) * 9, rk.y - 48 + ((i / 2) | 0) * 7, 5, 2.5);
      }
      break;
    }
    case 'screen': {                      // wall-mounted only: projector, or glazing
      const sc = iso(pr.x + .5, pr.y + .5);
      cx.fillStyle = 'rgba(18,22,30,.9)'; cx.fillRect(sc.x - 15, sc.y - 46, 30, 22);
      cx.fillStyle = 'rgba(140,200,235,.2)'; cx.fillRect(sc.x - 13, sc.y - 44, 26, 18);
      cx.strokeStyle = 'rgba(150,195,230,.45)'; cx.lineWidth = 1;
      cx.strokeRect(sc.x - 15, sc.y - 46, 30, 22);
      break;
    }
    case 'whiteboard': {                  // wall-mounted: the board, no stand ('board' has one)
      const wb = iso(pr.x + .5, pr.y + .5);
      cx.fillStyle = '#20242f'; cx.fillRect(wb.x - 16, wb.y - 46, 32, 24);
      cx.fillStyle = '#e8edf5'; cx.fillRect(wb.x - 14, wb.y - 44, 28, 20);
      cx.fillStyle = '#9aa4b8';
      for (let i = 0; i < 3; i++) cx.fillRect(wb.x - 10, wb.y - 39 + i * 6, 18 - i * 5, 2);
      break;
    }
    case 'locker':
      box(pr.x + .12, pr.y + .14, pr.w - .24, pr.h - .28, 44, '#3d4659', '#20252f', '#2c3240');
      for (const c of runCells(pr)) {
        cx.strokeStyle = '#59637d'; cx.lineWidth = 1;
        cx.strokeRect(c.x - 8, c.y - 40, 16, 28);
        cx.fillStyle = '#8a93a8'; cx.fillRect(c.x + 4, c.y - 28, 2.5, 2.5);
      }
      break;
    case 'bin': {                         // recycling, lidded
      box(pr.x + .32, pr.y + .32, .36, .36, 15, '#2f4a3c', '#1a2a22', '#22382d');
      const bn = iso(pr.x + .5, pr.y + .5);
      cx.fillStyle = '#4b7a61';
      cx.beginPath(); cx.ellipse(bn.x, bn.y - 15, 10, 5, 0, 0, 7); cx.fill();
      break;
    }
    default:
      // A missing case used to be an invisible prop over a blocked tile — people
      // walking around nothing. Draw it hot pink and say so once.
      if (!noCase.has(pr.type)) {
        noCase.add(pr.type);
        console.warn('drawProp: no case for prop type', pr.type);
      }
      box(pr.x + .2, pr.y + .2, (pr.w || 1) - .4, (pr.h || 1) - .4, 16,
          'rgba(255,60,200,.55)', 'rgba(150,20,110,.55)', 'rgba(205,40,160,.55)');
      cx.font = '700 8px ui-monospace,Menlo,monospace'; cx.textAlign = 'center';
      cx.fillStyle = '#ff7ad8';
      cx.fillText(String(pr.type || '?'), iso(pr.x + .5, pr.y + .5).x,
                  iso(pr.x + .5, pr.y + .5).y - 22);
  }
}

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
  cx.fillText((p.boss ? '★ ' : '') + (p.display || personName(p)), bx, by + 17);
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
  // all-time, not who is in there now — the header's "teammates" counts the living
  const label = roomName(r) + (s.agents && s.agents.length ? '  ×' + s.agents.length + ' all-time' : '');
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

/* A facility is not a department, so a department hue would be a lie — and a
   cafeteria that looks like a washroom is the whole problem. Warm where people eat
   and rest, cool and desaturated where they work or the machines live. */
const AM_TINT = {
  reception:   { h: 208, s: 26 },     // corporate blue
  cafeteria:   { h: 28,  s: 40 },     // warm amber
  washrooms:   { h: 190, s: 22 },     // pale tile cyan
  lounge:      { h: 268, s: 24 },     // muted violet
  boardroom:   { h: 6,   s: 26 },     // oxblood
  huddle:      { h: 96,  s: 26 },     // green
  phonebooths: { h: 168, s: 24 },     // teal
  printbay:    { h: 44,  s: 22 },     // manila
  wellness:    { h: 146, s: 28 },     // sage
  serverroom:  { h: 222, s: 16 },     // cold steel
  coworking:   { h: 322, s: 22 },     // magenta-grey
};
/* an unknown kind is a plain grey box, never a crash: floor.js may add a twelfth */
const amTint = a => AM_TINT[a.kind] || { h: 220, s: 8 };

/* A facility is never the focus and has no session to match a query against, so it
   dims behind a focused room and behind a search it does not answer by name. */
const amDim = a => !!St.focus ||
  (!!St.q && !a.label.toLowerCase().includes(St.q) && !a.kind.includes(St.q));

/* Same bones as drawRoomShell, but the door is on the SOUTH wall and every facility
   is a different width, so nothing here may read a shared AM_W. */
function drawAmenity(a, dim, busy) {
  const t = amTint(a);
  cx.globalAlpha = dim ? .1 : 1;

  for (let x = 1; x < a.w - 1; x++) for (let y = 1; y < a.h - 1; y++)
    tile(a.gx + x, a.gy + y, shade(t.h, t.s * .5, 20 + ((x + y) % 2 ? 1.8 : 0)),
         'rgba(255,255,255,.025)');
  if (a.door) tile(a.door.x, a.door.y, shade(t.h, t.s * .5, 23));   // the opening itself

  // north and west walls full height, matching a team room. The south wall is only a
  // sill: it is the wall the door is in, and a full one would hide the whole room.
  for (let x = 0; x < a.w; x++)
    box(a.gx + x, a.gy, 1, .16, 26, shade(t.h, t.s, 31), shade(t.h, t.s, 22), shade(t.h, t.s, 27));
  for (let y = 0; y < a.h; y++)
    box(a.gx, a.gy + y, .16, 1, 26, shade(t.h, t.s, 31), shade(t.h, t.s, 25), shade(t.h, t.s, 20));
  const sy = a.gy + a.h - .16;
  for (let x = 0; x < a.w; x++) {
    if (a.door && a.gx + x === a.door.x) continue;
    box(a.gx + x, sy, 1, .16, 7, shade(t.h, t.s, 28), shade(t.h, t.s, 20), shade(t.h, t.s, 24));
  }
  if (a.door) {                             // posts either side, so the doorway reads
    const f = [shade(t.h, t.s + 24, 47), shade(t.h, t.s + 24, 35), shade(t.h, t.s + 24, 41)];
    box(a.door.x - .06, sy, .12, .16, 14, f[0], f[1], f[2]);
    box(a.door.x + .94, sy, .12, .16, 14, f[0], f[1], f[2]);
  }

  const n = iso(a.gx + a.w / 2, a.gy - 1.2);
  cx.font = '600 12px ui-monospace,Menlo,monospace'; cx.textAlign = 'center';
  const w = cx.measureText(a.label).width + 22;
  cx.fillStyle = 'rgba(8,10,16,.92)';
  cx.beginPath(); cx.roundRect(n.x - w / 2, n.y - 30, w, 21, 5); cx.fill();
  cx.strokeStyle = busy ? shade(t.h, 62, 56) : '#2c3242'; cx.lineWidth = 1.1; cx.stroke();
  cx.fillStyle = busy ? shade(t.h, 74, 72) : shade(t.h, 24, 56);
  cx.fillText(a.label, n.x, n.y - 15);
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

/* a room's screen box, computed once — rooms never move */
function isoBox(r) {
  if (r._bb) return r._bb;
  const c = [iso(r.gx, r.gy), iso(r.gx + r.w, r.gy),
             iso(r.gx, r.gy + r.h), iso(r.gx + r.w, r.gy + r.h)];
  const xs = c.map(p => p.x), ys = c.map(p => p.y);
  return (r._bb = { x0: Math.min(...xs) - 48, x1: Math.max(...xs) + 48,
                    y0: Math.min(...ys) - 96, y1: Math.max(...ys) + 48 });
}

function render() {
  const Wp = cv.clientWidth, Hp = cv.clientHeight;
  cx.setTransform(St.dpr, 0, 0, St.dpr, 0, 0);
  cx.fillStyle = '#0b0d13'; cx.fillRect(0, 0, Wp, Hp);
  cx.save();
  cx.translate(Wp / 2, Hp / 2); cx.scale(St.cam.z, St.cam.z); cx.translate(-St.cam.x, -St.cam.y);

  drawDepartments();

  // Only what the camera can see. Stepping into one room used to cost a full
  // build and rasterise of every other room on the floor, at alpha .1.
  const hx = Wp / 2 / St.cam.z, hy = Hp / 2 / St.cam.z;
  const x0 = St.cam.x - hx, x1 = St.cam.x + hx, y0 = St.cam.y - hy, y1 = St.cam.y + hy;
  const rooms = Object.values(F.state.rooms).filter(r => {
    const b = isoBox(r);
    return b.x1 > x0 && b.x0 < x1 && b.y1 > y0 && b.y0 < y1;
  });
  // the band culls the same way: a facility is a static box that never moves, so the
  // cached bbox applies to it unchanged
  const ams = (F.state.amenities || []).filter(a => {
    const b = isoBox(a);
    return b.x1 > x0 && b.x0 < x1 && b.y1 > y0 && b.y0 < y1;
  });
  const shown = new Set(rooms), shownAm = new Set(ams);
  const vis = r => !((St.focus && St.focus !== r) || !roomHit(r));

  // Who is standing in the band, once per frame: the band's own culling and its
  // name-plate highlight both need it, and p.room cannot answer it.
  const inBand = new Map();
  for (const k in St.people) {
    const p = St.people[k], fa = p.fac || p.cowork;
    if (fa && inAm(fa, p.x, p.y)) inBand.set(p, fa);
  }
  const busyFac = new Set(inBand.values());

  // One depth-sorted pass over both: the band sits above the corridor but its east
  // end still interleaves in screen depth with the west end of the first department.
  for (const s of ams.concat(rooms).sort((a, b) => (a.gx + a.gy) - (b.gx + b.gy)))
    s.kind ? drawAmenity(s, amDim(s), busyFac.has(s)) : drawRoomShell(s, !vis(s));

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
    // 0 empty, 1 the owner is logged on, 2 the owner was active within IDLE
    const on = d => { const p = occupant(d); return !p ? 0 : (St.clock - p.last < IDLE ? 2 : 1); };
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
  for (const a of ams) {
    const dim = amDim(a);
    for (const pr of a.props) if (pr.type !== 'pod' && pr.type !== 'bossdesk')
      draws.push({ z: pr.x + pr.y, f: () => { cx.globalAlpha = dim ? .1 : 1; drawProp(pr); } });
    // Hot desks only, and only on coworking. d.by here is the full sid|aid person key,
    // not a bare agent id — the band is shared by every session at once. Prefixing
    // a.sid + '|' the way the room pass does gives a key that can never match, and
    // no monitor in the band would ever light up (EDGE_CASES H1, one layer up).
    for (const d of a.desks || []) {
      const who = d.by ? St.people[d.by] : null;
      const on = !who ? 0 : (St.clock - who.last < IDLE ? 2 : 1);
      draws.push({ z: d.x + d.y, f: () => { cx.globalAlpha = dim ? .1 : 1; drawDesk(d, on, false); } });
    }
  }
  for (const k in St.people) {
    const p = St.people[k];
    const fa = inBand.get(p);
    if (fa ? !shownAm.has(fa) : !shown.has(p.room)) continue;
    // dimmed by their OWN room either way: a teammate of the focused session stays lit
    // while they are up at the cafeteria, which is the point of watching them go
    const dim = !vis(p.room);
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
    // r.w/r.h, not ROOM_W/ROOM_H: facilities are each a different size
    const X0 = r.gx - 2, X1 = r.gx + r.w + 2, Y0 = r.gy - 3, Y1 = r.gy + r.h + 2;
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
/* The band belongs in the default frame or it sits off-screen above the corridor.
   AM_BAND is derived at module load, so it is right before a facility object exists —
   but the band is only built by the first ensureRoom(), so with no rooms there is
   nothing up there to frame either. */
const BAND = F.AM_BAND && { gx: F.AM_BAND.x, gy: F.AM_BAND.y, w: F.AM_BAND.w, h: F.AM_BAND.h };
const fitAll = () => frameTo(Object.values(F.state.rooms)
  .concat(BAND && (F.state.amenities || []).length ? [BAND] : []), .92, 1.0);

function focusRoom(r) {
  St.focus = r;
  if (!r) { el('panel').classList.remove('open'); Chat.renderLog(null); fitAll(); return; }
  el('panel').classList.add('open');
  frameTo([r], .86, 1.5);
}

/* ---------------------------------------------------------------- loop --- */
/* index.html layers the 3D canvas over this one and marks #stage.three, and that is
   the normal path now: the 2D canvas is what a machine with no usable WebGL falls back
   to. While the 3D view is up every pixel this file paints is hidden — render() was
   building and sorting ~1,250 draws and issuing ~27,000 canvas operations a frame for
   nobody. So the drawing and the bubble layout stop, and nothing else does: the sim,
   the header, the clock, the scrubber, the empty-state banner, the side panel and the
   room chat log all keep running, because the 3D view shows all of them. Bubbles go
   the same way fast-forward takes them — hidden, still logged.

   is3D is the only new top-level name: this is a classic script, so every binding up
   here is a global shared with the other classic scripts. */
let is3D = el('stage').classList.contains('three');
new MutationObserver(() => {
  const now3D = el('stage').classList.contains('three');
  if (now3D === is3D) return;
  is3D = now3D;
  // Paint immediately on the way back: this canvas sits UNDER the 3D one and still
  // holds whatever it last drew, which by then is minutes of world old. An observer
  // callback runs before the browser paints, so that stale frame is never shown.
  if (!is3D) render();
}).observe(el('stage'), { attributes: true, attributeFilter: ['class'] });

let prev = performance.now(), dragging = false, panning = null, roomCount = 0;
const hhmmss = t => new Date(t * 1000).toLocaleTimeString();

function frame(now) {
  const dt = Math.min((now - prev) / 1000, .1); prev = now;
  St.wall = now / 1000;

  Sim.advance(dt);

  // the camera is the one thing that moves without the sim: it chases its target
  // in real time, so it stays smooth while the world is paused or scrubbing
  const c = St.cam, k = 1 - Math.exp(-6 * dt);
  c.x = lerp(c.x, c.tx, k); c.y = lerp(c.y, c.ty, k); c.z = lerp(c.z, c.tz, k);

  if (!is3D) render();

  if (Object.keys(F.state.rooms).length !== roomCount) {
    roomCount = Object.keys(F.state.rooms).length;
    if (!St.focus && !St.userMoved) fitAll();
  }

  if (!is3D) Chat.sync(St.people, (x, y) => {
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
      <div class="rt"><b>${kid ? '' : '★ '}${esc(p.display || personName(p))}</b>
        <span>${esc(kid ? (p.name || '') : (p.aid || p.sid))}</span>
        <i>${esc(p.saying || (idle ? 'idle' : p.state))}</i></div></div>`;
  };
  const html =
    (boss ? row(boss, false) : `<div class="row boss off"><div class="rt"><b>BOSS · ${esc(r.sid.slice(0, 8))}</b><span>${esc(s.title || '')}</span><i>away</i></div></div>`) +
    (team.map(p => row(p, true)).join('') ||
      '<div class="row kid off"><div class="rt"><b>no teammates</b><span>this boss works alone right now</span></div></div>');
  // building the string is cheap; reparsing it 60x a second is not, and it kills
  // text selection in the panel while you are trying to read it
  if (html !== panelHtml) { el('plist').innerHTML = panelHtml = html; }
}
let panelHtml = '';

/* ------------------------------------------------------------ controls --- */
function resize() {
  St.dpr = Math.min(devicePixelRatio || 1, 2);
  cv.width = cv.clientWidth * St.dpr; cv.height = cv.clientHeight * St.dpr;
  St.focus ? frameTo([St.focus], .86, 1.5) : fitAll();
}
addEventListener('resize', resize);

function tileAt(mx, my) {
  const Wp = cv.clientWidth, Hp = cv.clientHeight;
  const wx = (mx - Wp / 2) / St.cam.z + St.cam.x, wy = (my - Hp / 2) / St.cam.z + St.cam.y;
  const y = (wy / (TH / 2) - wx / (TW / 2)) / 2;
  return { x: wy / (TH / 2) - y, y };
}
function pick(mx, my) {
  const t = tileAt(mx, my);
  for (const r of Object.values(F.state.rooms))
    if (t.x >= r.gx && t.x <= r.gx + r.w && t.y >= r.gy && t.y <= r.gy + r.h) return r;
  return null;
}
/* Facilities are picked separately from rooms because they are not rooms: no session,
   no teammates, no chat log, so nothing here may reach focusRoom(). */
function pickAmenity(mx, my) {
  const t = tileAt(mx, my);
  for (const a of F.state.amenities || []) if (inAm(a, t.x, t.y)) return a;
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

/* A facility is shared by every session, so it has no title, no branch and no log —
   a name and a head count is the whole of what it can honestly say. */
function tipForAmenity(a) {
  const here = Object.values(St.people)
    .filter(q => (q.fac || q.cowork) === a && inAm(a, q.x, q.y));
  const desks = a.desks || [];
  return `<div class="tk">Shared facility</div>
    <h3>${esc(a.label)}</h3>
    <dl>
      ${row('here now', here.length + (here.length === 1 ? ' person' : ' people'))}
      ${desks.length ? row('hot desks', desks.filter(d => d.by).length + ' of ' + desks.length + ' taken') : ''}
      ${row('standing room', (a.seats || []).length + ' spots')}
    </dl>`;
}

function showTip(mx, my) {
  const tip = el('tip');
  if (panning) { tip.classList.remove('on'); return; }
  const p = hitPerson(mx, my);
  const r = p ? null : pick(mx, my);
  const a = p || r ? null : pickAmenity(mx, my);
  if (!p && !r && !a) { tip.classList.remove('on'); cv.style.cursor = 'default'; return; }
  cv.style.cursor = a ? 'default' : 'pointer';      // a facility does not open on click
  const key = p ? p.key : r ? 'room:' + r.sid : 'am:' + a.kind;
  if (tip.dataset.key !== key) {
    tip.dataset.key = key;
    tip.innerHTML = a ? tipForAmenity(a) : tipFor(p, r);
  }
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
  const mx = e.offsetX ?? 0, my = e.offsetY ?? 0;
  const r = pick(mx, my);
  // Clicking a facility does nothing: there is no session behind it to open a panel
  // for, and treating it as a click on bare floor would drop the room you are reading.
  if (!r && pickAmenity(mx, my)) return;
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
  if (to < St.clock) Sim.rebuild(to);
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
  Sim.rebuild(Date.now() / 1000);
});
el('speed').addEventListener('click', () => {
  St.si = (St.si + 1) % SPEEDS.length;
  el('speed').textContent = SPEEDS[St.si] + '×';
});
el('speed').textContent = SPEEDS[St.si] + '×';

(async () => {
  Chat.init(el('bubbles'), el('chatlog'), el('jump'));
  resize();
  await Sim.poll();
  Sim.rebuild(Date.now() / 1000);
  St.clock = St.t1;
  setInterval(Sim.poll, 2000);
  requestAnimationFrame(frame);
})();
