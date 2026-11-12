'use strict';
/* Top-Down GP — game server.
   Serves the game files and runs online sessions: rooms with codes, lobby, practice -> qualifying -> race,
   and online championships (a season of race weekends with friends).
   The server simulates every car 60 times a second (authoritative), sends snapshots 20x/s. */
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

require('./shared/data');
require('./shared/tracks');
require('./shared/sim');
const F1 = globalThis.F1;

const PORT = process.env.PORT || 3000;
const MAX_HUMANS = 8;
const GRID_SIZE = 22;
const MAX_ROOMS = 200;
const PHASE_CODE = { countdown: 0, running: 1, finishing: 2, done: 3 };
const STAGE_TITLE = { p1: 'PRACTICE 1', p2: 'PRACTICE 2', p3: 'PRACTICE 3', quali: 'QUALIFYING', race: 'RACE' };
const NEXT_IN = 12;      // seconds between the sessions of a weekend
const RESUME_MS = 3000;  // a paused season carries on after a 3-2-1
const MAX_ROUNDS = Object.keys(F1.TRACK_DEFS).length;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));
app.get('/healthz', function (req, res) { res.send('ok'); });

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

// Build tracks (racing lines, AI speed profiles) once at start-up.
Object.keys(F1.TRACK_DEFS).forEach(function (id) {
  const T = F1.getTrack(id);
  ['easy', 'medium', 'hard'].forEach(function (lv) { F1.speedProfile(T, lv); });
  F1.refLapTime(T);
});

const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  let c;
  do {
    c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(c));
  return c;
}
function newKey() { return crypto.randomBytes(12).toString('hex'); }

