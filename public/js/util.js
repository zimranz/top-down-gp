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
      this.data.steering = F1.clamp(Math.round(Number(this.data.steering) || 5), 1, 15);
      if (['close', 'normal', 'far'].indexOf(this.data.zoom) < 0) this.data.zoom = 'normal';
      if (typeof this.data.ghost !== 'boolean') this.data.ghost = true;
      if (this.data.units !== 'mph') this.data.units = 'kmh';
      this.data.touchSteer = F1.clamp(Math.round(Number(this.data.touchSteer) || 5), 1, 10);
      if (this.data.touchMode !== 'slide') this.data.touchMode = 'arrows';      // phones: arrow buttons unless the slider was chosen
      if (['auto', 'sharp', 'light'].indexOf(this.data.graphics) < 0) this.data.graphics = 'auto';   // lighter graphics: by itself / never / always
      if (this.data.vibrate !== 'off') this.data.vibrate = 'on';                                      // phones: a buzz on contact, kerbs, lights out
      this.data.keys = cleanKeys(this.data.keys);
    },
    save: function () {
      try { window.localStorage.setItem('topdowngp.settings', JSON.stringify(this.data)); } catch (e) { /* ignore */ }
    },
    // how fast the steering input ramps up (per second) and how much lock it reaches (sensitivity 1-15; 13-15 carry on
    // the same steps as 1-12, so each one is a little quicker again)
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
      if (cur && cur.t - t >= 1) Ach.unlock(['ghost']);
      Ach.refresh();
      return true;
    }
  };
  PB.load();

  // ------------------------------------------------------------- career (your records across every mode, this browser)
  /* { v, since, races, wins, podiums, poles, fl (fastest laps), points, laps, seasons (championships finished),
       titles (championships won), time (seconds played), online: { races, wins, podiums },
       tracks: { id: { races, wins, podiums, best, time } } } */
  const Career = {
    data: null,
    blank: function () {
      return { v: 1, since: Date.now(), races: 0, wins: 0, podiums: 0, poles: 0, fl: 0, points: 0, laps: 0, seasons: 0, titles: 0, time: 0,
        online: { races: 0, wins: 0, podiums: 0 }, tracks: {} };
    },
    load: function () {
      const d = this.blank();
      try {
        const o = JSON.parse(window.localStorage.getItem('topdowngp.career') || 'null');
        if (o && typeof o === 'object') {
          ['since', 'races', 'wins', 'podiums', 'poles', 'fl', 'points', 'laps', 'seasons', 'titles'].forEach(function (k) { if (isFinite(o[k]) && o[k] >= 0) d[k] = Math.floor(o[k]); });
          if (isFinite(o.time) && o.time > 0) d.time = o.time;
          if (o.online) ['races', 'wins', 'podiums'].forEach(function (k) { if (isFinite(o.online[k]) && o.online[k] >= 0) d.online[k] = Math.floor(o.online[k]); });
          if (o.tracks && typeof o.tracks === 'object') Object.keys(o.tracks).forEach(function (id) {
            const t = o.tracks[id];
            if (t && F1.TRACK_DEFS[id]) d.tracks[id] = { races: Math.floor(t.races) || 0, wins: Math.floor(t.wins) || 0, podiums: Math.floor(t.podiums) || 0, best: t.best > 0 ? Math.floor(t.best) : 0,
              time: isFinite(t.time) && t.time > 0 ? t.time : 0 };
          });
        }
      } catch (e) { /* keep the blank career */ }
      this.data = d;
      return d;
    },
    save: function () { try { window.localStorage.setItem('topdowngp.career', JSON.stringify(this.data)); } catch (e) { /* ignore */ } },
    /* A race you finished or retired from: { track, pos, out, fl, pts, laps, online } and for the achievements
       { grid (your place on the grid), ovt (your overtakes), cars, rain (it rained in the race), level (the AI's
       difficulty, when there were AI cars), full (a weekend with all three practices and qualifying) } */
    race: function (o) {
      const d = this.load(), t = this.trk(d, o.track);
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
      Ach.race(o, win, pod);
    },
    trk: function (d, id) { return d.tracks[id] || (d.tracks[id] = { races: 0, wins: 0, podiums: 0, best: 0, time: 0 }); },
    pole: function () { const d = this.load(); d.poles++; this.save(); Ach.refresh(); },
    /* A championship you raced to the end (single-player or online), and how many races it had. */
    season: function (won, rounds) {
      const d = this.load(); d.seasons++; if (won) d.titles++; this.save();
      if (rounds >= 24) Ach.unlock(['fullseason']);
      Ach.refresh();
    },
    /* Time played, in seconds per track: { trackId: seconds } */
    addTime: function (per) {
      const d = this.load(), self = this;
      Object.keys(per).forEach(function (id) {
        if (!F1.TRACK_DEFS[id] || !(per[id] > 0)) return;
        d.time = Math.round((d.time + per[id]) * 10) / 10;
        const t = self.trk(d, id);
        t.time = Math.round((t.time + per[id]) * 10) / 10;
      });
      this.save();
      Ach.refresh();
    }
  };
  /* "12 h 14 min", "43 min" (time played) */
  function fmtPlayed(s) {
    const m = Math.floor((s || 0) / 60);
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }

  // ------------------------------------------------------------- achievements (this browser)
  /* 42 achievements. Counted ones (goal) unlock when their number is reached and show a progress bar until then; the
     others unlock at a moment in a race. The race feats need at least 5 opponents in the race. Unlocked achievements
     are kept with the time they were unlocked: { id: time }. */
  const nTracks = function () { return Object.keys(F1.TRACK_DEFS).length; };
  const ACH = [
    { id: 'race1', group: 'Racing', name: 'Lights out', desc: 'Start your first race', goal: 1, v: function (s) { return s.c.races; } },
    { id: 'win1', group: 'Racing', name: 'First win', desc: 'Win a race', goal: 1, v: function (s) { return s.c.wins; } },
    { id: 'podium1', group: 'Racing', name: 'On the podium', desc: 'Finish in the top three', goal: 1, v: function (s) { return s.c.podiums; } },
    { id: 'wins10', group: 'Racing', name: 'Serial winner', desc: 'Win 10 races', goal: 10, v: function (s) { return s.c.wins; } },
    { id: 'wins50', group: 'Racing', name: 'Dominant', desc: 'Win 50 races', goal: 50, v: function (s) { return s.c.wins; } },
    { id: 'podiums25', group: 'Racing', name: 'Champagne shower', desc: 'Finish on the podium 25 times', goal: 25, v: function (s) { return s.c.podiums; } },
    { id: 'pole1', group: 'Racing', name: 'Pole position', desc: 'Be fastest in qualifying', goal: 1, v: function (s) { return s.c.poles; } },
    { id: 'poles10', group: 'Racing', name: 'Pole master', desc: 'Take 10 pole positions', goal: 10, v: function (s) { return s.c.poles; } },
    { id: 'fl1', group: 'Racing', name: 'Fastest lap', desc: 'Set the fastest lap of a race', goal: 1, v: function (s) { return s.c.fl; } },
    { id: 'fl10', group: 'Racing', name: 'Purple patch', desc: 'Set the fastest lap in 10 races', goal: 10, v: function (s) { return s.c.fl; } },
    { id: 'pts100', group: 'Racing', name: 'Points on the board', desc: 'Score 100 points', goal: 100, v: function (s) { return s.c.points; } },
    { id: 'pts1000', group: 'Racing', name: 'Points machine', desc: 'Score 1,000 points', goal: 1000, v: function (s) { return s.c.points; } },
    { id: 'laps100', group: 'Racing', name: 'Centurion', desc: 'Drive 100 racing laps', goal: 100, v: function (s) { return s.c.laps; } },
    { id: 'laps1000', group: 'Racing', name: 'Marathon', desc: 'Drive 1,000 racing laps', goal: 1000, v: function (s) { return s.c.laps; } },
    { id: 'season1', group: 'Championships', name: 'Season done', desc: 'Race a championship to the end', goal: 1, v: function (s) { return s.c.seasons; } },
    { id: 'title1', group: 'Championships', name: 'World Champion', desc: 'Win a championship', goal: 1, v: function (s) { return s.c.titles; } },
    { id: 'titles3', group: 'Championships', name: 'Dynasty', desc: 'Win 3 championships', goal: 3, v: function (s) { return s.c.titles; } },
    { id: 'fullseason', group: 'Championships', name: 'Full calendar', desc: 'Race a championship of 24 races to the end' },
    { id: 'sweep', group: 'Race feats', name: 'Clean sweep', desc: 'Start first, win and set the fastest lap' },
    { id: 'comeback', group: 'Race feats', name: 'Comeback', desc: 'Win from P15 or lower on the grid' },
    { id: 'fromback', group: 'Race feats', name: 'From the back', desc: 'Start last and finish on the podium' },
    { id: 'overtaker', group: 'Race feats', name: 'Overtaker', desc: 'Make 10 overtakes in one race' },
    { id: 'rain', group: 'Race feats', name: 'Rain master', desc: 'Win a race in the rain' },
    { id: 'night', group: 'Race feats', name: 'Under the lights', desc: 'Win a night race' },
    { id: 'monaco', group: 'Race feats', name: 'Monaco king', desc: 'Win at Monaco' },
    { id: 'monza', group: 'Race feats', name: 'Temple of speed', desc: 'Win at Monza' },
    { id: 'classic', group: 'Race feats', name: 'Old school', desc: 'Win on a classic track' },
    { id: 'expert', group: 'Race feats', name: 'Beat the best', desc: 'Win a race on Expert difficulty' },
    { id: 'fullgrid', group: 'Race feats', name: 'Full grid', desc: 'Win a race against 21 opponents' },
    { id: 'weekend', group: 'Race feats', name: 'Full weekend', desc: 'Race a weekend with all three practices and qualifying' },
    { id: 'tracksall', group: 'Tracks and laps', name: 'Globetrotter', desc: function () { return 'Race on all ' + nTracks() + ' tracks'; }, goal: nTracks, v: function (s) { return s.raced; } },
    { id: 'wintracks10', group: 'Tracks and laps', name: 'World tour', desc: 'Win on 10 different tracks', goal: 10, v: function (s) { return s.won; } },
    { id: 'pb10', group: 'Tracks and laps', name: 'Speed collector', desc: 'Set a best lap on 10 tracks', goal: 10, v: function (s) { return s.pbs; } },
    { id: 'pball', group: 'Tracks and laps', name: 'All-rounder', desc: function () { return 'Set a best lap on all ' + nTracks() + ' tracks'; }, goal: nTracks, v: function (s) { return s.pbs; } },
    { id: 'ghost', group: 'Tracks and laps', name: 'Ghostbuster', desc: 'Beat your best lap on a track by a full second' },
    { id: 'tt10', group: 'Tracks and laps', name: 'Time trialist', desc: 'Set a time trial lap on 10 tracks', goal: 10, v: function (s) { return s.tts; } },
    { id: 'online1', group: 'Online and time', name: 'Online racer', desc: 'Race online', goal: 1, v: function (s) { return s.c.online.races; } },
    { id: 'onlinewin', group: 'Online and time', name: 'Online winner', desc: 'Win an online race', goal: 1, v: function (s) { return s.c.online.wins; } },
    { id: 'hour1', group: 'Online and time', name: 'Warming up', desc: 'Play for 1 hour', goal: 60, unit: 'min', v: function (s) { return s.c.time / 60; } },
    { id: 'hours10', group: 'Online and time', name: 'Night owl', desc: 'Play for 10 hours', goal: 600, unit: 'min', v: function (s) { return s.c.time / 60; } },
    // version 17: the daily challenge
    { id: 'golds10', group: 'Daily challenge', name: 'Gold rush', desc: 'Win 10 gold medals in the daily challenge', goal: 10, v: function (s) { return s.daily.golds; } },
    { id: 'streak7', group: 'Daily challenge', name: 'On fire', desc: 'Win a daily challenge medal 7 days in a row', goal: 7, v: function (s) { return s.daily.streak; } }
  ];
  const ACH_BY = {};
  ACH.forEach(function (a) { ACH_BY[a.id] = a; });
  const Ach = {
    LIST: ACH,
    onUnlock: null,          // (main.js shows the new ones)
    got: function () {
      try { return JSON.parse(window.localStorage.getItem('topdowngp.ach') || '{}') || {}; } catch (e) { return {}; }
    },
    /* When the Achievements tab was last opened (version 16): the ones earned since are new. Not set yet (the first
       time version 16 opens): everything earned so far counts as seen. */
    seen: function () {
      let v = null;
      try { v = window.localStorage.getItem('topdowngp.achSeen'); } catch (e) { /* ignore */ }
      if (v === null) { this.markSeen(); return Date.now(); }
      return Number(v) || 0;
    },
    markSeen: function () { try { window.localStorage.setItem('topdowngp.achSeen', String(Date.now())); } catch (e) { /* ignore */ } },
    goal: function (a) { return typeof a.goal === 'function' ? a.goal() : a.goal; },
    desc: function (a) { return typeof a.desc === 'function' ? a.desc() : a.desc; },
    /* The numbers the counted achievements go by. */
    stats: function () {
      const c = Career.load(), tr = c.tracks;
      const tt = window.TTBoard ? window.TTBoard.load() : {};
      const D = window.Daily;
      return { c: c,
        daily: D ? { golds: D.counts().golds, streak: D.bestStreak() } : { golds: 0, streak: 0 },
        raced: Object.keys(tr).filter(function (id) { return tr[id].races > 0; }).length,
        won: Object.keys(tr).filter(function (id) { return tr[id].wins > 0; }).length,
        pbs: Object.keys(F1.TRACK_DEFS).filter(function (id) { return !!PB.get(id); }).length,
        tts: Object.keys(F1.TRACK_DEFS).filter(function (id) { return Array.isArray(tt[id]) && tt[id].length > 0; }).length };
    },
    unlock: function (ids) {
      const got = this.got(), fresh = [];
      ids.forEach(function (id) { if (ACH_BY[id] && !got[id]) { got[id] = Date.now(); fresh.push(ACH_BY[id]); } });
      if (fresh.length) {
        try { window.localStorage.setItem('topdowngp.ach', JSON.stringify(got)); } catch (e) { /* ignore */ }
        if (this.onUnlock) { try { this.onUnlock(fresh); } catch (e) { /* ignore */ } }
      }
      return fresh;
    },
    /* Unlock the counted achievements whose number has been reached. */
    refresh: function () {
      const s = this.stats(), self = this;
      return this.unlock(ACH.filter(function (a) { return a.v && a.v(s) >= self.goal(a); }).map(function (a) { return a.id; }));
    },
    /* The race feats, at the end of a race (see Career.race). */
    race: function (o, win, pod) {
      const T = F1.TRACK_DEFS[o.track] || {}, ids = [], cars = o.cars || 0, field = cars >= 6;
      if (field) {
        if (win && o.grid === 1 && o.fl) ids.push('sweep');
        if (win && o.grid >= 15) ids.push('comeback');
        if (pod && cars >= 10 && o.grid === cars) ids.push('fromback');
        if (!o.out && o.ovt >= 10) ids.push('overtaker');
        if (win && o.rain) ids.push('rain');
        if (win && T.night) ids.push('night');
        if (win && o.track === 'monaco') ids.push('monaco');
        if (win && o.track === 'monza') ids.push('monza');
        if (win && T.classic) ids.push('classic');
        if (win && o.level === 'expert') ids.push('expert');
        if (win && cars >= 22) ids.push('fullgrid');
      }
      if (!o.out && o.full) ids.push('weekend');
      this.unlock(ids);
      this.refresh();
    }
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

  // ------------------------------------------------------------- phone vibration
  /* Short buzzes on phones that can (Android; iPhones can't): contact, kerbs, lights out. Settings → Vibration. */
  const Haptics = {
    can: typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function',
    kerbAt: 0,
    on: function () { return this.can && Settings.data.vibrate !== 'off' && document.body.classList.contains('touch'); },
    buzz: function (p) { if (this.on()) { try { navigator.vibrate(p); } catch (e) { /* not allowed yet */ } } },
    // session events: lights out
    event: function (e) { if (e.k === 'lightsOut') this.buzz(90); },
    // a hit near your car (power: how hard)
    hit: function (power, dist) { if (dist < 6) this.buzz(Math.round(F1.clamp(18 + power / 120, 20, 90))); },
    // riding a kerb at speed: a quick rumble
    kerb: function (own) {
      if (!own || own.surf !== 1 || own.speed < 8) return;
      const now = performance.now();
      if (now - this.kerbAt > 95) { this.kerbAt = now; this.buzz(14); }
    }
  };

  // ------------------------------------------------------------- on-screen messages
  /* opts.from: 'eng' = your race engineer on the radio (with the radio beep, unless opts.quiet), 'rc' = race control.
     opts.sign: 'warn' / 'pen' (race control: a warning or a penalty). */
  function Messages() { this.list = []; }
  Messages.prototype.add = function (text, opts) {
    opts = opts || {};
    const now = performance.now();
    if (opts.key) this.list = this.list.filter(function (m) { return m.key !== opts.key; });
    this.list.push({ text: text, sub: opts.sub, color: opts.color, subColor: opts.subColor, big: opts.big, sign: opts.sign, from: opts.from, key: opts.key, until: now + (opts.dur || 3000), start: now });
    if (this.list.length > 3) this.list.shift();
    if (opts.from === 'eng' && !opts.quiet && window.GameAudio && window.GameAudio.radio) window.GameAudio.radio();
  };
  Messages.prototype.active = function () {
    const now = performance.now();
    this.list = this.list.filter(function (m) { return m.until > now; });
    return this.list.map(function (m) {
      const left = m.until - now;
      return { text: m.text, sub: m.sub, color: m.color, subColor: m.subColor, big: m.big, sign: m.sign, from: m.from, age: now - m.start, alpha: Math.min(1, left / 400) };
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
  window.Haptics = Haptics;
  window.PB = PB;
  window.Input = Input;
  window.KeyBind = KeyBind;
  window.Career = Career;
  window.Ach = Ach;
  window.fmtPlayed = fmtPlayed;
  window.Messages = Messages;
  window.gearFor = gearFor;
  window.controlsHint = controlsHint;
})();
