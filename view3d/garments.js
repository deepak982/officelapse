/* view3d/garments.js — clothing geometry, skinned by copying the body's own weights.

   A garment is a lofted tube of rings, each ring one radius per sector, all of them
   MEASURED off the bind-pose body mesh rather than tabulated: the same code fits the
   71-bone male rig and the 65-bone female one, and would fit a third. Every garment
   vertex then takes the skinIndex and skinWeight of its nearest bind-pose body vertex
   verbatim, so the shirt bends at the elbow and the trousers at the knee on all 18
   clips, with no new bones and no new animation.

   buildFace is the odd one out: a static decal in Head-bone local space, parented like
   the hair rather than skinned. It lives here because it is the same measuring machinery.

   Not a policy module. Who wears what, in what colour, is characters.js's call. */

import * as THREE from '../vendor/three.module.js';
import { mergeGeometries } from '../vendor/BufferGeometryUtils.js';

export const GARMENTS = ['top', 'topLong', 'trousers', 'skirt', 'jacket'];
export const EXPRESSIONS = ['idle', 'focus', 'talk'];

export const OPT = {
  /* Standoff from the measured body surface: cloth thickness, NOT the thing that stops
     skin poking through. Coverage comes from circumscribing every ring by 1/cos(pi/seg),
     the exact amount a flat chord cuts inside the two vertices it spans; with that and
     the slab quota in place a sweep over both rigs finds zero skin outside the cloth at
     every offset from 0 up. What the offset buys is separation — at 0 the two surfaces
     are coincident at each measured extreme and z-fight — and room to move under a pose. */
  offset: 0.018,
  jacketOffset: 0.030,   // a jacket hangs off the body, not on it
  collarRise: 0.030,     // the collar's vertical stand
  seg: 12,               // sectors round the torso; 12 round a limb, 14 round a skirt
  skirtHem: 0.62,        // just above the knee. Raise for a dress, drop for a long one
  skirtFlare: 1.55,      // hem radius / waist radius
  faceLift: 0.004,       // how far a face feature stands off the skull
};

/* Dominant-bone grouping, same idea as characters.js's splitRegions: it is the only
   way to measure the torso's cross-section without the T-posed arms passing through
   the slab and reporting a 0.97 shoulder. */
const G_TORSO = 1, G_ARM = 2, G_LEG = 4, G_HEAD = 8;
const groupOf = n =>
  /^(upperarm|lowerarm|hand|index_|middle_|ring_|pinky_|thumb_)/.test(n) ? G_ARM :
  /^(thigh_|calf_|foot_|ball_)/.test(n) ? G_LEG :
  /^(pelvis|spine_|clavicle)/.test(n) ? G_TORSO : G_HEAD;

/* Bones every garment is placed from. All eight are core UE names present on both rigs;
   nothing here indexes the skeleton by position. */
const NEED = ['pelvis', 'neck_01', 'thigh_l', 'calf_l', 'foot_l',
  'upperarm_l', 'lowerarm_l', 'hand_l'];

// ring axis -> its two cross axes. Torso/legs/skirt run up y, a T-posed sleeve along x.
const CROSS = [[1, 2], [0, 2]];

const bodies = new WeakMap();   // skeleton -> the sampled bind pose, built once

/* ----------------------------------------------------------------- body --- */

/* Every skinned mesh on the rig, not only the one handed in — the asset splits a person
   across primitives and measuring one of them misses half the silhouette — but never the
   M_Joints blobs. That mesh is one sphere per bone, median diameter 0.053, and a shoulder
   sphere is wider than the arm it sits on: measured, it inflates a shirt into a duvet and
   still pokes out at the elbow. It is not drawn either. Matched on the material name,
   the same signal characters.js's JOINT_MAT already uses. */
const JOINT_MAT = /joint/i;
function skinsOf(mesh) {
  let top = mesh;
  while (top.parent) top = top.parent;
  const out = [];
  top.traverse(o => {
    if (!o.isSkinnedMesh || o.skeleton !== mesh.skeleton) return;
    if ([].concat(o.material).some(m => m && JOINT_MAT.test(m.name || ''))) return;
    out.push(o);
  });
  return out.length ? out : [mesh];
}

function sampleBody(mesh) {
  const hit = bodies.get(mesh.skeleton);
  if (hit) return hit;
  const skins = skinsOf(mesh);
  let n = 0;
  for (const s of skins) n += s.geometry.attributes.position.count;
  const b = {
    n, p: new Float32Array(n * 3), nr: new Float32Array(n * 3),
    si: new Uint16Array(n * 4), sw: new Float32Array(n * 4), g: new Uint8Array(n),
  };
  const K = ['X', 'Y', 'Z', 'W'];
  let at = 0;
  for (const s of skins) {
    const g = s.geometry, pos = g.attributes.position, nor = g.attributes.normal;
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    if (!si || !sw) throw new Error('garments: body mesh carries no skin weights');
    const bones = s.skeleton.bones;
    for (let i = 0; i < pos.count; i++, at++) {
      b.p[at * 3] = pos.getX(i); b.p[at * 3 + 1] = pos.getY(i); b.p[at * 3 + 2] = pos.getZ(i);
      if (nor) {
        b.nr[at * 3] = nor.getX(i); b.nr[at * 3 + 1] = nor.getY(i); b.nr[at * 3 + 2] = nor.getZ(i);
      }
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) {
        const w = sw['get' + K[k]](i);
        b.si[at * 4 + k] = si['get' + K[k]](i);
        b.sw[at * 4 + k] = w;
        if (w > bw) { bw = w; best = b.si[at * 4 + k]; }
      }
      const bone = bones[best];
      b.g[at] = bone ? groupOf(bone.name) : G_TORSO;
    }
  }

  /* Bind-pose bone positions straight off the skeleton's boneInverses, so this needs
     no updateMatrixWorld and cannot be thrown off by whatever pose the rig is in. */
  const m = new THREE.Matrix4(), v = new THREE.Vector3(), pos = {};
  mesh.skeleton.bones.forEach((bone, i) => {
    m.copy(mesh.skeleton.boneInverses[i]).invert();
    if (mesh.bindMatrixInverse) m.premultiply(mesh.bindMatrixInverse);
    pos[bone.name] = v.setFromMatrixPosition(m).toArray();
  });
  for (const k of NEED) if (!pos[k]) throw new Error('garments: rig has no bone ' + k);
  b.pelvisBone = mesh.skeleton.bones.findIndex(x => x.name === 'pelvis');
  b.frame = {
    pelvisY: pos.pelvis[1], neckY: pos.neck_01[1],
    hipY: pos.thigh_l[1], kneeY: pos.calf_l[1], ankleY: pos.foot_l[1],
    armY: pos.upperarm_l[1], armZ: pos.upperarm_l[2],
    shoulderX: pos.upperarm_l[0], elbowX: pos.lowerarm_l[0], wristX: pos.hand_l[0],
  };
  bodies.set(mesh.skeleton, b);
  return b;
}