function cleanName(n) {
  const s = String(n || '').replace(/[<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s || 'Player';
}
/* The private id a browser keeps for itself, so the season knows you when you come back. */
function cleanToken(t) {
  const s = String(t || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return s.length >= 8 ? s : null;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function intIn(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

const r2 = function (v) { return Math.round(v * 100) / 100; };
const r3 = function (v) { return Math.round(v * 1000) / 1000; };
const r4 = function (v) { return Math.round(v * 10000) / 10000; };

function newRoom(code, hostId) {
  const room = {
    code: code,
    hostId: hostId,
    players: new Map(),
    settings: { mode: 'single', track: 'monza', calendar: ['suzuka', 'montreal', 'silverstone', 'monza', 'baku'],
      p1: 0, p2: 0, p3: 0, qualiLaps: 2, raceLaps: 5, aiCount: 21, aiLevel: 'medium' },
    state: 'lobby',
    session: null,
    carOf: new Map(), ownerOf: new Map(), inputQ: new Map(), lastIn: new Map(), ack: new Map(), lastSeq: new Map(),
    qualiOrder: null, weekendAI: null, stages: null, stageIdx: 0, stage: null, timer: null, lastResults: null,
    // championship: the season, and the pause while the host is away
    season: null, hostAway: false, awayName: null, awayCar: null, resumeAt: 0
  };
  rooms.set(code, room);
  return room;
}

function roomPayload(room) {
  const se = room.season;
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    settings: room.settings,
    maxHumans: MAX_HUMANS,
    hostAway: room.hostAway,
    awayName: room.awayName,
    resumeIn: room.resumeAt ? Math.max(0, room.resumeAt - Date.now()) : 0,
    season: se ? { done: se.done, played: se.rounds.length, of: se.calendar.length, next: se.done ? null : se.calendar[se.rounds.length] } : null,
    players: Array.from(room.players.values()).map(function (p) {
      return { id: p.id, name: p.name, driverId: p.driverId, inSession: room.carOf.has(p.id), seat: !!p.eid };
    })
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room', roomPayload(room));
}

function sessionInfo(room) {
  const S = room.session;
  return {
    type: S.type,
    stage: room.stage,
    title: (room.season ? 'R' + (room.season.rounds.length + 1) + ' ' : '') + (STAGE_TITLE[room.stage] || ''),
    track: S.track.id,
    laps: S.laps,
    aiLevel: S.aiLevel,
    entries: S.cars.map(function (c) {
      return { id: c.id, driverId: c.driverId, isAI: c.isAI, name: c.name, owner: room.ownerOf.get(c.id) || null };
    })
  };
}

// ------------------------------------------------------------- championship
/* A season: { v, key (the host's secret), calendar, opts, aiDrivers, entrants:[{ eid, name, driverId, human, token, from }],
   rounds:[{ track, res:[{ eid, d, pos, pts, out: null|'left'|'absent' }] }], done }.
   The same drivers race all season: players keep their car, the AI drivers are fixed when it starts. */
function driverTaken(se, driverId) {
  return se.entrants.some(function (e) { return e.driverId === driverId; });
}
function uniqueEid(se, base) {
  let eid = base;
  while (se.entrants.some(function (e) { return e.eid === eid; })) eid = base + ':' + crypto.randomBytes(3).toString('hex');
  return eid;
}

/* Give a player their place in the season: their car from before if they have raced in it (same browser,
   or the same name), otherwise a free car with 0 points. With every car taken they can only watch. */
function seatPlayer(room, p) {
  const se = room.season;
  if (!se || p.eid) return;
  const here = new Set();
  room.players.forEach(function (q) { if (q !== p && q.eid) here.add(q.eid); });
  let e = p.token ? se.entrants.find(function (x) { return x.human && x.token === p.token && !here.has(x.eid); }) : null;
  if (!e) e = se.entrants.find(function (x) { return x.human && !here.has(x.eid) && x.name.toLowerCase() === p.name.toLowerCase(); });
  if (!e) {
    const pick = p.driverId && F1.driver(p.driverId) && !driverTaken(se, p.driverId) ? p.driverId : null;
    const free = pick || (F1.DRIVERS.find(function (d) { return !driverTaken(se, d.id); }) || {}).id;
    if (!free) { p.driverId = null; return; }
    // joining in the middle of a round: their first round is the next one
    const midRound = !!room.session || room.state === 'stageResults';
    e = { eid: uniqueEid(se, 'p:' + (p.token || newKey())), name: p.name, driverId: free, human: true, token: p.token, from: se.rounds.length + (midRound ? 1 : 0) };
    se.entrants.push(e);
  }
  e.name = p.name;
  if (p.token) e.token = p.token;
  p.eid = e.eid;
  p.driverId = e.driverId;
}

function startSeason(room) {
  const st = room.settings;
  const humans = Array.from(room.players.values());
  const taken = new Set();
  humans.forEach(function (p) {
    if (p.driverId && F1.driver(p.driverId) && !taken.has(p.driverId)) taken.add(p.driverId);
    else p.driverId = null;
  });
  humans.forEach(function (p) {
    if (!p.driverId) { const free = F1.DRIVERS.find(function (d) { return !taken.has(d.id); }); p.driverId = free.id; taken.add(free.id); }
  });
  const aiCount = intIn(st.aiCount, 0, GRID_SIZE - humans.length, 0);
  const ai = shuffle(F1.DRIVERS.filter(function (d) { return !taken.has(d.id); })).slice(0, aiCount).map(function (d) { return d.id; });
  const se = {
    v: 1, key: newKey(), calendar: st.calendar.slice(0, MAX_ROUNDS),
    opts: { p1: st.p1, p2: st.p2, p3: st.p3, qualiLaps: st.qualiLaps, raceLaps: st.raceLaps, aiLevel: st.aiLevel, aiCount: ai.length },
    aiDrivers: ai, entrants: [], rounds: [], done: false
  };
  humans.forEach(function (p) {
    const e = { eid: uniqueEid(se, 'p:' + (p.token || newKey())), name: p.name, driverId: p.driverId, human: true, token: p.token, from: 0 };
    se.entrants.push(e);
    p.eid = e.eid;
  });
  ai.forEach(function (id) { se.entrants.push({ eid: 'ai:' + id, name: F1.driver(id).name, driverId: id, human: false, token: null, from: 0 }); });
  room.season = se;
  startRound(room);
  broadcastSeason(room);
}

/* The next race weekend of the season, with the sessions the host picked. */
function startRound(room) {
  const se = room.season;
  if (!se || se.done) return;
  const o = se.opts;
  room.settings.track = se.calendar[se.rounds.length];
  room.qualiOrder = null;
  room.weekendAI = se.aiDrivers.slice();
  room.lastResults = null;
  room.stages = ['p1', 'p2', 'p3'].filter(function (k) { return o[k] > 0; });
  if (o.qualiLaps > 0) room.stages.push('quali');
  room.stages.push('race');
  room.stageIdx = 0;
  startSession(room, room.stages[0]);
}

/* Championship order: points, then most wins, most 2nd places, ... (eids). */
function seasonOrder(se) {
  const tot = {};
  se.entrants.forEach(function (e, k) { tot[e.eid] = { eid: e.eid, pts: 0, count: new Array(41).fill(0), k: k }; });
  se.rounds.forEach(function (rd) {
    rd.res.forEach(function (x) { const t = tot[x.eid]; if (t) { t.pts += x.pts; if (!x.out) t.count[x.pos]++; } });
  });
  return Object.keys(tot).map(function (k) { return tot[k]; }).sort(function (a, b) {
    if (b.pts !== a.pts) return b.pts - a.pts;
    for (let p = 1; p < 41; p++) if (b.count[p] !== a.count[p]) return b.count[p] - a.count[p];
    return a.k - b.k;
  }).map(function (t) { return t.eid; });
}

/* A race of the season is over: everyone classified scores by position (drivers who left are classified
   behind the others); drivers in the season who missed it are placed last and score if that is in the top 10. */
function recordRound(room, track, results) {
  const se = room.season;
  const byDriver = {};
  se.entrants.forEach(function (e) { byDriver[e.driverId] = e; });
  const res = [];
  results.forEach(function (r) {
    const e = byDriver[r.driverId];
    if (e) res.push({ eid: e.eid, d: r.driverId, pos: r.pos, pts: r.pts || 0, out: r.left ? 'left' : null });
  });
  const raced = new Set(res.map(function (x) { return x.eid; }));
  const order = seasonOrder(se), idx = se.rounds.length;
  se.entrants
    .filter(function (e) { return !raced.has(e.eid) && (e.from || 0) <= idx; })
    .sort(function (a, b) { return order.indexOf(a.eid) - order.indexOf(b.eid); })
    .forEach(function (e) {
      const pos = res.length + 1;
      res.push({ eid: e.eid, d: e.driverId, pos: pos, pts: F1.POINTS[pos - 1] || 0, out: 'absent' });
    });
  se.rounds.push({ track: track, res: res });
  if (se.rounds.length >= se.calendar.length) se.done = true;
}

/* What each player is told about the season. The host also gets a full copy to keep in their browser,
   so the season can carry on another day (or after the server restarts). */
function seasonPayload(room, p) {
  const se = room.season;
  if (!se) return null;
  const here = new Set();
  room.players.forEach(function (q) { if (q.eid) here.add(q.eid); });
  const out = {
    calendar: se.calendar, opts: se.opts, rounds: se.rounds, done: se.done, you: p.eid || null,
    entrants: se.entrants.map(function (e) { return { eid: e.eid, name: e.name, driverId: e.driverId, human: e.human, here: here.has(e.eid), from: e.from || 0 }; })
  };
  if (p.id === room.hostId) out.save = { code: room.code, key: se.key, season: se };
  return out;
}
function broadcastSeason(room) {
  if (!room.season) return;
  room.players.forEach(function (p) { io.to(p.id).emit('season', seasonPayload(room, p)); });
}

/* A season the host kept in their browser, read back (everything checked: it came from a browser). */
function cleanSeason(s, key) {
  if (!s || typeof s !== 'object' || s.done) return null;
  const cal = [];
  (Array.isArray(s.calendar) ? s.calendar : []).forEach(function (id) { if (F1.TRACK_DEFS[id] && cal.length < MAX_ROUNDS) cal.push(id); });
  if (cal.length < 2) return null;
  const o = s.opts || {};
  const opts = { p1: intIn(o.p1, 0, 3, 0), p2: intIn(o.p2, 0, 3, 0), p3: intIn(o.p3, 0, 3, 0), qualiLaps: intIn(o.qualiLaps, 0, 5, 2),
    raceLaps: intIn(o.raceLaps, 1, 7, 5), aiLevel: F1.AI_LEVELS[o.aiLevel] ? o.aiLevel : 'medium', aiCount: 0 };
  const used = new Set(), entrants = [];
  (Array.isArray(s.entrants) ? s.entrants : []).slice(0, GRID_SIZE + 8).forEach(function (e) {
    if (!e || !F1.driver(e.driverId) || used.has(e.driverId)) return;
    const eid = String(e.eid || '').replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 64);
    if (!eid || entrants.some(function (x) { return x.eid === eid; })) return;
    used.add(e.driverId);
    entrants.push({ eid: eid, name: e.human ? cleanName(e.name) : F1.driver(e.driverId).name, driverId: e.driverId, human: !!e.human,
      token: e.human ? cleanToken(e.token) : null, from: intIn(e.from, 0, MAX_ROUNDS, 0) });
  });
  if (entrants.length > GRID_SIZE + 8 || !entrants.some(function (e) { return e.human; })) return null;
  const aiDrivers = entrants.filter(function (e) { return !e.human; }).map(function (e) { return e.driverId; });
  opts.aiCount = aiDrivers.length;
  const ids = {};
  entrants.forEach(function (e) { ids[e.eid] = e; });
  const rounds = [];
  const list = Array.isArray(s.rounds) ? s.rounds : [];
  for (let k = 0; k < list.length && k < cal.length - 1; k++) {
    const rd = list[k];
    if (!rd || rd.track !== cal[k] || !Array.isArray(rd.res)) break;
    rounds.push({ track: rd.track, res: rd.res.filter(function (x) { return x && ids[x.eid]; }).slice(0, 40).map(function (x) {
      return { eid: x.eid, d: ids[x.eid].driverId, pos: intIn(x.pos, 1, 40, 40), pts: intIn(x.pts, 0, 26, 0), out: x.out === 'left' || x.out === 'absent' ? x.out : null };
    }) });
  }
  return { v: 1, key: typeof key === 'string' && key.length >= 16 ? key.slice(0, 64) : newKey(), calendar: cal, opts: opts, aiDrivers: aiDrivers, entrants: entrants, rounds: rounds, done: false };
}

/* The host ends the season (or it is over and they go back to the lobby). */
function endSeason(room) {
  const finished = !!(room.season && room.season.done);
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  room.session = null;
  room.carOf = new Map(); room.ownerOf = new Map();
  room.season = null;
  room.hostAway = false; room.awayName = null; room.awayCar = null; room.resumeAt = 0;
  room.state = 'lobby';
  room.lastResults = null;
  room.players.forEach(function (p) { p.eid = null; });
  if (!room.players.has(room.hostId)) room.hostId = room.players.keys().next().value;
  io.to(room.code).emit('seasonEnded', { finished: finished });
  broadcastRoom(room);
}

/* The host is back: their car is theirs again and the season carries on after a 3-2-1
   (or, between sessions, the countdown to the next session starts again). */
function hostBack(room, p) {
  room.hostAway = false;
  room.awayName = null;
  if (room.session) {
    const id = room.awayCar, c = id !== null ? room.session.byId[id] : null;
    if (c && !c.out) {
      room.carOf.set(p.id, id); room.ownerOf.set(id, p.id);
      room.inputQ.set(id, []); room.ack.set(id, 0); room.lastSeq.set(id, 0); room.lastIn.set(id, F1.NEUTRAL);
    }
    room.awayCar = null;
    room.resumeAt = Date.now() + RESUME_MS;
  } else if (room.state === 'stageResults' && room.lastResults) {
    room.lastResults.nextIn = NEXT_IN;
    io.to(room.code).emit('sessionEnd', room.lastResults);
    scheduleNext(room);
  }
}

// ------------------------------------------------------------- sessions
/* stage: 'p1' | 'p2' | 'p3' | 'quali' | 'race' */
function startSession(room, stage) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  const type = stage === 'quali' || stage === 'race' ? stage : 'practice';
  const se = room.season, o = se ? se.opts : room.settings;
  const T = F1.getTrack(room.settings.track);
  let humans = Array.from(room.players.values());
  let aiDrivers;
  if (se) {
    // a season: everyone keeps their car; players without one (every car taken) watch
    humans.forEach(function (p) { seatPlayer(room, p); });
    humans = humans.filter(function (p) { return p.eid && p.driverId; });
    aiDrivers = se.aiDrivers.map(function (id) { return F1.driver(id); });
  } else {
    const taken = new Set();
    humans.forEach(function (p) {
      if (p.driverId && F1.driver(p.driverId) && !taken.has(p.driverId)) taken.add(p.driverId);
      else p.driverId = null;
    });
    humans.forEach(function (p) {
      if (!p.driverId) {
        const free = F1.DRIVERS.find(function (d) { return !taken.has(d.id); });
        p.driverId = free.id;
        taken.add(free.id);
      }
    });
    const aiCount = intIn(room.settings.aiCount, 0, GRID_SIZE - humans.length, 0);
    if (room.weekendAI) {
      // the same AI drivers all weekend (practice, qualifying and the race)
      aiDrivers = room.weekendAI.filter(function (id) { return !taken.has(id); }).map(function (id) { return F1.driver(id); });
      const extra = shuffle(F1.DRIVERS.filter(function (d) { return !taken.has(d.id) && aiDrivers.indexOf(d) < 0; }));
      while (aiDrivers.length < aiCount && extra.length) aiDrivers.push(extra.pop());
      aiDrivers = aiDrivers.slice(0, aiCount);
    } else {
      aiDrivers = shuffle(F1.DRIVERS.filter(function (d) { return !taken.has(d.id); })).slice(0, aiCount);
    }
    room.weekendAI = aiDrivers.map(function (d) { return d.id; });
  }
  if (!humans.length) return;
  room.stage = stage;
  let entries = humans.map(function (p) { return { driverId: p.driverId, isAI: false, name: p.name, owner: p.id }; })
    .concat(aiDrivers.map(function (d) { return { driverId: d.id, isAI: true }; }));
  if (type === 'race' && room.qualiOrder) {
    const order = room.qualiOrder;
    entries.sort(function (a, b) {
      const ia = order.indexOf(a.driverId), ib = order.indexOf(b.driverId);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  } else {
    entries = shuffle(entries);
  }
  entries.forEach(function (e, k) { e.id = k; });

  const S = new F1.Session({
    type: type,
    track: T,
    entries: entries,
    laps: type === 'race' ? o.raceLaps : type === 'quali' ? o.qualiLaps : o[stage],
    aiLevel: o.aiLevel,
    collisions: true,
    seed: Math.floor(Math.random() * 1e9),
    startMode: type === 'practice' ? 'pit' : 'grid'      // practice: you start in your team's garage
  });
  room.session = S;
  room.state = type;
  room.carOf = new Map();
  room.ownerOf = new Map();
  room.inputQ = new Map();
  room.lastIn = new Map();
  room.ack = new Map();
  room.lastSeq = new Map();
  room.awayCar = null;
  room.resumeAt = 0;
  entries.forEach(function (e) {
    if (!e.isAI) {
      room.carOf.set(e.owner, e.id);
      room.ownerOf.set(e.id, e.owner);
      room.inputQ.set(e.id, []);
      room.ack.set(e.id, 0);
    }
  });
  io.to(room.code).emit('session', sessionInfo(room));
  broadcastRoom(room);
}

/* keepFx: a one-off copy for one player (joining): the contact effects stay for everyone's next snapshot. */
function snapshot(room, keepFx) {
  const S = room.session;
  const cars = [];
  for (let i = 0; i < S.cars.length; i++) {
    const c = S.cars[i];
    if (c.out) { cars.push([c.id, 0, 0, 0, 0, 0, 0, 0, 64, 0]); continue; }
    const lv = S.track.bridge ? F1.levelAt(S.track, c.s) : 0;       // on a bridge (512) or underneath it (1024)
    let flags = (c.drsOpen ? 1 : 0) | (c.locked ? 2 : 0) | (c.slide ? 4 : 0) | (c.finished ? 32 : 0) | (c.lockFx ? 256 : 0) | (lv > 0 ? 512 : lv < 0 ? 1024 : 0);
    for (let z = 0; z < c.drsElig.length; z++) if (c.drsElig[z]) flags |= 8 << z;
    cars.push([c.id, r2(c.x), r2(c.y), r4(c.a), r2(c.vx), r2(c.vy), r3(c.w), r3(c.delta), flags, room.ack.get(c.id) || 0]);
  }
  // w: when the server sent this (ms): lets players tell a slow server from a slow connection
  return { t: S.tick, tm: r3(S.time), ph: PHASE_CODE[S.phase], l: S.lights, c: cars, fx: keepFx ? [] : S.drainFx(), w: Math.round(performance.now()) };
}

/* Each player's connection as their game measures it: [car id, ping ms, worst delay spike ms]. */
function netInfo(room) {
  const out = [];
  room.carOf.forEach(function (carId, sid) {
    const p = room.players.get(sid);
    if (p && p.net) out.push([carId, p.net.p, p.net.j]);
  });
  return out;
}

function timing(room) {
  const S = room.session;
  return {
    o: S.order,
    r: S.cars.map(function (c) {
      return [c.id, c.lapsDone, c.lastLap === null ? -1 : r3(c.lastLap), c.bestLap === null ? -1 : r3(c.bestLap), r3(c.gap),
        c.lapStart === null ? -1 : r3(c.lapStart), (c.finished ? 1 : 0) | (c.out && !c.parked ? 2 : 0) | (c.qualiDone ? 4 : 0), Math.round(c.raceDist), c.penalty];
    }),
    f: S.fastest ? [S.fastest.id, r3(S.fastest.time)] : null,
    tl: isFinite(S.timeLimit) ? Math.max(0, Math.round(S.timeLimit - S.time)) : -1,
    st: S.startTime,
    np: netInfo(room)
  };
}

function scheduleNext(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(function () {
    room.timer = null;
    if (rooms.get(room.code) === room && room.state === 'stageResults' && room.players.size && !room.hostAway && room.stages) {
      room.stageIdx++;
      startSession(room, room.stages[room.stageIdx]);
    }
  }, NEXT_IN * 1000);
}

function onSessionEnd(room) {
  const S = room.session;
  if (!S) return;
  const results = S.results || S.buildResults();
  io.to(room.code).emit('timing', timing(room));
  room.session = null;
  room.carOf = new Map();
  room.awayCar = null;
  room.resumeAt = 0;
  if (S.type === 'quali') room.qualiOrder = results.map(function (r) { return r.driverId; });
  const stages = room.stages || [S.type];
  const next = room.stageIdx + 1 < stages.length ? stages[room.stageIdx + 1] : null;
  const round = room.season ? room.season.rounds.length + 1 : 0;
  if (next) {
    // practice or qualifying done: show the results, then the next session starts by itself
    room.state = 'stageResults';
    room.lastResults = { type: S.type, stage: room.stage, track: S.track.id, results: results, next: next, nextIn: NEXT_IN, round: round };
    io.to(room.code).emit('sessionEnd', room.lastResults);
    if (!room.hostAway) scheduleNext(room);
  } else if (room.season) {
    // a race of the season: points into the championship, then the host starts the next round
    recordRound(room, S.track.id, results);
    room.state = 'seasonBreak';
    room.lastResults = { type: 'race', stage: 'race', track: S.track.id, results: results, stats: S.stats || null, round: round, season: true };
    io.to(room.code).emit('sessionEnd', room.lastResults);
    broadcastSeason(room);
  } else {
    room.state = 'results';
    room.lastResults = { type: 'race', stage: 'race', track: S.track.id, results: results, stats: S.stats || null };
    io.to(room.code).emit('sessionEnd', room.lastResults);
  }
  broadcastRoom(room);
}

function tickRoom(room) {
  const S = room.session;
  if (!S || S.phase === 'done') return;
  if (room.hostAway) return;                           // a season waits for its host
  if (room.resumeAt) {
    if (Date.now() < room.resumeAt) return;            // 3-2-1 after the host came back
    room.resumeAt = 0;
  }
  const inputs = {};
  room.inputQ.forEach(function (q, carId) {
    let inp = room.lastIn.get(carId) || F1.NEUTRAL;
    if (q.length > 0) {
      if (q.length > 6) {
        const dropped = q.splice(0, q.length - 3);
        room.ack.set(carId, dropped[dropped.length - 1].seq);
      }
      inp = q.shift();
      room.ack.set(carId, inp.seq);
      room.lastIn.set(carId, { throttle: inp.throttle, brake: inp.brake, steer: inp.steer, drs: inp.drs, reset: false });
    }
    inputs[carId] = inp;
  });
  S.step(inputs);
  const evs = S.drainEvents().filter(function (e) { return e.k !== 'end'; });
  if (evs.length) io.to(room.code).emit('ev', evs);
  if (S.tick % 3 === 0) io.to(room.code).emit('snap', snapshot(room));
  if (S.tick % 15 === 0) io.to(room.code).emit('timing', timing(room));
  if (S.phase === 'done') onSessionEnd(room);
}

function joinRoom(socket, room, name, token, asHost) {
  leaveRoom(socket);
  socket.join(room.code);
  socket.data.room = room.code;
  const p = { id: socket.id, name: cleanName(name), driverId: null, token: cleanToken(token), eid: null };
  room.players.set(socket.id, p);
  if (asHost) room.hostId = socket.id;
  if (room.season) seatPlayer(room, p);
  const wasAway = asHost && room.hostAway;
  if (wasAway) hostBack(room, p);
  broadcastRoom(room);
  broadcastSeason(room);
  if (room.session) {
    // where everyone is right now (the session may be paused: no snapshots until it carries on)
    socket.emit('session', sessionInfo(room));
    socket.emit('timing', timing(room));
    socket.emit('snap', snapshot(room, true));
  } else if (room.lastResults && !wasAway && (room.state === 'results' || room.state === 'stageResults' || room.state === 'seasonBreak')) {
    socket.emit('sessionEnd', room.lastResults);
  }
}

function leaveRoom(socket) {
  const code = socket.data.room;
  if (!code) return;
  socket.leave(code);
  socket.data.room = null;
  const room = rooms.get(code);
  if (!room) return;
  const p = room.players.get(socket.id);
  room.players.delete(socket.id);
  const carId = room.carOf.get(socket.id);
  if (room.season && !room.season.done && room.hostId === socket.id && !room.hostAway) {
    // the host left the season: everything pauses until they come back (their car waits where it is)
    room.hostAway = true;
    room.awayName = p ? p.name : 'The host';
    if (carId !== undefined) {
      room.carOf.delete(socket.id); room.ownerOf.delete(carId);
      room.awayCar = carId;
      room.inputQ.set(carId, []); room.lastIn.set(carId, F1.NEUTRAL);
    }
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }
    room.resumeAt = 0;
    if (room.session) io.to(room.code).emit('snap', snapshot(room));
  } else if (carId !== undefined && room.session) {
    room.session.retire(carId, 'left');
    room.carOf.delete(socket.id);
    room.inputQ.delete(carId);
    room.ownerOf.delete(carId);
  }
  if (room.players.size === 0) {
    if (room.timer) clearTimeout(room.timer);
    rooms.delete(code);
    return;
  }
  if (!room.hostAway && room.hostId === socket.id) room.hostId = room.players.keys().next().value;
  if (room.session && room.carOf.size === 0 && room.awayCar === null) {
    room.session.finish();
    onSessionEnd(room);
  }
  broadcastRoom(room);
  broadcastSeason(room);
}

function roomOfHost(socket) {
  const room = rooms.get(socket.data.room);
  return room && room.hostId === socket.id ? room : null;
}

io.on('connection', function (socket) {
  socket.data.room = null;
  socket.data.inputCount = 0;
  socket.data.inputWindow = Date.now();

  socket.on('createRoom', function (msg, ack) {
    if (typeof ack !== 'function') return;
    if (rooms.size >= MAX_ROOMS) return ack({ ok: false, error: 'Server is full, try again later' });
    const room = newRoom(newCode(), socket.id);
    joinRoom(socket, room, msg && msg.name, msg && msg.token);
    ack({ ok: true, code: room.code });
  });

  socket.on('joinRoom', function (msg, ack) {
    if (typeof ack !== 'function') return;
    const code = String((msg && msg.code) || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return ack({ ok: false, error: 'No room with code ' + (code || '?') + (msg && msg.key ? '' : ' — if it was a championship, the host can open it again') });
    if (room.players.size >= MAX_HUMANS && !room.players.has(socket.id)) return ack({ ok: false, error: 'Room is full (8 players max)' });
    // the season's host coming back through the invite link
    const asHost = !!(room.season && msg && msg.key && room.season.key === String(msg.key) && room.hostAway);
    joinRoom(socket, room, msg && msg.name, msg && msg.token, asHost);
    ack({ ok: true, code: room.code });
  });

  /* The host comes back to their season: the room if it is still open (everyone was waiting), or opened
     again from the copy kept in their browser (the server restarted, or everyone had left). */
  socket.on('rejoinSeason', function (msg, ack) {
    if (typeof ack !== 'function' || !msg || typeof msg !== 'object') return;
    const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    const key = String(msg.key || '').slice(0, 64);
    let room = rooms.get(code);
    if (room && room.season && room.season.key === key) {
      if (!room.hostAway && !room.players.has(socket.id)) return ack({ ok: false, error: 'This season is already open in another tab or window' });
      if (room.players.size >= MAX_HUMANS && !room.players.has(socket.id)) return ack({ ok: false, error: 'Room is full (8 players max)' });
      joinRoom(socket, room, msg.name, msg.token, true);
      return ack({ ok: true, code: room.code });
    }
    if (rooms.size >= MAX_ROOMS) return ack({ ok: false, error: 'Server is full, try again later' });
    const se = cleanSeason(msg.season, key);
    if (!se) return ack({ ok: false, error: 'The saved season could not be loaded' });
    room = newRoom(code.length === 4 && !rooms.has(code) ? code : newCode(), socket.id);
    room.season = se;
    Object.assign(room.settings, { mode: 'champ', calendar: se.calendar.slice(), p1: se.opts.p1, p2: se.opts.p2, p3: se.opts.p3,
      qualiLaps: se.opts.qualiLaps, raceLaps: se.opts.raceLaps, aiLevel: se.opts.aiLevel, aiCount: se.opts.aiCount });
    room.state = 'seasonBreak';
    joinRoom(socket, room, msg.name, msg.token, true);
    ack({ ok: true, code: room.code, moved: room.code !== code });
  });

  // the host ends the season for everyone (from the room, or from the home screen while away)
  socket.on('endSeason', function (msg, ack) {
    const code = String((msg && msg.code) || socket.data.room || '').toUpperCase().slice(0, 4);
    const room = rooms.get(code);
    const isHost = room && room.season && ((msg && room.season.key === String(msg.key || '')) || room.hostId === socket.id);
    if (isHost) endSeason(room);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('nextRound', function () {
    const room = roomOfHost(socket);
    if (!room || !room.season || room.season.done || room.state !== 'seasonBreak' || room.hostAway) return;
    startRound(room);
  });

  socket.on('leaveRoom', function () { leaveRoom(socket); });

  socket.on('pickDriver', function (driverId) {
    const room = rooms.get(socket.data.room);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || !F1.driver(driverId)) return;
    if (room.season) {
      // joined during the season and not raced yet: you can still change your car (to a free one)
      const se = room.season, e = p.eid ? se.entrants.find(function (x) { return x.eid === p.eid; }) : null;
      if (!e || room.carOf.has(socket.id) || driverTaken(se, driverId)) return;
      if (se.rounds.some(function (rd) { return rd.res.some(function (x) { return x.eid === e.eid; }); })) return;
      e.driverId = driverId; p.driverId = driverId;
      broadcastRoom(room); broadcastSeason(room);
      return;
    }
    if (room.state !== 'lobby' && room.state !== 'results') return;
    for (const other of room.players.values()) if (other.id !== p.id && other.driverId === driverId) return;
    p.driverId = driverId;
    broadcastRoom(room);
  });

  socket.on('settings', function (s) {
    const room = roomOfHost(socket);
    if (!room || !s || room.season || (room.state !== 'lobby' && room.state !== 'results')) return;
    const st = room.settings;
    if (s.mode === 'single' || s.mode === 'champ') st.mode = s.mode;
    if (Array.isArray(s.calendar)) {
      const cal = [];
      s.calendar.forEach(function (id) { if (F1.TRACK_DEFS[id] && cal.indexOf(id) < 0 && cal.length < MAX_ROUNDS) cal.push(id); });
      st.calendar = cal;
    }
    if (s.track && F1.TRACK_DEFS[s.track]) st.track = s.track;
    ['p1', 'p2', 'p3'].forEach(function (k) { if (s[k] !== undefined) st[k] = intIn(s[k], 0, 3, st[k]); });
    if (s.qualiLaps !== undefined) st.qualiLaps = intIn(s.qualiLaps, 0, 5, st.qualiLaps);
    if (s.raceLaps !== undefined) st.raceLaps = intIn(s.raceLaps, 1, 7, st.raceLaps);
    if (s.aiCount !== undefined) st.aiCount = intIn(s.aiCount, 0, GRID_SIZE - 1, st.aiCount);
    if (s.aiLevel && F1.AI_LEVELS[s.aiLevel]) st.aiLevel = s.aiLevel;
    broadcastRoom(room);
  });

  socket.on('start', function () {
    const room = roomOfHost(socket);
    if (!room || room.season || (room.state !== 'lobby' && room.state !== 'results')) return;
    room.qualiOrder = null;
    room.weekendAI = null;
    room.lastResults = null;
    if (room.settings.mode === 'champ') {
      if (!room.settings.calendar || room.settings.calendar.length < 2) return;
      startSeason(room);
      return;
    }
    // the weekend: practice sessions the host picked, qualifying (if any), then the race
    const st = room.settings;
    room.stages = ['p1', 'p2', 'p3'].filter(function (k) { return st[k] > 0; });
    if (st.qualiLaps > 0) room.stages.push('quali');
    room.stages.push('race');
    room.stageIdx = 0;
    startSession(room, room.stages[0]);
  });

  // the host ends practice or qualifying early for everyone
  socket.on('endSession', function () {
    const room = roomOfHost(socket);
    if (!room || !room.session) return;
    const S = room.session;
    if ((S.type === 'practice' || S.type === 'quali') && S.phase !== 'done') {
      S.finish();
      S.drainEvents();
      onSessionEnd(room);
    }
  });

  socket.on('backToLobby', function () {
    const room = roomOfHost(socket);
    if (!room || room.session) return;
    if (room.season) {
      if (!room.season.done) return;
      endSeason(room);                // the season is over: back to the lobby for the next one
      return;
    }
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }
    room.state = 'lobby';
    room.lastResults = null;
    broadcastRoom(room);
  });

  // driving input: [seq, throttle, brake, steer * 1000, flags (1 = DRS, 2 = reset)]
  socket.on('i', function (a) {
    const room = rooms.get(socket.data.room);
    if (!room || !room.session || !Array.isArray(a)) return;
    const carId = room.carOf.get(socket.id);
    if (carId === undefined) return;
    const now = Date.now();
    if (now - socket.data.inputWindow > 1000) { socket.data.inputWindow = now; socket.data.inputCount = 0; }
    if (++socket.data.inputCount > 150) return;
    const seq = Number(a[0]) | 0;
    if (seq <= (room.lastSeq.get(carId) || 0)) return;
    room.lastSeq.set(carId, seq);
    const q = room.inputQ.get(carId);
    if (!q) return;
    q.push({
      seq: seq,
      throttle: F1.clamp(Number(a[1]) || 0, 0, 1),
      brake: F1.clamp(Number(a[2]) || 0, 0, 1),
      steer: F1.clamp((Number(a[3]) || 0) / 1000, -1.8, 1.8),
      drs: !!((a[4] | 0) & 1),
      reset: !!((a[4] | 0) & 2)
    });
    if (q.length > 30) q.splice(0, q.length - 30);
  });

  // ping check; the game also reports its own ping and its worst delay spike, shown to the others in the room
  socket.on('lat', function (a, b) {
    const cb = typeof a === 'function' ? a : b;
    if (a && typeof a === 'object') {
      const room = rooms.get(socket.data.room), p = room && room.players.get(socket.id);
      if (p) p.net = { p: intIn(a.p, 0, 9999, 0), j: intIn(a.j, 0, 9999, 0) };
    }
    if (typeof cb === 'function') cb(Date.now());
  });

  socket.on('disconnect', function () { leaveRoom(socket); });
});

// Fixed-rate simulation loop (60 Hz) for every active room.
const TICK_MS = 1000 / 60;
let lastTime = performance.now();
let acc = 0;
setInterval(function () {
  const now = performance.now();
  acc += now - lastTime;
  lastTime = now;
  if (acc > 200) acc = 200;
  while (acc >= TICK_MS) {
    acc -= TICK_MS;
    rooms.forEach(function (room) {
      try { tickRoom(room); } catch (err) { console.error('Room ' + room.code + ' error:', err); }
    });
  }
}, 4);

server.listen(PORT, function () {
  console.log('Top-Down GP (version ' + F1.VERSION + ') running on port ' + PORT);
  console.log('Open http://localhost:' + PORT + ' in your browser');
});
