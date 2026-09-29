#!/usr/bin/env node
/* test_fit.mjs — do the clothes FIT?   Run:  node test_fit.mjs

   Numbers, not opinions. Three metrics, each reported PER REGION so a failure names the
   collar or the seat rather than "top":

     penetration  worst signed distance of any body vertex left outside the cloth.
                  Target zero; a non-zero one anywhere exits non-zero.
     ease         MEDIAN signed skin->cloth-surface gap. Median deliberately: the min is
                  pinned at 0 by the crotch (the mannequin's thighs touch, so trousers
                  interpenetrate there whatever we do) and the max is meaningless.
     silhouette   garment cross-section width / body cross-section width, per band.
                  This is the circumscription tax read out directly.

   Inside/outside is the generalised winding number over ALL the garment's triangles, and
   the gap is the distance to the nearest TRIANGLE. Both matter:
     - a nearest-vertex normal test false-positives on the convex shoulder cap, where the
       nearest skin vertex's normal points at the sky;
     - gating the sign on distance lets the shell alone convict a deltoid the sleeve is
       covering, the winner decided by whichever vertex happened to be nearest;
     - min-signed-distance-over-all-triangles, which garments.js's own selfTest uses, is
       negative for a point just outside an open tube (the far wall always reads
       "inside"), so that test cannot fail. See the report.
   Region membership is fixed in BIND pose by vertex index, so there is no posed bounding
   box for a walk's 1.3 units of baked root motion to fool. Root drift is stripped anyway,
   the way characters.js strips it, so these are the numbers the app shows.

   FIT_GARMENTS=<path> measures an alternate garments.js, for baselining a snapshot. */

import { readFileSync } from 'node:fs';
import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { clone as skeletonClone } from './vendor/SkeletonUtils.js';

const Garments = await import(process.env.FIT_GARMENTS || './view3d/garments.js');

/* A millimetre, garments.js's own tolerance: the body is 1.83 units tall and drawn a few
   dozen pixels high, so a pixel is ~45 of these and anything under one is float noise. */
const TOL = 1e-3;
const BAND = 0.07;          // how deep under a hem or cuff edge that region reaches
const COVERS = 0.6;         // bind-pose inside-fraction that makes a region this garment's
const CAP = 48;             // body vertices sampled per region
/* Four samples per clip at these fractions of its duration: off frame 0 (which is near
   bind pose and proves nothing) and off the loop seam. On walk_loop that is four phases
   of a 1.333 s stride; on fixing_kneeling, 5.2 s, it is the kneel-down, two frames of the
   held kneel and the stand-up. Raising it to 8 moved no worst case by more than 0.2 mm. */
const AT = [0.13, 0.38, 0.62, 0.87];

const REGIONS = ['collar', 'shoulder', 'chest', 'waist', 'hip',
  'thigh', 'knee', 'sleeve', 'cuff', 'hem'];
/* Single kinds are the diagnostic; the two merged outfits are what the floor wears.
   `dress` is characters.js's dress — topLong + skirt in one tone, not a garments.js kind. */
const CELLS = [['top'], ['topLong'], ['trousers'], ['skirt'], ['jacket'],
  ['topLong', 'skirt'], ['topLong', 'trousers', 'jacket']];
const LABEL = k => (k.length === 1 ? k[0] : k.length === 2 ? 'dress' : 'boss');

const ARM = /^(clavicle|upperarm|lowerarm|hand_|index_|middle_|ring_|pinky_|thumb_)/;
const HAND = /^(hand_|index_|middle_|ring_|pinky_|thumb_)/;
const LEG = /^(thigh_|calf_|foot_|ball_)/;
const SKULL = /^(Head|eye|jaw)/;
const JOINT_MAT = /joint/i;

/* ------------------------------------------------------------------ rig --- */

