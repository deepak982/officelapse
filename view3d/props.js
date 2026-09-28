/* view3d/props.js — all the geometry. Primitives only, no external models: the
   floor has to be complete and correct with zero .glb files loaded, so anything
   here that needed an asset would be a hole in the floor instead of a prop.

   Two coordinate conventions, both in tiles (1 tile = 1 world unit, Y up):

     floor props   built with their min corner at the origin, extent (w, *, h) in
                   (x, *, z). The instance matrix is a plain translate to (x,0,y).
     wall props    built centred on the tile (x and z run -.5..+.5) with the panel
                   at the -z face looking toward +z. The instance matrix translates
                   to the tile centre and spins about Y, so one geometry serves all
                   four walls. See wallSideOf / SIDE_ROT in scene.js.

   Geometry is merged per material and handed back as buckets, one InstancedMesh
   per bucket in scene.js. Merged-with-groups would be one mesh, but a material
   array on an InstancedMesh is a narrower path through the renderer than plain
   single-material instancing, and the draw-call count is identical either way. */

import * as THREE from '../vendor/three.module.js';
import { MAT, COL } from './materials.js';

/* Heights in world units, sized against the character rig, NOT against office.js's
   pixel boxes: the rig is 1.80 tall with feet on y=0, standing pelvis .877, standing
   head 1.526, and the seated clips put the pelvis at .542. So anything a person sits
   ON tops out at .44 (chair, sofa, stool, hot-desk chair) or they float / sink, and
   a desk they sit at goes to .72.

   H.wall is the one knob to turn on screen. The camera looks in from +x/+z at 26.5
   degrees, so a wall of height h hides h*cos(e)/(sin(e)/sqrt2) = 2.8h tiles of the
   row BEHIND it. office.js gets away with .81 because 2D has no depth to lose; 1.25
   here costs 3.5 tiles, which is the empty lane plus a room's own entry strip. Push
   it higher only if the rooms behind can spare the depth. */
const H = {
  wall: 1.25, cap: .06, wallT: .16,
  seat: .44, seatBack: .90,          // .44 is measured, not chosen — see above
  desk: .72, table: .72, low: .40,
  sofa: .44, sofaBack: .90,
  counter: 1.00, cabinet: 1.10, cooler: 1.30, vending: 1.90, shelf: 1.80,
  stall: 2.00, booth: 2.20, rack: 2.00, locker: 1.85, printer: .95, bin: .60,
  sink: .85, pot: .40, coffee: 1.10, deco: 1.45,
};

/* ------------------------------------------------------------ primitives --- */
const bx = (mat, col, x, y, z, w, h, d) =>
  ({ mat, col, geom: new THREE.BoxGeometry(w, h, d).translate(x + w / 2, y + h / 2, z + d / 2) });

const cy = (mat, col, cx, y, cz, r, h, seg = 8) =>
  ({ mat, col, geom: new THREE.CylinderGeometry(r, r, h, seg).translate(cx, y + h / 2, cz) });

const sp = (mat, col, cx, cy_, cz, r) =>
  ({ mat, col, geom: new THREE.SphereGeometry(r, 7, 5).translate(cx, cy_, cz) });

/* a horizontal quad: 6 verts against a box's 36, which is what makes a per-tile
   carpet checker affordable inside the room-shell geometry */
const flat = (mat, col, x, y, z, w, d) =>
  ({ mat, col, geom: new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2).translate(x + w / 2, y, z + d / 2) });

/* Long furniture — a sink run, a planter wall, a sofa — is laid out along x in
   some plans and along z in others. This emits in a (u = long, v = across) frame
   so one body of code covers both. Swapping u and v mirrors rather than rotates;
   every prop that uses it is symmetric across its long axis, so that is fine. */
function frame(w, h) {
  const alongX = w >= h;
  return {
    L: alongX ? w : h, D: alongX ? h : w, alongX,
    bx: (m, c, u, y, v, du, hh, dv) =>
      alongX ? bx(m, c, u, y, v, du, hh, dv) : bx(m, c, v, y, u, dv, hh, du),
    cy: (m, c, u, y, v, r, hh, s) =>
      alongX ? cy(m, c, u, y, v, r, hh, s) : cy(m, c, v, y, u, r, hh, s),
    sp: (m, c, u, y, v, r) => alongX ? sp(m, c, u, y, v, r) : sp(m, c, v, y, u, r),
  };
}

