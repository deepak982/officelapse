/* chat.js — the talking layer.
   Speech bubbles are real DOM nodes over the canvas (so they can be hovered,
   frozen and pinned) and every line is also kept in a per-room chat log.
   Dwell is WALL-CLOCK, never simulation time, so bubbles stay readable at 1800x. */
(function (root) {
'use strict';

const DWELL = 4.2;        // seconds of real time a bubble stays up
const MAX_LIFT = 96;      // px a bubble may be pushed above its speaker
const LOG_MAX = 200;      // messages kept per room

const C = {
  layer: null, log: null, jump: null,
  bubbles: new Map(),     // person key -> {el, until, pinned, hover}
  logs: new Map(),        // sid -> {msgs: [], ver: 0}
  shownSid: null, shownVer: -1, follow: true,
};

const esc = s => String(s).replace(/[<>&"]/g, c =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function init(layerEl, logEl, jumpEl) {
  C.layer = layerEl; C.log = logEl; C.jump = jumpEl;
  C.log.addEventListener('scroll', () => {
    const nearBottom = C.log.scrollHeight - C.log.scrollTop - C.log.clientHeight < 40;
    C.follow = nearBottom;
    C.jump.classList.toggle('show', !nearBottom);
  });
  C.jump.addEventListener('click', () => {
    C.follow = true; C.jump.classList.remove('show');
    C.log.scrollTop = C.log.scrollHeight;
  });
}

/* a person said something */
function say(p, text, isTask, wallNow, simNow, showBubble) {
  if (!text) return;
  logLine(p, text, isTask, simNow);
  if (!showBubble) return;
  let b = C.bubbles.get(p.key);
  if (!b) {
    const el = document.createElement('div');
    el.className = 'bub';
    el.addEventListener('mouseenter', () => { b.hover = true; });
    el.addEventListener('mouseleave', () => { b.hover = false; });
    el.addEventListener('click', e => { e.stopPropagation(); b.pinned = !b.pinned; el.classList.toggle('pin', b.pinned); });
    C.layer.appendChild(el);
    b = { el, until: 0, pinned: false, hover: false };
    C.bubbles.set(p.key, b);
  }
  if (b.text !== text) {
    b.el.innerHTML = `<i>${esc(p.boss ? 'BOSS' : (p.display || (p.aid || '').slice(1, 6)))}</i>${esc(text)}`;
    b.text = text;
    b.el.classList.remove('in'); void b.el.offsetWidth; b.el.classList.add('in');
  }
  b.el.classList.toggle('task', !!isTask);
  b.until = wallNow + DWELL;
}

/* the log records everything, including while bubbles are suppressed */
function logLine(p, text, isTask, simNow) {
  const L = logFor(p.room.sid);
  const last = L.msgs[L.msgs.length - 1];
  if (last && last.text === text && last.key === p.key) return;
  L.msgs.push({ t: simNow, key: p.key, boss: p.boss,
                who: p.boss ? 'BOSS' : (p.display || (p.aid || '').slice(1, 7)),
                name: p.name || '', hue: p.hue, text, task: !!isTask });
  if (L.msgs.length > LOG_MAX) L.msgs.shift();
  L.ver++;
}

const logFor = sid => {
  let L = C.logs.get(sid);
  if (!L) { L = { msgs: [], ver: 0 }; C.logs.set(sid, L); }
  return L;
};

/* position every live bubble, drop the expired ones, and lift any that would
   cover another so two people talking side by side stay both readable */
function sync(people, project, wallNow, visible, showAll) {
  if (showAll === false) {            // zoomed too far out to tell who is speaking
    for (const [, b] of C.bubbles) b.el.classList.remove('on');
    return;
  }
  const live = [];
  for (const [key, b] of C.bubbles) {
    const p = people[key];
    const alive = p && visible(p) && (b.pinned || b.hover || wallNow < b.until);
    if (!alive) {
      b.el.classList.remove('on');
      if (!p) { b.el.remove(); C.bubbles.delete(key); }
      continue;
    }
    const s = project(p.x, p.y);
    if (s.off) { b.el.classList.remove('on'); continue; }
    live.push({ b, x: s.x, y0: s.y - 46, y: s.y - 46,
                w: b.el.offsetWidth || 120, h: b.el.offsetHeight || 26 });
  }
  live.sort((a, b) => a.y - b.y);                 // highest first, then push others up
  const placed = [];
  for (const it of live) {
    for (const q of placed) {
      if (Math.abs(it.x - q.x) > (it.w + q.w) / 2 + 6) continue;
      const gap = q.y - it.h - 6;                 // sit clear above the one already there
      if (it.y > gap && it.y + it.h > q.y) it.y = gap;
    }
    // never float so far up that the bubble loses its owner
    if (it.y0 - it.y > MAX_LIFT) { it.b.el.classList.remove('on'); continue; }
    placed.push(it);
    it.b.el.style.transform =
      `translate(-50%,-100%) translate(${it.x.toFixed(1)}px,${it.y.toFixed(1)}px)`;
    it.b.el.classList.add('on');
  }
}

/* the focused room's chat channel */
function renderLog(room, clockFmt) {
  if (!room) { C.shownSid = null; C.log.innerHTML = ''; return; }
  const L = logFor(room.sid);
  if (C.shownSid === room.sid && C.shownVer === L.ver) return;
  const jump = C.shownSid !== room.sid;
  C.shownSid = room.sid; C.shownVer = L.ver;
  C.log.innerHTML = L.msgs.map(m => `
    <div class="msg${m.boss ? ' boss' : ''}${m.task ? ' task' : ''}">
      <span class="av" style="background:hsl(${m.hue} 62% 52%)"></span>
      <div class="mb"><b>${esc(m.who)}<em>${clockFmt(m.t)}</em></b><p>${esc(m.text)}</p></div>
    </div>`).join('') ||
    '<div class="msg empty"><div class="mb"><p>nothing said in this room yet</p></div></div>';
  if (C.follow || jump) { C.log.scrollTop = C.log.scrollHeight; C.jump.classList.remove('show'); }
}

function clear() {
  for (const [, b] of C.bubbles) b.el.remove();
  C.bubbles.clear();
  // the logs go too: a rebuild replays the same events, and logLine only dedupes
  // against the line immediately before it, so every room would say it all twice
  C.logs.clear();
  C.shownSid = null;
  C.shownVer = -1;
}

const Chat = { init, say, sync, renderLog, clear, logFor, DWELL };

if (typeof module !== 'undefined' && module.exports) module.exports = Chat;
else root.Chat = Chat;
})(typeof globalThis !== 'undefined' ? globalThis : this);