/* One radius per sector, not a bounding ellipse. A hip or shoulder cross-section fills
   the corners of its own bounding box, so an ellipse inscribed in that box leaves the
   skin outside the garment on the diagonals — measured at up to 0.024 before this.
   The centre matters too: the pelvis sits 0.05 behind the spine, so a ring centred on
   z=0 would leave the backside outside the shirt.
   Raw sector maxima and the count behind each one: the caller decides which sectors it
   trusts and applies the circumscription, so one starved sector can be re-measured in a
   wider slab without the well-fed ones losing their own reading. `ctr` pins the centre
   to an earlier measurement's, which is what makes the two commensurable. */
function measure(body, mask, along, lo, hi, side, seg, ctr) {
  const [cu, cv] = CROSS[along];
  const keep = i => (body.g[i] & mask) &&
    body.p[i * 3 + along] >= lo && body.p[i * 3 + along] <= hi &&
    !(side && Math.sign(body.p[i * 3]) !== side);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, n = 0;
  for (let i = 0; i < body.n; i++) {
    if (!keep(i)) continue;
    const u = body.p[i * 3 + cu], v = body.p[i * 3 + cv];
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
    if (v < v0) v0 = v;
    if (v > v1) v1 = v;
    n++;
  }
  if (!n) return null;
  const mu = ctr ? ctr[0] : (u0 + u1) / 2, mv = ctr ? ctr[1] : (v0 + v1) / 2;
  const step = Math.PI * 2 / seg;
  const R = new Float64Array(seg).fill(-1), C = new Uint16Array(seg);
  for (let i = 0; i < body.n; i++) {
    if (!keep(i)) continue;
    const du = body.p[i * 3 + cu] - mu, dv = body.p[i * 3 + cv] - mv;
    let k = Math.round(Math.atan2(dv, du) / step) % seg;
    if (k < 0) k += seg;
    C[k]++;
    const r = Math.hypot(du, dv);
    if (r > R[k]) R[k] = r;
  }
  return { u: mu, v: mv, R, C, n };
}

/* Two samples is what a sector needs to be believed. The male mesh carries 852 vertices
   for a whole leg, so a sector can catch exactly one — and if that one is an inner
   surface it reports it as the outer radius, measured once as a 0.060 gash in the skirt
   hem. Below this a sector is re-measured in a wider slab; at or above it, it keeps what
   it saw. The old quota was the same 6-per-sector idea applied to the WHOLE ring, which
   on a sparse body meant every sector inherited the widest thing in a slab that also
   held a hip or a ribcage. */
const SECTOR_MIN = 2;

/* One ring per station, each measuring its own slab out to the half-way point toward
   its neighbours — so every body cross-section in the span is inside some ring and the
   clearance only has to cover the chord, not a bulge nobody looked at.
   Each radius is circumscribed by 1/cos(pi/seg), the exact amount the flat chord between
   two ring vertices cuts inside them, so `pad` is pure cloth thickness and not half a
   fudge factor. */
function ringsAlong(body, mask, along, stations, pad, seg, side, fat) {
  const rings = [];
  const spanLo = Math.min(...stations) - 0.01, spanHi = Math.max(...stations) + 0.01;
  const sec = 1 / Math.cos(Math.PI / seg);
  stations.forEach((at, i) => {
    const up = stations[i + 1] === undefined ? at : (at + stations[i + 1]) / 2;
    const dn = stations[i - 1] === undefined ? at : (at + stations[i - 1]) / 2;
    let lo = Math.min(at, dn, up) - 1e-4, hi = Math.max(at, dn, up) + 1e-4;
    let m = measure(body, mask, along, lo, hi, side, seg);
    // nothing at all in the station's slab: there is no centre to hang sectors off yet
    while (!m && (lo > spanLo || hi < spanHi)) {
      lo = Math.max(spanLo, lo - 0.02);
      hi = Math.min(spanHi, hi + 0.02);
      m = measure(body, mask, along, lo, hi, side, seg);
    }
    if (!m) m = measure(body, mask, along, spanLo - 0.06, spanHi + 0.06, side, seg);
    if (!m) return;
    /* Growth is per sector and stays inside the garment's own span: reaching below the
       ankle ring would size a trouser hem off the foot. */
    const starved = () => m.C.some(c => c < SECTOR_MIN);
    for (let g = 0; g < 40 && starved() && (lo > spanLo || hi < spanHi); g++) {
      lo = Math.max(spanLo, lo - 0.02);
      hi = Math.min(spanHi, hi + 0.02);
      const w = measure(body, mask, along, lo, hi, side, seg, [m.u, m.v]);
      if (!w) continue;
      for (let k = 0; k < seg; k++)
        if (m.C[k] < SECTOR_MIN) { m.R[k] = w.R[k]; m.C[k] = w.C[k]; }
    }
    const k = fat ? fat(i, stations.length) : 1;
    const R = new Float64Array(seg);
    for (let s = 0; s < seg; s++) {
      // a sector still empty at the widest slab borrows rather than collapsing
      let r = m.R[s];
      for (let d = 1; r < 0 && d <= seg; d++)
        r = Math.max(m.R[(s + d) % seg], m.R[(s - d + seg * 2) % seg]);
      R[s] = (Math.max(r, 0) * sec + pad) * k;
    }
    rings.push(ring(along, at, m.u, m.v, R));
  });
  return rings;
}

