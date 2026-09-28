/* view3d/scene.js — the 3D view: renderer, camera, lights, and the incremental
   reconciliation of the scene graph against Floor's world. The 3D answer to
   office.js's drawRoomShell + drawProp + drawDepartments.

   Deliberately knows nothing about office.js, the 2D canvas, or characters.js.
   Geometry comes from props.js, colour from materials.js, and the world is read
   through the Sim / Floor objects handed to sync() — never imported, so this
   module can be loaded before either exists.

   The whole floor is static: rooms never move (floor.js guarantees it) and props
   never move at all. So sync() builds a room or a facility exactly once and then
   only ever touches per-instance colour (focus) and one small dynamic batch (lit
   monitors). Nothing here rebuilds geometry per frame. */

import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import * as Props from './props.js';
import {
  MAT, deptColor, amColor, plateMaterial, GROUND, CORRIDOR, BACKDROP, DIM, NEUTRAL,
  dispose as disposeMaterials,
} from './materials.js';

/* ---------------------------------------------------------------- camera --- */
/* asin(0.5), so the 3D floor projects at exactly the same tile ratio as the 2D one.
   An orthographic camera at azimuth 45 projects one world unit of x to (1/sqrt2)
   across and (sin(e)/sqrt2) down, so the on-screen ratio is 1/sin(e) : 1, and
   office.js's TW/TH is 2:1. That needs sin(e) = 0.5, not tan(e) = 0.5 — atan(0.5)
   gives 2.236:1 and true isometric (35.264) gives 1.732:1. Both are visibly wrong
   against the 2D view, which is the thing this has to sit beside. */
const ELEV = Math.asin(0.5);
const AZIMUTH = Math.PI / 4;
/* unit vector from target to camera: horizontal cos(e) split 45/45 across x and z,
   vertical sin(e). +x then reads right and +z reads left, matching office.js's iso() */
const OFFSET = new THREE.Vector3(
  Math.cos(ELEV) * Math.SQRT1_2, Math.sin(ELEV), Math.cos(ELEV) * Math.SQRT1_2);
const DIST = 600;              // ortho: distance only has to keep everything in front

/* screen basis, derived once, for fitting the frustum to a world box */
const RIGHT = new THREE.Vector3(Math.SQRT1_2, 0, -Math.SQRT1_2);
const UPC = new THREE.Vector3(
  -Math.sin(ELEV) * Math.SQRT1_2, Math.cos(ELEV), -Math.sin(ELEV) * Math.SQRT1_2);

/* wall deco is built facing +z; this spins it to face into the room from its wall */
const SIDE_ROT = { N: 0, S: Math.PI, W: Math.PI / 2, E: -Math.PI / 2 };
/* a chair is built facing N (floor.js dir 0 = looking -z) */
const DIR_ROT = [0, -Math.PI / 2, Math.PI, Math.PI / 2];

const SEAT_LIKE = new Set(['table', 'roundtable', 'longtable']);

/* ----------------------------------------------------------------- state --- */
let renderer = null, scene = null, camera = null, controls = null, canvas = null;
let frustum = 40;                       // world units of height the camera shows
const batches = new Map();              // key -> BatchSet
let shellBatch = null;                  // the one batch every team room instances
const roomIdx = new Map();              // sid -> instance index in shellBatch
const facDone = new Set();              // facility objects already built
const deptPlates = new Map();           // proj -> { mesh, n }
let bandPlate = null, roomPlate = null, poolPlate = null;
let corridorMesh = null, glowBatch = null, screenBatch = null;
let backdrop = null, backdropTex = null;
let groundRooms = -1, groundBand = false;   // what the plates were last built for
const labels = new Map();               // id -> { sprite, text }
let roomCount = 0, lastFocus = undefined, lastQ = undefined, userMoved = false;
let framedFocus = null;              // the room the camera was last framed onto

/* Set this to be called once per frame after the scene is up to date but before
   the draw — characters.js hangs its mixers here. Left null on purpose: scene.js
   must not know that module exists. */
export const hooks = { frame: null };

export const getScene = () => scene;
export const getCamera = () => camera;

/* ------------------------------------------------------------- instancing --- */
/* One BatchSet per distinct geometry (a prop type at a footprint, a room shell, a
   facility shell of one width). props.js merges each into one geometry per
   material, so a BatchSet holds one InstancedMesh per material and writes the same
   transform into each. Draw calls therefore scale with prop TYPES, not with rooms.

   Capacity doubles rather than growing by one: an InstancedMesh cannot be resized,
   so every growth is a fresh allocation plus a full rewrite. */
class BatchSet {
  constructor(buckets) {
    this.buckets = buckets;
    this.meshes = [];
    this.cap = 0; this.n = 0;
    this.m = new Float32Array(0);       // mirror of every instance matrix, for regrow
    this.c = new Float32Array(0);
  }

