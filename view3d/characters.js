/* view3d/characters.js — the people. One rig per person, one mixer per rig.

   Wiring, for whoever glues the 3D view together:

     import * as Scene from './scene.js';
     import { createCharacters } from './characters.js';
     const chars = createCharacters();
     Scene.init(canvas);
     Scene.getScene().add(chars.group);
     chars.load();                        // async; stand-ins render until it lands
     Scene.hooks.frame = chars.sync;      // once per frame, with the real dt
     // on teardown: chars.dispose() before Scene.dispose()


   sim.js hands over plain data (state, x, y, face, speed, phase, h, gesture) and
   everything in here is presentation. Three things make or break it:

   - SkeletonUtils.clone(), never mesh.clone(). A plain clone shares one skeleton
     and all 17 people animate in lockstep, which is the usual way this ships
     broken. Clips are shared data; the mixer is per person.
   - crossFadeTo on a state change. walk -> type -> walk with hard cuts reads as
     a bug; the smoothness is the whole point.
   - the walk clip is played at simSpeed / 0.975, because 0.975 u/s is the ground
     speed its baked root motion was authored at. Anything else skates.

   Every number about the rig comes from assets/manifest.json, which is measured,
   not guessed. The file is fetched at load() so a re-export cannot silently
   invalidate this module. If it is missing we fall back to resolving clip names
   out of whatever the rig .glb carries, and if there is no rig at all we draw
   capsule stand-ins — the layer always renders something.

   Call sync(people, dt, ctx) exactly once per frame with the REAL frame dt: the
   sim moves people in real seconds too (only its clock is scaled by replay
   rate). There is deliberately no second update() for the mixers — one entry
   point cannot be double-advanced. */

import * as THREE from '../vendor/three.module.js';
import { clone as skeletonClone } from '../vendor/SkeletonUtils.js';

/* p.state -> clip key, straight out of the contract. `leaving` walks out. */
export const CLIP_FOR = {
  walk: 'walk', type: 'type', think: 'idle', file: 'search', meet: 'talk', leaving: 'walk',
};
/* p.gesture -> clip key. sim.js maps the tool to these (Read -> point, ...). */
export const GESTURE_KEYS = ['point', 'typefast', 'headscratch', 'handoff', 'lookup'];

/* Three of the five gestures do not exist in CC0 and are synthesised from the
   rig's own measured bind/seated pose (see buildAdditive). `desk` is not a
   contract gesture: it is the typing pose the seated base clip lacks — its hands
   rest in the lap at y=0.644 while a desk surface is at ~0.73. `type` is the
   most common state in a coding timelapse, so this layer is always on while
   seated, and `typefast` is the same layer in a hurry. */
const SYNTH = ['desk', 'headscratch', 'lookup'];
/* additive layers blend on top of the base clip, so they are safe over a walk or
   a seated pose. Everything else is a full-body one-shot that replaces the base. */
const ADDITIVE = new Set([...SYNTH, 'nod']);

/* fallback only: used when assets/manifest.json cannot be read and the clips have
   to be recognised by name inside whatever .glb turns up. */
const ALIASES = {
  walk: ['walkformalloop', 'walkloop', 'walk', 'walking'],
  idle: ['idleloop', 'idle', 'standing'],
  talk: ['idletalkingloop', 'talk', 'talking'],
  type: ['sittingidleloop', 'sitting', 'sit', 'type', 'typing'],
  search: ['fixingkneeling', 'search', 'crouch', 'kneel', 'pickup'],
  point: ['interact', 'point', 'pointing'],
  handoff: ['pickuptable', 'handoff', 'give', 'wave'],
  nod: ['yes', 'nod'],
};

/* N=0 E=1 S=2 W=3 (floor.js). N is -z, E is +x, S is +z, W is -x. The yaw here
   assumes the model faces +z; which way it really faces is measured at load and
   folded into options.yawOffset. */
const FACE_YAW = [Math.PI, Math.PI / 2, 0, -Math.PI / 2];

/* last-resort tell when a gesture has no clip and no synthesised layer (a rig
   that failed to load, or the cheap LOD): [seconds, rad/s, radians] of pitch. */
const PULSE = {
  point: [0.55, 7.5, 0.17], typefast: [0.60, 22.0, 0.05], headscratch: [0.95, 4.5, 0.11],
  handoff: [0.55, 6.0, 0.21], lookup: [0.70, 3.2, 0.15],
};

const DEFAULTS = {
  manifest: 'manifest.json',     // resolved against assets/
  walkRef: 0.975,     // measured: walk_loop's baked root motion covers 0.975 u/s
  standIn: 1.8287,    // measured bind-pose height; the capsule matches it
  fade: 0.25,         // state crossfade, seconds
  gestureFade: 0.15,
  turnRate: 9,        // quaternion slerp rate; higher snaps harder
  maxFull: 40,        // hard cap on rigs+mixers, per the performance budget
  yawOffset: null,    // null = measure it from the rig's own hand bones
  pitchSign: 1,       // flip if a lookup pitches the head down instead of up
  bossScale: 1.06,    // the 2D view draws the boss 1.1x; a rig needs less
  nodOnPrompt: true,  // a boss taking an instruction nods; prompt events carry no tool
  variants: true,     // two walks and two idles, picked by p.h
};

/* the rig's own bone names, from the manifest. Only these are ever touched. */
const BONES = {
  root: 'root', head: 'Head', neck: 'neck_01', spine: 'spine_02',
  armL: 'upperarm_l', armR: 'upperarm_r', foreL: 'lowerarm_l', foreR: 'lowerarm_r',
  handL: 'hand_l', handR: 'hand_r',
};

/* ------------------------------------------------------------------ pure --- */