function ring(along, at, cu, cv, R) {
  const [iu, iv] = CROSS[along], seg = R.length, v = [], c = [0, 0, 0];
  c[along] = at; c[iu] = cu; c[iv] = cv;
  for (let k = 0; k < seg; k++) {
    const t = (k / seg) * Math.PI * 2, p = [0, 0, 0];
    p[along] = at; p[iu] = cu + Math.cos(t) * R[k]; p[iv] = cv + Math.sin(t) * R[k];
    v.push(p);
  }
  return { v, c, R, front: cv + Math.max(...R) };
}

/* --------------------------------------------------------------- lofting --- */

/* Winding is decided per triangle against an outward reference rather than reasoned
   out per frame: five garments built on three different ring axes is five chances to
   hand a back-facing shirt to the renderer. */
function tri(P, I, a, b, c, out) {
  const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
  const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
  const vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (nx * out[0] + ny * out[1] + nz * out[2] < 0) I.push(a, c, b);
  else I.push(a, b, c);
}

function loft(P, I, rings) {
  if (rings.length < 2) return;
  const seg = rings[0].v.length, base = P.length / 3;
  for (const r of rings) for (const p of r.v) P.push(p[0], p[1], p[2]);
  for (let i = 0; i < rings.length - 1; i++) {
    const r0 = rings[i], r1 = rings[i + 1];
    for (let k = 0; k < seg; k++) {
      const k2 = (k + 1) % seg;
      const a = base + i * seg + k, b = base + i * seg + k2;
      const c = base + (i + 1) * seg + k2, d = base + (i + 1) * seg + k;
      const out = [0, 1, 2].map(j =>
        r0.v[k][j] - r0.c[j] + r0.v[k2][j] - r0.c[j] +
        r1.v[k][j] - r1.c[j] + r1.v[k2][j] - r1.c[j]);
      tri(P, I, a, b, c, out);
      tri(P, I, a, c, d, out);
    }
  }
}

function quad(P, I, pts, out) {
  const base = P.length / 3;
  for (const p of pts) P.push(p[0], p[1], p[2]);
  tri(P, I, base, base + 1, base + 2, out);
  tri(P, I, base, base + 2, base + 3, out);
}

/* Weights copied verbatim from the nearest bind-pose body vertex, masked to the limb
   the part covers so a trouser hem cannot pick up a fingertip. Brute force on purpose:
   this runs once per rig, not once per person. */
function transfer(B, mask, from) {
  const body = B.body, end = B.P.length / 3;
  for (let i = from; i < end; i++) {
    const x = B.P[i * 3], y = B.P[i * 3 + 1], z = B.P[i * 3 + 2];
    let best = -1, bd = Infinity;
    for (let j = 0; j < body.n; j++) {
      if (!(body.g[j] & mask)) continue;
      const dx = body.p[j * 3] - x, dy = body.p[j * 3 + 1] - y, dz = body.p[j * 3 + 2] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) { bd = d; best = j; }
    }
    for (let k = 0; k < 4; k++) {
      B.si.push(best < 0 ? 0 : body.si[best * 4 + k]);
      B.sw.push(best < 0 ? (k ? 0 : 1) : body.sw[best * 4 + k]);
    }
  }
}

function part(B, mask, rings) {
  const from = B.P.length / 3;
  loft(B.P, B.I, rings);
  transfer(B, mask, from);
  return from;
}

/* ------------------------------------------------------------- garments --- */

/* The anchor ring sits INBOARD of the shoulder, inside the shell and inside the deltoid.
   Measured: moving it out to the shell's own side wall left the deltoid — which is
   skinned to upperarm and so invisible to the shell's torso measurement — bare, at
   0.043 proud of the shirt. A ring buried under another part of the same garment costs
   nothing; a bare shoulder is the thing you can see. */
function sleeves(B, f, o, endX) {
  for (const side of [1, -1]) {
    const stations = [side * f.shoulderX * 0.78, side * endX];
    if (Math.abs(endX) > Math.abs(f.elbowX)) stations.splice(1, 0, side * f.elbowX);
    // first ring inflated so the sleeve reads as a shoulder, last one as a cuff
    part(B, G_ARM | G_TORSO, ringsAlong(B.body, G_ARM, 0, stations, o.pad, 12, side,
      (i, n) => (i === 0 ? 1.35 : i === n - 1 ? 1.16 : 1)));
  }
}

