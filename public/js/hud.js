/* Shared HUD + on-screen messages for practice, Grand Prix and online sessions. */
(function () {
  'use strict';
  const F1 = window.F1;

  let towAt = -1e9;      // when your car was last in a slipstream

  /* Turn a session event into an on-screen message. codeOf(id) -> 'NOR' etc. */
  function eventMessage(msgs, e, myId, codeOf) {
    if (e.k === 'lightsOut') msgs.add('LIGHTS OUT AND AWAY WE GO!', { big: true, color: '#e10600', key: 'start', dur: 2600 });
    else if (e.k === 'go') msgs.add('QUALIFYING — GO!', { big: true, color: '#19c94a', key: 'start', dur: 2200 });
    else if (e.k === 'finalLap') msgs.add('FINAL LAP', { color: '#ffffff', key: 'final', dur: 3500 });
    else if (e.k === 'chequered') msgs.add('CHEQUERED FLAG', { sub: codeOf(e.id) + ' WINS', big: true, color: '#ffffff', key: 'cheq', dur: 4500 });
    else if (e.k === 'finish' && e.id === myId) msgs.add('FINISHED  P' + e.pos, { big: true, color: '#ffd600', key: 'fin', dur: 6000 });
    else if (e.k === 'qualiDone' && e.id === myId) {
      if (e.p) msgs.add('SESSION COMPLETE', { sub: 'Results coming up', color: '#19c94a', from: 'eng', key: 'qd', dur: 6000 });
      else msgs.add('QUALIFYING OVER', { sub: 'Waiting for the others to finish their laps', color: '#19c94a', from: 'eng', key: 'qd', dur: 6000 });
    }
    else if (e.k === 'tl') {
      // corner cutting: a warning sign for you, penalties for everyone in the race
      if (e.id === myId) {
        if (e.pen) msgs.add('5 SECOND PENALTY', { sub: e.lap ? 'Track limits: 5 seconds added to this lap' : 'Track limits: added to your race time', sign: 'pen', from: 'rc', key: 'tl', dur: 5500 });
        else if (e.n === 0) msgs.add('TRACK LIMITS', { sub: "Don't cut corners", sign: 'warn', from: 'rc', key: 'tl', dur: 3500 });
        else msgs.add('TRACK LIMITS — WARNING ' + e.n + ' OF 3', { sub: e.n < 3 ? 'Stop cutting corners: after 3 warnings each cut is a 5-second penalty' : 'Last warning: the next cut is a 5-second penalty', sign: 'warn', from: 'rc', key: 'tl', dur: 5000 });
      } else if (e.pen && !e.lap) msgs.add('PENALTY  ' + codeOf(e.id), { sub: '5 seconds for track limits', color: '#ffd600', key: 'pen', dur: 3000 });
    }
    else if (e.k === 'tyres' && e.id === myId) {
      if (e.n === 1) msgs.add('TYRES FADING', { sub: '75% worn: grip will drop soon', color: '#ffd600', from: 'eng', key: 'tyres', dur: 4500 });
      else msgs.add('TYRES WORN OUT', { sub: 'You are losing a lot of time: box this lap', color: '#ff5a4f', from: 'eng', key: 'tyres', dur: 5500 });
    }
    else if (e.k === 'mustStop' && e.id === myId) {
      msgs.add('PIT STOP REQUIRED', { sub: e.left <= 1 ? 'Last lap: box now or get a 30-second penalty' : 'At least one stop this race: box within ' + e.left + ' laps', color: '#ffd600', from: 'eng', key: 'must', dur: 5500 });
    }
    else if (e.k === 'noStop') {
      if (e.id === myId) msgs.add('NO PIT STOP — 30 SECOND PENALTY', { sub: 'At least one stop was needed this race', sign: 'pen', from: 'rc', key: 'nostop', dur: 6000 });
      else msgs.add('PENALTY  ' + codeOf(e.id), { sub: '30 seconds: no pit stop', color: '#ffd600', key: 'pen', dur: 3000 });
    }
    else if (e.k === 'stopDone' && e.id === myId) {
      const ty = F1.TYRES[e.tyre];
      msgs.add('PIT STOP  ' + e.t.toFixed(1) + ' s', { sub: 'New ' + (ty ? ty.name.toLowerCase() : '') + ' tyres', color: '#19c94a', from: 'eng', key: 'stop', dur: 3500 });
    }
    else if (e.k === 'rainSoon') msgs.add('RAIN EXPECTED', { sub: e.heavy ? 'Heavy rain in about a minute' : 'Light rain in about a minute', color: '#6ec1ff', from: 'eng', key: 'wx', dur: 4500 });
    else if (e.k === 'rain') msgs.add(e.n === 2 ? 'HEAVY RAIN' : 'IT IS RAINING', { sub: e.n === 2 ? 'Water\u2019s building up: full wets soon' : 'The track is getting wet', color: '#6ec1ff', from: 'eng', key: 'wx', dur: 4500 });
    else if (e.k === 'rainStop') msgs.add('RAIN HAS STOPPED', { sub: 'The racing line will dry first', color: '#6ec1ff', from: 'eng', key: 'wx', dur: 4000 });
    else if (e.k === 'wxTyres' && e.id === myId) {
      // what is wrong with the tyres you are on (e.have)
      let title, sub;
      if (e.need === 'W') { title = 'BOX FOR FULL WETS'; sub = e.have === 'I' ? 'Too much water for your inters' : 'Slicks in standing water: no grip'; }
      else if (e.need === 'I') { title = 'BOX FOR INTERS'; sub = e.have === 'W' ? 'Too dry for full wets' : 'Track\u2019s too wet for slicks'; }
      else { title = 'TIME FOR SLICKS'; sub = 'The racing line is dry: box for slicks'; }
      msgs.add(title, { sub: sub, color: '#ffd600', from: 'eng', key: 'wxt', dur: 5500 });
    }
    else if (e.k === 'jump') {
      if (e.id === myId) msgs.add('JUMP START', { sub: '5-second penalty: wait for the lights to go out', sign: 'pen', from: 'rc', key: 'jump', dur: 6000 });
      else msgs.add('JUMP START  ' + codeOf(e.id), { sub: '5-second penalty', color: '#ffd600', key: 'pen', dur: 3500 });
    }
    else if (e.k === 'lap') {
      if (e.id === myId) {
        // e.record = beat the personal best saved for this track; e.ttRank = place in your time trial best laps
        const nth = function (n) { return n + (n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'); };
        const sub = e.ttRank > 1 ? 'YOUR ' + nth(e.ttRank).toUpperCase() + ' BEST LAP HERE'
          : e.fastest && e.record ? 'FASTEST LAP · NEW PERSONAL BEST' : e.fastest && !e.ttRank ? 'FASTEST LAP OF THE SESSION'
          : e.record ? 'NEW PERSONAL BEST' : e.pb ? 'SESSION BEST' : null;
        msgs.add('LAP ' + e.n + '   ' + F1.fmtLap(e.t), {
          sub: e.pen ? 'Includes ' + e.pen + ' s penalty for track limits' + (sub ? ' · ' + sub : '') : sub,
          subColor: e.pen ? '#ffd600' : e.fastest ? '#c77dff' : '#19c94a', color: e.fastest ? '#9b30ff' : '#19c94a', from: 'eng', quiet: true, key: 'mylap', dur: e.record ? 5000 : 4000
        });
      } else if (e.fastest) {
        msgs.add('FASTEST LAP', { sub: codeOf(e.id) + '  ' + F1.fmtLap(e.t), color: '#9b30ff', subColor: '#c77dff', key: 'fl', dur: 3000 });
      }
    }
  }

  /* Sector times of your current lap: the colours of the S1-S3 blocks and the pop-up after sectors 1 and 2.
     Green / yellow compare with the same sector of your personal-best lap on this track (saved with it);
     until one is saved, with your best lap of this session. Purple: the fastest by anyone this session. */
  function fmtSector(t) { return t >= 60 ? F1.fmtLap(t) : t.toFixed(3); }
  const SEC_COL = { purple: ['#9b30ff', '#c77dff'], green: ['#19c94a', '#7dff9b'], yellow: ['#ffd600', '#ffe46b'] };
  function SectorTracker(trackId) {
    this.track = trackId;
    this.cols = [null, null, null];
    this.clearAt = 0;
    this.sess = null;          // sector times of your best lap this session
    this.sessLap = Infinity;
  }
  SectorTracker.prototype.onSector = function (e, msgs) {
    const pb = window.PB.get(this.track), saved = pb && pb.sec && pb.sec.length === 3 ? pb.sec : null;
    const base = saved || this.sess, gap = base ? e.t - base[e.n] : null;
    const col = e.best ? 'purple' : gap === null || gap <= 0 ? 'green' : 'yellow';
    if (e.n === 0) this.cols = [null, null, null];
    this.cols[e.n] = col;
    this.clearAt = e.n === 2 ? performance.now() + 6000 : 0;      // the finished lap stays up for a moment
    if (e.n < 2 && msgs) {
      const sub = gap === null ? (e.best ? 'FASTEST OF THE SESSION' : null)
        : (gap <= 0 ? '−' : '+') + Math.abs(gap).toFixed(3) + (saved ? '  VS YOUR BEST LAP' : '  VS YOUR SESSION BEST');
      msgs.add('SECTOR ' + (e.n + 1) + '   ' + fmtSector(e.t), { sub: sub, color: SEC_COL[col][0], subColor: SEC_COL[col][1], from: 'eng', quiet: true, key: 'sector', dur: 2600 });
    }
  };
  SectorTracker.prototype.onLap = function (e) {
    if (e.sec && !e.pen && e.t < this.sessLap) { this.sessLap = e.t; this.sess = e.sec; }
  };
  SectorTracker.prototype.view = function () {
    if (this.clearAt && performance.now() > this.clearAt) { this.cols = [null, null, null]; this.clearAt = 0; }
    return this.cols;
  };

  /* Live gaps in a race, the way TV measures them: how long ago the car ahead was exactly where you are now, and
     how long ago you were where the car behind is now. Every car's distance is noted against the race clock as it
     goes round; the gaps come from those notes, so they change smoothly, corner by corner. trend: green when you
     are gaining on the car ahead / pulling away from the car behind, red when losing (over about the last second). */
  function GapTracker() { this.h = {}; this.hist = { a: [], b: [] }; this.who = { a: null, b: null }; }
  GapTracker.prototype.note = function (id, d, t) {
    let H = this.h[id];
    if (!H || d < H.d[H.d.length - 1] - 30 || t < H.t[H.t.length - 1]) H = this.h[id] = { d: [d], t: [t] };   // (a new session)
    else if (d > H.d[H.d.length - 1] + 2) {
      H.d.push(d); H.t.push(t);
      if (H.d.length > 6000) { H.d.splice(0, 2000); H.t.splice(0, 2000); }
    }
  };
  // when car id was at distance d (null if not known)
  GapTracker.prototype.timeAt = function (id, d) {
    const H = this.h[id];
    if (!H || d < H.d[0] || d > H.d[H.d.length - 1]) return null;
    let lo = 0, hi = H.d.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (H.d[m] <= d) lo = m; else hi = m; }
    const span = H.d[hi] - H.d[lo];
    return span > 0 ? H.t[lo] + (H.t[hi] - H.t[lo]) * (d - H.d[lo]) / span : H.t[lo];
  };
  GapTracker.prototype.trend = function (k, who, gap, t) {
    if (this.who[k] !== who) { this.who[k] = who; this.hist[k] = []; }
    const H = this.hist[k];
    if (!H.length || t - H[H.length - 1][0] > 0.1) H.push([t, gap]);
    while (H.length > 2 && t - H[1][0] > 1.2) H.shift();
    return H.length > 1 && t - H[0][0] > 0.5 ? gap - H[0][1] : 0;
  };
  // -> { a: {text, color} | null, b: ... }
  GapTracker.prototype.update = function (o) {
    const rows = o.rows, order = o.order, L = o.track.length, t = o.time;
    for (let i = 0; i < order.length; i++) { const r = rows[order[i]]; if (r && !r.out && r.dist >= 0) this.note(order[i], r.dist, t); }
    const me = rows[o.myId], at = order.indexOf(o.myId);
    if (!me || me.fin || me.out || at < 0 || o.phase < 1) return null;
    let ia = at - 1, ib = at + 1;
    while (ia >= 0 && rows[order[ia]] && rows[order[ia]].out) ia--;
    while (ib < order.length && rows[order[ib]] && rows[order[ib]].out) ib++;
    const code = function (id) { return o.entries[id] ? o.entries[id].driverId : ''; };
    const out = { a: null, b: null };
    const show = function (k, gap, who, sign) {
      const tr = this.trend(k, who, gap, t), good = k === 'a' ? tr < -0.03 : tr > 0.03, bad = k === 'a' ? tr > 0.03 : tr < -0.03;
      out[k] = { text: sign + gap.toFixed(1) + ' ' + code(who), color: good ? '#19c94a' : bad ? '#ff5a4f' : '#ffffff' };
    }.bind(this);
    if (ia >= 0) {
      const id = order[ia], r = rows[id];
      if (r.dist - me.dist > L) { const n = Math.floor((r.dist - me.dist) / L); out.a = { text: '+' + n + (n > 1 ? ' LAPS ' : ' LAP ') + code(id), color: '#ffffff' }; }
      else { const ta = this.timeAt(id, me.dist); if (ta !== null) show('a', Math.max(0, t - ta), id, '+'); }
    }
    if (ib < order.length) {
      const id = order[ib], r = rows[id];
      if (me.dist - r.dist > L) { const n = Math.floor((me.dist - r.dist) / L); out.b = { text: '\u2212' + n + (n > 1 ? ' LAPS ' : ' LAP ') + code(id), color: '#ffffff' }; }
      else { const tm = this.timeAt(o.myId, r.dist); if (tm !== null) show('b', Math.max(0, t - tm), id, '\u2212'); }
    }
    return out;
  };

  /* o = { type, laps, track, order, rows:{id:{laps,last,best,gap,lapStart,fin,out,qdone,dist}}, entries:{id:{driverId}},
           myId, phase (0 countdown, 1 running, 2 finishing, 3 done), lights, time, timeLeft, fastestId,
           own (car state or null), msgs, ping, started, wrongT, stuckT } */
  function buildHud(o) {
    const T = o.track, rows = o.rows, order = o.order, isRace = o.type === 'race', isQuali = o.type === 'quali';
    const limited = isQuali || (o.type === 'practice' && o.laps > 0);   // a set number of timed laps
    const leader = rows[order[0]] || null;
    const tower = order.map(function (id, i) {
      const e = o.entries[id], r = rows[id] || {};
      const t = F1.teamOfDriver(e.driverId);
      let info = '', tag = null;
      if (r.out) info = 'OUT';
      else if (r.gar) { info = 'GARAGE'; tag = 'gar'; }          // in the garage (practice)
      else if (r.pit) { info = 'IN PIT'; tag = 'pit'; }          // in the pit lane
      else if (isRace) {
        if (i === 0) info = r.fin ? 'WINNER' : 'LEADER';
        else if (leader && leader.dist - r.dist > T.length && !r.fin) {
          const n = Math.floor((leader.dist - r.dist) / T.length);
          info = '+' + n + (n > 1 ? ' LAPS' : ' LAP');
        } else {
          const ahead = rows[order[i - 1]];
          info = '+' + Math.max(0, ahead ? r.gap - ahead.gap : 0).toFixed(1);
        }
      } else info = r.best !== null && r.best !== undefined ? F1.fmtLap(r.best) : 'NO TIME';
      return {
        pos: i + 1, code: e.driverId, color: F1.teamUiColor(t), info: info, tag: tag, pen: isRace && r.pen ? r.pen : 0,
        tyre: o.tyresShow && r.ty && !r.out ? r.ty : null,
        me: Number(id) === o.myId, out: !!r.out, done: isRace ? !!r.fin : !!r.qdone, purple: !isRace && Number(id) === o.fastestId
      };
    });
    const hud = {
      title: o.title || (isRace ? 'RACE' : isQuali ? 'QUALIFYING' : 'PRACTICE'),
      towerRight: isRace ? 'LAP ' + Math.min(o.laps, (leader ? leader.laps : 0) + 1) + '/' + o.laps : (T.short || T.name).toUpperCase(),
      tower: tower,
      msgs: o.msgs.active(),
      ping: o.ping
    };
    if (o.delta !== null && o.delta !== undefined && isFinite(o.delta)) {
      hud.delta = { text: (o.delta >= 0 ? '+' : '−') + Math.abs(o.delta).toFixed(3), color: o.delta > 0.0005 ? '#ff5a4f' : '#19c94a' };
    }
    if (o.phase === 0 && isRace) { hud.lights = o.lights; hud.lightsNote = 'GO WHEN THE LIGHTS GO OUT'; }
    if (o.phase === 0 && isQuali) {
      const left = Math.ceil(3 - o.time);
      if (left > 0) hud.centre = { text: String(left), size: 90 };
    }
    // the weather (when it is raining or the track is wet): under the minimap
    const W = o.weather;
    if (W && (W.rain > 0.06 || W.wet > 0.04)) {
      const lw = W.wet * (1 - 0.65 * W.ld);
      const sky = W.rain > 0.55 ? 'HEAVY RAIN' : W.rain > 0.06 ? 'LIGHT RAIN' : 'DRYING';
      const trk = lw > 0.6 ? 'VERY WET' : lw > 0.14 ? 'WET' : lw > 0.05 ? 'DAMP' : 'DRY LINE';
      hud.weather = { rain: W.rain, text: sky + ' · ' + trk, short: (W.rain > 0.06 ? 'RAIN' : 'DRYING') + ' · ' + trk };
    }
    if (limited && o.timeLeft >= 0) {
      const m = Math.floor(o.timeLeft / 60), s = Math.floor(o.timeLeft % 60);
      hud.timeLeft = 'SESSION ' + m + ':' + (s < 10 ? '0' : '') + s;
    }
    const own = o.own;
    if (own && !own.out) {
      const r = rows[o.myId] || {};
      const sp = Math.hypot(own.vx, own.vy) * 3.6;
      const vf = own.vx * Math.cos(own.a) + own.vy * Math.sin(own.a);
      const pos = order.indexOf(o.myId) + 1;
      const mph = window.Settings && window.Settings.data.units === 'mph';
      hud.speed = Math.round(mph ? sp / 1.609344 : sp);
      hud.unit = mph ? 'MPH' : 'KM/H';
      hud.gear = window.gearFor(sp, vf);
      hud.drs = own.drsOpen ? 'open' : own.drsAllowed ? 'avail' : 'off';
      const touch = window.Input.touch.active;
      hud.drsHint = touch ? 'DRS — TAP DRS' : 'DRS — PRESS ' + window.KeyBind.label('drs').toUpperCase();
      hud.pit = !!own.inPit;
      // your tyres: compound, and how worn (when tyre wear is on)
      if (o.tyresShow && r.ty) hud.tyre = { c: r.ty, w: o.tyres ? r.tw || 0 : null };
      // slipstream: towed along by the car ahead (held on for a moment, so the sign doesn't flicker)
      if ((own.tow || 1) < 0.975 && sp > 120 && !own.inPit) towAt = performance.now();
      hud.tow = performance.now() - towAt < 450;
      hud.posText = 'P' + pos + ' / ' + order.length;
      const has = function (v) { return v !== null && v !== undefined; };
      if (isRace) hud.lapText = r.fin ? 'FINISHED' : 'LAP ' + Math.min(o.laps, (r.laps || 0) + 1) + ' / ' + o.laps;
      if (isRace && o.gaps) hud.gaps = o.gaps.update(o);
      else if (limited) hud.lapText = r.qdone ? (isQuali ? 'QUALIFYING COMPLETE' : 'SESSION COMPLETE') : !has(r.lapStart) ? 'OUT LAP' : 'TIMED LAP ' + Math.min(o.laps, (r.laps || 0) + 1) + ' / ' + o.laps;
      else hud.lapText = 'LAPS COMPLETED  ' + (r.laps || 0);
      if (has(r.lapStart) && o.phase >= 1 && !r.fin) hud.cur = F1.fmtLap(Math.max(0, o.time - r.lapStart));
      else hud.cur = isRace ? null : 'OUT LAP';
      hud.last = has(r.last) ? F1.fmtLap(r.last) : null;
      hud.best = has(r.best) ? F1.fmtLap(r.best) : null;
      hud.bestPurple = o.fastestId === o.myId;
      const pb = window.PB.get(T.id);
      hud.pb = pb ? F1.fmtLap(pb.t) : null;
      hud.sectors = o.sectors || null;
      hud.wrongWay = o.wrongT > 1.2;
      if (!touch && performance.now() - o.started < 12000 && (o.phase === 0 || o.type === 'practice')) hud.hint = window.controlsHint();
      if (o.stuckT > 3 || o.wrongT > 4) {
        hud.stuck = true;
        hud.msgs = hud.msgs.concat([{ text: 'STUCK?', sub: touch ? 'Tap the reset button (↺) to put the car back on track' : 'Press R to put the car back on track', color: '#ffd600' }]);
      }
    } else if (o.myId === null) {
      hud.msgs = hud.msgs.concat([{ text: 'SPECTATING', sub: 'You will join the next session', color: '#ffd600' }]);
    }
    return hud;
  }

  /* Banked corners (Zandvoort): say once per corner and session that the slope gives more grip. seen = {} kept by the game. */
  function bankHint(T, car, msgs, seen) {
    if (!T.bank || !car || car.out || !(T.bank[car.seg] > 1.08)) return;
    for (let z = 0; z < T.banked.length; z++) {
      const b = T.banked[z];
      let rel = car.s - b.s0; rel -= Math.floor(rel / T.length) * T.length;
      if (rel <= b.s1 - b.s0 && !seen[z]) {
        seen[z] = true;
        msgs.add('BANKED CORNER', { sub: 'The slope presses the car down: more grip, carry more speed', color: '#3fb6ff', from: 'eng', key: 'bank', dur: 3800 });
      }
    }
  }

  window.HUD = { eventMessage: eventMessage, build: buildHud, bankHint: bankHint, GapTracker: GapTracker };
  window.SectorTracker = SectorTracker;
})();
