/* Online session client.
   - Your own car is predicted locally (instant response), then corrected against the server.
   - Other cars are extrapolated to the same moment and smoothed, so side-by-side racing lines up. */
(function () {
  'use strict';
  const F1 = window.F1;
  const DT = F1.DT;
  const Q = {};

  function extrap(st, dtA, out) {
    if (dtA > 0.5) dtA = 0.5;
    if (dtA < 0) dtA = 0;
    const w = st.slide ? 0 : st.w, ph = w * dtA;
    if (Math.abs(w) > 1e-3) {
      const s = Math.sin(ph), c = Math.cos(ph);
      out.x = st.x + (s * st.vx - (1 - c) * st.vy) / w;
      out.y = st.y + ((1 - c) * st.vx + s * st.vy) / w;
      out.vx = c * st.vx - s * st.vy;
      out.vy = s * st.vx + c * st.vy;
    } else {
      out.x = st.x + st.vx * dtA; out.y = st.y + st.vy * dtA;
      out.vx = st.vx; out.vy = st.vy;
    }
    out.a = st.a + st.w * dtA;
    out.w = st.w;
    return out;
  }

  function OnlineGame(net, info) {
    this.net = net;
    this.kind = 'online';
    this.type = info.type;
    this.T = F1.getTrack(info.track);
    this.laps = info.laps;
    this.entries = {};
    const self = this;
    info.entries.forEach(function (e) { self.entries[e.id] = e; });
    const mine = info.entries.find(function (e) { return e.owner === net.id(); });
    this.myId = mine ? mine.id : null;
    this.remote = {};
    this.own = null;
    this.ownPrev = null;
    this.err = { x: 0, y: 0, a: 0 };
    this.pending = [];
    this.seq = 0;
    this.snapT = -1;
    this.snapRecv = performance.now();
    this.phase = 0;
    this.lights = 0;
    this.serverTime = 0;
    this.timing = null;
    this.rows = {};
    this.msgs = new window.Messages();
    this.fx = [];
    this.ended = false;
    this.alpha = 0;
    this.wrongT = 0;
    this.stuckT = 0;
    this.views = {};
    this.tmpA = {}; this.tmpB = {}; this.tmpC = {};
    this.started = performance.now();
    this.collide = info.type === 'race';
  }

  OnlineGame.prototype.predTick = function (now) {
    if (this.own && !this.own.out) return this.snapT + this.pending.length + this.alpha;
    return this.snapT + Math.min(30, (now - this.snapRecv) / 1000 / DT);
  };

  OnlineGame.prototype.onSnap = function (m) {
    this.phase = m.ph;
    this.lights = m.l;
    this.serverTime = m.tm;
    let ownArr = null;
    const updates = [];
    for (let i = 0; i < m.c.length; i++) {
      const a = m.c[i], id = a[0];
      if (id === this.myId) { ownArr = a; continue; }
      let r = this.remote[id];
      if (!r) r = this.remote[id] = { st: null, t: 0, ex: 0, ey: 0, ea: 0, out: false, flags: 0 };
      if (a[8] & 64) { r.out = true; continue; }
      updates.push([r, a]);
    }
    if (ownArr) this.reconcile(ownArr, m.t);
    const P = this.own && !this.own.out ? m.t + this.pending.length + this.alpha : m.t;
    for (let i = 0; i < updates.length; i++) {
      const r = updates[i][0], a = updates[i][1];
      const st = { x: a[1], y: a[2], a: a[3], vx: a[4], vy: a[5], w: a[6], delta: a[7], slide: !!(a[8] & 4) };
      if (r.st) {
        const o = extrap(r.st, (P - r.t) * DT, this.tmpA), n = extrap(st, (P - m.t) * DT, this.tmpB);
        let ex = o.x + r.ex - n.x, ey = o.y + r.ey - n.y, ea = F1.wrapAngle(o.a + r.ea - n.a);
        if (ex * ex + ey * ey > 100 || Math.abs(ea) > 1) { ex = 0; ey = 0; ea = 0; }
        r.ex = ex; r.ey = ey; r.ea = ea;
      }
      r.st = st; r.t = m.t; r.flags = a[8]; r.out = false;
    }
    this.snapT = m.t;
    this.snapRecv = performance.now();
    if (m.fx) for (let i = 0; i < m.fx.length; i++) this.fx.push(m.fx[i]);
  };

  OnlineGame.prototype.reconcile = function (a, t) {
    const ack = a[9], flags = a[8];
    while (this.pending.length && this.pending[0].seq <= ack) this.pending.shift();
    if (flags & 64) { if (this.own) this.own.out = true; return; }
    let own = this.own;
    const first = !own;
    if (first) {
      own = this.own = { x: a[1], y: a[2], a: a[3], vx: 0, vy: 0, w: 0, delta: 0, seg: -1, s: 0, d: 0, dist: 0, surf: 0,
        slide: false, drsOpen: false, drsAllowed: false, locked: true, resetCd: 0, wallHit: 0, out: false, drsElig: [false, false] };
    }
    const ox = own.x, oy = own.y, oa = own.a;
    own.x = a[1]; own.y = a[2]; own.a = a[3]; own.vx = a[4]; own.vy = a[5]; own.w = a[6]; own.delta = a[7];
    own.drsOpen = !!(flags & 1); own.locked = !!(flags & 2); own.slide = !!(flags & 4);
    own.drsElig[0] = !!(flags & 8); own.drsElig[1] = !!(flags & 16);
    own.finished = !!(flags & 32);
    F1.queryTrack(this.T, own.x, own.y, own.seg, Q);
    own.seg = Q.idx; own.s = Q.s; own.d = Q.d; own.dist = Q.dist;
    for (let k = 0; k < this.pending.length; k++) this.simulate(this.pending[k].inp, k + 1, t);
    if (first || !this.ownPrev) { this.ownPrev = { x: own.x, y: own.y, a: own.a }; return; }
    const dx = own.x - ox, dy = own.y - oy, da = F1.wrapAngle(own.a - oa);
    if (dx * dx + dy * dy > 144) {
      this.err.x = 0; this.err.y = 0; this.err.a = 0;
      this.ownPrev = { x: own.x, y: own.y, a: own.a };
    } else {
      this.err.x -= dx; this.err.y -= dy; this.err.a -= da;
      this.ownPrev.x += dx; this.ownPrev.y += dy; this.ownPrev.a += da;
    }
  };

  OnlineGame.prototype.simulate = function (inp, k, baseTick) {
    const own = this.own, T = this.T;
    own.locked = this.phase === 0;
    const z = T.drsZone[F1.idxAt(T, own.s)];
    own.drsAllowed = z >= 0 && own.drsElig[z] && this.phase !== 0;
    const sub = DT / F1.SUBSTEPS;
    for (let i = 0; i < F1.SUBSTEPS; i++) {
      F1.stepCar(own, inp, T, sub);
      if (this.collide && this.phase >= 1) {
        const tick = baseTick + (k - 1) + (i + 1) / F1.SUBSTEPS;
        for (const id in this.remote) {
          const r = this.remote[id];
          if (!r.st || r.out) continue;
          const dx = r.st.x - own.x, dy = r.st.y - own.y;
          if (dx * dx + dy * dy > 1600) continue;
          const o = extrap(r.st, (tick - r.t) * DT, this.tmpC);
          F1.collideCars(own, o, false);
        }
      }
    }
  };

  OnlineGame.prototype.onTiming = function (t) {
    this.timing = t;
    const rows = {};
    for (let i = 0; i < t.r.length; i++) {
      const a = t.r[i];
      rows[a[0]] = { laps: a[1], last: a[2] < 0 ? null : a[2], best: a[3] < 0 ? null : a[3], gap: a[4], lapStart: a[5] < 0 ? null : a[5], fin: !!(a[6] & 1), out: !!(a[6] & 2), qdone: !!(a[6] & 4), dist: a[7] };
    }
    this.rows = rows;
  };

  OnlineGame.prototype.code = function (id) {
    const e = this.entries[id];
    return e ? e.driverId : '???';
  };

  OnlineGame.prototype.onEvents = function (evs) {
    const self = this;
    for (let i = 0; i < evs.length; i++) window.HUD.eventMessage(this.msgs, evs[i], this.myId, function (id) { return self.code(id); });
  };

  OnlineGame.prototype.step = function () {
    const own = this.own;
    if (this.myId === null || !own || own.out || this.ended) return;
    const inp = window.Input.sample(DT);
    this.seq++;
    this.net.emit('i', [this.seq, inp.throttle, inp.brake, Math.round(inp.steer * 1000), (inp.drs ? 1 : 0) | (inp.reset ? 2 : 0)]);
    this.pending.push({ seq: this.seq, inp: inp });
    if (this.pending.length > 90) this.pending.shift();
    this.ownPrev = { x: own.x, y: own.y, a: own.a };
    this.simulate(inp, this.pending.length, this.snapT);
    this.wrongT = F1.isWrongWay(own, this.T) ? this.wrongT + DT : 0;
    this.stuckT = Math.hypot(own.vx, own.vy) < 2 && this.phase >= 1 && !own.inPit ? this.stuckT + DT : 0;
  };

  /* Tab hidden: tell the server to brake so the car does not keep the last key held. */
  OnlineGame.prototype.sendNeutral = function () {
    if (this.myId === null || !this.own || this.own.out || this.ended) return;
    const inp = { throttle: 0, brake: 1, steer: 0, drs: false, reset: false };
    this.seq++;
    this.net.emit('i', [this.seq, 0, 1, 0, 0]);
    this.pending.push({ seq: this.seq, inp: inp });
  };

  OnlineGame.prototype.carView = function (id) {
    let v = this.views[id];
    if (!v) {
      const e = this.entries[id];
      v = this.views[id] = { id: Number(id), team: F1.teamOfDriver(e.driverId), code: e.driverId, label: e.isAI ? e.driverId : (e.name || e.driverId) };
    }
    return v;
  };

  OnlineGame.prototype.render = function (R, alpha, dt) {
    this.alpha = alpha;
    const now = performance.now();
    const P = this.predTick(now);
    const decay = Math.exp(-dt / 0.11);
    const cars = [];
    const ghost = this.type === 'quali';
    for (const id in this.remote) {
      const r = this.remote[id];
      if (!r.st || r.out) continue;
      r.ex *= decay; r.ey *= decay; r.ea *= decay;
      const e = extrap(r.st, (P - r.t) * DT, this.tmpA);
      const v = this.carView(id);
      v.x = e.x + r.ex; v.y = e.y + r.ey; v.a = e.a + r.ea; v.vx = e.vx; v.vy = e.vy;
      v.delta = r.st.delta; v.drsOpen = !!(r.flags & 1); v.me = false; v.ghost = ghost; v.surf = 0;
      cars.push(v);
    }
    let focus = null;
    const own = this.own;
    if (own && !own.out) {
      this.err.x *= decay; this.err.y *= decay; this.err.a *= decay;
      const p = this.ownPrev || own;
      const v = this.carView(this.myId);
      v.x = p.x + (own.x - p.x) * alpha + this.err.x;
      v.y = p.y + (own.y - p.y) * alpha + this.err.y;
      v.a = window.Renderer.lerpAngle(p.a, own.a, alpha) + this.err.a;
      v.vx = own.vx; v.vy = own.vy; v.delta = own.delta; v.drsOpen = own.drsOpen; v.surf = own.surf;
      v.me = true; v.ghost = false;
      cars.push(v);
      focus = v;
    } else if (this.timing) {
      for (let i = 0; i < this.timing.o.length && !focus; i++) {
        const id = this.timing.o[i];
        focus = cars.find(function (c) { return c.id === id; }) || null;
      }
    }
    if (!focus && cars.length) focus = cars[0];
    const frame = { track: this.T, cars: cars, labels: window.Settings.data.labels };
    R.updateCamera(focus, dt, window.Settings.data.camera === 'rotate');
    for (let i = 0; i < this.fx.length; i++) R.sparks(this.fx[i][0], this.fx[i][1], this.fx[i][2]);
    this.fx = [];
    R.drawWorld(frame, dt);
    R.drawHUD(this.hud(now), frame);
  };

  OnlineGame.prototype.hud = function (now) {
    const tm = this.timing;
    return window.HUD.build({
      type: this.type, laps: this.laps, track: this.T,
      order: tm ? tm.o : Object.keys(this.entries).map(Number),
      rows: this.rows, entries: this.entries, myId: this.myId, phase: this.phase, lights: this.lights,
      time: this.serverTime + Math.min(1, (now - this.snapRecv) / 1000),
      timeLeft: tm && tm.tl >= 0 ? tm.tl : -1,
      fastestId: tm && tm.f ? tm.f[0] : null,
      own: this.own, msgs: this.msgs, ping: this.net.ping,
      started: this.started, wrongT: this.wrongT, stuckT: this.stuckT
    });
  };

  window.OnlineGame = OnlineGame;
})();