/* Torso shell, hem to collar, in one lofted tube. The collar is the top two rings and
   nothing more: this mannequin's trapezius runs straight into the skull, so a collar
   placed by eye at a plausible neck radius buries its own back panel 0.055 inside the
   flesh. Measured instead, it comes out as the body's own taper from 0.20 at the
   shoulder to 0.14 at the neck — a sloped yoke with a raised rim, which is what a
   collar is at forty pixels. */
function shell(B, f, o, hemY) {
  const shoulderY = f.neckY - 0.05, span = shoulderY - hemY;
  const stations = [hemY, hemY + span * 0.40, hemY + span * 0.74, shoulderY, f.neckY];
  // one mask for the lot: leg verts only exist at the hem, head verts only at the collar
  const rings = ringsAlong(B.body, G_TORSO | G_LEG | G_HEAD, 1, stations, o.pad, o.seg, 0);
  const top = rings[rings.length - 1];
  /* The rim reuses the ring below it instead of measuring its own slab: the torso mesh
     ENDS at 1.53 and its topmost geometry is the shoulder tops, so a slab up there is
     both sparse and lopsided. Same radii, 6% out and 0.03 up, is a standing rim for free. */
  if (top) rings.push(ring(1, f.neckY + o.collarRise, top.c[0], top.c[2],
    top.R.map(r => r * 1.06)));
  part(B, G_TORSO, rings);
  return rings;
}

/* Two flat panels down the chest. At a few dozen pixels a lapel is a V of lighter
   shading, which is exactly what four triangles standing off the front can be. Widths are
   fractions of the shell's own widest ring and heights fractions of its own span, so a
   narrower rig gets a narrower lapel instead of one sized for this mannequin. */
function lapels(B, rings, off) {
  const frontZ = y => {
    let lo = rings[0], hi = rings[rings.length - 1];
    for (let i = 0; i < rings.length - 1; i++) {
      if (y >= rings[i].c[1] && y <= rings[i + 1].c[1]) { lo = rings[i]; hi = rings[i + 1]; }
    }
    const span = hi.c[1] - lo.c[1] || 1, t = Math.min(1, Math.max(0, (y - lo.c[1]) / span));
    return lo.front + (hi.front - lo.front) * t + off;
  };
  const w = Math.max(...rings.map(r => r.R[0]));
  const hemY = rings[0].c[1], neckY = rings[rings.length - 2].c[1], span = neckY - hemY;
  const yTop = neckY - span * 0.055, yBot = neckY - span * 0.36;
  const from = B.P.length / 3;
  for (const s of [1, -1]) {
    quad(B.P, B.I, [
      [s * w * 0.12, yTop, frontZ(yTop)],
      [s * w * 0.48, yTop - span * 0.062, frontZ(yTop - span * 0.062)],
      [s * w * 0.29, yBot, frontZ(yBot)],
      [s * w * 0.05, yBot + span * 0.028, frontZ(yBot + span * 0.028)],
    ], [0, 0, 1]);
  }
  transfer(B, G_TORSO, from);
}

function trousers(B, f, o) {
  const body = B.body, pad = o.pad;
  // one seat band over both legs first, or the crotch is a hole between two tubes
  part(B, G_TORSO | G_LEG,
    ringsAlong(body, G_TORSO | G_LEG, 1, [f.hipY - 0.10, f.pelvisY + 0.05], pad, o.seg, 0));
  for (const side of [1, -1]) {
    // four stations: the calf is the widest part of a leg and sits between knee and ankle
    const stations = [f.hipY - 0.05, f.kneeY, (f.kneeY + f.ankleY) / 2, f.ankleY + 0.03];
    part(B, G_LEG, ringsAlong(body, G_LEG, 1, stations, pad, 12, side,
      (i, n) => (i === n - 1 ? 1.12 : 1)));
  }
}

/* A skirt cannot take the body's weights as they come: the hips are thigh-dominated,
   so the left half would follow thigh_l and the right half thigh_r and the thing would
   scissor open the first time somebody walked. Every vertex is blended toward pelvis
   instead, fully by the hem, so it swings as one piece.
   ponytail: rigid below the waist — a seated skirt is a cone the thighs pass through.
   Fine at a few dozen pixels; needs cloth or a couple of skirt bones to do better. */
function skirt(B, f, o) {
  const body = B.body, waistY = f.pelvisY + 0.04, hemY = Math.min(o.skirtHem, waistY - 0.1);
  const seg = Math.max(o.seg, 14);
  const stations = [waistY, waistY - (waistY - hemY) / 3, waistY - (waistY - hemY) * 2 / 3, hemY];
  const flare = (i, n) => 1 + (o.skirtFlare - 1) * (i / (n - 1));
  const rings = ringsAlong(body, G_TORSO | G_LEG, 1, stations, o.pad, seg, 0, flare);
  const from = part(B, G_TORSO, rings);

  const pelvis = body.pelvisBone < 0 ? 0 : body.pelvisBone;
  const end = B.P.length / 3;
  for (let i = from; i < end; i++) {
    const y = B.P[i * 3 + 1];
    const t = Math.min(1, Math.max(0, (waistY - y) / Math.max(1e-4, waistY - hemY)));
    const k = 0.45 + 0.55 * t;                 // already mostly pelvis at the waist
    for (let j = 0; j < 4; j++) {
      const at = i * 4 + j;
      B.sw[at] *= 1 - k;
      if (B.si[at] === pelvis) B.sw[at] += k;
    }
    // the blend has nowhere to land if pelvis was not among the four slots
    let sum = 0;
    for (let j = 0; j < 4; j++) sum += B.sw[i * 4 + j];
    if (sum < 0.999) {
      let worst = 0;
      for (let j = 1; j < 4; j++) if (B.sw[i * 4 + j] < B.sw[i * 4 + worst]) worst = j;
      B.si[i * 4 + worst] = pelvis;
      B.sw[i * 4 + worst] += 1 - sum;
    }
  }
}

