/* floor.js — the building plan.
   Departments (projects) -> team rooms (sessions) -> zones -> desks, on one tile grid.
   Pure: no DOM, no canvas. Runs in node for tests and in the browser for the office.

   Invariants this module exists to guarantee:
     - a room, once placed, NEVER moves (moving rooms is what teleported people)
     - every room is the same size, so a growing team never resizes or collides
     - a desk claimed by an agent stays that agent's desk for the session's lifetime
     - paths only ever cross walkable tiles, and never cut a blocked corner
*/
(function (root) {
'use strict';

/* ---------------------------------------------------------------- sizes --- */
const ROOM_W = 20, ROOM_H = 18;      // team room, walls included
const SLOT_W = 22, SLOT_H = 20;      // room + the 2-tile service lane east and south
const DEPT_COLS = 3;                 // rooms per department row; departments grow DOWNWARD
const DEPT_GAP = 3;                  // lane between departments
const CORRIDOR_H = 3;                // walkable spine along the top
const DEPT_PITCH = DEPT_COLS * SLOT_W + DEPT_GAP;

const N = 0, E = 1, S = 2, W = 3;    // facing: the direction the occupant looks

const BLOCK = 1, FREE = 0;

/* ------------------------------------------------------------ the world --- */
const F = {
  gw: 0, gh: 0,          // grid size in tiles
  blocked: null,         // Uint8Array(gw*gh); anything outside a room/lane is blocked
  rooms: {},             // sid -> room
  depts: {},             // proj -> { idx, rooms: [sid] }
  _paths: new Map(),     // "fx,fy>tx,ty" -> [{x,y}]
};

const idx = (x, y) => y * F.gw + x;
const inGrid = (x, y) => x >= 0 && y >= 0 && x < F.gw && y < F.gh;
const walkable = (x, y) => inGrid(x | 0, y | 0) && F.blocked[idx(x | 0, y | 0)] === FREE;

/* grow the grid, preserving what is already marked */
function ensureGrid(w, h) {
  if (w <= F.gw && h <= F.gh) return;
  const gw = Math.max(w, F.gw), gh = Math.max(h, F.gh);
  const next = new Uint8Array(gw * gh).fill(BLOCK);
  if (F.blocked) {
    for (let y = 0; y < F.gh; y++)
      next.set(F.blocked.subarray(y * F.gw, (y + 1) * F.gw), y * gw);
  }
  F.gw = gw; F.gh = gh; F.blocked = next;
  F._paths.clear();
}

const setFree = (x, y) => { if (inGrid(x, y)) F.blocked[idx(x, y)] = FREE; };
const setBlocked = (x, y) => { if (inGrid(x, y)) F.blocked[idx(x, y)] = BLOCK; };

/* -------------------------------------------------------- room interior --- */
/* Local layout, (0,0) = room's NW corner. Walls on the border, door in the north
   wall so every room opens onto the service lane that leads to the corridor.

     y0        ####### door #######
     y1        entry strip (kept clear)
     y2..y12   work zone: 6 pods of 4 desks, bench style, aisles between
     y3..y8    boss zone on the east: boss desk + meeting table
     y13..y16  break (west) and archive (east)
*/
function buildInterior(r) {
  const { gx, gy } = r;
  const abs = (x, y) => ({ x: gx + x, y: gy + y });

  for (let x = 1; x < ROOM_W - 1; x++) for (let y = 1; y < ROOM_H - 1; y++) setFree(gx + x, gy + y);
  r.door = abs(ROOM_W / 2 | 0, 0);
  setFree(r.door.x, r.door.y);                       // the opening itself
  setFree(r.door.x, r.door.y - 1);                   // and the lane tile outside it

  r.desks = []; r.props = [];
  const deskAt = (x, y, sx, sy, dir) => {
    const d = abs(x, y), s = abs(sx, sy);
    setBlocked(d.x, d.y);
    r.desks.push({ x: d.x, y: d.y, seat: { x: s.x, y: s.y }, dir, by: null });
  };

  // work zone: pods of 4, two desks back to back, occupants on the outer sides
  for (let pr = 0; pr < 2; pr++) for (let pc = 0; pc < 3; pc++) {
    const x0 = 1 + pc * 3, y0 = 2 + pr * 5;
    deskAt(x0,     y0 + 1, x0,     y0,     S);
    deskAt(x0 + 1, y0 + 1, x0 + 1, y0,     S);
    deskAt(x0,     y0 + 2, x0,     y0 + 3, N);
    deskAt(x0 + 1, y0 + 2, x0 + 1, y0 + 3, N);
    r.props.push({ type: 'pod', x: gx + x0, y: gy + y0 + 1, w: 2, h: 2 });
  }

  // boss zone (east): desk at the top, meeting table below it
  const bd = abs(16, 3), bs = abs(16, 4);
  setBlocked(bd.x, bd.y);
  r.boss = { x: bd.x, y: bd.y, seat: { x: bs.x, y: bs.y }, dir: N, by: null };
  r.props.push({ type: 'bossdesk', x: bd.x, y: bd.y, w: 2, h: 1 });
  setBlocked(bd.x + 1, bd.y);

  for (let x = 14; x <= 17; x++) for (let y = 6; y <= 7; y++) setBlocked(gx + x, gy + y);
  r.props.push({ type: 'table', x: gx + 14, y: gy + 6, w: 4, h: 2 });
  r.meet = [[14, 8], [15, 8], [16, 8], [17, 8], [13, 6], [13, 7]]
    .map(([x, y]) => abs(x, y));

  // break zone (west) and archive (east)
  const cooler = abs(2, 15);
  setBlocked(cooler.x, cooler.y);
  r.props.push({ type: 'cooler', x: cooler.x, y: cooler.y, w: 1, h: 1 });
  r.break = [[3, 15], [2, 16], [3, 16], [4, 15], [1, 13], [2, 13], [3, 12]].map(([x, y]) => abs(x, y));

  for (let x = 14; x <= 16; x++) setBlocked(gx + x, gy + 15);
  r.props.push({ type: 'cabinet', x: gx + 14, y: gy + 15, w: 3, h: 1 });
  r.archive = [[14, 16], [15, 16], [16, 16]].map(([x, y]) => abs(x, y));

  // lounge, print bay, library and greenery — a floor with only desks reads as a warehouse
  const put = (type, x, y, w, h) => {
    for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) setBlocked(gx + x + i, gy + y + j);
    r.props.push({ type, x: gx + x, y: gy + y, w, h });
  };
  put('plant', 18, 16, 1, 1);
  put('plant', 18, 2, 1, 1);
  put('sofa', 1, 12, 2, 1);
  put('lowtable', 4, 12, 1, 1);
  put('printer', 11, 14, 1, 1);
  put('shelf', 18, 10, 1, 2);
  put('board', 13, 5, 1, 1);          // whiteboard beside the meeting table

  r.zones = {
    work:    { x: gx + 1,  y: gy + 2,  w: 10, h: 11, label: 'WORK' },
    boss:    { x: gx + 13, y: gy + 2,  w: 6,  h: 7,  label: 'MEETING' },
    lounge:  { x: gx + 1,  y: gy + 12, w: 5,  h: 2,  label: '' },
    break:   { x: gx + 1,  y: gy + 14, w: 6,  h: 3,  label: 'BREAK' },
    archive: { x: gx + 12, y: gy + 13, w: 7,  h: 4,  label: 'ARCHIVE' },
    aisle:   { x: gx + 11, y: gy + 2,  w: 2,  h: 11, label: '' },
  };
  r.center = { x: gx + ROOM_W / 2, y: gy + ROOM_H / 2 };
}

/* ------------------------------------------------------------ placement --- */
/* A room's slot is decided once, from its department index and its position in
   that department. Existing rooms are never re-packed. */
function ensureRoom(sid, proj) {
  let r = F.rooms[sid];
  if (r) return r;

  let d = F.depts[proj];
  if (!d) d = F.depts[proj] = { proj, idx: Object.keys(F.depts).length, rooms: [] };
  const n = d.rooms.length;
  d.rooms.push(sid);

  const gx = d.idx * DEPT_PITCH + (n % DEPT_COLS) * SLOT_W + 1;
  const gy = CORRIDOR_H + 2 + Math.floor(n / DEPT_COLS) * SLOT_H;

  ensureGrid(gx + SLOT_W + DEPT_GAP + 2, gy + SLOT_H + 4);

  r = F.rooms[sid] = { sid, proj, dept: d, gx, gy, w: ROOM_W, h: ROOM_H, claims: {} };
  buildInterior(r);
  openLanes();
  F._paths.clear();
  return r;
}

/* corridor along the top plus the service lanes east and south of every room */
function openLanes() {
  for (let x = 0; x < F.gw; x++) for (let y = 0; y < CORRIDOR_H; y++) setFree(x, y);
  for (const sid in F.rooms) {
    const r = F.rooms[sid];
    for (let y = r.gy - 2; y < r.gy + SLOT_H; y++)
      for (let x = r.gx + ROOM_W; x < r.gx + SLOT_W; x++) setFree(x, y);
    for (let x = r.gx - 2; x < r.gx + SLOT_W; x++)
      for (let y = r.gy + ROOM_H; y < r.gy + SLOT_H; y++) setFree(x, y);
    for (let y = 0; y < r.gy; y++) { setFree(r.door.x, y); }     // door -> corridor
  }
}

/* ----------------------------------------------------------- desk claims --- */
/* Claimed once per agent, for the room's lifetime. Scrubbing the timeline wipes
   people but NOT claims, so a teammate always comes back to the same desk. */
function claimDesk(room, aid) {
  if (room.claims[aid] !== undefined) return room.desks[room.claims[aid]];
  const free = room.desks.findIndex(d => d.by === null);
  if (free < 0) return null;                       // full: caller falls back to hot-desking
  room.desks[free].by = aid;
  room.claims[aid] = free;
  return room.desks[free];
}

function claimBoss(room, sid) {
  room.boss.by = sid;
  return room.boss;
}

/* ------------------------------------------------------------- queueing --- */
/* Shared stations hand out numbered standing spots instead of random jitter, so
   people line up rather than pile onto one tile. */
function takeSpot(room, zone, key) {
  const spots = room[zone];
  if (!spots) return null;
  room._held = room._held || {};
  const held = room._held[zone] = room._held[zone] || {};
  if (held[key] !== undefined) return spots[held[key]];
  for (let i = 0; i < spots.length; i++) {
    if (!Object.values(held).includes(i)) { held[key] = i; return spots[i]; }
  }
  return spots[spots.length - 1];                  // overflow: share the last spot
}

function releaseSpots(room, key) {
  if (!room._held) return;
  for (const z in room._held) delete room._held[z][key];
}

/* --------------------------------------------------------- pathfinding --- */
/* 4-connected BFS, so a path can never slip diagonally through a blocked corner,
   then greedily smoothed against a line-of-sight test. */
function bfs(fx, fy, tx, ty) {
  fx |= 0; fy |= 0; tx |= 0; ty |= 0;
  if (!inGrid(fx, fy) || !inGrid(tx, ty)) return null;
  if (fx === tx && fy === ty) return [{ x: tx, y: ty }];
  const n = F.gw * F.gh;
  const prev = new Int32Array(n).fill(-1);
  const seen = new Uint8Array(n);
  const q = new Int32Array(n);
  let head = 0, tail = 0;
  const start = idx(fx, fy);
  q[tail++] = start; seen[start] = 1;
  const goal = idx(tx, ty);
  while (head < tail) {
    const cur = q[head++];
    if (cur === goal) break;
    const cx = cur % F.gw, cy = (cur / F.gw) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = cx + (k === 1 ? 1 : k === 3 ? -1 : 0);
      const ny = cy + (k === 2 ? 1 : k === 0 ? -1 : 0);
      if (!inGrid(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (seen[ni]) continue;
      // the goal may itself be blocked (a desk); allow stepping onto it last
      if (F.blocked[ni] === BLOCK && ni !== goal) { seen[ni] = 1; continue; }
      seen[ni] = 1; prev[ni] = cur; q[tail++] = ni;
    }
  }
  if (prev[goal] === -1 && goal !== start) return null;
  const out = [];
  for (let cur = goal; cur !== -1; cur = prev[cur]) {
    out.push({ x: cur % F.gw, y: (cur / F.gw) | 0 });
    if (cur === start) break;
  }
  return out.reverse();
}

/* Exact, not sampled. Stride sampling misses any slice of a blocked tile shorter
   than the stride, and smooth() tries the LONGEST legs first, which is exactly
   where those slivers happen — so sampling handed back the corner-cutting that
   4-connected BFS exists to prevent. Here we cut the segment at every grid line
   it crosses and test the tile on each interval, plus both shoulders wherever it
   passes exactly through a lattice corner. */
const EPS = 1e-9;
function lineClear(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const cuts = [0, 1];
  if (Math.abs(dx) > EPS) {
    const lo = Math.min(ax, bx), hi = Math.max(ax, bx);
    for (let g = Math.ceil(lo - EPS); g <= Math.floor(hi + EPS); g++) {
      const t = (g - ax) / dx;
      if (t > EPS && t < 1 - EPS) cuts.push(t);
    }
  }
  if (Math.abs(dy) > EPS) {
    const lo = Math.min(ay, by), hi = Math.max(ay, by);
    for (let g = Math.ceil(lo - EPS); g <= Math.floor(hi + EPS); g++) {
      const t = (g - ay) / dy;
      if (t > EPS && t < 1 - EPS) cuts.push(t);
    }
  }
  cuts.sort((a, b) => a - b);
  for (let i = 0; i < cuts.length - 1; i++) {
    const gap = cuts[i + 1] - cuts[i];
    if (gap < EPS) {                       // x and y cross together: a corner
      const t = cuts[i], e = 1e-4;
      const px = ax + dx * (t - e), py = ay + dy * (t - e);
      const nx = ax + dx * (t + e), ny = ay + dy * (t + e);
      if (!walkable(nx, py) || !walkable(px, ny)) return false;
      continue;
    }
    const m = (cuts[i] + cuts[i + 1]) / 2;   // midpoint lies strictly inside one tile
    if (!walkable(ax + dx * m, ay + dy * m)) return false;
  }
  return true;
}

function smooth(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !lineClear(pts[i].x, pts[i].y, pts[j].x, pts[j].y)) j--;
    out.push(pts[j]); i = j;
  }
  return out;
}

/* public: tile path from (fx,fy) to (tx,ty), smoothed, cached */
function path(fx, fy, tx, ty) {
  const key = `${fx | 0},${fy | 0}>${tx | 0},${ty | 0}`;
  const hit = F._paths.get(key);
  if (hit) return hit;
  const raw = bfs(fx, fy, tx, ty);
  const out = raw ? smooth(raw) : null;
  if (F._paths.size > 4000) F._paths.clear();
  F._paths.set(key, out);
  return out;
}

const Floor = {
  N, E, S, W, ROOM_W, ROOM_H, SLOT_W, SLOT_H, DEPT_COLS, DEPT_PITCH, CORRIDOR_H,
  state: F, ensureRoom, claimDesk, claimBoss, takeSpot, releaseSpots,
  path, walkable, bfs, lineClear,
  reset() {
    F.gw = F.gh = 0; F.blocked = null; F.rooms = {}; F.depts = {}; F._paths.clear();
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = Floor;
else root.Floor = Floor;
})(typeof globalThis !== 'undefined' ? globalThis : this);
