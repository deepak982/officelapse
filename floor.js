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

/* Shared facilities sit in a band ABOVE the corridor, never in the space between
   two departments: that space belongs to rooms 2 and 3 of a team that has not
   opened them yet, and a cafeteria built there would be built over the moment
   they do. The band is laid out once and nothing ever claims it. */
const AM_Y = 1;                      // the band starts one tile in from the north edge
const AM_H = 11;                     // both facility rows are this tall
const AM_GAP = 2;                    // between neighbours, and the depth of the aisle
const AM_X0 = 1;                     // first facility in each row
const AM_ROW_Y = [AM_Y, AM_Y + AM_H + AM_GAP];   // north row, south row
const CORRIDOR_Y = AM_ROW_Y[1] + AM_H;   // corridor runs between the band and the teams
const ROOM_Y0 = CORRIDOR_Y + CORRIDOR_H + 2;

const N = 0, E = 1, S = 2, W = 3;    // facing: the direction the occupant looks

const BLOCK = 1, FREE = 0;

/* ------------------------------------------------------------ the world --- */
const F = {
  gw: 0, gh: 0,          // grid size in tiles
  blocked: null,         // Uint8Array(gw*gh); anything outside a room/lane is blocked
  rooms: {},             // sid -> room
  depts: {},             // proj -> { idx, rooms: [sid] }
  amenities: [],         // the ten shared facilities in the band — built once
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

/* ------------------------------------------------------- shared facilities --- */
/* The band above the corridor. Same bones as a team room — walls, a door onto the
   corridor, props, and spots people can stand or sit in — but nobody is assigned
   here and no desk is ever claimed.

   Eleven facilities go in TWO rows, each sized to what it holds. One row at a
   uniform 18-tile slot would make the band 198 tiles wide — nearly 3 department
   pitches — and the default zoom frames the whole floor, so one row would shrink
   every team room to a smudge. Two rows, individually sized (a phone booth is not a
   cafeteria), come to 94x24: about 1.4 pitches, so the floor still frames.

   The south row opens straight onto the corridor. The north row opens onto a 2-tile
   aisle between the rows, which reaches the corridor through the gaps the south row
   leaves between its facilities. Every door is still on its own SOUTH wall. */

const put = (a, type, x, y, w, h, extra) => {
  for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) setBlocked(a.gx + x + i, a.gy + y + j);
  a.props.push(Object.assign({ type, x: a.gx + x, y: a.gy + y, w, h }, extra));
};
/* on a wall, so the tile is already blocked — pictures, mirrors, signage */
const deco = (a, type, x, y, extra) =>
  a.props.push(Object.assign({ type, x: a.gx + x, y: a.gy + y, w: 1, h: 1 }, extra));
const spot = (a, x, y) => a.seats.push({ x: a.gx + x, y: a.gy + y });
/* A chair is furniture somebody stands ON, so the prop and the seat are the same
   tile and it must not block: blocking a chair traps the seat it exists to give. */
const sit = (a, type, x, y) => {
  a.props.push({ type, x: a.gx + x, y: a.gy + y, w: 1, h: 1 });
  a.seats.push({ x: a.gx + x, y: a.gy + y });
};
/* A shared bench desk. Same shape as a team room's desk — blocked tile, occupant on
   the outer side, a facing — so claimDesk()/releaseDesk() work on it unchanged. */
const desk = (a, dx, dy, sx, sy, dir) => {
  a.desks.push({ x: a.gx + dx, y: a.gy + dy,
                 seat: { x: a.gx + sx, y: a.gy + sy }, dir, by: null });
  sit(a, 'chair', sx, sy);
};

/* Every facility is AM_H tall, so its interior is x 1..w-2, y 1..AM_H-2 and its
   door sits at local x = w/2|0 on the south wall. The tile directly inside that
   door is left empty in every plan below — furniture there would seal the room. */