/* ----------------------------------------------------------------- face --- */

const heads = new WeakMap();   // Head bone -> the skull, measured in its own local space

/* The skull's own vertices in Head-bone local space, which is where the hair already
   lives. boneInverses maps bind world -> bone local, so this needs no posed matrices.
   Measured per rig and never tabulated: Head is bone 58 of 71 on the male rig and 6 of
   65 on the female, and their skulls differ in every axis. */
function sampleHead(headBone) {
  const hit = heads.get(headBone);
  if (hit) return hit;
  let top = headBone;
  while (top.parent) top = top.parent;
  let mesh = null;
  top.traverse(o => {
    if (mesh || !o.isSkinnedMesh || !o.skeleton) return;
    if (o.skeleton.bones.indexOf(headBone) < 0) return;
    if ([].concat(o.material).some(m => m && JOINT_MAT.test(m.name || ''))) return;
    mesh = o;
  });
  if (!mesh) throw new Error('garments: buildFace found no rig for that bone');
  const hi = mesh.skeleton.bones.indexOf(headBone);
  const m = new THREE.Matrix4().copy(mesh.skeleton.boneInverses[hi]);
  if (mesh.bindMatrix) m.multiply(mesh.bindMatrix);
  const g = mesh.geometry, p = g.attributes.position;
  const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  const K = ['X', 'Y', 'Z', 'W'], v = new THREE.Vector3(), pts = [];
  for (let i = 0; i < p.count; i++) {
    let best = 0, bw = -1;
    for (const k of K) {
      const w = sw['get' + k](i);
      if (w > bw) { bw = w; best = si['get' + k](i); }
    }
    if (best !== hi) continue;
    pts.push(v.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(m).toArray());
  }
  if (pts.length < 20) throw new Error('garments: too few Head-weighted vertices to place a face');
  const lo = [Infinity, Infinity, Infinity], up = [-Infinity, -Infinity, -Infinity];
  for (const q of pts) for (let k = 0; k < 3; k++) {
    if (q[k] < lo[k]) lo[k] = q[k];
    if (q[k] > up[k]) up[k] = q[k];
  }
  const out = { pts, lo, up, hw: Math.max(-lo[0], up[0]), h: up[1] - lo[1] };
  heads.set(headBone, out);
  return out;
}

/* Where the face surface is at (x, y): the front-most skull vertex nearby, floored by an
   ellipsoid fitted to the skull's measured bbox. The measurement alone is not enough — the
   male skull carries 178 vertices to the female's 623, and sampling it per corner twisted
   his eyes back 0.065 in z where hers moved 0.018. The ellipsoid smooths that out; the
   measurement keeps the result in front of the actual skin wherever the mesh bulges past
   it. Both terms come off the same rig, so neither is a constant. */
function skullFront(head, x, y) {
  const mid = (head.lo[1] + head.up[1]) / 2, ry = head.h / 2;
  const k = 1 - (x / head.hw) ** 2 - ((y - mid) / ry) ** 2;
  let best = head.up[2] * Math.sqrt(Math.max(0, k));
  for (let r = head.hw * 0.3; r <= head.hw * 2; r *= 1.7) {
    let hit = false;
    for (const q of head.pts) {
      if (q[2] <= 0 || Math.hypot(q[0] - x, q[1] - y) > r) continue;
      hit = true;
      if (q[2] > best) best = q[2];
    }
    if (hit) break;
  }
  return best;
}

/* brow: inner end raised, in brow half-widths — the whole expression, really. A furrowed
   inner end reads as concentration at six pixels where a mouth does not read at all. */
const FACE = {
  idle: { brow: 0.10, rise: 0.0, squint: 0.0, mouth: 0 },
  focus: { brow: -0.50, rise: -0.28, squint: 0.40, mouth: 0 },
  talk: { brow: 0.42, rise: 0.30, squint: 0.0, mouth: 1 },
};

/* headBone: the rig's Head bone. Returns a BufferGeometry in Head-LOCAL space — parent it
   to that bone and it rides every clip with no skinning, exactly as the hair does. Every
   feature is dark, so the whole face is one material and one draw call. Pick an
   expression by swapping geometry: the three are shared per rig, so it is a pointer. */
export function buildFace(headBone, opts = {}) {
  const o = Object.assign({}, OPT, opts);
  const name = EXPRESSIONS.includes(o.expression) ? o.expression : 'idle';
  const e = FACE[name], head = sampleHead(headBone);
  const hw = head.hw, h = head.h;
  const yEye = head.lo[1] + h * 0.50, xEye = hw * 0.46;
  const P = [], I = [];
  // every corner rides the skull it was measured on, so a quad wraps the brow ridge
  const put = (x, y, w, t, lift) => {
    const pts = [[x - w, y - t], [x + w, y - t], [x + w, y + t], [x - w, y + t]]
      .map(([px, py]) => py + lift(px))
      .map((py, k) => {
        const px = k === 0 || k === 3 ? x - w : x + w;
        return [px, py, skullFront(head, px, py) + o.faceLift];
      });
    quad(P, I, pts, [0, 0, 1]);
  };
  for (const s of [1, -1]) {
    const cx = s * xEye, ew = hw * 0.21, eh = h * 0.042 * (1 - e.squint);
    put(cx, yEye, ew, eh, () => 0);
    const bw = hw * 0.26, by = yEye + h * (0.085 + 0.02 * e.rise);
    // tilt is applied as a per-corner shear, so two triangles carry the whole expression
    put(cx, by, bw, h * 0.022, px => (s * (px - cx) / bw) * -e.brow * h * 0.05);
  }
  if (e.mouth) {
    const my = head.lo[1] + (yEye - head.lo[1]) * 0.38;
    put(0, my, hw * 0.26, h * 0.030, () => 0);
  }
  return finish({ P, I, si: null, sw: null });
}