const AT_URL = p => new URL('./' + p.replace(/^\.\//, ''), import.meta.url);
const MANIFEST = JSON.parse(readFileSync(AT_URL('assets/manifest.json'), 'utf8'));
const loader = new GLTFLoader();
const GLB = f => new Promise((res, rej) => {
  const b = readFileSync(AT_URL('assets/' + f.replace(/^assets\//, '')));
  loader.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '', res, rej);
});

const skinsOf = root => {
  const out = [];
  root.traverse(o => {
    if (!o.isSkinnedMesh) return;
    if ([].concat(o.material).some(m => m && JOINT_MAT.test(m.name || ''))) return;
    out.push(o);
  });
  return out;
};

/* Bind-pose bone positions off boneInverses, so no posed matrix can throw this off —
   the same route garments.js takes. */
function frameOf(mesh) {
  const m = new THREE.Matrix4(), v = new THREE.Vector3(), at = {};
  mesh.skeleton.bones.forEach((b, i) => {
    m.copy(mesh.skeleton.boneInverses[i]).invert();
    if (mesh.bindMatrixInverse) m.premultiply(mesh.bindMatrixInverse);
    at[b.name] = v.setFromMatrixPosition(m).toArray();
  });
  return {
    pelvisY: at.pelvis[1], neckY: at.neck_01[1], hipY: at.thigh_l[1],
    kneeY: at.calf_l[1], ankleY: at.foot_l[1],
    s1Y: at.spine_01[1], s2Y: at.spine_02[1], s3Y: at.spine_03[1],
    shoulderX: at.upperarm_l[0], elbowX: at.lowerarm_l[0], wristX: at.hand_l[0],
  };
}

/* Bind-pose body point cloud, plus which mesh and which bone each point came off. */
function cloudOf(skins) {
  let n = 0;
  for (const s of skins) n += s.geometry.attributes.position.count;
  const c = { n, p: new Float64Array(n * 3), bone: new Array(n), mesh: new Uint8Array(n),
    at: new Int32Array(n) };
  const K = ['X', 'Y', 'Z'];
  let k = 0;
  skins.forEach((s, si) => {
    const pos = s.geometry.attributes.position, ix = s.geometry.attributes.skinIndex;
    const w = s.geometry.attributes.skinWeight, bones = s.skeleton.bones;
    for (let i = 0; i < pos.count; i++, k++) {
      for (let a = 0; a < 3; a++) c.p[k * 3 + a] = pos['get' + K[a]](i);
      let best = 0, bw = -1;
      for (const q of ['X', 'Y', 'Z', 'W']) {
        const ww = w['get' + q](i);
        if (ww > bw) { bw = ww; best = ix['get' + q](i); }
      }
      c.bone[k] = (bones[best] && bones[best].name) || '';
      c.mesh[k] = si; c.at[k] = i;
    }
  });
  return c;
}

// characters.js's rule, verbatim in effect: real travel goes, a bob or a sway stays
function stripRootDrift(clip) {
  const t = clip.tracks.find(k => k.name === 'root.position');
  if (!t) return 0;
  const v = t.values, n = v.length / 3;
  let far = 0;
  for (let i = 0; i < n; i++) far = Math.max(far, Math.hypot(v[i * 3] - v[0], v[i * 3 + 2] - v[2]));
  if (far < 0.25) return 0;
  for (let i = 1; i < n; i++) { v[i * 3] = v[0]; v[i * 3 + 2] = v[2]; }
  return far;
}

/* -------------------------------------------------------------- geometry --- */

let CPX = 0, CPY = 0, CPZ = 0, OMEGA = 0;
/* Closest point on a triangle (Ericson) and the triangle's solid angle from q
   (Van Oosterom & Strackee), in one pass because both want the same three edges.
   Scalar args, no allocation: this runs ~10^8 times. */
function probe(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { CPX = ax; CPY = ay; CPZ = az; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { CPX = bx; CPY = by; CPZ = bz; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const t = d1 / (d1 - d3);
        CPX = ax + abx * t; CPY = ay + aby * t; CPZ = az + abz * t;
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { CPX = cx; CPY = cy; CPZ = cz; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const t = d2 / (d2 - d6);
            CPX = ax + acx * t; CPY = ay + acy * t; CPZ = az + acz * t;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const t = (d4 - d3) / (d4 - d3 + d5 - d6);
              CPX = bx + (cx - bx) * t; CPY = by + (cy - by) * t; CPZ = bz + (cz - bz) * t;
            } else {
              const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
              CPX = ax + abx * v + acx * w; CPY = ay + aby * v + acy * w;
              CPZ = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  const qax = ax - px, qay = ay - py, qaz = az - pz;
  const qbx = bx - px, qby = by - py, qbz = bz - pz;
  const qcx = cx - px, qcy = cy - py, qcz = cz - pz;
  const la = Math.hypot(qax, qay, qaz), lb = Math.hypot(qbx, qby, qbz);
  const lc = Math.hypot(qcx, qcy, qcz);
  const nx = qby * qcz - qbz * qcy, ny = qbz * qcx - qbx * qcz, nz = qbx * qcy - qby * qcx;
  const num = qax * nx + qay * ny + qaz * nz;
  const den = la * lb * lc +
    (qax * qbx + qay * qby + qaz * qbz) * lc +
    (qax * qcx + qay * qcy + qaz * qcz) * lb +
    (qbx * qcx + qby * qcy + qbz * qcz) * la;
  OMEGA = 2 * Math.atan2(num, den);
}

const FOURPI = Math.PI * 4;
/* Signed skin->cloth distance at q: + means the skin is OUTSIDE the cloth. The winding
   number decides the side over every triangle; the distance is to the nearest one. */
function signedAt(qx, qy, qz, GP, idx) {
  let d2 = Infinity, sum = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    probe(qx, qy, qz, GP[a], GP[a + 1], GP[a + 2], GP[b], GP[b + 1], GP[b + 2],
      GP[c], GP[c + 1], GP[c + 2]);
    sum += OMEGA;
    const dx = CPX - qx, dy = CPY - qy, dz = CPZ - qz, d = dx * dx + dy * dy + dz * dz;
    if (d < d2) d2 = d;
  }
  const inside = Math.abs(sum) / FOURPI > 0.5;
  return inside ? -Math.sqrt(d2) : Math.sqrt(d2);
}

/* --------------------------------------------------------------- regions --- */

/* Seven anatomical bands off measured bone landmarks, three garment-relative edges
   (collar is anatomical because the shell's top rings measure exactly that slab).
   They OVERLAP on purpose — hem is the band under whichever hem this garment has, so on
   trousers it is the ankle and on a skirt the mid-thigh, and it is the only place that
   reads as a seam. They are diagnostic views, not a partition. */
function regionsOf(f, gLo, gAbsX) {
  const yCollar = f.neckY - 0.05;
  const yChest = (f.s2Y + f.s3Y) / 2;
  const yWaist = (f.s1Y + f.s2Y) / 2;
  const yHip = f.hipY - 0.08;
  const yThigh = f.kneeY + 0.30 * (f.hipY - f.kneeY);
  const xShoulder = f.shoulderX + 0.25 * (f.elbowX - f.shoulderX);
  const hasSleeve = gAbsX > xShoulder + 0.03;
  const torso = b => !ARM.test(b) && !LEG.test(b) && !SKULL.test(b);
  const r = {
    collar: [1, (b, x, y) => torso(b) && y >= yCollar],
    shoulder: [0, (b, x) => ARM.test(b) && !HAND.test(b) && Math.abs(x) <= xShoulder],
    chest: [1, (b, x, y) => torso(b) && y >= yChest && y < yCollar],
    waist: [1, (b, x, y) => torso(b) && y >= yWaist && y < yChest],
    hip: [1, (b, x, y) => (torso(b) || LEG.test(b)) && y >= yHip && y < yWaist],
    thigh: [1, (b, x, y) => LEG.test(b) && y >= yThigh && y < yHip],
    knee: [1, (b, x, y) => LEG.test(b) && y >= f.ankleY && y < yThigh],
    sleeve: [0, (b, x) => ARM.test(b) && !HAND.test(b) && Math.abs(x) > xShoulder],
    cuff: [0, (b, x) => hasSleeve && ARM.test(b) && !HAND.test(b) &&
      Math.abs(x) >= gAbsX - BAND && Math.abs(x) <= gAbsX],
    hem: [1, (b, x, y) => !ARM.test(b) && !SKULL.test(b) &&
      y >= gLo[1] && y <= gLo[1] + BAND],
  };
  // the band each region spans, for the legend — nothing here is a literal
  r._spans = {
    collar: `y>=${yCollar.toFixed(3)}`, chest: `y ${yChest.toFixed(3)}-${yCollar.toFixed(3)}`,
    waist: `y ${yWaist.toFixed(3)}-${yChest.toFixed(3)}`,
    hip: `y ${yHip.toFixed(3)}-${yWaist.toFixed(3)}`,
    thigh: `y ${yThigh.toFixed(3)}-${yHip.toFixed(3)}`,
    knee: `y ${f.ankleY.toFixed(3)}-${yThigh.toFixed(3)} (knee, calf, ankle)`,
    shoulder: `|x|<=${xShoulder.toFixed(3)} (deltoid, clavicle)`,
    sleeve: `|x|>${xShoulder.toFixed(3)}`,
    cuff: hasSleeve ? `|x| ${(gAbsX - BAND).toFixed(3)}-${gAbsX.toFixed(3)}` : 'no sleeve',
    hem: `y ${gLo[1].toFixed(3)}-${(gLo[1] + BAND).toFixed(3)}`,
  };
  return r;
}

const median = a => {
  if (!a.length) return NaN;
  a.sort((x, y) => x - y);
  const h = a.length >> 1;
  return a.length & 1 ? a[h] : (a[h - 1] + a[h]) / 2;
};

/* ----------------------------------------------------------------- poses --- */

const POSE_KEYS = [];
const CLIP_SPECS = {};
for (const group of ['clips', 'gestures', 'extraClips']) {
  for (const [k, spec] of Object.entries(MANIFEST[group] || {})) {
    if (!spec || !spec.file) continue;
    CLIP_SPECS[k] = spec; POSE_KEYS.push(k);
  }
}

/* No CC0 clip in the pool raises the arms — the nearest are `point` (reach forward) and
   `handoff` (reach down). The pose that strains a sleeve/shell junction most is therefore
   synthesised, and the direction is MEASURED (whichever sign lifts hand_l) rather than
   guessed at from a bone's local axis. */
function armsUp(root) {
  const hand = root.getObjectByName('hand_l');
  const arms = ['upperarm_l', 'upperarm_r'].map(n => root.getObjectByName(n));
  if (!hand || arms.some(b => !b)) return false;
  const rest = arms.map(b => b.quaternion.clone());
  let best = null, bestY = -Infinity;
  for (const ang of [1.1, -1.1]) {
    arms.forEach((b, i) => { b.quaternion.copy(rest[i]); b.rotateZ(i ? -ang : ang); });
    root.updateMatrixWorld(true);
    const y = hand.getWorldPosition(new THREE.Vector3()).y;
    if (y > bestY) { bestY = y; best = ang; }
  }
  arms.forEach((b, i) => { b.quaternion.copy(rest[i]); b.rotateZ(i ? -best : best); });
  root.updateMatrixWorld(true);
  return true;
}

/* ------------------------------------------------------------------ main --- */

const RIG_KEYS = Object.keys(MANIFEST).filter(k => /^rig/.test(k) && MANIFEST[k].file);
const t0 = Date.now();
const PEN = {}, EASE = {}, SIL = {}, COV = {}, WORST = [];
const notes = [];
let cells = 0, poses = 0, probes = 0;

for (const rigKey of RIG_KEYS) {
  const template = (await GLB(MANIFEST[rigKey].file)).scene;
  const clips = {};
  for (const [k, spec] of Object.entries(CLIP_SPECS)) {
    const g = await GLB(spec.file);
    if (!g.animations[0]) continue;
    const far = stripRootDrift(g.animations[0]);
    if (far && rigKey === RIG_KEYS[0]) notes.push(`stripped ${far.toFixed(2)}u of root drift from ${k}`);
    clips[k] = g.animations[0];
  }
  const tSkins = skinsOf(template);
  if (tSkins.length !== 1) notes.push(`${rigKey}: ${tSkins.length} non-joint skins`);
  const f = frameOf(tSkins[0]);
  // the shipped hem: characters.js measures it off this rig's own knee, not OPT.skirtHem
  template.updateMatrixWorld(true);
  const skirtHem = template.getObjectByName('calf_l')
    .getWorldPosition(new THREE.Vector3()).y - 0.012;

  for (const kinds of CELLS) {
    const label = LABEL(kinds);
    const row = rigKey + '/' + label;
    const out = Garments.buildOutfit(kinds, tSkins[0], { skirtHem });

    // one dressed clone per cell, exactly as characters.js dresses a person
    const root = skeletonClone(template);
    const skins = skinsOf(root);
    const body = skins[0];
    const cloth = new THREE.SkinnedMesh(out.geometry,
      out.groups.map(() => new THREE.MeshBasicMaterial()));
    root.add(cloth);
    cloth.bind(new THREE.Skeleton(body.skeleton.bones, body.skeleton.boneInverses),
      body.bindMatrix);
    root.updateMatrixWorld(true);

    const cloud = cloudOf(skins);
    const gp = out.geometry.attributes.position;
    const idx = out.geometry.index.array;
    const gLo = [Infinity, Infinity, Infinity], gAbs = [0, 0, 0];
    for (let i = 0; i < gp.count; i++) for (let a = 0; a < 3; a++) {
      const v = gp.getComponent(i, a);
      if (v < gLo[a]) gLo[a] = v;
      if (Math.abs(v) > gAbs[a]) gAbs[a] = Math.abs(v);
    }
    const reg = regionsOf(f, gLo, gAbs[0]);
    if (!SIL._spans) SIL._spans = {};
    SIL._spans[row] = reg._spans;

    // membership fixed here, in BIND pose, by vertex index — nothing posed filters it
    const members = {};
    for (const name of REGIONS) {
      const [, pick] = reg[name], all = [];
      for (let i = 0; i < cloud.n; i++)
        if (pick(cloud.bone[i], cloud.p[i * 3], cloud.p[i * 3 + 1], cloud.p[i * 3 + 2]))
          all.push(i);
      const step = Math.max(1, Math.floor(all.length / CAP));
      members[name] = { all, use: all.filter((_, k) => k % step === 0).slice(0, CAP) };
    }

    const GP = new Float64Array(gp.count * 3);
    const v3 = new THREE.Vector3();
    const posed = (mesh, i) => {
      v3.fromBufferAttribute(mesh.geometry.attributes.position, i);
      mesh.applyBoneTransform(i, v3);
      return v3.applyMatrix4(mesh.matrixWorld);
    };
    const snapshot = () => {
      for (let i = 0; i < gp.count; i++) {
        posed(cloth, i);
        GP[i * 3] = v3.x; GP[i * 3 + 1] = v3.y; GP[i * 3 + 2] = v3.z;
      }
    };

    const pen = {}, ease = {}, cov = {};
    for (const name of REGIONS) { pen[name] = 0; ease[name] = []; }

    const measure = (poseName) => {
      snapshot();
      poses++;
      for (const name of REGIONS) {
        const use = members[name].use;
        probes += use.length * (idx.length / 3);
        let inside = 0;
        for (const i of use) {
          const q = posed(skins[cloud.mesh[i]], cloud.at[i]);
          const sd = signedAt(q.x, q.y, q.z, GP, idx);
          if (sd < 0) inside++;
          ease[name].push(-sd);
          if (sd > pen[name]) {
            pen[name] = sd;
            if (sd > TOL) WORST.push([row, name, sd, poseName]);
          }
        }
        if (poseName === 'bind') cov[name] = use.length ? inside / use.length : 0;
      }
    };

    /* Bind pose first: it is what garments.js measured against, and its inside-fraction
       is what decides which regions are this garment's business at all. A pose cannot
       erase that intent, so a later leak in a covered region always counts. */
    measure('bind');

    /* Silhouette, bind pose. A height band alone is not a region: the arms sit at chest
       height, so a band-only body span measures shoulder-to-fingertip and calls a shirt
       0.35x its own chest, and the torso sits inside a sleeve's |x| band and calls a
       sleeve 7.6x its arm. Each garment vertex is therefore assigned the region of the
       body vertex nearest it, and both spans are taken over region members only. */
    const gRegion = new Array(gp.count).fill(null);
    for (let i = 0; i < gp.count; i++) {
      let best = Infinity, at = -1;
      const gx = GP[i * 3], gy = GP[i * 3 + 1], gz = GP[i * 3 + 2];
      for (let j = 0; j < cloud.n; j++) {
        const dx = cloud.p[j * 3] - gx, dy = cloud.p[j * 3 + 1] - gy,
              dz = cloud.p[j * 3 + 2] - gz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) { best = d; at = j; }
      }
      gRegion[i] = at;
    }
    const bodyRegion = new Map();
    for (const name of REGIONS) for (const i of members[name].all) {
      if (!bodyRegion.has(i)) bodyRegion.set(i, []);
      bodyRegion.get(i).push(name);
    }

    const sil = {};
    for (const name of REGIONS) {
      const [axis] = reg[name], cross = axis === 1 ? [0, 2] : [1, 2];
      if (!members[name].all.length) { sil[name] = null; continue; }
      const inRegion = new Set(members[name].all);
      const span = (P, n, pick) => {
        const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
        let any = false;
        for (let i = 0; i < n; i++) {
          if (!pick(i)) continue;
          const x = P[i * 3], c = [x, P[i * 3 + 1], P[i * 3 + 2]];
          if (x < -1e-6) continue;
          any = true;
          for (let k = 0; k < 2; k++) {
            if (c[cross[k]] < lo[k]) lo[k] = c[cross[k]];
            if (c[cross[k]] > hi[k]) hi[k] = c[cross[k]];
          }
        }
        return any ? [hi[0] - lo[0], hi[1] - lo[1]] : null;
      };
      const B = span(cloud.p, cloud.n, i => inRegion.has(i));
      const G = span(GP, gp.count, i => inRegion.has(gRegion[i]));
      sil[name] = B && G && B[0] > 1e-4 && B[1] > 1e-4
        ? [G[0] / B[0], G[1] / B[1]] : null;
    }

    // every clip, sampled through its duration, plus the synthesised arms-raised pose
    const mixer = new THREE.AnimationMixer(root);
    for (const key of POSE_KEYS) {
      if (!clips[key]) continue;
      mixer.stopAllAction();
      mixer.clipAction(clips[key]).reset().play();
      for (const frac of AT) {
        mixer.setTime(clips[key].duration * frac);
        root.updateMatrixWorld(true);
        measure(key + '@' + frac);
      }
    }
    mixer.stopAllAction();
    body.skeleton.pose();                    // back to bind pose before posing by hand
    root.updateMatrixWorld(true);
    if (armsUp(root)) measure('armsRaised');

    PEN[row] = pen; COV[row] = cov; SIL[row] = sil;
    EASE[row] = {};
    for (const name of REGIONS) EASE[row][name] = median(ease[name]);
    cells++;
  }
}

/* ---------------------------------------------------------------- report --- */

const W = 8;
const head = () => '  ' + 'body / garment'.padEnd(22) + REGIONS.map(r => r.padStart(W)).join('');
const cell = (v) => String(v).padStart(W);
const rows = Object.keys(PEN);

console.log('\n=== PENETRATION — worst skin left OUTSIDE the cloth, mm, over every pose ===');
console.log('    .  = covered and clean      -  = not this garment\'s region (bind-pose ' +
  'inside-fraction < ' + COVERS + ')');
console.log(head());
let fails = 0;
for (const row of rows) {
  const line = REGIONS.map(r => {
    if ((COV[row][r] || 0) < COVERS) return cell('-');
    const mm = PEN[row][r] * 1000;
    if (mm <= TOL * 1000) return cell('.');
    fails++;
    return cell(mm.toFixed(1));
  });
  console.log('  ' + row.padEnd(22) + line.join(''));
}

console.log('\n=== EASE — MEDIAN skin->cloth gap, mm, pooled over every pose ===');
console.log('    + = cloth stands off the skin   - = cloth is inside the skin   ' +
  '- alone = no vertices in band');
console.log(head());
for (const row of rows) {
  console.log('  ' + row.padEnd(22) + REGIONS.map(r => {
    const v = EASE[row][r];
    return cell(Number.isFinite(v) ? (v * 1000).toFixed(1) : '-');
  }).join(''));
}

console.log('\n=== SILHOUETTE — garment cross-section / body cross-section, bind pose ===');
console.log('    width across the band, then depth. 1.00 = skin-tight. One side only.');
for (const axis of [0, 1]) {
  console.log('  ' + (axis ? 'depth' : 'width').padEnd(22) + REGIONS.map(r => r.padStart(W)).join(''));
  for (const row of rows) {
    console.log('  ' + row.padEnd(22) + REGIONS.map(r => {
      const s = SIL[row][r];
      return cell(s ? s[axis].toFixed(3) : '-');
    }).join(''));
  }
}

console.log('\n=== COVERAGE — bind-pose fraction of each region inside this garment ===');
console.log(head());
for (const row of rows) {
  console.log('  ' + row.padEnd(22) + REGIONS.map(r =>
    cell((COV[row][r] || 0).toFixed(2))).join(''));
}

console.log('\n=== REGION BANDS, measured off each rig\'s own bones ===');
for (const row of rows.filter(r => /\/topLong$/.test(r) || /\/trousers$/.test(r) || /\/skirt$/.test(r))) {
  console.log('  ' + row);
  for (const r of REGIONS) console.log('      ' + r.padEnd(10) + SIL._spans[row][r]);
}

if (WORST.length) {
  console.log('\n=== WORST PENETRATION, named ===');
  const seen = new Map();
  for (const [row, r, sd, pose] of WORST) {
    const k = row + '|' + r;
    if (!seen.has(k) || seen.get(k)[2] < sd) seen.set(k, [row, r, sd, pose]);
  }
  for (const [row, r, sd, pose] of [...seen.values()].sort((a, b) => b[2] - a[2]))
    if ((COV[row][r] || 0) >= COVERS)
      console.log(`  ${(sd * 1000).toFixed(1)} mm   ${row.padEnd(22)} ${r.padEnd(9)} ${pose}`);
}

for (const n of notes) console.log('  note: ' + n);
console.log(`\n${cells} cells, ${poses} poses, ${(probes / 1e6).toFixed(1)}M point-triangle ` +
  `probes, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(fails ? `FAIL  ${fails} region(s) leave skin outside the cloth`
  : 'PASS  no skin outside the cloth anywhere in the matrix');
process.exit(fails ? 1 : 0);
