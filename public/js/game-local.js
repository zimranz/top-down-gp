/* Sessions simulated entirely in the browser: practice, Grand Prix (qualifying + race) and the menu background. */
(function () {
  'use strict';
  const F1 = window.F1;
  const PH = { countdown: 0, running: 1, finishing: 2, done: 3 };

  /* opts: { attract, type: 'practice'|'quali'|'race', track, driverId, aiCount, aiDrivers, grid, aiLevel, collisions, laps, onEnd } */
  function LocalGame(opts) {
    this.kind = opts.attract ? 'attract' : 'local';
    this.type = opts.type || 'practice';
    this.opts = opts;
    this.T = F1.getTrack(opts.track);
    const rng = F1.rng((Math.random() * 1e9) | 0);
    let order;
    if (opts.grid) {
      order = opts.grid.slice();
    } else {
      let ai = opts.aiDrivers ? opts.aiDrivers.slice() : null;
      if (!ai) {
        ai = F1.DRIVERS.map(function (d) { return d.id; }).filter(function (id) { return id !== opts.driverId; });
        for (let i = ai.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = ai[i]; ai[i] = ai[j]; ai[j] = t; }
        ai = ai.slice(0, opts.aiCount || 0);
      }
      order = opts.attract ? ai : [opts.driverId].concat(ai);
      if (this.type !== 'practice') {
        for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
      }
    }
    const self = this;
    this.myId = null;
    const entries = order.map(function (driverId, k) {
      const human = !opts.attract && driverId === opts.driverId;
      if (human) self.myId = k;
      return { id: k, driverId: driverId, isAI: !human, name: human ? 'You' : null };
    });
    this.S = new F1.Session({
      type: this.type, track: this.T, entries: entries, laps: opts.laps || 0,
      aiLevel: opts.aiLevel || 'medium', collisions: this.type === 'practice' ? opts.collisions !== false : true,
      seed: (rng() * 1e9) | 0, startMode: this.type === 'practice' && !opts.attract ? 'pit' : 'grid'
    });
    this.me = this.myId !== null ? this.S.byId[this.myId] : null;
    this.entries = {};
    entries.forEach(function (e) { self.entries[e.id] = e; });
    this.paused = false;
    this.ended = false;
    this.msgs = new window.Messages();
    this.fx = [];
    this.wrongT = 0;
    this.stuckT = 0;
    this.started = performance.now();
    this.views = {};
  }

  LocalGame.prototype.step = function () {
    if (this.paused) return;
    const inputs = {};
    if (this.me) inputs[this.myId] = window.Input.sample(F1.DT);
    this.S.step(inputs);
    const evs = this.S.drainEvents();
    const self = this;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (this.kind === 'attract') continue;
      if (e.k === 'end') {
        if (!this.ended) {
          this.ended = true;
          if (this.opts.onEnd) setTimeout(function () { self.opts.onEnd(self.S.results, self); }, 900);
        }
        continue;
      }
      if (e.k === 'lap' && e.id === this.myId) e.record = window.PB.offer(this.T.id, e.t, this.me.driverId);
      window.HUD.eventMessage(this.msgs, e, this.myId, function (id) { return self.S.byId[id].driverId; });
      window.GameAudio.event(e, this.myId);
    }
    const fx = this.S.drainFx();
    for (let i = 0; i < fx.length; i++) this.fx.push(fx[i]);
    if (this.me) {
      this.wrongT = F1.isWrongWay(this.me, this.T) ? this.wrongT + F1.DT : 0;
      const sp = Math.hypot(this.me.vx, this.me.vy);
      this.stuckT = sp < 2 && this.S.phase !== 'countdown' && !this.me.inPit && this.S.time > 4 ? this.stuckT + F1.DT : 0;
    }
  };

  LocalGame.prototype.view = function (c, alpha) {
    let v = this.views[c.id];
    if (!v) {
      const d = F1.driver(c.driverId);
      v = this.views[c.id] = { id: c.id, team: F1.teamOfDriver(c.driverId), code: d.id, label: d.id };
    }
    v.x = c.px + (c.x - c.px) * alpha;
    v.y = c.py + (c.y - c.py) * alpha;
    v.a = window.Renderer.lerpAngle(c.pa, c.a, alpha);
    v.vx = c.vx; v.vy = c.vy; v.delta = c.delta; v.drsOpen = c.drsOpen; v.surf = c.surf; v.lock = c.lockFx;
    v.me = this.me === c;
    v.ghost = this.type === 'quali' && !v.me;
    return v;
  };

  LocalGame.prototype.render = function (R, alpha, dt) {
    const S = this.S, T = this.T;
    const cars = [];
    for (let i = 0; i < S.cars.length; i++) if (!S.cars[i].out) cars.push(this.view(S.cars[i], this.paused ? 1 : alpha));
    let focus = this.me ? this.views[this.myId] : null;
    if (!focus && cars.length) focus = cars[0];
    const frame = { track: T, cars: cars, labels: window.Settings.data.labels, yellow: S.yellow.map(function (z) { return [z.s, z.id]; }),
      lights: S.phase === 'countdown' ? S.lights : 0, pitRed: S.phase === 'countdown' && this.type === 'race' };
    R.updateCamera(focus, dt, this.kind === 'attract' ? true : window.Settings.data.camera === 'rotate');
    for (let i = 0; i < this.fx.length; i++) {
      const f = this.fx[i];
      R.sparks(f[0], f[1], f[2]);
      if (focus) window.GameAudio.contact(f[2], Math.hypot(f[0] - focus.x, f[1] - focus.y));
    }
    this.fx = [];
    this.focus = focus;
    R.drawWorld(frame, this.paused ? 0 : dt);
    if (this.kind === 'attract') return;
    R.drawHUD(this.hud(), frame);
  };

  /* What the sound system needs this frame. */
  LocalGame.prototype.audioState = function () {
    const S = this.S, me = this.me && !this.me.out ? this.me : null, f = this.focus || me;
    if (!f) return null;
    const cars = [];
    for (let i = 0; i < S.cars.length; i++) {
      const c = S.cars[i];
      if (c === me || c.out) continue;
      cars.push({ id: c.id, x: c.x, y: c.y, vx: c.vx, vy: c.vy, throttle: c.input ? c.input.throttle : 0.7 });
    }
    let own = null;
    if (me) {
      const vf = me.vx * Math.cos(me.a) + me.vy * Math.sin(me.a);
      own = { speed: Math.hypot(me.vx, me.vy), vf: vf, throttle: me.input ? me.input.throttle || 0 : 0, inPit: !!me.inPit, surf: me.surf,
        drsOpen: me.drsOpen, drsAllowed: me.drsAllowed, locked: me.locked };
    }
    return {
      listener: { x: f.x, y: f.y, a: f.a, vx: f.vx, vy: f.vy }, own: own, cars: cars,
      lights: S.phase === 'countdown' ? S.lights : 0,
      countdown: S.type === 'quali' && S.phase === 'countdown' ? Math.max(0, Math.ceil(3 - S.time)) : 0
    };
  };

  LocalGame.prototype.hud = function () {
    const S = this.S;
    const rows = {};
    for (let i = 0; i < S.cars.length; i++) {
      const c = S.cars[i];
      rows[c.id] = { laps: c.lapsDone, last: c.lastLap, best: c.bestLap, gap: c.gap, lapStart: c.lapStart, fin: c.finished, out: c.out, qdone: c.qualiDone, dist: c.raceDist };
    }
    return window.HUD.build({
      type: this.type, laps: S.laps, track: this.T, order: S.order, rows: rows, entries: this.entries, title: this.opts.title,
      myId: this.myId, phase: PH[S.phase], lights: S.lights, time: S.time,
      timeLeft: isFinite(S.timeLimit) ? Math.max(0, S.timeLimit - S.time) : -1,
      fastestId: S.fastest ? S.fastest.id : null, own: this.me, msgs: this.msgs, ping: null,
      started: this.started, wrongT: this.wrongT, stuckT: this.stuckT,
      yellow: S.yellow.map(function (z) { return [z.s, z.id]; }), blue: !!(this.me && this.me.blue >= 0)
    });
  };

  window.LocalGame = LocalGame;
})();
