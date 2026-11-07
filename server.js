'use strict';
/* Top-Down GP — game server.
   Serves the game files and runs online sessions: rooms with codes, lobby, qualifying -> race.
   The server simulates every car 60 times a second (authoritative), sends snapshots 20x/s. */
const path = require('path');
const http = require('http');
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

function cleanName(n) {
  const s = String(n || '').replace(/[<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s || 'Player';
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

function roomPayload(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    settings: room.settings,
    maxHumans: MAX_HUMANS,
    players: Array.from(room.players.values()).map(function (p) {
      return { id: p.id, name: p.name, driverId: p.driverId, inSession: room.carOf.has(p.id) };
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
    track: S.track.id,
    laps: S.laps,
    aiLevel: S.aiLevel,
    entries: S.cars.map(function (c) {
      return { id: c.id, driverId: c.driverId, isAI: c.isAI, name: c.name, owner: room.ownerOf.get(c.id) || null };
    })
  };
}

function startSession(room, type) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  const T = F1.getTrack(room.settings.track);
  const humans = Array.from(room.players.values());
  if (!humans.length) return;
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
  let aiDrivers;
  if (type === 'race' && room.qualiOrder && room.qualiAI) {
    // race after qualifying: keep the same AI drivers that qualified
    aiDrivers = room.qualiAI.filter(function (id) { return !taken.has(id); }).map(function (id) { return F1.driver(id); });
    const extra = shuffle(F1.DRIVERS.filter(function (d) { return !taken.has(d.id) && aiDrivers.indexOf(d) < 0; }));
    while (aiDrivers.length < aiCount && extra.length) aiDrivers.push(extra.pop());
    aiDrivers = aiDrivers.slice(0, aiCount);
  } else {
    aiDrivers = shuffle(F1.DRIVERS.filter(function (d) { return !taken.has(d.id); })).slice(0, aiCount);
  }
  room.qualiAI = type === 'quali' ? aiDrivers.map(function (d) { return d.id; }) : room.qualiAI;
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
    laps: type === 'race' ? room.settings.raceLaps : room.settings.qualiLaps,
    aiLevel: room.settings.aiLevel,
    collisions: true,
    seed: Math.floor(Math.random() * 1e9)
  });
  room.session = S;
  room.state = type;
  room.carOf = new Map();
  room.ownerOf = new Map();
  room.inputQ = new Map();
  room.lastIn = new Map();
  room.ack = new Map();
  room.lastSeq = new Map();
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

function snapshot(room) {
  const S = room.session;
  const cars = [];
  for (let i = 0; i < S.cars.length; i++) {
    const c = S.cars[i];
    if (c.out) { cars.push([c.id, 0, 0, 0, 0, 0, 0, 0, 64, 0]); continue; }
    let flags = (c.drsOpen ? 1 : 0) | (c.locked ? 2 : 0) | (c.slide ? 4 : 0) | (c.finished ? 32 : 0);
    for (let z = 0; z < c.drsElig.length; z++) if (c.drsElig[z]) flags |= 8 << z;
    cars.push([c.id, r2(c.x), r2(c.y), r4(c.a), r2(c.vx), r2(c.vy), r3(c.w), r3(c.delta), flags, room.ack.get(c.id) || 0]);
  }
  return { t: S.tick, tm: r3(S.time), ph: PHASE_CODE[S.phase], l: S.lights, c: cars, fx: S.drainFx() };
}

function timing(room) {
  const S = room.session;
  return {
    o: S.order,
    r: S.cars.map(function (c) {
      return [c.id, c.lapsDone, c.lastLap === null ? -1 : r3(c.lastLap), c.bestLap === null ? -1 : r3(c.bestLap), r3(c.gap),
        c.lapStart === null ? -1 : r3(c.lapStart), (c.finished ? 1 : 0) | (c.out ? 2 : 0) | (c.qualiDone ? 4 : 0), Math.round(c.raceDist)];
    }),
    f: S.fastest ? [S.fastest.id, r3(S.fastest.time)] : null,
    tl: isFinite(S.timeLimit) ? Math.max(0, Math.round(S.timeLimit - S.time)) : -1,
    st: S.startTime
  };
}

function onSessionEnd(room) {
  const S = room.session;
  if (!S) return;
  const results = S.results || S.buildResults();
  io.to(room.code).emit('timing', timing(room));
  room.session = null;
  room.carOf = new Map();
  if (S.type === 'quali') {
    room.qualiOrder = results.map(function (r) { return r.driverId; });
    room.state = 'qualiResults';
    const raceIn = 12;
    io.to(room.code).emit('sessionEnd', { type: 'quali', track: S.track.id, results: results, raceIn: raceIn });
    room.timer = setTimeout(function () {
      room.timer = null;
      if (rooms.get(room.code) === room && room.state === 'qualiResults' && room.players.size) startSession(room, 'race');
    }, raceIn * 1000);
  } else {
    room.state = 'results';
    io.to(room.code).emit('sessionEnd', { type: 'race', track: S.track.id, results: results });
  }
  broadcastRoom(room);
}

function tickRoom(room) {
  const S = room.session;
  if (!S || S.phase === 'done') return;
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

function joinRoom(socket, room, name) {
  leaveRoom(socket);
  socket.join(room.code);
  socket.data.room = room.code;
  room.players.set(socket.id, { id: socket.id, name: cleanName(name), driverId: null });
  broadcastRoom(room);
  if (room.session) {
    socket.emit('session', sessionInfo(room));
    socket.emit('timing', timing(room));
  } else if (room.lastResults && (room.state === 'results' || room.state === 'qualiResults')) {
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
  room.players.delete(socket.id);
  const carId = room.carOf.get(socket.id);
  if (carId !== undefined && room.session) {
    room.session.retire(carId);
    room.carOf.delete(socket.id);
    room.inputQ.delete(carId);
    room.ownerOf.delete(carId);
  }
  if (room.players.size === 0) {
    if (room.timer) clearTimeout(room.timer);
    rooms.delete(code);
    return;
  }
  if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
  if (room.session && room.carOf.size === 0) {
    room.session.finish();
    onSessionEnd(room);
  }
  broadcastRoom(room);
}

io.on('connection', function (socket) {
  socket.data.room = null;
  socket.data.inputCount = 0;
  socket.data.inputWindow = Date.now();

  socket.on('createRoom', function (msg, ack) {
    if (typeof ack !== 'function') return;
    if (rooms.size >= MAX_ROOMS) return ack({ ok: false, error: 'Server is full, try again later' });
    const room = {
      code: newCode(),
      hostId: socket.id,
      players: new Map(),
      settings: { track: 'monza', qualiLaps: 2, raceLaps: 5, aiCount: 21, aiLevel: 'medium' },
      state: 'lobby',
      session: null,
      carOf: new Map(), ownerOf: new Map(), inputQ: new Map(), lastIn: new Map(), ack: new Map(), lastSeq: new Map(),
      qualiOrder: null, timer: null, lastResults: null
    };
    rooms.set(room.code, room);
    joinRoom(socket, room, msg && msg.name);
    ack({ ok: true, code: room.code });
  });

  socket.on('joinRoom', function (msg, ack) {
    if (typeof ack !== 'function') return;
    const code = String((msg && msg.code) || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return ack({ ok: false, error: 'No room with code ' + (code || '?') });
    if (room.players.size >= MAX_HUMANS && !room.players.has(socket.id)) return ack({ ok: false, error: 'Room is full (8 players max)' });
    joinRoom(socket, room, msg && msg.name);
    ack({ ok: true, code: room.code });
  });

  socket.on('leaveRoom', function () { leaveRoom(socket); });

  socket.on('pickDriver', function (driverId) {
    const room = rooms.get(socket.data.room);
    if (!room || room.state !== 'lobby' && room.state !== 'results') return;
    const p = room.players.get(socket.id);
    if (!p || !F1.driver(driverId)) return;
    for (const other of room.players.values()) if (other.id !== p.id && other.driverId === driverId) return;
    p.driverId = driverId;
    broadcastRoom(room);
  });

  socket.on('settings', function (s) {
    const room = rooms.get(socket.data.room);
    if (!room || room.hostId !== socket.id || !s || (room.state !== 'lobby' && room.state !== 'results')) return;
    const st = room.settings;
    if (s.track && F1.TRACK_DEFS[s.track]) st.track = s.track;
    if (s.qualiLaps !== undefined) st.qualiLaps = intIn(s.qualiLaps, 0, 5, st.qualiLaps);
    if (s.raceLaps !== undefined) st.raceLaps = intIn(s.raceLaps, 1, 7, st.raceLaps);
    if (s.aiCount !== undefined) st.aiCount = intIn(s.aiCount, 0, GRID_SIZE - 1, st.aiCount);
    if (s.aiLevel && F1.AI_LEVELS[s.aiLevel]) st.aiLevel = s.aiLevel;
    broadcastRoom(room);
  });

  socket.on('start', function () {
    const room = rooms.get(socket.data.room);
    if (!room || room.hostId !== socket.id || (room.state !== 'lobby' && room.state !== 'results')) return;
    room.qualiOrder = null;
    room.qualiAI = null;
    room.lastResults = null;
    startSession(room, room.settings.qualiLaps > 0 ? 'quali' : 'race');
  });

  socket.on('backToLobby', function () {
    const room = rooms.get(socket.data.room);
    if (!room || room.hostId !== socket.id || room.session) return;
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
      steer: F1.clamp((Number(a[3]) || 0) / 1000, -1.6, 1.6),
      drs: !!((a[4] | 0) & 1),
      reset: !!((a[4] | 0) & 2)
    });
    if (q.length > 30) q.splice(0, q.length - 30);
  });

  socket.on('lat', function (cb) { if (typeof cb === 'function') cb(Date.now()); });

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
  console.log('Top-Down GP running on port ' + PORT);
  console.log('Open http://localhost:' + PORT + ' in your browser');
});