const norm = s => String(s || '').toLowerCase().replace(/^.*\|/, '').replace(/[^a-z0-9]/g, '');
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* first clip matching any alias of `want`, or null. Fallback path only. */
export function pickClip(clips, want) {
  const names = clips.map(c => norm(c.name));
  for (const alias of ALIASES[want] || [want]) {
    let i = names.indexOf(alias);
    if (i < 0) i = names.findIndex(n => n.startsWith(alias));
    if (i < 0) i = names.findIndex(n => n.includes(alias));
    if (i >= 0) return clips[i];
  }
  return null;
}

/* walk playback so the feet match the floor: measured ground speed / reference.
   The sim walks people at 2.0-2.39 tiles/s against a 0.975 u/s clip, so this
   sits near 2.3x and the walk looks brisk. That is honest — the alternatives are
   a slower p.speed in sim.js or switching to jog_fwd_loop (5.36 u/s), not a
   fudged rate, which would put the slide back. */
export const walkScale = (ground, ref) => clamp(ground / (ref || 1), 0.35, 2.6);

/* Who gets a full rig: the focused room, plus anyone in the amenity band, capped.
   The band is under the camera at all times, so degrading someone in the
   cafeteria is the worst possible trade — band first when the cap bites. Sorted
   by key so the winning set cannot churn frame to frame. */
export function chooseFull(people, focus, cap) {
  const band = [], room = [];
  for (const p of people) {
    if (p.fac || p.cowork) band.push(p);
    else if (!focus || p.room === focus) room.push(p);
  }
  const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  band.sort(byKey); room.sort(byKey);
  return new Set(band.concat(room).slice(0, cap).map(p => p.key));
}

const TMP_Q = new THREE.Quaternion();
const TMP_E = new THREE.Euler();

/* Turn toward a yaw by slerp, frame-rate independent — never a snap to the four
   90-degree facings, which is what the 2D view does and what looks robotic in
   3D. Writes a clean yaw-only quaternion the caller copies out, so a gesture's
   pitch lean cannot accumulate into the turn. */
function turnTo(q, yaw, rate, dt, snap) {
  TMP_E.set(0, yaw, 0);
  TMP_Q.setFromEuler(TMP_E);
  if (snap) q.copy(TMP_Q);
  else q.slerp(TMP_Q, 1 - Math.exp(-rate * dt));
}

/* ----------------------------------------------------------------- build --- */