const FURNISH = {
  reception(a) {                                   // door x 7
    put(a, 'counter', 4, 1, 5, 1);
    deco(a, 'logo', 6, 0);
    deco(a, 'art', 2, 0, { art: 0 });
    deco(a, 'art', 11, 0, { art: 1 });
    put(a, 'sofa', 2, 5, 3, 1);
    put(a, 'sofa', 2, 7, 3, 1);
    put(a, 'lowtable', 6, 6, 1, 1);
    put(a, 'planter', 1, 3, 1, 1);
    put(a, 'plant', 12, 2, 1, 1);
    put(a, 'plant', 12, 8, 1, 1);
    [[2, 6], [3, 6], [4, 6], [5, 2], [9, 2]].forEach(([x, y]) => spot(a, x, y));
  },
  cafeteria(a) {                                   // door x 9
    put(a, 'counter', 2, 1, 6, 1);
    put(a, 'coffee', 10, 1, 1, 1);
    put(a, 'vending', 12, 1, 1, 1);
    deco(a, 'menu', 9, 0);
    deco(a, 'art', 4, 0, { art: 2 });
    for (const x of [2, 6, 10, 14]) {              // four tables, aisles between
      put(a, 'table', x, 4, 2, 2);
      [[x, 3], [x + 1, 3], [x, 6], [x + 1, 6]].forEach(([sx, sy]) => spot(a, sx, sy));
    }
    put(a, 'plant', 1, 9, 1, 1);
    put(a, 'plant', 16, 9, 1, 1);
    [[3, 2], [5, 2], [7, 2], [10, 2]].forEach(([x, y]) => spot(a, x, y));   // the queue
  },
  washrooms(a) {                                   // door x 5
    for (const x of [1, 4, 7]) {
      put(a, 'stall', x, 1, 2, 2);
      spot(a, x, 3);                               // whoever is waiting for that stall
    }
    put(a, 'sink', 1, 5, 1, 4);                    // sink run down the west wall
    for (let y = 5; y <= 8; y++) deco(a, 'mirror', 0, y);
    put(a, 'plant', 8, 8, 1, 1);
    [[2, 5], [2, 7]].forEach(([x, y]) => spot(a, x, y));
  },
  lounge(a) {                                      // door x 6
    put(a, 'sofa', 1, 2, 3, 1);
    put(a, 'sofa', 1, 5, 3, 1);
    put(a, 'lowtable', 4, 4, 1, 1);
    put(a, 'shelf', 10, 1, 1, 3);                  // bookshelf
    put(a, 'sofa', 8, 7, 3, 1);
    put(a, 'lowtable', 9, 5, 1, 1);
    deco(a, 'art', 3, 0, { art: 3 });
    deco(a, 'art', 9, 0, { art: 4 });
    put(a, 'planter', 1, 8, 1, 1);
    put(a, 'plant', 11, 8, 1, 1);
    [[1, 3], [2, 3], [3, 3], [1, 4], [3, 4], [8, 6], [9, 6], [10, 6]]
      .forEach(([x, y]) => spot(a, x, y));
  },
  boardroom(a) {                                   // door x 8
    put(a, 'longtable', 4, 4, 8, 2);
    for (let x = 4; x <= 11; x++) { sit(a, 'chair', x, 3); sit(a, 'chair', x, 6); }
    sit(a, 'chair', 3, 4);                         // the two ends
    sit(a, 'chair', 12, 5);
    deco(a, 'screen', 7, 0);                       // projector screen
    deco(a, 'whiteboard', 0, 4);
    put(a, 'cabinet', 12, 1, 3, 1);
    put(a, 'plant', 1, 1, 1, 1);
    put(a, 'plant', 1, 9, 1, 1);
    put(a, 'plant', 14, 9, 1, 1);
  },
  huddle(a) {                                      // door x 8
    /* two pods; the roundtable plus its ring of chairs IS the pod — a 'pod' prop
       would be a blocked box around seats nobody could then reach. */
    for (const x of [3, 10]) {
      put(a, 'roundtable', x, 3, 2, 2);
      [[x - 1, 3], [x - 1, 4], [x + 2, 3], [x + 2, 4], [x, 2], [x + 1, 5]]
        .forEach(([sx, sy]) => sit(a, 'chair', sx, sy));
    }
    deco(a, 'whiteboard', 3, 0);
    deco(a, 'whiteboard', 11, 0);
    put(a, 'plant', 1, 8, 1, 1);
    put(a, 'plant', 14, 8, 1, 1);
  },
  phonebooths(a) {                                 // door x 5
    /* four singles, two to a side; the booth shell is blocked and the occupant
       stands in its mouth, which keeps the middle column a clear run to the door. */
    for (const [x, y, sy] of [[1, 1, 3], [6, 1, 3], [1, 6, 5], [6, 6, 5]]) {
      put(a, 'booth', x, y, 2, 2);
      spot(a, x, sy);
    }
    deco(a, 'art', 3, 0, { art: 7 });
    put(a, 'plant', 8, 1, 1, 1);
    put(a, 'plant', 8, 8, 1, 1);
  },
  printbay(a) {                                    // door x 6
    put(a, 'printer', 2, 1, 2, 1);
    put(a, 'printer', 5, 1, 2, 1);
    put(a, 'shelf', 1, 4, 1, 4);
    put(a, 'shelf', 10, 3, 1, 4);
    put(a, 'cabinet', 2, 8, 3, 1);
    put(a, 'bin', 8, 8, 1, 1);
    put(a, 'bin', 9, 8, 1, 1);
    put(a, 'plant', 10, 8, 1, 1);
    [[2, 2], [5, 2], [2, 5], [9, 4], [3, 7]].forEach(([x, y]) => spot(a, x, y));
  },
  wellness(a) {                                    // door x 6
    put(a, 'planter', 1, 1, 1, 7);                 // the planter wall
    put(a, 'sofa', 3, 2, 3, 1);                    // low seating
    put(a, 'sofa', 8, 5, 1, 3);
    put(a, 'lowtable', 4, 5, 1, 1);
    deco(a, 'art', 4, 0, { art: 5 });
    deco(a, 'art', 9, 0, { art: 6 });
    put(a, 'plant', 11, 1, 1, 1);
    put(a, 'plant', 11, 8, 1, 1);
    [[3, 3], [4, 3], [5, 3], [7, 5], [7, 6]].forEach(([x, y]) => spot(a, x, y));
  },
  serverroom(a) {                                  // door x 6
    for (const x of [2, 4, 7, 9]) put(a, 'rack', x, 1, 1, 3);
    /* the glazing reads as screens on the south wall: no prop type is a free-standing
       partition, and a blocked one across the room would seal the racks off. */
    deco(a, 'screen', 3, AM_H - 1);
    deco(a, 'screen', 9, AM_H - 1);
    put(a, 'cabinet', 1, 7, 2, 1);
    put(a, 'bin', 10, 8, 1, 1);
    [[4, 4], [2, 5], [6, 5], [9, 5]].forEach(([x, y]) => spot(a, x, y));
  },
  coworking(a) {                                   // door x 9
    /* Four bench pods, sixteen desks, aisle down the middle and across. Overflow out
       of a full team room has to read as working, so these are desks with chairs —
       not the standing room the break zone was being used as. */
    a.desks = [];
    for (const py of [2, 7]) for (const px of [3, 10]) {
      put(a, 'pod', px, py, 2, 2);
      for (const i of [0, 1]) {
        desk(a, px + i, py, px + i, py - 1, S);     // north side, looking back at the bench
        desk(a, px + i, py + 1, px + i, py + 2, N); // south side
      }
    }
    put(a, 'cooler', 16, 1, 1, 1);
    put(a, 'shelf', 16, 4, 1, 3);
    put(a, 'planter', 1, 1, 1, 1);
    put(a, 'planter', 1, 9, 1, 1);
    put(a, 'plant', 16, 9, 1, 1);
    deco(a, 'art', 6, 0, { art: 8 });
    deco(a, 'whiteboard', 13, 0);
  },
};