  _grow(need) {
    let cap = Math.max(8, this.cap || 8);
    while (cap < need) cap *= 2;
    const m = new Float32Array(cap * 16), c = new Float32Array(cap * 3);
    m.set(this.m); c.set(this.c);
    this.m = m; this.c = c; this.cap = cap;
    for (const mesh of this.meshes) { scene.remove(mesh); mesh.dispose(); }
    this.meshes = this.buckets.map(b => {
      const mesh = new THREE.InstancedMesh(b.geometry, b.material, cap);
      mesh.instanceColor =
        new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      /* An InstancedMesh's bounding sphere is the GEOMETRY's, which sits at the
         origin — leave culling on and the whole floor vanishes the moment the
         camera pans off tile (0,0). */
      mesh.frustumCulled = false;
      mesh.count = this.n;
      scene.add(mesh);
      return mesh;
    });
    for (let i = 0; i < this.n; i++) this._write(i);
  }

  _write(i) {
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.array.set(this.m.subarray(i * 16, i * 16 + 16), i * 16);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.array.set(this.c.subarray(i * 3, i * 3 + 3), i * 3);
      mesh.instanceColor.needsUpdate = true;
    }
  }

  push(matrix, color) {
    const i = this.n++;
    if (this.n > this.cap) this._grow(this.n);   // grow FIRST: it copies the mirrors
    this.m.set(matrix.elements, i * 16);
    this.c[i * 3] = color.r; this.c[i * 3 + 1] = color.g; this.c[i * 3 + 2] = color.b;
    this._write(i);
    for (const mesh of this.meshes) mesh.count = this.n;
    return i;
  }

  recolor(i, color) {
    if (i < 0 || i >= this.n) return;
    this.c[i * 3] = color.r; this.c[i * 3 + 1] = color.g; this.c[i * 3 + 2] = color.b;
    for (const mesh of this.meshes) {
      mesh.instanceColor.array.set(this.c.subarray(i * 3, i * 3 + 3), i * 3);
      mesh.instanceColor.needsUpdate = true;
    }
  }

  /* the dynamic batch refills itself every frame; capacity and buffers are reused */
  reset() { this.n = 0; for (const mesh of this.meshes) mesh.count = 0; }

  dispose() {
    for (const mesh of this.meshes) { scene.remove(mesh); mesh.dispose(); }
    for (const b of this.buckets) b.geometry.dispose();
    this.meshes.length = 0;
  }
}

function batch(key, build) {
  let b = batches.get(key);
  if (!b) {
    b = new BatchSet(build());
    if (!b.buckets.length) console.error(`[view3d] empty geometry for batch "${key}"`);
    batches.set(key, b);
  }
  return b;
}

/* ------------------------------------------------------------------ lights --- */
/* Three lights, no shadow maps: the budget caps real-time shadows at 20 characters
   and real sessions reach 135, so the only contact cue is the blob under each person,
   which is characters.js's job.

   The intensities look large because three r155+ dropped legacy lights (this build
   has _useLegacyLights = false), so intensity is physical and BRDF_Lambert divides
   by PI. The old 0.85 + 0.9 pair therefore exposed an up-facing surface at
   (0.85 + 0.9*cos) / PI ~= 0.48 of its own albedo — the whole floor rendered at
   roughly a third of the colour written in materials.js, which is exactly what
   "unlit and murky" was. Anything retuned here must keep the PI in mind.

   Exposed so an up-facing surface lands at ~1.45x albedo, which after the .74
   department tint puts a team-room carpet at office.js's own 19-20% and leaves the
   sRGB curve's whole usable range above it for desks, walls and people.

   The camera is locked, so only three faces of any box are ever visible: the top,
   the +z face and the +x face. They are lit to 1.00 / 0.70 / 0.50 of each other —
   office.js hand-paints its boxes at 1.00 / 0.68 / 0.39 in linear terms, so this is
   the same read with more light left in the darkest face, which is where the room
   interiors were disappearing. */
function addLights() {
  /* cool sky over a warm floor bounce: the split is what keeps an unlit underside
     from going the same dead grey as an unlit side */
  scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x3a3026, 2.85));

  /* Warm key from above and to the south (+z), a little east (+x), i.e. OFF the
     camera axis — a key light on the camera axis lights all three visible faces
     identically and every desk turns into one flat shape. Weighted further toward
     +z than before so the two visible vertical faces separate 2.5:1, not 1.4:1:
     a room's north wall now reads clearly brighter than its west wall. */
  const key = new THREE.DirectionalLight(0xfff2dc, 3.9);
  key.position.set(0.34, 1, 0.86);
  key.castShadow = false;
  scene.add(key);

  /* Cool fill aimed almost flat along +x — at the west wall's inward face and every
     desk's east side, the one visible orientation the key barely reaches. Without it
     that face crushes and the wall, the desks against it and anyone standing there
     all merge into one dark shape, which is where interior detail was going. */
  const fill = new THREE.DirectionalLight(0x9fc0ff, 0.85);
  fill.position.set(1, 0.34, -0.1);
  fill.castShadow = false;
  scene.add(fill);
}

