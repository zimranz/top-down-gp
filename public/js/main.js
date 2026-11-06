/* Menus, lobby, results, pause/settings and the main loop. */
(function () {
  'use strict';
  const F1 = window.F1, Settings = window.Settings, Input = window.Input, Renderer = window.Renderer;
  const $ = function (id) { return document.getElementById(id); };

  Settings.load();
  Input.init();
  const R = new Renderer($('game'));

  let game = null;
  let mode = 'menu';          // 'menu' | 'practice' | 'online'
  let net = null;
  let room = null;
  let resultsTimer = null;
  let lastResults = null;
  const practiceOpts = Object.assign({ track: 'monza', driverId: 'NOR', aiCount: 10, aiLevel: 'medium', collisions: true }, Settings.data.practice || {});

  // ------------------------------------------------------------- helpers
  function show(id) {
    document.querySelectorAll('.screen').forEach(function (s) { s.classList.toggle('active', s.id === id); });
    $('overlay').classList.toggle('hidden', !id);
    Input.active = !id && $('pause').classList.contains('hidden');
  }
  let toastT = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function teamColor(t) { return F1.teamUiColor(t); }

  function startAttract() {
    game = new window.LocalGame({ attract: true, track: Math.random() < 0.5 ? 'monza' : 'silverstone', aiCount: 12, aiLevel: 'hard', collisions: true });
    R.resetEffects();
  }
  function goHome() {
    mode = 'menu';
    clearInterval(resultsTimer);
    $('pause').classList.add('hidden');
    $('settings').classList.add('hidden');
    startAttract();
    show('home');
  }

  // ------------------------------------------------------------- shared widgets
  function buildTrackCards(container, selected, onPick, disabled) {
    container.innerHTML = '';
    Object.keys(F1.TRACK_DEFS).forEach(function (id) {
      const T = F1.getTrack(id);
      const b = el('button', 'track-card' + (id === selected ? ' on' : ''));
      const cv = el('canvas');
      b.append(cv, el('div', 'tname', T.name), el('div', 'tlen', (T.length / 1000).toFixed(3) + ' km · ' + T.country));
      b.dataset.id = id;
      b.disabled = !!disabled;
      b.addEventListener('click', function () {
        container.querySelectorAll('.track-card').forEach(function (c) { c.classList.toggle('on', c.dataset.id === id); });
        onPick(id);
      });
      container.appendChild(b);
      requestAnimationFrame(function () { Renderer.trackPreview(cv, T); });
    });
  }

  function buildDrivers(container, opts) {
    container.innerHTML = '';
    F1.TEAMS.forEach(function (team) {
      const card = el('div', 'team-card');
      card.style.setProperty('--team', teamColor(team));
      const top = el('div', 'team-top');
      const cv = el('canvas');
      top.append(el('div', 'team-name', team.name), cv);
      card.appendChild(top);
      F1.DRIVERS.filter(function (d) { return d.team === team.id; }).forEach(function (d) {
        const b = el('button', 'driver-btn' + (d.id === opts.selected ? ' on' : ''));
        b.dataset.id = d.id;
        b.append(el('span', 'num', '#' + d.number), el('span', 'dname', d.name));
        const taker = opts.takenBy && opts.takenBy[d.id];
        if (taker) { b.appendChild(el('span', 'taken', taker)); b.disabled = true; }
        b.addEventListener('click', function () {
          container.querySelectorAll('.driver-btn').forEach(function (x) { x.classList.toggle('on', x.dataset.id === d.id); });
          opts.onPick(d.id);
        });
        card.appendChild(b);
      });
      container.appendChild(card);
      requestAnimationFrame(function () { Renderer.carPreview(cv, team); });
    });
  }

  function segInit(container, value, onPick) {
    container.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.v === value);
      b.onclick = function () {
        container.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
        onPick(b.dataset.v);
      };
    });
  }

  // ------------------------------------------------------------- practice
  function openPractice() {
    buildTrackCards($('practice-tracks'), practiceOpts.track, function (id) { practiceOpts.track = id; });
    buildDrivers($('practice-drivers'), { selected: practiceOpts.driverId, onPick: function (id) { practiceOpts.driverId = id; } });
    $('practice-ai').value = practiceOpts.aiCount;
    $('practice-ai-val').textContent = practiceOpts.aiCount;
    $('practice-ai').oninput = function () { practiceOpts.aiCount = Number(this.value); $('practice-ai-val').textContent = this.value; };
    segInit($('practice-level'), practiceOpts.aiLevel, function (v) { practiceOpts.aiLevel = v; });
    $('practice-coll').checked = practiceOpts.collisions;
    $('practice-coll').onchange = function () { practiceOpts.collisions = this.checked; };
    show('practice');
  }
  function startPractice() {
    Settings.data.practice = Object.assign({}, practiceOpts);
    Settings.save();
    mode = 'practice';
    game = new window.LocalGame(practiceOpts);
    R.resetEffects();
    show(null);
  }
  $('practice-start').addEventListener('click', startPractice);

  // ------------------------------------------------------------- navigation
  document.querySelectorAll('[data-go]').forEach(function (b) {
    b.addEventListener('click', function () {
      const go = b.dataset.go;
      if (go === 'practice') openPractice();
      else if (go === 'online') openOnline();
      else show(go);
    });
  });
  document.querySelectorAll('[data-act="settings"]').forEach(function (b) { b.addEventListener('click', openSettings); });

  // ------------------------------------------------------------- settings
  function openSettings() {
    const d = Settings.data;
    $('set-steer').value = d.steering;
    $('set-steer-val').textContent = d.steering;
    $('set-steer').oninput = function () { d.steering = Number(this.value); $('set-steer-val').textContent = this.value; Settings.save(); };
    segInit($('set-camera'), d.camera, function (v) { d.camera = v; Settings.save(); });
    $('set-labels').checked = !!d.labels;
    $('set-labels').onchange = function () { d.labels = this.checked; Settings.save(); };
    $('settings').classList.remove('hidden');
    Input.active = false;
  }
  $('settings-close').addEventListener('click', function () {
    $('settings').classList.add('hidden');
    Input.active = mode !== 'menu' && $('overlay').classList.contains('hidden') && $('pause').classList.contains('hidden');
  });

  // ------------------------------------------------------------- pause
  function pauseOpen() { return !$('pause').classList.contains('hidden'); }
  function openPause() {
    if (mode === 'menu' || !$('overlay').classList.contains('hidden')) return;
    $('pause').classList.remove('hidden');
    if (game && game.kind === 'practice') game.paused = true;
    $('pause-restart').style.display = mode === 'practice' ? '' : 'none';
    $('pause-note').textContent = mode === 'online' ? 'The session keeps running while this menu is open.' : '';
    $('pause-quit').textContent = mode === 'online' ? 'Leave the room' : 'Quit to menu';
    Input.active = false;
  }
  function resume() {
    $('pause').classList.add('hidden');
    $('settings').classList.add('hidden');
    if (game && game.kind === 'practice') game.paused = false;
    Input.active = mode !== 'menu' && $('overlay').classList.contains('hidden');
  }
  $('pause-resume').addEventListener('click', resume);
  $('pause-restart').addEventListener('click', function () { resume(); startPractice(); });
  $('pause-quit').addEventListener('click', function () {
    if (mode === 'online') leaveRoom(); else goHome();
  });
  window.addEventListener('keydown', function (e) {
    if (e.code !== 'Escape' && e.code !== 'KeyP') return;
    const tag = e.target && e.target.tagName;
    if (e.code === 'KeyP' && (tag === 'INPUT' || tag === 'SELECT')) return;
    if (!$('settings').classList.contains('hidden')) { $('settings-close').click(); return; }
    if (pauseOpen()) resume(); else openPause();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && mode === 'practice' && !pauseOpen()) openPause();
    if (document.hidden) {
      Input.keys = {};
      if (game && game.kind === 'online') game.sendNeutral();
    }
  });

  // ------------------------------------------------------------- online
  function ensureNet() {
    if (net) return net;
    const socket = window.io({ transports: ['websocket', 'polling'], tryAllTransports: true });
    net = { socket: socket, ping: null, id: function () { return socket.id; }, emit: function () { socket.emit.apply(socket, arguments); } };
    socket.on('room', onRoom);
    socket.on('session', onSession);
    socket.on('snap', function (m) { if (game && game.kind === 'online') game.onSnap(m); });
    socket.on('timing', function (m) { if (game && game.kind === 'online') game.onTiming(m); });
    socket.on('ev', function (m) { if (game && game.kind === 'online') game.onEvents(m); });
    socket.on('sessionEnd', onSessionEnd);
    socket.on('disconnect', function () {
      if (room) { room = null; goHome(); toast('Lost connection to the server'); }
    });
    socket.on('connect_error', function () { $('online-error').textContent = 'Cannot reach the game server.'; });
    setInterval(function () {
      if (!socket.connected) return;
      const t0 = performance.now();
      socket.emit('lat', function () { net.ping = Math.round(performance.now() - t0); });
    }, 2000);
    return net;
  }

  function openOnline(code) {
    $('online-name').value = Settings.data.name || '';
    if (code) $('online-code').value = code;
    $('online-error').textContent = '';
    show('online');
    setTimeout(function () { ($('online-name').value ? $('online-code') : $('online-name')).focus(); }, 50);
    ensureNet();
  }
  function playerName() {
    const n = $('online-name').value.trim() || 'Player';
    Settings.data.name = n;
    Settings.save();
    return n;
  }
  $('online-create').addEventListener('click', function () {
    const n = ensureNet();
    $('online-error').textContent = '';
    n.socket.emit('createRoom', { name: playerName() }, function (res) {
      if (!res || !res.ok) { $('online-error').textContent = (res && res.error) || 'Could not create a room'; return; }
      history.replaceState(null, '', '?room=' + res.code);
    });
  });
  function joinCode() {
    const n = ensureNet();
    const code = $('online-code').value.trim().toUpperCase();
    if (code.length !== 4) { $('online-error').textContent = 'Room codes have 4 characters'; return; }
    $('online-error').textContent = '';
    n.socket.emit('joinRoom', { code: code, name: playerName() }, function (res) {
      if (!res || !res.ok) { $('online-error').textContent = (res && res.error) || 'Could not join'; return; }
      history.replaceState(null, '', '?room=' + res.code);
    });
  }
  $('online-join').addEventListener('click', joinCode);
  $('online-code').addEventListener('keydown', function (e) { if (e.key === 'Enter') joinCode(); });

  function leaveRoom() {
    if (net) net.socket.emit('leaveRoom');
    room = null;
    history.replaceState(null, '', location.pathname);
    goHome();
  }
  $('lobby-leave').addEventListener('click', leaveRoom);
  $('lobby-copy').addEventListener('click', function () {
    if (!room) return;
    const link = location.origin + location.pathname + '?room=' + room.code;
    const done = function () { toast('Invite link copied — send it to your friends'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, function () { window.prompt('Copy this link:', link); });
    else window.prompt('Copy this link:', link);
  });
  $('lobby-start').addEventListener('click', function () { if (net) net.socket.emit('start'); });
  $('results-lobby').addEventListener('click', function () { if (net) net.socket.emit('backToLobby'); });

  function fillSelect(sel, options, value) {
    const key = JSON.stringify(options);
    if (sel.dataset.key !== key) {
      sel.innerHTML = '';
      options.forEach(function (o) { const op = el('option', null, o[1]); op.value = o[0]; sel.appendChild(op); });
      sel.dataset.key = key;
    }
    sel.value = String(value);
  }

  let lastDriverKey = '';
  function renderLobby(r) {
    const me = net.id();
    const isHost = r.hostId === me;
    $('lobby-code').textContent = r.code;
    $('lobby-count').textContent = '(' + r.players.length + '/' + r.maxHumans + ')';
    const list = $('lobby-players');
    list.innerHTML = '';
    r.players.forEach(function (p) {
      const li = el('li', p.id === me ? 'me' : '');
      const d = p.driverId ? F1.driver(p.driverId) : null;
      const t = d ? F1.team(d.team) : null;
      const dot = el('span', 'dot');
      if (t) dot.style.background = teamColor(t);
      li.append(dot, el('span', null, p.name + (p.id === me ? ' (you)' : '')));
      if (p.id === r.hostId) li.appendChild(el('span', 'host', 'HOST'));
      li.appendChild(el('span', 'pdrv', d ? '#' + d.number + ' ' + d.name : 'picking…'));
      list.appendChild(li);
    });
    const s = r.settings;
    fillSelect($('set-track'), Object.keys(F1.TRACK_DEFS).map(function (id) { return [id, F1.TRACK_DEFS[id].name]; }), s.track);
    fillSelect($('set-quali'), [[0, 'None (random grid)'], [1, '1 lap'], [2, '2 laps'], [3, '3 laps'], [4, '4 laps'], [5, '5 laps']], s.qualiLaps);
    const raceOpts = []; for (let i = 1; i <= 10; i++) raceOpts.push([i, i + (i === 1 ? ' lap' : ' laps')]);
    fillSelect($('set-race'), raceOpts, s.raceLaps);
    const aiMax = 22 - r.players.length, aiOpts = [];
    for (let i = 0; i <= 21; i++) aiOpts.push([i, i > aiMax ? i + ' (max ' + aiMax + ')' : (i === aiMax ? i + ' (full grid)' : String(i))]);
    fillSelect($('set-ai'), aiOpts, s.aiCount);
    $('set-level').value = s.aiLevel;
    ['set-track', 'set-quali', 'set-race', 'set-ai', 'set-level'].forEach(function (id) { $(id).disabled = !isHost; });
    $('lobby-hostnote').textContent = isHost ? '' : '(host decides)';
    $('lobby-start').style.display = isHost ? '' : 'none';
    $('lobby-start').textContent = s.qualiLaps > 0 ? 'Start qualifying' : 'Start race';
    $('lobby-waiting').style.display = isHost ? 'none' : '';
    const mine = r.players.find(function (p) { return p.id === me; });
    const takenBy = {};
    r.players.forEach(function (p) { if (p.driverId && p.id !== me) takenBy[p.driverId] = p.name; });
    const key = JSON.stringify([takenBy, mine && mine.driverId]);
    if (key !== lastDriverKey) {
      lastDriverKey = key;
      buildDrivers($('lobby-drivers'), {
        selected: mine && mine.driverId,
        takenBy: takenBy,
        onPick: function (id) { net.socket.emit('pickDriver', id); }
      });
    }
  }
  ['set-track', 'set-quali', 'set-race', 'set-ai', 'set-level'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      const map = { 'set-track': 'track', 'set-quali': 'qualiLaps', 'set-race': 'raceLaps', 'set-ai': 'aiCount', 'set-level': 'aiLevel' };
      const v = this.value, msg = {};
      msg[map[id]] = (id === 'set-track' || id === 'set-level') ? v : Number(v);
      if (net) net.socket.emit('settings', msg);
    });
  });

  function onRoom(r) {
    room = r;
    mode = 'online';
    const inSession = game && game.kind === 'online' && !game.ended;
    if (r.state === 'lobby' && !inSession) {
      if (!$('lobby').classList.contains('active')) {
        if (game && game.kind === 'online') startAttract();
        clearInterval(resultsTimer);
        lastResults = null;
        $('pause').classList.add('hidden');
        show('lobby');
      }
      renderLobby(r);
    } else if ($('lobby').classList.contains('active')) {
      renderLobby(r);
    }
    updateResultsButtons();
  }

  function onSession(info) {
    mode = 'online';
    clearInterval(resultsTimer);
    $('pause').classList.add('hidden');
    $('settings').classList.add('hidden');
    game = new window.OnlineGame(net, info);
    R.resetEffects();
    show(null);
  }

  function onSessionEnd(m) {
    if (game && game.kind === 'online') game.ended = true;
    lastResults = m;
    mode = 'online';
    const T = F1.getTrack(m.track);
    $('results-title').textContent = (m.type === 'quali' ? 'Qualifying' : 'Race') + ' results — ' + T.name;
    const body = $('results-body');
    body.innerHTML = '';
    const me = net && net.id();
    const myPlayer = room && room.players.find(function (p) { return p.id === me; });
    let fastest = null;
    m.results.forEach(function (r) { if (r.best !== null && (fastest === null || r.best < fastest)) fastest = r.best; });
    m.results.forEach(function (r) {
      const d = F1.driver(r.driverId), t = F1.team(d.team);
      const tr = el('tr', myPlayer && myPlayer.driverId === r.driverId ? 'me' : '');
      tr.appendChild(el('td', 'pos', String(r.pos)));
      const td = el('td', 'drv');
      const bar = el('span', 'bar'); bar.style.background = teamColor(t);
      td.append(bar, document.createTextNode(d.name + (r.isAI ? '' : '  (' + (r.name || 'Player') + ')')));
      tr.appendChild(td);
      tr.appendChild(el('td', null, t.name));
      tr.appendChild(el('td', 'r', r.gap));
      tr.appendChild(el('td', 'r' + (r.best !== null && r.best === fastest && m.type === 'race' ? ' purple' : ''), r.best !== null ? F1.fmtLap(r.best) : '—'));
      tr.appendChild(el('td', 'r', String(r.laps)));
      body.appendChild(tr);
    });
    clearInterval(resultsTimer);
    if (m.type === 'quali' && m.raceIn) {
      let left = m.raceIn;
      $('results-note').textContent = 'The race starts in ' + left + ' s — you start from your qualifying position';
      resultsTimer = setInterval(function () {
        left--;
        if (left <= 0) { clearInterval(resultsTimer); $('results-note').textContent = 'Starting…'; return; }
        $('results-note').textContent = 'The race starts in ' + left + ' s — you start from your qualifying position';
      }, 1000);
    } else {
      $('results-note').textContent = '';
    }
    $('pause').classList.add('hidden');
    show('results');
    updateResultsButtons();
  }
  function updateResultsButtons() {
    const isHost = room && net && room.hostId === net.id();
    const raceDone = lastResults && lastResults.type === 'race';
    $('results-lobby').style.display = isHost && raceDone ? '' : 'none';
    if (raceDone && !isHost) $('results-note').textContent = 'Waiting for the host to return to the lobby…';
  }

  // ------------------------------------------------------------- main loop
  goHome();
  const params = new URLSearchParams(location.search);
  if (params.get('room')) openOnline(params.get('room').toUpperCase().slice(0, 4));

  if (params.get('debug') === '1') window.__tdgp = { onSessionEnd: onSessionEnd, net: function () { return net; }, game: function () { return game; } };

  let last = performance.now(), acc = 0;
  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.25) dt = 0.25;
    acc += dt;
    let steps = 0;
    while (acc >= F1.DT && steps < 6) { game.step(); acc -= F1.DT; steps++; }
    if (steps >= 6) acc = 0;
    try { game.render(R, acc / F1.DT, dt); } catch (err) { console.error(err); }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