export function createCharacters(opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  const group = new THREE.Group();
  group.name = 'characters';

  const avatars = new Map();
  const tints = new Map();
  const scratch = new THREE.Object3D();
  const color = new THREE.Color();

  let template = null, clips = {}, gen = 0, yaw0 = 0;
  const info = {
    mode: 'primitive', rig: null, clips: {}, synth: [], missing: [],
    full: 0, cheap: 0, notes: [],
  };
  const warn = m => { info.notes.push(m); console.warn('[characters] ' + m); };

  /* --- cheap LOD: three InstancedMeshes, no mixer, no per-person draw call ---
     Proportioned from the manifest's measured heights: 1.8287 tall, ankle 0.103,
     head 1.526. There is no low-poly CC0 stand-in, so this is a capsule. */
  const geoBody = new THREE.CapsuleGeometry(0.19, 0.97, 3, 10);
  const geoHead = new THREE.SphereGeometry(0.15, 10, 7);
  const geoBlob = new THREE.CircleGeometry(0.3, 14).rotateX(-Math.PI / 2);
  const matCheap = new THREE.MeshLambertMaterial();
  // blob shadow, not a shadow map: 135 characters cannot afford real ones
  const matBlob = new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false,
  });
  let cap = 0, bodies = null, heads = null, blobs = null;

  function ensureCap(n) {
    if (n <= cap) return;
    cap = Math.max(64, 1 << Math.ceil(Math.log2(n)));
    for (const m of [bodies, heads, blobs]) if (m) { group.remove(m); m.dispose(); }
    bodies = new THREE.InstancedMesh(geoBody, matCheap, cap);
    heads = new THREE.InstancedMesh(geoHead, matCheap, cap);
    blobs = new THREE.InstancedMesh(geoBlob, matBlob, cap);
    for (const m of [bodies, heads, blobs]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;         // one mesh spans the whole floor
      m.count = 0;
      group.add(m);
    }
  }
  ensureCap(64);

  /* ------------------------------------------------------------- loading --- */

  /* `pre` is an already-parsed { scene, animations }: Rohan may be loading the
     .glb himself, and it is also the only way to exercise the rig path headless. */
  async function load(pre) {
    if (pre && pre.scene) {
      info.rig = 'preloaded';
      if (pre.clips) { template = pre.scene; clips = { ...pre.clips }; prepare(); }
      else adoptPool(pre.scene, pre.animations || [], 'preloaded');
      return info;
    }
    let GLTFLoader;
    try {
      // dynamic: a broken loader must degrade to stand-ins, not kill the whole
      // 3D view with a top-level import error
      ({ GLTFLoader } = await import('../vendor/GLTFLoader.js'));
    } catch (e) {
      warn('GLTFLoader unavailable (' + (e && e.message) + ') — capsule stand-ins only');
      return info;
    }
    const loader = new GLTFLoader();
    const base = new URL('../assets/', import.meta.url);

    let man = null;
    try { man = await (await fetch(new URL(o.manifest, base))).json(); }
    catch (e) { warn('assets/manifest.json unreadable (' + (e && e.message) + ')'); }

    const rigFile = (man && man.rig && man.rig.file) || 'assets/rig-human.glb';
    let rig;
    try { rig = await loader.loadAsync(new URL(rigFile.replace(/^assets\//, ''), base).href); }
    catch (e) {
      warn('rig ' + rigFile + ' failed (' + (e && e.message) + ') — capsule stand-ins only');
      return info;
    }
    info.rig = rigFile;

    if (!man || !man.clips) {
      // no manifest: the rig might be a single .glb carrying its own clips
      adoptPool(rig.scene, rig.animations || [], rigFile);
      return info;
    }

    /* one file per clip, mesh-free, exactly one AnimationClip each */
    const wanted = { ...man.clips, ...man.gestures };
    if (o.variants && man.extraClips) {
      wanted.walk2 = man.extraClips.walk_formal;
      wanted.idle2 = man.extraClips.idle_foldarms;
    }
    if (o.nodOnPrompt && man.extraClips) wanted.nod = man.extraClips.nod;

    const got = await Promise.all(Object.entries(wanted).map(async ([key, spec]) => {
      if (!spec || !spec.file) return [key, null];
      try {
        const g = await loader.loadAsync(new URL(spec.file.replace(/^assets\//, ''), base).href);
        return [key, (g.animations || [])[0] || null];
      } catch (e) { warn('clip ' + key + ' (' + spec.file + ') failed: ' + (e && e.message)); return [key, null]; }
    }));

    template = rig.scene;
    clips = {};
    for (const [key, clip] of got) if (clip) clips[key] = clip;
    // the manifest calls walk_formal the better office walk, so it leads
    if (clips.walk2) { const w = clips.walk; clips.walk = clips.walk2; clips.walk2 = w; }
    prepare();
    return info;
  }

  /* fallback: resolve clip keys out of one pool of animations by name */
  function adoptPool(scene, pool, where) {
    template = scene;
    clips = {};
    for (const key of [...new Set(Object.values(CLIP_FOR)), 'point', 'handoff', 'nod']) {
      const c = pickClip(pool, key);
      if (c) clips[key] = c;
    }
    info.rig = where;
    prepare();
  }

  function prepare() {
    if (!clips.idle) clips.idle = clips.walk || clips.type || clips.talk || null;
    if (!clips.idle) {
      warn('rig ' + info.rig + ' carries no usable clip — capsule stand-ins only');
      template = null;
      return;
    }
    template.traverse(c => {
      if (!c.isMesh) return;
      c.castShadow = c.receiveShadow = false;    // blob shadows only
      c.frustumCulled = false;                   // a skinned bbox is the bind pose and pops
    });

    let pruned = 0;
    for (const key in clips) { stripRootDrift(clips[key]); pruned += pruneStatic(clips[key]); }
    if (pruned) info.notes.push('pruned ' + pruned + ' dead tracks across ' +
      Object.keys(clips).length + ' clips');

    /* fixing_kneeling is stand -> kneel -> hold -> stand and is NOT a loop
       despite its flag: measured, it stands until 0.4, kneels to 0.8, holds to
       4.0 and stands back up. 0.9-4.0s is the only part that loops. The length
       guard keeps this from mangling a short clip if the asset is ever swapped. */
    if (clips.search && clips.search.duration > 3) {
      clips.search = THREE.AnimationUtils.subclip(clips.search, 'search_hold', 27, 120, 30);
    }
    if (clips.nod) clips.nod = headOnlyAdditive(clips.nod, 'nod', 36, 30);

    yaw0 = o.yawOffset === null ? measureFacing() : o.yawOffset;
    buildAdditive();

    // a bone the rig does not have makes a synthesised clip null: drop those keys
    // rather than carry a hole every later lookup has to test for
    for (const k in clips) if (!clips[k]) delete clips[k];
    info.clips = Object.fromEntries(Object.entries(clips).map(([k, c]) => [k, c.name]));
    info.synth = SYNTH.filter(k => clips[k]);
    info.missing = [...Object.values(CLIP_FOR), ...GESTURE_KEYS]
      .filter((k, i, a) => a.indexOf(k) === i && !clips[k]);
    info.mode = 'rig';
    if (info.missing.length) warn('no clip or layer for: ' + info.missing.join(', '));
    gen++;        // stand-ins already on the floor upgrade on the next sync
  }

  /* Root motion is baked into the locomotion clips: walk_loop translates `root`
     1.3 units. The sim owns position, so the horizontal component has to go or
     people walk away from where they were put. Detected by travel, not by clip
     name, because a seated clip also writes root.position (it drops the body
     onto the chair) and that one must be kept. */
  function stripRootDrift(clip) {
    const t = clip.tracks.find(k => k.name === BONES.root + '.position');
    if (!t) return;
    const v = t.values, n = v.length / 3;
    let maxXZ = 0;
    for (let i = 0; i < n; i++) {
      maxXZ = Math.max(maxXZ, Math.hypot(v[i * 3] - v[0], v[i * 3 + 2] - v[2]));
    }
    if (maxXZ < 0.25) return;            // a bob or a sway, not travel
    for (let i = 1; i < n; i++) { v[i * 3] = v[0]; v[i * 3 + 2] = v[2]; }
    info.notes.push('stripped ' + maxXZ.toFixed(2) + 'u of root drift from ' + clip.name);
  }

  /* Two thirds of every one of these clips' 195 tracks do nothing: all 65 scale
     tracks are exactly 1 and every bone but root and pelvis keeps its bind
     translation for the whole clip. Dropping a track only when it is constant
     AND already equal to the rig's rest value is provably pose-preserving, and
     on 40 mixers it is the cheapest threefold saving available. Measured per
     clip, so a future asset with real squash or bone stretching keeps it. */
  function pruneStatic(clip) {
    if (clip.blendMode === THREE.AdditiveAnimationBlendMode) return 0;   // rest is identity there
    const before = clip.tracks.length;
    clip.tracks = clip.tracks.filter(t => {
      const dot = t.name.lastIndexOf('.');
      const b = template.getObjectByName(t.name.slice(0, dot));
      if (!b) return true;                       // unknown target: leave it alone
      const rest = { position: b.position, scale: b.scale, quaternion: b.quaternion }[
        t.name.slice(dot + 1)];
      if (!rest) return true;
      const r = rest.toArray(), st = r.length, v = t.values;
      for (let i = 0; i < v.length; i++) if (Math.abs(v[i] - r[i % st]) > 1e-4) return true;
      return false;
    });
    return before - clip.tracks.length;
  }

  /* `yes` is a 2.5s full-body loop. Trimmed to one nod, reduced to the head and
     spine, and made additive so a seated boss nods without leaving his chair. */
  function headOnlyAdditive(clip, name, endFrame, fps) {
    const keep = new Set([BONES.head, BONES.neck, BONES.spine, 'spine_03']);
    const c = THREE.AnimationUtils.subclip(clip, name, 0, endFrame, fps);
    c.tracks = c.tracks.filter(t => t.name.endsWith('.quaternion') &&
      keep.has(t.name.slice(0, -'.quaternion'.length)));
    if (!c.tracks.length) return null;
    THREE.AnimationUtils.makeClipAdditive(c);
    c.blendMode = THREE.AdditiveAnimationBlendMode;
    return c;
  }

  /* ------------------------------------------------- measured pose helpers --- */

  const bone = n => (template && template.getObjectByName(n)) || null;

  /* run fn with the template posed by `clip` at time t, then put the bind pose
     back. Every synthesised gesture is measured off a real pose this way rather
     than guessing which way a UE-style bone's local axes point. */
  function withPose(clip, t, fn) {
    const skins = [];
    template.traverse(x => { if (x.isSkinnedMesh) skins.push(x); });
    let mx = null;
    if (clip) { mx = new THREE.AnimationMixer(template); mx.clipAction(clip).play(); mx.update(t); }
    template.updateMatrixWorld(true);
    try { return fn(); } finally {
      if (mx) { mx.stopAllAction(); mx.uncacheRoot(template); }
      for (const s of skins) s.skeleton.pose();
      template.updateMatrixWorld(true);
    }
  }

  /* Which way does the rig face? Measured from its own hand bones rather than
     assumed: right = handR - handL, and forward = up x right. Folded into the
     yaw so a rig authored facing -z needs no config. */
  function measureFacing() {
    const l = bone(BONES.handL), r = bone(BONES.handR);
    if (!l || !r) { warn('no hand bones — assuming the rig faces +z'); return 0; }
    return withPose(null, 0, () => {
      const a = l.getWorldPosition(new THREE.Vector3()), b = r.getWorldPosition(new THREE.Vector3());
      const right = b.sub(a).setY(0).normalize();
      const fwd = new THREE.Vector3(0, 1, 0).cross(right);
      info.notes.push('rig faces (' + fwd.x.toFixed(2) + ', ' + fwd.z.toFixed(2) + ')');
      return -Math.atan2(fwd.x, fwd.z);
    });
  }

  const V = () => new THREE.Vector3();

  /* three applies an additive quaternion as base * delta, so a delta lives in
     the bone's own frame: delta = W^-1 * worldRotation * W. */
  function toLocal(b, world) {
    const W = b.getWorldQuaternion(new THREE.Quaternion());
    return W.clone().invert().multiply(world).multiply(W);
  }
  /* rotate a bone about a world axis by `angle`, expressed as a local delta */
  function spin(b, axis, angle) {
    return toLocal(b, new THREE.Quaternion().setFromAxisAngle(axis, angle));
  }
  /* swing a bone so its own direction (toward `child`) points at `target` */
  function aim(b, child, target, amount) {
    const bp = b.getWorldPosition(V()), cp = child.getWorldPosition(V());
    const from = cp.sub(bp).normalize(), to = target.clone().sub(bp).normalize();
    const full = new THREE.Quaternion().setFromUnitVectors(from, to);
    return toLocal(b, new THREE.Quaternion().slerp(full, amount));
  }

  const qTrack = (name, times, quats) => {
    const v = new Float32Array(quats.length * 4);
    quats.forEach((q, i) => q.toArray(v, i * 4));
    return new THREE.QuaternionKeyframeTrack(name, new Float32Array(times), v);
  };
  const I = () => new THREE.Quaternion();
  const part = (q, amount) => new THREE.Quaternion().slerp(q, amount);

  function additiveClip(name, duration, tracks) {
    const t = tracks.filter(Boolean);
    if (!t.length) return null;
    const c = new THREE.AnimationClip(name, duration, t);
    c.blendMode = THREE.AdditiveAnimationBlendMode;
    return c;
  }

  /* The three gestures CC0 does not have, plus the typing pose the seated clip
     lacks. All rotation-only and all additive, so they layer over any base and
     never fight the root position the sim owns. */
  function buildAdditive() {
    const head = bone(BONES.head), neck = bone(BONES.neck);
    const foreL = bone(BONES.foreL), foreR = bone(BONES.foreR);
    const handL = bone(BONES.handL), handR = bone(BONES.handR);
    const armR = bone(BONES.armR);

    /* desk: measured in the SEATED pose, because that is the pose it corrects.
       The clip rests the hands in the lap at y=0.644 and a desk is at ~0.73, so
       each forearm is swung until the hand reaches the surface, then pumped. */
    if (clips.type && foreL && foreR && handL && handR) {
      const right = withPose(clips.type, 0, () =>
        handR.getWorldPosition(V()).sub(handL.getWorldPosition(V())).setY(0).normalize());
      const fwd = new THREE.Vector3(0, 1, 0).cross(right);
      const dl = withPose(clips.type, 0, () =>
        aim(foreL, handL, handL.getWorldPosition(V()).add(fwd.clone().multiplyScalar(0.10)).setY(0.75), 1));
      const dr = withPose(clips.type, 0, () =>
        aim(foreR, handR, handR.getWorldPosition(V()).add(fwd.clone().multiplyScalar(0.10)).setY(0.75), 1));
      const nod = head ? withPose(clips.type, 0, () => spin(head, right, 0.035 * o.pitchSign)) : null;
      const T = [0, 0.18, 0.36, 0.54, 0.72];
      clips.desk = additiveClip('desk', 0.72, [
        qTrack(BONES.foreL + '.quaternion', T, [dl, part(dl, 0.86), dl, part(dl, 0.86), dl]),
        qTrack(BONES.foreR + '.quaternion', T, [part(dr, 0.86), dr, part(dr, 0.86), dr, part(dr, 0.86)]),
        nod && qTrack(BONES.head + '.quaternion', T, [I(), nod, I(), part(nod, -0.6), I()]),
      ]);
    }

    /* headscratch: the right arm swung toward the head bone, measured from the
       bind pose, held, released. Aim beats a guessed axis on a UE-style rig. */
    if (armR && foreR && head) {
      const target = withPose(null, 0, () => head.getWorldPosition(V()));
      const up = withPose(null, 0, () => aim(armR, foreR, target, 0.72));
      const bend = withPose(null, 0, () => aim(foreR, handR || head, target, 0.85));
      const T = [0, 0.3, 0.95, 1.35];
      clips.headscratch = additiveClip('headscratch', 1.35, [
        qTrack(BONES.armR + '.quaternion', T, [I(), up, up, I()]),
        qTrack(BONES.foreR + '.quaternion', T, [I(), bend, bend, I()]),
      ]);
    }

    /* lookup: head and neck pitched up, with a small sweep so it reads as
       looking something up rather than a single tick. */
    if (head) {
      const right = withPose(null, 0, () => {
        const l = handL && handL.getWorldPosition(V()), r = handR && handR.getWorldPosition(V());
        return l && r ? r.sub(l).setY(0).normalize() : new THREE.Vector3(-1, 0, 0);
      });
      const up = new THREE.Vector3(0, 1, 0);
      const hp = withPose(null, 0, () => spin(head, right, 0.22 * o.pitchSign));
      const sweep = withPose(null, 0, () => spin(head, up, 0.18));
      const hn = hp.clone().multiply(sweep);
      const np = neck ? withPose(null, 0, () => spin(neck, right, 0.10 * o.pitchSign)) : null;
      const T = [0, 0.28, 0.7, 1.15];
      clips.lookup = additiveClip('lookup', 1.15, [
        qTrack(BONES.head + '.quaternion', T, [I(), hp, hn, I()]),
        np && qTrack(BONES.neck + '.quaternion', T, [I(), np, np, I()]),
      ]);
    }

    /* typefast is the desk layer in a hurry — see fireGesture */
    if (clips.desk) clips.typefast = clips.desk;
  }

  /* ------------------------------------------------------------ material --- */

  /* How far a person is knocked back when a focus or a search excludes them. The 2D
     view drops them to alpha .25 over a near-black void, which on a lit surface comes
     out as roughly a plain multiply by this. */
  const BACK = 0.24;

  /* Tint by p.hue the way the 2D view does, desaturating when idle. Multiplying
     the source colour keeps the model's own light/dark split so a character does
     not go flat monochrome. Cached per (material, hue bucket, idle, knocked back):
     a few dozen materials for 135 people. */
  function tinted(src, hue, idle, back) {
    const bucket = (Math.round(hue / 12) | 0) + (idle ? 1000 : 0) + (back ? 2000 : 0);
    const k = src.uuid + '|' + bucket;
    let m = tints.get(k);
    if (!m) {
      m = src.clone();
      // sRGB explicitly: setHSL defaults to the WORKING colour space, which is
      // linear, so 0.56 would land at sRGB 79% and a person renders as a white-hot
      // chip instead of a body. office.js's torso is shade(hue, 60, 50) — sRGB.
      color.setHSL(hue / 360, idle ? 0.16 : 0.58, idle ? 0.42 : 0.56, THREE.SRGBColorSpace);
      m.color = (src.color ? src.color.clone() : new THREE.Color(0xffffff)).lerp(color, 0.6);
      if (back) m.color.multiplyScalar(BACK);
      tints.set(k, m);
    }
    return m;
  }

  /* Whether a focus or a search excludes this person, which is the 2D view's own rule for
     a body: a different room is focused, or a query is running that their own text does
     not answer. Without it the search box and `/` did nothing at all in 3D — every frame
     came out identical however the query changed — and people in unfocused rooms stayed at
     full brightness while their room shell correctly dimmed around them.

     roomHit is deliberately NOT consulted: it is true when ANY person in the room matches,
     so a room can hit while this person does not, and the 2D view knocks that person back
     too. Testing the person alone is both finer and O(1) instead of O(people) per room. */
  function backOf(p, focus, q, personText) {
    if (focus && p.room !== focus) return true;
    return !!q && !!personText && !personText(p).includes(q);
  }

  /* ------------------------------------------------------------- avatars --- */

  const hashOf = p => (p.h != null ? p.h : 0);

  function makeAvatar(p) {
    return {
      p, key: p.key, lod: 'none', gen: -1, h: hashOf(p),
      root: null, mixer: null, acts: null, base: null, baseKey: '',
      shot: null, addShot: null, desk: null, fastT: 0,
      pulse: null, pulseT: 0,
      gesture: p.gesture || '', lastEvent: p.last,
      q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, (FACE_YAW[p.face] || 0) + yaw0, 0)),
      px: p.x, pz: p.y, ground: 0, idle: null, hue: -1, back: null,
    };
  }

  function actionFor(a, key) {
    if (!clips[key]) return null;
    let act = a.acts[key];
    if (!act) act = a.acts[key] = a.mixer.clipAction(clips[key]);
    return act;
  }

  function upgrade(a) {
    const p = a.p;
    // SkeletonUtils.clone: a plain .clone() shares the skeleton and everyone
    // animates identically. The rig has TWO skinned meshes; clone handles both.
    const root = skeletonClone(template);
    if (p.boss) root.scale.setScalar(o.bossScale);
    const mixer = new THREE.AnimationMixer(root);
    a.root = root; a.mixer = mixer; a.acts = {};
    a.base = null; a.baseKey = ''; a.shot = null; a.addShot = null; a.desk = null;
    a.hue = -1;
    mixer.addEventListener('finished', e => {
      if (e.action === a.addShot) { a.addShot = null; return; }
      if (e.action !== a.shot) return;
      a.shot = null;
      if (!a.base) return;
      /* A weight fade that reaches 0 also sets enabled = false in three, and a
         disabled action neither fades back in nor advances its clip. Without
         re-arming the base here the rig freezes on the one-shot's last frame
         for good — it looks like the person got stuck mid-reach. */
      a.base.enabled = true;
      e.action.crossFadeTo(a.base, o.gestureFade, false);
    });
    setClip(a, CLIP_FOR[p.state] || 'idle', 0);
    layerDesk(a, p.state === 'type', 0);
    mixer.update(0);              // otherwise frame 1 is the bind pose (a T-pose)
    group.add(root);
    a.lod = 'full'; a.gen = gen;
  }

  function downgrade(a) {
    if (a.root) group.remove(a.root);
    if (a.mixer) { a.mixer.stopAllAction(); a.mixer.uncacheRoot(a.root); }
    // geometry and materials are shared with the template and the tint cache:
    // never disposed here, only in dispose()
    a.root = null; a.mixer = null; a.acts = null;
    a.base = null; a.shot = null; a.addShot = null; a.desk = null;
    a.lod = 'cheap';
  }

  function setClip(a, key, fade) {
    let want = key;
    // two walks and two idles so a corridor is not one pose
    if (o.variants && (a.h & 1) && clips[key + '2']) want = key + '2';
    const next = actionFor(a, want) || actionFor(a, 'idle');
    if (!next) return;
    if (a.shot) { a.shot.fadeOut(fade || o.gestureFade); a.shot = null; }
    if (next === a.base) { a.baseKey = key; return; }
    next.enabled = true;
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = false;
    next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);
    next.reset();
    // offset per person, or a row of people at the same station is in lockstep
    next.time = ((a.h % 997) / 997) * (next.getClip().duration || 0);
    next.play();
    if (a.base && fade > 0) a.base.crossFadeTo(next, fade, false);
    else if (a.base) a.base.setEffectiveWeight(0);
    a.base = next; a.baseKey = key;
  }

  /* the desk layer rides along under everything else while a person is seated */
  function layerDesk(a, on, fade) {
    const act = a.desk || (a.desk = actionFor(a, 'desk'));
    if (!act) return;
    if (on) {
      if (!act.isRunning()) {
        act.enabled = true;
        act.setLoop(THREE.LoopRepeat, Infinity);
        act.reset();
        act.time = ((a.h % 331) / 331) * act.getClip().duration;
        act.play();
      }
      if (fade > 0) act.fadeIn(fade); else act.setEffectiveWeight(1);
    } else if (act.isRunning()) {
      if (fade > 0) act.fadeOut(fade); else { act.setEffectiveWeight(0); act.stop(); }
    }
  }

  function fireGesture(a, gesture, ff) {
    const p = a.p;
    const pulse = () => { a.pulse = PULSE[gesture] || PULSE.point; a.pulseT = 0; };
    if (ff) return;
    if (a.lod !== 'full' || !a.mixer) { pulse(); return; }

    // typefast is not a clip: it is the desk layer in a hurry, which is exactly
    // what an Edit looks like. Only means anything while actually seated.
    if (gesture === 'typefast') {
      if (p.state === 'type' && clips.desk) a.fastT = 0.9; else pulse();
      return;
    }
    const clip = clips[gesture];
    if (!clip) { pulse(); return; }

    if (ADDITIVE.has(gesture)) {
      const act = actionFor(a, gesture);
      act.reset();
      act.enabled = true;
      act.setLoop(THREE.LoopOnce, 1);
      act.clampWhenFinished = false;   // the synthesised clips end back at identity
      act.setEffectiveTimeScale(1);
      act.setEffectiveWeight(1);
      act.play();
      a.addShot = act;
      return;
    }
    // full-body one-shot: replaces the base, so never mid-stride and never at a
    // desk, where a standing reach would stand the person up
    if (p.state === 'walk' || p.state === 'leaving' || p.state === 'type') { pulse(); return; }
    const act = actionFor(a, gesture);
    act.reset();
    act.enabled = true;
    act.setLoop(THREE.LoopOnce, 1);
    act.clampWhenFinished = true;
    act.setEffectiveTimeScale(1);
    act.setEffectiveWeight(1);
    act.play();
    if (a.base) a.base.crossFadeTo(act, o.gestureFade, false);
    a.shot = act;
  }

  /* ---------------------------------------------------------------- sync --- */

  function sync(people, dt, ctx) {
    if (!bodies) return info;        // a frame can still land after dispose()
    const St = (globalThis.Sim && globalThis.Sim.St) || null;
    // scene.js's per-frame hook is hooks.frame(dt), so sync(dt) is accepted too
    // and takes the roster from the sim: `Scene.hooks.frame = chars.sync` works
    if (typeof people === 'number') { ctx = dt; dt = people; people = St && St.people; }
    const c = ctx || {};
    const focus = 'focus' in c ? c.focus : (St ? St.focus : null);
    // catchUp teleports people exactly as ff does, so both skip animation
    const ff = 'ff' in c ? !!c.ff : !!(St && (St.ff || St.catchUp));
    const clock = 'clock' in c ? c.clock : (St ? St.clock : 0);
    const idleAfter = (globalThis.Sim && globalThis.Sim.IDLE) || 90;
    const q = ('q' in c ? c.q : (St ? St.q : '')) || '';
    const personText = globalThis.Sim && globalThis.Sim.personText;
    const list = Array.isArray(people) ? people : Object.values(people || {});
    dt = Math.min(Math.max(dt || 0, 0), 0.25);     // a backgrounded tab must not jump

    const live = new Set(list.map(p => p.key));
    for (const key of [...avatars.keys()]) if (!live.has(key)) drop(key);

    const wantFull = template && info.mode === 'rig'
      ? chooseFull(list, focus, o.maxFull) : new Set();
    let nCheap = 0, nAll = 0;
    ensureCap(list.length);

    for (const p of list) {
      let a = avatars.get(p.key);
      if (!a) { a = makeAvatar(p); avatars.set(p.key, a); }
      a.p = p;

      const want = wantFull.has(p.key) ? 'full' : 'cheap';
      if (want === 'full' && (a.lod !== 'full' || a.gen !== gen)) {
        if (a.lod === 'full') downgrade(a);
        upgrade(a);
      } else if (want === 'cheap' && a.lod !== 'cheap') downgrade(a);

      /* ground speed, measured not nominal: the personal-space shove and the
         slow-down into a waypoint both change it, and the feet have to follow
         the floor, not p.speed */
      const dx = p.x - a.px, dz = p.y - a.pz, d = Math.hypot(dx, dz);
      const teleport = d > 1.5 || ff;
      if (dt > 0) a.ground += ((teleport ? 0 : d / dt) - a.ground) * Math.min(1, dt * 8);
      a.px = p.x; a.pz = p.y;

      /* p.gesture is PERSISTENT — Ishita sets it per tool call and clears it
         later, so it holds a value for many frames. Compare against the last one
         played or the one-shot re-triggers every frame and reads as a twitch. */
      const g = p.gesture || '';
      if (g !== a.gesture) { if (g) fireGesture(a, g, ff); a.gesture = g; }
      /* a prompt event carries no tool, so it leaves p.gesture empty — but the
         boss just took an instruction. sim.js quotes only prompts into p.saying. */
      if (o.nodOnPrompt && clips.nod && p.last !== a.lastEvent && !g &&
          p.saying && p.saying.charCodeAt(0) === 0x201C) fireGesture(a, 'nod', ff);
      a.lastEvent = p.last;

      if (a.pulse) { a.pulseT += dt; if (a.pulseT > a.pulse[0]) a.pulse = null; }
      const pitch = a.pulse
        ? Math.sin(a.pulseT * a.pulse[1]) * a.pulse[2] * (1 - a.pulseT / a.pulse[0]) : 0;

      /* aim down the movement vector while walking (smooth, and already
         lane-offset by the sim) and at p.face once parked */
      const yaw = (!teleport && d > 0.004 ? Math.atan2(dx, dz) : FACE_YAW[p.face] || 0) + yaw0;
      turnTo(a.q, yaw, o.turnRate, dt, ff);
      const seated = p.state === 'type';
      const isIdle = clock - p.last > idleAfter;
      const back = backOf(p, focus, q, personText);

      if (a.lod === 'full') {
        const key = CLIP_FOR[p.state] || 'idle';
        if (key !== a.baseKey) {
          setClip(a, key, ff ? 0 : o.fade);
          layerDesk(a, seated, ff ? 0 : o.fade);
        }
        if (a.base) {
          a.base.setEffectiveTimeScale(
            a.baseKey === 'walk' ? walkScale(a.ground, o.walkRef) : 1);
        }
        if (a.fastT > 0) {
          a.fastT -= dt;
          if (a.desk) a.desk.setEffectiveTimeScale(a.fastT > 0 ? 2.4 : 1);
        }
        if (a.hue !== p.hue || a.idle !== isIdle || a.back !== back) {
          a.root.traverse(ch => {
            if (ch.isMesh) ch.material = tinted(ch.material, p.hue, isIdle, back);
          });
          a.hue = p.hue; a.idle = isIdle; a.back = back;
        }
        a.root.position.set(p.x, 0, p.y);
        a.root.quaternion.copy(a.q);
        if (pitch) a.root.rotateX(pitch);
        // mixers are meaningless while the sim teleports people: freeze the pose
        if (!ff && dt > 0) a.mixer.update(dt);
      } else {
        const i = nCheap++;
        const s = p.boss ? o.bossScale : 1;
        const bob = p.state === 'walk' ? Math.abs(Math.sin(p.phase)) * 0.06
          : Math.sin(p.bob) * 0.018;
        const lift = ff ? 0 : bob;
        scratch.quaternion.copy(a.q);
        if (pitch) scratch.rotateX(pitch);
        color.setHSL(p.hue / 360, isIdle ? 0.16 : 0.58, isIdle ? 0.38 : 0.55,
                     THREE.SRGBColorSpace);   // see the note on the rigged tint above
        if (back) color.multiplyScalar(BACK);

        scratch.position.set(p.x, (seated ? 0.66 : 0.79) * s + lift, p.y);
        scratch.scale.set(s, s * (seated ? 0.66 : 1), s);
        scratch.updateMatrix();
        bodies.setMatrixAt(i, scratch.matrix);
        bodies.setColorAt(i, color);

        scratch.position.set(p.x, (seated ? 1.33 : 1.68) * s + lift, p.y);
        scratch.scale.setScalar(s);
        scratch.updateMatrix();
        heads.setMatrixAt(i, scratch.matrix);
        // set, not offsetHSL: that would do the arithmetic in linear HSL and undo
        // the colour space we just asked for
        color.setHSL(p.hue / 360,
          Math.max(0, (isIdle ? 0.16 : 0.58) - 0.08),
          Math.min(1, (isIdle ? 0.38 : 0.55) + 0.1), THREE.SRGBColorSpace);
        if (back) color.multiplyScalar(BACK);
        heads.setColorAt(i, color);
      }

      scratch.position.set(p.x, 0.02, p.y);
      scratch.quaternion.identity();
      scratch.scale.setScalar(seated ? 0.8 : 1);
      scratch.updateMatrix();
      blobs.setMatrixAt(nAll++, scratch.matrix);
    }

    bodies.count = heads.count = nCheap;
    blobs.count = nAll;
    for (const m of [bodies, heads, blobs]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    info.full = avatars.size - nCheap;
    info.cheap = nCheap;
    return info;
  }

  function drop(key) {
    const a = avatars.get(key);
    if (!a) return;
    if (a.lod === 'full') downgrade(a);
    avatars.delete(key);
  }

  function dispose() {
    for (const key of [...avatars.keys()]) drop(key);
    for (const m of [bodies, heads, blobs]) if (m) { group.remove(m); m.dispose(); }
    bodies = heads = blobs = null; cap = 0;
    for (const g of [geoBody, geoHead, geoBlob]) g.dispose();
    matCheap.dispose(); matBlob.dispose();
    for (const m of tints.values()) m.dispose();
    tints.clear();
    if (template) {
      template.traverse(c => {
        if (!c.isMesh) return;
        c.geometry.dispose();
        for (const m of [].concat(c.material)) if (m) m.dispose();
      });
    }
    template = null; clips = {};
    group.clear();
    info.mode = 'primitive';
  }

  return { group, load, sync, dispose, info, options: o, CLIP_FOR };
}

/* ------------------------------------------------------------- selftest --- */
/* The pure logic, which is where the bugs hide: clip fallback naming, the walk
   rate that stops the feet skating, and the LOD rule.
   node --experimental-default-type=module -e \
     "import('./view3d/characters.js').then(m => m.selfTest())"          */
export function selfTest() {
  const ok = (c, m) => { if (!c) throw new Error('selfTest: ' + m); };
  const cl = names => names.map(n => ({ name: n }));

  ok(pickClip(cl(['idle_loop', 'walk_loop']), 'walk').name === 'walk_loop', 'walk_loop');
  ok(pickClip(cl(['walk_loop', 'walk_formal_loop']), 'walk').name === 'walk_formal_loop',
    'the formal walk leads, per the manifest');
  ok(pickClip(cl(['Armature|idle_loop']), 'idle').name === 'Armature|idle_loop', 'prefixed name');
  ok(pickClip(cl(['sitting_idle_loop', 'idle_loop']), 'type').name === 'sitting_idle_loop',
    'type takes the seated clip, not idle');
  ok(pickClip(cl(['idle_loop']), 'point') === null, 'a missing gesture is null, not a wrong clip');

  // the sim walks people at 2.0-2.39 tiles/s against a 0.975 u/s clip
  const r = walkScale(2.2, 0.975);
  ok(r > 2.2 && r < 2.3, 'sim speed 2.2 -> ~2.26x, got ' + r);
  ok(walkScale(0.975, 0.975) === 1, 'the reference speed plays at 1x');
  ok(walkScale(0, 0.975) === 0.35 && walkScale(99, 0.975) === 2.6, 'clamped both ends');

  const R1 = { id: 1 }, R2 = { id: 2 };
  const ppl = [];
  for (let i = 0; i < 50; i++) ppl.push({ key: 'k' + String(i).padStart(3, '0'), room: i < 45 ? R1 : R2 });
  ok(chooseFull(ppl, R1, 40).size === 40, 'focused room capped at 40');
  ok(!chooseFull(ppl, R1, 40).has('k049'), 'another room, no rig');
  ok(chooseFull(ppl, R2, 40).size === 5, 'small focused room, everyone rigged');
  ok(chooseFull(ppl, null, 40).size === 40, 'no focus: spend the budget, still capped');
  const a = [...chooseFull(ppl, null, 40)].join();
  const b = [...chooseFull(ppl.slice().reverse(), null, 40)].join();
  ok(a === b, 'the LOD set is order-independent, so it cannot churn frame to frame');

  // the corrected rule: the amenity band is never degraded, wherever focus is
  const caf = { key: 'zzz-cafe', room: R2, fac: { kind: 'cafeteria' } };
  ok(chooseFull([...ppl, caf], R1, 40).has('zzz-cafe'), 'band person must keep a rig');
  ok(chooseFull([...ppl, caf], R1, 1).has('zzz-cafe'), 'band wins the last slot');
  const cow = { key: 'zzz-cowork', room: R2, cowork: true };
  ok(chooseFull([...ppl, cow], R1, 40).has('zzz-cowork'), 'p.cowork counts as the band too');

  ok(FACE_YAW[2] === 0 && Math.abs(FACE_YAW[0] - Math.PI) < 1e-9, 'S faces +z, N faces -z');
  ok(Math.abs(Math.atan2(1, 0) - FACE_YAW[1]) < 1e-9, 'E yaw agrees with atan2(dx, dz)');
  ok(Math.abs(Math.atan2(0, -1) - FACE_YAW[0]) < 1e-9, 'N yaw agrees with atan2(dx, dz)');

  for (const g of GESTURE_KEYS) ok(PULSE[g], 'gesture ' + g + ' has no fallback tell');
  ok(SYNTH.every(k => ADDITIVE.has(k)), 'a synthesised layer must be additive');

  console.log('characters.js selfTest: ok');
  return true;
}