/* ---------------------------------------------------------------- backdrop --- */
/* The frame behind the building. Without it the plan is a lit island in flat void and
   four fifths of the picture reads as nothing drawn — and now that the ground plate is
   cut to the footprint, that boundary is MORE visible, not less.

   A child of the camera, so its local space is screen space: it cannot slide out of
   frame on a pan, never needs re-centring, and a vignette belongs to the frame anyway,
   not to the world. Costs one draw call, and per frame only the scale set in
   sizeBackdrop(). Values come from BACKDROP, which is the page's own chrome. */
function backdropTexture() {
  const S = 256;                       // a gradient needs no more; bilinear does the rest
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const cx = cv.getContext('2d');
  const lift = cx.createLinearGradient(0, 0, 0, S);
  lift.addColorStop(0, BACKDROP.top);
  lift.addColorStop(0.55, BACKDROP.mid);
  lift.addColorStop(1, BACKDROP.edge);
  cx.fillStyle = lift;
  cx.fillRect(0, 0, S, S);
  /* The vignette proper, painted in the page's body colour so the frame edges dissolve
     into the surrounding UI instead of stopping at the canvas border. Centre is biased
     above the middle: the building is framed centrally and light reads as coming from
     above. Held fully transparent out to 0.55 so the lift is a broad pool, not a spot. */
  const rgb = BACKDROP.edge.match(/\w\w/g).map(h => parseInt(h, 16)).join(',');
  const vig = cx.createRadialGradient(S / 2, S * 0.42, 0, S / 2, S * 0.42, S * 0.62);
  vig.addColorStop(0, `rgba(${rgb},0)`);
  vig.addColorStop(0.55, `rgba(${rgb},0)`);
  vig.addColorStop(1, `rgba(${rgb},1)`);
  cx.fillStyle = vig;
  cx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function addBackdrop() {
  if (typeof document === 'undefined') return;     // node: sync() must still run
  backdropTex = backdropTexture();
  backdrop = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: backdropTex,
                                  depthTest: false, depthWrite: false }));
  /* just past the near plane, and it writes no depth, so it can never occlude anything */
  backdrop.position.set(0, 0, -(camera.near + 0.5));
  backdrop.renderOrder = -1;
  backdrop.frustumCulled = false;
  camera.add(backdrop);
  scene.add(camera);      // a camera's children are only traversed if it is in the scene
}

/* An orthographic camera's on-screen extent is (right - left) / zoom, and OrbitControls'
   dolly moves zoom rather than the frustum — so this cannot live in applyFrustum(), it
   has to run after controls.update(). Slightly oversized so no edge texel shows. */
function sizeBackdrop() {
  if (!backdrop) return;
  const z = camera.zoom || 1;
  backdrop.scale.set(1.02 * (camera.right - camera.left) / z,
                     1.02 * (camera.top - camera.bottom) / z, 1);
}

/* -------------------------------------------------------------------- init --- */
export function init(canvasEl) {
  if (!canvasEl) throw new Error('View3D.init needs a canvas element');
  canvas = canvasEl;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x0b0d13, 1);      // same void office.js paints

  scene = new THREE.Scene();

  addLights();

  camera = new THREE.OrthographicCamera(-20, 20, 12, -12, 1, DIST * 3);
  camera.position.copy(OFFSET).multiplyScalar(DIST);
  addBackdrop();

  controls = new OrbitControls(camera, canvas);
  /* Lock the camera to the dimetric angle: min === max on both angles means
     OrbitControls re-seats the camera onto that angle on every update, so no
     input path can ever leave it. OrbitControls' polar angle is measured from
     +y, hence PI/2 - elevation. */
  const polar = Math.PI / 2 - ELEV;
  controls.minPolarAngle = controls.maxPolarAngle = polar;
  controls.minAzimuthAngle = controls.maxAzimuthAngle = AZIMUTH;
  controls.enableRotate = false;
  controls.screenSpacePanning = true;
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY,
                            RIGHT: THREE.MOUSE.PAN };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
  controls.addEventListener('start', () => { userMoved = true; });
  controls.update();

  applyFrustum();
}

/* ----------------------------------------------------------------- framing --- */
function applyFrustum() {
  const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
  const half = frustum / 2, aspect = w / h;
  camera.left = -half * aspect; camera.right = half * aspect;
  camera.top = half; camera.bottom = -half;
  camera.updateProjectionMatrix();
}

/* Fit a set of tile rectangles by projecting their corners onto the screen basis.
   Not a Box3: the camera is oblique, so the extent that matters is along RIGHT and
   UPC, not along world x/y/z. */
function frameTo(rects, pad = 0.92) {
  if (!rects.length) return;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.gx - 1); x1 = Math.max(x1, r.gx + r.w + 1);
    z0 = Math.min(z0, r.gy - 2); z1 = Math.max(z1, r.gy + r.h + 1);
  }
  const mid = new THREE.Vector3((x0 + x1) / 2, 0.5, (z0 + z1) / 2);
  let ex = 0, ey = 0;
  const v = new THREE.Vector3();
  for (const x of [x0, x1]) for (const z of [z0, z1]) for (const y of [0, 2.2]) {
    v.set(x, y, z).sub(mid);
    ex = Math.max(ex, Math.abs(v.dot(RIGHT)));
    ey = Math.max(ey, Math.abs(v.dot(UPC)));
  }
  const aspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1);
  frustum = Math.max(2 * ey, 2 * ex / aspect) / pad;
  controls.target.copy(mid);
  camera.position.copy(mid).addScaledVector(OFFSET, DIST);
  camera.zoom = 1;
  controls.update();
  applyFrustum();
}

