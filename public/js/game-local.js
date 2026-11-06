/* Practice mode (and the menu background), simulated entirely in the browser. */
(function () {
  'use strict';
  const F1 = window.F1;

  function LocalGame(opts) {
    this.kind = opts.attract ? 'attract' : 'practice';
    this.opts = opts;
    this.T = F1.getTrack(opts.track);
    const rng = F1.rng((Math.random() * 1e9) | 0);
    const entries = [];
    if (!opts.attract) entries.push({ id: 0, driverId: opts.driverId, isAI: false, name: 'You' });
    const pool = F1.DRIVERS.map(function (d) { return d.id; }).filter(function (id) { return id !== opts.driverId; });
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    pool.slice(0, opts.aiCount || 0).forEach(function (id) { entries.push({ id: entries.length, driverId: id, isAI: true }); });
    this.S = new F1.Session({
      type: 'practice', track: this.T, entries: entries,
      aiLevel: opts.aiLevel || 'medium', collisions: opts.collisions !== false, seed: (rng() * 1e9) | 0
    });
    this.me = opts.attract ? null : this.S.byId[0];
    this.paused = false;
    this.msgs = new window.Messages();
    this.fx = [];
    this.wrongT = 0;
    this.started = performance.now();
    this.views = {};
  }

  LocalGame.prototype.step = function () {
    if (this.paused) return;
    const inputs = {};
    if (this.me) inputs[0] = window.Input.sample(F1.DT);
    this.S.step(inputs);
    const evs = this.S.drainEvents();
    for (let i = 0; i < evs.length; i++) this.onEvent(evs[i]);
    const fx = this.S.drainFx();
    for (let i = 0; i < fx.length; i++) this.fx.push(fx[i]);
    if (this.me) this.wrongT = F1.isWrongWay(this.me, this.T) ? this.wrongT + F1.DT : 0;
  };

  LocalGame.prototype.onEvent = function (e) {
    if (!this.me || e.k !== 'lap') return;
    const c = this.S.byId[e.id];
    if (e.id === 0) {
      this.msgs.add('LAP ' + e.n + '   ' + F1.fmtLap(e.t), {
        sub: e.fastest ? 'FASTEST LAP OF THE SESSION' : e.pb ? 'PERSONAL BEST' : null,
        subColor: e.fastest ? '#c77dff' : '#19c94a', color: e.fastest ? '#9b30ff' : '#19c94a', key: 'mylap', dur: 4000
      });
    } else if (e.fastest) {
      this.msgs.add('FASTEST LAP', { sub: c.driverId + '  ' + F1.fmtLap(e.t), color: '#9b30ff', subColor: '#c77dff', key: 'fl', dur: 3000 });
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
    v.vx = c.vx; v.vy = c.vy; v.delta = c.delta; v.drsOpen = c.drsOpen; v.surf = c.surf;
    v.me = this.me === c;
    v.ghost = false;
    return v;
  };

  LocalGame.prototype.render = function (R, alpha, dt) {
    const S = this.S, T = this.T;
    const cars = [];
    for (let i = 0; i < S.cars.length; i++) if (!S.cars[i].out) cars.push(this.view(S.cars[i], this.paused ? 1 : alpha));
    let focus = this.me ? this.views[0] : null;
    if (!focus && cars.length) focus = cars[0];
    const frame = { track: T, cars: cars, labels: window.Settings.data.labels };
    R.updateCamera(focus, dt, this.kind === 'attract' ? true : window.Settings.data.camera === 'rotate');
    for (let i = 0; i < this.fx.length; i++) R.sparks(this.fx[i][0], this.fx[i][1], this.fx[i][2]);
    this.fx = [];
    R.drawWorld(frame, this.paused ? 0 : dt);
    if (this.kind === 'attract') return;
    R.drawHUD(this.hud(), frame);
  };

  LocalGame.prototype.hud = function () {
    const S = this.S, me = this.me;
    const fastestId = S.fastest ? S.fastest.id : null;
    const tower = S.order.map(function (id) {
      const c = S.byId[id];
      const t = F1.teamOfDriver(c.driverId);
      return {
        pos: c.pos, code: c.driverId, color: F1.teamUiColor(t),
        info: c.bestLap !== null ? F1.fmtLap(c.bestLap) : 'NO TIME',
        me: c === me, purple: id === fastestId
      };
    });
    const sp = Math.hypot(me.vx, me.vy) * 3.6;
    const vf = me.vx * Math.cos(me.a) + me.vy * Math.sin(me.a);
    const hint = performance.now() - this.started < 14000 ? window.controlsHint() : null;
    return {
      title: 'PRACTICE',
      towerRight: this.T.name.toUpperCase(),
      lapText: 'LAPS COMPLETED  ' + me.lapsDone,
      tower: tower,
      speed: Math.round(sp),
      gear: window.gearFor(sp, vf),
      drs: me.drsOpen ? 'open' : me.drsAllowed ? 'avail' : 'off',
      cur: me.lapStart !== null ? F1.fmtLap(S.time - me.lapStart) : 'OUT LAP',
      last: me.lastLap !== null ? F1.fmtLap(me.lastLap) : null,
      best: me.bestLap !== null ? F1.fmtLap(me.bestLap) : null,
      bestPurple: fastestId === 0,
      posText: 'P' + me.pos + ' / ' + S.cars.length,
      msgs: this.msgs.active(),
      wrongWay: this.wrongT > 1.2,
      hint: hint
    };
  };

  window.LocalGame = LocalGame;
})();
