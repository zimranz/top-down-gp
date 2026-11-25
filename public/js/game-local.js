/* Sessions simulated entirely in the browser: practice, time trial, Grand Prix (qualifying + race; also each round of
   a championship) and the menu background. */
(function () {
  'use strict';
  const F1 = window.F1;
  const PH = { countdown: 0, running: 1, finishing: 2, done: 3 };

  /* opts: { attract, type: 'practice'|'quali'|'race', track, driverId, aiCount, aiDrivers, grid, aiLevel, collisions, laps, onEnd,
     daily (a daily challenge), session (the session's own options, for a daily challenge) } */
  function LocalGame(opts) {
    this.kind = opts.attract ? 'attract' : 'local';
    this.type = opts.type || 'practice';
    this.tt = !!opts.tt;               // time trial: just you and your ghost
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
    const so = {
      type: this.type, track: this.T, entries: entries, laps: opts.laps || 0,
      aiLevel: opts.aiLevel || 'medium', collisions: this.type === 'practice' ? opts.collisions !== false : true,
      drafting: opts.drafting !== false, runs: this.type === 'practice' && !opts.attract && !this.tt,
      tyres: !opts.attract && !this.tt && opts.tyres === true, weather: !opts.attract && !this.tt && opts.weather === true,
      seed: (rng() * 1e9) | 0, startMode: this.tt ? 'flying' : this.type === 'practice' && !opts.attract ? 'pit' : 'grid'
    };
    if (opts.session) Object.assign(so, opts.session);       // (a daily challenge sets the session up its own way)
    this.S = new F1.Session(so);
    this.me = this.myId !== null ? this.S.byId[this.myId] : null;
    this.entries = {};
    entries.forEach(function (e) { self.entries[e.id] = e; });
    this.paused = false;
    this.resumeT = 0;                  // after Resume: a 3-2-1 countdown with the game still frozen
    this.ended = false;
    this.msgs = new window.Messages();
    this.sectors = new window.SectorTracker(this.T.id);
    this.fx = [];
    this.wrongT = 0;
    this.stuckT = 0;
    this.started = performance.now();
    this.views = {};
    // ghost car: your laps are recorded; in practice your best saved lap on this track is replayed
    this.rec = this.me ? new window.GhostRecorder() : null;
    this.ghost = undefined;            // loaded when first needed
    this.ghostView = null;
    // a daily challenge: where the clock starts and stops, and the result (daily.js)
    this.run = opts.daily && window.DailyRun ? new window.DailyRun(this, opts.daily) : null;
  }

  /* The saved ghost lap to show in this session (practice only, if switched on in Settings). */
  LocalGame.prototype.ghostLap = function () {
    if (this.type !== 'practice' || !this.me || this.run || (!this.tt && !window.Settings.data.ghost)) return null;
    if (this.ghost === undefined) this.ghost = window.Ghost.load(this.T.id);
    return this.ghost;
  };

  /* A lap of lapT seconds just finished: keep it as the ghost if it beats the saved one. */
  LocalGame.prototype.saveGhost = function (lapT) {
    if (!this.rec || this.run) return;
    const saved = window.Ghost.load(this.T.id);
    if (saved && saved.t <= lapT) return;
    const t1 = this.me.lapStart !== null ? this.me.lapStart : this.S.time;
    const p = this.rec.lap(t1 - lapT, t1);
    if (!p) return;
    const g = { t: lapT, d: this.me.driverId, p: p };
    window.Ghost.save(this.T.id, g);
    this.ghost = g;
    this.ghostView = null;
  };

  /* End your practice or qualifying now. Qualifying: your best lap stands and the other drivers finish their
     runs at high speed in the background (onProgress gets 0..1). */
  LocalGame.prototype.endEarly = function (onProgress) {
    const S = this.S, self = this;
    if (S.phase === 'done' || this.ff) return;
    if (this.type !== 'quali') { S.finish(); return; }
    S.park(this.myId);
    this.ff = true;
    const ai = S.cars.filter(function (c) { return c.isAI && !c.out; });
    const chunk = function () {
      const t0 = performance.now();
      while (S.phase !== 'done' && performance.now() - t0 < 25) self.step(true);
      if (onProgress) onProgress(ai.length ? ai.filter(function (c) { return c.qualiDone; }).length / ai.length : 1);
      if (S.phase !== 'done') setTimeout(chunk, 0);
    };
    chunk();
  };

  /* Resume after a pause: the game stays frozen for 3 seconds (3, 2, 1) so you can see where you are first. */
  LocalGame.prototype.startResume = function () {
    this.paused = true;
    this.resumeT = 3;
    this.resumeShown = 0;
  };
  LocalGame.prototype.cancelResume = function () { this.resumeT = 0; };
  LocalGame.prototype.tickResume = function (dt) {
    if (!(this.resumeT > 0)) return;
    this.resumeT -= dt;
    const n = Math.ceil(this.resumeT);
    if (this.resumeT > 0 && n !== this.resumeShown) { this.resumeShown = n; window.GameAudio.countdown(); }
    if (this.resumeT <= 0) { this.resumeT = 0; this.paused = false; window.GameAudio.go(); }
  };

  LocalGame.prototype.step = function (fast) {
    if (this.paused || (this.ff && !fast)) return;
    const inputs = {};
    if (this.me) {
      inputs[this.myId] = window.Input.sample(F1.DT);
      if (this.goOut) { inputs[this.myId].garageOut = true; this.goOut = false; }    // the garage's "Go back out" button
    }
    this.S.step(inputs);
    if (this.rec && !this.me.out) this.rec.sample(this.S.time, this.me);
    const evs = this.S.drainEvents();
    const self = this;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (this.kind === 'attract' || (this.ff && e.k !== 'end')) continue;
      if (e.k === 'end') {
        if (!this.ended) {
          this.ended = true;
          if (this.opts.onEnd) setTimeout(function () { self.opts.onEnd(self.S.results, self); }, 900);
        }
        continue;
      }
      if (e.k === 'sec' && e.id === this.myId) this.sectors.onSector(e, this.msgs);
      if (e.k === 'lap' && e.id === this.myId) {
        e.record = window.PB.offer(this.T.id, e.t, this.me.driverId, e.pen ? null : e.sec);
        this.sectors.onLap(e);
        if (this.tt) e.ttRank = window.TTBoard.offer(this.T.id, e.t, this.me.driverId);
        this.saveGhost(e.t);
      }
      window.HUD.eventMessage(this.msgs, e, this.myId, function (id) { return self.S.byId[id].driverId; });
      window.GameAudio.event(e, this.myId);
      if (window.Haptics && this.kind !== 'attract') window.Haptics.event(e);
    }
    if (this.run) this.run.step(evs);
    const fx = this.S.drainFx();
    for (let i = 0; i < fx.length; i++) this.fx.push(fx[i]);
    if (this.me) {
      if (this.T.bank && this.kind !== 'attract' && !this.ff) window.HUD.bankHint(this.T, this.me, this.msgs, this.bankSeen || (this.bankSeen = {}));
      // (not while the garage panel is up: it would hide the message)
      if (this.T.airDown < 1 && this.kind !== 'attract' && !this.ff && !this.garageState()) window.HUD.airHint(this.T, this.msgs, this.airSeen || (this.airSeen = {}), this.S.time);
      this.wrongT = F1.isWrongWay(this.me, this.T) ? this.wrongT + F1.DT : 0;
      const sp = Math.hypot(this.me.vx, this.me.vy);
      this.stuckT = sp < 2 && this.S.phase !== 'countdown' && !this.me.inPit && !this.me.gar && this.S.time > 4 ? this.stuckT + F1.DT : 0;
    }
  };

  /* The race behind the menus, joined somewhere mid-race: the cars at racing speed in a pack at a random point of the
     lap, in a random order, some side by side (a pass under way). */
  LocalGame.prototype.placeMidRace = function () {
    const S = this.S, T = this.T, L = T.length, prof = F1.speedProfile(T, 'hard'), Q = { idx: 0, s: 0, d: 0, dist: 0 };
    const cars = S.cars.slice();
    for (let i = cars.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = cars[i]; cars[i] = cars[j]; cars[j] = t; }
    let s = Math.random() * L, dist = 0, prevD = null;
    for (let k = 0; k < cars.length; k++) {
      const c = cars[k];
      let side = false;
      if (k) {
        side = Math.random() < 0.3;                                    // alongside the car ahead (a pass under way)
        const gap = side ? 2 + Math.random() * 3 : 9 + Math.random() * 24;
        s -= gap; dist += gap;
      }
      let sw = F1.wrapS(s, L), i = F1.idxAt(T, sw);
      const room = Math.max(0.5, T.hwE[i] - 1.4);
      let d = T.rlOff[i] + (Math.random() - 0.5) * 1.2;
      if (side && prevD !== null) d = prevD > T.rlOff[i] ? prevD - 3.3 : prevD + 3.3;
      if (side && Math.abs(d) > room) {                               // (no room alongside here: drop in behind)
        side = false; s -= 9; dist += 9;
        sw = F1.wrapS(s, L); i = F1.idxAt(T, sw); d = T.rlOff[i];
      }
      const room2 = Math.max(0.5, T.hwE[i] - 1.4);
      d = Math.max(-room2, Math.min(room2, d));
      const p = F1.trackPoint(T, sw, d), a = T.hd[i], v = prof[i] * (0.92 + Math.random() * 0.05) * (side ? 1.02 : 1);
      c.x = p.x; c.y = p.y; c.a = a; c.vx = Math.cos(a) * v; c.vy = Math.sin(a) * v;
      c.px = c.x; c.py = c.y; c.pa = c.a;
      F1.queryTrack(T, c.x, c.y, -1, Q);
      c.seg = Q.idx; c.s = Q.s; c.d = Q.d; c.dist = Q.dist; c.prevS = c.s; c.raceDist = 100000 - dist;
      if (c.ai) { c.ai.latT = c.d; c.ai.bias = c.d - T.rlOff[c.seg]; }
      prevD = d;
    }
  };
  /* The race behind the menus follows a car in the thick of it: on the grid, one from the middle of the field;
     mid-race, the car closest behind another (a fight for position). */
  LocalGame.prototype.pickAttractCar = function (onGrid) {
    const cars = this.S.cars.filter(function (c) { return !c.out; }).sort(function (a, b) { return b.raceDist - a.raceDist; });
    if (!cars.length) return;
    if (onGrid) { this.attractId = cars[Math.min(cars.length - 1, 3 + Math.floor(Math.random() * 4))].id; return; }
    // the car closest behind another one (measured along the track, so it works anywhere on the lap)
    const L = this.T.length;
    let best = cars[0], gap = Infinity;
    for (const c of cars) for (const o of cars) {
      if (o === c) continue;
      let d = o.s - c.s; d -= L * Math.round(d / L);
      if (d > 0 && d < gap) { gap = d; best = c; }
    }
    this.attractId = best.id;
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
    v.tyreC = this.tyresShown() && c.tyre ? c.tyre.c : null;          // (coloured sidewalls)
    v.me = this.me === c;
    v.ghost = this.type === 'quali' && !v.me;
    v.lvl = this.T.bridge ? F1.levelAt(this.T, c.s) : 0;      // on / under a bridge (drawing order)
    return v;
  };

  LocalGame.prototype.render = function (R, alpha, dt) {
    const S = this.S, T = this.T;
    const cars = [], garage = [];
    for (let i = 0; i < S.cars.length; i++) {
      const c = S.cars[i];
      if (c.out) continue;
      const v = this.view(c, alpha);
      v.garage = !!c.gar;                    // in the garage or rolling in / out: drawn under the garage roof
      if (v.garage) garage.push(v); else cars.push(v);
    }
    let focus = this.me && !this.me.out ? this.views[this.myId] : null;
    // (the race behind the menus: the car picked to follow; if it drops out, another one in a fight for position)
    if (!focus && this.attractId !== undefined) {
      if (!S.byId[this.attractId] || S.byId[this.attractId].out) this.pickAttractCar(false);
      if (S.byId[this.attractId] && !S.byId[this.attractId].out) focus = this.views[this.attractId];
    }
    if (!focus && cars.length) focus = cars[0];
    // the ghost runs from the moment you start a timed lap
    const g = this.ghostLap();
    if (g && this.me.lapStart !== null && !this.me.out && !this.me.inPit) {
      const t = S.time - (1 - alpha) * F1.DT - this.me.lapStart;
      const gv = this.ghostView || (this.ghostView = { id: 'ghost', team: F1.teamOfDriver(g.d || this.me.driverId), code: 'GHOST', label: 'GHOST',
        ghost: true, replay: true, me: false, delta: 0, drsOpen: false, surf: 0 });
      if (window.ghostAt(g, t, gv)) cars.unshift(gv);
    }
    const frame = { track: T, cars: cars, garage: garage, labels: window.Settings.data.labels,
      lights: S.phase === 'countdown' ? S.lights : 0, pitRed: S.phase === 'countdown' && this.type === 'race',
      weather: S.weatherOn ? { rain: S.rain, wet: S.wet, ld: S.lineDry } : null };
    // behind the menus the picture turns with the track, not with the car (a car pulling out of its grid slot or changing
    // lanes does not swing the whole screen one way and back)
    let camFocus = focus;
    if (this.kind === 'attract' && focus && S.byId[focus.id]) {
      const cf = this.camFocus || (this.camFocus = {});
      cf.x = focus.x; cf.y = focus.y; cf.vx = focus.vx; cf.vy = focus.vy;
      // (the track's direction a little ahead of the car, taken from where the car is in this very picture and
      // blended between the track's points: it turns smoothly, not in small steps from one point to the next)
      const sc = S.byId[focus.id], L = T.length;
      let ds = sc.s - (sc.prevS === undefined ? sc.s : sc.prevS);
      if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
      cf.a = F1.trackPoint(T, sc.s - ds * (1 - alpha) + 12, 0).h;
      camFocus = cf;
    }
    R.updateCamera(camFocus, dt, this.kind === 'attract' ? true : window.Settings.data.camera === 'rotate', this.kind === 'attract' ? 'normal' : window.Settings.data.zoom);
    for (let i = 0; i < this.fx.length; i++) {
      const f = this.fx[i];
      R.sparks(f[0], f[1], f[2]);
      if (focus) window.GameAudio.contact(f[2], Math.hypot(f[0] - focus.x, f[1] - focus.y));
      if (focus && focus.me && window.Haptics) window.Haptics.hit(f[2], Math.hypot(f[0] - focus.x, f[1] - focus.y));
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
    const grid = S.type === 'race' && S.phase === 'countdown';
    for (let i = 0; i < S.cars.length; i++) {
      const c = S.cars[i];
      if (c === me || c.out) continue;
      // on the grid the other cars rev their engines while the lights come on
      const thr = grid ? window.GameAudio.gridRev(c.id, S.time) : c.input ? c.input.throttle : 0.7;
      cars.push({ id: c.id, x: c.x, y: c.y, vx: c.vx, vy: c.vy, throttle: thr });
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
      countdown: S.type === 'quali' && S.phase === 'countdown' ? Math.max(0, Math.ceil(3 - S.time)) : 0,
      wx: S.weatherOn ? { rain: S.rain, wet: S.wet * (1 - 0.5 * S.lineDry) } : null      // (a dry line throws up less spray)
    };
  };

  LocalGame.prototype.hud = function () {
    const S = this.S;
    const rows = {};
    for (let i = 0; i < S.cars.length; i++) {
      const c = S.cars[i];
      rows[c.id] = { laps: c.lapsDone, last: c.lastLap, best: c.bestLap, gap: c.gap, lapStart: c.lapStart, fin: c.finished, out: c.out, qdone: c.qualiDone, dist: c.raceDist, pen: c.penalty,
        gar: !!c.gar, pit: !c.gar && (c.inPit || !!(c.pitPlan && c.pitPlan.entered)), ty: c.tyre.c, tw: c.tyre.w, st: c.stops };
    }
    // live gap to the ghost (time trial, and practice when the ghost is on)
    let delta = null;
    const me = this.me, g = this.ghostLap();
    if (g && me && !me.out && !me.inPit && me.lapStart !== null) {
      const lapT = S.time - me.lapStart;
      if (lapT > 1.5 && !(me.s > this.T.length * 0.8 && lapT < 10)) delta = lapT - window.ghostTimeAtS(g, this.T, me.s);
    }
    const hud = window.HUD.build({
      type: this.type, laps: S.laps, track: this.T, order: S.order, rows: rows, entries: this.entries, title: this.opts.title, delta: delta,
      gaps: this.type === 'race' ? (this.gapT || (this.gapT = new window.HUD.GapTracker())) : null,
      myId: this.myId, phase: PH[S.phase], lights: S.lights, time: S.time,
      timeLeft: isFinite(S.timeLimit) ? Math.max(0, S.timeLimit - S.time) : -1,
      fastestId: S.fastest ? S.fastest.id : null, own: this.me, msgs: this.msgs, tyres: S.tyres, tyresShow: this.tyresShown(),
      weather: S.weatherOn ? { rain: S.rain, wet: S.wet, ld: S.lineDry } : null,
      started: this.started, wrongT: this.wrongT, stuckT: this.stuckT, sectors: this.sectors.view()
    });
    if (this.resumeT > 0) { hud.resume = Math.ceil(this.resumeT); hud.hint = null; }
    return hud;
  };

  /* Your car parked in your garage (practice and qualifying): what the garage panel shows. null = not parked. */
  LocalGame.prototype.garageState = function () {
    const me = this.me;
    if (!me || me.out || !me.gar || me.gar.k !== 'park' || this.kind !== 'local' || this.run) return null;
    return { best: me.bestLap, pos: me.pos, laps: me.lapsDone, n: this.S.cars.length, first: !me.gMoved,
      tyres: this.tyresShown() ? { cur: me.tyreNext || this.S.defaultTyre(me), opts: this.tyreOpts() } : null };
  };

  /* Tyres. Shown when they matter: tyre wear on (or rain). The choice: the dry tyres, and the rain ones when the weather is on. */
  LocalGame.prototype.tyresShown = function () { return !!(this.S.tyres || this.S.weatherOn); };
  LocalGame.prototype.tyreOpts = function () { return this.S.weatherOn ? F1.TYRE_KEYS.slice() : ['S', 'M', 'H']; };
  LocalGame.prototype.pickTyre = function (k) { if (this.me && this.kind === 'local') this.S.setTyreChoice(this.myId, k); };
  /* The tyre picker in a race: on the grid before the start (tyre wear on), and while the car is brought in for a pit
     stop; then the stop itself. null = nothing to show. */
  LocalGame.prototype.tyreState = function () {
    const S = this.S, me = this.me;
    if (!me || me.out || this.kind !== 'local' || S.type !== 'race') return null;
    if (S.phase === 'countdown') return S.gridT > 0 ? { mode: 'grid', cur: me.tyre.c, opts: this.tyreOpts(), must: S.mustStop, laps: S.laps, wet: S.lineWet(), wear: S.tyres } : null;
    if (me.finished) return null;
    if (me.pitStop) return { mode: 'stop', cur: me.pitStop.k, left: me.pitStop.t0 + me.pitStop.dur - S.time };
    if (me.pitPlan && me.pitPlan.entered && me.pitPlan.stage === 'in') return { mode: 'pit', cur: me.tyreNext || S.defaultTyre(me), opts: this.tyreOpts(), left: S.laps - me.lapsDone };
    return null;
  };

  window.LocalGame = LocalGame;
})();