/* ------------------------------------------------------------------- build --- */
const T = new THREE.Matrix4(), R = new THREE.Matrix4(), S = new THREE.Matrix4();

function slab(material, x, y, z, w, d) {
  const g = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2)
    .translate(x + w / 2, y, z + d / 2);
  const m = new THREE.Mesh(g, material);
  scene.add(m);
  return m;
}

/* The base plate is the OCCUPIED footprint, never F.gw x F.gh. floor.js sizes the
   grid so a department can grow into it — buildAmenities alone takes it to 96 x 54 —
   so with one room open a full-grid quad is mostly a dead field off the +x side of
   frame, which is the bottom right of a 45-degree view.
   Two quads, not one: the band is 94 wide from the very first frame while the rooms
   start one column wide, and a single rectangle covering both is mostly the L-shaped
   gap between them. Rooms never move (floor.js guarantees it) and the footprint only
   grows, so the room count is a sufficient test for "rebuild". */
const PAD = 2;                          // tiles of plate showing past the outermost wall

function plateRect(rects) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.gx); z0 = Math.min(z0, r.gy);
    x1 = Math.max(x1, r.gx + r.w); z1 = Math.max(z1, r.gy + r.h);
  }
  if (x0 === Infinity) return null;
  return { x: x0 - PAD, z: z0 - PAD, w: x1 - x0 + PAD * 2, d: z1 - z0 + PAD * 2 };
}

function drop(mesh) {
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); }
  return null;
}

/* The pool of light the building stands in — the fix for a footprint that otherwise
   reads as cut out and pasted onto the backdrop, and for the hard cut where the opaque
   plate stops. One quad for the WHOLE footprint, not one per plate: two overlapping
   fades would double-blend where they meet and print a seam across the corridor.

   Alpha ramps over POOL_FADE tiles from the plate's rim outwards. It is per-vertex, not
   a texture, so the ramp is the same width in tiles whatever aspect the footprint grows
   into — a texture's ramp would stretch with the quad and go lopsided the moment the
   rooms got wider than the band. Sits below the plates, so depth hides everything
   inside the rim, including the ramp's inner crease. */
const POOL_FADE = 12;

function buildPool(r) {
  const w = r.w + POOL_FADE * 2, d = r.d + POOL_FADE * 2;
  const cx = r.x + r.w / 2, cz = r.z + r.d / 2;
  const g = new THREE.PlaneGeometry(w, d, 3, 3)
    .rotateX(-Math.PI / 2).translate(cx, -0.2, cz);
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 4);
  for (let i = 0; i < p.count; i++) {
    /* PlaneGeometry puts its interior ring a third of the way in; pull it out to the
       plate's own rim, which is what makes the ramp POOL_FADE wide and no wider */
    const outX = Math.abs(p.getX(i) - cx) > w / 4;
    const outZ = Math.abs(p.getZ(i) - cz) > d / 4;
    if (!outX) p.setX(i, cx + Math.sign(p.getX(i) - cx) * r.w / 2);
    if (!outZ) p.setZ(i, cz + Math.sign(p.getZ(i) - cz) * r.d / 2);
    col[i * 4] = col[i * 4 + 1] = col[i * 4 + 2] = 1;   // colour lives on MAT.pool
    col[i * 4 + 3] = outX || outZ ? 0 : 1;
  }
  p.needsUpdate = true;                 // the rings were moved after the buffer was built
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  const mesh = new THREE.Mesh(g, MAT.pool);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}

function rebuildGround(F, Floor) {
  bandPlate = drop(bandPlate);
  roomPlate = drop(roomPlate);
  poolPlate = drop(poolPlate);
  corridorMesh = drop(corridorMesh);

  const band = Floor.AM_BAND;
  const bandR = band && band.w
    ? plateRect([{ gx: band.x, gy: band.y, w: band.w, h: band.h }]) : null;
  const roomR = plateRect(Object.values(F.rooms));
  if (bandR) bandPlate = slab(GROUND, bandR.x, -0.12, bandR.z, bandR.w, bandR.d);
  if (roomR) roomPlate = slab(GROUND, roomR.x, -0.12, roomR.z, roomR.w, roomR.d);

  const ends = [bandR, roomR].filter(Boolean);
  if (ends.length) {
    const x = Math.min(...ends.map(r => r.x));
    const z = Math.min(...ends.map(r => r.z));
    const w = Math.max(...ends.map(r => r.x + r.w)) - x;
    const d = Math.max(...ends.map(r => r.z + r.d)) - z;
    /* The corridor is free across the whole grid in floor.js, but only the stretch
       that actually connects something is worth drawing. */
    corridorMesh = slab(CORRIDOR, x, -0.04, Floor.CORRIDOR_Y, w, Floor.CORRIDOR_H);
    /* the pool takes the union, including the L-shaped gap between the band and the
       rooms — a glow across that gap is what ties the two plates into one building */
    poolPlate = buildPool({ x, z, w, d });
  }
  groundRooms = Object.keys(F.rooms).length;
  groundBand = !!bandR;
}

