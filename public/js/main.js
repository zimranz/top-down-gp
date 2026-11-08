/* Menus, lobby, results, pause/settings and the main loop. */
(function () {
  'use strict';
  const F1 = window.F1, Settings = window.Settings, Input = window.Input, Renderer = window.Renderer;
  const $ = function (id) { return document.getElementById(id); };

  Settings.load();
  Input.init();
  const GameAudio = window.GameAudio;
  GameAudio.load();
  // menu clicks: a rising sound for the big red buttons, a falling one for going back, a tap for the rest
  document.addEventListener('click', function (e) {
    const b = e.target.closest && e.target.closest('button, .track-card, .driver-btn');
    if (!b || b.id === 'set-engine-test') return;
    const kind = b.classList.contains('red') ? 'go' : (b.dataset.go === 'home' || /quit|menu|leave/.test(b.id)) ? 'back' : 'tap';
    GameAudio.click(kind);
  }, true);
  document.addEventListener('change', function (e) { if (e.target.matches && e.target.matches('select, input[type=checkbox]')) GameAudio.click('tap'); }, true);
  const R = new Renderer($('game'));

  let game = null;
  let mode = 'menu';          // 'menu' | 'practice' | 'gp' | 'online'
  let net = null;
  let room = null;
  let resultsTimer = null;
  let lastResults = null;
  const practiceOpts = Object.assign({ track: 'monza', driverId: 'NOR', aiCount: 10, aiLevel: 'medium', collisions: true }, Settings.data.practice || {});
  const gpOpts = Object.assign({ track: 'monza', driverId: 'NOR', aiCount: 15, aiLevel: 'medium', p1: 0, p2: 0, p3: 0, qualiLaps: 2, raceLaps: 5 }, Settings.data.gp || {});
  if (!F1.TRACK_DEFS[practiceOpts.track]) practiceOpts.track = 'monza';
  if (!F1.TRACK_DEFS[gpOpts.track]) gpOpts.track = 'monza';
  let gp = null;               // current Grand Prix weekend { opts, aiDrivers, grid, stages, idx }
  const STAGE_NAME = { p1: 'Practice 1', p2: 'Practice 2', p3: 'Practice 3', quali: 'Qualifying', race: 'Race' };
  let resultsCtx = 'online';   // which buttons the results screen shows

  // ------------------------------------------------------------- helpers
  function show(id) {
    document.querySelectorAll('.screen').forEach(function (s) { s.classList.toggle('active', s.id === id); });
    $('overlay').classList.toggle('hidden', !id);
    Input.active = !id && $('pause').classList.contains('hidden');
    if (!id && document.activeElement && document.activeElement.blur) document.activeElement.blur();
    updatePauseBtn();
  }
  function updatePauseBtn() {
    const inGame = mode !== 'menu' && $('overlay').classList.contains('hidden') && $('pause').classList.contains('hidden') && game && game.kind !== 'attract';
    $('pausebtn').classList.toggle('hidden', !inGame);
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
    const ids = Object.keys(F1.TRACK_DEFS);
    game = new window.LocalGame({ attract: true, type: 'practice', track: ids[Math.floor(Math.random() * ids.length)], aiCount: 12, aiLevel: 'hard', collisions: true });
    R.resetEffects();
  }
  function goHome() {
    mode = 'menu';
    gp = null;
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
      const pb = window.PB.get(id);
      b.append(cv, el('div', 'tname', T.name), el('div', 'tlen', (T.length / 1000).toFixed(3) + ' km · ' + T.country),
        el('div', 'tpb' + (pb ? '' : ' none'), pb ? 'PB ' + F1.fmtLap(pb.t) : 'No personal best yet'));
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
    game = new window.LocalGame(Object.assign({ type: 'practice' }, practiceOpts));
    R.resetEffects();
    GameAudio.newSession();
    show(null);
  }
  $('practice-start').addEventListener('click', startPractice);

  // ------------------------------------------------------------- grand prix
  function lapOptions(sel, min, max, value, noneLabel) {
    const opts = [];
    if (noneLabel) opts.push([0, noneLabel]);
    for (let i = min; i <= max; i++) opts.push([i, i + (i === 1 ? ' lap' : ' laps')]);
    fillSelect(sel, opts, value);
  }
  function openGp() {
    buildTrackCards($('gp-tracks'), gpOpts.track, function (id) { gpOpts.track = id; });
    buildDrivers($('gp-drivers'), { selected: gpOpts.driverId, onPick: function (id) { gpOpts.driverId = id; } });
    $('gp-ai').value = gpOpts.aiCount;
    $('gp-ai-val').textContent = gpOpts.aiCount;
    $('gp-ai').oninput = function () { gpOpts.aiCount = Number(this.value); $('gp-ai-val').textContent = this.value; };
    segInit($('gp-level'), gpOpts.aiLevel, function (v) { gpOpts.aiLevel = v; });
    ['p1', 'p2', 'p3'].forEach(function (k) {
      lapOptions($('gp-' + k), 1, 3, gpOpts[k], 'Skip');
      $('gp-' + k).onchange = function () { gpOpts[k] = Number(this.value); };
    });
    lapOptions($('gp-quali'), 1, 5, gpOpts.qualiLaps, 'None (random grid)');
    lapOptions($('gp-race'), 1, 7, gpOpts.raceLaps);
    $('gp-quali').onchange = function () { gpOpts.qualiLaps = Number(this.value); };
    $('gp-race').onchange = function () { gpOpts.raceLaps = Number(this.value); };
    show('gp');
  }
  function shuffled(a) {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  /* A weekend is a list of stages: optional P1-P3, optional qualifying, then the race. */
  function startGp() {
    Settings.data.gp = Object.assign({}, gpOpts);
    Settings.save();
    const pool = F1.DRIVERS.map(function (d) { return d.id; }).filter(function (id) { return id !== gpOpts.driverId; });
    gp = { opts: Object.assign({}, gpOpts), aiDrivers: shuffled(pool).slice(0, gpOpts.aiCount), grid: null, stages: [], idx: 0 };
    ['p1', 'p2', 'p3'].forEach(function (k) { if (gp.opts[k] > 0) gp.stages.push(k); });
    if (gp.opts.qualiLaps > 0) gp.stages.push('quali');
    gp.stages.push('race');
    startGpStage(0);
  }
  function startGpStage(i) {
    const o = gp.opts, stage = gp.stages[i];
    const type = stage === 'quali' ? 'quali' : stage === 'race' ? 'race' : 'practice';
    gp.idx = i;
    gp.stage = stage;
    if (type === 'race' && !gp.grid) gp.grid = shuffled([o.driverId].concat(gp.aiDrivers));   // no qualifying: random grid
    mode = 'gp';
    clearInterval(resultsTimer);
    game = new window.LocalGame({
      type: type, track: o.track, driverId: o.driverId, aiDrivers: gp.aiDrivers,
      grid: type === 'race' ? gp.grid : null, aiLevel: o.aiLevel, collisions: true,
      laps: type === 'race' ? o.raceLaps : type === 'quali' ? o.qualiLaps : o[stage],
      title: type === 'practice' ? STAGE_NAME[stage].toUpperCase() : null,
      onEnd: function (results) {
        if (mode !== 'gp' || game.S.results !== results) return;
        if (type === 'quali') gp.grid = results.map(function (r) { return r.driverId; });
        showResults({ type: type, stage: stage, track: o.track, results: results }, 'gp');
      }
    });
    R.resetEffects();
    GameAudio.newSession();
    show(null);
  }
  $('gp-start').addEventListener('click', startGp);
  $('results-next').addEventListener('click', function () { if (gp && gp.idx + 1 < gp.stages.length) startGpStage(gp.idx + 1); });
  $('results-again').addEventListener('click', function () { if (gp) startGpStage(gp.stages.length - 1); });   // same grid
  $('results-restart').addEventListener('click', function () {
    if (!gp) return;
    if (gp.opts.qualiLaps > 0) gp.grid = null;
    else gp.grid = shuffled(gp.grid);
    startGpStage(0);
  });
  $('results-menu').addEventListener('click', function () { goHome(); });

  // ------------------------------------------------------------- navigation
  document.querySelectorAll('[data-go]').forEach(function (b) {
    b.addEventListener('click', function () {
      const go = b.dataset.go;
      if (go === 'practice') openPractice();
      else if (go === 'gp') openGp();
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
    ['master', 'engine', 'effects'].forEach(function (k) {
      const inp = $('set-vol-' + k), out = $('set-vol-' + k + '-val');
      inp.value = Math.round(GameAudio.vol[k] * 100); out.textContent = inp.value;
      inp.oninput = function () { out.textContent = this.value; GameAudio.setVolume(k, Number(this.value) / 100); };
    });
    $('set-mute').checked = !!GameAudio.vol.muted;
    $('set-mute').onchange = function () { if (!!GameAudio.vol.muted !== this.checked) GameAudio.toggleMute(); };
    $('set-engine').value = GameAudio.vol.style;
    $('set-engine').onchange = function () { GameAudio.setStyle(this.value); };
    $('set-engine-test').onclick = function () { GameAudio.demo(); setTimeout(engineNote, 300); };
    function engineNote() {
      $('set-engine-note').textContent = GameAudio.ready && !GameAudio.onboardAvailable() && window.isSecureContext === false
        ? 'Onboard sound needs a secure page (https or localhost), so the TV camera sound is used here.' : '';
    }
    engineNote();
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
    if (game && game.kind === 'local') game.paused = true;
    $('pause-restart').style.display = mode === 'practice' || mode === 'gp' ? '' : 'none';
    $('pause-restart').textContent = mode === 'gp' ? 'Restart this session' : 'Restart practice';
    $('pause-end').style.display = mode === 'gp' && gp && game && game.type === 'practice' ? '' : 'none';
    updatePauseBtn();
    $('pause-note').textContent = mode === 'online' ? 'The session keeps running while this menu is open.' : '';
    $('pause-quit').textContent = mode === 'online' ? 'Leave the room' : 'Quit to menu';
    Input.active = false;
  }
  function resume() {
    $('pause').classList.add('hidden');
    $('settings').classList.add('hidden');
    if (game && game.kind === 'local') game.paused = false;
    Input.active = mode !== 'menu' && $('overlay').classList.contains('hidden');
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    updatePauseBtn();
  }
  $('pausebtn').querySelector('button').addEventListener('click', function (e) { e.currentTarget.blur(); openPause(); });
  $('pause-resume').addEventListener('click', resume);
  $('pause-restart').addEventListener('click', function () {
    resume();
    if (mode === 'gp' && gp) startGpStage(gp.idx); else startPractice();
  });
  $('pause-end').addEventListener('click', function () {
    resume();
    if (mode === 'gp' && game && game.kind === 'local' && game.S.phase !== 'done') game.S.finish();
  });
  $('pause-quit').addEventListener('click', function () {
    if (mode === 'online') leaveRoom(); else goHome();
  });
  window.addEventListener('keydown', function (e) {
    const tg = e.target && e.target.tagName;
    if (e.code === 'KeyM' && !e.repeat && tg !== 'INPUT' && tg !== 'SELECT') {
      const muted = GameAudio.toggleMute();
      toast(muted ? 'Sound off (M to turn it back on)' : 'Sound on');
      if ($('set-mute')) $('set-mute').checked = muted;
      return;
    }
    if (e.code !== 'Escape' && e.code !== 'KeyP') return;
    const tag = e.target && e.target.tagName;
    if (e.code === 'KeyP' && (tag === 'INPUT' || tag === 'SELECT')) return;
    if (!$('settings').classList.contains('hidden')) { $('settings-close').click(); return; }
    if (pauseOpen()) resume(); else openPause();
  });
  document.addEventListener('visibilitychange', function () {
    GameAudio.suspend(document.hidden);
    if (document.hidden && (mode === 'practice' || mode === 'gp') && !pauseOpen()) openPause();
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
    const raceOpts = []; for (let i = 1; i <= 7; i++) raceOpts.push([i, i + (i === 1 ? ' lap' : ' laps')]);
    fillSelect($('set-race'), raceOpts, Math.min(7, s.raceLaps));
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
    GameAudio.newSession();
    show(null);
  }

  function onSessionEnd(m) {
    if (game && game.kind === 'online') game.ended = true;
    mode = 'online';
    showResults(m, 'online');
  }
  function showResults(m, ctx) {
    lastResults = m;
    resultsCtx = ctx;
    const T = F1.getTrack(m.track);
    $('results-title').textContent = (m.stage ? STAGE_NAME[m.stage] : m.type === 'quali' ? 'Qualifying' : 'Race') + ' results — ' + T.name;
    const body = $('results-body');
    body.innerHTML = '';
    $('results-table').classList.toggle('no-pts', m.type !== 'race');
    const me = net && net.id();
    const myPlayer = ctx === 'gp' ? { driverId: gp && gp.opts.driverId } : room && room.players.find(function (p) { return p.id === me; });
    let fastest = null;
    m.results.forEach(function (r) { if (r.best !== null && (fastest === null || r.best < fastest)) fastest = r.best; });
    m.results.forEach(function (r) {
      const d = F1.driver(r.driverId), t = F1.team(d.team);
      const tr = el('tr', myPlayer && myPlayer.driverId === r.driverId ? 'me' : '');
      tr.appendChild(el('td', 'pos', String(r.pos)));
      const td = el('td', 'drv');
      const bar = el('span', 'bar'); bar.style.background = teamColor(t);
      td.append(bar, document.createTextNode(d.name + (r.isAI ? '' : '  (' + (ctx === 'gp' ? 'You' : r.name || 'Player') + ')')));
      tr.appendChild(td);
      tr.appendChild(el('td', null, t.name));
      tr.appendChild(el('td', 'r', r.gap));
      tr.appendChild(el('td', 'r' + (r.best !== null && r.best === fastest && m.type === 'race' ? ' purple' : ''), r.best !== null ? F1.fmtLap(r.best) : '—'));
      tr.appendChild(el('td', 'r', String(r.laps)));
      tr.appendChild(el('td', 'r pts-col' + (r.pts ? ' pts' : ''), r.pts ? String(r.pts) : ''));
      body.appendChild(tr);
    });
    clearInterval(resultsTimer);
    if (ctx === 'gp') {
      const mine = m.results.find(function (r) { return !r.isAI; });
      if (m.type === 'practice') $('results-note').textContent = mine && mine.best !== null ? 'Your best lap ' + F1.fmtLap(mine.best) + ' — P' + mine.pos : 'No lap time set';
      else if (m.type === 'quali') $('results-note').textContent = mine ? 'You start the race from P' + mine.pos : '';
      else $('results-note').textContent = mine ? 'You finished P' + mine.pos + (mine.pts ? ' — ' + mine.pts + (mine.pts === 1 ? ' point' : ' points') : '') : '';
    } else if (m.type === 'quali' && m.raceIn) {
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
    const isGp = resultsCtx === 'gp';
    const isHost = !isGp && room && net && room.hostId === net.id();
    const raceDone = lastResults && lastResults.type === 'race';
    $('results-lobby').style.display = !isGp && isHost && raceDone ? '' : 'none';
    const next = isGp && gp && !raceDone ? gp.stages[gp.idx + 1] : null;
    $('results-next').style.display = next ? '' : 'none';
    if (next) $('results-next').textContent = next === 'race' ? 'Start the race' : 'Start ' + STAGE_NAME[next];
    $('results-again').style.display = isGp && raceDone ? '' : 'none';
    $('results-restart').style.display = isGp && raceDone && gp && gp.stages.length > 1 ? '' : 'none';
    $('results-menu').style.display = isGp ? '' : 'none';
    if (!isGp && raceDone && !isHost) $('results-note').textContent = 'Waiting for the host to return to the lobby…';
  }

  // ------------------------------------------------------------- main loop
  goHome();
  const params = new URLSearchParams(location.search);
  if (params.get('room')) openOnline(params.get('room').toUpperCase().slice(0, 4));

  if (params.get('debug') === '1') window.__tdgp = { onSessionEnd: onSessionEnd, net: function () { return net; }, game: function () { return game; }, R: R };

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
    // sound: only while a session is on screen (not in menus, pause or results)
    const audioOn = mode !== 'menu' && game.kind !== 'attract' && $('overlay').classList.contains('hidden') && $('pause').classList.contains('hidden');
    GameAudio.setActive(audioOn);
    if (audioOn && game.audioState) { try { const st = game.audioState(); if (st) GameAudio.update(st, dt); } catch (err) { console.error(err); } }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
