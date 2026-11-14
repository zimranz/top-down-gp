/* On-screen controls for phones and tablets.
   Left thumb: slide left and right to steer, starting from wherever the thumb lands. Right thumb: the brake and
   accelerator pedals; the DRS button sits on top of the accelerator, so the thumb can slide up onto it without
   lifting. Two small buttons beside the minimap: pause, and put the car back on track.
   What the thumbs are doing goes into Input.touch, which Input.sample() reads. The page switches to these controls
   at the first touch, and back to the keyboard when a driving key is pressed. */
(function () {
  'use strict';
  const F1 = window.F1, Input = window.Input, Settings = window.Settings;
  const T = Input.touch;
  const $ = function (id) { return document.getElementById(id); };

  /* How far the thumb slides (pixels) for full steering, by the touch sensitivity setting: 1 = long slide, 10 = short. */
  const TRAVEL = [125, 112, 100, 89, 79, 70, 62, 55, 49, 43];
  const DEAD = 4;          // the first pixels do nothing, so a resting thumb keeps the car straight
  const CURVE = 1.25;      // a little finer around the middle
  const KNOB = 52;

  let root = null, els = null;
  const cb = {};
  let wanted = false;            // a session is on screen (no menu, no pause)
  let portrait = false;          // a phone held upright while driving: the "turn your phone" notice is up
  const steers = {};             // fingers on the left half: touch id -> { x0, tL, tR, u } (the one slid furthest steers)
  const pedals = {};             // fingers on the right half: touch id -> { x, y, gas }
  let drsShown = '', stuckShown = false, labelGone = false;

  const api = {
    L: null,                     // layout of the controls (also read by the renderer); null in keyboard mode
    travel: function () { return TRAVEL[F1.clamp(Math.round(Number(Settings.data.touchSteer)) || 5, 1, 10) - 1]; }
  };

  /* Where everything goes, for this screen size. Phones get smaller parts; on tablets the controls sit a little
     higher, where the thumbs are when you hold one by its sides. */
  function layout() {
    const W = window.innerWidth, H = window.innerHeight;
    const phone = H < 520 || W < 700;
    const o = { W: W, H: H, phone: phone };
    o.bottom = phone ? 10 : F1.clamp(Math.round((H - 420) * 0.22), 14, 110);
    const gasW = phone ? 92 : 108, gasH = phone ? F1.clamp(Math.round(H * 0.36), 100, 132) : 150;
    const brakeW = phone ? 84 : 98, brakeH = Math.round(gasH * 0.82), drsH = phone ? 36 : 44;
    o.gas = { x: W - 14 - gasW, y: H - o.bottom - gasH, w: gasW, h: gasH };
    o.brake = { x: o.gas.x - 10 - brakeW, y: H - o.bottom - brakeH, w: brakeW, h: brakeH };
    o.drs = { x: o.gas.x, y: o.gas.y - 8 - drsH, w: gasW, h: drsH };
    o.divX = o.gas.x - 5;                      // left of this line a finger brakes, right of it it accelerates
    o.side = W - o.brake.x;                    // width of the pedal block, from the right edge
    // top right: the minimap, with pause and "back on track" beside it
    o.mini = phone ? F1.clamp(Math.round(H * 0.27), 76, 112) : W < 820 ? 130 : 200;
    o.btn = phone ? 40 : 48;
    const bx = W - 12 - o.mini - 8 - o.btn;
    o.pause = { x: bx, y: 12, w: o.btn, h: o.btn };
    o.reset = { x: bx, y: 12 + o.btn + 6, w: o.btn, h: o.btn };
    // dashboard: the usual one when it fits between the thumbs, else a slim one
    const room = W - 2 * (o.side + 10);
    o.dash = !phone && room >= 560 ? 'full' : !phone && room >= 400 ? 'compact' : 'slim';
    o.dashW = F1.clamp(room, 220, 400);
    o.dashH = o.dash === 'full' ? 96 : o.dash === 'compact' ? 84 : 56;
    // the steering guide: where it rests, and how far its knob moves on screen
    o.travel = api.travel();
    o.vis = Math.min(o.travel, phone ? 62 : 90);
    o.gx = Math.max(o.vis + KNOB / 2 + 14, Math.round(W * 0.17));
    o.gy = H - o.bottom - Math.round(phone ? gasH * 0.5 : 86);
    return o;
  }

  function put(el, r) {
    el.style.left = r.x + 'px'; el.style.top = r.y + 'px'; el.style.width = r.w + 'px'; el.style.height = r.h + 'px';
  }
  function hit(r, x, y, pad) { return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad; }
  function knob(u) { els.knob.style.transform = 'translate(' + (u * api.L.vis).toFixed(1) + 'px, 0)'; }

  /* Lift every finger: nothing pressed, steering straight. */
  function release() {
    for (const id in pedals) delete pedals[id];
    for (const id in steers) delete steers[id];
    T.held = false; T.steer = 0; T.throttle = 0; T.brake = 0; T.drs = false; T.drsTap = false;
    if (!els) return;
    els.gas.classList.remove('on'); els.brake.classList.remove('on'); els.drs.classList.remove('press'); els.steer.classList.remove('on');
    els.knob.style.transform = '';
  }

  /* Show or hide the controls and lay them out again (screen turned, mode changed, setting changed). */
  function refresh() {
    if (!root) return;
    api.L = T.active ? layout() : null;
    const on = wanted && T.active;
    const port = on && api.L.H > api.L.W && api.L.W < 600;
    root.classList.toggle('hidden', !on || port);
    $('rotate').classList.toggle('hidden', !port);
    if (!on || port) release();
    if (api.L) {
      const L = api.L, half = L.vis + KNOB / 2;
      put(els.gas, L.gas); put(els.brake, L.brake); put(els.drs, L.drs); put(els.pause, L.pause); put(els.reset, L.reset);
      put(els.steer, { x: L.gx - half, y: L.gy - 28, w: half * 2, h: 56 });
      root.classList.toggle('phone', L.phone);
    }
    if (port !== portrait) { portrait = port; if (cb.rotate) cb.rotate(port); }
  }

  function setMode(on) {
    if (T.active === on) return;
    T.active = on;
    document.body.classList.toggle('touch', on);
    if (!on) release();
    refresh();
    if (cb.mode) cb.mode(on);
  }

  // ------------------------------------------------------------- fingers
  function pedalState() {
    let gas = 0, brake = 0, drs = false;
    for (const id in pedals) {
      const p = pedals[id];
      if (p.gas) { gas = 1; if (hit(api.L.drs, p.x, p.y, 6)) drs = true; } else brake = 1;
    }
    if (drs && !T.drs) T.drsTap = true;        // even the shortest tap opens DRS
    T.throttle = gas; T.brake = brake; T.drs = drs;
    els.gas.classList.toggle('on', !!gas); els.brake.classList.toggle('on', !!brake); els.drs.classList.toggle('press', drs);
  }
  /* The steering is whatever the finger that has slid furthest says. (Normally there is one thumb; a palm or a second
     finger resting on the left half does not move, so it changes nothing.) */
  function steerState() {
    let best = 0, shown = 0, any = false;
    for (const id in steers) {
      const f = steers[id];
      any = true;
      if (Math.abs(f.u) > Math.abs(best)) best = f.u;
      if (Math.abs(f.k) > Math.abs(shown)) shown = f.k;
    }
    T.held = any; T.steer = best;
    els.steer.classList.toggle('on', any);
    knob(shown);
  }
  function steerMove(f, x) {
    const dx = x - f.x0, lim = dx < 0 ? f.tL : f.tR, a = Math.abs(dx);
    const u = a <= DEAD ? 0 : Math.pow(Math.min(1, (a - DEAD) / (lim - DEAD)), CURVE);
    f.u = dx < 0 ? -u : u;
    f.k = F1.clamp(dx / lim, -1, 1);
    if (!labelGone && a > 24) { labelGone = true; els.steer.classList.add('used'); }
    steerState();
  }
  function begin(t) {
    const L = api.L, x = t.clientX, y = t.clientY;
    if (hit(L.pause, x, y, 7)) { if (cb.pause) cb.pause(); return; }
    if (hit(L.reset, x, y, 7)) { Input.resetEdge = true; flash(els.reset); return; }
    if (x >= L.W * 0.5) {
      // the lower right is the pedals: whichever side of the line between them the finger is on
      // (a touch higher up, near the minimap and its buttons, does nothing)
      if (y < L.drs.y - 30) return;
      pedals[t.identifier] = { x: x, y: y, gas: x >= L.divX };
      pedalState();
      return;
    }
    // steering starts from where the thumb lands; close to the screen edge the slide to the left is shorter
    const tr = api.travel();
    steers[t.identifier] = { x0: x, tR: tr, tL: Math.max(Math.min(tr, x - 8), tr * 0.55), u: 0, k: 0 };
    steerState();
  }
  function move(t) {
    if (steers[t.identifier]) { steerMove(steers[t.identifier], t.clientX); return; }
    const p = pedals[t.identifier];
    if (!p) return;
    p.x = t.clientX; p.y = t.clientY;
    // sliding from one pedal to the other: switch once the finger is clearly across the line
    if (p.gas && p.x < api.L.divX - 7) p.gas = false; else if (!p.gas && p.x > api.L.divX + 7) p.gas = true;
    pedalState();
  }
  function end(t) {
    if (steers[t.identifier]) { delete steers[t.identifier]; steerState(); return; }
    if (pedals[t.identifier]) { delete pedals[t.identifier]; pedalState(); }
  }
  function each(e, fn) {
    if (e.cancelable) e.preventDefault();        // no scrolling, zooming or text selection while driving
    if (!api.L || root.classList.contains('hidden')) return;
    for (let i = 0; i < e.changedTouches.length; i++) fn(e.changedTouches[i]);
  }
  function flash(el) { el.classList.add('tap'); setTimeout(function () { el.classList.remove('tap'); }, 160); }

  // ------------------------------------------------------------- set-up
  /* o = { pause: fn, rotate: fn(upright), mode: fn(touchOn) } */
  api.init = function (o) {
    Object.assign(cb, o || {});
    root = $('touchui');
    els = { gas: $('t-gas'), brake: $('t-brake'), drs: $('t-drs'), pause: $('t-pause'), reset: $('t-reset'), steer: $('t-steer'), knob: $('t-knob') };
    root.addEventListener('touchstart', function (e) { each(e, begin); }, { passive: false });
    root.addEventListener('touchmove', function (e) { each(e, move); }, { passive: false });
    root.addEventListener('touchend', function (e) { each(e, end); }, { passive: false });
    root.addEventListener('touchcancel', function (e) { each(e, end); }, { passive: false });
    // a mouse on the two small buttons (touch-screen laptops)
    els.pause.addEventListener('click', function () { if (cb.pause) cb.pause(); });
    els.reset.addEventListener('click', function () { Input.resetEdge = true; flash(els.reset); });
    root.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('resize', refresh);
    window.addEventListener('orientationchange', function () { setTimeout(refresh, 300); });
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', function () { if (document.hidden) release(); });
    // the first touch anywhere switches to the on-screen controls; a driving key switches back
    window.addEventListener('touchstart', function () { setMode(true); }, { capture: true, passive: true });
    window.addEventListener('keydown', function (e) {
      if (!T.active || e.repeat || !Input.bound(window.KeyBind.norm(e.code))) return;
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || '')) return;      // typing a name is not driving
      setMode(false);
    }, true);
    if (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches) setMode(true);
    refresh();
  };
  /* While you drive on a phone or tablet, or wait in an online room, the screen must not dim or lock by itself
     (where the browser allows it). */
  let lock = null, lockWanted = false, lockAsking = false;
  function keepAwake(on) {
    lockWanted = on;
    try {
      if (on && !lock && !lockAsking && navigator.wakeLock && !document.hidden) {
        lockAsking = true;
        navigator.wakeLock.request('screen').then(function (l) {
          lockAsking = false;
          lock = l;
          l.addEventListener('release', function () { if (lock === l) lock = null; });
          if (!lockWanted) { l.release(); lock = null; }
        }, function () { lockAsking = false; /* not allowed right now */ });
      } else if (!on && lock) { lock.release(); lock = null; }
    } catch (e) { lockAsking = false; /* not supported */ }
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && lockWanted) keepAwake(true); });

  /* on = a session is on screen and being driven (not a menu, not paused); busy = that, or waiting in an online room
     (the screen stays awake, so the phone does not drop out of the room between sessions) */
  api.show = function (on, busy) { wanted = !!on; refresh(); keepAwake((wanted || !!busy) && T.active); };
  api.refresh = refresh;
  api.upright = function () { return portrait; };
  /* Called with every HUD frame: the DRS button shows whether DRS can be used, the reset button pulses when stuck. */
  api.hud = function (h) {
    const st = h.speed === undefined || h.pit ? '' : h.drs;
    if (st !== drsShown) {
      els.drs.classList.toggle('avail', st === 'avail'); els.drs.classList.toggle('open', st === 'open');
      drsShown = st;
    }
    if (!!h.stuck !== stuckShown) { stuckShown = !!h.stuck; els.reset.classList.toggle('pulse', stuckShown); }
  };

  window.TouchUI = api;
})();
