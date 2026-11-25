/* The daily challenge in the browser (version 17): your results (kept in this browser, and on the server too when you
   are signed in), running an attempt (DailyRun: LocalGame calls it after every step), the little panel at the top of
   the screen while you drive, and the challenge screen. */
(function () {
  'use strict';
  const F1 = window.F1;
  const STORE = 'topdowngp.daily';
  const $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  const units = function () { return window.Settings && window.Settings.data.units === 'mph' ? 'mph' : 'kmh'; };

  // ------------------------------------------------------------- your results
  /* { v: 1, days: { 'YYYY-MM-DD': { s: best score, m: medal (0-3), a: attempts, at: time of the best } } } */
  const Daily = {
    data: null,
    spec: null,               // today's challenge as the server gave it (the same as worked out here)
    load: function () {
      if (this.data) return this.data;
      let o = null;
      try { o = JSON.parse(window.localStorage.getItem(STORE) || 'null'); } catch (e) { o = null; }
      const d = { v: 1, days: {} };
      if (o && o.days && typeof o.days === 'object') {
        Object.keys(o.days).forEach(function (k) {
          const r = o.days[k];
          if (!F1.dailyValidKey(k) || !r) return;
          d.days[k] = { s: typeof r.s === 'number' && isFinite(r.s) ? r.s : null, m: Math.max(0, Math.min(3, Math.floor(r.m) || 0)), a: Math.max(0, Math.floor(r.a) || 0), at: r.at || 0 };
        });
      }
      this.data = d;
      return d;
    },
    save: function () {
      const d = this.load(), keys = Object.keys(d.days).sort();
      while (keys.length > 400) delete d.days[keys.shift()];
      try { window.localStorage.setItem(STORE, JSON.stringify(d)); } catch (e) { /* ignore */ }
    },
    today: function () {
      const k = F1.dailyKey();
      if (this.spec && this.spec.key === k) return this.spec;
      return F1.dailyChallenge(k);
    },
    day: function (k) { return this.load().days[k] || null; },
    attempt: function (ch) {
      const d = this.load(), r = d.days[ch.key] || (d.days[ch.key] = { s: null, m: 0, a: 0, at: 0 });
      r.a++; this.save();
      return r;
    },
    /* A finished attempt: keeps your best of the day. { best, medal, improved, was } */
    record: function (ch, score) {
      const d = this.load(), r = d.days[ch.key] || (d.days[ch.key] = { s: null, m: 0, a: 1, at: 0 }), was = r.m;
      const improved = F1.dailyBetter(ch, score, r.s);
      if (improved) { r.s = score; r.m = F1.dailyMedal(ch, score); r.at = Date.now(); }
      this.save();
      if (window.Ach) window.Ach.refresh();
      return { best: r.s, medal: r.m, improved: improved, was: was };
    },
    /* Results from the server (signed in on another device): the better of the two for each day. */
    merge: function (days) {
      const d = this.load();
      let changed = false;
      Object.keys(days || {}).forEach(function (k) {
        const x = days[k], ch = F1.dailyValidKey(k) ? F1.dailyChallenge(k) : null;
        if (!ch || !x || typeof x.s !== 'number') return;
        const r = d.days[k] || (d.days[k] = { s: null, m: 0, a: 0, at: 0 });
        if (F1.dailyBetter(ch, x.s, r.s)) { r.s = x.s; r.m = F1.dailyMedal(ch, x.s); changed = true; }
        if (x.a > r.a) { r.a = x.a; changed = true; }
      });
      if (changed) { this.save(); if (window.Ach) window.Ach.refresh(); }
      return changed;
    },
    /* Days in a row with a medal, up to today (or up to yesterday while today has none yet). */
    streak: function () {
      const d = this.load(), n0 = F1.dailyNum(F1.dailyKey());
      let n = n0, s = 0;
      if (!(d.days[F1.dailyKeyOf(n)] && d.days[F1.dailyKeyOf(n)].m > 0)) n--;
      while (d.days[F1.dailyKeyOf(n)] && d.days[F1.dailyKeyOf(n)].m > 0) { s++; n--; }
      return s;
    },
    bestStreak: function () {
      const d = this.load(), ns = Object.keys(d.days).filter(function (k) { return d.days[k].m > 0; }).map(F1.dailyNum).sort(function (a, b) { return a - b; });
      let best = 0, run = 0;
      for (let i = 0; i < ns.length; i++) { run = i && ns[i] === ns[i - 1] + 1 ? run + 1 : 1; if (run > best) best = run; }
      return best;
    },
    counts: function () {
      const d = this.load(), c = { medals: 0, golds: 0, played: 0 };
      Object.keys(d.days).forEach(function (k) { const r = d.days[k]; if (r.a > 0 || r.s !== null) c.played++; if (r.m > 0) c.medals++; if (r.m === 3) c.golds++; });
      return c;
    }
  };

  // ------------------------------------------------------------- an attempt
  /* How the session is set up for a challenge: LocalGame options (the cars, in grid order) and the session's own. */
  function gameOpts(ch, driverId) {
    const r = F1.rng((ch.seed ^ 0x9e3779b9) >>> 0);
    const ai = F1.DRIVERS.map(function (d) { return d.id; }).filter(function (id) { return id !== driverId; });
    for (let i = ai.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = ai[i]; ai[i] = ai[j]; ai[j] = t; }
    const field = ai.slice(0, ch.cars - 1);
    const grid = field.slice(0, ch.grid - 1).concat([driverId], field.slice(ch.grid - 1));
    const race = ch.type === 'race' || ch.type === 'defend';
    return {
      type: race ? 'race' : 'practice', track: ch.track, driverId: driverId, grid: grid, aiLevel: ch.level || 'medium', laps: race ? ch.laps : 0,
      title: 'DAILY CHALLENGE', daily: ch,
      session: { tyres: false, weather: ch.wet, wplan: ch.wet ? [{ t0: -2000, t1: 1e7, peak: F1.DAILY_RAIN }] : null, runs: false, collisions: true,
        drafting: true, contactEvents: ch.type === 'climb', seed: ch.seed,
        startMode: ch.type === 'lap' || ch.type === 'wetlap' ? 'flying' : ch.type === 'pitexit' ? 'pit' : 'grid' }
    };
  }

  /* One attempt, run alongside the session: where the clock starts and stops, what counts, the result. */
  function DailyRun(game, ch) {
    this.g = game; this.ch = ch; this.S = game.S; this.T = game.T; this.me = game.me;
    this.state = 'ready';          // 'ready' (not timing yet), 'run' (the clock is running), 'done'
    this.t0 = null; this.cuts = 0; this.hits = 0; this.hitAt = {}; this.result = null; this.live = null; this.n = 0;
    const T = this.T, L = T.length, me = this.me, S = this.S, type = ch.type, self = this;
    this.solo = type !== 'climb' && type !== 'race' && type !== 'defend';
    if (type === 'lap' || type === 'wetlap') {
      let toLine = F1.wrapS(-me.s, L); if (toLine < 30) toLine += L;
      this.G = new F1.DailyGates(T, me); this.A = this.G.add(toLine); this.B = this.G.add(toLine + L);
    } else if (type === 'sector' || type === 'sectors2') {
      const st = F1.dailySectorStart(T, ch.sector), run = F1.DAILY_RUNUP;
      F1.dailyPlace(me, T, st.s, 0, st.v);
      this.G = new F1.DailyGates(T, me); this.A = this.G.add(run); this.B = this.G.add(run + (type === 'sector' ? 1 : 2) * L / 3);
    } else if (type === 'trap') {
      const tr = F1.dailyTrap(T);
      F1.dailyPlace(me, T, tr.start, 0, tr.v);
      this.G = new F1.DailyGates(T, me); this.B = this.G.add(F1.wrapS(tr.s - tr.start, L));
    } else if (type === 'climb') {
      this.placePack();
    }
    if (type !== 'race' && type !== 'defend') game.startResume();      // (a 3-2-1 with everything still, so you can see where you are)
    if (type === 'pitexit') this.goOut = true;
    this.limit = ch.what === 'time' ? ch.medals[0] * 2.2 + 30 : 240;
    const h = $('dhud'); if (h) h.innerHTML = '';
    this.paint();
    this.timer = setInterval(function () { self.paint(); }, 100);
  }
  /* Climb the field: you just after the sector line, the others in a bunch just ahead (shared/daily.js). */
  DailyRun.prototype.placePack = function () {
    const P = F1.dailyPack(this.S, this.me, this.ch);
    this.G = P.G; this.B = P.B; this.gates = P.others;
  };
  /* Places gained so far: how many of the others are behind you now, less one for every car you ran into. */
  DailyRun.prototype.places = function () { return F1.dailyPlaces(this, this.hits); };
  DailyRun.prototype.step = function (evs) {
    if (this.state === 'done') return;
    const S = this.S, me = this.me, ch = this.ch, myId = this.g.myId;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.id !== myId) continue;
      if (e.k === 'tl' && (this.state === 'run' || (ch.type === 'trap' || ch.type === 'climb'))) this.cuts++;
      if (e.k === 'contact' && e.hit && ch.type === 'climb') {
        const last = this.hitAt[e.by];
        if (last === undefined || S.time - last > 1.5) { this.hits++; this.hitAt[e.by] = S.time; }
      }
      if (e.k === 'finish' && (ch.type === 'race' || ch.type === 'defend')) {
        // the race is over for you: the others are classified where they are now (time penalties count)
        S.finish();
        const row = (S.results || []).find(function (x) { return x.id === myId; }), pos = row ? row.pos : e.pos;
        const t = (me.finishTime !== null ? me.finishTime : S.time) + (me.penalty || 0) - (S.startTime || 0);
        this.end(pos * 10000 + Math.round(t * 1000) / 1000, null);
        return;
      }
    }
    if (ch.type === 'race' || ch.type === 'defend') {
      if (me.out) this.end(null, 'You retired from the race');
      return;
    }
    if (this.goOut) { this.goOut = false; this.g.goOut = true; }
    if (ch.type === 'pitexit') {
      if (this.state === 'ready' && !me.gar && !me.pitPlan && this.pitStage !== 1) {
        me.pitPlan = { stage: 'out', why: 'garage', entered: true, stopU: F1.pitInfo(this.T).u(me.s) };
        this.pitStage = 1;
      } else if (this.state === 'ready' && this.pitStage === 1 && !me.pitPlan) {
        this.state = 'run'; this.t0 = S.time; this.line0 = me.maxLine;
      } else if (this.state === 'run' && me.maxLine > this.line0) {
        this.end(Math.round((me.lapStart - this.t0) * 1000) / 1000, null);
        return;
      }
    } else {
      this.G.step(me, S.time);
      if (this.gates) for (let i = 0; i < this.gates.length; i++) this.gates[i].G.step(this.gates[i].c, S.time);
      if (this.state === 'ready' && (!this.A || this.A.t !== null)) { this.state = 'run'; this.t0 = this.A ? this.A.t : S.time; }
      if (this.state === 'run' && this.B.t !== null) {
        if (ch.type === 'trap') {
          if (this.cuts) this.end(null, 'Track limits: you cut a corner on the way');
          else this.end(Math.floor(this.B.v * 3.6 * 10) / 10, null);
        } else if (ch.type === 'climb') this.end(this.places(), null);
        else if (ch.type === 'wetlap' && this.cuts) this.end(null, 'Not a clean lap: you cut a corner');
        else this.end(Math.round((this.B.t - this.A.t + 5 * this.cuts) * 1000) / 1000, null);
        return;
      }
    }
    if (this.state === 'run' && S.time - this.t0 > this.limit) this.end(ch.type === 'climb' ? this.places() : null, 'Out of time');
  };
  /* The attempt is over: score (null = no result) and why not. The session stops a moment later. */
  DailyRun.prototype.end = function (score, why) {
    if (this.state === 'done') return;
    this.state = 'done';
    this.result = { score: score, why: why || null, medal: score === null ? 0 : F1.dailyMedal(this.ch, score), cuts: this.cuts, hits: this.hits };
    this.paint();
    const g = this.g;
    if (g.S.type !== 'race' && g.S.phase !== 'done') {
      setTimeout(function () { if (g.S.phase !== 'done') g.S.finish(); }, 700);
    }
  };
  DailyRun.prototype.stop = function () { clearInterval(this.timer); const h = $('dhud'); if (h) h.classList.add('hidden'); };
  /* What the panel at the top shows now. */
  DailyRun.prototype.view = function () {
    const ch = this.ch, S = this.S, me = this.me, st = this.state;
    let big = '', small = '';
    if (st === 'done' && this.result) {
      big = this.result.score === null ? (this.result.why || 'No result') : F1.dailyFormat(ch, this.result.score, units());
      small = this.result.score === null ? '' : this.result.medal ? F1.DAILY_MEDALS[this.result.medal] + '!' : 'No medal this time';
    } else if (ch.type === 'race' || ch.type === 'defend') {
      big = S.phase === 'countdown' ? 'Get ready' : 'P' + me.pos;
      small = S.phase === 'countdown' ? (ch.type === 'defend' ? 'Hold the lead' : 'Win the race') : 'Lap ' + Math.min(S.laps, me.lapsDone + 1) + ' of ' + S.laps;
    } else if (ch.type === 'climb') {
      const p = this.gates ? this.places() : 0;
      big = (p > 0 ? '+' : '') + p + (Math.abs(p) === 1 ? ' place' : ' places');
      small = (this.hits ? this.hits + (this.hits === 1 ? ' car hit (-1) \u00b7 ' : ' cars hit (-' + this.hits + ') \u00b7 ') : '') + this.toGo() + ' to the end of sector ' + (ch.sector + 1);
    } else if (ch.type === 'trap') {
      big = Math.round(Math.hypot(me.vx, me.vy) * 3.6 / (units() === 'mph' ? 1.609344 : 1)) + (units() === 'mph' ? ' mph' : ' km/h');
      small = this.cuts ? 'Track limits!' : 'Speed trap in ' + this.toGo();
    } else if (st === 'ready') {
      big = ch.type === 'pitexit' ? 'Pit lane' : 'Get ready';
      small = ch.type === 'pitexit' ? 'The clock starts at the pit exit' : ch.type === 'lap' || ch.type === 'wetlap' ? 'The clock starts at the line' : 'The clock starts at the sector line, ' + this.toGo(this.A);
    } else {
      big = F1.dailyFmtTime(S.time - this.t0);
      small = this.cuts ? (ch.type === 'wetlap' ? 'Not clean: corner cut' : '+' + 5 * this.cuts + ' s track limits') : ch.type === 'pitexit' ? 'To the finish line' : this.toGo() + ' to go';
    }
    return { name: ch.name, big: big, small: small };
  };
  /* How far to the finish of the run (or to gate g): "850 m", "1.2 km". */
  DailyRun.prototype.toGo = function (g) {
    const gate = g || this.B;
    if (!gate || !this.G) return '';
    const m = Math.max(0, gate.at - this.G.prog);
    return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m / 10) * 10 + ' m';
  };
  DailyRun.prototype.paint = function () {
    const h = $('dhud');
    if (!h) return;
    const v = this.view(), ch = this.ch;
    h.classList.remove('hidden');
    if (!h.firstChild) {
      h.innerHTML = '<div class="dh-name"></div><div class="dh-big"></div><div class="dh-small"></div><div class="dh-medals"></div>';
    }
    h.children[0].textContent = v.name;
    h.children[1].textContent = v.big;
    h.children[2].textContent = v.small;
    const md = h.children[3];
    if (!md.firstChild) for (let i = 0; i < 3; i++) md.appendChild(el('span', 'dh-m m' + (i + 1), F1.dailyTarget(ch, i, units())));
    const got = this.result ? this.result.medal : ch.type === 'climb' && this.gates ? F1.dailyMedal(ch, this.places()) : 0;
    for (let i = 0; i < 3; i++) md.children[i].classList.toggle('got', got >= i + 1);
  };

  // ------------------------------------------------------------- the challenge screen
  /* The map: the whole lap in grey, the part that counts in yellow, a red dot where you start. */
  function drawMap(cv, ch) {
    const O = F1.trackOutline(ch.track), N = O.n;
    const dpr = Math.min(2, window.devicePixelRatio || 1), w = cv.clientWidth || 260, h = cv.clientHeight || 170;
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const b = O.bounds, bw = b.maxX - b.minX, bh = b.maxY - b.minY, sc = Math.min((w - 24) / bw, (h - 24) / bh);
    const ox = (w - bw * sc) / 2 - b.minX * sc, oy = (h - bh * sc) / 2 - b.minY * sc;
    const P = function (f) { const k = ((Math.round(f * N) % N) + N) % N; return [O.x[k] * sc + ox, O.y[k] * sc + oy]; };
    const path = function (f0, f1) {
      g.beginPath();
      const steps = Math.max(2, Math.round((f1 - f0) * N / 3));
      for (let i = 0; i <= steps; i++) { const p = P(f0 + (f1 - f0) * i / steps); if (!i) g.moveTo(p[0], p[1]); else g.lineTo(p[0], p[1]); }
    };
    g.lineCap = g.lineJoin = 'round';
    path(0, 1); g.strokeStyle = 'rgba(255,255,255,0.82)'; g.lineWidth = 5; g.stroke();
    let f0 = 0, f1 = 1, dot = 0;
    if (ch.type === 'sector' || ch.type === 'climb') { f0 = ch.sector / 3; f1 = f0 + 1 / 3; dot = f0; }
    else if (ch.type === 'sectors2') { f0 = ch.sector / 3; f1 = f0 + 2 / 3; dot = f0; }
    else if (ch.type === 'trap') {
      const T = F1.getTrack(ch.track), tr = F1.dailyTrap(T);          // (the track is built now: it is needed to start anyway)
      f0 = tr.start / T.length; f1 = f0 + F1.wrapS(tr.s - tr.start, T.length) / T.length; dot = f0;
    }
    path(f0, f1); g.strokeStyle = '#ffd600'; g.lineWidth = 7; g.stroke();
    if (ch.type === 'trap' && f1 !== 1) { const q = P(f1); g.fillStyle = '#ffd600'; g.fillRect(q[0] - 5, q[1] - 5, 10, 10); }
    const p = P(dot); g.fillStyle = '#e10600'; g.beginPath(); g.arc(p[0], p[1], 7, 0, Math.PI * 2); g.fill();
  }
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function dayTitle(k) { const d = new Date(k + 'T12:00:00Z'); return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; }
  function leftText() {
    const m = Math.max(1, Math.ceil(F1.dailyLeft() / 60000));
    return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min';
  }
  const MEDAL_ICON = ['', '🥉', '🥈', '🥇'];
  const UI = {
    /* Fill the screen's left and middle boxes for challenge ch. */
    render: function (ch) {
      const T = F1.TRACK_DEFS[ch.track], left = $('daily-left'), mid = $('daily-mid');
      left.innerHTML = ''; mid.innerHTML = '';
      left.appendChild(el('h3', null, dayTitle(ch.key)));
      const cv = el('canvas', 'daily-map'); left.appendChild(cv);
      const where = el('p', 'daily-where');
      where.appendChild(el('b', null, T.name)); where.appendChild(document.createTextNode(' · ' + T.country));
      left.appendChild(where);
      const p1 = el('p', 'mu');
      p1.appendChild(document.createTextNode('Same challenge for everyone today.')); p1.appendChild(el('br'));
      p1.appendChild(document.createTextNode('Next one in ')); p1.appendChild(el('b', 'daily-left-t', leftText()));
      left.appendChild(p1);
      const st = Daily.streak(), sp = el('p', 'daily-streak');
      sp.innerHTML = st > 0 ? '🔥 Streak: <b>' + st + (st === 1 ? ' day' : ' days') + '</b> in a row with a medal' : 'Win a medal today to start a streak';
      left.appendChild(sp);
      mid.appendChild(el('h3', null, 'Today’s challenge'));
      mid.appendChild(el('div', 'daily-title', ch.name));
      const tags = el('div', 'daily-tags');
      F1.dailyTags(ch).forEach(function (t) { tags.appendChild(el('span', t === 'Rain' ? 'rain' : null, t)); });
      mid.appendChild(tags);
      mid.appendChild(el('p', 'daily-text', F1.dailyText(ch)));
      const md = el('div', 'medals');
      const mine = Daily.day(ch.key), got = mine ? mine.m : 0;
      ['Bronze', 'Silver', 'Gold'].forEach(function (n, i) {
        const b = el('div', 'm m' + (i + 1) + (got >= i + 1 ? ' got' : ''));
        b.appendChild(el('span', null, n.toUpperCase()));
        b.appendChild(el('b', null, F1.dailyTarget(ch, i, units())));
        md.appendChild(b);
      });
      mid.appendChild(md);
      if (ch.what === 'time' || ch.what === 'speed') mid.appendChild(el('p', 'mu small', 'Beat the Medium AI for bronze, the Hard AI for silver and the Expert AI for gold.'));
      const best = el('p', 'daily-best');
      if (mine && mine.s !== null) best.innerHTML = 'Your best today: <b>' + F1.dailyFormat(ch, mine.s, units()) + '</b>' + (mine.m ? ' (' + F1.DAILY_MEDALS[mine.m] + ')' : '') + ' · ' + mine.a + (mine.a === 1 ? ' attempt' : ' attempts');
      else if (mine && mine.a) best.textContent = 'No result yet today · ' + mine.a + (mine.a === 1 ? ' attempt' : ' attempts');
      else best.textContent = 'You haven’t tried it yet today.';
      mid.appendChild(best);
      mid.appendChild(el('h3', 'daily-other', 'Other days you might get'));
      const chips = el('div', 'chips');
      F1.DAILY_TYPE_IDS.forEach(function (id) { if (id !== ch.type) chips.appendChild(el('span', null, F1.DAILY_TYPES[id].name)); });
      mid.appendChild(chips);
      requestAnimationFrame(function () { drawMap(cv, ch); });
    },
    tick: function () { const t = document.querySelector('#daily .daily-left-t'); if (t) t.textContent = leftText(); },
    /* The home screen button: today's track and challenge, and how you have done. */
    homeLine: function () {
      const ch = Daily.today();
      if (!ch) return '';
      const mine = Daily.day(ch.key), T = F1.TRACK_DEFS[ch.track];
      const how = mine && mine.m ? F1.DAILY_MEDALS[mine.m] + ' so far' : mine && mine.a ? 'No medal yet' : 'Not tried yet';
      return (T.short || T.name) + ' · ' + ch.name + ' · ' + how;
    },
    medalIcon: function (m) { return MEDAL_ICON[m] || ''; },
    /* The window after an attempt. o: { ch, result, rec } */
    showResult: function (o) {
      const ch = o.ch, r = o.result, box = $('dres');
      const m = r && r.score !== null ? r.medal : 0;
      $('dres-medal').className = 'dres-medal m' + m;
      $('dres-medal').textContent = m ? MEDAL_ICON[m] : '—';
      $('dres-title').textContent = !r || r.score === null ? 'No result' : m ? F1.DAILY_MEDALS[m] + '!' : 'No medal this time';
      $('dres-score').textContent = !r ? '' : r.score === null ? (r.why || '') : F1.dailyFormat(ch, r.score, units());
      const lines = [];
      if (r && r.score !== null && ch.type === 'climb' && r.hits) lines.push(r.hits + (r.hits === 1 ? ' car hit cost a place' : ' car hits cost ' + r.hits + ' places'));
      if (r && r.score !== null && (ch.type === 'lap' || ch.type === 'sector' || ch.type === 'sectors2') && r.cuts) lines.push('Includes ' + 5 * r.cuts + ' s for track limits');
      if (r && r.score !== null && m < 3) {
        lines.push('Next: ' + F1.DAILY_MEDALS[m + 1] + ' for ' + (ch.what === 'pos' ? F1.dailyTarget(ch, m) : F1.dailyTarget(ch, m, units())));
      }
      if (o.rec && o.rec.best !== null) lines.push((o.rec.improved && o.rec.best === r.score ? 'Your new best today: ' : 'Your best today: ') + F1.dailyFormat(ch, o.rec.best, units()) +
        (o.rec.medal ? ' (' + F1.DAILY_MEDALS[o.rec.medal] + ')' : ''));
      $('dres-lines').innerHTML = '';
      lines.forEach(function (t) { $('dres-lines').appendChild(el('p', null, t)); });
      box.classList.remove('hidden');
    }
  };

  window.Daily = Daily;
  window.DailyRun = DailyRun;
  window.DailyRun.gameOpts = gameOpts;
  window.DailyUI = UI;
})();
