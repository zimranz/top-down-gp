/* Shared HUD + on-screen messages for practice, Grand Prix and online sessions. */
(function () {
  'use strict';
  const F1 = window.F1;

  /* Turn a session event into an on-screen message. codeOf(id) -> 'NOR' etc. */
  function eventMessage(msgs, e, myId, codeOf) {
    if (e.k === 'lightsOut') msgs.add('LIGHTS OUT AND AWAY WE GO!', { big: true, color: '#e10600', key: 'start', dur: 2600 });
    else if (e.k === 'go') msgs.add('QUALIFYING — GO!', { big: true, color: '#19c94a', key: 'start', dur: 2200 });
    else if (e.k === 'finalLap') msgs.add('FINAL LAP', { color: '#ffffff', key: 'final', dur: 3500 });
    else if (e.k === 'chequered') msgs.add('CHEQUERED FLAG', { sub: codeOf(e.id) + ' WINS', big: true, color: '#ffffff', key: 'cheq', dur: 4500 });
    else if (e.k === 'finish' && e.id === myId) msgs.add('FINISHED  P' + e.pos, { big: true, color: '#ffd600', key: 'fin', dur: 6000 });
    else if (e.k === 'qualiDone' && e.id === myId) {
      if (e.p) msgs.add('SESSION COMPLETE', { sub: 'Results coming up', color: '#19c94a', key: 'qd', dur: 6000 });
      else msgs.add('QUALIFYING COMPLETE', { sub: 'Keep driving — waiting for the others', color: '#19c94a', key: 'qd', dur: 6000 });
    }
    else if (e.k === 'lap') {
      if (e.id === myId) {
        // e.record = beat the personal best saved for this track
        const sub = e.fastest && e.record ? 'FASTEST LAP · NEW PERSONAL BEST' : e.fastest ? 'FASTEST LAP OF THE SESSION'
          : e.record ? 'NEW PERSONAL BEST' : e.pb ? 'SESSION BEST' : null;
        msgs.add('LAP ' + e.n + '   ' + F1.fmtLap(e.t), {
          sub: sub, subColor: e.fastest ? '#c77dff' : '#19c94a', color: e.fastest ? '#9b30ff' : '#19c94a', key: 'mylap', dur: e.record ? 5000 : 4000
        });
      } else if (e.fastest) {
        msgs.add('FASTEST LAP', { sub: codeOf(e.id) + '  ' + F1.fmtLap(e.t), color: '#9b30ff', subColor: '#c77dff', key: 'fl', dur: 3000 });
      }
    }
  }

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
      let info = '';
      if (r.out) info = 'OUT';
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
        pos: i + 1, code: e.driverId, color: F1.teamUiColor(t), info: info,
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
    if (o.phase === 0 && isRace) hud.lights = o.lights;
    if (o.phase === 0 && isQuali) {
      const left = Math.ceil(3 - o.time);
      if (left > 0) hud.centre = { text: String(left), size: 90 };
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
      hud.speed = Math.round(sp);
      hud.gear = window.gearFor(sp, vf);
      hud.drs = own.drsOpen ? 'open' : own.drsAllowed ? 'avail' : 'off';
      hud.pit = !!own.inPit;
      hud.posText = 'P' + pos + ' / ' + order.length;
      const has = function (v) { return v !== null && v !== undefined; };
      if (isRace) hud.lapText = r.fin ? 'FINISHED' : 'LAP ' + Math.min(o.laps, (r.laps || 0) + 1) + ' / ' + o.laps;
      else if (limited) hud.lapText = r.qdone ? (isQuali ? 'QUALIFYING COMPLETE' : 'SESSION COMPLETE') : !has(r.lapStart) ? 'OUT LAP' : 'TIMED LAP ' + Math.min(o.laps, (r.laps || 0) + 1) + ' / ' + o.laps;
      else hud.lapText = 'LAPS COMPLETED  ' + (r.laps || 0);
      if (has(r.lapStart) && o.phase >= 1 && !r.fin) hud.cur = F1.fmtLap(Math.max(0, o.time - r.lapStart));
      else hud.cur = isRace ? null : 'OUT LAP';
      hud.last = has(r.last) ? F1.fmtLap(r.last) : null;
      hud.best = has(r.best) ? F1.fmtLap(r.best) : null;
      hud.bestPurple = o.fastestId === o.myId;
      const pb = window.PB.get(T.id);
      hud.pb = pb ? F1.fmtLap(pb.t) : null;
      hud.wrongWay = o.wrongT > 1.2;
      if (performance.now() - o.started < 12000 && (o.phase === 0 || o.type === 'practice')) hud.hint = window.controlsHint();
      if (o.stuckT > 3 || o.wrongT > 4) {
        hud.msgs = hud.msgs.concat([{ text: 'STUCK?', sub: 'Press R to put the car back on track', color: '#ffd600' }]);
      }
    } else if (o.myId === null) {
      hud.msgs = hud.msgs.concat([{ text: 'SPECTATING', sub: 'You will join the next session', color: '#ffd600' }]);
    }
    return hud;
  }

  window.HUD = { eventMessage: eventMessage, build: buildHud };
})();