/* Which way a chair faces. floor.js's sit() gives a chair no direction, so read it
   off the thing it is pulled up to — the table, or in coworking the bench desk. */
function chairDir(pr, rect) {
  let best = null, bd = Infinity;
  const cx = pr.x + 0.5, cz = pr.y + 0.5;
  /* Nearest point on the footprint, not its centre: an 8-tile boardroom table has
     its centre four tiles from the chair at either end, which read as "nothing to
     face" and turned both end chairs to face the wall. */
  const consider = (x, y, w, h) => {
    const dx = Math.min(Math.max(cx, x), x + w) - cx;
    const dz = Math.min(Math.max(cz, y), y + h) - cz;
    const d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = [dx, dz]; }
  };
  for (const q of rect.props || []) if (SEAT_LIKE.has(q.type)) consider(q.x, q.y, q.w, q.h);
  for (const d of rect.desks || []) consider(d.x, d.y, 1, 1);
  if (!best || bd > 4) return 0;                   // nothing within two tiles: face N
  const [dx, dz] = best;
  return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 1 : 3) : (dz > 0 ? 2 : 0);
}

function addProp(pr, rect, color) {
  if (Props.SKIP.has(pr.type)) return;
  const deco = Props.WALL_DECO.has(pr.type);
  const side = deco ? Props.wallSideOf(pr, rect) : null;
  if (deco && !side) {
    /* a board that is not actually on a wall — floor.js's team rooms still put a
       free-standing 'board' beside the meeting table. Give it legs rather than
       hanging it in mid-air. */
    const key = `${pr.type}|stand`;
    const b = batch(key, () => Props.buildProp(pr.type, 1, 1, { standing: true, art: pr.art }));
    T.makeTranslation(pr.x + 0.5, 0, pr.y + 0.5);
    b.push(T, color);
    return;
  }
  if (deco) {
    const key = `${pr.type}|${pr.art === undefined ? '-' : pr.art}`;
    const b = batch(key, () => Props.buildProp(pr.type, 1, 1, { art: pr.art }));
    T.makeTranslation(pr.x + 0.5, 0, pr.y + 0.5)
      .multiply(R.makeRotationY(SIDE_ROT[side]));
    b.push(T, color);
    return;
  }
  /* Footprint is part of the key: a 4x2 table built by stretching a 2x2 one gets
     fat legs. One batch per type per footprint is still one per type in practice —
     floor.js uses two footprints at most for anything. */
  const key = `${pr.type}|${pr.w}x${pr.h}`;
  const b = batch(key, () => Props.buildProp(pr.type, pr.w, pr.h, {}));
  if (pr.type === 'chair') {
    const rot = DIR_ROT[chairDir(pr, rect)];
    T.makeTranslation(pr.x + 0.5, 0, pr.y + 0.5)
      .multiply(R.makeRotationY(rot))
      .multiply(S.makeTranslation(-0.5, 0, -0.5));
  } else {
    T.makeTranslation(pr.x, 0, pr.y);
  }
  b.push(T, color);
}

/* Whether a shell is shown at its own colour or knocked back, for rooms and for the
   band. These are office.js's own predicates — its vis() and amDim() — and the one
   place either is decided, so a shell being BUILT and a shell being RE-TINTED can never
   disagree. They did: buildRoom always pushed the department colour, so a room that
   opened while the user was inside another room stayed at full brightness for the rest
   of the session, which happens on any machine busy enough to start a second session. */
function roomTint(Sim, r) {
  const focus = Sim.St.focus;
  return (focus && focus !== r) || !Sim.roomHit(r)
    ? DIM : deptColor(Sim.deptHue(r.proj));
}

function buildRoom(r, Sim, Floor) {
  if (!shellBatch) shellBatch = batch('room', () => Props.buildRoomShell(Floor, r));
  T.makeTranslation(r.gx, 0, r.gy);
  roomIdx.set(r.sid, shellBatch.push(T, roomTint(Sim, r)));
  for (const pr of r.props) addProp(pr, { gx: r.gx, gy: r.gy, w: r.w, h: r.h,
                                          props: r.props, desks: r.desks }, NEUTRAL);
}

/* The shell carries the facility's tint and its props do not — same division as a
   team room, and the same one office.js uses: it tints the tiles and walls from
   AM_TINT but paints every prop from the shared palette. Tinting the props too would
   turn the cafeteria's white crockery amber.

   KNOWN GAP: office.js also knocks the whole band back behind a focus and behind a
   search it cannot answer (its amDim()), and this does not. Closing it needs each
   facility's instance index kept so it can be re-tinted, which the shells being split
   across one batch per width makes a Map rather than an array — left out on purpose,
   because it is not one of the reported defects and it would force a change on the
   test harness's injected scope. */