/* ---------------------------------------------------------------- merge --- */
/* Concatenates parts into one buffer per material, baking each part's colour into
   a vertex-colour attribute. Everything is flattened to non-indexed first, so the
   merge is a straight array copy with no index rebasing — the primitives here are
   tiny enough that the ~1.5x vertex cost is cheaper than the bug surface.

   BufferGeometryUtils.mergeGeometries would do this, but it lives in
   three/examples/jsm and the vendored build is the single three.module.js file. */
export function mergeParts(parts) {
  const byMat = new Map();
  for (const p of parts) {
    if (!p) continue;
    const g = p.geom.index ? p.geom.toNonIndexed() : p.geom;
    if (g !== p.geom) p.geom.dispose();
    if (!byMat.has(p.mat)) byMat.set(p.mat, []);
    byMat.get(p.mat).push({ g, col: p.col });
  }
  const buckets = [];
  for (const [material, list] of byMat) {
    let n = 0;
    for (const it of list) n += it.g.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
    let off = 0;
    for (const { g, col: c } of list) {
      const m = g.attributes.position.count;
      pos.set(g.attributes.position.array, off * 3);
      nor.set(g.attributes.normal.array, off * 3);
      for (let i = 0; i < m; i++) {
        col[(off + i) * 3] = c.r; col[(off + i) * 3 + 1] = c.g; col[(off + i) * 3 + 2] = c.b;
      }
      off += m;
      g.dispose();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geometry.computeBoundingSphere();
    buckets.push({ material, geometry });
  }
  return buckets;
}

/* -------------------------------------------------------- shared clusters --- */
/* A desk and its chair are the same in every room, so they are merged into the
   room shell rather than batched as props — see buildRoomShell. */
function deskParts(x, z, seat, big) {
  const w = big ? 1.9 : .96, d = .78;
  /* the monitor goes on the far side from the chair, or the occupant types into
     the back of it */
  const far = seat.z > z;
  const mz = far ? z + .10 : z + d - .22;
  const cx = x + w / 2;
  return [
    bx(MAT.plastic, COL.desk, x + .02, H.desk - .05, z + .06, w, .05, d),
    bx(MAT.plastic, COL.deskEdge, x + .12, 0, z + .16, w - .24, H.desk - .05, d - .22),
    bx(MAT.metal, COL.metalDark, cx - .05, H.desk, mz + .04, .10, .16, .07),
    bx(MAT.screen, COL.screenOff, cx - .29, H.desk + .16, mz, .58, .36, .04),
  ];
}

/* dir is the direction the occupant LOOKS (floor.js N/E/S/W = 0/1/2/3), so the
   back goes on the opposite side. Baked per-direction instead of rotated, because
   these are merged into a shell that is instanced as one rigid lump. */
function chairParts(x, z, dir) {
  const p = [
    bx(MAT.fabric, COL.fabric, x + .24, H.seat - .07, z + .24, .52, .07, .52),
    bx(MAT.metal, COL.metal, x + .42, 0, z + .42, .16, H.seat - .07, .16),
  ];
  const bh = H.seatBack - H.seat;
  if (dir === 0) p.push(bx(MAT.fabric, COL.fabricBack, x + .24, H.seat, z + .70, .52, bh, .10));
  else if (dir === 2) p.push(bx(MAT.fabric, COL.fabricBack, x + .24, H.seat, z + .20, .52, bh, .10));
  else if (dir === 1) p.push(bx(MAT.fabric, COL.fabricBack, x + .70, H.seat, z + .24, .10, bh, .52));
  else p.push(bx(MAT.fabric, COL.fabricBack, x + .20, H.seat, z + .24, .10, bh, .52));
  return p;
}

/* ------------------------------------------------------- the prop vocabulary --- */
/* Keyed exactly on prop.type. Anything floor.js can emit must have an entry here
   or buildProp shouts and draws a magenta marker — a silent skip is how a floor
   ends up quietly missing its washrooms. */
const BUILD = {
  counter(w, h) {
    const f = frame(w, h);
    return [
      f.bx(MAT.plastic, COL.plastic, .06, 0, .14, f.L - .12, H.counter - .06, f.D - .28),
      f.bx(MAT.wood, COL.wood, 0, H.counter - .06, .04, f.L, .06, f.D - .08),
    ];
  },
  coffee() {
    return [
      bx(MAT.metal, COL.metalDark, .18, 0, .20, .64, H.coffee - .18, .58),
      bx(MAT.plastic, COL.dark, .24, H.coffee - .18, .26, .52, .18, .46),
      bx(MAT.glass, COL.glass, .34, .44, .68, .32, .26, .10),
      bx(MAT.metal, COL.metal, .30, .40, .60, .40, .04, .16),
    ];
  },
  vending() {
    const p = [
      bx(MAT.plastic, COL.plastic, .10, 0, .16, .80, H.vending, .66),
      bx(MAT.glass, COL.glass, .16, .36, .80, .68, H.vending - .50, .06),
    ];
    for (let i = 0; i < 4; i++)
      p.push(bx(MAT.paper, COL.art[i][0], .22, .48 + i * .26, .60, .56, .14, .16));
    return p;
  },
  table(w, h) {
    const p = [bx(MAT.wood, COL.wood, .06, H.table - .06, .06, w - .12, .06, h - .12)];
    for (const dx of [.18, w - .30]) for (const dz of [.18, h - .30])
      p.push(bx(MAT.metal, COL.metal, dx, 0, dz, .12, H.table - .06, .12));
    return p;
  },
  roundtable(w, h) {
    const r = Math.min(w, h) / 2 - .10, cx = w / 2, cz = h / 2;
    return [
      cy(MAT.wood, COL.wood, cx, H.table - .07, cz, r, .07, 16),
      cy(MAT.metal, COL.metal, cx, 0, cz, .09, H.table - .07, 10),
      cy(MAT.metal, COL.metalDark, cx, 0, cz, r * .55, .05, 14),
    ];
  },
  longtable(w, h) {
    const f = frame(w, h);
    const p = [f.bx(MAT.wood, COL.wood, .06, H.table - .07, .08, f.L - .12, .07, f.D - .16)];
    for (const u of [.6, f.L - 1.0])
      p.push(f.bx(MAT.metal, COL.metalDark, u, 0, f.D / 2 - .14, .40, H.table - .07, .28));
    p.push(f.bx(MAT.metal, COL.metal, .8, H.table - .22, f.D / 2 - .05, f.L - 1.6, .08, .10));
    return p;
  },
  chair() { return chairParts(0, 0, 0); },   // faces N; scene.js spins the instance
  sofa(w, h) {
    const f = frame(w, h);
    return [
      f.bx(MAT.fabric, COL.fabric, .08, 0, .14, f.L - .16, H.sofa, f.D - .34),
      f.bx(MAT.fabric, COL.fabricBack, .08, 0, f.D - .22, f.L - .16, H.sofaBack, .18),
      f.bx(MAT.fabric, COL.fabricBack, .04, 0, .14, .12, H.sofa + .14, f.D - .30),
      f.bx(MAT.fabric, COL.fabricBack, f.L - .16, 0, .14, .12, H.sofa + .14, f.D - .30),
    ];
  },
  lowtable(w, h) {
    const p = [bx(MAT.wood, COL.woodDark, .14, H.low - .06, .14, w - .28, .06, h - .28)];
    for (const dx of [.20, w - .30]) for (const dz of [.20, h - .30])
      p.push(bx(MAT.wood, COL.woodDark, dx, 0, dz, .10, H.low - .06, .10));
    return p;
  },
  shelf(w, h) {
    const f = frame(w, h);
    const p = [
      f.bx(MAT.wood, COL.woodDark, .08, 0, .12, f.L - .16, H.shelf, f.D - .30),
      f.bx(MAT.wood, COL.wood, .06, H.shelf, .10, f.L - .12, .06, f.D - .26),
    ];
    /* books: the colour is what says "bookshelf" rather than "cupboard" */
    for (let s = 0; s < 4; s++) {
      const y = .28 + s * .36;
      for (let i = 0; i * .34 < f.L - .5; i++)
        p.push(f.bx(MAT.paper, COL.art[(s + i) % COL.art.length][0],
                    .18 + i * .34, y, f.D - .30, .26, .30, .12));
    }
    return p;
  },
  cabinet(w, h) {
    const f = frame(w, h);
    const p = [f.bx(MAT.metal, COL.metalDark, .08, 0, .14, f.L - .16, H.cabinet, f.D - .30)];
    for (let i = 0; i < 3; i++) {
      p.push(f.bx(MAT.metal, COL.plastic, .12, .10 + i * .30, f.D - .17, f.L - .24, .24, .04));
      p.push(f.bx(MAT.metal, COL.metal, f.L / 2 - .16, .18 + i * .30, f.D - .13, .32, .05, .04));
    }
    return p;
  },
  printer(w, h) {
    return [
      bx(MAT.plastic, COL.plastic, .12, 0, .16, w - .24, H.printer - .12, h - .32),
      bx(MAT.plastic, COL.plasticPale, .20, H.printer - .12, .22, w - .40, .12, h - .44),
      bx(MAT.paper, COL.white, .26, H.printer, h - .46, w - .52, .02, .30),
      bx(MAT.screen, COL.screenOn, w - .40, H.printer - .10, .12, .18, .08, .05),
    ];
  },
  cooler() {
    return [
      bx(MAT.plastic, COL.plastic, .26, 0, .26, .48, H.cooler - .50, .48),
      cy(MAT.glass, COL.water, .5, H.cooler - .50, .5, .19, .48, 12),
      bx(MAT.metal, COL.metal, .44, H.cooler - .62, .72, .12, .08, .10),
    ];
  },
  plant() {
    return [
      cy(MAT.plastic, COL.pot, .5, 0, .5, .22, H.pot, 10),
      sp(MAT.plant, COL.leaf, .5, H.pot + .30, .5, .26),
      sp(MAT.plant, COL.leafDeep, .36, H.pot + .18, .58, .18),
      sp(MAT.plant, COL.leaf, .64, H.pot + .22, .40, .17),
    ];
  },
  planter(w, h) {
    const f = frame(w, h);
    const p = [f.bx(MAT.wood, COL.woodDark, .06, 0, .18, f.L - .12, .42, f.D - .36)];
    for (let i = 0; i * .55 < f.L - .3; i++) {
      p.push(f.sp(MAT.plant, COL.leaf, .34 + i * .55, .62, f.D / 2, .21));
      p.push(f.sp(MAT.plant, COL.leafDeep, .52 + i * .55, .52, f.D / 2 + .10, .15));
    }
    return p;
  },
  stall(w, h) {
    /* three sides and a door, open toward +z: floor.js parks the person waiting
       for a stall on the tile directly south of it */
    return [
      bx(MAT.plastic, COL.plastic, .04, .10, .04, w - .08, H.stall, .08),
      bx(MAT.plastic, COL.plastic, .04, .10, .04, .08, H.stall, h - .08),
      bx(MAT.plastic, COL.plastic, w - .12, .10, .04, .08, H.stall, h - .08),
      bx(MAT.plastic, COL.plasticPale, .14, .10, h - .12, w - .28, H.stall, .07),
      bx(MAT.metal, COL.metal, w - .26, .90, h - .16, .10, .04, .06),
      bx(MAT.plastic, COL.plasticPale, w / 2 - .18, 0, .20, .36, .46, .48),
    ];
  },
  sink(w, h) {
    const f = frame(w, h);
    const p = [
      f.bx(MAT.metal, COL.metalDark, .04, H.sink - .08, .16, f.L - .08, .08, f.D - .28),
      f.bx(MAT.plastic, COL.plastic, .10, 0, .22, f.L - .20, H.sink - .08, f.D - .40),
    ];
    const n = Math.max(1, Math.round(f.L));
    for (let i = 0; i < n; i++) {
      const u = (i + .5) * (f.L / n);
      p.push(f.cy(MAT.metal, COL.plasticPale, u, H.sink - .10, f.D / 2, .17, .04, 12));
      p.push(f.bx(MAT.metal, COL.metal, u - .03, H.sink, f.D - .34, .06, .20, .06));
    }
    return p;
  },
  booth(w, h) {
    /* glass on all four sides: a phone booth you cannot see into is a cupboard */
    const p = [
      bx(MAT.glass, COL.glass, .10, .06, .10, w - .20, H.booth, .06),
      bx(MAT.glass, COL.glass, .10, .06, h - .16, w - .20, H.booth, .06),
      bx(MAT.glass, COL.glass, .10, .06, .10, .06, H.booth, h - .20),
      bx(MAT.glass, COL.glass, w - .16, .06, .10, .06, H.booth, h - .20),
    ];
    for (const dx of [.08, w - .16]) for (const dz of [.08, h - .16])
      p.push(bx(MAT.metal, COL.metalDark, dx, 0, dz, .08, H.booth + .08, .08));
    p.push(bx(MAT.wood, COL.wood, .18, H.desk, .16, w - .36, .06, .34));
    p.push(bx(MAT.fabric, COL.fabric, w / 2 - .18, 0, h - .62, .36, H.seat, .36));
    return p;
  },
  rack(w, h) {
    const f = frame(w, h);
    const p = [
      f.bx(MAT.metal, COL.dark, .08, 0, .14, f.L - .16, H.rack, f.D - .30),
      f.bx(MAT.glass, COL.glass, .12, .10, f.D - .17, f.L - .24, H.rack - .20, .05),
    ];
    for (let i = 0; i < 7; i++) {
      p.push(f.bx(MAT.metal, COL.metalDark, .14, .16 + i * .24, f.D - .22, f.L - .28, .18, .05));
      for (let j = 0; j < 3; j++)
        p.push(f.bx(MAT.screen, j === 1 ? COL.led : COL.accent,
                    .24 + j * .18, .22 + i * .24, f.D - .24, .05, .05, .03));
    }
    return p;
  },
  locker(w, h) {
    const f = frame(w, h);
    const p = [f.bx(MAT.metal, COL.metalDark, .08, 0, .14, f.L - .16, H.locker, f.D - .30)];
    const n = Math.max(1, Math.round(f.L));
    for (let i = 0; i < n; i++) for (let r = 0; r < 2; r++) {
      const u = .12 + i * (f.L - .24) / n;
      p.push(f.bx(MAT.metal, COL.plastic, u + .03, .08 + r * .84, f.D - .17,
                  (f.L - .24) / n - .06, .78, .04));
      p.push(f.bx(MAT.metal, COL.metal, u + .08, .50 + r * .84, f.D - .13, .10, .06, .04));
    }
    return p;
  },
  bin() {
    return [
      cy(MAT.plastic, COL.plastic, .5, 0, .5, .26, H.bin, 10),
      cy(MAT.plastic, COL.dark, .5, H.bin - .04, .5, .29, .05, 10),
    ];
  },

  /* ---- wall decoration: tile-centred, panel on the -z face looking toward +z ---- */
  art(w, h, x) {
    /* Floored modulo, not plain %: JS's % keeps the sign, so art:-1 looked up
       COL.art[-1], got undefined and threw on the destructure below. floor.js only
       emits 0..8 today, which is exactly why it went unnoticed. */
    const n = COL.art.length;
    const pal = COL.art[(((x.art | 0) % n) + n) % n], z = x.z0;
    return [
      bx(MAT.wood, COL.dark, -.34, H.deco - .28, z, .68, .56, .06),
      bx(MAT.paper, pal[0], -.29, H.deco - .01, z + .05, .58, .24, .03),
      bx(MAT.paper, pal[1], -.29, H.deco - .23, z + .05, .58, .22, .03),
    ];
  },
  logo(w, h, x) {
    const z = x.z0;
    const p = [bx(MAT.plastic, COL.dark, -.46, H.deco - .16, z, .92, .32, .05)];
    for (let i = 0; i < 5; i++)
      p.push(bx(MAT.screen, COL.accent, -.38 + i * .16, H.deco - .10 + (i % 2) * .04,
                z + .04, .10, .14 - (i % 2) * .04, .03));
    return p;
  },
  menu(w, h, x) {
    const z = x.z0;
    const p = [bx(MAT.plastic, COL.dark, -.42, H.deco - .26, z, .84, .52, .05)];
    for (let i = 0; i < 4; i++)
      p.push(bx(MAT.screen, COL.led, -.34, H.deco + .12 - i * .12, z + .04, .52 - i * .09, .05, .03));
    return p;
  },
  mirror(w, h, x) {
    const z = x.z0;
    return [
      bx(MAT.metal, COL.metal, -.36, H.deco - .30, z, .72, .60, .05),
      bx(MAT.mirror, COL.glass, -.31, H.deco - .25, z + .04, .62, .50, .03),
    ];
  },
  screen(w, h, x) {
    const z = x.z0;
    return [
      bx(MAT.plastic, COL.dark, -.46, H.deco - .32, z, .92, .64, .06),
      bx(MAT.screen, COL.screenOn, -.41, H.deco - .27, z + .05, .82, .54, .03),
    ];
  },
  whiteboard(w, h, x) {
    const z = x.z0;
    const p = [
      bx(MAT.metal, COL.metal, -.44, H.deco - .34, z, .88, .68, .05),
      bx(MAT.paper, COL.white, -.39, H.deco - .29, z + .04, .78, .58, .03),
    ];
    for (let i = 0; i < 3; i++)
      p.push(bx(MAT.screen, COL.ink, -.32, H.deco + .06 - i * .13, z + .07, .50 - i * .14, .04, .02));
    if (x.standing) {                    // not on a wall: give it legs to stand on
      p.push(bx(MAT.metal, COL.metalDark, -.34, 0, z + .01, .07, H.deco - .34, .07));
      p.push(bx(MAT.metal, COL.metalDark, .27, 0, z + .01, .07, H.deco - .34, .07));
    }
    return p;
  },
};
BUILD.board = BUILD.whiteboard;   // floor.js's room interior still says 'board'

/* Drawn by the room shell, not as props: 'pod' marks a desk cluster and
   'bossdesk' the desk under Floor's r.boss, and both are already built from
   r.desks / r.boss. office.js skips them in drawProp for the same reason. */
export const SKIP = new Set(['pod', 'bossdesk']);

/* Mounts flat on the wall it sits on. Anything here uses the tile-centred frame. */
export const WALL_DECO = new Set(['art', 'logo', 'menu', 'mirror', 'screen', 'whiteboard', 'board']);

/* Which wall of rect a prop sits on, or null if it stands in the open. N wins a
   corner, because that is the wall office.js hangs things on. */
export function wallSideOf(pr, rect) {
  if (pr.y === rect.gy) return 'N';
  if (pr.y === rect.gy + rect.h - 1) return 'S';
  if (pr.x === rect.gx) return 'W';
  if (pr.x === rect.gx + rect.w - 1) return 'E';
  return null;
}

const shouted = new Set();
function unknown(type, w, h) {
  if (!shouted.has(type)) {
    shouted.add(type);
    console.error(`[view3d] no geometry for prop type "${type}" — add it to ` +
                  'view3d/props.js BUILD. Drawing a marker box instead.');
  }
  return mergeParts([bx(MAT.screen, new THREE.Color(1, 0, 1), .1, 0, .1, w - .2, 1.2, h - .2)]);
}

/* Geometry for one prop, as material buckets. `extra` carries prop.art and, for
   wall decoration, standing = true when the prop is not actually on a wall. */
export function buildProp(type, w, h, extra) {
  const fn = BUILD[type];
  if (!fn) return unknown(type, w, h);
  /* A missing footprint used to sail straight through into NaN vertex positions, and a
     NaN bounding sphere does not drop one prop — it takes the WHOLE instanced batch off
     screen, because every prop of that type shares the geometry. Loud, and clamped to a
     tile so the rest of the batch survives. */
  if (!(w >= 1) || !(h >= 1)) {
    const key = `${type}|footprint`;
    if (!shouted.has(key)) {
      shouted.add(key);
      console.error(`[view3d] prop "${type}" has footprint ${w}x${h} — floor.js must ` +
                    'give every prop w and h >= 1. Clamping to 1x1.');
    }
    w = w >= 1 ? w : 1; h = h >= 1 ? h : 1;
  }
  /* z0 is where a wall panel's back face sits: hard against the wall normally,
     pulled to the tile centre when the board is free-standing */
  const x = Object.assign({ z0: extra && extra.standing ? -.03 : -.46 }, extra);
  const parts = fn(w, h, x);
  if (!parts || !parts.length) return unknown(type, w, h);
  return mergeParts(parts);
}

/* --------------------------------------------------------------- shells --- */
/* Both shells draw only the NORTH and WEST walls, exactly as office.js does. The
   camera looks in from +x/+z, so those are the far walls: drawing the near two
   would wall the room off from the only angle anyone ever sees it. */
function walls(parts, w, h, doorX) {
  for (let x = 0; x < w; x++) {
    if (x === doorX) continue;
    parts.push(bx(MAT.wall, COL.wall, x, 0, 0, 1, H.wall, H.wallT));
  }
  for (let y = 0; y < h; y++)
    parts.push(bx(MAT.wall, COL.wall, 0, 0, y, H.wallT, H.wall, 1));
  parts.push(bx(MAT.wall, COL.wallTop, 0, H.wall, 0, w, H.cap, H.wallT));
  parts.push(bx(MAT.wall, COL.wallTop, 0, H.wall, 0, H.wallT, H.cap, h));
  if (doorX >= 0) {
    for (const dx of [doorX - .07, doorX + .95])
      parts.push(bx(MAT.wall, COL.doorFrame, dx, 0, -.02, .12, H.wall + H.cap + .16, H.wallT + .04));
  }
}

/* The checker is what stops a 20x18 carpet reading as one flat slab under a
   directional light that hits every tile identically. */
function carpet(parts, x0, z0, w, h, base) {
  parts.push(flat(MAT.carpet, base, x0, 0, z0, w, h));
  for (let x = 0; x < w; x++) for (let z = 0; z < h; z++)
    if ((x + z) & 1) parts.push(flat(MAT.carpet, COL.carpetAlt, x0 + x, .003, z0 + z, 1, 1));
}

/* One geometry for EVERY team room. floor.js guarantees all rooms are ROOM_W x
   ROOM_H with the same interior at the same local offsets, so this is read off
   whichever room happens to arrive first and then instanced for all of them. */
export function buildRoomShell(Floor, r) {
  const W = Floor.ROOM_W, Hh = Floor.ROOM_H;
  const parts = [];
  carpet(parts, 1, 1, W - 2, Hh - 2, COL.carpet);
  for (const k in r.zones) {
    const z = r.zones[k];
    const tint = k === 'boss' ? COL.carpetBoss
               : k === 'break' || k === 'lounge' ? COL.carpetBreak
               : k === 'aisle' ? COL.carpetAisle : null;
    if (tint) parts.push(flat(MAT.carpet, tint, z.x - r.gx, .006, z.y - r.gy, z.w, z.h));
  }
  walls(parts, W, Hh, r.door.x - r.gx);
  const rel = d => ({ x: d.x - r.gx, z: d.y - r.gy, sx: d.seat.x - r.gx, sz: d.seat.y - r.gy });
  for (const d of r.desks.concat([r.boss])) {
    const q = rel(d);
    parts.push(...deskParts(q.x, q.z, { x: q.sx, z: q.sz }, d === r.boss));
    parts.push(...chairParts(q.sx, q.sz, d.dir));
  }
  return mergeParts(parts);
}

/* Facilities vary in width but not in height or door rule, so the shell is shared
   by every facility of the same width. coworking is the exception: it is the only
   facility with a.desks, so it gets its own shell keyed on kind — see shellKey. */
export const shellKey = a => 'fac|' + (a.desks ? a.kind : a.w);

export function buildFacilityShell(Floor, a) {
  const parts = [];
  carpet(parts, 1, 1, a.w - 2, Floor.AM_H - 2, COL.carpetFac);
  walls(parts, a.w, Floor.AM_H, -1);   // the door is on the south wall, which is not drawn
  /* Only coworking has desks. Its chairs arrive as 'chair' props (floor.js sit()s
     them so the seat tile stays walkable), so bake the desk and leave the chair. */
  for (const d of a.desks || [])
    parts.push(...deskParts(d.x - a.gx, d.y - a.gy,
                            { x: d.seat.x - a.gx, z: d.seat.y - a.gy }, false));
  return mergeParts(parts);
}

export { H };
