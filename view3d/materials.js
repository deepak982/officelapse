/* view3d/materials.js — the shared palette.
   One instance per surface for the whole floor. A material per mesh is a shader
   bind per mesh, which throws away everything the instanced prop batches in
   props.js buy back.

   Every material a merged prop batch uses has vertexColors on: prop geometry is
   merged per material (props.js mergeParts) and each part's colour is baked into
   the buffer. MAT.monitor is the one exception — it is a single quad scene.js builds
   itself, with one colour, so there is nothing to bake and nothing to multiply. The
   per-instance colour on top carries the department accent. Final colour is
   material.color * vertexColor * instanceColor, so material.color stays white
   and the baked colour wins unless a batch deliberately tints it.

   Lambert for everything matte: there is no environment map on this scene, so
   MeshStandardMaterial's metalness/roughness has nothing to reflect and reads
   flatter than Phong's plain specular highlight. Phong only where a highlight is
   the whole point — metal, glass, mirror. */

import * as THREE from '../vendor/three.module.js';

const lambert = o => new THREE.MeshLambertMaterial(Object.assign({ vertexColors: true }, o));
const phong = o => new THREE.MeshPhongMaterial(Object.assign({ vertexColors: true }, o));

export const MAT = {
  carpet: lambert({}),
  wall: lambert({}),
  wood: lambert({}),
  fabric: lambert({}),
  plastic: lambert({}),
  plant: lambert({}),
  paper: lambert({}),
  metal: phong({ shininess: 50, specular: 0x8fa2ba }),
  /* depthWrite off, so two glass panels of the same booth do not punch holes in
     each other depending on which was merged first */
  glass: phong({ shininess: 90, specular: 0xdfefff, transparent: true, opacity: .24,
                 depthWrite: false }),
  mirror: phong({ shininess: 140, specular: 0xffffff }),
  /* unlit: a screen that takes the key light stops reading as a light source */
  screen: new THREE.MeshBasicMaterial({ vertexColors: true }),
  /* The screen face of a monitor somebody is working at. Same idea as office.js,
     which repaints that one monitor to #8bd9fb and changes nothing else in the room —
     so this is opaque and unlit, not a translucent light source, and it is ordinary
     depth-tested geometry so a person in front of a lit desk still occludes it.
     Colour tracks COL.screenOn, declared below; the batch's per-instance NEUTRAL takes
     it to 88%, which is still the brightest thing on the floor by a wide margin. */
  monitor: new THREE.MeshBasicMaterial({ color: 0x8bd9fb }),
  /* The SAME face when the desk's owner is logged on but not working. A person holds a
     desk until GONE (900s) yet only counts as active for IDLE (90s), so with only two
     states a character sits at a dead black panel for 810 of those 900 seconds — which
     is exactly the "I sat down and the monitor stayed dark" report. A real screen does
     not switch itself off because somebody paused for ninety seconds.

     Deliberately a desaturated slate rather than a dim cyan: at room zoom a HUE
     difference separates at a glance where a pure value difference does not. Tracks
     COL.screenIdle below. The three states land at 11% / 38% / 77% sRGB against a 27%
     desk top, and only the active one carries a halo. */
  monitorIdle: new THREE.MeshBasicMaterial({ color: 0x4f6780 }),
  /* The halo around the ACTIVE face only, which is what makes a working desk findable at Fit
     zoom where the face itself is two pixels across. office.js carries the same pair:
     drawDesk repaints the monitor AND lays a radial bloom over the desk.

     Additive, so it can only ever ADD light — it cannot paint a character out the way
     the translucent quad of the first attempt did. The falloff is per-vertex alpha on
     a fan (see scene.js glowBuckets), not a texture, so it has no edge anywhere and
     nothing to load. Contribution is color * opacity * vertexAlpha, so opacity is the
     one knob if the halo reads too hot or too faint. */
  bloom: new THREE.MeshBasicMaterial({
    color: 0x8bd9fb, vertexColors: true, transparent: true, opacity: .4,
    depthWrite: false, blending: THREE.AdditiveBlending }),
  /* The pool of light the building stands in, so the footprint reads as sitting on
     something rather than cut out and pasted onto the void. Value lands between
     BACKDROP and GROUND — see both below. Per-vertex alpha again, so the ramp stays a
     fixed number of tiles wide whatever shape the footprint grows into. */
  pool: new THREE.MeshBasicMaterial({
    color: 0x141a2d, vertexColors: true, transparent: true, depthWrite: false }),
};