function buildFacility(a, Floor) {
  const b = batch(Props.shellKey(a), () => Props.buildFacilityShell(Floor, a));
  T.makeTranslation(a.gx, 0, a.gy);
  b.push(T, amColor(a.kind));
  for (const pr of a.props) addProp(pr, a, NEUTRAL);
  facDone.add(a);
}

/* A department's plate is one quad under its rooms. Rebuilt only when the
   department gains a room, which is a handful of times per session. */
function syncDepts(F, Sim) {
  for (const proj in F.depts) {
    const d = F.depts[proj];
    const rs = d.rooms.map(sid => F.rooms[sid]).filter(Boolean);
    if (!rs.length) continue;
    const have = deptPlates.get(proj);
    if (have && have.n === rs.length) continue;
    if (have) { scene.remove(have.mesh); have.mesh.geometry.dispose(); }
    const x0 = Math.min(...rs.map(r => r.gx)) - 1.4;
    const z0 = Math.min(...rs.map(r => r.gy)) - 1.4;
    const x1 = Math.max(...rs.map(r => r.gx + r.w)) + 1.4;
    const z1 = Math.max(...rs.map(r => r.gy + r.h)) + 1.4;
    const mesh = slab(plateMaterial(Sim.deptHue(proj)), x0, -0.06, z0, x1 - x0, z1 - z0);
    deptPlates.set(proj, { mesh, n: rs.length });
  }
}

/* office.js drops every unfocused or unmatched shell to alpha .1. Per-instance alpha is
   not a thing, so the shell instance is tinted dark instead. Props are left alone: they
   are batched across rooms, and tracking each room's prop indices to dim them would cost
   more bookkeeping than the effect is worth.

   Memoised on focus AND query: the search box moves St.q with no focus change, so keying
   on focus alone meant `/` and the search field did nothing whatever in 3D — every frame
   came out byte-identical however the query changed. Sim.roomHit walks the people table
   per room, which is why this runs on change rather than per frame. */
function syncFocus(Sim, F) {
  const focus = Sim.St.focus || null, q = Sim.St.q || '';
  if (focus === lastFocus && q === lastQ) return;
  lastFocus = focus; lastQ = q;
  if (!shellBatch) return;
  for (const [sid, i] of roomIdx) {
    const r = F.rooms[sid];
    if (r) shellBatch.recolor(i, roomTint(Sim, r));
  }
}

/* The only thing here that is not static: the state of every owned monitor.

   Read off Sim.St.people and p.desk rather than off the desks, so this never has to know
   that an amenity desk's `by` holds a full sid|aid key while a room desk's holds a bare
   agent id — the trap that once left every monitor dark (EDGE_CASES H1). Iterating people
   also means "the desk's owner" needs no lookup at all: it is whoever holds p.desk. */
/* One quad per owned desk, sitting exactly on that monitor's own screen face, which is
   all office.js changes too: drawDesk repaints the monitor to #8bd9fb and leaves the
   rest of the room alone. So this is the monitor lighting up, not a lamp switching on
   over the desk — no billboard, nothing the size of a tile, and nothing that can
   paint over somebody sitting there. It is plain depth-tested geometry a fraction in
   front of the baked dark panel, so a character nearer the camera occludes it.

   MONITOR mirrors the screen box in props.js deskParts(), which is private to that
   module: change the desk there and these numbers have to follow. A monitor rect
   exported from props.js would kill the duplication. */
const MONITOR = {
  w: .66, h: .42,          // the baked panel is .58 x .36 — a hair over, so the lit
                           // face reads past the bezel the way office.js's taller
                           // "on" monitor does, and stays a third of a tile wide
  cy: Props.H.desk + .34,  // screen centre: baked from H.desk + .16, .36 tall
  dx: .48, dxBig: .95,     // desk half-width: .96 normally, 1.9 for a boss desk
  /* the camera-facing side of the panel, named for where the occupant sits:
     floor.js's N is -z and S is +z, and the monitor goes opposite the seat */
  faceSeatS: .14, faceSeatN: .60,
  lift: .006,              // clear of the baked panel without reading as detached
  bloom: .6,               // halo radius; spills ~.27 past the face's widest edge
};

/* A fan: alpha 1 at the centre, 0 all round the rim, so the falloff is linear and the
   halo has no edge anywhere — which is the whole difference from the flat translucent
   quad of the first attempt. Additive, so it can only add light and never paint over
   anyone, and it sits .003 BEHIND the lit face, so the opaque face hides the hot middle
   and only the spill around it shows. The face stays the thing you read. */
function bloomGeometry() {
  const g = new THREE.CircleGeometry(MONITOR.bloom, 20).translate(0, 0, -0.003);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    col[i * 4] = col[i * 4 + 1] = col[i * 4 + 2] = 1;   // colour lives on MAT.bloom
    col[i * 4 + 3] = i === 0 ? 1 : 0;      // CircleGeometry's vertex 0 is the centre
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  return g;
}

/* Active: the bright face and its halo. Two buckets, one instance matrix — the face and
   its halo are always at the same desk, so the halo's offset is baked into its geometry
   rather than pushed per instance. */