const AMENITIES = [
  { kind: 'reception',   label: 'RECEPTION',        row: 0, w: 14 },
  { kind: 'cafeteria',   label: 'CAFETERIA',        row: 0, w: 18 },
  { kind: 'washrooms',   label: 'WASHROOMS',        row: 0, w: 11 },
  { kind: 'lounge',      label: 'LOUNGE',           row: 0, w: 13 },
  { kind: 'boardroom',   label: 'BOARDROOM',        row: 0, w: 16 },
  { kind: 'huddle',      label: 'HUDDLE',           row: 1, w: 16 },
  { kind: 'phonebooths', label: 'PHONE BOOTHS',     row: 1, w: 10 },
  { kind: 'printbay',    label: 'PRINT & SUPPLIES', row: 1, w: 12 },
  { kind: 'wellness',    label: 'QUIET ROOM',       row: 1, w: 13 },
  { kind: 'serverroom',  label: 'IT / SERVER',      row: 1, w: 12 },
  { kind: 'coworking',   label: 'HOT DESKS',        row: 1, w: 18 },
];

/* The band's footprint in tiles — what a renderer needs to frame the floor. Derived
   from the table, not from the built rooms, so it is right before anything is built. */
const AM_ROW_W = AMENITIES.reduce((w, s) => (w[s.row] += s.w + AM_GAP, w), [AM_X0, AM_X0]);
const AM_BAND = { x: 0, y: AM_Y, w: Math.max(AM_ROW_W[0], AM_ROW_W[1]), h: CORRIDOR_Y - AM_Y };

