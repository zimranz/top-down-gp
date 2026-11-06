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
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.k === 'lightsOut') this.msgs.add('LIGHTS OUT AND AWAY WE GO!', { big: true, color: '#e10600', key: 'start', dur: 2600 });
      else if (e.k === 'go') this.msgs.add('QUALIFYING — GO!', { big: true, color: '#19c94a', key: 'start', dur: 2200 });
      else if (e.k === 'finalLap') this.msgs.add('FINAL LAP', { color: '#ffffff', key: 'final', dur: 3500 });
      else if (e.k === 'chequered') this.msgs.add('CHEQUERED FLAG', { sub: this.code(e.id) + ' WINS', big: true, color: '#ffffff', key: 'cheq', dur: 4500 });
      else if (e.k === 'finish' && e.id === this.myId) this.msgs.add('FINISHED  P' + e.pos, { big: true, color: '#ffd600', key: 'fin', dur: 6000 });
      else if (e.k === 'qualiDone' && e.id === this.myId) this.msgs.add('QUALIFYING COMPLETE', { sub: 'Keep driving — waiting for the others', color: '#19c94a', key: 'qd', dur: 6000 });
      else if (e.k === 'lap') {
        if (e.id === this.myId) {
          this.msgs.add('LAP ' + e.n + '   ' + F1.fmtLap(e.t), {
            sub: e.fastest ? 'FASTEST LAP OF THE SESSION' : e.pb ? 'PERSONAL BEST' : null,
            subColor: e.fastest ? '#c77dff' : '#19c94a', color: e.fastest ? '#9b30ff' : '#19c94a', key: 'mylap', dur: 4000
          });
        } else if (e.fastest) {
          this.msgs.add('FASTEST LAP', { sub: this.code(e.id) + '  ' + F1.fmtLap(e.t), color: '#9b30ff', subColor: '#c77dff', key: 'fl', dur: 3000 });
        }
      }
    }
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
    const T = this.T, rows = this.rows, self = this;
    const tm = this.timing;
    const order = tm ? tm.o : Object.keys(this.entries).map(Number);
    const fastestId = tm && tm.f ? tm.f[0] : null;
    const isRace = this.type === 'race';
    const leader = rows[order[0]] || null;
    const tower = order.map(function (id, i) {
      const e = self.entries[id], r = rows[id] || {};
      const t = F1.teamOfDriver(e.driverId);
      let info = '';
      if (r.out) info = 'OUT';
      else if (isRace) {
        if (i === 0) info = r.fin ? 'WINNER' : 'LEADER';
        else if (leader && leader.dist - r.dist > T.length && !r.fin) {
          const n = Math.floor((leader.dist - r.dist) / T.length);
          info = '+' + n + (n > 1 ? ' LAPS' : ' LAP');
        } else {
          const ahead = rows[order[i - 1]];
          const iv = ahead ? Math.max(0, r.gap - ahead.gap) : 0;
          info = '+' + iv.toFixed(1);
        }
      } else info = r.best !== null && r.best !== undefined ? F1.fmtLap(r.best) : 'NO TIME';
      return {
        pos: i + 1, code: e.driverId, color: F1.teamUiColor(t), info: info,
        me: id === self.myId, out: !!r.out, done: isRace ? !!r.fin : !!r.qdone, purple: !isRace && id === fastestId
      };
    });
    const srvNow = this.serverTime + Math.min(1, (now - this.snapRecv) / 1000);
    const hud = {
      title: isRace ? 'RACE' : 'QUALIFYING',
      towerRight: isRace ? 'LAP ' + Math.min(this.laps, (leader ? leader.laps : 0) + 1) + '/' + this.laps : T.name.toUpperCase(),
      tower: tower,
      msgs: this.msgs.active(),
      ping: this.net.ping
    };
    if (this.phase === 0 && isRace) hud.lights = this.lights;
    if (this.phase === 0 && !isRace) {
      const left = Math.ceil(3 - this.serverTime);
      if (left > 0) hud.centre = { text: String(left), size: 90 };
    }
    if (tm && tm.tl >= 0 && !isRace) {
      const m = Math.floor(tm.tl / 60), s = tm.tl % 60;
      hud.timeLeft = 'SESSION ' + m + ':' + (s < 10 ? '0' : '') + s;
    }
    const own = this.own;
    if (own && !own.out) {
      const r = rows[this.myId] || {};
      const sp = Math.hypot(own.vx, own.vy) * 3.6;
      const vf = own.vx * Math.cos(own.a) + own.vy * Math.sin(own.a);
      const pos = order.indexOf(this.myId) + 1;
      hud.speed = Math.round(sp);
      hud.gear = window.gearFor(sp, vf);
      hud.drs = own.drsOpen ? 'open' : own.drsAllowed ? 'avail' : 'off';
      hud.posText = 'P' + pos + ' / ' + order.length;
      if (isRace) hud.lapText = r.fin ? 'FINISHED' : 'LAP ' + Math.min(this.laps, (r.laps || 0) + 1) + ' / ' + this.laps;
      else hud.lapText = r.qdone ? 'QUALIFYING COMPLETE' : r.lapStart === null || r.lapStart === undefined ? 'OUT LAP' : 'TIMED LAP ' + Math.min(this.laps, (r.laps || 0) + 1) + ' / ' + this.laps;
      hud.cur = r.lapStart !== null && r.lapStart !== undefined && this.phase >= 1 && !r.fin ? F1.fmtLap(Math.max(0, srvNow - r.lapStart)) : (isRace ? null : 'OUT LAP');
      hud.last = r.last !== null && r.last !== undefined ? F1.fmtLap(r.last) : null;
      hud.best = r.best !== null && r.best !== undefined ? F1.fmtLap(r.best) : null;
      hud.bestPurple = fastestId === this.myId;
      hud.wrongWay = this.wrongT > 1.2;
      if (now - this.started < 9000 && this.phase === 0) hud.hint = window.controlsHint();
    } else if (this.myId === null) {
      hud.msgs = hud.msgs.concat([{ text: 'SPECTATING', sub: 'You will join the next session', color: '#ffd600' }]);
    }
    return hud;
  };

  window.OnlineGame = OnlineGame;
})();