function glowBuckets() {
  return [{ material: MAT.monitor,
            /* PlaneGeometry already faces +z, which is the side the camera sees */
            geometry: new THREE.PlaneGeometry(MONITOR.w, MONITOR.h) },
          { material: MAT.bloom, geometry: bloomGeometry() }];
}

/* Occupied: the same face, slate instead of cyan, and no halo. The missing halo is the
   cue that carries at Fit zoom, where both faces are only a few pixels. */
function screenBuckets() {
  return [{ material: MAT.monitorIdle,
            geometry: new THREE.PlaneGeometry(MONITOR.w, MONITOR.h) }];
}

/* Three states, driven by the desk's OWNER and not by where that owner is standing:

     empty      nobody holds the desk          the baked dark panel, untouched
     occupied   owner logged on, paused        slate, no halo
     active     owner's last event within IDLE  bright cyan plus the halo

   Owner, not occupant, is the whole point of the rule. A person holds a desk until GONE
   (900s) but only reads as active for IDLE (90s), so gating on "seated AND recently
   active" left a character staring at a black panel for 810 of every 900 seconds. Gating
   on seated at all still blacked out the screen of anyone who stepped to the cafeteria,
   and disagreed with the 2D view, which lights a desk from its owner's activity wherever
   that owner happens to be standing. Both views now follow the same rule.

   A desk goes in exactly ONE batch: the two faces are coplanar, so pushing to both would
   z-fight rather than layer. */
function syncGlow(Sim) {
  if (!glowBatch) glowBatch = batch('glow', glowBuckets);
  if (!screenBatch) screenBatch = batch('screen', screenBuckets);
  glowBatch.reset();
  screenBatch.reset();
  const { St, IDLE } = Sim;
  for (const k in St.people) {
    const p = St.people[k];
    /* desk.hot is floor.js's overflow spot in the break or meeting area — there is no
       desk built there, so a lit monitor would be hanging in mid-air */
    if (!p.desk || p.desk.hot) continue;
    const d = p.desk;
    /* deskParts puts the monitor on the far side of the desk from the seat, so which
       face the camera sees depends on which side the occupant sits */
    T.makeTranslation(d.x + (p.boss ? MONITOR.dxBig : MONITOR.dx), MONITOR.cy,
                      d.y + (d.seat.y > d.y ? MONITOR.faceSeatS : MONITOR.faceSeatN) + MONITOR.lift);
    (St.clock - p.last < IDLE ? glowBatch : screenBatch).push(T, NEUTRAL);
  }
}


/* ------------------------------------------------------------------ labels --- */
/* office.js paints a plaque over every room and a sign over every department, and
   without them a 3D floor is thirty identical grey rooms. A canvas texture on a
   Sprite is the only text three.js gives you without a font loader, and a sprite
   is one draw call each — 40 rooms plus a dozen signs is a rounding error next to
   the instanced batches.

   Skipped entirely when there is no document, so sync() stays runnable in node. */
function labelSprite(text, px, ink, bg) {
  const pad = 18, fs = px;
  const cv = document.createElement('canvas');
  const cx = cv.getContext('2d');
  const font = `600 ${fs}px ui-monospace,Menlo,Consolas,monospace`;
  cx.font = font;
  cv.width = Math.ceil(cx.measureText(text).width) + pad * 2;
  cv.height = Math.ceil(fs * 1.9);
  const c2 = cv.getContext('2d');
  c2.font = font;
  c2.fillStyle = bg;
  c2.beginPath();
  c2.roundRect(0, 0, cv.width, cv.height, 8);
  c2.fill();
  c2.fillStyle = ink;
  c2.textBaseline = 'middle';
  c2.fillText(text, pad, cv.height / 2 + 1);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, depthTest: false,
  }));
  /* 26 canvas px to one world tile keeps the plaque the same apparent size as the
     2D one at the default zoom; sprites do not scale with the ortho frustum, so
     this is a fixed world size and the text grows and shrinks with the camera. */
  sprite.scale.set(cv.width / 26, cv.height / 26, 1);
  return sprite;
}

function setLabel(id, text, x, y, z, px, ink, bg) {
  if (typeof document === 'undefined' || !text) return;
  const have = labels.get(id);
  if (have) {
    if (have.text === text) return;             // titles arrive late and then change
    scene.remove(have.sprite);
    have.sprite.material.map.dispose();
    have.sprite.material.dispose();
  }
  const sprite = labelSprite(text, px, ink, bg);
  sprite.position.set(x, y, z);
  scene.add(sprite);
  labels.set(id, { sprite, text });
}

/* plaque heights: clear of H.wall (1.25) and of anything standing in the room */
const H_LABEL_ROOM = 2.4, H_LABEL_FAC = 2.2, H_LABEL_DEPT = 3.4;