/* ------------------------------------------------------------------ api --- */

function finish(B) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(B.P, 3));
  if (B.si) {          // a face is static, parented to the Head bone, and has no weights
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(B.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(B.sw, 4));
  }
  // white, so a vertexColors material (every one in materials.js) does not draw black
  g.setAttribute('color', new THREE.Float32BufferAttribute(
    new Float32Array((B.P.length / 3) * 3).fill(1), 3));
  g.setIndex(B.I);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/* bodyMesh: a SkinnedMesh from the rig, in bind pose. Returns a BufferGeometry in the
   same local space, carrying position/normal/color/skinIndex/skinWeight, ready to be
   constructed as a SkinnedMesh against that same skeleton. */
export function buildGarment(kind, bodyMesh, opts = {}) {
  if (!GARMENTS.includes(kind)) throw new Error('garments: unknown kind ' + kind);
  const o = Object.assign({}, OPT, opts);
  const body = sampleBody(bodyMesh), f = body.frame;
  const B = { body, P: [], I: [], si: [], sw: [] };
  o.pad = kind === 'jacket' ? o.jacketOffset : o.offset;

  if (kind === 'trousers') trousers(B, f, o);
  else if (kind === 'skirt') skirt(B, f, o);
  else {
    const hem = f.pelvisY - (kind === 'jacket' ? 0.15 : 0.07);
    const rings = shell(B, f, o, hem);
    sleeves(B, f, o, kind === 'top'
      ? f.shoulderX + (f.elbowX - f.shoulderX) * 0.55     // short sleeve, mid upper arm
      : f.wristX - 0.02);
    if (kind === 'jacket') lapels(B, rings, o.pad + 0.014);
  }
  return finish(B);
}

/* One call per person: the requested kinds merged into ONE geometry with a material
   group each, so a dressed person is one extra draw call rather than four. */
export function buildOutfit(kinds, bodyMesh, opts = {}) {
  const list = (kinds || []).filter(k => GARMENTS.includes(k));
  if (!list.length) throw new Error('garments: buildOutfit needs at least one known kind');
  const geometry = mergeGeometries(list.map(k => buildGarment(k, bodyMesh, opts)), true);
  if (!geometry) throw new Error('garments: merge failed');
  const groups = geometry.groups.map((gr, i) => ({
    kind: list[gr.materialIndex], start: gr.start, count: gr.count, materialIndex: i,
  }));
  return { geometry, groups };
}

/* ------------------------------------------------------------- selftest --- */
/* Needs the real rig, so it parses the .glb itself rather than faking a skeleton —
   a hand-built fixture would agree with whatever this file happens to do.
   node --experimental-default-type=module -e \
     "import('./view3d/garments.js').then(m => m.selfTest())"          */
