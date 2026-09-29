#!/usr/bin/env node
/* test_view3d.mjs — the 3D layer, without a GPU.   Run:  node test_view3d.mjs

   Node has no WebGL, so View3D.init() and View3D.render() cannot run: they are the
   only two entry points this suite never calls. Everything else in view3d/ is pure
   or only needs three.js's CPU side, and that is where the bugs are — geometry per
   prop type and footprint, which wall a picture hangs on, which way a chair faces,
   the camera basis, the reconciliation of scene against world, the LOD rule, the walk
   rate against the clip's baked stride, and the variety 135 people are built from.

   Four things are pulled out of their modules rather than reimplemented:
     - scene.js's build/sync helpers are sliced out of the shipped source and run
       with fake batches. Reimplementing them here would test this file, not that one.
     - characters.js is driven through its real createCharacters()/sync() surface,
       with the real rig parsed from the .glb, so SkeletonUtils.clone is exercised.
     - office.js is evaluated in a vm with a stub 2D context and its drawPerson
       replaced by a recorder, so section X compares the two views' OWN answers.
     - every measured number (the clip's baked stride, walkRef, the rig's heights)
       comes from assets/manifest.json or the live options object. A literal copied
       into this file is how three files drift apart and both suites keep passing.

   It is an .mjs because view3d/ is ES modules; floor.js / sim.js / office.js are
   plain scripts and are loaded the way each of them expects.

   Known gaps this suite characterises rather than demands are at the bottom.      */

import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import * as Props from './view3d/props.js';
import { MAT, COL, deptColor, amColor, plateMaterial, personPalette, DIM, NEUTRAL }
  from './view3d/materials.js';
import { createCharacters, chooseFull, buildOf, walkScale, CLIP_FOR, GESTURE_KEYS }
  from './view3d/characters.js';

/* A second, independent props.js: it shouts once per unknown type per module
   instance, so probing the same type twice through one instance is silent. */
const FreshProps = await import('./view3d/props.js?probe');

const require = createRequire(import.meta.url);
const Floor = require('./floor.js');
const Sim = require('./sim.js');
const { St } = Sim;

/* ------------------------------------------------------------- harness --- */
const FAILS = [];
async function check(id, what, fn) {
  /* awaited: loading the rig is async, and an un-awaited body would print PASS
     before its first assertion ran and turn a failure into an unhandled rejection */
  try { await fn(); console.log('PASS  %s  %s', id, what); }
  catch (e) { FAILS.push(id); console.log('FAIL  %s  %s  ->  %s', id, what, e.message); }
}

/* props.js shouts on console.error and warns once per type; a check that means to
   provoke it says so, and any other shout is a failure of the check that caused it. */
let shouts = [];
const realError = console.error, realWarn = console.warn;
console.error = (...a) => shouts.push(a.join(' '));
console.warn = (...a) => shouts.push(a.join(' '));
process.on('exit', () => { console.error = realError; console.warn = realWarn; });

/* the contract's prop vocabulary, verbatim, plus the two floor.js still emits */
const VOCAB = ('counter coffee vending table roundtable longtable chair sofa lowtable ' +
  'shelf cabinet printer cooler plant planter stall sink booth rack screen whiteboard ' +
  'art logo menu mirror rug locker bin pod bossdesk').split(' ');

/* every rect a renderer switches on: a facility as floor.js hands it over, and a
   team room reshaped into the same {gx,gy,w,h,props,desks} the 3D layer passes down */
const asRect = r => ({ gx: r.gx, gy: r.gy, w: r.w, h: r.h, props: r.props,
                       desks: r.desks, kind: r.kind });
const allRects = () => [...Floor.state.amenities,
                        ...Object.values(Floor.state.rooms).map(asRect)];

function freshWorld(sids = [['s1', 'alpha'], ['s2', 'alpha'], ['s3', 'beta']]) {
  Floor.reset();
  for (const [sid, proj] of sids) Floor.ensureRoom(sid, proj);
  return Floor.state;
}

/* One tool per station, so a fixture reaches every p.state rather than only 'type':
   Grep -> the archive, Task -> the meeting area, WebFetch -> the lounge or a break. */
const TOOLS = ['Read', 'Grep', 'Task', 'WebFetch', 'Edit', 'Bash'];

/* a headless sim world: `n` teammates in one session, all busy at time `t` */
function freshSim(n, t = 100, si = 2) {
  Floor.reset();
  let seq = 0;
  Object.assign(St, {
    sessions: {}, agentMeta: {}, events: [], people: {},
    t0: 0, t1: 1e12, clock: 0, live: false, playing: true, si,
    scanFrom: 0, since: 0, q: '', ff: false, catchUp: false, focus: null, wall: 0,
  });
  Sim.hooks.say = () => {};
  Sim.hooks.reset = () => {};
  St.sessions.s1 = { sid: 's1', proj: 'alpha', title: 'Invoice PDF rewrite',
                     branch: 'feat/x', cwd: '', model: '', agents: [] };
  St.events = Array.from({ length: n }, (_, i) =>
    ({ t, sid: 's1', aid: 'a' + i, kind: 'tool', tool: TOOLS[i % TOOLS.length],
       say: 'reading x', seq: ++seq }));
  St.clock = t + 50;
  for (let i = 0; i < 8; i++) Sim.advance(1 / 60);
  return Object.values(St.people);
}

/* =========================================================== P. geometry === */
/* Every type at every footprint floor.js could ask for. A prop that builds nothing
   is an invisible obstacle: the tile is blocked but there is no furniture on it. */
await check('P1', 'every contract prop type builds valid buffers at five footprints', () => {
  shouts = [];
  let tris = 0, built = 0;
  for (const t of VOCAB) {
    if (Props.SKIP.has(t) || t === 'rug') continue;      // see P3 and P4
    for (const [w, h] of [[1, 1], [3, 1], [1, 4], [4, 2], [8, 2]]) {
      const buckets = Props.buildProp(t, w, h, { art: 3 });
      assert(buckets.length > 0, `${t} ${w}x${h} produced no buckets`);
      for (const b of buckets) {
        const n = b.geometry.attributes.position.count;
        assert(n > 0 && n % 3 === 0, `${t} ${w}x${h} vertex count ${n} is not whole triangles`);
        assert.strictEqual(b.geometry.attributes.color.count, n, `${t} colour attr mismatch`);
        assert.strictEqual(b.geometry.attributes.normal.count, n, `${t} normal attr mismatch`);
        const bs = b.geometry.boundingSphere;
        assert(bs && isFinite(bs.radius) && bs.radius > 0, `${t} ${w}x${h} bounds are not finite`);
        assert(b.material, `${t} bucket has no material`);
        tris += n / 3;
      }
      built++;
    }
  }
  assert.strictEqual(shouts.length, 0, 'unexpected console output: ' + shouts.join(' | '));
  console.log('        %d type+footprint builds, %d triangles', built, tris);
});

await check('P2', 'the real floor emits nothing props.js has no geometry for', () => {
  freshWorld();
  shouts = [];
  const combos = new Set();
  for (const rect of allRects()) for (const pr of rect.props) {
    combos.add(`${pr.type}|${pr.w}x${pr.h}`);
    if (Props.SKIP.has(pr.type)) continue;
    const deco = Props.WALL_DECO.has(pr.type);
    const side = deco ? Props.wallSideOf(pr, rect) : null;
    const b = Props.buildProp(pr.type, pr.w, pr.h,
      deco ? { art: pr.art, standing: !side } : {});
    assert(b.length > 0, `${pr.type} ${pr.w}x${pr.h} built nothing`);
  }
  assert.strictEqual(shouts.length, 0, 'props.js shouted: ' + shouts.join(' | '));
  console.log('        %d type+footprint combos on the real floor, all covered', combos.size);
});

await check('P3', 'pod and bossdesk are skipped — the shells already draw them', () => {
  assert.deepStrictEqual([...Props.SKIP].sort(), ['bossdesk', 'pod']);
  // and a room shell really does carry the desks pod/bossdesk stand for
  freshWorld();
  const r = Floor.state.rooms.s1;
  const shell = Props.buildRoomShell(Floor, r);
  const verts = shell.reduce((n, b) => n + b.geometry.attributes.position.count, 0);
  assert(verts > 2000, 'room shell is too small to contain 24 desks and a boss desk');
});

await check('P4', 'rug is the one contract type with no geometry, and the floor emits none', () => {
  shouts = [];
  Props.buildProp('rug', 2, 2, {});
  assert.strictEqual(shouts.length, 1, 'rug should shout exactly once (ADDENDUM 1: unused)');
  freshWorld();
  const rugs = allRects().flatMap(r => r.props).filter(p => p.type === 'rug');
  assert.strictEqual(rugs.length, 0, 'floor.js emitted a rug, which would block a tile');
  shouts = [];
  for (const t of VOCAB) {
    if (Props.SKIP.has(t) || t === 'rug') continue;
    Props.buildProp(t, 1, 1, { art: 0 });
  }
  assert.strictEqual(shouts.length, 0, 'another type has no geometry: ' + shouts.join(' | '));
});

await check('P5', 'no prop sinks through the floor or spills past its own footprint', () => {
  freshWorld();
  /* A prop is built with its min corner at the origin and translated to (x,0,y), so
     anything outside [0,w] x [0,h] overlaps the neighbouring tile, and anything below
     y=0 is under the carpet. Foliage is allowed to overhang its pot; furniture is not. */
  const FOLIAGE = new Set(['plant', 'planter']);
  const spill = new Map();
  for (const rect of allRects()) for (const pr of rect.props) {
    if (Props.SKIP.has(pr.type) || Props.WALL_DECO.has(pr.type)) continue;
    for (const b of Props.buildProp(pr.type, pr.w, pr.h, {})) {
      b.geometry.computeBoundingBox();
      const bb = b.geometry.boundingBox;
      assert(bb.min.y > -1e-6, `${pr.type} ${pr.w}x${pr.h} dips to y=${bb.min.y}`);
      const out = Math.max(-bb.min.x, -bb.min.z, bb.max.x - pr.w, bb.max.z - pr.h);
      if (out > 1e-6) spill.set(`${pr.type}|${pr.w}x${pr.h}`,
        Math.max(spill.get(`${pr.type}|${pr.w}x${pr.h}`) || 0, out));
    }
  }
  for (const [k, v] of spill) {
    assert(FOLIAGE.has(k.split('|')[0]), `${k} overhangs its footprint by ${v.toFixed(3)} tiles`);
    assert(v < 0.35, `${k} foliage overhangs ${v.toFixed(3)} tiles — into the next tile`);
  }
  console.log('        overhanging (foliage only): %s', [...spill.keys()].join(' ') || 'none');
});

await check('P6', 'wall decoration stays inside its own tile, mounted and free-standing', () => {
  freshWorld();
  for (const rect of allRects()) for (const pr of rect.props) {
    if (!Props.WALL_DECO.has(pr.type)) continue;
    for (const standing of [false, true]) {
      for (const b of Props.buildProp(pr.type, 1, 1, { art: pr.art, standing })) {
        b.geometry.computeBoundingBox();
        const bb = b.geometry.boundingBox;
        const out = Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x),
                             Math.abs(bb.min.z), Math.abs(bb.max.z));
        assert(out <= 0.5 + 1e-6,
          `${pr.type} standing=${standing} reaches ${out.toFixed(3)} from the tile centre`);
        assert(bb.min.y > -1e-6, `${pr.type} standing=${standing} hangs below the floor`);
      }
    }
  }
});

await check('P7', 'H.seat, H.desk and H.wall are the measured values, not drifted', () => {
  assert.strictEqual(Props.H.seat, 0.44, 'seat plane must match the rig\'s seated pelvis');
  assert.strictEqual(Props.H.desk, 0.72, 'desk height must match the rig\'s seated reach');
  assert.strictEqual(Props.H.wall, 1.25, 'wall height is the depth budget — see props.js H');
  const seat = Props.buildProp('chair', 1, 1, {});
  let top = -Infinity, bottom = Infinity;
  for (const b of seat) {
    b.geometry.computeBoundingBox();
    top = Math.max(top, b.geometry.boundingBox.max.y);
    bottom = Math.min(bottom, b.geometry.boundingBox.min.y);
  }
  assert(Math.abs(top - Props.H.seatBack) < 1e-6, `chair tops at ${top}, not H.seatBack`);
  assert(bottom > -1e-6, 'chair legs go through the floor');
});

/* P1 walks the CONTRACT vocabulary, so a type added to props.js but not to the
   contract would be built by nobody and tested by nobody. Keys come off the shipped
   source because a list written here drifts the moment somebody adds a prop. */
