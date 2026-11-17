/* Settings, keyboard input and small helpers for the browser game. */
(function () {
  'use strict';
  const F1 = window.F1;

  // ------------------------------------------------------------- settings
  const Settings = {
    data: { steering: 5, camera: 'rotate', zoom: 'normal', labels: true, name: '', units: 'kmh', touchSteer: 5 },
    load: function () {
      try {
        const raw = window.localStorage.getItem('topdowngp.settings');
        if (raw) Object.assign(this.data, JSON.parse(raw));
      } catch (e) { /* storage unavailable: keep defaults */ }
      this.data.steering = F1.clamp(Math.round(Number(this.data.steering) || 5), 1, 12);
      if (['close', 'normal', 'far'].indexOf(this.data.zoom) < 0) this.data.zoom = 'normal';
      if (typeof this.data.ghost !== 'boolean') this.data.ghost = true;
      if (this.data.units !== 'mph') this.data.units = 'kmh';
      this.data.touchSteer = F1.clamp(Math.round(Number(this.data.touchSteer) || 5), 1, 10);
      if (this.data.touchMode !== 'slide') this.data.touchMode = 'arrows';      // phones: arrow buttons unless the slider was chosen
      this.data.keys = cleanKeys(this.data.keys);
    },
    save: function () {
      try { window.localStorage.setItem('topdowngp.settings', JSON.stringify(this.data)); } catch (e) { /* ignore */ }
    },
    // how fast the steering input ramps up (per second) and how much lock it reaches
    steerRate: function () { return 2.4 + (this.data.steering - 1) * 0.7; },
    steerGain: function () { return 0.74 + (this.data.steering - 1) * 0.085; },
    // phones (arrow buttons): the same feel as the keys, from the touch sensitivity 1-10 (5 = the keys' default)
    touchKeyEq: function () { return [1, 2, 3, 4, 5, 6.4, 7.8, 9.2, 10.6, 12][F1.clamp(Math.round(Number(this.data.touchSteer)) || 5, 1, 10) - 1]; },
    touchRate: function () { return 2.4 + (this.touchKeyEq() - 1) * 0.7; },
    touchGain: function () { return 0.74 + (this.touchKeyEq() - 1) * 0.085; }
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
    /* Returns true when lap time t beats the saved best for this track (and saves it, with that lap's
       three sector times when they are known). */
    offer: function (track, t, driverId, sec) {
      if (!isFinite(t) || t <= 0) return false;
      const cur = this.get(track);
      if (cur && cur.t <= t) return false;
      this.data[track] = { t: Math.round(t * 1000) / 1000, d: driverId || null, at: Date.now() };
      if (sec && sec.length === 3 && sec.every(function (v) { return isFinite(v) && v > 0; })) this.data[track].sec = sec.slice();
      try { window.localStorage.setItem('topdowngp.pb', JSON.stringify(this.data)); } catch (e) { /* ignore */ }
      return true;
    }
  };
  PB.load();

  // ------------------------------------------------------------- career (your records across every mode, this browser)
  /* { v, since, races, wins, podiums, poles, fl (fastest laps), points, laps, seasons (championships finished),
       titles (championships won), online: { races, wins, podiums }, tracks: { id: { races, wins, podiums, best } } } */
  const Career = {
    data: null,
    blank: function () {
      return { v: 1, since: Date.now(), races: 0, wins: 0, podiums: 0, poles: 0, fl: 0, points: 0, laps: 0, seasons: 0, titles: 0,
        online: { races: 0, wins: 0, podiums: 0 }, tracks: {} };
    },
    load: function () {
      const d = this.blank();
      try {
        const o = JSON.parse(window.localStorage.getItem('topdowngp.career') || 'null');
        if (o && typeof o === 'object') {
          ['since', 'races', 'wins', 'podiums', 'poles', 'fl', 'points', 'laps', 'seasons', 'titles'].forEach(function (k) { if (isFinite(o[k]) && o[k] >= 0) d[k] = Math.floor(o[k]); });
          if (o.online) ['races', 'wins', 'podiums'].forEach(function (k) { if (isFinite(o.online[k]) && o.online[k] >= 0) d.online[k] = Math.floor(o.online[k]); });
          if (o.tracks && typeof o.tracks === 'object') Object.keys(o.tracks).forEach(function (id) {
            const t = o.tracks[id];
            if (t && F1.TRACK_DEFS[id]) d.tracks[id] = { races: Math.floor(t.races) || 0, wins: Math.floor(t.wins) || 0, podiums: Math.floor(t.podiums) || 0, best: t.best > 0 ? Math.floor(t.best) : 0 };
          });
        }
      } catch (e) { /* keep the blank career */ }
      this.data = d;
      return d;
    },
    save: function () { try { window.localStorage.setItem('topdowngp.career', JSON.stringify(this.data)); } catch (e) { /* ignore */ } },
    /* A race you finished or retired from: { track, pos, out, fl, pts, laps, online } */
    race: function (o) {
      const d = this.load(), t = d.tracks[o.track] || (d.tracks[o.track] = { races: 0, wins: 0, podiums: 0, best: 0 });
      const win = !o.out && o.pos === 1, pod = !o.out && o.pos <= 3;
      d.races++; t.races++;
      if (win) { d.wins++; t.wins++; }
      if (pod) { d.podiums++; t.podiums++; }
      if (!o.out && (!t.best || o.pos < t.best)) t.best = o.pos;
      if (o.fl) d.fl++;
      d.points += o.pts || 0;
      d.laps += o.laps || 0;
      if (o.online) { d.online.races++; if (win) d.online.wins++; if (pod) d.online.podiums++; }
      this.save();
    },
    pole: function () { const d = this.load(); d.poles++; this.save(); },
    /* A championship you raced to the end (single-player or online). */
    season: function (won) { const d = this.load(); d.seasons++; if (won) d.titles++; this.save(); }
  };

  // ------------------------------------------------------------- input
  /* Driving keys can be changed in Settings: two keys for each action. Left and right Shift count as one key. */
  const KEY_ACTIONS = ['left', 'right', 'accel', 'brake', 'drs'];
  const DEFAULT_KEYS = { left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'], accel: ['ArrowUp', 'KeyW'], brake: ['ArrowDown', 'KeyS'], drs: ['ShiftLeft', 'Space'] };
  // keys that already have a job in the game
  const RESERVED = { Escape: 'pausing', KeyP: 'pausing', KeyM: 'the sound', KeyF: 'full screen', KeyC: 'the camera', KeyR: 'putting the car back on track',
    Tab: 'moving between buttons', Enter: 'pressing buttons' };
  function normKey(code) { return code === 'ShiftRight' ? 'ShiftLeft' : code; }
  /* Why a key cannot be a driving key (null = it can). */
  function keyBlocked(code) {
    if (RESERVED[code]) return 'That key is used for ' + RESERVED[code];
    if (/^(Control|Alt|Meta|OS)/.test(code) || /^F\d+$/.test(code) || /^(ContextMenu|CapsLock|NumLock|ScrollLock|PrintScreen|Pause)$/.test(code) || !code || code === 'Unidentified') {
      return 'That key is used by the browser or the computer';
    }
    return null;
  }
  const KEY_NAMES = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', ShiftLeft: 'Shift', Comma: ',', Period: '.', Slash: '/', Semicolon: ';',
    Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', Backspace: 'Backspace', Delete: 'Del', Insert: 'Ins',
    Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn', IntlBackslash: '\\', NumpadEnter: 'Num Enter', NumpadAdd: 'Num +', NumpadSubtract: 'Num -',
    NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadDecimal: 'Num .' };
  function keyName(code) {
    if (!code) return '—';
    if (KEY_NAMES[code]) return KEY_NAMES[code];
    let m = /^Key([A-Z])$/.exec(code); if (m) return m[1];
    m = /^Digit(\d)$/.exec(code); if (m) return m[1];
    m = /^Numpad(\d)$/.exec(code); if (m) return 'Num ' + m[1];
    return code;
  }
  /* Saved key choices, checked: two slots per action, no reserved keys, no key used twice. */
  function cleanKeys(k) {
    const out = {}, used = {};
    KEY_ACTIONS.forEach(function (a) {
      const src = k && Array.isArray(k[a]) ? k[a] : DEFAULT_KEYS[a];
      out[a] = [0, 1].map(function (i) {
        const c = typeof src[i] === 'string' ? normKey(src[i]) : null;
        if (!c || keyBlocked(c) || used[c]) return null;
        used[c] = true;
        return c;
      });
    });
    return out;
  }
  const KeyBind = {
    ACTIONS: KEY_ACTIONS,
    LABELS: { left: 'Steer left', right: 'Steer right', accel: 'Accelerate', brake: 'Brake / reverse', drs: 'DRS' },
    name: keyName, blocked: keyBlocked, norm: normKey,
    get: function (action) { return Settings.data.keys[action]; },
    /* Give an action's slot a key (null empties it). A key used elsewhere moves here. */
    set: function (action, slot, code) {
      const K = Settings.data.keys;
      if (code) KEY_ACTIONS.forEach(function (a) { for (let i = 0; i < 2; i++) if (K[a][i] === code) K[a][i] = null; });
      K[action][slot] = code || null;
      Settings.save();
    },
    reset: function () { Settings.data.keys = cleanKeys(null); Settings.save(); },
    isDefault: function () { return JSON.stringify(Settings.data.keys) === JSON.stringify(cleanKeys(null)); },
    /* 'Shift / Space' for an action ('—' when it has no key). */
    label: function (action) {
      const b = Settings.data.keys[action].filter(function (c) { return !!c; }).map(keyName);
      return b.length ? b.join(' / ') : '—';
    },
    /* '← → / A D' for steering. */
    steerLabel: function () {
      const L = Settings.data.keys.left, R = Settings.data.keys.right, parts = [];
      for (let i = 0; i < 2; i++) if (L[i] || R[i]) parts.push(keyName(L[i]) + ' ' + keyName(R[i]));
      return parts.length ? parts.join(' / ') : '—';
    }
  };

  function toward(v, t, step) { return v < t ? Math.min(t, v + step) : Math.max(t, v - step); }
  const TOUCH_GAIN = 1.15;       // steering at full slide (about the same as the keyboard at its default setting)

  const Input = {
    keys: {},
    steer: 0,
    resetEdge: false,
    active: false,
    // on-screen controls (phones and tablets), filled in by touch.js
    touch: { active: false, mode: 'arrows', steer: 0, dir: 0, arw: 0, held: false, out: 0, throttle: 0, brake: 0, drs: false, drsTap: false },
    init: function () {
      const self = this;
      window.addEventListener('keydown', function (e) {
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        const code = normKey(e.code);
        if (self.active && (code === 'KeyR' || self.bound(code))) e.preventDefault();
        if (code === 'KeyR' && !e.repeat) self.resetEdge = true;
        self.keys[code] = true;
      });
      window.addEventListener('keyup', function (e) { self.keys[normKey(e.code)] = false; });
      window.addEventListener('blur', function () { self.keys = {}; });
    },
    bound: function (code) {
      const K = Settings.data.keys;
      for (let a = 0; a < KEY_ACTIONS.length; a++) { const b = K[KEY_ACTIONS[a]]; if (b[0] === code || b[1] === code) return true; }
      return false;
    },
    down: function (action) {
      const b = Settings.data.keys[action], k = this.keys;
      return !!((b[0] && k[b[0]]) || (b[1] && k[b[1]]));
    },
    sample: function (dt) {
      const left = this.down('left'), right = this.down('right');
      const target = (right ? 1 : 0) - (left ? 1 : 0);
      const rate = Settings.steerRate(), ret = rate * 1.8;
      let s = this.steer;
      if (target === 0) s = toward(s, 0, ret * dt);
      else if (s !== 0 && Math.sign(s) !== target) s = toward(s, target, (rate + ret) * dt);
      else s = toward(s, target, rate * dt);
      this.steer = s;
      const out = {
        throttle: this.down('accel') ? 1 : 0,
        brake: this.down('brake') ? 1 : 0,
        steer: s * Settings.steerGain(),
        drs: this.down('drs'),
        reset: this.resetEdge
      };
      // phone / tablet: the arrow buttons work like the arrow keys (the steering builds up while you hold one);
      // the slider steers directly (it follows the slide almost at once). The pedals and the DRS button add to the keys.
      const t = this.touch;
      if (t.active) {
        if (t.mode === 'slide') {
          t.arw = 0;
          t.out = toward(t.out, t.held ? t.steer : 0, (t.held ? 12 : 14) * dt);
          if (target === 0 && s === 0) out.steer = t.out * TOUCH_GAIN;
        } else {
          const tr = Settings.touchRate(), tret = tr * 1.8, d = t.dir;
          let a = t.arw;
          if (d === 0) a = toward(a, 0, tret * dt);
          else if (a !== 0 && Math.sign(a) !== d) a = toward(a, d, (tr + tret) * dt);
          else a = toward(a, d, tr * dt);
          t.arw = a; t.out = a;
          if (target === 0 && s === 0) out.steer = a * Settings.touchGain();
        }
        if (t.throttle > out.throttle) out.throttle = t.throttle;
        if (t.brake > out.brake) out.brake = t.brake;
        if (t.drs || t.drsTap) out.drs = true;
        t.drsTap = false;
      }
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
    const pad = function (t, n) { while (t.length < n) t += ' '; return t; };
    return [
      pad(KeyBind.label('accel') + '  throttle', 22) + KeyBind.label('brake') + '  brake / reverse',
      pad(KeyBind.steerLabel() + '  steer', 22) + KeyBind.label('drs') + '  DRS',
      pad('R  reset car', 22) + 'Esc / P  pause'
    ];
  }

  window.Settings = Settings;
  window.PB = PB;
  window.Input = Input;
  window.KeyBind = KeyBind;
  window.Career = Career;
  window.Messages = Messages;
  window.gearFor = gearFor;
  window.controlsHint = controlsHint;
})();