function buildAmenities() {
  if (F.amenities.length) return;
  const bandW = AM_BAND.w;
  ensureGrid(bandW + 2, ROOM_Y0 + SLOT_H + 4);

  const nextX = [AM_X0, AM_X0];
  for (const spec of AMENITIES) {
    const gx = nextX[spec.row], gy = AM_ROW_Y[spec.row];
    nextX[spec.row] = gx + spec.w + AM_GAP;
    const a = { kind: spec.kind, label: spec.label, gx, gy, w: spec.w, h: AM_H,
                props: [], seats: [], claims: {} };
    for (let x = 1; x < spec.w - 1; x++) for (let y = 1; y < AM_H - 1; y++) setFree(gx + x, gy + y);
    a.door = { x: gx + (spec.w / 2 | 0), y: gy + AM_H - 1 };
    setFree(a.door.x, a.door.y);
    a.center = { x: gx + spec.w / 2, y: gy + AM_H / 2 };
    FURNISH[spec.kind](a);
    F.amenities.push(a);
  }

  /* Open the aisle, and with it every column the south row does not stand on, all
     the way down to the corridor. Doing it by column rather than by door is what
     keeps a north door's route out of the band from tunnelling through a south
     facility's wall, whatever widths the table above is given. */
  const southCol = new Uint8Array(bandW + 2);
  for (const a of F.amenities)
    if (a.gy === AM_ROW_Y[1]) for (let x = a.gx; x < a.gx + a.w; x++) southCol[x] = 1;
  for (let y = AM_ROW_Y[0] + AM_H; y < CORRIDOR_Y; y++)
    for (let x = 0; x < bandW + 2; x++)
      if (y < AM_ROW_Y[1] || !southCol[x]) setFree(x, y);

  openLanes();                 // the corridor itself, so the band works with no rooms yet
}

/* ------------------------------------------------------------ placement --- */
/* A room's slot is decided once, from its department index and its position in
   that department. Existing rooms are never re-packed. */