function syncLabels(F, Sim) {
  for (const sid in F.rooms) {
    const r = F.rooms[sid];
    const hue = Sim.deptHue(r.proj);
    setLabel('r:' + sid, Sim.roomName(r), r.gx + r.w / 2, H_LABEL_ROOM, r.gy - 1,
             22, `hsl(${hue} 80% 76%)`, 'rgba(8,10,16,.92)');
  }
  for (const a of F.amenities)
    setLabel('a:' + a.kind, a.label, a.gx + a.w / 2, H_LABEL_FAC, a.gy - 0.6,
             20, '#b9c4da', 'rgba(8,10,16,.88)');
  for (const proj in F.depts) {
    const rs = F.depts[proj].rooms.map(sid => F.rooms[sid]).filter(Boolean);
    if (!rs.length) continue;
    const x0 = Math.min(...rs.map(r => r.gx)), x1 = Math.max(...rs.map(r => r.gx + r.w));
    const z0 = Math.min(...rs.map(r => r.gy));
    setLabel('d:' + proj, proj.toUpperCase(), (x0 + x1) / 2, H_LABEL_DEPT, z0 - 3.2,
             28, `hsl(${Sim.deptHue(proj)} 75% 74%)`, `hsl(${Sim.deptHue(proj)} 40% 13%)`);
  }
}

/* -------------------------------------------------------------------- sync --- */
export function sync(Sim, Floor) {
  if (!scene) throw new Error('View3D.sync before init');
  const F = Floor.state;
  /* Floor.reset() wipes rooms and amenities out from under us. Detect it by the room
     table emptying and start the scene over, or every later room lands on top of stale
     instances.

     This has to come BEFORE the F.blocked guard: reset() nulls the grid and empties the
     rooms in the same call, so testing the grid first made this branch unreachable and
     a reset would have left every later room sitting on stale instances. reset() leaves
     F.rooms as an object, so Object.keys is safe either way. */
  const n = Object.keys(F.rooms).length;
  if (!n && roomIdx.size) { clearWorld(); return; }

  if (!F.blocked) return;                  // nothing built yet; Floor.reset() leaves this null

  const band = Floor.AM_BAND;
  const hasBand = !!(band && band.w);
  if (n !== groundRooms || hasBand !== groundBand) rebuildGround(F, Floor);

  /* Amenities do not exist until the first ensureRoom() runs buildAmenities(), so
     the band is picked up on whichever sync() first sees it rather than at init. */
  for (const a of F.amenities) if (!facDone.has(a)) buildFacility(a, Floor);
  for (const sid in F.rooms) if (!roomIdx.has(sid)) buildRoom(F.rooms[sid], Sim, Floor);

  syncDepts(F, Sim);
  syncLabels(F, Sim);
  syncFocus(Sim, F);
  syncGlow(Sim);

  if (Sim.St.focus && Sim.St.focus !== framedFocus) {
    framedFocus = Sim.St.focus;
    frameTo([Sim.St.focus], 0.86);
  } else if (!Sim.St.focus && (n !== roomCount || framedFocus)) {
    framedFocus = null;
    if (!userMoved && !Sim.St.userMoved) {
      const rects = Object.values(F.rooms);
      if (hasBand) rects.push({ gx: band.x, gy: band.y, w: band.w, h: band.h });
      frameTo(rects, 0.94);
    }
  }
  roomCount = n;
}

/* ------------------------------------------------------------------ render --- */
export function render(dt) {
  if (!renderer) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w && h && (canvas.width !== Math.floor(w * renderer.getPixelRatio()) ||
                 canvas.height !== Math.floor(h * renderer.getPixelRatio()))) {
    renderer.setSize(w, h, false);
    applyFrustum();
  }
  controls.update();                       // damping needs this every frame
  sizeBackdrop();                          // after update(): dolly changes camera.zoom
  if (hooks.frame) hooks.frame(dt);        // characters.js advances its mixers here
  renderer.render(scene, camera);
}

/* ----------------------------------------------------------------- teardown --- */
function clearWorld() {
  for (const b of batches.values()) b.dispose();
  batches.clear();
  shellBatch = null; glowBatch = null; screenBatch = null;
  roomIdx.clear(); facDone.clear();
  for (const p of deptPlates.values()) { scene.remove(p.mesh); p.mesh.geometry.dispose(); }
  deptPlates.clear();
  for (const l of labels.values()) {
    scene.remove(l.sprite);
    l.sprite.material.map.dispose();
    l.sprite.material.dispose();
  }
  labels.clear();
  bandPlate = drop(bandPlate);
  roomPlate = drop(roomPlate);
  poolPlate = drop(poolPlate);
  corridorMesh = drop(corridorMesh);
  groundRooms = -1; groundBand = false; roomCount = 0;
  lastFocus = undefined; lastQ = undefined; framedFocus = null;
}

export function dispose() {
  if (!renderer) return;
  clearWorld();
  if (backdrop) {
    camera.remove(backdrop);
    backdrop.geometry.dispose();
    backdrop.material.dispose();
    backdropTex.dispose();
    backdrop = null; backdropTex = null;
  }
  controls.dispose();
  disposeMaterials();
  renderer.dispose();
  scene = null; camera = null; controls = null; renderer = null; canvas = null;
  userMoved = false;
}