export async function selfTest() {
  const [{ readFileSync }, { GLTFLoader }] = await Promise.all([
    import('node:fs'), import('../vendor/GLTFLoader.js'),
  ]);
  const ok = (c, m) => { if (!c) throw new Error('selfTest: ' + m); };
  const at = p => new URL('../' + p, import.meta.url);
  const man = JSON.parse(readFileSync(at('assets/manifest.json'), 'utf8'));
  const loader = new GLTFLoader();
  const load = f => new Promise((res, rej) => {
    const b = readFileSync(at(f));
    loader.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '', res, rej);
  });

  /* Closest point on a triangle (Ericson). Vertex-to-vertex distance is not enough here:
     the shoulder is sharply convex, so the body vertex nearest a shirt vertex is the one
     on top of the shoulder whose normal points at the sky, and a dot product against it
     calls a shirt that is plainly outside the arm "sunk into the body". */
  const closest = (p, a, b, c) => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const d1 = ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2];
    const d2 = ac[0] * ap[0] + ac[1] * ap[1] + ac[2] * ap[2];
    if (d1 <= 0 && d2 <= 0) return a;
    const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
    const d3 = ab[0] * bp[0] + ab[1] * bp[1] + ab[2] * bp[2];
    const d4 = ac[0] * bp[0] + ac[1] * bp[1] + ac[2] * bp[2];
    if (d3 >= 0 && d4 <= d3) return b;
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const t = d1 / (d1 - d3);
      return [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
    }
    const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    const d5 = ab[0] * cp[0] + ab[1] * cp[1] + ab[2] * cp[2];
    const d6 = ac[0] * cp[0] + ac[1] * cp[1] + ac[2] * cp[2];
    if (d6 >= 0 && d5 <= d6) return c;
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const t = d2 / (d2 - d6);
      return [a[0] + ac[0] * t, a[1] + ac[1] * t, a[2] + ac[2] * t];
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const t = (d4 - d3) / (d4 - d3 + d5 - d6);
      return [b[0] + (c[0] - b[0]) * t, b[1] + (c[1] - b[1]) * t, b[2] + (c[2] - b[2]) * t];
    }
    const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
    return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w,
      a[2] + ab[2] * v + ac[2] * w];
  };

  /* Two properties, because a garment has an inside and it has edges.
     leak — no body point under the garment is left in FRONT of it. That is the
       "body overflow with dress" the user saw, and it is measured against the cloth
       surface, taking the best of every overlapping part: a shoulder covered by the
       sleeve is covered even though it is outside the shell.
     sunk — the open rims (hem, cuff, collar) sit ON the skin, not in it. That is where
       cloth meets skin and the only place the seam shows. A sleeve's inboard anchor ring
       is also a rim but sits deep inside the shell, so only rims at the garment's own
       extremes are held to it. */
  const coverage = (g, body, reach = 0.06) => {
    /* A millimetre. The body is 1.83 units tall and drawn a few dozen pixels high, so one
       pixel is about 45 of these — anything under it is float32 noise on a ring radius,
       not something anybody can see. Two shoulder points land at exactly 0.0001. */
    const tol = 1e-3;
    const p = g.attributes.position, idx = g.index.array, tris = idx.length / 3;
    const GP = [];
    for (let i = 0; i < p.count; i++) GP.push([p.getX(i), p.getY(i), p.getZ(i)]);
    const lo = [Infinity, Infinity, Infinity], up = [-Infinity, -Infinity, -Infinity];
    for (const q of GP) for (let k = 0; k < 3; k++) {
      if (q[k] < lo[k]) lo[k] = q[k];
      if (q[k] > up[k]) up[k] = q[k];
    }
    const use = new Map();
    for (let t = 0; t < tris; t++) for (let e = 0; e < 3; e++) {
      const a = idx[t * 3 + e], b = idx[t * 3 + (e + 1) % 3];
      const k = a < b ? a + ':' + b : b + ':' + a;
      use.set(k, (use.get(k) || 0) + 1);
    }
    const rimV = new Set();
    for (const [k, n] of use) if (n === 1) k.split(':').forEach(s => rimV.add(+s));

    let leak = 0, tested = 0, worst = 0, at = '-';
    const stride = Math.max(1, Math.floor(body.n / 2500));
    for (let j = 0; j < body.n; j += stride) {
      const q = [body.p[j * 3], body.p[j * 3 + 1], body.p[j * 3 + 2]];
      let nv = -1, nd = Infinity;
      for (let i = 0; i < GP.length; i++) {
        const d = (GP[i][0] - q[0]) ** 2 + (GP[i][1] - q[1]) ** 2 + (GP[i][2] - q[2]) ** 2;
        if (d < nd) { nd = d; nv = i; }
      }
      if (nv < 0) continue;
      /* The sign is taken over EVERY triangle, not only those within reach. A deltoid can
         sit 0.03 outside the shell and 0.11 inside the sleeve that covers it; gating the
         sign on distance let the shell alone convict it, and which part won came down to
         whichever vertex happened to be nearest. Reach now only decides whether this body
         point is near this garment at all. */
      let best = Infinity, dmin = Infinity;
      for (let t = 0; t < tris; t++) {
        const a = GP[idx[t * 3]], b = GP[idx[t * 3 + 1]], c = GP[idx[t * 3 + 2]];
        const cp = closest(q, a, b, c);
        const d = Math.hypot(cp[0] - q[0], cp[1] - q[1], cp[2] - q[2]);
        if (d < dmin) dmin = d;
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const L = Math.hypot(n[0], n[1], n[2]) || 1;
        const sd = ((q[0] - cp[0]) * n[0] + (q[1] - cp[1]) * n[1] + (q[2] - cp[2]) * n[2]) / L;
        if (sd < best) best = sd;
      }
      if (dmin > reach) continue;                   // not a region this garment covers
      tested++;
      if (best > tol) {
        leak++;
        if (best > worst) { worst = best; at = q.map(x => x.toFixed(3)).join(','); }
      }
    }

    let sunk = 0, rim = 0, rimAt = '-';
    for (const i of rimV) {
      const q = GP[i];
      const edge = [0, 1, 2].some(k => q[k] < lo[k] + 0.03 || q[k] > up[k] - 0.03);
      if (!edge) continue;                            // a buried anchor ring, by design
      let out = -Infinity;
      for (let j = 0; j < body.n; j++) {
        const d = (body.p[j * 3] - q[0]) ** 2 + (body.p[j * 3 + 1] - q[1]) ** 2 +
          (body.p[j * 3 + 2] - q[2]) ** 2;
        if (d > 0.0036) continue;                     // only the skin within 0.06 judges
        out = Math.max(out, (q[0] - body.p[j * 3]) * body.nr[j * 3] +
          (q[1] - body.p[j * 3 + 1]) * body.nr[j * 3 + 1] +
          (q[2] - body.p[j * 3 + 2]) * body.nr[j * 3 + 2]);
      }
      if (out !== -Infinity && out < 0) {
        sunk++;
        if (out < rim) { rim = out; rimAt = q.map(x => x.toFixed(3)).join(','); }
      }
    }
    return { leak, tested, worst, at, sunk, rim, rimAt };
  };

  for (const spec of [man.rig, man.rigFemale]) {
    const gltf = await load(spec.file);
    const skins = [];
    gltf.scene.traverse(o => { if (o.isSkinnedMesh) skins.push(o); });
    ok(skins.length, spec.file + ': no skinned mesh');
    const body = sampleBody(skins[0]);

    for (const kind of GARMENTS) {
      const g = buildGarment(kind, skins[0]);
      const tris = g.index.count / 3, n = g.attributes.position.count;
      ok(tris > 20 && tris < 400, kind + ': ' + tris + ' triangles is not low-poly');

      const sw = g.attributes.skinWeight, si = g.attributes.skinIndex;
      const bones = skins[0].skeleton.bones.length;
      for (let i = 0; i < n; i++) {
        const s = sw.getX(i) + sw.getY(i) + sw.getZ(i) + sw.getW(i);
        ok(Math.abs(s - 1) < 1e-3, kind + ' vertex ' + i + ': weights sum to ' + s);
        ok(s > 0, kind + ' vertex ' + i + ' is unweighted');
        for (const k of ['X', 'Y', 'Z', 'W'])
          ok(si['get' + k](i) < bones, kind + ': skinIndex past the end of the skeleton');
      }

      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++)
        ok(Number.isFinite(p.getX(i)) && Number.isFinite(p.getY(i)) && Number.isFinite(p.getZ(i)),
          kind + ': non-finite position');
      ok(g.boundingSphere && Number.isFinite(g.boundingSphere.radius) &&
        g.boundingSphere.radius > 0.05 && g.boundingSphere.radius < 3, kind + ': bad bounds');

      const cov = coverage(g, body);
      ok(cov.leak === 0, kind + ': skin left outside the cloth at ' + cov.leak + ' of ' +
        cov.tested + ' body points, worst ' + cov.worst.toFixed(4) + ' at ' + cov.at);
      ok(cov.sunk === 0, kind + ': ' + cov.sunk + ' rim vertices sank into the body, worst ' +
        cov.rim.toFixed(4) + ' at ' + cov.rimAt);
    }

    // the skirt swings as one piece: no vertex may be pulled by one thigh alone
    const sk = buildGarment('skirt', skins[0]);
    const bones = skins[0].skeleton.bones;
    const swk = sk.attributes.skinWeight, sik = sk.attributes.skinIndex;
    const skp = sk.attributes.position;
    let hemY = Infinity;
    for (let i = 0; i < skp.count; i++) hemY = Math.min(hemY, skp.getY(i));
    for (let i = 0; i < swk.count; i++) {
      let thigh = 0, pelvis = 0;
      for (const k of ['X', 'Y', 'Z', 'W']) {
        const b = bones[sik['get' + k](i)], w = swk['get' + k](i);
        if (!b) continue;
        if (/^thigh_/.test(b.name)) thigh += w;
        if (b.name === 'pelvis') pelvis += w;
      }
      ok(pelvis >= 0.45, 'skirt vertex ' + i + ' only ' + pelvis.toFixed(2) + ' on pelvis');
      ok(thigh < 0.5, 'skirt vertex ' + i + ' is ' + thigh.toFixed(2) + ' on one thigh');
      /* The hem must be pelvis and nothing else. One bone means one rigid transform, which
         is why the hem ring measures 0.00% pair stretch over all 18 clips while a trouser
         hem — two ankles, two bones — stretches 1098% on the same walk. */
      if (skp.getY(i) < hemY + 0.01)
        ok(pelvis > 0.999, 'skirt hem vertex ' + i + ' is only ' + pelvis.toFixed(3) +
          ' pelvis, so the hem can scissor');
    }

    /* The face: placed off the measured skull, never a table. Ira left a bare crown on
       six hair styles by authoring against the wrong reference body; the assertion here
       is that every feature sits proud of the skull it was actually measured on. */
    const headBone = skins[0].skeleton.bones.find(b => b.name === 'Head');
    ok(headBone, spec.file + ': no Head bone');
    const head = sampleHead(headBone);
    ok(head.h > 0.15 && head.h < 0.45, 'skull height measured as ' + head.h.toFixed(3));
    const seenBrow = new Set();
    for (const name of EXPRESSIONS) {
      const fg = buildFace(headBone, { expression: name });
      const ft = fg.index.count / 3;
      ok(ft >= 8 && ft <= 16, name + ' face is ' + ft + ' triangles');
      ok(!fg.attributes.skinWeight, 'a face is static, it must carry no skin weights');
      const fp = fg.attributes.position;
      let minProud = Infinity, maxFloat = 0;
      for (let i = 0; i < fp.count; i++) {
        const q = [fp.getX(i), fp.getY(i), fp.getZ(i)];
        ok(q.every(Number.isFinite), name + ' face: non-finite position');
        ok(q[2] > 0, name + ' face: a feature ended up behind the head');
        ok(Math.abs(q[0]) <= head.hw && q[1] > head.lo[1] && q[1] < head.up[1],
          name + ' face: a feature left the skull bounds');
        /* sampled with a tighter disc than the placement used, so this is the skin
           directly under the feature rather than the number that positioned it */
        let local = -Infinity;
        for (const sp of head.pts)
          if (sp[2] > 0 && Math.hypot(sp[0] - q[0], sp[1] - q[1]) < head.hw * 0.18)
            local = Math.max(local, sp[2]);
        if (local > -Infinity) {
          minProud = Math.min(minProud, q[2] - local);
          maxFloat = Math.max(maxFloat, q[2] - local);
        }
      }
      ok(minProud > 0, name + ' face: a feature sank into the skull by ' +
        (-minProud).toFixed(4));
      ok(maxFloat < 0.05, name + ' face: a feature floats ' + maxFloat.toFixed(4) +
        ' off the skull');
      // the brow carries the expression, so the three must actually differ there
      seenBrow.add([...Array(fp.count).keys()].map(i => fp.getY(i).toFixed(4)).join());
    }
    ok(seenBrow.size === EXPRESSIONS.length, 'two expressions came out identical');

    const out = buildOutfit(['jacket', 'trousers'], skins[0]);
    ok(out.groups.length === 2, 'an outfit is one geometry with a group per kind');
    ok(out.groups[0].kind === 'jacket' && out.groups[1].kind === 'trousers', 'group order');
    ok(out.groups.reduce((s, g) => s + g.count, 0) === out.geometry.index.count,
      'the groups do not cover the whole index buffer');
    ok(out.geometry.attributes.skinWeight.count === out.geometry.attributes.position.count,
      'merged outfit lost its weights');
  }

  console.log('garments.js selfTest: ok');
  return true;
}
