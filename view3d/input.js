/* input.js — hover and click for the 3D view.

   The 2D canvas has had a docked hover card and click-to-enter-a-room since the
   start; this gives the 3D view the same ones. It deliberately reuses office.js's
   tipFor / tipForAmenity / focusRoom rather than re-deriving any of it, so the two
   views can never disagree about what a room or a person says. Those are top-level
   function declarations in a classic script, so they are on globalThis.

   Hit-testing is two different jobs. Rooms and facilities are flat, so one
   ray/ground-plane intersection gives the tile under the cursor and the rest is a
   rectangle test — no mesh raycasting needed. People are 1.8 units tall, so a
   ground hit under the cursor is not where they are standing when you point at
   someone's head; they are projected to the screen instead and tested there, the
   same way office.js does it. */
import * as THREE from '../vendor/three.module.js';

const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const DRAG = 6;             // px of movement that turns a click into a pan

const inAm = (a, x, y) =>
  x >= a.gx && x <= a.gx + a.w && y >= a.gy && y <= a.gy + a.h;

export function attach(canvas, getCamera) {
  const tip = document.getElementById('tip');
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const hit = new THREE.Vector3();
  const proj = new THREE.Vector3();
  let down = null;

  const st = () => globalThis.Sim && globalThis.Sim.St;
  const fl = () => globalThis.Floor && globalThis.Floor.state;

  const local = ev => {
    const r = canvas.getBoundingClientRect();
    return { mx: ev.clientX - r.left, my: ev.clientY - r.top, w: r.width, h: r.height };
  };

  /* pointer -> tile, via the floor plane at y = 0 */
  function tileAt(ev) {
    const cam = getCamera();
    if (!cam) return null;
    const { mx, my, w, h } = local(ev);
    ndc.set((mx / w) * 2 - 1, -(my / h) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    return ray.ray.intersectPlane(GROUND, hit) ? { x: hit.x, y: hit.z } : null;
  }

  const roomAt = t => {
    const F = fl();
    if (!F || !t) return null;
    for (const r of Object.values(F.rooms))
      if (t.x >= r.gx && t.x <= r.gx + r.w && t.y >= r.gy && t.y <= r.gy + r.h) return r;
    return null;
  };
  const amenityAt = t => {
    const F = fl();
    if (!F || !t) return null;
    for (const a of F.amenities || []) if (inAm(a, t.x, t.y)) return a;
    return null;
  };

  /* Projected to the screen rather than picked off the ground: pointing at a head
     is a ground hit a tile or two behind where that person is actually standing. */
  function personAt(ev) {
    const S = st(), cam = getCamera();
    if (!S || !cam) return null;
    const { mx, my, w, h } = local(ev);
    const Sim = globalThis.Sim;
    let best = null, bestZ = -1e9;
    for (const k in S.people) {
      const p = S.people[k];
      const inBand = !!(p.fac || p.cowork);
      if (S.focus && S.focus !== p.room && !inBand) continue;
      if (Sim.roomHit && !Sim.roomHit(p.room) && !inBand) continue;
      proj.set(p.x, 0.9, p.y).project(cam);
      if (proj.z > 1) continue;                       // behind the camera
      const sx = (proj.x * .5 + .5) * w, sy = (-proj.y * .5 + .5) * h;
      if (Math.abs(mx - sx) > 17 || my < sy - 34 || my > sy + 18) continue;
      const z = p.x + p.y;                            // nearer the camera wins
      if (z > bestZ) { bestZ = z; best = p; }
    }
    return best;
  }

  function hover(ev) {
    if (down && down.moved > DRAG) { tip.classList.remove('on'); return; }
    const p = personAt(ev);
    const t = p ? null : tileAt(ev);
    const r = p ? null : roomAt(t);
    const a = p || r ? null : amenityAt(t);
    if (!p && !r && !a) {
      tip.classList.remove('on');
      canvas.style.cursor = 'default';
      return;
    }
    // a facility never opens a panel, so it must not advertise itself as clickable
    canvas.style.cursor = a ? 'default' : 'pointer';
    const key = p ? p.key : r ? 'room:' + r.sid : 'am:' + a.kind;
    if (tip.dataset.key !== key) {
      tip.dataset.key = key;
      tip.innerHTML = a ? globalThis.tipForAmenity(a) : globalThis.tipFor(p, r);
    }
    tip.classList.add('on');
  }

  canvas.addEventListener('mousemove', hover);
  canvas.addEventListener('mouseleave', () => tip.classList.remove('on'));

  canvas.addEventListener('pointerdown', ev => {
    down = { x: ev.clientX, y: ev.clientY, moved: 0 };
    tip.classList.remove('on');
  });
  addEventListener('pointermove', ev => {
    if (!down) return;
    down.moved += Math.abs(ev.clientX - down.x) + Math.abs(ev.clientY - down.y);
    down.x = ev.clientX; down.y = ev.clientY;         // accumulate, like the 2D pan
  });
  addEventListener('pointerup', ev => {
    const d = down; down = null;
    if (!d || d.moved > DRAG) return;                 // that was a camera drag
    const t = tileAt(ev);
    const r = roomAt(t);
    // Clicking a facility does nothing. Falling through to "clicked bare floor"
    // would close the room panel you were reading, which is worse than nothing.
    if (!r && amenityAt(t)) return;
    const S = st();
    globalThis.focusRoom(r && r !== (S && S.focus) ? r : null);
  });
}