await check('P8', 'every type props.js implements is one P1 actually builds', () => {
  const src = readFileSync(new URL('./view3d/props.js', import.meta.url), 'utf8');
  const from = src.indexOf('const BUILD = {');
  assert(from >= 0, 'props.js no longer declares a BUILD table');
  const body = src.slice(from, src.indexOf('\n};', from));
  /* one entry per line at two-space indent: `name(w, h) {` or `name: ...` */
  const keys = [...body.matchAll(/^ {2}([a-z][a-z0-9]*)\s*[:(]/gm)].map(m => m[1]);
  /* plus aliases assigned after the table, e.g. BUILD.board = BUILD.whiteboard */
  for (const m of src.matchAll(/^BUILD\.([a-z][a-z0-9]*)\s*=/gm)) keys.push(m[1]);
  assert(keys.length > 20, `only ${keys.length} BUILD entries parsed — the shape changed`);
  const covered = new Set(VOCAB.concat([...Props.WALL_DECO]));
  const untested = keys.filter(k => !covered.has(k));
  assert.deepStrictEqual(untested, [],
    'props.js implements these and nothing builds them at five footprints: ' +
    untested.join(' ') + ' — add them to VOCAB here, and to the contract');
  console.log('        %d BUILD entries, all inside the vocabulary P1 sweeps', keys.length);
});

/* Clutter is a second geometry table, so it needs P1's guarantees again. One bucket
   per piece is the promise that a mug costs one draw call for the whole floor. */
await check('P9', 'every clutter piece is one bucket, resting on its own origin', () => {
  const src = readFileSync(new URL('./view3d/props.js', import.meta.url), 'utf8');
  const from = src.indexOf('const CLUTTER = {');
  assert(from >= 0, 'props.js no longer declares a CLUTTER table');
  const body = src.slice(from, src.indexOf('\n};', from));
  const types = [...body.matchAll(/^ {2}([a-z][a-z0-9]*)\s*[:(]/gm)].map(m => m[1]);
  assert(types.length >= 4, `only ${types.length} clutter types parsed — the shape changed`);
  shouts = [];
  for (const t of types) {
    const bs = Props.buildClutter(t);
    assert.strictEqual(bs.length, 1,
      `${t} merges into ${bs.length} buckets — one piece must be one draw call for the ` +
      'whole floor, or the vocabulary costs a call per material per type');
    const g = bs[0].geometry;
    const n = g.attributes.position.count;
    assert(n > 0 && n % 3 === 0, `${t} vertex count ${n} is not whole triangles`);
    assert.strictEqual(g.attributes.color.count, n, `${t} colour attr mismatch`);
    assert.strictEqual(g.attributes.normal.count, n, `${t} normal attr mismatch`);
    assert(g.boundingSphere && isFinite(g.boundingSphere.radius), `${t} bounds are not finite`);
    g.computeBoundingBox();
    const bb = g.boundingBox;
    assert(bb.min.y > -1e-6, `${t} dips to y=${bb.min.y.toFixed(3)} — the caller ` +
      'translates to the surface, so it would sink into it');
    // desk slots are .3 apart; the jacket is tile-framed like a chair, not centred
    const r = Math.max(bb.max.x, bb.max.z, -bb.min.x, -bb.min.z);
    if (t !== 'jacket') assert(r < 0.25,
      `${t} reaches ${r.toFixed(3)} from its own origin — it will hang off the desk`);
    else assert(bb.min.x >= -1e-6 && bb.max.x <= 1 + 1e-6 &&
                bb.min.z >= -1e-6 && bb.max.z <= 1 + 1e-6,
      'the jacket is tile-framed and must stay inside its own tile');
  }
  assert.strictEqual(shouts.length, 0, 'props.js shouted: ' + shouts.join(' | '));
  console.log('        %d clutter types, one bucket each: %s', types.length, types.join(' '));
});

/* ======================================================= N. negative props === */
await check('N1', 'a prop type nobody implemented shouts once and draws a marker', () => {
  shouts = [];
  const a = Props.buildProp('flumph', 2, 3, {});
  assert.strictEqual(shouts.length, 1, 'expected exactly one shout, got ' + shouts.length);
  assert(/flumph/.test(shouts[0]), 'the shout does not name the type');
  assert(a.length === 1 && a[0].geometry.attributes.position.count > 0,
    'an unknown type drew nothing — a blocked tile with no furniture on it');
  shouts = [];
  Props.buildProp('flumph', 2, 3, {});
  assert.strictEqual(shouts.length, 0, 'it shouts again every frame');
});

await check('N2', 'a facility kind nobody implemented still gets a shell', () => {
  freshWorld();
  const fake = { kind: 'gymnasium', label: 'GYM', gx: 5, gy: 1, w: 12, h: Floor.AM_H,
                 props: [], seats: [], claims: {} };
  shouts = [];
  assert.strictEqual(Props.shellKey(fake), 'fac|12', 'shellKey should fall back to the width');
  const s = Props.buildFacilityShell(Floor, fake);
  assert(s.length > 0 && s.every(b => b.geometry.attributes.position.count > 0),
    'an unimplemented kind drew no shell');
  assert.strictEqual(shouts.length, 0, 'shouted on a kind it handles fine: ' + shouts.join(' | '));
});

await check('N3', 'art out of range: 0..8 and anything above it resolve to a picture', () => {
  assert.strictEqual(COL.art.length, 9, 'floor.js numbers its art 0..8; the palette must cover it');
  const pairs = new Set(COL.art.map(p => p[0].getHexString() + p[1].getHexString()));
  assert.strictEqual(pairs.size, 9, 'two art indices share a picture');
  shouts = [];
  for (const art of [0, 4, 8, 9, 99, 1e6, undefined, null, 'x', NaN, 1.5])
    assert(Props.buildProp('art', 1, 1, { art }).length > 0, 'art=' + art + ' drew nothing');
  assert.strictEqual(shouts.length, 0, 'a stray art index shouted: ' + shouts.join(' | '));
  /* was GAP 1: a NEGATIVE index threw, because `(x.art | 0) % 9` is -1 for art:-1
     and COL.art[-1] is undefined. Now floored modulo. Kept as a positive guard so
     the plain `%` cannot come back. */
  for (const art of [-1, -9, -10, -1e6])
    assert(Props.buildProp('art', 1, 1, { art }).length > 0, 'art=' + art + ' drew nothing');
  assert.strictEqual(shouts.length, 0, 'a negative art index shouted: ' + shouts.join(' | '));
});

await check('N4', 'the real floor never emits a prop without a footprint', () => {
  freshWorld();
  for (const rect of allRects()) for (const pr of rect.props) {
    assert(Number.isInteger(pr.w) && pr.w >= 1, `${pr.type} has w=${pr.w}`);
    assert(Number.isInteger(pr.h) && pr.h >= 1, `${pr.type} has h=${pr.h}`);
    assert(Number.isInteger(pr.x) && Number.isInteger(pr.y), `${pr.type} has a fractional tile`);
  }
  /* was GAP 2: a missing footprint produced NaN geometry silently, and a NaN
     bounding sphere takes the WHOLE instanced batch off screen, not one prop. Now
     clamped to 1x1. Kept as a positive guard — this failure mode is invisible. */
  const clamped = Props.buildProp('table', undefined, undefined, {});
  assert(clamped.length > 0, 'a footprint-less prop drew nothing at all');
  for (const b of clamped)
    assert(isFinite(b.geometry.boundingSphere.radius),
      'NaN bounding sphere is back — the entire batch would vanish, not just this prop');
});

/* ======================================================= W. walls, chairs === */
await check('W1', 'wallSideOf resolves all four sides on the real floor', () => {
  const F = freshWorld();
  const fac = k => F.amenities.find(a => a.kind === k);
  const wr = fac('washrooms'), sr = fac('serverroom'), bd = fac('boardroom');
  const mirrors = wr.props.filter(p => p.type === 'mirror');
  assert(mirrors.length > 0 && mirrors.every(m => Props.wallSideOf(m, wr) === 'W'),
    'washroom mirrors should read as the WEST wall');
  assert(sr.props.filter(p => p.type === 'screen').every(s => Props.wallSideOf(s, sr) === 'S'),
    'the server room glazing should read as the SOUTH wall');
  assert.strictEqual(Props.wallSideOf(bd.props.find(p => p.type === 'screen'), bd), 'N',
    'the boardroom projector should read as the NORTH wall');
  assert.strictEqual(Props.wallSideOf(bd.props.find(p => p.type === 'whiteboard'), bd), 'W',
    'the boardroom whiteboard should read as the WEST wall');
  const mid = { x: bd.gx + 4, y: bd.gy + 4 };
  assert.strictEqual(Props.wallSideOf(mid, bd), null, 'a prop in the open is on no wall');
});

await check('W2', 'every wall deco is on a wall, or is deliberately free-standing', () => {
  const F = freshWorld();
  const standing = [];
  for (const rect of allRects()) for (const pr of rect.props) {
    if (!Props.WALL_DECO.has(pr.type)) continue;
    if (Props.wallSideOf(pr, rect) === null) standing.push(pr.type);
  }
  /* office.js and scene.js both give a board with no wall its own legs; anything
     ELSE floating in mid-air is a placement bug in floor.js */
  assert(standing.every(t => t === 'board' || t === 'whiteboard'),
    'these hang in mid-air with no wall behind them: ' + [...new Set(standing)].join(' '));
  assert(F.amenities.length === 11, 'the band should have 11 facilities');
});

await check('W3', 'chairs do not block, and sit ON their seat tile (ADDENDUM 1)', () => {
  const F = freshWorld();
  for (const a of F.amenities) for (const pr of a.props) {
    if (pr.type !== 'chair') continue;
    assert(Floor.walkable(pr.x, pr.y),
      `${a.kind}: the chair tile ${pr.x},${pr.y} is blocked — the seat it exists to give is trapped`);
    assert(a.seats.some(s => s.x === pr.x && s.y === pr.y) ||
           (a.desks || []).some(d => d.seat.x === pr.x && d.seat.y === pr.y),
      `${a.kind}: a chair at ${pr.x},${pr.y} that is not a seat`);
  }
});

/* ============================================================== C. camera === */
/* The camera constants are not exported, so they are read off the shipped source.
   Hardcoding the numbers here would let scene.js drift and still pass. */
const SCENE_SRC = readFileSync(new URL('./view3d/scene.js', import.meta.url), 'utf8');
const sceneNum = (name) => {
  const m = SCENE_SRC.match(new RegExp('const ' + name + ' = ([^;]+);'));
  assert(m, 'scene.js no longer declares ' + name);
  // eslint-disable-next-line no-new-func
  return new Function('return ' + m[1])();
};

await check('C1', 'the screen basis matches a real OrthographicCamera at the same angle', () => {
  const ELEV = sceneNum('ELEV');
  const OFFSET = new THREE.Vector3(Math.cos(ELEV) * Math.SQRT1_2, Math.sin(ELEV),
                                   Math.cos(ELEV) * Math.SQRT1_2);
  const cam = new THREE.OrthographicCamera(-10, 10, 10, -10, 1, 1000);
  cam.position.copy(OFFSET).multiplyScalar(600);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  const right = new THREE.Vector3(), up = new THREE.Vector3(), back = new THREE.Vector3();
  cam.matrixWorld.extractBasis(right, up, back);
  const RIGHT = new THREE.Vector3(Math.SQRT1_2, 0, -Math.SQRT1_2);
  const UPC = new THREE.Vector3(-Math.sin(ELEV) * Math.SQRT1_2, Math.cos(ELEV),
                                -Math.sin(ELEV) * Math.SQRT1_2);
  assert(right.distanceTo(RIGHT) < 1e-6, `RIGHT is ${right.toArray()}, scene.js says ${RIGHT.toArray()}`);
  assert(up.distanceTo(UPC) < 1e-6, `UPC is ${up.toArray()}, scene.js says ${UPC.toArray()}`);
  assert(SCENE_SRC.includes('Math.SQRT1_2, 0, -Math.SQRT1_2'),
    'scene.js RIGHT no longer matches the vector this check derives');
});

await check('C2', 'the 3D tile ratio is exactly office.js\'s TW/TH, so the two views line up', () => {
  const office = readFileSync(new URL('./office.js', import.meta.url), 'utf8');
  const m = office.match(/TW\s*=\s*(\d+(?:\.\d+)?)\s*,\s*TH\s*=\s*(\d+(?:\.\d+)?)/);
  assert(m, 'office.js no longer declares TW and TH together');
  const want = Number(m[1]) / Number(m[2]);
  const ELEV = sceneNum('ELEV');
  /* an ortho camera at azimuth 45 projects one unit of world x to 1/sqrt2 across and
     sin(e)/sqrt2 down, so the on-screen tile ratio is 1/sin(e) : 1 */
  const got = 1 / Math.sin(ELEV);
  assert(Math.abs(got - want) < 1e-9,
    `3D projects ${got.toFixed(4)}:1, office.js draws ${want.toFixed(4)}:1 — ` +
    'atan(0.5) gives 2.2361 and true isometric gives 1.7321; only asin(0.5) matches');
  console.log('        tile ratio %s : 1 in both views', got.toFixed(4));
});

await check('C3', '+x reads right-and-down and +z left-and-down, like office.js\'s iso()', () => {
  const ELEV = sceneNum('ELEV');
  const RIGHT = new THREE.Vector3(Math.SQRT1_2, 0, -Math.SQRT1_2);
  const UPC = new THREE.Vector3(-Math.sin(ELEV) * Math.SQRT1_2, Math.cos(ELEV),
                                -Math.sin(ELEV) * Math.SQRT1_2);
  const on = v => ({ r: RIGHT.dot(v), d: -UPC.dot(v) });
  const px = on(new THREE.Vector3(1, 0, 0)), pz = on(new THREE.Vector3(0, 0, 1));
  assert(px.r > 0 && px.d > 0, '+x must go right and down');
  assert(pz.r < 0 && pz.d > 0, '+z must go left and down');
  assert(Math.abs(px.d - pz.d) < 1e-9, 'x and z must fall at the same rate or the grid shears');
  const up = on(new THREE.Vector3(0, 1, 0));
  assert(Math.abs(up.r) < 1e-9 && up.d < 0, '+y must go straight up the screen');
});

await check('C4', 'OrbitControls is pinned to the dimetric angle on every axis', () => {
  assert(/minPolarAngle = controls\.maxPolarAngle/.test(SCENE_SRC),
    'the polar angle is not locked — a drag can leave the dimetric projection');
  assert(/minAzimuthAngle = controls\.maxAzimuthAngle/.test(SCENE_SRC),
    'the azimuth is not locked');
  assert(/enableRotate = false/.test(SCENE_SRC), 'rotation is not disabled');
  assert(/frustumCulled = false/.test(SCENE_SRC),
    'an InstancedMesh bounding sphere is the geometry\'s, at the origin: culling must be off');
});

/* ====================================================== V. reconciliation === */
/* scene.js's build and sync helpers, sliced out of the shipped source and run
   against fake batches: everything init() would have built can be faked, a WebGL
   context cannot.

   The slice runs inside `with (ENV)`, and ENV is a Proxy that falls through to the
   real globals and throws a named error for anything else. scene.js grows helpers
   while this suite is being written, so a new one is a one-line addition here with a
   message saying which, rather than a bare "x is not defined". */
const V = (() => {
  const from = SCENE_SRC.indexOf('function chairDir');
  const to = SCENE_SRC.indexOf('/* ------------------------------------------------------------------ labels ---');
  if (from < 0 || to < 0 || to < from) return null;
  const body = SCENE_SRC.slice(from, to);
  const want = ['chairDir', 'addProp', 'buildRoom', 'buildFacility', 'syncDepts',
                'syncFocus', 'syncGlow'];
  if (!want.every(n => body.includes('function ' + n))) return null;

  const pushed = [], recolored = [];
  class Fake {
    constructor(key) { this.key = key; this.n = 0; this.items = []; }
    push(m, c) {
      const it = { key: this.key, m: m.clone(), c: c.clone(), i: this.n };
      this.items.push(it); pushed.push(it);
      return this.n++;
    }
    recolor(i, c) {
      if (this.items[i]) this.items[i].c = c.clone();
      recolored.push({ key: this.key, i, c: c.clone() });
    }
    reset() { this.n = 0; this.items.length = 0; }
  }
  const made = new Map();
  const ELEV = sceneNum('ELEV'), AZIMUTH = sceneNum('AZIMUTH');
  const store = {
    THREE, Props, MAT, COL, deptColor, amColor, plateMaterial, DIM, NEUTRAL,
    ELEV, AZIMUTH,
    OFFSET: new THREE.Vector3(Math.cos(ELEV) * Math.SQRT1_2, Math.sin(ELEV),
                              Math.cos(ELEV) * Math.SQRT1_2),
    batch: (key, build) => {
      let b = made.get(key);
      if (!b) { made.set(key, b = new Fake(key)); b.buckets = build(); }
      return b;
    },
    T: new THREE.Matrix4(), R: new THREE.Matrix4(), S: new THREE.Matrix4(),
    roomIdx: new Map(), facDone: new Set(), deptPlates: new Map(),
    scene: { add() {}, remove() {} },
    slab: () => ({ geometry: { dispose() {} } }),
    GROUND: {}, CORRIDOR: {},
    SEAT_LIKE: new Set(['table', 'roundtable', 'longtable']),
    SIDE_ROT: { N: 0, S: Math.PI, W: Math.PI / 2, E: -Math.PI / 2 },
    DIR_ROT: [0, -Math.PI / 2, Math.PI, Math.PI / 2],
    /* the module-level `let`s the slice assigns to; as ENV properties they persist
       between calls exactly as they do inside scene.js */
    shellBatch: null, glowBatch: null, screenBatch: null,
    lastFocus: undefined, lastQ: undefined,
    bandPlate: null, roomPlate: null, corridorMesh: null,
  };
  const ENV = new Proxy(store, {
    has: () => true,
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'symbol') return undefined;
      if (k in globalThis) return globalThis[k];
      throw new Error('scene.js now references `' + String(k) + '` - add it to the V harness');
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  let fns;
  try {
    fns = new Function('ENV',
      'with (ENV) {\n' + body + '\nreturn { ' + want.join(', ') +
      /* the glow's own size table, if it still goes by that name */
      ", MONITOR: typeof MONITOR === 'undefined' ? null : MONITOR };\n}")(ENV);
  } catch (e) { return null; }
  const reset = () => {
    pushed.length = recolored.length = 0;
    for (const b of made.values()) b.reset();     // kept registered: the slice still
    store.roomIdx.clear();                        // holds shellBatch and glowBatch
    store.facDone.clear();
    store.deptPlates.clear();
  };
  return { ...fns, store, made, pushed, recolored, reset,
           roomIdx: store.roomIdx, facDone: store.facDone, deptPlates: store.deptPlates,
           at: it => new THREE.Vector3().setFromMatrixPosition(it.m),
           /* where a prop's own centre ended up: the invariant that holds for a plain
              translate and for a rotate-about-the-tile-centre alike */
           centre: (it, local) => local.clone().applyMatrix4(it.m) };
})();

if (!V) {
  FAILS.push('V*');
  console.log('FAIL  V*  scene.js source changed shape — the slice harness needs updating ' +
              '(this is an in-progress edit, not a defect)');
}

const vcheck = (id, what, fn) => (V ? check(id, what, fn) : Promise.resolve());

await vcheck('V1', 'one shell geometry for every team room, one per facility width', () => {
  V.reset();
  const F = freshWorld();
  for (const a of F.amenities) V.buildFacility(a, Floor);
  for (const sid in F.rooms) V.buildRoom(F.rooms[sid], Sim, Floor);
  assert.strictEqual(V.roomIdx.size, 3, 'not every room got a shell instance');
  assert.strictEqual(V.facDone.size, 11, 'not every facility was built');
  assert.strictEqual(V.made.get('room').items.length, 3,
    'the room shell is not instanced — one geometry must serve every room');
  const shells = [...V.made.keys()].filter(k => k.startsWith('fac|'));
  assert.strictEqual(shells.length, 8,
    `11 facilities should share 8 shells (7 widths + coworking), got ${shells.length}: ${shells}`);
  assert.strictEqual(V.made.get('fac|coworking').items.length, 1,
    'coworking must not share a shell — it is the only facility with desks');
  console.log('        %d batches for 3 rooms + 11 facilities, %d instances',
    V.made.size, V.pushed.length);
});

await vcheck('V2', 'every room shell instance lands on its own room\'s NW corner', () => {
  const F = Floor.state;
  const shell = V.made.get('room');
  for (const [sid, i] of V.roomIdx) {
    const p = V.at(shell.items[i]);
    assert.strictEqual(p.x, F.rooms[sid].gx, `${sid} shell x ${p.x} != gx ${F.rooms[sid].gx}`);
    assert.strictEqual(p.z, F.rooms[sid].gy, `${sid} shell z ${p.z} != gy ${F.rooms[sid].gy}`);
    assert.strictEqual(p.y, 0, 'a room shell is not on the ground');
  }
});

await vcheck('V3', 'every prop instance ends up centred on the tiles floor.js gave it', () => {
  const F = Floor.state;
  /* Three conventions meet here, and getting one wrong slides a whole prop type off
     by half a tile: a floor prop is built min-corner-at-origin and translated; wall
     deco is built tile-centred and rotated about that centre; a chair is built
     min-corner but rotated about its tile centre. So the invariant is not the
     matrix's translation — it is where the prop's OWN centre lands. */
  const V3 = new THREE.Vector3();
  for (const rect of [...F.amenities, ...Object.values(F.rooms).map(asRect)]) {
    for (const pr of rect.props) {
      if (Props.SKIP.has(pr.type)) continue;
      V.reset();
      V.addProp(pr, rect, NEUTRAL);
      assert.strictEqual(V.pushed.length, 1, `${pr.type} produced ${V.pushed.length} instances`);
      const deco = Props.WALL_DECO.has(pr.type);
      const local = deco ? V3.set(0, 0, 0)
                  : pr.type === 'chair' ? V3.set(0.5, 0, 0.5)
                  : V3.set(pr.w / 2, 0, pr.h / 2);
      const got = V.centre(V.pushed[0], local);
      const wx = pr.x + (deco ? 0.5 : pr.type === 'chair' ? 0.5 : pr.w / 2);
      const wz = pr.y + (deco ? 0.5 : pr.type === 'chair' ? 0.5 : pr.h / 2);
      assert(Math.abs(got.x - wx) < 1e-9 && Math.abs(got.z - wz) < 1e-9,
        `${pr.type} ${pr.w}x${pr.h} at ${pr.x},${pr.y} centres on ` +
        `${got.x.toFixed(3)},${got.z.toFixed(3)} instead of ${wx},${wz}`);
      assert(Math.abs(got.y) < 1e-9, `${pr.type} is not on the ground`);
      if (pr.type === 'chair') {
        /* and it is spun to the facing chairDir asked for. Compared as a direction,
           not as an Euler angle: the XYZ decomposition of a yaw of exactly PI is
           ambiguous and reads back as 0. */
        const want = [0, -Math.PI / 2, Math.PI, Math.PI / 2][V.chairDir(pr, rect)];
        const got = new THREE.Vector3(0, 0, 1).transformDirection(V.pushed[0].m);
        const ref = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), want);
        assert(got.distanceTo(ref) < 1e-9,
          `chair at ${pr.x},${pr.y} faces ${got.x.toFixed(2)},${got.z.toFixed(2)}, ` +
          `chairDir asked for ${ref.x.toFixed(2)},${ref.z.toFixed(2)}`);
      }
    }
  }
});

await vcheck('V4', 'chairDir agrees with floor.js\'s own d.dir on every hot desk', () => {
  const cw = Floor.state.amenities.find(a => a.kind === 'coworking');
  assert(cw && cw.desks && cw.desks.length === 16, 'coworking should carry 16 hot desks');
  const NAME = ['N', 'E', 'S', 'W'];
  for (const d of cw.desks) {
    const chair = cw.props.find(p => p.type === 'chair' &&
                                     p.x === d.seat.x && p.y === d.seat.y);
    assert(chair, `no chair on hot-desk seat ${d.seat.x},${d.seat.y}`);
    const got = V.chairDir(chair, cw);
    assert.strictEqual(got, d.dir,
      `hot desk ${d.x},${d.y}: floor.js says ${NAME[d.dir]}, chairDir says ${NAME[got]}`);
  }
});

await vcheck('V5', 'boardroom and huddle chairs face what they are pulled up to', () => {
  const F = Floor.state;
  const tally = (a) => {
    const t = [0, 0, 0, 0];
    for (const p of a.props) if (p.type === 'chair') t[V.chairDir(p, a)]++;
    return t;
  };
  // a long table seats two facing rows plus one chair at each end
  assert.deepStrictEqual(tally(F.amenities.find(a => a.kind === 'boardroom')), [8, 1, 8, 1],
    'boardroom seating is not two rows plus two ends (N,E,S,W)');
  // each huddle pod is a ring round its own table: two each side, one each end
  assert.deepStrictEqual(tally(F.amenities.find(a => a.kind === 'huddle')), [2, 4, 2, 4],
    'huddle chairs do not ring their round tables (N,E,S,W)');
});

await vcheck('V6', 'a chair with nothing to face falls back to N rather than guessing', () => {
  const bare = { gx: 0, gy: 0, w: 6, h: 6, props: [], desks: [] };
  assert.strictEqual(V.chairDir({ x: 3, y: 3, w: 1, h: 1 }, bare), Floor.N);
  const far = { gx: 0, gy: 0, w: 20, h: 20, props: [{ type: 'table', x: 15, y: 15, w: 2, h: 2 }] };
  assert.strictEqual(V.chairDir({ x: 1, y: 1, w: 1, h: 1 }, far), Floor.N,
    'a table five tiles away should not turn a chair toward it');
  assert.strictEqual(V.chairDir({ x: 1, y: 1, w: 1, h: 1 }, { gx: 0, gy: 0, w: 4, h: 4 }), Floor.N,
    'a rect with no props and no desks at all');
});

await vcheck('V7', 'a focused floor dims every other room and lights the focused one', () => {
  V.reset();
  const F = freshWorld();
  for (const sid in F.rooms) V.buildRoom(F.rooms[sid], Sim, Floor);
  const shell = V.made.get('room');
  St.focus = null;
  V.syncFocus(Sim, F);
  for (const [sid, i] of V.roomIdx)
    assert.strictEqual(shell.items[i].c.getHexString(),
      deptColor(Sim.deptHue(F.rooms[sid].proj)).getHexString(),
      `${sid} is not its department colour with no focus`);
  St.focus = F.rooms.s1;
  V.syncFocus(Sim, F);
  assert.strictEqual(shell.items[V.roomIdx.get('s1')].c.getHexString(),
    deptColor(Sim.deptHue('alpha')).getHexString(), 'the focused room was dimmed');
  for (const sid of ['s2', 's3'])
    assert.strictEqual(shell.items[V.roomIdx.get(sid)].c.getHexString(), DIM.getHexString(),
      sid + ' was not dimmed behind the focus');
  St.focus = null;
});

/* was GAP 3. buildRoom and syncFocus each decided a room's tint independently and
   disagreed, so a session opening while you were inside a room appeared at full
   brightness for ever. Both now call one roomTint(). Any machine busy enough to
   start a session while you are reading a room hits this, so it is pinned. */
await vcheck('V8', 'a room that opens while another is focused comes up dimmed', () => {
  const F = Floor.state;
  St.focus = F.rooms.s1;
  V.syncFocus(Sim, F);                      // establishes lastFocus
  Floor.ensureRoom('s9', 'gamma');
  V.buildRoom(F.rooms.s9, Sim, Floor);
  V.syncFocus(Sim, F);
  const shell = V.made.get('room');
  const lit = deptColor(Sim.deptHue('gamma')).getHexString();
  const got = shell.items[V.roomIdx.get('s9')].c.getHexString();
  assert.notStrictEqual(got, lit,
    'a room built during a focus is at full department brightness again — GAP 3 is back');
  St.focus = null;
  V.syncFocus(Sim, F);
  assert.strictEqual(shell.items[V.roomIdx.get('s9')].c.getHexString(), lit,
    'and it must light back up once the focus is dropped');
});

await vcheck('V9', 'one department plate per department, rebuilt only when it gains a room', () => {
  V.reset();
  const F = freshWorld([['s1', 'alpha'], ['s2', 'alpha'], ['s3', 'beta']]);
  V.syncDepts(F, Sim);
  assert.deepStrictEqual([...V.deptPlates.keys()].sort(), ['alpha', 'beta']);
  assert.strictEqual(V.deptPlates.get('alpha').n, 2, 'alpha plate does not span both its rooms');
  const before = V.deptPlates.get('beta');
  V.syncDepts(F, Sim);
  assert.strictEqual(V.deptPlates.get('beta'), before, 'a plate was rebuilt with no new room');
  Floor.ensureRoom('s4', 'beta');
  V.syncDepts(F, Sim);
  assert.notStrictEqual(V.deptPlates.get('beta'), before, 'beta gained a room and kept its plate');
});

await vcheck('V10', 'a lit monitor is ON its own desk\'s screen, not a billboard beside it', () => {
  /* The reported bug was tile-sized quads floating next to the desks, placed from the
     desk tile's origin. So the assertions here are deliberately independent of the
     placement arithmetic: how big it is, that it is inside the desk's own footprint,
     that it is at monitor height, and that it is on the far side of the desk from the
     seat — which is where props.js deskParts() puts the monitor. */
  V.reset();
  const ppl = freshSim(12, 100);
  St.clock = 120;                            // inside IDLE, so everyone is still lit
  V.syncGlow(Sim);
  const glow = V.made.get('glow');
  const typing = ppl.filter(p => p.desk && !p.desk.hot);
  assert(typing.length > 0, 'nobody is typing — the fixture is wrong, not the code');
  assert.strictEqual(glow.items.length, typing.length,
    `${glow.items.length} glows for ${typing.length} typists`);

  /* The lit FACE is a monitor screen, so it is well under a tile and depth-tested.
     Anything else in the batch is a halo, which may be larger but must be additive:
     additive light can only add, where a translucent quad paints a character out. */
  const faces = glow.buckets.filter(b => b.material === MAT.monitor);
  assert.strictEqual(faces.length, 1, `${faces.length} lit-face buckets, expected one`);
  for (const b of glow.buckets) {
    b.geometry.computeBoundingBox();
    const size = b.geometry.boundingBox.getSize(new THREE.Vector3());
    if (b.material === MAT.monitor) {
      assert(size.x > 0.1 && size.x < 0.8 && size.y > 0.1 && size.y < 0.6,
        `the lit face is ${size.x.toFixed(2)}x${size.y.toFixed(2)} tiles — a billboard, not a screen`);
      assert(b.material.depthTest !== false,
        'the lit face must be depth-tested, or it bleeds through walls and characters');
      assert(!b.material.transparent,
        'the lit face is translucent; office.js repaints that monitor opaque');
    } else {
      assert(b.material.blending === THREE.AdditiveBlending,
        'a second glow bucket must be additive — a translucent quad paints over whoever ' +
        'is sitting there, which is the bug the first attempt shipped');
      assert(b.material.depthWrite === false, 'the halo must not write depth');
      assert(size.x < 2 && size.y < 2, `the halo is ${size.x.toFixed(2)} tiles across`);
    }
  }

  const faceY = V.at(glow.items[0]).y;
  const byDesk = new Map(typing.map(p => [p.desk, p]));
  for (const it of glow.items) {
    const g = V.at(it);
    // whose desk is it on? a desk is one tile, a boss desk two wide
    const owner = typing.find(p => {
      const w = p.boss ? 2 : 1;
      return g.x >= p.desk.x - 1e-9 && g.x <= p.desk.x + w + 1e-9 &&
             g.z >= p.desk.y - 1e-9 && g.z <= p.desk.y + 1 + 1e-9;
    });
    assert(owner, `a lit face at ${g.x.toFixed(2)},${g.z.toFixed(2)} is on nobody's desk`);
    byDesk.delete(owner.desk);
    assert(g.y > Props.H.desk && g.y < 1.53,
      `the lit face is at y=${g.y.toFixed(2)}: above the desk and below head height, or it is not a monitor`);
    // deskParts puts the monitor opposite the seat, so the lit face must be too
    const seatSide = Math.sign(owner.desk.seat.y - (owner.desk.y + 0.5));
    if (seatSide !== 0) assert(Math.sign(g.z - (owner.desk.y + 0.5)) === -seatSide,
      'the lit face is on the same side of the desk as the chair — behind the monitor');
  }
  assert.strictEqual(byDesk.size, 0, byDesk.size + ' typists got no lit monitor');

  V.syncGlow(Sim);
  assert.strictEqual(V.made.get('glow').items.length, typing.length,
    'the glow batch is not reset each frame — it doubles every frame');
  St.clock = 100 + Sim.IDLE + 1;
  V.syncGlow(Sim);
  assert.strictEqual(V.made.get('glow').items.length, 0,
    'a monitor stayed lit past IDLE with nobody working at it');
  console.log('        %d buckets; lit face %sx%s tiles, screen centre y=%s',
    glow.buckets.length, V.MONITOR ? V.MONITOR.w : '?', V.MONITOR ? V.MONITOR.h : '?',
    faceY.toFixed(3));
});

await vcheck('V11', 'no glow hangs over a hot-desk stand-in, which has no desk under it', () => {
  /* Past 24 room desks and 16 hot desks, floor.js's hotDesk() hands out a standing
     spot in the break or meeting zone. It is desk-shaped so claimDesk works on it,
     but nothing is BUILT there, so a lit monitor would float over bare carpet. */
  V.reset();
  const ppl = freshSim(60, 100);
  St.clock = 120;
  V.syncGlow(Sim);
  const hot = new Set(ppl.filter(p => p.desk && p.desk.hot).map(p => p.desk.x + ',' + p.desk.y));
  assert(hot.size > 0, '60 teammates should overflow past the 24 desks and the 16 hot desks');
  const glows = V.made.get('glow').items;
  const floating = glows
    .map(it => { const p = V.at(it); return (p.x - 0.5) + ',' + (p.z - 0.5); })
    .filter(k => hot.has(k));
  assert.strictEqual(floating.length, 0,
    `${floating.length} of ${glows.length} glows hang over a break/meeting tile with no desk`);
  const typists = ppl.filter(p => p.desk && !p.desk.hot &&
                                  St.clock - p.last < Sim.IDLE);
  assert.strictEqual(glows.length, typists.length, 'the glow missed a real desk instead');
  console.log('        %d of 60 overflowed onto a stand-in; %d desks lit', hot.size, glows.length);
});

await vcheck('V12', 'zero rooms, one room and 135 teammates all reconcile', () => {
  V.reset();
  Floor.reset();
  St.people = {};
  assert.strictEqual(Floor.state.amenities.length, 0, 'reset left the band standing');
  V.syncDepts(Floor.state, Sim);
  V.syncFocus(Sim, Floor.state);
  V.syncGlow(Sim);
  assert.strictEqual(V.pushed.length, 0, 'an empty world built geometry');

  V.reset();
  const one = freshWorld([['s1', 'alpha']]);
  for (const a of one.amenities) V.buildFacility(a, Floor);
  V.buildRoom(one.rooms.s1, Sim, Floor);
  assert.strictEqual(V.roomIdx.size, 1);
  const oneRoom = V.pushed.length;

  V.reset();
  freshSim(135, 100);
  const F = Floor.state;
  for (const a of F.amenities) V.buildFacility(a, Floor);
  for (const sid in F.rooms) V.buildRoom(F.rooms[sid], Sim, Floor);
  St.clock = 120;
  V.syncGlow(Sim);
  assert.strictEqual(V.pushed.length - V.made.get('glow').items.length, oneRoom,
    'a 135-person session built more static geometry than a 1-person one');
  console.log('        135 teammates: %d static instances (same as one room), %d glows',
    oneRoom, V.made.get('glow').items.length);
});

/* Everything static, twice, instance for instance. Deliberately blind to what the
   props are, so new clutter is covered without editing this. The scrub bar rebuilds
   the floor from scratch, so one Math.random() in here redecorates every drag. */
await vcheck('V13', 'the static world builds byte-identically twice — no random clutter', () => {
  const build = () => {
    V.reset();
    const F = freshWorld([['s1', 'alpha'], ['s2', 'alpha'], ['s3', 'beta']]);
    for (const a of F.amenities) V.buildFacility(a, Floor);
    for (const sid in F.rooms) V.buildRoom(F.rooms[sid], Sim, Floor);
    V.syncDepts(F, Sim);
    return V.pushed.map(it =>
      it.key + '|' + it.m.toArray().map(v => +v.toFixed(6)).join(',') +
      '|' + it.c.getHexString()).join('\n');
  };
  const a = build(), b = build();
  assert(a.length > 0, 'nothing was built at all');
  assert.strictEqual(a, b,
    'two builds of the same floor differ — placement is not a pure function of the ' +
    'floor, so a scrub back to the same clock redecorates the office');
  // and the comparison discriminates: a different floor must not compare equal
  V.reset();
  const other = freshWorld([['s1', 'alpha'], ['s2', 'beta'], ['s3', 'beta'], ['s4', 'beta']]);
  for (const x of other.amenities) V.buildFacility(x, Floor);
  for (const sid in other.rooms) V.buildRoom(other.rooms[sid], Sim, Floor);
  assert.notStrictEqual(V.pushed.length, a.split('\n').length,
    'a four-room floor built the same instances as a three-room one — this check ' +
    'compares nothing and would pass whatever placement did');
  console.log('        %d static instances, identical across two builds', a.split('\n').length);
});

/* "One draw call per prop type per FLOOR, not per room" — the rule that lets this
   renderer hold at 135 people. An InstancedMesh is one call, so batches are calls. */
await vcheck('V14', 'draw calls do not scale with room count', () => {
  const build = n => {
    V.reset();
    const F = freshWorld(Array.from({ length: n }, (_, i) => ['s' + i, 'alpha']));
    for (const a of F.amenities) V.buildFacility(a, Floor);
    for (const sid in F.rooms) V.buildRoom(F.rooms[sid], Sim, Floor);
    V.syncDepts(F, Sim);
    return { calls: new Set(V.pushed.map(it => it.key)), rooms: V.roomIdx.size };
  };
  const one = build(1), many = build(8);
  assert.strictEqual(one.rooms, 1);
  assert.strictEqual(many.rooms, 8, 'the fixture did not open eight rooms');
  assert.deepStrictEqual([...many.calls].sort(), [...one.calls].sort(),
    'eight rooms draw batches one room does not: ' +
    [...many.calls].filter(k => !one.calls.has(k)).join(' '));
  // set equality catches a per-room key already, but only if no key carries a sid
  const named = [...many.calls].filter(k => /s[0-7]\b/.test(k));
  assert.deepStrictEqual(named, [],
    'a batch key names a room: ' + named.join(' ') + ' — one geometry per type per ' +
    'floor is the rule, and a per-room key is 8x the draw calls at eight sessions');
  console.log('        %d draw calls, the same set for 1 room and for 8', many.calls.size);
});

/* The clutter equivalent of V11: a mug over bare carpet is the same bug as a lit
   monitor over a hot-desk stand-in. Surface heights are MEASURED off the geometry
   props.js builds, so a height hardcoded in scene.js instead of taken from Props.H
   fails here. One rect at a time, so every cl| instance belongs to the rect built. */
await vcheck('V15', 'every piece of clutter rests on furniture that is really there', () => {
  const F = freshWorld([['s1', 'alpha']]);
  const room = F.rooms.s1;
  const topOf = (pr) => {
    let top = -Infinity;
    for (const b of Props.buildProp(pr.type, pr.w, pr.h, { art: pr.art })) {
      b.geometry.computeBoundingBox();
      top = Math.max(top, b.geometry.boundingBox.max.y);
    }
    return top;
  };
  const jobs = F.amenities.map(a => ({ rect: a, desks: a.desks || [], build: () => V.buildFacility(a, Floor) }));
  jobs.push({ rect: asRect(room), desks: room.desks.concat([room.boss]),
              boss: room.boss, build: () => V.buildRoom(room, Sim, Floor) });
  let placed = 0;
  const kinds = new Set();
  for (const job of jobs) {
    V.reset();
    job.build();
    for (const it of V.pushed) {
      if (!String(it.key).startsWith('cl|')) continue;
      const type = it.key.slice(3), g = V.at(it);
      placed++; kinds.add(type);
      // a jacket hangs on a chair back, placed tile-cornered at y=0
      if (type === 'jacket') {
        assert(job.rect.props.some(pr => pr.type === 'chair' &&
          Math.abs(g.x - (pr.x + 0.5)) < 0.75 && Math.abs(g.z - (pr.y + 0.5)) < 0.75),
          `a jacket at ${g.x.toFixed(2)},${g.z.toFixed(2)} hangs on no chair`);
        continue;
      }
      const d = job.desks.find(q => q && g.x > q.x - 0.1 &&
        g.x < q.x + (q === job.boss ? 2.1 : 1.1) && g.z > q.y - 0.1 && g.z < q.y + 1.1);
      if (d) {
        assert(Math.abs(g.y - Props.H.desk) < 0.011,
          `${type} on the desk at ${d.x},${d.y} floats at y=${g.y.toFixed(3)}, ` +
          `and a desk top is ${Props.H.desk}`);
        continue;
      }
      const pr = job.rect.props.find(q => g.x > q.x - 1e-6 && g.x < q.x + q.w + 1e-6 &&
        g.z > q.y - 1e-6 && g.z < q.y + q.h + 1e-6 &&
        !Props.SKIP.has(q.type) && !Props.WALL_DECO.has(q.type));
      assert(pr, `a ${type} at ${g.x.toFixed(2)},${g.z.toFixed(2)} in the ` +
        `${job.rect.kind || 'room'} sits on bare carpet`);
      const top = topOf(pr);
      // .13 below is the bin: litter drops under the rim so it pokes out, not hovers
      assert(g.y <= top + 0.02 && g.y > top - 0.13,
        `${type} on a ${pr.type} sits at y=${g.y.toFixed(3)} and that ${pr.type}'s top ` +
        `face measures ${top.toFixed(3)} — the height is not coming from the geometry`);
    }
  }
  assert(placed > 30, `only ${placed} pieces of clutter on the whole floor`);
  console.log('        %d pieces placed, %d types, every one on real furniture',
    placed, kinds.size);
});

/* ========================================================== K. characters === */
/* The real rig, parsed from the .glb without a browser. characters.js's own
   selfTest() covers the pure helpers; nothing here repeats it. */
const CHARS_SRC = readFileSync(new URL('./view3d/characters.js', import.meta.url), 'utf8');
const RIG = await (async () => {
  try {
    const loader = new GLTFLoader();
    const parse = f => new Promise((res, rej) => {
      const b = readFileSync(new URL('./assets/' + f.replace(/^assets\//, ''), import.meta.url));
      loader.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '', res, rej);
    });
    const man = JSON.parse(readFileSync(new URL('./assets/manifest.json', import.meta.url), 'utf8'));
    const rig = await parse(man.rig.file);
    /* the clip -> extraClips wiring is read out of characters.js rather than written
       here: load()'s browser path picks the variant sources itself, and a list copied
       into this fixture would keep loading walk2 from the old file while the real
       layer asked for a new one — the fixture would pass and the app would be one
       clip short. The regex mirrors `wanted.<key> = man.extraClips.<name>`. */
    const want = { ...man.clips, ...man.gestures };
    for (const m of CHARS_SRC.matchAll(/wanted\.(\w+)\s*=\s*man\.extraClips\.(\w+)/g))
      want[m[1]] = (man.extraClips || {})[m[2]];
    const clips = {};
    for (const [k, spec] of Object.entries(want)) {
      if (!spec || !spec.file) continue;
      const g = await parse(spec.file);
      if (g.animations[0]) clips[k] = g.animations[0];
    }
    return { scene: rig.scene, clips };
  } catch (e) { return { error: e.message }; }
})();

const person = (key, o = {}) => Object.assign({
  key, sid: 's1', aid: key, boss: false, x: 5, y: 5, face: Floor.N, state: 'type',
  hue: 200, phase: 0, bob: 0, h: 1, last: 0, gesture: '', saying: '',
  room: { sid: 's1' }, fac: null, cowork: null, desk: null, speed: 2,
}, o);

await check('K1', 'the roster drives the avatars — nobody left behind, nobody invented', () => {
  const c = createCharacters();
  try {
    assert.strictEqual(c.sync([], 1 / 60).cheap, 0, 'an empty floor rendered somebody');
    const ppl = [person('a'), person('b', { state: 'walk' }), person('c', { state: 'leaving' })];
    assert.strictEqual(c.sync(ppl, 1 / 60).cheap, 3, 'not everyone got a stand-in');
    assert.strictEqual(c.sync([ppl[0]], 1 / 60).cheap, 1, 'a departed person was not dropped');
    assert.strictEqual(c.sync({ a: ppl[0], b: ppl[1] }, 1 / 60).cheap, 2,
      'sync must take St.people as an object too, which is how index.html calls it');
    assert.strictEqual(c.sync([], 1 / 60).cheap, 0, 'the floor did not empty');
  } finally { c.dispose(); }
});

await check('K2', 'every p.state in the contract maps to a clip, and nothing else exists', () => {
  assert.deepStrictEqual(Object.keys(CLIP_FOR).sort(),
    ['file', 'leaving', 'meet', 'think', 'type', 'walk'],
    'CLIP_FOR no longer covers exactly the six sim states');
  /* the sim must never produce a state the 3D layer has no clip for */
  const ppl = freshSim(40, 100);
  const seen = new Set();
  for (let t = 100; t < 100 + Sim.GONE + 60; t += 7) {
    St.clock = t;
    Sim.advance(1 / 60);
    for (const p of Object.values(St.people)) seen.add(p.state);
  }
  for (const s of seen) assert(CLIP_FOR[s], `sim.js produced state "${s}" with no clip`);
  assert.strictEqual(ppl.length, 40, 'the fixture lost people');
  for (const s of ['type', 'think', 'file', 'meet'])
    assert(seen.has(s), `the fixture never reached state "${s}" — it proves nothing about it`);
  console.log('        states seen over a full day: %s', [...seen].sort().join(' '));
});

await check('K3', 'a gesture fires once per change, over any state, and never on a ghost', () => {
  const c = createCharacters();
  try {
    const ppl = [person('a', { state: 'type' }), person('b', { state: 'walk' }),
                 person('c', { state: 'leaving' }), person('d', { state: 'meet' })];
    c.sync(ppl, 1 / 60);
    /* p.gesture is a FIELD, not an event: it stays set for many frames and the layer
       has to compare against the last one played. Every contract gesture, over every
       state, including mid-walk and on the way out. */
    for (const g of GESTURE_KEYS) {
      for (const p of ppl) p.gesture = g;
      for (let i = 0; i < 5; i++) c.sync(ppl, 1 / 60);
    }
    for (const p of ppl) p.gesture = '';
    c.sync(ppl, 1 / 60);
    // a gesture on somebody who has already been removed must not resurrect them
    ppl[0].gesture = 'point';
    assert.strictEqual(c.sync(ppl.slice(1), 1 / 60).cheap, 3, 'a removed person came back');
    // and the value surviving a drop/re-add must not wedge anything
    assert.strictEqual(c.sync(ppl, 1 / 60).cheap, 4);
  } finally { c.dispose(); }
});

await check('K4', 'a backgrounded tab, a scrub and a zero dt do not move anybody', () => {
  const c = createCharacters();
  try {
    const ppl = Array.from({ length: 20 }, (_, i) =>
      person('p' + i, { x: i, y: 3, state: i % 2 ? 'walk' : 'type' }));
    c.sync(ppl, 1 / 60);
    for (const dt of [0, -5, 99, NaN, undefined]) {
      const got = c.sync(ppl, dt);
      assert.strictEqual(got.cheap, 20, `dt=${dt} lost people`);
    }
    // a scrub teleports everyone: ff must be honoured from St as well as from ctx
    for (const p of ppl) { p.x += 40; p.y += 40; }
    assert.strictEqual(c.sync(ppl, 1 / 60, { ff: true, focus: null, clock: 0 }).cheap, 20);
    St.ff = true;
    assert.strictEqual(c.sync(ppl, 1 / 60).cheap, 20, 'St.ff is not read when no ctx is given');
    St.ff = false; St.catchUp = true;
    assert.strictEqual(c.sync(ppl, 1 / 60).cheap, 20, 'St.catchUp must freeze like St.ff');
    St.catchUp = false;
  } finally { c.dispose(); }
});

await check('K5', 'the real rig loads headless, with a clip or layer for every state', async () => {
  assert(!RIG.error, 'the rig could not be parsed: ' + RIG.error);
  const c = createCharacters();
  try {
    await c.load(RIG);
    assert.strictEqual(c.info.mode, 'rig', 'the rig did not take: ' + c.info.notes.join('; '));
    assert.deepStrictEqual(c.info.missing, [],
      'no clip or layer for: ' + c.info.missing.join(', '));
    for (const k of Object.values(CLIP_FOR))
      assert(c.info.clips[k], `state clip "${k}" did not resolve`);
    for (const g of GESTURE_KEYS)
      assert(c.info.clips[g], `gesture "${g}" has neither a clip nor a synthesised layer`);
    console.log('        %s', c.info.notes.join('; '));
  } finally { c.dispose(); }
});

await check('K6', 'every person gets their OWN skeleton — SkeletonUtils.clone, not mesh.clone', async () => {
  assert(!RIG.error, 'the rig could not be parsed: ' + RIG.error);
  const c = createCharacters();
  try {
    await c.load(RIG);
    const ppl = Array.from({ length: 6 }, (_, i) => person('p' + i, { x: i, y: 2 }));
    c.sync(ppl, 1 / 60);
    const skeletons = new Set();
    let meshes = 0;
    c.group.traverse(o => { if (o.isSkinnedMesh) { skeletons.add(o.skeleton); meshes++; } });
    assert(meshes >= 6, `only ${meshes} skinned meshes for 6 people`);
    assert.strictEqual(skeletons.size, meshes,
      `${meshes} skinned meshes share ${skeletons.size} skeletons — a plain clone shares one ` +
      'skeleton and every character animates identically');
  } finally { c.dispose(); }
});

await check('K7', '135 teammates stay inside the rig budget, and the band never degrades', async () => {
  assert(!RIG.error, 'the rig could not be parsed: ' + RIG.error);
  const c = createCharacters();
  try {
    await c.load(RIG);
    const room = { sid: 's1' }, other = { sid: 's2' };
    const ppl = Array.from({ length: 135 }, (_, i) =>
      person('p' + String(i).padStart(3, '0'),
             { x: i % 30, y: (i / 30 | 0), room: i < 60 ? room : other,
               state: i % 3 ? 'type' : 'walk' }));
    ppl[100].fac = { kind: 'cafeteria' };            // in the band, in an unfocused room
    ppl[101].cowork = { kind: 'coworking' };
    const got = c.sync(ppl, 1 / 60, { focus: room, clock: 0 });
    assert.strictEqual(got.full + got.cheap, 135, 'people went missing');
    assert(got.full <= c.options.maxFull, `${got.full} full rigs, budget is ${c.options.maxFull}`);
    const band = chooseFull(ppl, room, c.options.maxFull);
    assert(band.has(ppl[100].key) && band.has(ppl[101].key),
      'the band must keep a rig wherever focus is — it is under the camera at all times');
    for (let i = 0; i < 10; i++) c.sync(ppl, 1 / 60, { focus: room, clock: i });
    assert.strictEqual(c.info.full + c.info.cheap, 135, 'the roster drifted over ten frames');
    console.log('        135 people: %d rigs, %d stand-ins', c.info.full, c.info.cheap);
  } finally { c.dispose(); }
});

await check('K8', 'a frame that lands after dispose() is ignored, not a crash', () => {
  const c = createCharacters();
  c.sync([person('a')], 1 / 60);
  c.dispose();
  c.sync([person('a'), person('b')], 1 / 60);     // must not throw
  c.dispose();                                     // twice is allowed too
});

/* =============================================== M. the walk, end to end === */
/* The office read as a robot because sim.js walked at 2.00-2.39 tiles/s against a clip
   whose baked stride covers 0.975 u/s — 2.05-2.45x playback. Three numbers in three
   files have to agree, and each was a literal in its own file, so any two could drift
   and both suites would still pass. These hold the RELATIONSHIP: stride from the
   manifest, walkRef from live options, ground speed from a real sim, walkScale itself.
   The only thing written here is the band a human stride can occupy. */

const MANIFEST = JSON.parse(
  readFileSync(new URL('./assets/manifest.json', import.meta.url), 'utf8'));

/* freshSim gives every event an agent id, so it never opens a boss (sim.js: `!e.aid`).
   Appended after the fact, so every other fixture keeps the roster it expects. */
function addBoss() {
  St.events.push({ t: 100, sid: 's1', aid: null, kind: 'tool', tool: 'Read',
                   say: 'ship it', seq: 1e6 });
  for (let i = 0; i < 4; i++) Sim.advance(1 / 60);
  const boss = Object.values(St.people).find(p => p.boss);
  assert(boss, 'sim.js no longer puts a boss on the floor for an event with no agent id');
  return boss;
}

await check('M1', 'walkRef is the measured stride of every clip the layer walks on', () => {
  const o = createCharacters().options;
  // every clip playable as `walk` runs at the one walkRef, so they must share a stride
  const strides = [['clips.walk', MANIFEST.clips.walk]];
  for (const m of CHARS_SRC.matchAll(/wanted\.(walk\d+)\s*=\s*man\.extraClips\.(\w+)/g))
    strides.push(['extraClips.' + m[2], (MANIFEST.extraClips || {})[m[2]]]);
  assert(strides.length > 1, 'characters.js no longer loads a second walk — variety is gone');
  for (const [where, spec] of strides) {
    assert(spec && spec.rootMotion, `${where} has no measured rootMotion in the manifest`);
    assert.strictEqual(spec.rootMotion.unitsPerSecond, o.walkRef,
      `${where} strides at ${spec.rootMotion.unitsPerSecond} u/s and characters.js plays ` +
      `every walk against walkRef ${o.walkRef} — one of the two walks will skate`);
  }
  assert.strictEqual(walkScale(o.walkRef, o.walkRef), 1,
    'a person walking at exactly the baked stride must play the clip at 1x');
  console.log('        %d walk clips, all baked at %s u/s', strides.length, o.walkRef);
});

await check('M2', 'every speed the sim hands out plays the walk at a human cadence', () => {
  // 1.6x is where a walk stops reading as a walk; the old 2.00-2.39 sat at 2.05-2.45x
  const LO = 0.85, HI = 1.60;
  const o = createCharacters().options;
  freshSim(60, 100);
  const boss = addBoss();
  const ppl = Object.values(St.people);
  assert.strictEqual(ppl.length, 61, 'the fixture lost people');
  const rates = new Set();
  let slowestMate = Infinity;
  for (const p of ppl) {
    const rate = walkScale(p.speed, o.walkRef);
    assert(rate > LO && rate < HI,
      `${p.key} walks at ${p.speed.toFixed(2)} tiles/s, i.e. the clip at ` +
      `${rate.toFixed(2)}x — outside ${LO}-${HI}x, which is not a walk`);
    // walkScale's clamp is an outlier guard: a speed that reaches it is hidden, not played
    assert(rate > 0.36 && rate < 2.59, `${p.key} is riding walkScale's clamp`);
    rates.add(rate.toFixed(3));
    if (!p.boss) slowestMate = Math.min(slowestMate, p.speed);
  }
  assert(walkScale(boss.speed, o.walkRef) < walkScale(slowestMate, o.walkRef),
    `the boss plays the walk at ${walkScale(boss.speed, o.walkRef).toFixed(2)}x and the ` +
    `slowest teammate at ${walkScale(slowestMate, o.walkRef).toFixed(2)}x — a gait you ` +
    'can pick out of a room only works if it is always the slowest one on the floor');
  assert(rates.size >= 8, `only ${rates.size} distinct cadences across 61 people`);
  console.log('        %d cadences, %s-%sx, boss %sx', rates.size,
    Math.min(...[...rates].map(Number)).toFixed(2),
    Math.max(...[...rates].map(Number)).toFixed(2),
    walkScale(boss.speed, o.walkRef).toFixed(2));
});

await check('M3', 'the speed the feet actually see stays inside a human band', () => {
  /* M2 pins the nominal speed; this pins what the layer measures. a.ground is the
     per-frame step low-passed, and the lane offset, the shove and the slow-down into a
     waypoint all move it — so it is averaged over a journey, which is where the
     low-pass lands. Wider than M2's band on purpose: 0.6-2.0x is still a walk. */
  const LO = 0.6, HI = 2.0;
  const o = createCharacters().options;
  freshSim(60, 100, 0);                 // 1x, so the clock and the frames agree
  const acc = new Map(), prev = new Map();
  for (let i = 0; i < 4000; i++) {
    for (const p of Object.values(St.people)) prev.set(p.key, [p.x, p.y, p.state]);
    Sim.advance(1 / 60);
    for (const p of Object.values(St.people)) {
      const q = prev.get(p.key);
      if (!q || q[2] !== 'walk' || p.state !== 'walk') continue;
      const d = Math.hypot(p.x - q[0], p.y - q[1]);
      if (d > 1.5) continue;             // a scrub or a respawn, not a step
      let a = acc.get(p.key);
      if (!a) acc.set(p.key, a = { d: 0, t: 0, boss: p.boss });
      a.d += d; a.t += 1 / 60;
    }
  }
  const rates = [];
  for (const [key, a] of acc) {
    if (a.t < 1) continue;               // too short to average anything
    const rate = walkScale(a.d / a.t, o.walkRef);
    assert(rate > LO && rate < HI,
      `${key} covers ${(a.d / a.t).toFixed(2)} tiles/s over ${a.t.toFixed(1)}s of ` +
      `walking, i.e. the clip at ${rate.toFixed(2)}x — outside ${LO}-${HI}x`);
    rates.push(rate);
  }
  assert(rates.length > 20, `only ${rates.length} journeys long enough to measure`);
  console.log('        %d journeys, %s-%sx measured off the floor', rates.length,
    Math.min(...rates).toFixed(2), Math.max(...rates).toFixed(2));
});

/* ========================================= D. variety, and it replays same === */
/* 135 people out of one rig: the variety has to be visible AND a pure function of
   p.h, or the scrub bar redecorates the office on every drag. Read off the instance
   buffers, the only place the cheap LOD's 95 stand-ins are observable. */

/* the three InstancedMeshes that carry a person, as "scale#colour" per instance */
function bodyRows(chars) {
  const m = new THREE.Matrix4(), col = new THREE.Color(), s = new THREE.Vector3();
  const out = new Map();
  chars.group.traverse(o => {
    if (!o.isInstancedMesh || !o.instanceColor) return;
    const rows = [];
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m);
      s.setFromMatrixScale(m);
      o.getColorAt(i, col);
      rows.push(s.toArray().map(v => v.toFixed(5)).join(',') + '#' + col.getHexString());
    }
    out.set(o.geometry.type, rows);
  });
  return out;
}

await check('D1', 'nothing in the 3D layer or the sim reaches for Math.random', () => {
  // behaviour cannot prove it: a Math.random() on a branch no fixture takes passes D3
  const files = ['sim.js', 'floor.js', 'view3d/characters.js', 'view3d/materials.js',
                 'view3d/props.js', 'view3d/scene.js'];
  const hits = [];
  for (const f of files) {
    /* Comments are blanked, not stripped, so line numbers stay true. Every one of these
       files promises in prose not to use Math.random() — raw text finds the promises. */
    let inBlock = false;
    readFileSync(new URL('./' + f, import.meta.url), 'utf8').split('\n').forEach((raw, i) => {
      let line = raw;
      if (inBlock) {
        const e = line.indexOf('*/');
        if (e < 0) return;
        line = line.slice(e + 2); inBlock = false;
      }
      line = line.replace(/\/\*(?:(?!\*\/)[\s\S])*\*\//g, ' ');
      const b = line.indexOf('/*');
      if (b >= 0) { inBlock = true; line = line.slice(0, b); }
      line = line.replace(/\/\/.*$/, '');
      if (/Math\.random\s*\(/.test(line)) hits.push(`${f}:${i + 1}`);
      // a wall clock is the same hazard: it cannot be replayed either
      if (/\b(Date\.now|performance\.now)\s*\(/.test(line) && f !== 'sim.js')
        hits.push(`${f}:${i + 1} (wall clock)`);
    });
  }
  assert.deepStrictEqual(hits, [],
    'a replay cannot survive these: ' + hits.join(' ') +
    ' — every per-person choice must be a bit slice of p.h');
});

await check('D2', '135 people are 135 different people, not 95 identical capsules', () => {
  const c = createCharacters();
  try {
    const ppl = freshSim(135, 100).sort((a, b) => (a.key < b.key ? -1 : 1));
    const got = c.sync(ppl, 1 / 60);
    assert.strictEqual(got.cheap, 135, 'the fixture did not land on the cheap LOD');
    const rows = bodyRows(c);
    assert(rows.size >= 3,
      'the stand-in is back to one primitive — legs, torso and head are what ' +
      'separates a person from a chess pawn at this distance');
    // height and width come off p.h: one value across 135 people is the reported bug
    const scales = new Set();
    for (const rowset of rows.values()) for (const r of rowset) scales.add(r.split('#')[0]);
    assert(scales.size >= 20,
      `${scales.size} distinct builds across 135 people — the hash slice is unmixed ` +
      'again, which dresses a whole room as one body');
    // each of the three tones has to vary on its own; one trouser tone is a uniform
    for (const [geo, rowset] of rows) {
      const tones = new Set(rowset.map(r => r.split('#')[1]));
      assert(tones.size >= 4, `${geo} paints ${tones.size} tones across 135 people`);
    }
    // and the pairing has to vary, or it is 135 people out of a handful of outfits
    const whole = new Set();
    const n = rows.get('CapsuleGeometry').length;
    for (let i = 0; i < n; i++)
      whole.add([...rows.values()].map(r => r[i]).join('/'));
    assert(whole.size >= 120,
      `${whole.size} distinct people among 135 — build and palette are correlated`);
    /* X8 pins ONE person's albedo against office.js's 50% lightness, and the palette now
       deals a four-step ladder — so a new step could break that contract for some people
       and not for the one X8 samples. Every step a teammate can be dealt, busy or idle. */
    const hsl = {};
    for (const idle of [false, true]) {
      for (let i = 0; i < 400; i++) {
        personPalette(199, Math.imul(i + 1, 2246822519) >>> 0, idle, false)
          .shirt.getHSL(hsl, THREE.SRGBColorSpace);
        assert(Math.abs(hsl.l - 0.50) < 0.12,
          `a shirt step reads at sRGB lightness ${hsl.l.toFixed(3)}; office.js draws a ` +
          'teammate at 50% and X8 allows +/-.12 — this step is outside it');
      }
    }
    console.log('        135 people: %d builds, %d whole-person combinations',
      scales.size, whole.size);
  } finally { c.dispose(); }
});

await check('D3', 'the same clock replays the same people, down to the instance buffer', () => {
  /* Z5 pins that the sim replays the same POSITIONS; this pins that the layer then
     dresses them identically. A new layer each time, so no cache carries over. */
  const replay = (T) => {
    Sim.rebuild(T);
    St.clock = T;
    for (let i = 0; i < 8; i++) Sim.advance(1 / 60);
    const c = createCharacters();
    try {
      const ppl = Object.values(St.people).sort((a, b) => (a.key < b.key ? -1 : 1));
      c.sync(ppl, 1 / 60);
      return { n: ppl.length, rows: [...bodyRows(c)].map(([g, r]) => g + ':' + r.join('|')).join('\n') };
    } finally { c.dispose(); }
  };
  freshSim(135, 100);
  const a = replay(200), b = replay(200);
  assert(a.n > 20, `the replay put only ${a.n} people back`);
  assert.strictEqual(b.n, a.n, 'two replays of the same clock produced different rosters');
  assert.strictEqual(a.rows, b.rows,
    'two replays of the same clock dressed the same people differently — something ' +
    'in the variety is not a pure function of p.h');
  // and the comparison discriminates: a different roster must not compare equal
  freshSim(40, 100);
  const few = replay(200);
  assert.notStrictEqual(few.rows, a.rows,
    'a 40-person floor produced the same rows as a 135-person one — this check ' +
    'compares nothing and would pass whatever the variety did');
  console.log('        %d people, identical across two replays to clock 200', a.n);
});

await check('D4', 'every clip variant a person can be dealt actually exists', async () => {
  /* setClip falls back to the default when the rig lacks a variant, so a missing one
     is silent — the office just goes back to one pose. Variants come from buildOf
     itself, not a list here, so a third walk is covered the day it lands. */
  assert(!RIG.error, 'the rig could not be parsed: ' + RIG.error);
  const c = createCharacters();
  try {
    await c.load(RIG);
    assert.strictEqual(c.info.mode, 'rig', 'the rig did not take: ' + c.info.notes.join('; '));
    const dealt = { walk: new Set(), idle: new Set() };
    for (let i = 0; i < 2000; i++) {
      const v = buildOf(Math.imul(i + 1, 2246822519) >>> 0, false, c.options).variant;
      for (const k in dealt) dealt[k].add(v[k]);
    }
    const bossV = buildOf(12345, true, c.options).variant;
    for (const k in dealt) dealt[k].add(bossV[k]);
    const missing = [];
    for (const [key, set] of Object.entries(dealt))
      for (const v of set) if (!c.info.clips[key + v]) missing.push(key + v);
    assert.deepStrictEqual(missing, [],
      'buildOf deals these and the rig carries no clip for them: ' + missing.join(' ') +
      ' — everyone dealt one silently falls back to the default pose');
    assert(dealt.walk.size >= 2 && dealt.idle.size >= 3,
      `only ${dealt.walk.size} walks and ${dealt.idle.size} standing idles are ever ` +
      'dealt — a corridor is one pose and a lounge is a rack of statues');
    console.log('        walks %s, idles %s, all resolved on the real rig',
      [...dealt.walk].map(v => 'walk' + v).join('/'),
      [...dealt.idle].map(v => 'idle' + v).join('/'));
  } finally { c.dispose(); }
});

/* ============================================================= B. the boss === */
/* The only difference used to be bossScale 1.06 — four pixels at office zoom. Each cue
   is pinned separately, so losing one cannot hide behind the others. */

await check('B1', 'a boss is a different build, a different gait and different clips', () => {
  const c = createCharacters();
  try {
    const o = c.options;
    freshSim(60, 100);
    const boss = addBoss();
    const ppl = Object.values(St.people);
    // the SAME hash as a teammate, so every difference is the flag, not the draw
    const asBoss = buildOf(boss.h, true, o), asMate = buildOf(boss.h, false, o);
    assert(asBoss.hy > asMate.hy, 'the boss is not taller than the same person would be');
    assert(asBoss.hw / asBoss.hy > asMate.hw / asMate.hy, 'and he is not broader either');
    // fixed clips whatever his hash says, or the silhouette is not a rank
    const dealt = new Set();
    for (let i = 0; i < 500; i++)
      dealt.add(JSON.stringify(buildOf(Math.imul(i + 1, 2246822519) >>> 0, true, o).variant));
    assert.strictEqual(dealt.size, 1,
      'a boss\'s clips are drawn from his hash — every boss has to read the same or ' +
      'the silhouette is not a rank');
    const mateVariants = new Set();
    for (let i = 0; i < 500; i++)
      mateVariants.add(JSON.stringify(buildOf(Math.imul(i + 1, 2246822519) >>> 0, false, o).variant));
    assert(mateVariants.size > 1, 'teammates no longer vary their clips');
    /* gait: strictly the slowest thing on the floor, not a multiple of a teammate's */
    for (const p of ppl) if (!p.boss)
      assert(boss.speed < p.speed,
        `${p.key} walks at ${p.speed.toFixed(2)} and the boss at ${boss.speed.toFixed(2)}`);
    console.log('        boss %sx tall, %s%% broader, walk %s idle %s, %s tiles/s',
      (asBoss.hy / asMate.hy).toFixed(3),
      (((asBoss.hw / asBoss.hy) / (asMate.hw / asMate.hy) - 1) * 100).toFixed(1),
      JSON.parse([...dealt][0]).walk || '(default)',
      JSON.parse([...dealt][0]).idle, boss.speed.toFixed(2));
  } finally { c.dispose(); }
});

await check('B2', 'the boss wears his own colour, outside every teammate shirt', () => {
  /* The jacket lands before a name plate is legible, so it has to sit OUTSIDE the
     range teammates draw from, not be another draw from it. sRGB, like X8. */
  const hsl = {}, read = c => { c.getHSL(hsl, THREE.SRGBColorSpace); return { ...hsl }; };
  const hue = 199;
  const mates = [];
  for (let i = 0; i < 400; i++)
    mates.push(read(personPalette(hue, Math.imul(i + 1, 2246822519) >>> 0, false, false).shirt));
  const boss = read(personPalette(hue, 12345, false, true).shirt);
  assert(boss.l < Math.min(...mates.map(m => m.l)) - 0.05,
    `the boss's shirt is at lightness ${boss.l.toFixed(2)} and teammates go down to ` +
    `${Math.min(...mates.map(m => m.l)).toFixed(2)} — a jacket has to read darker`);
  assert(boss.s > Math.max(...mates.map(m => m.s)) + 0.05,
    'the boss\'s shirt is no more saturated than a teammate\'s');
  // trousers too, or the only cue is gone the moment he sits down
  assert.notStrictEqual(personPalette(hue, 12345, false, true).trouser.getHexString(),
    personPalette(hue, 12345, false, false).trouser.getHexString(),
    'the boss wears the same trousers as the same person would as a teammate');
  /* and the cue must survive going idle, which darkens everybody */
  const bossIdle = read(personPalette(hue, 12345, true, true).shirt);
  const mateIdle = [];
  for (let i = 0; i < 400; i++)
    mateIdle.push(read(personPalette(hue, Math.imul(i + 1, 2246822519) >>> 0, true, false).shirt));
  assert(bossIdle.l < Math.min(...mateIdle.map(m => m.l)),
    'an idle boss is no longer darker than an idle teammate — the cue dies at the cooler');
  console.log('        jacket hsl(%d %d%% %d%%) against shirts %d-%d%% lightness',
    Math.round(boss.h * 360), Math.round(boss.s * 100), Math.round(boss.l * 100),
    Math.round(Math.min(...mates.map(m => m.l)) * 100),
    Math.round(Math.max(...mates.map(m => m.l)) * 100));
});

/* ================================================== X. the two views agree === */
/* office.js is a plain script that expects a DOM, so it runs in a vm with a stub
   2D context. Its drawPerson is then replaced by a recorder, which is how section X
   reads office.js's OWN visibility answer instead of a second implementation. */
const OFFICE = (() => {
  const grad = { addColorStop() {} };
  const ctx2d = new Proxy({}, {
    get(_, k) {
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => grad;
      if (k === 'measureText') return s => ({ width: String(s).length * 6 });
      if (k === 'canvas') return undefined;
      return () => {};
    },
    set() { return true; },
  });
  const el = id => ({ id, textContent: '', innerHTML: '', value: '', style: {}, dataset: {},
    width: 0, height: 0, clientWidth: 1600, clientHeight: 900,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, blur() {}, focus() {}, getContext: () => ctx2d });
  const els = {};
  const box = {
    console, performance: { now: () => 0 }, Math, JSON, Date, Set, Map, Object, Array,
    Promise, Error, RegExp, String, Number, Boolean, URLSearchParams,
    Float32Array, Uint8Array, Uint16Array, Int32Array,
    isFinite, isNaN, parseInt, parseFloat, devicePixelRatio: 1,
    document: { getElementById: id => (els[id] = els[id] || el(id)), body: el('body'),
      documentElement: el('html'), createElement: () => el('new'),
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    addEventListener() {}, setInterval() {}, clearInterval() {},
    setTimeout() {}, clearTimeout() {},
    requestAnimationFrame() {}, cancelAnimationFrame() {},
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { search: '', hash: '', href: 'http://localhost/' },
    navigator: { userAgent: 'node' },
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
  };
  box.window = box; box.globalThis = box;
  const ctx = vm.createContext(box);
  try {
    for (const f of ['floor.js', 'chat.js', 'sim.js', 'office.js'])
      vm.runInContext(readFileSync(new URL('./' + f, import.meta.url), 'utf8'), ctx,
                      { filename: f });
  } catch (e) { return { error: e.message }; }
  const drawn = [];
  box.__recordPerson = (p, dim) => drawn.push({ key: p.key, dim: !!dim, x: p.x, y: p.y });
  vm.runInContext('drawPerson = __recordPerson;', ctx);
  const get = e => vm.runInContext(e, ctx);
  if (get('drawPerson') !== box.__recordPerson) return { error: 'drawPerson is no longer hookable' };
  return { box, get, drawn, Floor: box.Floor, Sim: box.Sim };
})();

if (OFFICE.error) {
  FAILS.push('X*');
  console.log('FAIL  X*  office.js would not evaluate headlessly (%s) — the stub DOM needs ' +
              'a global it did not before; this is an in-progress edit, not a defect',
              OFFICE.error);
}

const xcheck = (id, what, fn) => (OFFICE.error ? Promise.resolve() : check(id, what, fn));

/* one world in the 2D sandbox: two sessions, people scattered up into the band */
function officeWorld() {
  const { Floor: F2, Sim: S2 } = OFFICE;
  const St2 = S2.St;
  S2.hooks.say = () => {}; S2.hooks.reset = () => {};
  F2.reset();
  Object.assign(St2, { sessions: {}, agentMeta: {}, events: [], people: {},
    t0: 0, t1: 1e12, clock: 0, live: false, playing: true, si: 2,
    scanFrom: 0, since: 0, q: '', ff: false, catchUp: false, focus: null, wall: 0 });
  St2.sessions.s1 = { sid: 's1', proj: 'alpha', title: 'Invoice PDF rewrite',
                      branch: 'feat/x', cwd: '', model: '', agents: [] };
  St2.sessions.s2 = { sid: 's2', proj: 'zeta', title: 'Unrelated work',
                      branch: '', cwd: '', model: '', agents: [] };
  let seq = 0;
  St2.events = [
    ...Array.from({ length: 30 }, (_, i) =>
      ({ t: 100, sid: 's1', aid: 'a' + i, kind: 'tool', tool: 'Read', say: 'x', seq: ++seq })),
    ...Array.from({ length: 5 }, (_, i) =>
      ({ t: 100, sid: 's2', aid: 'b' + i, kind: 'tool', tool: 'Read', say: 'y', seq: ++seq })),
  ];
  St2.clock = 150;
  for (let i = 0; i < 6; i++) S2.advance(1 / 60);
  for (let t = 150; t <= 400; t += 10) {            // past IDLE: trips up to the band
    St2.clock = t;
    for (let i = 0; i < 4; i++) S2.advance(1 / 60);
  }
  St2.cam = { x: 0, y: 0, z: 0.5, tx: 0, ty: 0, tz: 0.5 };
  OFFICE.get('fitAll')();
  St2.cam.x = St2.cam.tx; St2.cam.y = St2.cam.ty; St2.cam.z = St2.cam.tz;
  return St2;
}
const frame2d = () => { OFFICE.drawn.length = 0; OFFICE.get('render')(); return OFFICE.drawn; };

await xcheck('X1', 'both views switch on the same prop vocabulary', () => {
  const drawProp = OFFICE.get('drawProp');
  const only2d = [], only3d = [], neither = [];
  for (const t of VOCAB) {
    if (Props.SKIP.has(t)) continue;
    shouts = [];
    drawProp({ type: t, x: 3, y: 4, w: 2, h: 2, art: 5 });
    const has2d = shouts.length === 0;
    shouts = [];
    FreshProps.buildProp(t, 2, 2, { art: 5 });     // fresh instance: see its comment
    const has3d = shouts.length === 0;
    if (has2d && !has3d) only2d.push(t);
    if (has3d && !has2d) only3d.push(t);
    if (!has2d && !has3d) neither.push(t);
  }
  assert.deepStrictEqual(only2d, [],
    'the 2D view draws types the 3D view does not: ' + only2d.join(' '));
  assert.deepStrictEqual(only3d, [],
    'the 3D view draws types the 2D view does not: ' + only3d.join(' '));
  assert.deepStrictEqual(neither, ['rug'],
    'a contract type neither view draws: ' + neither.join(' '));
  console.log('        %d contract types, both views agree; only rug is in neither ' +
    '(ADDENDUM 1: unused, do not implement)', VOCAB.length - Props.SKIP.size);
});

await xcheck('X2', 'both views handle all eleven facility kinds and the twelfth nobody wrote', () => {
  const F2 = OFFICE.Floor;
  F2.reset(); F2.buildAmenities();
  const tint = OFFICE.get('AM_TINT');
  const kinds = F2.state.amenities.map(a => a.kind);
  assert.strictEqual(kinds.length, 11, 'the band is not eleven facilities');
  const untinted = kinds.filter(k => !tint[k]);
  assert.strictEqual(untinted.length, 0, '2D has no colour for: ' + untinted.join(' '));
  const hues = new Set(kinds.map(k => tint[k].h));
  assert.strictEqual(hues.size, 11, 'two facilities share a 2D hue');
  /* and the 3D tint is the SAME table: a cafeteria that reads amber in 2D and cyan
     in 3D is the same floor telling you two different things */
  const hsl = {};
  for (const k of kinds) {
    amColor(k).getHSL(hsl);
    assert.strictEqual(Math.round(hsl.h * 360), tint[k].h,
      `${k}: 2D hue ${tint[k].h}, 3D hue ${Math.round(hsl.h * 360)}`);
  }
  amColor('gymnasium').getHSL(hsl);
  assert.strictEqual(Math.round(hsl.h * 360), 220,
    'an unknown kind must fall back to the same plain grey 2D uses');
  freshWorld();
  for (const a of Floor.state.amenities) {
    shouts = [];
    assert(Props.buildFacilityShell(Floor, a).length > 0, `3D built no shell for ${a.kind}`);
    assert.strictEqual(shouts.length, 0, `${a.kind}: ` + shouts.join(' | '));
  }
  // an unknown kind: a grey box in 2D, a width-keyed shell in 3D. Neither throws.
  const fake = { kind: 'gymnasium', label: 'GYM', gx: 0, gy: 0, w: 12, h: Floor.AM_H,
                 door: { x: 6, y: Floor.AM_H - 1 }, props: [], seats: [] };
  OFFICE.get('drawAmenity')(fake, false, false);
  assert(Props.buildFacilityShell(Floor, fake).length > 0);
});

await xcheck('X3', 'both views place the same people at the same tiles', () => {
  const St2 = officeWorld();
  const drawn = frame2d();
  const keys2d = new Set(drawn.map(d => d.key));
  const all = Object.keys(St2.people);
  assert.strictEqual(keys2d.size, all.length,
    `2D drew ${keys2d.size} of ${all.length} people with the whole floor in frame`);
  const c = createCharacters();
  try {
    const got = c.sync(Object.values(St2.people), 1 / 60);
    assert.strictEqual(got.full + got.cheap, all.length,
      `3D rendered ${got.full + got.cheap} of ${all.length}`);
  } finally { c.dispose(); }
  // and at the same coordinates: both read p.x / p.y straight from the sim
  for (const d of drawn) {
    const p = St2.people[d.key];
    assert(d.x === p.x && d.y === p.y, d.key + ' moved between the roster and the draw');
  }
  console.log('        %d people, %d of them up in the band', all.length,
    Object.values(St2.people).filter(p => p.fac || p.cowork).length);
});

await xcheck('X4', 'a person standing in the band survives their own room being off-screen', () => {
  const St2 = officeWorld();
  const F2 = OFFICE.Floor;
  const inAm = OFFICE.get('inAm'), iso = OFFICE.get('iso');
  const cafe = F2.state.amenities.find(a => a.kind === 'cafeteria');
  const standing = Object.values(St2.people)
    .filter(p => (p.fac || p.cowork) && inAm(p.fac || p.cowork, p.x, p.y));
  assert(standing.length > 0, 'nobody arrived in a facility — the fixture is wrong');
  // zoom onto the cafeteria: every team room is now outside the viewport
  const mid = iso(cafe.gx + cafe.w / 2, cafe.gy + cafe.h / 2);
  St2.cam.x = mid.x; St2.cam.y = mid.y; St2.cam.z = 1.4;
  const drawn = frame2d();
  assert(drawn.length > 0,
    'the band emptied when the camera left the team rooms — this is EDGE_CASES E10, ' +
    'a person culled against their own room instead of against the band');
  const inCafe = new Set(standing.filter(p => inAm(cafe, p.x, p.y)).map(p => p.key));
  for (const k of inCafe)
    assert(drawn.some(d => d.key === k), k + ' vanished while standing in the cafeteria');
  console.log('        %d people drawn with every team room culled', drawn.length);
});

await xcheck('X5', 'both views dim the same rooms behind a focus', () => {
  const St2 = officeWorld();
  const F2 = OFFICE.Floor;
  St2.focus = F2.state.rooms.s1;
  const drawn = frame2d();
  for (const d of drawn) {
    const p = St2.people[d.key];
    assert.strictEqual(d.dim, p.room !== St2.focus,
      `${d.key} dim=${d.dim} but their room is ${p.room === St2.focus ? '' : 'not '}the focus`);
  }
  assert(drawn.some(d => d.dim) && drawn.some(d => !d.dim), 'the fixture has only one room');
  // 3D takes focus from the same field, and the band is never the focus in either view
  assert(SCENE_SRC.includes('Sim.St.focus'), 'scene.js no longer reads St.focus');
  assert(!Object.values(St2.people).some(p => p.fac === St2.focus), 'a facility became the focus');
  St2.focus = null;
});

/* was GAP 4. Neither scene.js nor characters.js read St.q, so with 3D as the only
   view the search box did nothing at all — three different queries produced
   byte-identical frames. Both halves now answer it: rooms via roomTint/roomHit,
   people via a per-person back-off. */
await xcheck('X6', 'a search dims the floor in both views', () => {
  const St2 = officeWorld();
  St2.q = '';
  assert.strictEqual(frame2d().filter(d => d.dim).length, 0, 'nothing is dimmed with no query');
  St2.q = 'invoice';                                 // s1's title
  const hit = frame2d();
  assert(hit.filter(d => d.dim).length === 5 && hit.length === 35,
    `a matching query should dim only the other session: ${hit.filter(d => d.dim).length} dim`);
  St2.q = 'nothingdoing';
  const miss = frame2d();
  assert.strictEqual(miss.filter(d => d.dim).length, miss.length,
    'a query nothing matches should dim the whole floor');
  St2.q = '';
  assert(/St\.q|roomHit/.test(SCENE_SRC),
    'scene.js has stopped reading the query — the search box is dead in 3D again');
  /* and the people inside a matching room, not just the shells around them: a room
     hits when ANY occupant matches, so a hitting room can still hold non-matching
     people, and 2D knocks those back individually. */
  const ppl = Object.values(St2.people);
  const c = createCharacters();
  /* read the colours the layer actually hands the GPU: the back-off bit is cached
     on the avatar entry, not on the person, so instance colour is the observable */
  const colours = () => {
    const out = [];
    c.group.traverse(o => {
      if (o.isInstancedMesh && o.instanceColor)
        out.push(Array.from(o.instanceColor.array).map(v => +v.toFixed(4)).join(','));
    });
    return out.join('|');
  };
  /* sync() resolves the query from ctx.q, else globalThis.Sim.St.q, and personText
     only from globalThis.Sim — which node does not have. Supply both, or the layer
     silently sees no query and this check passes for the wrong reason. */
  const hadSim = globalThis.Sim;
  globalThis.Sim = Sim;
  try {
    c.sync(ppl, 1 / 60, { q: '' });
    const lit = colours();
    c.sync(ppl, 1 / 60, { q: 'nothingdoing' });        // matches nobody
    const dimmed = colours();
    c.sync(ppl, 1 / 60, { q: '' });
    const back = colours();
    assert(lit.length > 0, 'the cheap LOD wrote no instance colours at all');
    assert.notStrictEqual(dimmed, lit,
      'characters.js ignores the query — a query matching nobody changed nothing');
    assert.strictEqual(back, lit, 'clearing the query must bring everyone back up');
  } finally { c.dispose(); globalThis.Sim = hadSim; }
});

/* was GAP 5. 2D lit a desk when its OWNER was recently active wherever they stood;
   3D additionally demanded p.state === 'type'. Measured on one frame: 35 monitors
   lit in 2D against 0 in 3D, because the whole team was up at the cafeteria. The
   owner now drives both, so a screen stays on when its owner walks off. */
await xcheck('X7', 'both views light a monitor from its desk\'s owner, not their posture', () => {
  const St2 = officeWorld();
  const F2 = OFFICE.Floor, IDLE = OFFICE.Sim.IDLE;
  St2.clock = 150;                                   // everyone recently active
  /* 2D: the monitor on a desk is lit when its OWNER was recently active, wherever
     they are standing. It resolves a room desk through the room (a desk holds a bare
     agent id) and a band desk by d.by directly (the full person key) — EDGE_CASES H1. */
  const lit2d = new Set();
  for (const r of Object.values(F2.state.rooms)) {
    for (const d of r.desks.concat([r.boss])) {
      const p = d === r.boss ? St2.people[r.sid + '|'] : (d.by ? St2.people[r.sid + '|' + d.by] : null);
      if (p && St2.clock - p.last < IDLE) lit2d.add(p.key);
    }
  }
  for (const a of F2.state.amenities) for (const d of a.desks || []) {
    const p = d.by ? St2.people[d.by] : null;
    if (p && St2.clock - p.last < IDLE) lit2d.add(p.key);
  }
  // 3D: same rule — the desk's owner, regardless of where they are standing
  const lit3d = new Set(Object.values(St2.people)
    .filter(p => p.desk && !p.desk.hot && St2.clock - p.last < IDLE).map(p => p.key));
  const only2d = [...lit2d].filter(k => !lit3d.has(k));
  const only3d = [...lit3d].filter(k => !lit2d.has(k));
  assert.deepStrictEqual(only2d, [],
    'a monitor lit in 2D is dark in 3D again — the posture clause is back: ' + only2d.join(' '));
  assert.deepStrictEqual(only3d, [],
    'a monitor lit in 3D is dark in 2D: ' + only3d.join(' '));
  assert(lit2d.size > 0, 'nobody was working, so this proved nothing');
  console.log('        %d owners lighting a monitor, both views agree', lit2d.size);
});

await xcheck('X8', 'the 3D palette is written in sRGB, like every colour in office.js', () => {
  /* THREE.Color.setHSL() defaults to the WORKING colour space, which is linear, so an
     l of .13 lands at about sRGB 40% and a value picked to sit under something ends up
     brighter than it. office.js writes plain CSS `hsl()`, i.e. sRGB, so every HSL
     value copied across has to say SRGBColorSpace or the two views drift apart. The
     symptom was department plates rendering LIGHTER than the rooms standing on them. */
  const lum = c => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  for (const hue of [199, 152, 41, 280, 12, 326, 96, 255]) {
    const plate = plateMaterial(hue).color, tint = deptColor(hue);
    // what a room's carpet actually renders as: the shell's baked colour times its tint
    const room = new THREE.Color(tint.r * COL.carpet.r, tint.g * COL.carpet.g,
                                 tint.b * COL.carpet.b);
    assert(lum(plate) < lum(room),
      `the department plate at hue ${hue} is lighter than the room standing on it ` +
      `(${lum(plate).toFixed(4)} vs ${lum(room).toFixed(4)})`);
  }
  /* and a character's albedo has to read as office.js's shade(hue, 60, 50) does */
  const c = createCharacters();
  try {
    const p = person('a', { hue: 199, state: 'type', last: 0 });
    c.sync([p], 1 / 60);
    const mesh = c.group.children.find(m => m.geometry.type === 'CapsuleGeometry');
    assert(mesh, 'the cheap LOD no longer draws a capsule body');
    const col = new THREE.Color();
    mesh.getColorAt(0, col);
    const hsl = {};
    col.getHSL(hsl, THREE.SRGBColorSpace);
    assert.strictEqual(Math.round(hsl.h * 360), p.hue, 'the body hue is not p.hue');
    assert(Math.abs(hsl.l - 0.50) < 0.12,
      `a busy teammate reads at sRGB lightness ${hsl.l.toFixed(3)}; office.js draws ` +
      'them at 50%. A linear-space setHSL lands near 0.77');
    console.log('        body albedo hsl(%d %d%% %d%%), office.js draws hsl(%d 60%% 50%%)',
      Math.round(hsl.h * 360), Math.round(hsl.s * 100), Math.round(hsl.l * 100), p.hue);
  } finally { c.dispose(); }
});

/* ============================================ Z. the world under the view === */
await check('Z1', 'the band is empty until the first room, and a sync must tolerate that', () => {
  Floor.reset();
  assert.deepStrictEqual(Floor.state.amenities, [], 'reset left the band standing');
  assert.strictEqual(Floor.state.blocked, null, 'reset left a grid behind');
  assert(Floor.AM_BAND && Floor.AM_BAND.w > 0,
    'AM_BAND must be derived at module load, so framing works before anything is built');
  Floor.ensureRoom('s1', 'alpha');
  assert.strictEqual(Floor.state.amenities.length, 11, 'the first room did not build the band');
  Floor.reset();
  Floor.buildAmenities();
  assert.strictEqual(Floor.state.amenities.length, 11,
    'buildAmenities() alone must work — scene.js may be asked to build the band itself');
  assert.strictEqual(Object.keys(Floor.state.rooms).length, 0);
});

/* was GAP 6. sync() returned early on `!F.blocked` and only THEN tested whether the
   room table had emptied — but Floor.reset() clears both in one call and ensureRoom
   rebuilds the grid and adds a room in one call, so there was no observable moment
   where a live grid had no rooms. clearWorld() could never fire and later rooms
   would land on stale instances. The order is now the other way round. */
await check('Z2', 'sync() tests for an emptied world before it guards on the grid', () => {
  Floor.reset();
  assert.strictEqual(Floor.state.blocked, null, 'reset no longer nulls the grid');
  Floor.ensureRoom('s1', 'alpha');
  assert(Floor.state.blocked !== null && Object.keys(Floor.state.rooms).length === 1,
    'ensureRoom no longer builds the grid and the room together');
  const guard = SCENE_SRC.indexOf('if (!F.blocked) return;');
  const teardown = SCENE_SRC.indexOf('clearWorld(); return;');
  assert(guard >= 0 && teardown >= 0, 'sync() no longer has both branches');
  assert(teardown < guard,
    'the grid guard is back in front of the teardown — clearWorld() is unreachable again');
  /* nothing in the app calls Floor.reset() today: only the suites do. */
  const app = readFileSync(new URL('./office.js', import.meta.url), 'utf8') +
              readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert(!/Floor\.reset\(/.test(app),
    'something now calls Floor.reset() at runtime — GAP 6 has teeth, fix it before shipping');
});

await check('Z3', 'a session whose metadata never arrives never reaches the 3D layer', () => {
  Floor.reset();
  Object.assign(St, { sessions: {}, agentMeta: {}, events: [], people: {},
    t0: 0, t1: 1e12, clock: 0, live: false, playing: true, si: 0,
    scanFrom: 0, since: 0, q: '', ff: false, catchUp: false, focus: null, wall: 0 });
  Sim.hooks.say = () => {}; Sim.hooks.reset = () => {};
  St.events = [{ t: 10, sid: 'ghost', aid: 'a1', kind: 'tool', tool: 'Read', say: 'x', seq: 1 }];
  St.clock = 20;
  Sim.advance(1 / 60);
  assert.strictEqual(Object.keys(St.people).length, 0,
    'a nameless session put somebody on the floor — it would open a "?" department');
  assert.strictEqual(Object.keys(Floor.state.rooms).length, 0, 'it built a room');
  const c = createCharacters();
  try { assert.strictEqual(c.sync(St.people, 1 / 60).cheap, 0); } finally { c.dispose(); }
  St.clock = 20 + Sim.IDLE + 1;
  Sim.advance(1 / 60);
  assert(St.events[0].done, 'the held event was never dropped; it pins the scan head forever');
});

await check('Z4', 'nobody holds a facility seat and a room zone at the same time', () => {
  /* the 3D LOD rule is the one-field test `p.fac || p.cowork`, so a person who is
     recorded in both places at once would be rigged as a band visitor while standing
     at their own desk */
  const ppl = freshSim(30, 100, 2);
  assert(ppl.length === 30);
  const held = key => {
    const out = [];
    for (const a of Floor.state.amenities)
      for (const z in (a._held || {})) if (a._held[z][key] !== undefined) out.push(a.kind + ':' + z);
    for (const r of Object.values(Floor.state.rooms))
      for (const z in (r._held || {})) if (r._held[z][key] !== undefined) out.push('room:' + z);
    return out;
  };
  let sawBand = 0;
  for (let t = 100; t < 100 + Sim.GONE; t += 11) {
    St.clock = t;
    Sim.advance(1 / 60);
    for (const p of Object.values(St.people)) {
      const h = held(p.key);
      if (p.fac) sawBand++;
      assert(h.length <= 1, `${p.key} holds ${h.length} spots at once: ${h.join(' ')}`);
      if (p.fac) assert(!h.some(k => k.startsWith('room:')),
        `${p.key} is in the ${p.fac.kind} and still holds ${h.join(' ')}`);
    }
  }
  assert(sawBand > 0, 'nobody ever walked up to the band — the fixture never exercised it');
});

await check('Z5', 'a scrub backwards and a scrub at 1800x leave the 3D layer consistent', () => {
  const c = createCharacters();
  try {
    freshSim(60, 100, 4);                            // si 4 = 1800x
    const F = Floor.state;
    const roster = () => Object.values(St.people);
    for (let t = 100; t < 900; t += 37) {
      St.clock = t;
      Sim.advance(1 / 60);
      const got = c.sync(roster(), 1 / 60);
      assert.strictEqual(got.full + got.cheap, roster().length, 'roster drifted at 1800x');
      if (V) {
        V.syncGlow(Sim);
        const typists = roster().filter(p => p.desk && !p.desk.hot &&
                                             St.clock - p.last < Sim.IDLE);
        assert.strictEqual(V.made.get('glow').items.length, typists.length,
          'the glow batch does not track the typists at 1800x');
      }
    }
    // backwards: rebuild wipes everyone, and the layer must drop every avatar
    Sim.rebuild(200);
    assert.strictEqual(Object.keys(St.people).length, 0, 'rebuild left people standing');
    assert.strictEqual(c.sync(roster(), 1 / 60).cheap, 0, 'avatars survived a scrub backwards');
    if (V) { V.syncGlow(Sim); assert.strictEqual(V.made.get('glow').items.length, 0,
      'monitors stayed lit through a scrub backwards'); }
    // and the same clock replays the same floor, which is what the batches are keyed on
    St.clock = 200;
    for (let i = 0; i < 8; i++) Sim.advance(1 / 60);
    const a = roster().map(p => `${p.key}@${p.x.toFixed(3)},${p.y.toFixed(3)}`).sort().join('|');
    Sim.rebuild(200);
    St.clock = 200;
    for (let i = 0; i < 8; i++) Sim.advance(1 / 60);
    const b = roster().map(p => `${p.key}@${p.x.toFixed(3)},${p.y.toFixed(3)}`).sort().join('|');
    assert.strictEqual(a, b, 'the same clock rebuilt a different floor');
    assert(roster().length > 0, 'the replay put nobody back');
    assert(Object.keys(F.rooms).length > 0);
  } finally { c.dispose(); }
});

/* ---------------------------------------------------------------- done --- */
console.error = realError;
console.warn = realWarn;
if (FAILS.length) {
  console.log('\n%d check(s) failed: %s', FAILS.length, FAILS.join(', '));
  console.log('See "KNOWN GAPS" at the bottom of test_view3d.mjs.');
  process.exit(1);
}
console.log('view3d ok');

/* ============================== KNOWN GAPS ==================================
   All six original gaps have been fixed, and every one is now pinned above as a
   POSITIVE guard that fails when the property breaks — not as a characterisation of
   the bug. The history is kept because it is what stops someone deleting a check
   they do not recognise; the "was GAP n" note above each one says which.

   1  props.js art(): `(x.art | 0) % COL.art.length` is negative for a negative
      index, and COL.art[-1] throws. floor.js only ever emits art 0..8, so nothing
      reaches it. Pinned by N3. Fix: `((x.art | 0) % n + n) % n`.

   2  props.js buildProp(): a prop with no w/h produces NaN positions and a NaN
      bounding sphere, which takes the whole instanced batch off screen rather than
      drawing one bad prop. floor.js always sets w/h. Pinned by N4.

   3  scene.js syncFocus() returns early when the focus has not CHANGED, and
      buildRoom() pushes every new shell instance at its department colour. A room
      that opens while another room is focused therefore stays at full brightness
      among its dimmed neighbours; the 2D view drops it to alpha .1. Reached by any
      session that starts while you are looking inside a room. Pinned by V8.
      Fix: push DIM in buildRoom while a focus is held, or drop the memo.

   4  scene.js and characters.js ignore St.q entirely. A search dims the whole 2D
      floor to alpha .1 except its hits; in 3D nothing changes, so the search box
      does nothing at all while the 3D view is showing. Pinned by X6.

   5  The two views disagree about who is working. 2D lights a desk monitor when its
      OWNER was active inside IDLE, wherever they are standing. 3D's glow also
      requires `p.state === 'type'`, so a room whose team is all up at the cafeteria
      shows every monitor lit in 2D and none in 3D. Pinned by X7. Dropping the state
      test would align them; it is a decision, not obviously a bug.

   6  scene.js sync() returns on `!F.blocked` BEFORE it tests whether the room table
      has emptied, and Floor.reset() clears both at once — so the clearWorld()
      teardown branch is unreachable via Floor.reset(), and rooms built after a reset
      would land on stale instances. Nothing calls Floor.reset() at runtime today
      (only the suites do), so this is latent; Z2 fails the moment something does.
      Fix: test the room table before the grid guard, or have Floor.reset() bump a
      generation counter the view can compare.

   Not gaps — recorded so they are not re-reported:
   - `rug` has no geometry in EITHER view, on purpose: ADDENDUM 1 forbids
     implementing it, because a rug with w/h would block the tile.
   - The 3D camera uses asin(0.5), not the atan(0.5) the contract's first draft
     named. asin is what makes the tile ratio exactly office.js's TW/TH = 2:1;
     atan gives 2.236:1 and true isometric 1.732:1. C2 pins the ratio against
     office.js's own constants rather than against a number written here.
   - Speech bubbles are 2D-only; 3D room, facility and department plates are sprites
     rather than screen-space text. Both deliberate.
   - characters.js renders every person with no camera culling, where office.js culls
     off-screen rooms. 3D is a superset, so nobody can vanish in it.
   - A monitor glow floating over a hot-desk stand-in was a gap when this suite was
     written and was fixed in scene.js while it was being written. V11 is now the
     positive check; do not re-report it.
   - The planter's foliage overhangs its pot by up to 0.26 tiles. Deliberate, and
     bounded by P5 so it cannot grow into the neighbouring tile.
   ========================================================================== */
