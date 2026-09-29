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
   - one rig for 135 people, so every difference between them is a bit slice of p.h
     and never Math.random: buildOf, VARIANTS, personPalette, splitRegions.

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
import { personPalette, mixHash } from './materials.js';

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
const ADDITIVE = new Set([...SYNTH, 'nod', 'shake']);

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
/* the same four facings as a unit [dx, dz], for the seated settle */
const FACE_FWD = [[0, -1], [1, 0], [0, 1], [-1, 0]];

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
  variants: true,     // two walks and three standing idles, picked by p.h
  /* x the measured 1.8287, so 1.62 m to 1.82 m. Tune by eye; width is the only
     non-uniform axis and 3% is its ceiling — past that a skinned mesh reads squashed
     rather than slim. */
  height: [0.885, 0.995],
  width: [0.97, 1.03],
  /* Parked on its seat tile's centre the seated pose puts its lower back THROUGH the
     chair's backrest and out the far side. 0.14 is a window, not a taste: it has to
     clear the back of the cushion and still rest on its front face, without pushing a
     foot into the desk. selfTest holds the window; do not nudge it by eye. */
  sitFwd: 0.14,
  /* Measured: M_Joints is 8012 of the male rig's 13744 triangles (8197 of 14612 on the
     female), 91% of it finger balls, and not one of its 49 balls sits over empty
     M_Main — so hiding it opens no hole and loses no silhouette. It is also the
     segmentation that reads as a jointed doll. Set false to see the joints again. */
  hideJoints: true,
  female: true,       // deal the second rig, per person, off p.h
  hair: true,
  garments: true,
  face: true,         // false leaves the blank mannequin head
  fidget: 17,         // seconds per micro-behaviour beat; 0 turns it off
};

/* Clip suffixes load() resolves; '' is the manifest's preferred default, so a rig
   carrying only the defaults still works (setClip falls back). */
const VARIANTS = { walk: ['', '2'], idle: ['', '2', '3'] };

/* The body mesh is split into four contiguous index ranges by the bone that skins each
   vertex hardest (see splitRegions). Bare, they are the outfit: skin, shirt, trousers.
   Dressed, a range a garment fully encloses is given an invisible material, which three
   skips entirely — so a covered body range costs no draw call AND cannot poke through
   the cloth over it. The boundaries are measured, not assumed:

     R_SHIRT   spine/clavicle/upperarm/lowerarm — under topLong's shell and its
               sleeve, which reaches wristX - 0.02. Hidden whenever a top is worn.
     R_TROUSER pelvis + thigh, measured y 0.5245-1.0775. Trousers cover 0.133-0.967
               and the shell covers from 0.847 up, so together the whole range.
               A skirt covers it too, as long as its hem is AT the thigh/calf vertex
               boundary — which is why outfitFor measures the knee instead of taking
               garments.js's 0.62 default, 10 cm above it.
     R_SHIN    calf + foot, y 0.0996-0.5135. Never hidden: trousers stop at
               ankleY + 0.03, so the last 3 cm is a foot, and under a skirt the whole
               range is a bare leg. Tinted trouser or skin instead.

   A height split would not work for the arms — the rig is T-posed, so every arm vertex
   sits at shoulder height (measured: upperarm 1.373-1.521). */
const R_SKIN = 0, R_SHIRT = 1, R_TROUSER = 2, R_SHIN = 3, R_N = 4;
const SKIN_BONES = /^(Head|neck_01|hand_|index_|middle_|ring_|pinky_|thumb_)/;
const HIP_BONES = /^(pelvis|thigh_)/;
const SHIN_BONES = /^(calf_|foot_|ball_)/;
const regionOfBone = n =>
  SKIN_BONES.test(n) ? R_SKIN : HIP_BONES.test(n) ? R_TROUSER
    : SHIN_BONES.test(n) ? R_SHIN : R_SHIRT;
// M_Joints is ball joints, three quarters of it finger balls: one dark tone
const JOINT_MAT = /joint/i;

/* Hair, dealt by gender. Weighted lists rather than a weighting table: a buzz is
   rarer than a full head, and a duplicate entry says so in one character. */
const HAIR_F = ['long', 'long', 'buns', 'buns', 'buzzedFemale'];
const HAIR_M = ['parted', 'parted', 'buzzed'];
/* Silhouette volume on the cheap LOD, as a multiple of the head sphere. Under 1.05
   there is nothing to draw — a buzz IS the bare crown. */
const HAIR_VOL = { long: 1.16, buns: 1.18, buzzedFemale: 1.03, parted: 1.10, buzzed: 1.03 };
/* garments.js's own kinds. Women get a skirt or a dress twice as often as trousers,
   which is what puts both on the floor without dressing the office as a uniform. */
const LOWER_F = ['trousers', 'trousers', 'skirt', 'skirt', 'dress'];
/* The hue carries the team, so the top carries the hue; the bottom comes off the
   neutral fabric ladder. A dress is two of her kinds in one tone — see buildOf. */
const CLOTH_TONE = { top: 'shirt', topLong: 'shirt', trousers: 'trouser',
                     skirt: 'trouser', jacket: 'jacket' };
/* Micro-behaviour, all additive and all already loaded for something else. */
const FIDGET = ['lookup', 'nod', 'shake', 'headscratch'];

/* Clips whose first and last frames do not meet, so LoopRepeat snaps at the seam.
   Measured on the real rig, first vs last frame, worst non-finger bone: walk 0.1 cm,
   walk2 0.6, idle 0.3, idle2 0.1, idle3 0.0, talk 0.0, type 0.0 — and search 8.6 cm at
   the forearm, 14.5 at the fingertips. `search` is 0.9-4.0 s cut out of a clip that
   stands up at the end, so on repeat every person at a filing cabinet threw a hand 9 cm
   across one frame, every 3 seconds. That was the involuntary motion. PingPong plays it
   forward then backward: no seam at either end, and a reach in and back out is what
   rummaging in a cabinet looks like anyway. */
const PINGPONG = new Set(['search']);

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

/* Measured ground speed / reference. NEVER fudge this ratio to fix a cadence — it is
   the only thing stopping the skate, so the knob is p.speed in sim.js, which used to
   play it at 2.45x. The clamp is an outlier guard for the shove, not an operating
   point. */