function ensureRoom(sid, proj) {
  let r = F.rooms[sid];
  if (r) return r;
  buildAmenities();            // the shared band exists before any team moves in

  let d = F.depts[proj];
  if (!d) d = F.depts[proj] = { proj, idx: Object.keys(F.depts).length, rooms: [] };
  const n = d.rooms.length;
  d.rooms.push(sid);

  const gx = d.idx * DEPT_PITCH + (n % DEPT_COLS) * SLOT_W + 1;
  const gy = ROOM_Y0 + Math.floor(n / DEPT_COLS) * SLOT_H;

  ensureGrid(gx + SLOT_W + DEPT_GAP + 2, gy + SLOT_H + 4);

  r = F.rooms[sid] = { sid, proj, dept: d, gx, gy, w: ROOM_W, h: ROOM_H, claims: {} };
  buildInterior(r);
  openLanes();
  F._paths.clear();
  return r;
}

/* corridor along the top plus the service lanes east and south of every room */
function openLanes() {
  for (let x = 0; x < F.gw; x++)
    for (let y = CORRIDOR_Y; y < CORRIDOR_Y + CORRIDOR_H; y++) setFree(x, y);
  for (const sid in F.rooms) {
    const r = F.rooms[sid];
    for (let y = r.gy - 2; y < r.gy + SLOT_H; y++)
      for (let x = r.gx + ROOM_W; x < r.gx + SLOT_W; x++) setFree(x, y);
    for (let x = r.gx - 2; x < r.gx + SLOT_W; x++)
      for (let y = r.gy + ROOM_H; y < r.gy + SLOT_H; y++) setFree(x, y);
    // corridor -> door, never above it: the band up there is not a thoroughfare
    for (let y = CORRIDOR_Y; y < r.gy; y++) setFree(r.door.x, y);
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

/* A teammate who has clocked out frees their desk for the next one. Sessions on
   this machine reach 135 subagents over a day while only a handful are ever
   active at once, so without this every desk leaks and later arrivals get none. */
function releaseDesk(room, aid) {
  const i = room.claims[aid];
  if (i === undefined) return;
  if (room.desks[i] && room.desks[i].by === aid) room.desks[i].by = null;
  delete room.claims[aid];
}

/* Genuinely more concurrent teammates than desks: stand them in the break and
   meeting areas rather than stacking them onto the boss's chair. */
function hotDesk(room, aid) {
  const spots = room.break.concat(room.meet);
  let h = 0;
  for (const c of String(aid)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const s = spots[h % spots.length];
  return { x: s.x, y: s.y, seat: { x: s.x, y: s.y }, dir: N, by: aid, hot: true };
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

/* Scan the leg OUTWARD and give up after SMOOTH_MISS consecutive failures, instead
   of starting at the far end and stepping back one point at a time. The old walk
   cost one lineClear per point of the whole remaining path for every leg it found —
   O(n^2): a 277-point desk-to-cafeteria route burnt 973 calls and 7.8ms, which at
   135 people walking is a ~1s stall. Every destination used to be inside the
   walker's own room (<=25 points) so it never showed. Outward is linear in the path
   and the miss budget still hops a lone pillar; past that the leg just ends a few
   tiles early, which nobody can see. */
const SMOOTH_MISS = 8;
function smooth(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let best = i + 1, miss = 0;          // neighbours are always clear, never tested
    for (let j = i + 2; j < pts.length && miss < SMOOTH_MISS; j++) {
      if (lineClear(pts[i].x, pts[i].y, pts[j].x, pts[j].y)) { best = j; miss = 0; }
      else miss++;
    }
    out.push(pts[best]); i = best;
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
  AM_H, AM_GAP, AM_Y, AM_ROW_Y, AM_BAND, CORRIDOR_Y, ROOM_Y0,
  state: F, ensureRoom, buildAmenities, claimDesk, claimBoss, releaseDesk, hotDesk,
  takeSpot, releaseSpots, path, walkable, bfs, lineClear,
  reset() {
    F.gw = F.gh = 0; F.blocked = null; F.rooms = {}; F.depts = {};
    F.amenities = []; F._paths.clear();
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = Floor;
else root.Floor = Floor;
})(typeof globalThis !== 'undefined' ? globalThis : this);
