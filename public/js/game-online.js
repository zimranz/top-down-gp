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
    this.stage = info.stage || info.type;
    this.title = info.title || null;
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
    this.near = [];       // nearby cars (track position) for dirty air on our own car
    // connection check: how late snapshots arrive (your connection) and how late the server sent them (server)
    this.cq = { base: [], bmin: Infinity, bAt: 0, prevW: null, events: [], lastFrame: 0, stallAt: -1e9, shown: null };
    // online season paused (host away), then a 3-2-1 before it carries on
    this.frozen = false;
    this.resumeUntil = 0;
    this.resumeT = 0;
    this.resumeShown = 0;
  }

  /* away: the season waits for its host. resumeMs > 0: it carries on after that long (3-2-1). */
  OnlineGame.prototype.setPause = function (away, resumeMs) {
    const now = performance.now();
    if (away) { this.frozen = true; this.resumeUntil = 0; this.resumeT = 0; }
    else if (resumeMs > 0) { this.frozen = true; this.resumeUntil = now + resumeMs; }
    else if (!this.resumeUntil) this.frozen = false;
    // the gap in snapshots while paused is not the server being slow
    this.cq.prevW = null;
    this.cq.stallAt = now;
  };

  /* One snapshot arrived: note delay spikes on the way to us and gaps in what the server sends. */
  OnlineGame.prototype.netSample = function (m) {
    if (m.w === undefined) return;
    const now = performance.now(), q = this.cq;
    if (this.frozen) { q.prevW = null; return; }     // a paused season: gaps between snapshots are expected
    const d = now - m.w;                       // server send time -> arrival here (plus a fixed clock offset)
    if (now - q.bAt > 5000) { if (q.bmin < Infinity) q.base.push(q.bmin); if (q.base.length > 4) q.base.shift(); q.bmin = Infinity; q.bAt = now; }
    if (d < q.bmin) q.bmin = d;
    let base = q.bmin;
    for (let i = 0; i < q.base.length; i++) if (q.base[i] < base) base = q.base[i];
    const jit = d - base;
    // ignore the first seconds of a session and moments when this computer itself was busy (not the network)
    const settled = now - this.started > 3000 && now - q.stallAt > 600 && !document.hidden;
    if (settled) {
      if (this.net) this.net.jitWorst = Math.max(this.net.jitWorst || 0, Math.round(jit));
      if (jit >= 130) q.events.push({ t: now, lvl: jit >= 300 ? 2 : 1, who: 'you' });
      if (q.prevW !== null) {
        const sg = m.w - q.prevW;                // normally 50 ms between snapshots
        if (sg >= 110) q.events.push({ t: now, lvl: sg >= 250 ? 2 : 1, who: 'server' });
      }
    }
    q.prevW = m.w;
  };

  /* Green / amber / red: is a slowdown the server, your connection or a friend's? Problems stay up for 4 s. */
  OnlineGame.prototype.connStatus = function (now, compact) {
    const q = this.cq;
    while (q.events.length && now - q.events[0].t > 4000) q.events.shift();
    let best = { lvl: 0, who: null, t: 0 };
    for (let i = 0; i < q.events.length; i++) {
      const e = q.events[i];
      if (e.lvl > best.lvl || (e.lvl === best.lvl && e.t >= best.t)) best = e;
    }
    const ping = this.net ? this.net.ping : null;
    if (ping !== null && ping >= 160) {
      const lvl = ping >= 300 ? 2 : 1;
      if (lvl > best.lvl) best = { lvl: lvl, who: 'you', t: now };
    }
    let friend = null;
    if (best.lvl === 0 && this.timing && this.timing.np) {
      for (let i = 0; i < this.timing.np.length; i++) {
        const a = this.timing.np[i];
        if (a[0] === this.myId || !this.entries[a[0]]) continue;
        if (a[1] >= 300 || a[2] >= 300) { friend = this.entries[a[0]]; best = { lvl: 1, who: 'friend', t: now }; break; }
      }
    }
    const ms = ping !== null ? ping + ' MS' : '';
    let text;
    if (best.who === 'server') text = 'SERVER BUSY';
    else if (best.who === 'you') text = (compact ? 'YOU' : 'YOUR CONNECTION') + (ms ? ' · ' + ms : '');
    else if (best.who === 'friend') {
      const n = String(friend.name || friend.driverId).toUpperCase().slice(0, compact ? 8 : 12);
      text = compact ? n : n + "'S CONNECTION";
    } else text = (compact ? 'GOOD' : 'CONNECTION GOOD') + (ms ? ' · ' + ms : '');
    return { lvl: best.lvl, text: text };
  };

  OnlineGame.prototype.predTick = function (now) {
    if (this.frozen) return this.snapT + (this.own && !this.own.out ? this.pending.length : 0);
    if (this.own && !this.own.out) return this.snapT + this.pending.length + this.alpha;
    return this.snapT + Math.min(30, (now - this.snapRecv) / 1000 / DT);
  };

  OnlineGame.prototype.onSnap = function (m) {
    this.netSample(m);
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
      // rough throttle estimate for the engine sound (from how fast the car is speeding up)
      if (r.st) {
        const dts = Math.max(1, m.t - r.t) * DT, acc = (Math.hypot(st.vx, st.vy) - Math.hypot(r.st.vx, r.st.vy)) / dts;
        r.thr = acc > 1.5 ? 1 : acc < -4 ? 0 : 0.45;
      }
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
    own.dirty = this.collide ? this.ownDirty(baseTick + k) : 1;
    for (let i = 0; i < F1.SUBSTEPS; i++) {
      F1.stepCar(own, inp, T, sub);
      if (this.collide && this.phase >= 1) {
        const tick = baseTick + (k - 1) + (i + 1) / F1.SUBSTEPS;
        const myLv = T.bridge ? F1.levelAt(T, own.s) : 0;
        for (const id in this.remote) {
          const r = this.remote[id];
          if (!r.st || r.out) continue;
          const dx = r.st.x - own.x, dy = r.st.y - own.y;
          if (dx * dx + dy * dy > 1600) continue;
          if (myLv * (r.flags & 512 ? 1 : r.flags & 1024 ? -1 : 0) < 0) continue;     // one on the bridge, one underneath
          const o = extrap(r.st, (tick - r.t) * DT, this.tmpC);
          F1.collideCars(own, o, false);
        }
      }
    }
  };

  /* Dirty air on our own car: the same rule as the server, using where the other cars are predicted to be. */
  OnlineGame.prototype.ownDirty = function (tick) {
    const own = this.own, T = this.T, near = this.near;
    if (own.vx * own.vx + own.vy * own.vy < 900) return 1;
    let n = 0;
    for (const id in this.remote) {
      const r = this.remote[id];
      if (!r.st || r.out) continue;
      const dx = r.st.x - own.x, dy = r.st.y - own.y;
      if (dx * dx + dy * dy > 1600) continue;
      const e = extrap(r.st, (tick - r.t) * DT, this.tmpC);
      // the last track position is only a good starting point if it is from the previous tick
      F1.queryTrack(T, e.x, e.y, r.segTick === tick - 1 && r.seg !== undefined ? r.seg : -1, Q, e.a);
      r.seg = Q.idx; r.segTick = tick;
      if (!near[n]) near[n] = { s: 0, d: 0, out: false };
      near[n].s = Q.s; near[n].d = Q.d; n++;
    }
    if (!n) return 1;
    near.length = n;
    near.push(own);
    const f = F1.dirtyAir(own, near, T.length);
    near.pop();
    return f;
  };

  OnlineGame.prototype.onTiming = function (t) {
    this.timing = t;
    const rows = {};
    for (let i = 0; i < t.r.length; i++) {
      const a = t.r[i];
      rows[a[0]] = { laps: a[1], last: a[2] < 0 ? null : a[2], best: a[3] < 0 ? null : a[3], gap: a[4], lapStart: a[5] < 0 ? null : a[5], fin: !!(a[6] & 1), out: !!(a[6] & 2), qdone: !!(a[6] & 4), dist: a[7], pen: a[8] || 0 };
    }
    this.rows = rows;
  };

  OnlineGame.prototype.code = function (id) {
    const e = this.entries[id];
    return e ? e.driverId : '???';
  };

  OnlineGame.prototype.onEvents = function (evs) {
    const self = this;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.k === 'lap' && e.id === this.myId) e.record = window.PB.offer(this.T.id, e.t, this.code(this.myId));
      window.HUD.eventMessage(this.msgs, e, this.myId, function (id) { return self.code(id); });
      window.GameAudio.event(e, this.myId);
    }
  };

  OnlineGame.prototype.step = function () {
    const own = this.own;
    if (this.frozen || this.myId === null || !own || own.out || this.ended) return;
    const inp = window.Input.sample(DT);
    this.seq++;
    this.net.emit('i', [this.seq, inp.throttle, inp.brake, Math.round(inp.steer * 1000), (inp.drs ? 1 : 0) | (inp.reset ? 2 : 0)]);
    this.pending.push({ seq: this.seq, inp: inp });
    this.lastInp = inp;
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
    // a long gap between frames means this computer was busy: late snapshots right after it are not the network
    if (this.cq.lastFrame && now - this.cq.lastFrame > 150) this.cq.stallAt = now;
    this.cq.lastFrame = now;
    // a paused season carrying on: 3, 2, 1
    if (this.resumeUntil) {
      const left = this.resumeUntil - now;
      if (left <= 0) { this.resumeUntil = 0; this.resumeT = 0; this.frozen = false; this.cq.stallAt = now; window.GameAudio.go(); }
      else {
        this.resumeT = left / 1000;
        const n = Math.ceil(this.resumeT);
        if (n !== this.resumeShown) { this.resumeShown = n; window.GameAudio.countdown(); }
      }
    }
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
      v.delta = r.st.delta; v.drsOpen = !!(r.flags & 1); v.me = false; v.ghost = ghost; v.surf = 0; v.lock = !!(r.flags & 256);
      v.lvl = r.flags & 512 ? 1 : r.flags & 1024 ? -1 : 0;
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
      v.me = true; v.ghost = false; v.lock = false;
      v.lvl = this.T.bridge ? F1.levelAt(this.T, own.s) : 0;
      cars.push(v);
      focus = v;
    } else if (this.timing) {
      for (let i = 0; i < this.timing.o.length && !focus; i++) {
        const id = this.timing.o[i];
        focus = cars.find(function (c) { return c.id === id; }) || null;
      }
    }
    if (!focus && cars.length) focus = cars[0];
    const frame = { track: this.T, cars: cars, labels: window.Settings.data.labels,
      lights: this.phase === 0 ? this.lights : 0, pitRed: this.phase === 0 && this.type === 'race' };
    R.updateCamera(focus, dt, window.Settings.data.camera === 'rotate', window.Settings.data.zoom);
    for (let i = 0; i < this.fx.length; i++) {
      const f = this.fx[i];
      R.sparks(f[0], f[1], f[2]);
      if (focus) window.GameAudio.contact(f[2], Math.hypot(f[0] - focus.x, f[1] - focus.y));
    }
    this.fx = [];
    this.focus = focus;
    this.frameCars = cars;
    R.drawWorld(frame, dt);
    R.drawHUD(this.hud(now), frame);
  };

  /* What the sound system needs this frame. */
  OnlineGame.prototype.audioState = function () {
    const f = this.focus;
    if (!f) return null;
    const cars = [], list = this.frameCars || [];
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v.me) continue;
      const r = this.remote[v.id];
      cars.push({ id: v.id, x: v.x, y: v.y, vx: v.vx, vy: v.vy, throttle: r && r.thr !== undefined ? r.thr : 0.7 });
    }
    const me = this.own && !this.own.out && this.myId !== null ? this.own : null;
    let own = null;
    if (me) {
      const vf = me.vx * Math.cos(me.a) + me.vy * Math.sin(me.a);
      own = { speed: Math.hypot(me.vx, me.vy), vf: vf, throttle: this.lastInp ? this.lastInp.throttle : 0, inPit: !!me.inPit, surf: me.surf,
        drsOpen: me.drsOpen, drsAllowed: me.drsAllowed, locked: me.locked };
    }
    return {
      listener: { x: f.x, y: f.y, a: f.a, vx: f.vx, vy: f.vy }, own: own, cars: cars,
      lights: this.phase === 0 ? this.lights : 0,
      countdown: this.type === 'quali' && this.phase === 0 ? Math.max(0, Math.ceil(3 - this.serverTime)) : 0
    };
  };

  OnlineGame.prototype.hud = function (now) {
    const tm = this.timing;
    const hud = window.HUD.build({
      type: this.type, laps: this.laps, track: this.T, title: this.title,
      order: tm ? tm.o : Object.keys(this.entries).map(Number),
      rows: this.rows, entries: this.entries, myId: this.myId, phase: this.phase, lights: this.lights,
      time: this.serverTime + Math.min(1, (now - this.snapRecv) / 1000),
      timeLeft: tm && tm.tl >= 0 ? tm.tl : -1,
      fastestId: tm && tm.f ? tm.f[0] : null,
      own: this.own, msgs: this.msgs, ping: this.net.ping,
      started: this.started, wrongT: this.wrongT, stuckT: this.stuckT
    });
    hud.conn = this.connStatus(now, window.innerWidth < 820);
    if (this.resumeT > 0) { hud.resume = Math.ceil(this.resumeT); hud.hint = null; }
    return hud;
  };

  window.OnlineGame = OnlineGame;
})();