const c = hex => new THREE.Color(hex);

/* Named by role, not by hue — "COL.wood" survives a repaint, "COL.brown" does not.
   Values track office.js's 2D palette so the two views read as one product.

   These are ALBEDO, and scene.js's lights are exposed so an up-facing surface in a
   team room renders at very close to its own value here (deptColor .74 x light 1.45
   ~= 1.07). That is the point of the exposure: a value written here can be compared
   straight against office.js's shade(h, s, l), and the ladder below is that view's —
   floor 20%, desk top 27%, wall 27/32%, wall cap 40%, all in sRGB lightness. */
export const COL = {
  carpet:      c('#2a3044'),
  /* Checker offset. Stronger than office.js's +1.8 L on purpose: 2D also strokes
     every tile rgba(255,255,255,.025), and a 3D floor has no such outline, so the
     fill step is the only thing left carrying tile scale. */
  carpetAlt:   c('#343b55'),
  carpetBoss:  c('#38344e'),
  carpetBreak: c('#33404a'),
  carpetAisle: c('#3a4258'),
  carpetFac:   c('#343a4c'),
  /* A wall's two visible faces fall to .70 and .50 of an up-face, so wall albedo has
     to clear the carpet by more than office.js's does (it gets the junction for free
     off the isometric silhouette; here it is value or nothing) */
  wall:        c('#545c78'),
  wallTop:     c('#5a6280'),
  doorFrame:   c('#7c8bb0'),
  desk:        c('#3b4259'),
  deskEdge:    c('#2f3549'),
  wood:        c('#6d6250'),
  woodDark:    c('#4a3d30'),
  fabric:      c('#414a66'),
  fabricBack:  c('#4a5578'),
  plastic:     c('#464f68'),
  plasticPale: c('#d8dee9'),
  metal:       c('#7e8798'),
  metalDark:   c('#49526c'),
  dark:        c('#1b1f29'),
  glass:       c('#78a5cd'),
  water:       c('#63b6d8'),
  leaf:        c('#3f7d4f'),
  leafDeep:    c('#2f6440'),
  pot:         c('#5b4636'),
  white:       c('#e8edf5'),
  ink:         c('#9aa4b8'),
  /* the three states of a monitor: nobody holds the desk, its owner is logged on but
     paused, its owner is working. screenOff is baked into the shell by props.js; the
     other two are scene.js quads over the top of it — see MAT.monitor / monitorIdle,
     which hold these same two values, because MAT is declared before COL. */
  screenOff:   c('#1c2130'),
  screenIdle:  c('#4f6780'),
  screenOn:    c('#8bd9fb'),
  led:         c('#7fe08a'),
  accent:      c('#7dd3fc'),
  /* the picture palette: office.js's five, plus four more because floor.js now
     numbers its art 0..8 and a modulo would hang the same picture twice */
  art: [[c('#e07a5f'), c('#3d405b')], [c('#81b29a'), c('#2b3a55')],
        [c('#e8b04b'), c('#5b3a52')], [c('#6b9fd4'), c('#33405e')],
        [c('#c76b8e'), c('#3a3350')], [c('#7f9ec4'), c('#2c3448')],
        [c('#d99a6c'), c('#433248')], [c('#6cc2b0'), c('#283a44')],
        [c('#b8a0d8'), c('#332c4a')]],
};

/* Per-department accent, kept desaturated: it multiplies into EVERY baked colour
   of a room-shell instance, so a saturated tint would turn the whole room that
   colour instead of nudging it. Cached — deptColor is called once per room, but
   a new Color per call would still leak into the focus recolour path.

   Lightness .74, not .60: this is a multiplier, so every point below 1 is light
   thrown away on all 30-odd rooms at once. HSL chroma collapses as l climbs, so the
   saturation goes up with it to hold the same hue strength (C/l ~= .36 either way) —
   a department must still be recognisable by colour. */
