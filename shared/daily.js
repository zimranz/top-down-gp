/* The daily challenge (version 17): one challenge a day, the same for everyone; a new one at midnight UK time.
   Which track, which kind of challenge and the medal targets come from the date alone, so the server (the board) and
   every browser work out the same challenge. The medal targets of the timed challenges are the times (and speeds) of
   the AI driving them alone: bronze beats the Medium AI, silver the Hard AI, gold the Expert AI (shared/dailyref.js). */
(function (root) {
  'use strict';
  const F1 = (root.F1 = root.F1 || {});

  // ---------------------------------------------------------------- the day (UK time)
  let UKF = null;
  try {
    UKF = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch (e) { UKF = null; }
  /* 'YYYY-MM-DD': the day in the UK at time t (ms; now if left out). */
  F1.dailyKey = function (t) {
    const d = new Date(t === undefined ? Date.now() : t);
    if (UKF) {
      const p = {};
      UKF.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
      if (p.year && p.month && p.day) return p.year + '-' + p.month + '-' + p.day;
    }
    return d.toISOString().slice(0, 10);          // (no time zones in this browser: the day in UTC)
  };
  /* Milliseconds until the next challenge (the next midnight in the UK). */
  F1.dailyLeft = function (t) {
    t = t === undefined ? Date.now() : t;
    const k = F1.dailyKey(t);
    let lo = t, hi = t + 26 * 3600e3;
    while (hi - lo > 500) { const m = (lo + hi) / 2; if (F1.dailyKey(m) === k) lo = m; else hi = m; }
    return Math.max(0, hi - t);
  };
  F1.dailyValidKey = function (k) { return typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k) && !isNaN(Date.parse(k + 'T00:00:00Z')); };
  /* Days since 1 January 2026. */
  F1.dailyNum = function (k) { return Math.round((Date.parse(k + 'T00:00:00Z') - Date.UTC(2026, 0, 1)) / 864e5); };
  F1.dailyKeyOf = function (n) { return new Date(Date.UTC(2026, 0, 1) + n * 864e5).toISOString().slice(0, 10); };

  // ---------------------------------------------------------------- the kinds of challenge
  /* better: which way a score is better ('low': times and places on the road; 'high': places gained, speed) */
  const TYPES = F1.DAILY_TYPES = {
    lap: { name: 'Fastest lap', better: 'low', what: 'time' },
    sector: { name: 'Fastest sector', better: 'low', what: 'time' },
    sectors2: { name: 'Two sectors', better: 'low', what: 'time' },
    climb: { name: 'Climb the field', better: 'high', what: 'places' },
    pitexit: { name: 'From the pit exit', better: 'low', what: 'time' },
    race: { name: 'Short race to win', better: 'low', what: 'pos' },
    defend: { name: 'Defend the lead', better: 'low', what: 'pos' },
    trap: { name: 'Speed trap', better: 'high', what: 'speed' },
    wetlap: { name: 'Clean lap in the wet', better: 'low', what: 'time' }
  };
  F1.DAILY_TYPE_IDS = ['lap', 'sector', 'sectors2', 'climb', 'pitexit', 'race', 'defend', 'trap', 'wetlap'];
  F1.DAILY_RAIN = 0.35;                       // light rain all session (intermediate tyres)
  // places to gain for bronze, silver, gold (from the AI driving your car: the Expert AI gains 2 places from a Medium
  // pack about half the time, 4 one time in ten)
  F1.DAILY_CLIMB = { medium: [1, 3, 5], hard: [1, 2, 4] };

  function shuffle(a, seed) {
    const r = F1.rng(seed >>> 0), o = a.slice();
    for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = o[i]; o[i] = o[j]; o[j] = t; }
    return o;
  }
  /* Day n of a deck dealt in shuffled rounds (no card twice in a row, also where one round meets the next). */
  function deal(cards, n, salt) {
    const N = cards.length, b = Math.floor(n / N), i = n - b * N;
    const deck = function (k) {
      const d = shuffle(cards, (k * 7919 + salt) >>> 0);
      if (k > 0) { const prev = shuffle(cards, ((k - 1) * 7919 + salt) >>> 0); if (d[0] === prev[N - 1] && N > 1) { const t = d[0]; d[0] = d[1]; d[1] = t; } }
      return d;
    };
    return deck(b)[i];
  }
  /* The tracks the challenge uses: those with AI references (all of them). */
  F1.dailyTracks = function () {
    const ref = F1.DAILY_REF || {};
    return Object.keys(F1.TRACK_DEFS).filter(function (id) { return ref[id] && ref[id].dry && ref[id].wet; });
  };

  /* The challenge of day k ('YYYY-MM-DD'):
     { key, type, name, better, what, track, sector (0-2: the sector it starts in), wet, laps, cars (with you), grid
       (your place at the start), level (the AI), medals: [bronze, silver, gold], seed } */
  F1.dailyChallenge = function (k) {
    if (!F1.dailyValidKey(k)) return null;
    const n = F1.dailyNum(k), ids = F1.dailyTracks();
    if (!ids.length) return null;
    const type = deal(F1.DAILY_TYPE_IDS, n, 101), track = deal(ids, n, 202);
    const r = F1.rng(((n + 7) * 2654435761) >>> 0), TY = TYPES[type], ref = F1.DAILY_REF[track];
    const wetChance = { lap: 0, sector: 0.25, sectors2: 0.25, climb: 0.2, pitexit: 0.2, race: 0.25, defend: 0.25, trap: 0, wetlap: 1 }[type];
    const ch = { key: k, n: n, type: type, name: TY.name, better: TY.better, what: TY.what, track: track, sector: Math.floor(r() * 3),
      wet: r() < wetChance, laps: 0, cars: 1, grid: 1, level: null, medals: null, seed: (n * 48271 + 11) >>> 0 };
    if (type === 'wetlap') ch.wet = true;
    const R = ref[ch.wet ? 'wet' : 'dry'];
    const tri = function (a) { return [a[0], a[1], a[2]]; };
    if (type === 'lap' || type === 'wetlap') ch.medals = tri(R.lap);
    else if (type === 'sector') ch.medals = tri(R.sec[ch.sector]);
    else if (type === 'sectors2') ch.medals = tri(R.two[ch.sector]);
    else if (type === 'pitexit') ch.medals = tri(R.pit);
    else if (type === 'trap') {
      // (where every AI comes out of the corner much the same, the medals are still a few km/h apart)
      const e = R.trap[2];
      ch.medals = [Math.round(Math.min(R.trap[0], e - 6) * 10) / 10, Math.round(Math.min(R.trap[1], e - 2.5) * 10) / 10, e];
    }
    else if (type === 'climb') { ch.cars = 12; ch.grid = 12; ch.level = r() < 0.5 ? 'medium' : 'hard'; ch.medals = F1.DAILY_CLIMB[ch.level].slice(); }
    else if (type === 'race' || type === 'defend') {
      // (from the AI driving your car: from 6th, the Expert AI wins about half the time against the Medium AI and
      // gets on the podium about half the time against the Hard AI; on pole, the Hard AI holds off the Expert AI
      // about two times in three)
      ch.laps = (F1.TRACK_DEFS[track].officialLength || 5000) > 5600 ? 2 : 3; ch.cars = 10;
      if (type === 'race') { ch.grid = 6; ch.level = r() < 0.5 ? 'medium' : 'hard'; ch.medals = [4, 3, 1]; }
      else { ch.grid = 1; ch.level = 'expert'; ch.medals = [3, 2, 1]; }
    }
    return ch;
  };
  F1.dailyToday = function () { return F1.dailyChallenge(F1.dailyKey()); };

  // ---------------------------------------------------------------- scores and medals
  /* Scores: times in seconds; places gained; speed in km/h; finishing places as place * 10000 + race time. */
  F1.dailyPos = function (score) { return Math.floor(score / 10000); };
  F1.dailyBetter = function (ch, a, b) {
    if (a === null || a === undefined || !isFinite(a)) return false;
    if (b === null || b === undefined || !isFinite(b)) return true;
    return ch.better === 'high' ? a > b : a < b;
  };
  /* 0 none, 1 bronze, 2 silver, 3 gold */
  F1.dailyMedal = function (ch, score) {
    if (!ch || score === null || score === undefined || !isFinite(score)) return 0;
    let m = 0;
    for (let i = 0; i < 3; i++) {
      const v = ch.medals[i];
      const ok = ch.what === 'pos' ? F1.dailyPos(score) <= v : ch.better === 'high' ? score >= v : score <= v;
      if (ok) m = i + 1;
    }
    return m;
  };
  F1.DAILY_MEDALS = ['', 'Bronze', 'Silver', 'Gold'];
  function fmtTime(t) {
    if (!isFinite(t)) return '--';
    const ms = Math.round(t * 1000), m = Math.floor(ms / 60000), s = (ms - m * 60000) / 1000;
    return m > 0 ? m + ':' + (s < 10 ? '0' : '') + s.toFixed(3) : s.toFixed(3);
  }
  F1.dailyFmtTime = fmtTime;
  /* A score as text: "1:31.204", "+7 places", "P1", "321.4 km/h" (or mph). */
  F1.dailyFormat = function (ch, score, units) {
    if (score === null || score === undefined || !isFinite(score)) return '--';
    if (ch.what === 'time') return fmtTime(score);
    if (ch.what === 'places') { const p = Math.round(score); return (p > 0 ? '+' : '') + p + (Math.abs(p) === 1 ? ' place' : ' places'); }
    if (ch.what === 'pos') return 'P' + F1.dailyPos(score);
    return units === 'mph' ? (score / 1.609344).toFixed(1) + ' mph' : score.toFixed(1) + ' km/h';
  };
  /* A medal target as text: "1:31.204", "6 places", "Win", "Podium", "Top 5", "321.4 km/h". */
  F1.dailyTarget = function (ch, i, units) {
    const v = ch.medals[i];
    if (ch.what === 'pos') return v === 1 ? 'Win' : v === 3 ? 'Podium' : 'Top ' + v;
    if (ch.what === 'places') return v + (v === 1 ? ' place' : ' places');
    return F1.dailyFormat(ch, v, units);
  };
  /* A score that could come from playing the challenge (the board turns away anything else). */
  F1.dailyPlausible = function (ch, score) {
    if (!ch || typeof score !== 'number' || !isFinite(score)) return false;
    if (ch.what === 'time') return score > ch.medals[2] * 0.85 && score < 3600;
    if (ch.what === 'speed') return score > 50 && score < ch.medals[2] * 1.12;
    if (ch.what === 'places') return score === Math.round(score) && score >= -(ch.cars - 1) && score <= ch.cars - 1;
    const p = F1.dailyPos(score), t = score - p * 10000;
    return p >= 1 && p <= ch.cars && t > 10 && t < 3600;
  };

  // ---------------------------------------------------------------- the words on the screen
  const SEC = ['sector 1', 'sector 2', 'sector 3'];
  const LV = { easy: 'Easy', medium: 'Medium', hard: 'Hard', extrahard: 'Very hard', expert: 'Expert' };
  /* Short labels under the title: ['Sector 2', 'Start P12', 'Rain', 'Hard AI', 'Intermediates'] */
  F1.dailyTags = function (ch) {
    const t = [];
    if (ch.type === 'sector' || ch.type === 'climb') t.push('Sector ' + (ch.sector + 1));
    if (ch.type === 'sectors2') t.push('Sectors ' + (ch.sector + 1) + ' + ' + ((ch.sector + 1) % 3 + 1));
    if (ch.laps) t.push(ch.laps + ' laps');
    if (ch.cars > 1) t.push('Start P' + ch.grid);
    t.push(ch.wet ? 'Rain' : 'Dry');
    if (ch.level) t.push(LV[ch.level] + ' AI');
    t.push(ch.wet ? 'Intermediates' : 'Soft tyres');
    return t;
  };
  F1.dailyText = function (ch) {
    const s1 = SEC[ch.sector], s2 = SEC[(ch.sector + 1) % 3];
    switch (ch.type) {
      case 'lap': return 'One flying lap. Each track-limits offence adds 5 seconds.';
      case 'wetlap': return 'One flying lap in the rain. The lap only counts if it is clean: no track-limits offences.';
      case 'sector': return 'A flying run through ' + s1 + ' only. The clock starts and stops at the sector lines.';
      case 'sectors2': return 'A flying run through ' + s1 + ' and ' + s2 + '. The clock starts and stops at the sector lines.';
      case 'climb': return 'You start last, at the beginning of ' + s1 + ', with the field just ahead of you. Gain as many places as you can before the end of the sector. Running into a car costs a place.';
      case 'pitexit': return 'You start in your garage and the car drives itself down the pit lane. The clock starts at the pit exit and stops at the finish line.';
      case 'race': return 'A ' + ch.laps + '-lap race against ' + (ch.cars - 1) + ' cars. You start ' + ord(ch.grid) + '.';
      case 'defend': return 'You start on pole with ' + (ch.cars - 1) + ' cars behind you. Hold on to the lead for ' + ch.laps + ' laps.';
      case 'trap': return 'Come out of the corner onto the fastest straight as fast as you can: the speed trap is 250 m down the straight. You start just before the corner.';
    }
    return '';
  };
  function ord(n) { return n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'); }

  // ---------------------------------------------------------------- where things are on the track
  /* The speed trap: on the fastest straight, 250 m after the corner leading onto it (so the speed there shows how well
     you came out of the corner), and the start of the run to it: 200 m before that corner's slowest point. { s, start, v } */
  F1.dailyTrap = function (T) {
    if (T._trap) return T._trap;
    const N = T.n, ds = T.ds, prof = F1.speedProfile(T, 'hard'), vr = F1.dailyFly(T);
    let top = 0;
    for (let i = 1; i < N; i++) if (vr[i] > vr[top]) top = i;
    // back from the trap to the slowest point before it (the corner onto the straight)
    let k = top, low = top;
    for (let step = 0; step < N * 0.6; step++) {
      k = (k - 1 + N) % N;
      if (vr[k] < vr[low]) low = k;
      if (vr[k] > vr[low] + 25) break;
    }
    // the trap: 250 m after the corner (how well you came out of it still shows), and well before the braking zone
    let gap = top - low; if (gap < 0) gap += N;
    const at = low + Math.min(Math.round(250 / ds), Math.max(1, gap - Math.round(60 / ds)));
    const start = F1.wrapS(low * ds - 200, T.length), si = F1.idxAt(T, start);
    T._trap = { s: F1.wrapS(at * ds, T.length), start: start, v: Math.min(prof[si], vr[si]) * 0.92 };
    return T._trap;
  };
  /* The speed all round the lap flat out between the corners, for the Hard AI's cornering (where a car put down on the
     track should be going). */
  F1.dailyFly = function (T) {
    if (T._dfly) return T._dfly;
    const N = T.n, ds = T.ds, prof = F1.speedProfile(T, 'hard'), P = F1.PHYS, CAR = F1.CAR, vr = new Float64Array(N);
    let w = 20;
    for (let lap = 0; lap < 2; lap++) {
      for (let i = 0; i < N; i++) {
        const acc = Math.min(P.POWER / (CAR.MASS * Math.max(w, 4)), P.TRACT0) - (P.DRAG * w * w * T.airDrag) / CAR.MASS - P.ROLL;
        w = Math.min(prof[i], Math.sqrt(Math.max(1, w * w + 2 * acc * ds)));
        vr[i] = w;
      }
    }
    T._dfly = vr;
    return vr;
  };
  /* Where a sector run starts: 300 m before the sector line, at 90% of the speed the track allows there. */
  F1.DAILY_RUNUP = 300;
  F1.dailySectorStart = function (T, n) {
    const s = F1.wrapS(n * T.length / 3 - F1.DAILY_RUNUP, T.length);
    return { s: s, v: F1.dailyFly(T)[F1.idxAt(T, s)] * 0.9 };
  };
  /* Put car c at distance s along the track (d to the side of the racing line), heading down the track at speed v. */
  F1.dailyPlace = function (c, T, s, d, v) {
    const sw = F1.wrapS(s, T.length), i = F1.idxAt(T, sw), p = F1.trackPoint(T, sw, (T.rlOff[i] || 0) + (d || 0)), a = T.hd[i], Q = {};
    c.x = p.x; c.y = p.y; c.a = a; c.vx = Math.cos(a) * v; c.vy = Math.sin(a) * v; c.w = 0;
    c.px = c.x; c.py = c.y; c.pa = c.a;
    F1.queryTrack(T, c.x, c.y, -1, Q);
    c.seg = Q.idx; c.s = Q.s; c.d = Q.d; c.dist = Q.dist; c.prevS = c.s;
  };
  /* Climb the field: you (me) just after the sector line, the others in a bunch just ahead (a few side by side),
     everyone at racing speed. { G: your gates, B: the end of the sector, others: [{ c, at (how far ahead it started), G }] } */
  F1.dailyPack = function (S, me, ch) {
    const T = S.track, L = T.length, vr = F1.dailyFly(T), r = F1.rng((ch.seed ^ 0x51ed27) >>> 0);
    const s0 = ch.sector * L / 3 + 2, speed = function (s) { return vr[F1.idxAt(T, F1.wrapS(s, L))] * 0.88; };
    F1.dailyPlace(me, T, s0, 0, speed(s0));
    const G = new Gates(T, me), B = G.add(L / 3 - 2), others = [];
    const ai = S.cars.filter(function (c) { return c !== me; });
    let s = s0 + 16, prevD = null;
    for (let k = 0; k < ai.length; k++) {
      const c = ai[k];
      let side = k > 0 && r() < 0.25, d = (r() - 0.5) * 1.2;
      if (k > 0) s += side ? 2 + r() * 2 : 9 + r() * 10;
      const i = F1.idxAt(T, F1.wrapS(s, L)), room = Math.max(0.5, T.hwE[i] - 1.6);
      if (side && prevD !== null) { d = prevD > 0 ? prevD - 3.3 : prevD + 3.3; if (Math.abs(T.rlOff[i] + d) > room) { side = false; s += 8; d = 0; } }
      const di = F1.idxAt(T, F1.wrapS(s, L)), lim = Math.max(0.5, T.hwE[di] - 1.6);
      d = Math.max(-lim - T.rlOff[di], Math.min(lim - T.rlOff[di], d));
      F1.dailyPlace(c, T, s, d, speed(s));
      if (c.ai) { c.ai.latT = c.d; c.ai.bias = c.d - T.rlOff[c.seg]; }
      others.push({ c: c, at: s - s0, G: new Gates(T, c) });
      prevD = d;
    }
    return { G: G, B: B, others: others };
  };
  /* Places gained (o: { G, gates }): the others behind you now, less one for every car you ran into. */
  F1.dailyPlaces = function (o, hits) {
    const mine = o.G.prog, list = o.gates || o.others;
    let ahead = 0;
    for (let i = 0; i < list.length; i++) { const x = list[i]; if (!x.c.out && x.at + x.G.prog > mine) ahead++; }
    return list.length - ahead - (hits || 0);
  };
  /* How far a car has gone along the track since it was put down (forwards +, backwards -): gates are crossed at
     distances from there. step(c, time) after every step of the session; cross(dist) = the time it was crossed (null if not yet);
     speedAt(dist) = its speed there (m/s). */
  function Gates(T, c) {
    this.T = T; this.prog = 0; this.lastS = c.s; this.lastT = null; this.lastV = 0; this.list = [];
  }
  Gates.prototype.add = function (dist) { const g = { at: dist, t: null, v: null }; this.list.push(g); return g; };
  Gates.prototype.step = function (c, time) {
    const L = this.T.length;
    let d = c.s - this.lastS; d -= L * Math.round(d / L);
    const p0 = this.prog, p1 = p0 + d, v1 = Math.hypot(c.vx, c.vy);
    if (this.lastT !== null && p1 > p0) {
      for (let i = 0; i < this.list.length; i++) {
        const g = this.list[i];
        if (g.t === null && p0 < g.at && p1 >= g.at) {
          const f = (g.at - p0) / (p1 - p0);
          g.t = this.lastT + f * (time - this.lastT);
          g.v = this.lastV + f * (v1 - this.lastV);
        }
      }
    }
    this.prog = p1; this.lastS = c.s; this.lastT = time; this.lastV = v1;
  };
  F1.DailyGates = Gates;

  if (typeof module !== 'undefined' && module.exports) module.exports = F1;
})(typeof window !== 'undefined' ? window : globalThis);