export const walkScale = (ground, ref) => clamp(ground / (ref || 1), 0.35, 2.6);

/* Height and width off MIXED bits of p.h: hash() in sim.js is a plain *31 roll, so
   sibling keys share every bit above ~8 and an unmixed slice hands a whole room one
   body — the trap sim.js's own KNUTH multiply fixes. The boss is scaled on top. */
export function buildOf(h, boss, o) {
  const m = mixHash(h);
  const [hLo, hHi] = o.height, [wLo, wHi] = o.width;
  const hy = (hLo + ((m >>> 18) % 12) / 11 * (hHi - hLo)) * (boss ? o.bossScale : 1);
  const wRel = wLo + ((m >>> 22) % 7) / 6 * (wHi - wLo) + (boss ? 0.02 : 0);
  const pick = (key, at) => {
    const opts = VARIANTS[key];
    return opts[((m >>> at) >>> 0) % opts.length];
  };
  /* Gender, hair and outfit come off a SECOND avalanche of the same p.h, not a second
     slice of the first: Knuth's multiply mixes its high bits well and its low ones
     barely at all, and materials.js already reads the low slices for shirt, trouser,
     skin and hair colour. One more xor-and-multiply is cheaper than a bit budget. */
  const g = mixHash((h >>> 0) ^ 0x9e3779b9);
  const female = ((g >>> 31) & 1) === 1;
  const styles = female ? HAIR_F : HAIR_M;
  const low = female && !boss ? LOWER_F[(g >>> 19) % LOWER_F.length] : 'trousers';
  const dress = low === 'dress';
  return {
    hy, hw: hy * wRel,
    // fixed for a boss, dealt for everyone else: arms folded is the cheapest way the
    // rig can say who is in charge, and a rank that varies is not a rank
    variant: { walk: boss ? '' : pick('walk', 26), idle: boss ? '2' : pick('idle', 28) },
    female,
    hair: styles[(g >>> 27) % styles.length],
    beard: !female && ((g >>> 23) & 3) === 0,
    dress,
    skirt: dress || low === 'skirt',
    /* Always the long sleeve. garments.js's short-sleeved `top` stops at mid upper arm,
       which would leave R_SHIRT only half covered and so undroppable — and an outer
       upper arm showing through a shell is the poke-through we are removing.
       The boss's suit is fixed, and the jacket is one of his five identity cues. */
    outfit: boss ? ['topLong', 'trousers', 'jacket'] : ['topLong', dress ? 'skirt' : low],
  };
}

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

  /* `template` is the male rig AND the measurement reference: every synthesised layer
     and the facing are measured off it, and the two rigs share one skeleton with the
     same rest orientations. `templates.f` is the female rig or null. */
  let template = null, clips = {}, gen = 0, yaw0 = 0;
  const templates = { rig: null, rigFemale: null };
  let Garm = null, merge = null;                 // garments.js, BufferGeometryUtils
  /* Did we load the rigs and hair ourselves? load(pre) takes a scene the CALLER parsed,
     and dispose() must not tear down buffers somebody else is still drawing with. */
  let owned = false;
  const hairSrc = {};                            // style -> source geometry
  let hairFit = null;
  const hairGeo = new Map();                     // style(+beard)|rigKey -> fitted geometry
  const outfits = new Map();                     // rigKey|kinds -> Rhea's { geometry, groups }
  const info = {
    mode: 'primitive', rig: null, rigFemale: null, clips: {}, synth: [], missing: [],
    hair: [], outfits: 0, full: 0, cheap: 0, notes: [],
  };
  const warn = m => { info.notes.push(m); console.warn('[characters] ' + m); };

  /* --- cheap LOD: four InstancedMeshes, no mixer, no per-person draw call ---
     95 of 135 people are these, so three parts, not one pill. Heights from the
     manifest, scaled by the same build the rig uses. Legs are a cylinder and not a
     second capsule because X8 finds the body by geometry type. */
  const geoBody = new THREE.CapsuleGeometry(0.17, 0.34, 3, 10);
  const geoLegs = new THREE.CylinderGeometry(0.155, 0.115, 0.80, 8);
  const geoHead = new THREE.SphereGeometry(0.13, 10, 7);
  const geoBlob = new THREE.CircleGeometry(0.3, 14).rotateX(-Math.PI / 2);
  /* Unscaled part centres. Seated drops onto the chair (seat top 0.44) and shortens
     the legs, since a cylinder cannot show a thigh going forward. Neighbouring parts
     OVERLAP a couple of centimetres: butted exactly, the bob opens a slit at the
     waist and neck. */
  /* hemY/hemS are the skirt band: the SAME span the rig's garment covers — hip to knee,
     bare below — so a skirt does not become a floor-length bell when a person crosses
     the LOD line. It is a second instance of the leg cylinder, flipped end for end so
     its taper runs the other way (see putPart), which costs no extra draw call. */
  const POSE = {
    stand: { legY: 0.50, legS: 1, torsoY: 1.19, torsoS: 1, headY: 1.67,
             hemY: 0.40, hemS: 0.30 },
    sit: { legY: 0.34, legS: 0.62, torsoY: 0.86, torsoS: 0.85, headY: 1.20,
           hemY: 0.34, hemS: 0.24 },
  };
  const matCheap = new THREE.MeshLambertMaterial();
  /* Sources for tinted() only, never rendered as they are. Both double-sided: the hair
     is authored that way and a skirt is seen from inside it every time somebody sits. */
  const matHair = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  const matCloth = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  // flat quads laid on the skull: double-sided, so a winding we did not author cannot
  // turn the whole face invisible, which is the bug this exists to fix
  const matFace = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  /* A body range that a garment encloses. three skips a group whose material is not
     visible, so this is genuinely not drawn — no draw call, nothing to poke through. */
  const matHidden = new THREE.MeshBasicMaterial({ visible: false });
  // blob shadow, not a shadow map: 135 characters cannot afford real ones
  const matBlob = new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false,
  });
  let cap = 0, bodies = null, legs = null, heads = null, blobs = null;

  function ensureCap(n) {
    if (n <= cap) return;
    cap = Math.max(64, 1 << Math.ceil(Math.log2(n)));
    for (const m of [bodies, legs, heads, blobs]) if (m) { group.remove(m); m.dispose(); }
    // bodies first: X8 takes the first CapsuleGeometry in the group as the torso
    bodies = new THREE.InstancedMesh(geoBody, matCheap, cap);
    legs = new THREE.InstancedMesh(geoLegs, matCheap, cap);
    heads = new THREE.InstancedMesh(geoHead, matCheap, cap);
    blobs = new THREE.InstancedMesh(geoBlob, matBlob, cap);
    for (const m of [bodies, legs, heads, blobs]) {
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
      // pre.female / pre.hair / pre.garments let a headless harness reach the same
      // code the browser does; without them everyone is dealt the one rig, bare
      if (o.female && pre.female) { templates.rigFemale = pre.female; info.rigFemale = 'preloaded'; }
      if (pre.hair) { Object.assign(hairSrc, pre.hair.styles || {}); hairFit = pre.hair.fit || null; }
      if (o.garments && pre.garments) Garm = pre.garments;
      if (pre.merge) merge = pre.merge;
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

    const at = f => new URL(f.replace(/^assets\//, ''), base).href;
    owned = true;                  // everything below is ours to dispose
    const rigFile = (man && man.rig && man.rig.file) || 'assets/rig-human.glb';
    let rig;
    try { rig = await loader.loadAsync(at(rigFile)); }
    catch (e) {
      warn('rig ' + rigFile + ' failed (' + (e && e.message) + ') — capsule stand-ins only');
      return info;
    }
    info.rig = rigFile;

    /* The second rig is optional in both directions: without it every person is dealt
       the male one, which is what shipped before. Its 65 bones are a subset of the
       male 71 and the 6 it lacks are exactly the unanimated ones, so the clips bind. */
    if (o.female && man && man.rigFemale && man.rigFemale.file) {
      try {
        templates.rigFemale = (await loader.loadAsync(at(man.rigFemale.file))).scene;
        info.rigFemale = man.rigFemale.file;
      } catch (e) { warn('female rig failed (' + (e && e.message) + ') — one rig only'); }
    }
    // beard-over-hair merges into one mesh, so a bearded man is still one draw call
    try { ({ mergeGeometries: merge } = await import('../vendor/BufferGeometryUtils.js')); }
    catch (e) { warn('BufferGeometryUtils unavailable — no beards'); }
    if (o.hair && man && man.hair) await loadHair(loader, at, man.hair);
    if (o.garments) {
      try { Garm = await import('./garments.js'); }
      catch (e) { warn('garments.js unavailable (' + (e && e.message) + ') — bare rigs'); }
    }

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
      // third idle. NOT idle_talking_loop, which is already `talk` for `meet`:
      // someone alone at the cooler talking to nobody looks wrong
      wanted.idle3 = man.extraClips.idle_phone;
    }
    if (o.nodOnPrompt && man.extraClips) wanted.nod = man.extraClips.nod;
    if (o.fidget && man.extraClips) wanted.shake = man.extraClips.shake;

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
    /* walk_formal_loop leads. Here and name-keyed, not out in load(): load(pre)
       returns early, so a swap out there inverted the preloaded path — the boss lost
       his composed walk and every test ran a different assignment than the app. */
    if (clips.walk2 && /formal/i.test(clips.walk2.name || '')) {
      const w = clips.walk; clips.walk = clips.walk2; clips.walk2 = w;
    }
    if (!clips.idle) clips.idle = clips.walk || clips.type || clips.talk || null;
    if (!clips.idle) {
      warn('rig ' + info.rig + ' carries no usable clip — capsule stand-ins only');
      template = null;
      return;
    }
    templates.rig = template;
    let split = 0, hidden = 0, tris = 0;
    for (const t of [templates.rig, templates.rigFemale]) {
      if (!t) continue;
      t.traverse(c => {
        if (!c.isMesh) return;
        c.castShadow = c.receiveShadow = false;  // blob shadows only
        c.frustumCulled = false;                 // a skinned bbox is the bind pose and pops
        const n = (c.material && c.material.name) || '';
        // on the TEMPLATE: clone shares geometry, so one partition dresses all 40 rigs
        if (!JOINT_MAT.test(n)) { c.userData.body = true; if (splitRegions(c)) split++; }
        else if (o.hideJoints) { c.visible = false; hidden++; }
        if (c.visible) tris += (c.geometry.index ? c.geometry.index.count : 0) / 3;
      });
    }
    info.notes.push(split ? 'split ' + split + ' mesh into ' + R_N + ' skin/cloth ranges'
                          : 'no mesh could be partitioned — one tone per person');
    if (hidden) info.notes.push('hid ' + hidden + ' ball-joint mesh, ' + tris + ' tris left');
    info.hair = Object.keys(hairSrc);

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
    if (clips.shake) clips.shake = headOnlyAdditive(clips.shake, 'shake', 45, 30);

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

  /* Re-order the index buffer into R_N contiguous ranges so one mesh draws as skin,
     shirt, trousers and shins with shared materials and no per-person geometry.
     By dominant bone, never by height: the hands sit at 0.92 in bind pose, right in
     the middle of the torso's band. */
  function splitRegions(mesh) {
    const g = mesh.geometry;
    if (Array.isArray(mesh.material)) return true;   // already partitioned; idempotent
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    if (!si || !sw || !g.index || !mesh.skeleton) return false;
    const bones = mesh.skeleton.bones;
    const vreg = new Uint8Array(si.count);
    for (let i = 0; i < si.count; i++) {
      let best = 0, bw = -1;
      for (const k of ['X', 'Y', 'Z', 'W']) {
        const w = sw['get' + k](i);
        if (w > bw) { bw = w; best = si['get' + k](i); }
      }
      const b = bones[best];
      vreg[i] = b ? regionOfBone(b.name) : R_SHIRT;
    }
    const idx = g.index.array, tris = idx.length / 3;
    const buckets = Array.from({ length: R_N }, () => []);
    for (let t = 0; t < tris; t++) {
      const a = vreg[idx[t * 3]], b = vreg[idx[t * 3 + 1]], c = vreg[idx[t * 3 + 2]];
      buckets[a === b || a === c ? a : b === c ? b : a].push(t);
    }
    if (buckets.filter(b => b.length).length < 2) return false;   // nothing to split
    const out = new idx.constructor(idx.length);
    let at = 0;
    g.clearGroups();
    for (let r = 0; r < R_N; r++) {
      const start = at;
      for (const t of buckets[r]) {
        out[at++] = idx[t * 3]; out[at++] = idx[t * 3 + 1]; out[at++] = idx[t * 3 + 2];
      }
      if (at > start) g.addGroup(start, at - start, r);
    }
    g.index.set(out);
    g.index.needsUpdate = true;
    // one entry per region, replaced by paint(); Mesh.copy slices the array
    mesh.material = new Array(R_N).fill(mesh.material);
    return true;
  }

  /* ---------------------------------------------------------------- hair --- */

  /* Static meshes already in Head-bone local space, so parenting one to `Head` makes
     it ride all 18 clips with no skinning and no rebinding. */
  async function loadHair(loader, at, spec) {
    hairFit = spec.fit || null;
    await Promise.all(Object.entries(spec.styles || {}).map(async ([k, s]) => {
      try {
        const g = await loader.loadAsync(at(s.file));
        let mesh = null;
        g.scene.traverse(x => { if (x.isMesh && !mesh) mesh = x; });
        if (mesh) hairSrc[k] = mesh.geometry;
      } catch (e) { warn('hair ' + k + ' failed: ' + (e && e.message)); }
    }));
    info.hair = Object.keys(hairSrc);
  }

  /* These were authored on a wider, shorter skull than either mannequin's, so the
     manifest carries a per-axis scale and offset keyed by source group and target
     rig. Skipping it leaves every style floating off a bare crown. */
  function fittedHair(style, rigKey) {
    const key = style + '|' + rigKey;
    if (hairGeo.has(key)) return hairGeo.get(key);
    let g = null;
    const src = hairSrc[style];
    if (src) {
      const grp = Object.values(hairFit || {})
        .find(f => f && Array.isArray(f.appliesTo) && f.appliesTo.includes(style));
      const t = grp && grp[rigKey];
      g = src.clone();
      if (t) { g.scale(t.scale[0], t.scale[1], t.scale[2]); g.translate(...t.position); }
      else warn('no fit transform for hair ' + style + ' on ' + rigKey + ' — bare crown');
    }
    hairGeo.set(key, g);
    return g;
  }

  function hairGeometry(style, beard, rigKey) {
    const key = style + (beard ? '+beard' : '') + '|' + rigKey;
    if (hairGeo.has(key)) return hairGeo.get(key);
    const hair = fittedHair(style, rigKey);
    const chin = beard ? fittedHair('beard', rigKey) : null;
    let g = hair;
    if (hair && chin && merge) {
      try { g = merge([hair, chin]) || hair; }
      catch (e) { warn('beard would not merge onto ' + style + ': ' + (e && e.message)); }
    }
    hairGeo.set(key, g);
    return g;
  }

  /* ---------------------------------------------------------------- face --- */

  /* garments.js measures the eyes and brows off each rig's own skull and hands back a
     static Head-local geometry, so it rides every clip exactly as the hair does. The
     three expressions are shared per rig: changing one is a pointer swap, not a rebuild.
     Its own mesh rather than merged into the hair, because the features have to stay
     dark on a fair-haired person — merged, they would take the hair's colour. */
  const EXPR_FOR = { meet: 'talk', type: 'focus', file: 'focus' };
  const exprOf = state => (o.face && EXPR_FOR[state]) || 'idle';

  function faceGeometry(rigKey, expr) {
    const key = 'face|' + rigKey + '|' + expr;
    if (hairGeo.has(key)) return hairGeo.get(key);
    let g = null;
    const head = templates[rigKey] && templates[rigKey].getObjectByName(BONES.head);
    if (Garm && Garm.buildFace && head) {
      try { g = Garm.buildFace(head, { expression: expr }); }
      catch (e) { warn('face ' + key + ' failed: ' + (e && e.message)); }
    }
    hairGeo.set(key, g);
    return g;
  }

  /* ------------------------------------------------------------ garments --- */

  const bodyOf = root => {
    let m = null;
    root.traverse(x => { if (x.isSkinnedMesh && x.userData.body && !m) m = x; });
    return m;
  };

  /* Rhea merges the requested kinds into ONE geometry with a material group each, and
     it is built off the TEMPLATE's body, so every person wearing the same outfit shares
     it — one build per outfit, not per person. */
  function outfitFor(b) {
    const rigKey = b.female && templates.rigFemale ? 'rigFemale' : 'rig';
    const key = rigKey + '|' + b.outfit.join(',');
    if (outfits.has(key)) return outfits.get(key);
    let out = null;
    const body = bodyOf(templates[rigKey]);
    if (Garm && body && b.outfit.length) {
      /* The hem lands ON the thigh/calf vertex boundary, measured off this rig's own
         knee, not on garments.js's 0.62 default — 10 cm higher, which would leave a
         bare thigh below a hidden R_TROUSER range. A dress is the same hem in the
         top's tone: at this camera one colour head to hem is the cue, not the length. */
      try { out = Garm.buildOutfit(b.outfit, body, { skirtHem: kneeOf(rigKey) }); }
      catch (e) { warn('outfit ' + key + ' failed: ' + (e && e.message)); }
    }
    outfits.set(key, out);
    info.outfits = [...outfits.values()].filter(Boolean).length;
    return out;
  }

  function kneeOf(rigKey) {
    const t = templates[rigKey];
    if (!t) return undefined;
    t.updateMatrixWorld(true);              // bind pose; nothing else reads it stale
    const knee = t.getObjectByName('calf_l');
    return knee ? knee.getWorldPosition(new THREE.Vector3()).y - 0.012 : undefined;
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

  /* Keyed on the COLOUR, not the person, so three tones per rig still collapse onto a
     few dozen materials. SET, not lerped toward: this rig has one flat colour per mesh,
     so a lerp preserved no light/dark split, only a wash a skin tone cannot survive. */
  function tinted(src, col, back) {
    const k = src.uuid + '|' + col.getHexString() + (back ? '|b' : '');
    let m = tints.get(k);
    if (!m) {
      m = src.clone();
      m.color = col.clone();
      if (back) m.color.multiplyScalar(BACK);
      tints.set(k, m);
    }
    return m;
  }

  /* Memoised: personPalette's cache key is a string, and building 95 of those a frame
     was two thirds of this layer's frame cost. Shared by both LODs, so nobody changes
     colour crossing the boundary. */
  function palOf(a, p, idle) {
    if (!a.pal || a.palHue !== p.hue || a.palIdle !== idle) {
      a.pal = personPalette(p.hue, a.h, idle, !!p.boss);
      a.palHue = p.hue; a.palIdle = idle;
    }
    return a.pal;
  }

  /* The source comes from userData, never from ch.material: reading the current
     material tinted the ALREADY tinted one on every idle or focus flip, so the colour
     crept and the cache grew an entry per mesh per flip for the whole session. */
  function paint(a, p, idle, back) {
    const pal = palOf(a, p, idle);
    // bare, the four ranges ARE the outfit; a bare shin under a skirt is skin, not cloth
    const tone = [pal.skin, pal.shirt, pal.trouser, a.dressed ? pal.skin : pal.trouser];
    a.root.traverse(ch => {
      if (!ch.isMesh) return;
      const src = ch.userData.srcMat, u = ch.userData;
      if (u.tones) { ch.material = u.tones.map(k => tinted(matCloth, pal[k], back)); return; }
      if (u.hair) { ch.material = tinted(matHair, pal.hair, back); return; }
      if (u.face) { ch.material = tinted(matFace, pal.face, back); return; }
      if (!Array.isArray(src)) {
        ch.material = tinted(src, JOINT_MAT.test(src.name || '') ? pal.joint : pal.shirt, back);
        return;
      }
      ch.material = src.map((s, r) => (a.cover && a.cover[r]) ? matHidden
        : tinted(s, tone[r] || pal.shirt, back));
    });
  }

  // declared once, not per person per frame: a closure over the loop body is 95
  // allocations a frame for no gain
  /* `sw` widens XZ (a skirt hem, a head of hair) and `flip` turns a part end for end:
     the leg cylinder is wide at the waist and narrow at the ankle, so upside down and
     widened it is the tapered cone a skirt needs, with no second geometry and no
     second draw call. A 180-degree X rotation is proper, so the winding survives. */
  function putPart(mesh, i, col, x, z, a, y, sy, lift, pitch, back, sw, flip) {
    const b = a.build, w = b.hw * (sw || 1);
    scratch.position.set(x, y * b.hy + lift, z);
    scratch.quaternion.copy(a.q);
    const rx = pitch + (flip ? Math.PI : 0);
    if (rx) scratch.rotateX(rx);
    scratch.scale.set(w, b.hy * sy, w);
    scratch.updateMatrix();
    mesh.setMatrixAt(i, scratch.matrix);
    color.copy(col);
    if (back) color.multiplyScalar(BACK);
    mesh.setColorAt(i, color);
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
      // decided once, and read by both LODs so nobody changes shape crossing over
      build: buildOf(hashOf(p), !!p.boss, o),
      root: null, mixer: null, acts: null, base: null, baseKey: '',
      shot: null, addShot: null, desk: null, fastT: 0,
      pulse: null, pulseT: 0, dressed: false, cover: null, beat: null,
      face: null, expr: '', rigKey: 'rig',
      gesture: p.gesture || '', lastEvent: p.last,
      q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, (FACE_YAW[p.face] || 0) + yaw0, 0)),
      px: p.x, pz: p.y, ground: 0, idle: null, hue: -1, back: null,
      pal: null, palHue: -1, palIdle: null,
      sitOff: p.state === 'type' ? o.sitFwd : 0,     // 0..o.sitFwd
    };
  }

  /* Clothes and hair onto one cloned rig. Called before srcMat is stamped, so paint()
     picks both up with everything else. a.cover says which body ranges are inside
     cloth: paint() gives those an invisible material, which three skips outright — so
     they cost no draw call and, more to the point, cannot poke through what covers
     them. That is the exact fix for a shoulder pressing out of a sleeve. */
  function dress(a, root, rigKey) {
    const b = a.build;
    const out = outfitFor(b);
    a.dressed = false;
    a.cover = null;
    if (out) {
      const k = b.outfit;
      a.cover = [];
      a.cover[R_SHIRT] = k.includes('topLong') || k.includes('jacket');
      a.cover[R_TROUSER] = k.includes('trousers') || k.includes('skirt');
      // R_SHIN is never covered: trousers stop at ankleY + 0.03 and a skirt at the knee
      const body = bodyOf(root);
      /* Its own Skeleton over the SAME bones: three counts one skeleton per skinned
         mesh, and sharing the object would read as the plain-clone bug K6 pins. */
      const sk = new THREE.Skeleton(body.skeleton.bones, body.skeleton.boneInverses);
      const mesh = new THREE.SkinnedMesh(out.geometry, out.groups.map(() => matCloth));
      mesh.userData.tones = out.groups.map(gr =>
        b.dress ? 'shirt' : (CLOTH_TONE[gr.kind] || 'shirt'));
      mesh.frustumCulled = false;
      mesh.castShadow = mesh.receiveShadow = false;
      root.add(mesh);
      mesh.bind(sk, body.bindMatrix);
      // a skirt or a dress leaves the shins bare, so they are skin and not trouser cloth
      a.dressed = true;
    }
    const head = root.getObjectByName(BONES.head);
    if (!head) return;
    const hair = o.hair && hairGeometry(b.hair, b.beard, rigKey);
    if (hair) head.add(headPart(hair, matHair, { hair: true }));
    a.expr = exprOf(a.p.state);
    a.rigKey = rigKey;
    const face = o.face && faceGeometry(rigKey, a.expr);
    if (face) head.add(a.face = headPart(face, matFace, { face: true }));
  }

  function headPart(geo, mat, tag) {
    const m = new THREE.Mesh(geo, mat);
    Object.assign(m.userData, tag);
    m.frustumCulled = false;                  // parented to a bone; its bbox is bind pose
    m.castShadow = m.receiveShadow = false;
    return m;
  }

  function actionFor(a, key) {
    if (!clips[key]) return null;
    let act = a.acts[key];
    if (!act) act = a.acts[key] = a.mixer.clipAction(clips[key]);
    return act;
  }

  function upgrade(a) {
    const p = a.p, b = a.build;
    const rigKey = b.female && templates.rigFemale ? 'rigFemale' : 'rig';
    // SkeletonUtils.clone: a plain .clone() shares the skeleton and everyone
    // animates identically. The rig has TWO skinned meshes; clone handles both.
    const root = skeletonClone(templates[rigKey]);
    /* Root scale scales the posed result, so the shared `desk` layer's 0.75 target
       lands at 0.75 * hy and a short person's hands rest ~7 cm under the desk.
       Accepted, deliberately: per-person would mean 40 clips, and the desk occludes
       it at this camera. Do not "fix" it by dropping the height spread. */
    root.scale.set(b.hw, b.hy, b.hw);
    dress(a, root, rigKey);
    // kept so paint() never tints a tinted material
    root.traverse(ch => { if (ch.isMesh) ch.userData.srcMat = ch.material; });
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
    a.dressed = false; a.cover = null; a.face = null; a.expr = '';
    a.lod = 'cheap';
  }

  function setClip(a, key, fade) {
    let want = key;
    // a variant the rig does not carry falls back to the default clip
    const v = o.variants && a.build.variant[key];
    if (v && clips[key + v]) want = key + v;
    const next = actionFor(a, want) || actionFor(a, 'idle');
    if (!next) return;
    if (a.shot) { a.shot.fadeOut(fade || o.gestureFade); a.shot = null; }
    if (next === a.base) { a.baseKey = key; return; }
    next.enabled = true;
    next.setLoop(PINGPONG.has(key) ? THREE.LoopPingPong : THREE.LoopRepeat, Infinity);
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
      /* One additive slot. Two layers rotating the same head at once — a nod on a
         prompt landing over a lookup — is the twitch that reads as a dance, and the
         finished listener only ever re-arms the one it is holding. */
      if (a.addShot && a.addShot !== act) a.addShot.stop();
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
    let nCheap = 0, nAll = 0, nHead = 0, nLeg = 0;
    ensureCap(list.length * 2);          // a stand-in can draw two heads and two legs

    for (const p of list) {
      let a = avatars.get(p.key);
      if (!a) { a = makeAvatar(p); avatars.set(p.key, a); }
      a.p = p;

      const want = wantFull.has(p.key) ? 'full' : 'cheap';
      if (want === 'full' && (a.lod !== 'full' || a.gen !== gen)) {
        if (a.lod === 'full') downgrade(a);
        upgrade(a);
      } else if (want === 'cheap' && a.lod !== 'cheap') downgrade(a);

      /* ground speed, measured not nominal: the slow-down into a waypoint changes it
         and the feet have to follow the floor, not p.speed.

         Gated on actually walking, and that gate is the fix for the wobble that read
         as dancing. sim.js's personal-space shove moves p.x/p.y of EVERY person in a
         room, seated ones included, by up to .03 a frame — twice a walk step at the
         current 1.06-1.49 tiles/s. Ungated, the yaw below aimed down that shove, so a
         person at a desk spun to face whoever was next to them and slerped back, every
         frame, for as long as they sat there. */
      const moving = p.state === 'walk' || p.state === 'leaving';
      const dx = p.x - a.px, dz = p.y - a.pz, d = Math.hypot(dx, dz);
      const teleport = d > 1.5 || ff;
      if (dt > 0) {
        a.ground += ((teleport || !moving ? 0 : d / dt) - a.ground) * Math.min(1, dt * 8);
      }
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
      const yaw = (moving && !teleport && d > 0.004
        ? Math.atan2(dx, dz) : FACE_YAW[p.face] || 0) + yaw0;
      turnTo(a.q, yaw, o.turnRate, dt, ff);
      const seated = p.state === 'type';
      const isIdle = clock - p.last > idleAfter;
      const back = backOf(p, focus, q, personText);

      /* Settle into the chair (see o.sitFwd). Eased, not applied on the state change,
         so sitting down and standing up slide rather than snap — the cheap half of
         sitting_enter / sitting_exit. Snapped while the sim teleports people. */
      const fwd = FACE_FWD[p.face] || FACE_FWD[2];
      const sitTo = seated ? o.sitFwd : 0;
      a.sitOff = ff ? sitTo : a.sitOff + (sitTo - a.sitOff) * Math.min(1, dt * 6);
      const ox = p.x + fwd[0] * a.sitOff, oz = p.y + fwd[1] * a.sitOff;

      /* Occasional micro-behaviour, so a desk is not one pose for ten minutes: a
         glance, a nod, a head shake, a scratch. The beat comes off p.h and the sim
         clock, so a replay reproduces it, and seven beats in eight are nothing —
         somebody who fidgets every few seconds reads worse than somebody sitting
         still. Full rigs only: a 0.1 rad pitch on a capsule is a wobble, not a glance,
         and it would put a wall-clock into the instanced buffers D3 compares. */
      if (o.fidget && !ff && !g && a.lod === 'full' && !a.shot && !a.addShot &&
          p.state !== 'leaving') {
        const beat = Math.floor((clock + (a.h % 4096) * 0.017) / o.fidget);
        if (beat !== a.beat) {
          const r = mixHash((a.h ^ Math.imul(beat, 0x85ebca6b)) >>> 0);
          if (a.beat !== null && (r >>> 29) === 0) fireGesture(a, FIDGET[(r >>> 25) & 3], false);
          a.beat = beat;
        }
      }

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
        /* Expression follows the state: brows down at a desk or a cabinet, up and a
           mouth open in a meeting, neutral otherwise. A geometry swap, not a rebuild. */
        if (a.face) {
          const want = exprOf(p.state);
          if (want !== a.expr) {
            const g = faceGeometry(a.rigKey, want);
            if (g) { a.face.geometry = g; a.expr = want; }
          }
        }
        if (a.hue !== p.hue || a.idle !== isIdle || a.back !== back) {
          paint(a, p, isIdle, back);
          a.hue = p.hue; a.idle = isIdle; a.back = back;
        }
        a.root.position.set(ox, 0, oz);
        a.root.quaternion.copy(a.q);
        if (pitch) a.root.rotateX(pitch);
        // mixers are meaningless while the sim teleports people: freeze the pose
        if (!ff && dt > 0) a.mixer.update(dt);
      } else {
        const i = nCheap++;
        const pose = seated ? POSE.sit : POSE.stand;
        const bob = p.state === 'walk' ? Math.abs(Math.sin(p.phase)) * 0.06
          : Math.sin(p.bob) * 0.018;
        const lift = ff ? 0 : bob;
        const pal = palOf(a, p, isIdle);
        /* Same build and same palette the rig would use, so nothing about a person
           changes when they cross the LOD line: bare legs under a skirt exactly where
           the rig hides its trouser range, the hem band over the same span, a dress in
           the top's tone, and hair as a second head sphere set back over the crown —
           which at 26.5 degrees of elevation is most of what a head is. */
        const b = a.build;
        const vol = HAIR_VOL[b.hair] || 1;
        putPart(legs, nLeg++, b.skirt ? pal.skin : pal.trouser, ox, oz, a,
          pose.legY, pose.legS, lift, pitch, back);
        if (b.skirt) {
          putPart(legs, nLeg++, b.dress ? pal.shirt : pal.trouser, ox, oz, a,
            pose.hemY, pose.hemS, lift, pitch, back, 1.45, true);
        }
        putPart(bodies, i, pal.shirt, ox, oz, a, pose.torsoY, pose.torsoS, lift, pitch, back);
        putPart(heads, nHead++, pal.skin, ox, oz, a, pose.headY, 1, lift, pitch, back);
        if (o.hair && vol >= 1.05) {
          putPart(heads, nHead++, pal.hair, ox - fwd[0] * 0.022, oz - fwd[1] * 0.022, a,
            pose.headY + 0.022, vol, lift, pitch, back, vol);
        }
      }

      scratch.position.set(ox, 0.02, oz);
      scratch.quaternion.identity();
      scratch.scale.setScalar((seated ? 0.8 : 1) * a.build.hw);
      scratch.updateMatrix();
      blobs.setMatrixAt(nAll++, scratch.matrix);
    }

    bodies.count = nCheap;
    legs.count = nLeg;
    heads.count = nHead;
    blobs.count = nAll;
    for (const m of [bodies, legs, heads, blobs]) {
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
    for (const m of [bodies, legs, heads, blobs]) if (m) { group.remove(m); m.dispose(); }
    bodies = legs = heads = blobs = null; cap = 0;
    for (const g of [geoBody, geoLegs, geoHead, geoBlob]) g.dispose();
    matCheap.dispose(); matBlob.dispose();
    matHair.dispose(); matCloth.dispose(); matFace.dispose(); matHidden.dispose();
    for (const m of tints.values()) m.dispose();
    tints.clear();
    // hair and outfit geometry are shared by every person wearing them, so they are
    // freed here and never in downgrade()
    for (const g of hairGeo.values()) if (g) g.dispose();          // clones and merges
    for (const out of outfits.values()) if (out) out.geometry.dispose();
    hairGeo.clear(); outfits.clear();
    /* Only what we loaded. load(pre) hands over a scene the caller parsed and may still
       be drawing — disposing it left them with a black rig on the next toggle. */
    if (owned) {
      for (const k in hairSrc) hairSrc[k].dispose();
      for (const t of [templates.rig, templates.rigFemale]) {
        if (!t) continue;
        t.traverse(c => {
          if (!c.isMesh) return;
          c.geometry.dispose();
          for (const m of [].concat(c.material)) if (m) m.dispose();
        });
      }
    }
    for (const k in hairSrc) delete hairSrc[k];
    hairFit = null; owned = false;
    template = templates.rig = templates.rigFemale = null;
    Garm = null; clips = {};
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

  // sim.js's 1.06-1.49 tiles/s against a 0.975 u/s clip; ~1.6x is where a walk cycle
  // stops reading as walking
  ok(walkScale(0.975, 0.975) === 1, 'the reference speed plays at 1x');
  // the boss's own band (0.86-0.99) sits strictly below everyone else's (1.06-1.49)
  for (const [v, lo, hi] of [[0.86, 0.85, 1.0], [1.06, 1.05, 1.15], [1.49, 1.45, 1.6]]) {
    const r = walkScale(v, 0.975);
    ok(r > lo && r < hi, 'ground ' + v + ' should play at ' + lo + '-' + hi + 'x, got ' + r);
  }
  ok(walkScale(2.39, 0.975) > 2.4, 'the old 2.39 tiles/s really was 2.45x — the thing we left');
  ok(walkScale(0, 0.975) === 0.35 && walkScale(99, 0.975) === 2.6, 'clamped both ends');

  // sim.js-shaped hashes, whose high bits barely move between siblings — the case
  // buildOf has to mix before it slices
  const O = { height: [0.885, 0.995], width: [0.97, 1.03], bossScale: 1.06, variants: true };
  const sib = i => { let x = 0; for (const c of 's1|a' + i) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x; };
  const builds = [], hs = [], widths = [], idles = new Set(), walks = new Set();
  for (let i = 0; i < 24; i++) {
    const bd = buildOf(sib(i), false, O);
    builds.push(bd); hs.push(bd.hy.toFixed(4)); widths.push((bd.hw / bd.hy).toFixed(4));
    idles.add(bd.variant.idle); walks.add(bd.variant.walk);
    ok(bd.hy >= 0.885 - 1e-9 && bd.hy <= 0.995 + 1e-9, 'height out of range: ' + bd.hy);
    const rel = bd.hw / bd.hy;
    ok(rel >= 0.97 - 1e-9 && rel <= 1.03 + 1e-9, 'width out of range: ' + rel);
  }
  ok(JSON.stringify(buildOf(sib(3), false, O)) === JSON.stringify(builds[3]),
    'buildOf must be a pure function of p.h — a scrub has to rebuild the same floor');
  ok(new Set(hs).size >= 6, 'only ' + new Set(hs).size + ' heights across 24 siblings — ' +
    'the hash slice is unmixed again, which dressed a whole room as one body');
  ok(new Set(widths).size >= 3, 'widths barely move: ' + new Set(widths).size);
  ok(idles.size === 3 && walks.size === 2, 'siblings do not cover every clip variant: ' +
    [...idles].join() + ' / ' + [...walks].join());

  const boss = buildOf(sib(3), true, O);
  ok(boss.hy > builds[3].hy && boss.hw / boss.hy > builds[3].hw / builds[3].hy,
    'the boss must be taller AND broader than the same person would be');
  ok(boss.variant.idle === '2' && boss.variant.walk === '',
    'a boss folds his arms and takes the composed walk, whatever his hash says');

  ok(regionOfBone('Head') === R_SKIN && regionOfBone('hand_r') === R_SKIN,
    'head and hands are skin');
  ok(regionOfBone('thigh_l') === R_TROUSER && regionOfBone('pelvis') === R_TROUSER,
    'hips and thighs are trousers');
  ok(regionOfBone('upperarm_l') === R_SHIRT && regionOfBone('spine_02') === R_SHIRT,
    'arms and spine are shirt');
  /* The forearm has to be SHIRT, not skin: the sleeve of garments.js's topLong reaches
     wristX - 0.02, so it is what R_SHIRT being droppable depends on. */
  ok(regionOfBone('lowerarm_l') === R_SHIRT, 'the forearm is under a long sleeve');
  ok(regionOfBone('ball_leaf_r') === R_SHIN, 'a leaf bone follows its chain');
  /* Shins are their OWN range, because no garment covers them: trousers stop at
     ankleY + 0.03 and a skirt at the knee. Fold them back into R_TROUSER and a
     hidden trouser range takes a bare leg with it. */
  ok(regionOfBone('calf_l') === R_SHIN && regionOfBone('foot_r') === R_SHIN,
    'calves and feet are the shin range');
  ok(new Set([R_SKIN, R_SHIRT, R_TROUSER, R_SHIN]).size === R_N, 'the regions are distinct');

  /* Who wears what. Every choice is a slice of p.h, so this is the whole floor's
     wardrobe in one loop — and the one thing that must hold is that it VARIES. */
  const F = { female: 0, hair: new Set(), beard: 0, skirt: 0, dress: 0, outfit: new Set() };
  for (let i = 0; i < 600; i++) {
    const bd = buildOf(Math.imul(i + 1, 2246822519) >>> 0, false, O);
    if (bd.female) F.female++;
    if (bd.beard) F.beard++;
    if (bd.skirt) F.skirt++;
    if (bd.dress) F.dress++;
    F.hair.add(bd.hair);
    F.outfit.add(bd.outfit.join('+') + (bd.dress ? '/one tone' : ''));
    ok(!bd.beard || !bd.female, 'a beard was dealt to a woman');
    ok(bd.skirt === (bd.dress || bd.outfit.includes('skirt')), 'build.skirt disagrees with the outfit');
    ok(bd.outfit.length >= 2, 'an outfit of ' + bd.outfit.length + ' garment leaves skin showing');
    ok((bd.female ? HAIR_F : HAIR_M).includes(bd.hair),
      bd.hair + ' is not a style ' + (bd.female ? 'she' : 'he') + ' can be dealt');
  }
  ok(F.female > 240 && F.female < 360, F.female + '/600 women — "boy and girl" needs both halves');
  ok(F.hair.size === 5, 'only ' + [...F.hair].join('/') + ' ever reaches the floor');
  ok(F.beard > 30, 'only ' + F.beard + ' beards in 600 people');
  ok(F.skirt > 60 && F.dress > 30,
    F.skirt + ' skirts and ' + F.dress + ' dresses in 600 — the user asked for both by name');
  ok(F.outfit.size === 3, 'outfits: ' + [...F.outfit].join(', '));
  ok(JSON.stringify(buildOf(7, false, O)) === JSON.stringify(buildOf(7, false, O)),
    'the wardrobe must be a pure function of p.h too');
  const bossFit = new Set();
  for (let i = 0; i < 200; i++)
    bossFit.add(buildOf(Math.imul(i + 1, 2246822519) >>> 0, true, O).outfit.join('+'));
  ok(bossFit.size === 1 && [...bossFit][0] === 'topLong+trousers+jacket',
    'the boss must always wear the jacket: ' + [...bossFit].join(' / '));

  /* sitFwd's window. Body extents measured off the skinned seated rig; the rest are
     props.js's chair and desk and step()'s shove, i.e. other people's files — so this
     is what notices if the furniture moves. */
  const SEAT = { rear: -0.400, front: 0.369, backRear: -0.30, backFace: -0.20,
                 pedestal: 0.66, shove: 0.13 };
  const so = DEFAULTS.sitFwd;
  ok(SEAT.rear + so > SEAT.backRear,
    'sitFwd ' + so + ' leaves the lower back out the far side of the chair — the bug');
  ok(SEAT.rear + so < SEAT.backFace,
    'sitFwd ' + so + ' lifts the back clear of the cushion; it should rest against it');
  ok(SEAT.front + so + SEAT.shove < SEAT.pedestal,
    'sitFwd ' + so + ' puts a foot inside the desk when somebody walks past');
  ok(SEAT.rear + so > -0.26 - 0.10,
    'sitFwd ' + so + ' still hangs the buttocks off the back of a seat pad ending at -0.26');
  /* That margin is also the entire budget for a chair that is not exactly on its tile:
     props.js jitters team chairs, and its slide ALONG the facing has to stay under this
     or the back pokes out again. Yaw and sideways slide are free. */
  ok(SEAT.rear + so - SEAT.backRear > 0.03,
    'under 30mm behind the cushion — no room left for a chair that has been nudged');
  ok(FACE_FWD[0][1] === -1 && FACE_FWD[2][1] === 1 &&
     FACE_FWD[1][0] === 1 && FACE_FWD[3][0] === -1,
    'the settle must push the way the contract says N/E/S/W point');

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