const deptCache = new Map();
export function deptColor(hue) {
  let col = deptCache.get(hue);
  if (!col) deptCache.set(hue, col = new THREE.Color().setHSL(hue / 360, .48, .74));
  return col;
}

/* The band's answer to deptColor. A facility is not a department, so a department
   hue would be a lie, and eleven identically grey facilities is the reason room
   interiors read as one mass. Hues are office.js's AM_TINT verbatim — warm where
   people eat and rest, cool and desaturated where they work or the machines live —
   which is also what separates the whole band from the team rooms below it. */
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

const amCache = new Map();
export function amColor(kind) {
  let col = amCache.get(kind);
  if (!col) {
    /* an unknown kind is a plain grey box, never a crash: floor.js may add a twelfth */
    const t = AM_TINT[kind] || { h: 220, s: 8 };
    amCache.set(kind, col = new THREE.Color()
      .setHSL(t.h / 360, Math.min(.62, t.s * 1.6 / 100), .74));
  }
  return col;
}

/* A room the camera is not focused on. Same instanced batch, just a darker tint —
   the 2D view drops it to alpha .1, which instancing cannot do per instance. */
export const DIM = new THREE.Color(0.16, 0.17, 0.22);
/* .88, not 1: leaves headroom so COL.white on a prop lands just under clipping at
   the current exposure instead of burning out into a white blob */
export const NEUTRAL = new THREE.Color(0.88, 0.89, 0.93);

/* Plate materials are not part of a merged batch, so they carry their own colour
   and want no vertexColors. One per hue, shared.

   setHSL writes into the working colour space, which is LINEAR — so the plain
   three-arg form treats .13 as a linear value and lands at sRGB 40%, nowhere near
   office.js's shade(hue, 40, 13). That made the plate LIGHTER than the rooms
   standing on it. The explicit SRGBColorSpace is what makes the two match. */
const plateCache = new Map();
export function plateMaterial(hue) {
  let m = plateCache.get(hue);
  if (!m) {
    m = new THREE.MeshLambertMaterial({
      color: new THREE.Color().setHSL(hue / 360, .40, .13, THREE.SRGBColorSpace),
    });
    plateCache.set(hue, m);
  }
  return m;
}

/* The base slab under the building: dark enough to sit clearly below a room carpet
   (12% against 20%) but clearly above the renderer's void (5%), so its edge reads as
   the building's footprint rather than as a hole. scene.js sizes it to what is
   actually occupied — an oversized slab is a dead grey field, whatever its colour. */
export const GROUND = new THREE.MeshLambertMaterial({ color: 0x151823 });
/* Circulation, and the one thing tying the band to the team rooms — so it is the
   LIGHTEST floor on screen (28%), not another mid-grey lost against the carpet. */
export const CORRIDOR = new THREE.MeshLambertMaterial({ color: 0x333a4e });

/* The frame behind everything, painted by scene.js into a gradient the whole backdrop
   quad wears. These are literal sRGB: the backdrop is unlit, so what is written here
   is what appears.

   The values are the page's own chrome, which is the point — the canvas should not
   look like a black hole cut into the UI. `edge` IS the body background, so the frame
   edges dissolve into the page; `mid` IS the header and footer. `top` is the only
   invented value, a hair above the header and a touch cooler, so the frame lifts
   behind the building instead of reading as one flat wash.

   The whole ramp sits below GROUND's 12%, which keeps the value ladder the floor
   depends on: backdrop 5-10%, pool 11%, ground plate 12%, carpet 20%, corridor 28%. */
export const BACKDROP = {
  top: '#121825',       // 9.3%, the lift up-screen — which is also the far distance
  mid: '#101420',       // the page header and footer, 8.0%
  edge: '#0b0d13',      // the page body, 5.1% — also the renderer's clear colour
};

export function dispose() {
  for (const k in MAT) MAT[k].dispose();
  for (const m of plateCache.values()) m.dispose();
  plateCache.clear();
  deptCache.clear();
  amCache.clear();
  GROUND.dispose();
  CORRIDOR.dispose();
}
