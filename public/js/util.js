/* Settings, keyboard input and small helpers for the browser game. */
(function () {
  'use strict';
  const F1 = window.F1;

  // ------------------------------------------------------------- settings
  const Settings = {
    data: { steering: 5, camera: 'rotate', zoom: 'normal', labels: true, name: '' },
    load: function () {
      try {
        const raw = window.localStorage.getItem('topdowngp.settings');
        if (raw) Object.assign(this.data, JSON.parse(raw));
      } catch (e) { /* storage unavailable: keep defaults */ }
      this.data.steering = F1.clamp(Math.round(Number(this.data.steering) || 5), 1, 12);
      if (['close', 'normal', 'far'].indexOf(this.data.zoom) < 0) this.data.zoom = 'normal';
      if (typeof this.data.ghost !== 'boolean') this.data.ghost = true;
    },
    save: function () {
      try { window.localStorage.setItem('topdowngp.settings', JSON.stringify(this.data)); } catch (e) { /* ignore */ }
    },
    // how fast the steering input ramps up (per second) and how much lock it reaches
    steerRate: function () { return 2.4 + (this.data.steering - 1) * 0.7; },
    steerGain: function () { return 0.74 + (this.data.steering - 1) * 0.085; }
  };

  // ------------------------------------------------------------- personal bests (per track, this browser)
  const PB = {
    data: {},
    load: function () {
      try { this.data = JSON.parse(window.localStorage.getItem('topdowngp.pb') || '{}') || {}; } catch (e) { this.data = {}; }
    },
    get: function (track) {
      const r = this.data[track];
      return r && isFinite(r.t) && r.t > 0 ? r : null;
    },
    /* Returns true when lap time t beats the saved best for this track (and saves it). */
    offer: function (track, t, driverId) {
      if (!isFinite(t) || t <= 0) return false;
      const cur = this.get(track);
      if (cur && cur.t <= t) return false;
      this.data[track] = { t: Math.round(t * 1000) / 1000, d: driverId || null, at: Date.now() };
      try { window.localStorage.setItem('topdowngp.pb', JSON.stringify(this.data)); } catch (e) { /* ignore */ }
      return true;
    }
  };
  PB.load();

  // ------------------------------------------------------------- input
  const GAME_KEYS = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, KeyW: 1, KeyA: 1, KeyS: 1, KeyD: 1, Space: 1, ShiftLeft: 1, ShiftRight: 1, KeyR: 1 };
  function toward(v, t, step) { return v < t ? Math.min(t, v + step) : Math.max(t, v - step); }

  const Input = {
    keys: {},
    steer: 0,
    resetEdge: false,
    active: false,
    init: function () {
      const self = this;
      window.addEventListener('keydown', function (e) {
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        if (GAME_KEYS[e.code] && self.active) e.preventDefault();
        if (e.code === 'KeyR' && !e.repeat) self.resetEdge = true;
        self.keys[e.code] = true;
      });
      window.addEventListener('keyup', function (e) { self.keys[e.code] = false; });
      window.addEventListener('blur', function () { self.keys = {}; });
    },
    sample: function (dt) {
      const k = this.keys;
      const left = k.ArrowLeft || k.KeyA, right = k.ArrowRight || k.KeyD;
      const target = (right ? 1 : 0) - (left ? 1 : 0);
      const rate = Settings.steerRate(), ret = rate * 1.8;
      let s = this.steer;
      if (target === 0) s = toward(s, 0, ret * dt);
      else if (s !== 0 && Math.sign(s) !== target) s = toward(s, target, (rate + ret) * dt);
      else s = toward(s, target, rate * dt);
      this.steer = s;
      const out = {
        throttle: k.ArrowUp || k.KeyW ? 1 : 0,
        brake: k.ArrowDown || k.KeyS ? 1 : 0,
        steer: s * Settings.steerGain(),
        drs: !!(k.ShiftLeft || k.ShiftRight || k.Space),
        reset: this.resetEdge
      };
      this.resetEdge = false;
      return out;
    }
  };

  // ------------------------------------------------------------- on-screen messages
  function Messages() { this.list = []; }
  Messages.prototype.add = function (text, opts) {
    opts = opts || {};
    const now = performance.now();
    if (opts.key) this.list = this.list.filter(function (m) { return m.key !== opts.key; });
    this.list.push({ text: text, sub: opts.sub, color: opts.color, subColor: opts.subColor, big: opts.big, sign: opts.sign, key: opts.key, until: now + (opts.dur || 3000), start: now });
    if (this.list.length > 3) this.list.shift();
  };
  Messages.prototype.active = function () {
    const now = performance.now();
    this.list = this.list.filter(function (m) { return m.until > now; });
    return this.list.map(function (m) {
      const left = m.until - now;
      return { text: m.text, sub: m.sub, color: m.color, subColor: m.subColor, big: m.big, sign: m.sign, alpha: Math.min(1, left / 400) };
    });
  };

  function gearFor(kmh, vf) {
    if (vf < -0.5) return 'R';
    if (kmh < 2) return 'N';
    const th = [0, 82, 122, 158, 192, 226, 262, 298];
    let g = 1;
    for (let i = 1; i < th.length; i++) if (kmh >= th[i]) g = i + 1;
    return String(g);
  }

  function controlsHint() {
    return [
      '↑ / W  throttle      ↓ / S  brake / reverse',
      '← → / A D  steer     Shift / Space  DRS',
      'R  reset car         Esc / P  pause'
    ];
  }

  window.Settings = Settings;
  window.PB = PB;
  window.Input = Input;
  window.Messages = Messages;
  window.gearFor = gearFor;
  window.controlsHint = controlsHint;
})();
