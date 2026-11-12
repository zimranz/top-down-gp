/* Menus, lobby, results, pause/settings and the main loop. */
(function () {
  'use strict';
  const F1 = window.F1, Settings = window.Settings, Input = window.Input, Renderer = window.Renderer;
  const $ = function (id) { return document.getElementById(id); };

  Settings.load();
  Input.init();
  const GameAudio = window.GameAudio;
  $('version').textContent = 'Version ' + F1.VERSION;
  document.querySelector('#home .tag').textContent = '2026 grid · 11 teams · 22 drivers · ' + Object.keys(F1.TRACK_DEFS).length + ' circuits';
  GameAudio.load();
  syncSoundUI();
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
  let mode = 'menu';          // 'menu' | 'practice' | 'tt' | 'gp' | 'online'
  let net = null;
  let room = null;
  let resultsTimer = null;
  let lastResults = null;
  const practiceOpts = Object.assign({ track: 'monza', driverId: 'NOR', aiCount: 10, aiLevel: 'medium', collisions: true }, Settings.data.practice || {});
  const gpOpts = Object.assign({ track: 'monza', driverId: 'NOR', aiCount: 15, aiLevel: 'medium', p1: 0, p2: 0, p3: 0, qualiLaps: 2, raceLaps: 5 }, Settings.data.gp || {});
  if (!F1.TRACK_DEFS[practiceOpts.track]) practiceOpts.track = 'monza';
  if (!F1.TRACK_DEFS[gpOpts.track]) gpOpts.track = 'monza';
  let gp = null;               // current Grand Prix weekend { opts, aiDrivers, grid, stages, idx, champ }
  const champOpts = Object.assign({ driverId: 'NOR', aiCount: 15, aiLevel: 'medium', p1: 0, p2: 0, p3: 0, qualiLaps: 2, raceLaps: 5,
    calendar: ['silverstone', 'spa', 'monza', 'interlagos', 'abudhabi'] }, Settings.data.champ || {});
  champOpts.calendar = (champOpts.calendar || []).filter(function (id) { return F1.TRACK_DEFS[id]; });
  const STAGE_NAME = { p1: 'Practice 1', p2: 'Practice 2', p3: 'Practice 3', quali: 'Qualifying', race: 'Race' };
  let resultsCtx = 'online';   // which buttons the results screen shows
  let standingsCtx = 'local';  // standings screen: 'local' (your championship) or 'online' (the room's season)
  let season = null;           // online championship of the room you are in (from the server)

  /* This browser's private id: an online season knows you by it when you come back. */
  function myToken() {
    let t = null;
    try { t = window.localStorage.getItem('topdowngp.pid'); } catch (e) { /* ignore */ }
    if (!t || t.length < 8) {
      t = '';
      const c = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      for (let i = 0; i < 20; i++) t += c[Math.floor(Math.random() * c.length)];
      try { window.localStorage.setItem('topdowngp.pid', t); } catch (e) { /* ignore */ }
    }
    return t;
  }
  /* The online season you host, kept in this browser so it can carry on another day:
     { code, key, season, at }. Removed when the season ends. */
  const OnlineSeason = {
    load: function () {
      try {
        const o = JSON.parse(window.localStorage.getItem('topdowngp.onlineSeason') || 'null');
        return o && o.code && o.key && o.season && Array.isArray(o.season.calendar) && !o.season.done ? o : null;
      } catch (e) { return null; }
    },
    save: function (o) { try { window.localStorage.setItem('topdowngp.onlineSeason', JSON.stringify(o)); } catch (e) { /* ignore */ } },
    clear: function () { try { window.localStorage.removeItem('topdowngp.onlineSeason'); } catch (e) { /* ignore */ } }
  };

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
    // the sound button: on the home screen and while driving (next to the pause button)
    const home = $('home').classList.contains('active') && !$('overlay').classList.contains('hidden');
    $('soundbtn').classList.toggle('hidden', !inGame && !home);
    $('soundbtn').classList.toggle('ingame', !!inGame);
    $('fsbtn').classList.toggle('hidden', !fsSupported || (!inGame && !home));
    $('fsbtn').classList.toggle('ingame', !!inGame);
  }
  /* Full screen (button or F): the game fills the whole screen, without the browser's bars. */
  const fsSupported = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function toggleFullscreen() {
    const de = document.documentElement;
    const fail = function () { toast('Full screen is not available here'); };
    try {
      const p = fsElement() ? (document.exitFullscreen || document.webkitExitFullscreen).call(document) : (de.requestFullscreen || de.webkitRequestFullscreen).call(de);
      if (p && p.catch) p.catch(fail);
    } catch (e) { fail(); }
  }
  function syncFsUI() {
    const on = !!fsElement();
    $('fsbtn').classList.toggle('on', on);
    $('fsbtn').querySelector('.lbl').textContent = on ? 'Exit full screen' : 'Full screen (F)';
    $('fsbtn').querySelector('button').setAttribute('aria-label', on ? 'Exit full screen (F)' : 'Full screen (F)');
  }
  document.addEventListener('fullscreenchange', syncFsUI);
  document.addEventListener('webkitfullscreenchange', syncFsUI);
  /* Show the real sound state everywhere it appears. */
  function syncSoundUI() {
    const muted = !!GameAudio.vol.muted;
    $('soundbtn').classList.toggle('muted', muted);
    $('soundbtn').querySelector('button').setAttribute('aria-pressed', muted ? 'true' : 'false');
    $('soundbtn').querySelector('.lbl').textContent = muted ? 'Sound off (M)' : 'Sound on (M)';
    if ($('set-mute')) $('set-mute').checked = muted;
  }
  function toggleSound() {
    const muted = GameAudio.toggleMute();
    syncSoundUI();
    toast(muted ? 'Sound off (M to turn it back on)' : 'Sound on');
  }
  let toastT = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('high', mode !== 'menu' && !!game && game.kind !== 'attract');   // above the dashboard while driving
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
  /* The Rejoin season button (home screen) and the season box (online screen), when you host a season. */
  function updateSeasonButtons() {
    const sv = OnlineSeason.load();
    $('home-rejoin').classList.toggle('hidden', !sv);
    $('online-season').classList.toggle('hidden', !sv);
    if (!sv) return;
    const n = sv.season.rounds.length, of = sv.season.calendar.length, next = F1.TRACK_DEFS[sv.season.calendar[n]];
    $('home-rejoin-sub').textContent = 'Round ' + (n + 1) + ' of ' + of + (next ? ' · ' + next.name : '') + ' · room ' + sv.code;
    $('os-sub').textContent = (n ? n + ' of ' + of + ' races done' : 'Not started yet') + (next ? ' · next: ' + next.name : '') + ' · room ' + sv.code;
  }
  function goHome() {
    $('busy').classList.add('hidden');
    $('confirm').classList.add('hidden');
    $('hostaway').classList.add('hidden');
    confirmAction = null;
    season = null;
    updateSeasonButtons();
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

  // ------------------------------------------------------------- time trial
  const ttOpts = Object.assign({ track: 'monza', driverId: 'NOR' }, Settings.data.tt || {});
  if (!F1.TRACK_DEFS[ttOpts.track]) ttOpts.track = 'monza';
  function showTTBoard(track) {
    const list = window.TTBoard.list(track), body = $('tt-board');
    $('tt-board-title').textContent = 'Your best laps — ' + F1.getTrack(track).name;
    body.innerHTML = '';
    if (!list.length) {
      const tr = el('tr'), td = el('td', 'empty', 'No laps yet — set the first time on this track');
      td.colSpan = 5; tr.appendChild(td); body.appendChild(tr);
      return;
    }
    list.forEach(function (e, i) {
      const d = F1.driver(e.d) || F1.driver('NOR'), t = F1.team(d.team);
      const tr = el('tr', i === 0 ? 'best' : '');
      tr.appendChild(el('td', 'pos', String(i + 1)));
      tr.appendChild(el('td', 'r', F1.fmtLap(e.t)));
      tr.appendChild(el('td', 'r', i === 0 ? '' : '+' + (e.t - list[0].t).toFixed(3)));
      const td = el('td', 'drv'), bar = el('span', 'bar');
      bar.style.background = teamColor(t);
      td.append(bar, document.createTextNode(d.name + ' · ' + t.name));
      tr.appendChild(td);
      tr.appendChild(el('td', 'r', new Date(e.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })));
      body.appendChild(tr);
    });
  }
  function openTT() {
    buildTrackCards($('tt-tracks'), ttOpts.track, function (id) { ttOpts.track = id; showTTBoard(id); });
    // the cards show your best time trial lap on each track
    $('tt-tracks').querySelectorAll('.track-card').forEach(function (card) {
      const l = window.TTBoard.list(card.dataset.id), pb = card.querySelector('.tpb');
      pb.textContent = l.length ? 'Best ' + F1.fmtLap(l[0].t) : 'No time yet';
      pb.classList.toggle('none', !l.length);
    });
    buildDrivers($('tt-drivers'), { selected: ttOpts.driverId, onPick: function (id) { ttOpts.driverId = id; } });
    showTTBoard(ttOpts.track);
    show('tt');
  }
  function startTT() {
    Settings.data.tt = Object.assign({}, ttOpts);
    Settings.save();
    mode = 'tt';
    game = new window.LocalGame({ type: 'practice', tt: true, track: ttOpts.track, driverId: ttOpts.driverId, aiCount: 0, title: 'TIME TRIAL' });
    R.resetEffects();
    GameAudio.newSession();
    show(null);
  }
  $('tt-start').addEventListener('click', startTT);

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
    newWeekend(Object.assign({}, gpOpts), shuffled(pool).slice(0, gpOpts.aiCount), null);
  }
  function newWeekend(opts, aiDrivers, champ) {
    gp = { opts: opts, aiDrivers: aiDrivers, grid: null, stages: [], idx: 0, champ: champ, recorded: false };
    ['p1', 'p2', 'p3'].forEach(function (k) { if (opts[k] > 0) gp.stages.push(k); });
    if (opts.qualiLaps > 0) gp.stages.push('quali');
    gp.stages.push('race');
    startGpStage(0);
  }
  function startGpStage(i) {
    const o = gp.opts, stage = gp.stages[i];
    const type = stage === 'quali' ? 'quali' : stage === 'race' ? 'race' : 'practice';
    gp.idx = i;
    gp.stage = stage;
    gp.recorded = false;
    if (type === 'race' && !gp.grid) gp.grid = shuffled([o.driverId].concat(gp.aiDrivers));   // no qualifying: random grid
    const round = gp.champ ? gp.champ.rounds.length + 1 : 0;
    mode = 'gp';
    clearInterval(resultsTimer);
    game = new window.LocalGame({
      type: type, track: o.track, driverId: o.driverId, aiDrivers: gp.aiDrivers,
      grid: type === 'race' ? gp.grid : null, aiLevel: o.aiLevel, collisions: true,
      laps: type === 'race' ? o.raceLaps : type === 'quali' ? o.qualiLaps : o[stage],
      title: round ? 'R' + round + ' ' + STAGE_NAME[stage].toUpperCase() : type === 'practice' ? STAGE_NAME[stage].toUpperCase() : null,
      onEnd: function (results, g) {
        if (mode !== 'gp' || game.S.results !== results) return;
        if (type === 'quali') gp.grid = results.map(function (r) { return r.driverId; });
        if (type === 'race' && gp.champ && !gp.recorded) recordRound(gp.champ, o.track, results);
        showResults({ type: type, stage: stage, track: o.track, results: results, round: round, stats: g && g.S.stats }, gp.champ ? 'champ' : 'gp');
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

  // ------------------------------------------------------------- championship
  /* A season: { v, opts, calendar:[track ids], aiDrivers, rounds:[{ track, res:[{ d, pos, pts, out }] }], done }
     saved in this browser so it can be continued later. */
  const Champ = {
    load: function () {
      try {
        const c = JSON.parse(window.localStorage.getItem('topdowngp.champ') || 'null');
        return c && c.v === 1 && Array.isArray(c.calendar) && Array.isArray(c.rounds) ? c : null;
      } catch (e) { return null; }
    },
    save: function (c) { try { window.localStorage.setItem('topdowngp.champ', JSON.stringify(c)); } catch (e) { /* ignore */ } }
  };

  function buildCalendar() {
    const box = $('champ-tracks');
    box.innerHTML = '';
    Object.keys(F1.TRACK_DEFS).forEach(function (id) {
      const T = F1.getTrack(id);
      const b = el('button', 'track-card');
      const cv = el('canvas');
      b.append(cv, el('div', 'tname', T.name), el('div', 'tlen', (T.length / 1000).toFixed(3) + ' km · ' + T.country));
      b.dataset.id = id;
      b.addEventListener('click', function () {
        const k = champOpts.calendar.indexOf(id);
        if (k >= 0) champOpts.calendar.splice(k, 1); else champOpts.calendar.push(id);
        markCalendar();
      });
      box.appendChild(b);
      requestAnimationFrame(function () { Renderer.trackPreview(cv, T); });
    });
    markCalendar();
  }
  function markCalendar() {
    $('champ-tracks').querySelectorAll('.track-card').forEach(function (b) {
      const k = champOpts.calendar.indexOf(b.dataset.id);
      b.classList.toggle('on', k >= 0);
      const old = b.querySelector('.round-badge');
      if (old) old.remove();
      if (k >= 0) b.appendChild(el('span', 'round-badge', String(k + 1)));
    });
    const n = champOpts.calendar.length;
    $('champ-start').textContent = n >= 2 ? 'Start season (' + n + ' races)' : 'Start season';
  }

  function openChamp() {
    buildCalendar();
    buildDrivers($('champ-drivers'), { selected: champOpts.driverId, onPick: function (id) { champOpts.driverId = id; } });
    $('champ-ai').value = champOpts.aiCount; $('champ-ai-val').textContent = champOpts.aiCount;
    $('champ-ai').oninput = function () { champOpts.aiCount = Number(this.value); $('champ-ai-val').textContent = this.value; };
    segInit($('champ-level'), champOpts.aiLevel, function (v) { champOpts.aiLevel = v; });
    ['p1', 'p2', 'p3'].forEach(function (k) {
      lapOptions($('champ-' + k), 1, 3, champOpts[k], 'Skip');
      $('champ-' + k).onchange = function () { champOpts[k] = Number(this.value); };
    });
    lapOptions($('champ-quali'), 1, 5, champOpts.qualiLaps, 'None (random grid)');
    lapOptions($('champ-race'), 1, 7, champOpts.raceLaps);
    $('champ-quali').onchange = function () { champOpts.qualiLaps = Number(this.value); };
    $('champ-race').onchange = function () { champOpts.raceLaps = Number(this.value); };
    // a season already under way?
    const c = Champ.load();
    $('champ-continue').classList.toggle('hidden', !c);
    if (c) {
      const st = standings(c), me = st.drivers.findIndex(function (r) { return r.id === c.opts.driverId; });
      if (c.done) {
        const w = st.drivers[0];
        $('cc-title').textContent = 'Last season: ' + (w.id === c.opts.driverId ? 'you were World Champion!' : F1.driver(w.id).name + ' was World Champion');
        $('cc-sub').textContent = 'You finished P' + (me + 1) + ' with ' + st.drivers[me].pts + ' points. Starting a new season replaces it.';
        $('cc-go').style.display = 'none';
      } else {
        const next = F1.getTrack(c.calendar[c.rounds.length]).name;
        $('cc-title').textContent = 'Season in progress: round ' + (c.rounds.length + 1) + ' of ' + c.calendar.length + ' — ' + next;
        $('cc-sub').textContent = (c.rounds.length ? 'You are P' + (me + 1) + ' with ' + st.drivers[me].pts + ' points. ' : '') + 'Starting a new season replaces it.';
        $('cc-go').style.display = '';
      }
    }
    show('champ');
  }
  function startSeason() {
    if (champOpts.calendar.length < 2) { toast('Pick at least 2 tracks for the calendar'); return; }
    Settings.data.champ = JSON.parse(JSON.stringify(champOpts));
    Settings.save();
    const pool = F1.DRIVERS.map(function (d) { return d.id; }).filter(function (id) { return id !== champOpts.driverId; });
    const o = champOpts;
    const c = { v: 1, opts: { driverId: o.driverId, aiCount: o.aiCount, aiLevel: o.aiLevel, p1: o.p1, p2: o.p2, p3: o.p3, qualiLaps: o.qualiLaps, raceLaps: o.raceLaps },
      calendar: o.calendar.slice(), aiDrivers: shuffled(pool).slice(0, o.aiCount), rounds: [], done: false };
    Champ.save(c);
    startRound(c);
  }
  function startRound(c) {
    if (c.done) return;
    newWeekend(Object.assign({ track: c.calendar[c.rounds.length] }, c.opts), c.aiDrivers.slice(), c);
  }
  function recordRound(c, track, results) {
    gp.recorded = true;
    c.rounds.push({ track: track, res: results.map(function (r) { return { d: r.driverId, pos: r.pos, pts: r.pts || 0, out: !!r.out }; }) });
    if (c.rounds.length >= c.calendar.length) c.done = true;
    Champ.save(c);
  }
  /* Drivers' and constructors' points; ties go to whoever has more wins, then more 2nd places, and so on. */
  function standings(c) {
    const ids = [c.opts.driverId].concat(c.aiDrivers);
    const rows = ids.map(function (id) { return { id: id, pts: 0, res: [], count: new Array(23).fill(0) }; });
    const byId = {};
    rows.forEach(function (r) { byId[r.id] = r; });
    c.rounds.forEach(function (rd, k) {
      rd.res.forEach(function (x) {
        const r = byId[x.d];
        if (!r) return;
        r.pts += x.pts;
        r.res[k] = x.out ? 'DNF' : x.pos;
        if (!x.out) r.count[x.pos]++;
      });
    });
    rows.sort(function (a, b) {
      if (b.pts !== a.pts) return b.pts - a.pts;
      for (let p = 1; p < 23; p++) if (b.count[p] !== a.count[p]) return b.count[p] - a.count[p];
      return ids.indexOf(a.id) - ids.indexOf(b.id);
    });
    const teams = {};
    rows.forEach(function (r) { const t = F1.teamOfDriver(r.id); teams[t.id] = (teams[t.id] || 0) + r.pts; });
    const teamRows = Object.keys(teams).map(function (id) { return { id: id, pts: teams[id] }; })
      .sort(function (a, b) { return b.pts - a.pts || F1.TEAMS.findIndex(function (t) { return t.id === a.id; }) - F1.TEAMS.findIndex(function (t) { return t.id === b.id; }); });
    return { drivers: rows, teams: teamRows };
  }
  /* Standings screen (your championship or an online season):
     o = { title, banner: { text, small } | null, calendar, drivers: [{ me, name, sub, color, cells: [{ text, cls, title }], pts }],
           teams: [{ me, name, color, pts }], note, next, newb, menu, car: { options, value } | null } */
  const CODES = { suzuka: 'JPN', jeddah: 'KSA', montreal: 'CAN', monaco: 'MON', redbullring: 'AUT', silverstone: 'GBR', spa: 'BEL', monza: 'ITA', baku: 'AZE', interlagos: 'BRA', abudhabi: 'UAE' };
  function renderStandings(o) {
    $('st-title').textContent = o.title;
    const banner = $('st-banner');
    banner.classList.toggle('hidden', !o.banner);
    if (o.banner) {
      banner.innerHTML = '';
      banner.append(document.createTextNode(o.banner.text));
      banner.appendChild(el('small', null, o.banner.small));
    }
    // drivers: a column per round (finishing position), then the total
    const head = $('st-drivers-head');
    head.innerHTML = '';
    const hr = el('tr');
    hr.append(el('th', null, 'Pos'), el('th', null, 'Driver'));
    o.calendar.forEach(function (id) { const th = el('th', 'rd', CODES[id] || id.slice(0, 3).toUpperCase()); th.title = F1.getTrack(id).name; hr.appendChild(th); });
    hr.appendChild(el('th', 'r', 'Pts'));
    head.appendChild(hr);
    const body = $('st-drivers');
    body.innerHTML = '';
    o.drivers.forEach(function (r, k) {
      const tr = el('tr', r.me ? 'me' : '');
      tr.appendChild(el('td', 'pos', String(k + 1)));
      const td = el('td', 'drv');
      const bar = el('span', 'bar'); bar.style.background = r.color;
      td.append(bar, document.createTextNode(r.name));
      if (r.sub) td.appendChild(el('span', 'sub', r.sub));
      tr.appendChild(td);
      r.cells.forEach(function (c) {
        const cell = el('td', 'rd' + (c.cls ? ' ' + c.cls : ''), c.text);
        if (c.title) cell.title = c.title;
        tr.appendChild(cell);
      });
      tr.appendChild(el('td', 'r big', String(r.pts)));
      body.appendChild(tr);
    });
    const tb = $('st-teams');
    tb.innerHTML = '';
    o.teams.forEach(function (r, k) {
      const tr = el('tr', r.me ? 'me' : '');
      tr.appendChild(el('td', 'pos', String(k + 1)));
      const td = el('td', 'drv');
      const bar = el('span', 'bar'); bar.style.background = r.color;
      td.append(bar, document.createTextNode(r.name));
      tr.appendChild(td);
      tr.appendChild(el('td', 'r big', String(r.pts)));
      tb.appendChild(tr);
    });
    $('st-note').textContent = o.note || '';
    $('st-next').style.display = o.next ? '' : 'none';
    if (o.next) $('st-next').textContent = o.next;
    $('st-new').style.display = o.newb ? '' : 'none';
    if (o.newb) $('st-new').textContent = o.newb;
    $('st-menu').textContent = o.menu;
    $('st-car-wrap').classList.toggle('hidden', !o.car);
    if (o.car) fillSelect($('st-car'), o.car.options, o.car.value);
    $('pause').classList.add('hidden');
    show('standings');
  }
  function posCell(v) {
    if (v === undefined) return { text: '–' };
    if (v === 'DNF') return { text: 'DNF', cls: 'dnf' };
    return { text: String(v), cls: v === 1 ? 'p1' : v === 2 ? 'p2' : v === 3 ? 'p3' : '' };
  }
  function showStandings(c) {
    standingsCtx = 'local';
    const st = standings(c), myId = c.opts.driverId;
    const done = c.done, n = c.rounds.length;
    let banner = null;
    if (done) {
      const w = st.drivers[0], t = F1.teamOfDriver(w.id);
      banner = { text: w.id === myId ? '🏆 You are the World Champion!' : '🏆 ' + F1.driver(w.id).name + ' is the World Champion',
        small: t.name + ' · ' + w.pts + ' points · Constructors\' champions: ' + F1.team(st.teams[0].id).name };
    }
    const myTeam = F1.teamOfDriver(myId).id, next = done ? null : F1.getTrack(c.calendar[n]);
    renderStandings({
      title: done ? 'Final standings' : n ? 'Standings after round ' + n + ' of ' + c.calendar.length : 'Standings',
      banner: banner, calendar: c.calendar,
      drivers: st.drivers.map(function (r) {
        return { me: r.id === myId, name: F1.driver(r.id).name + (r.id === myId ? '  (You)' : ''), color: teamColor(F1.teamOfDriver(r.id)), pts: r.pts,
          cells: c.calendar.map(function (id, i) { return posCell(r.res[i]); }) };
      }),
      teams: st.teams.map(function (r) { return { me: r.id === myTeam, name: F1.team(r.id).name, color: teamColor(F1.team(r.id)), pts: r.pts }; }),
      note: done ? 'Season complete.' : 'Your season is saved: you can carry on later from Championship on the home screen.',
      next: next ? 'Next race: ' + next.name : null, newb: done ? 'New season' : null, menu: 'Back to menu', car: null
    });
  }
  /* The online season's standings: drivers (players and AI) and constructors. Players who missed a race were
     placed last; players who left during a race were classified behind the others. */
  function onlineStandings(sv) {
    const rows = sv.entrants.map(function (e, k) { return { e: e, pts: 0, res: [], count: new Array(41).fill(0), k: k }; });
    const by = {};
    rows.forEach(function (r) { by[r.e.eid] = r; });
    sv.rounds.forEach(function (rd, i) {
      rd.res.forEach(function (x) { const r = by[x.eid]; if (!r) return; r.pts += x.pts; r.res[i] = x; if (!x.out) r.count[x.pos]++; });
    });
    rows.sort(function (a, b) {
      if (b.pts !== a.pts) return b.pts - a.pts;
      for (let p = 1; p < 41; p++) if (b.count[p] !== a.count[p]) return b.count[p] - a.count[p];
      return a.k - b.k;
    });
    const teams = {};
    rows.forEach(function (r) { const t = F1.teamOfDriver(r.e.driverId); teams[t.id] = (teams[t.id] || 0) + r.pts; });
    const teamRows = Object.keys(teams).map(function (id) { return { id: id, pts: teams[id] }; })
      .sort(function (a, b) { return b.pts - a.pts || F1.TEAMS.findIndex(function (t) { return t.id === a.id; }) - F1.TEAMS.findIndex(function (t) { return t.id === b.id; }); });
    return { drivers: rows, teams: teamRows };
  }
  function showOnlineStandings() {
    standingsCtx = 'online';
    const sv = season;
    if (!sv || !room) return;
    const st = onlineStandings(sv), n = sv.rounds.length, done = sv.done;
    const isHost = net && room.hostId === net.id();
    const me = sv.entrants.find(function (e) { return e.eid === sv.you; }) || null;
    const nameOf = function (e) { return e.human ? e.name : F1.driver(e.driverId).name; };
    let banner = null;
    if (done && st.drivers.length) {
      const w = st.drivers[0].e, t = F1.teamOfDriver(w.driverId);
      banner = { text: me && w.eid === me.eid ? '🏆 You are the World Champion!' : '🏆 ' + nameOf(w) + ' is the World Champion',
        small: t.name + ' · ' + st.drivers[0].pts + ' points · Constructors\' champions: ' + F1.team(st.teams[0].id).name };
    }
    const next = done ? null : F1.getTrack(sv.calendar[n]);
    const hostP = room.players.find(function (p) { return p.id === room.hostId; });
    // joined during the season and not raced yet: you can still pick a free car
    let car = null;
    if (me && !sv.rounds.some(function (rd) { return rd.res.some(function (x) { return x.eid === me.eid; }); })) {
      const used = {};
      sv.entrants.forEach(function (e) { if (e.eid !== me.eid) used[e.driverId] = true; });
      car = { value: me.driverId, options: F1.DRIVERS.filter(function (d) { return !used[d.id]; }).map(function (d) { return [d.id, '#' + d.number + ' ' + d.name]; }) };
    }
    const myTeam = me ? F1.teamOfDriver(me.driverId).id : null;
    renderStandings({
      title: (done ? 'Final standings' : n ? 'Standings after round ' + n + ' of ' + sv.calendar.length : 'Championship: ' + sv.calendar.length + ' rounds'),
      banner: banner, calendar: sv.calendar,
      drivers: st.drivers.map(function (r) {
        const e = r.e, mine = me && e.eid === me.eid;
        return { me: mine, name: nameOf(e) + (mine ? '  (You)' : ''), sub: e.human ? F1.driver(e.driverId).name + (e.here ? '' : ' · away') : '',
          color: teamColor(F1.teamOfDriver(e.driverId)), pts: r.pts,
          cells: sv.calendar.map(function (id, i) {
            const x = r.res[i];
            if (!x) return { text: '–' };
            if (x.out === 'absent') return { text: String(x.pos), cls: 'absent', title: 'Missed this race: placed last' };
            if (x.out === 'left') return { text: String(x.pos), cls: 'left', title: 'Left during the race' };
            return posCell(x.pos);
          }) };
      }),
      teams: st.teams.map(function (r) { return { me: r.id === myTeam, name: F1.team(r.id).name, color: teamColor(F1.team(r.id)), pts: r.pts }; }),
      note: done ? (isHost ? 'Season complete. Back to the lobby to start another one.' : 'Season complete.')
        : isHost ? 'The season is saved in your browser. If you leave, it pauses until you come back.'
        : 'Waiting for ' + (hostP ? hostP.name : 'the host') + ' to start ' + (n ? 'round ' + (n + 1) : 'the first round') + '…',
      next: isHost && next ? 'Start round ' + (n + 1) + ': ' + next.name : null,
      newb: isHost && done ? 'Back to lobby' : null,
      menu: 'Leave room', car: car
    });
  }
  $('champ-start').addEventListener('click', startSeason);
  $('cc-go').addEventListener('click', function () { const c = Champ.load(); if (c && !c.done) startRound(c); });
  $('cc-standings').addEventListener('click', function () { const c = Champ.load(); if (c) showStandings(c); });
  $('results-standings').addEventListener('click', function () {
    if (resultsCtx === 'online') { showOnlineStandings(); return; }
    const c = gp && gp.champ ? gp.champ : Champ.load(); if (c) showStandings(c);
  });
  $('st-next').addEventListener('click', function () {
    if (standingsCtx === 'online') { if (net) net.socket.emit('nextRound'); return; }
    const c = Champ.load(); if (c && !c.done) startRound(c);
  });
  $('st-new').addEventListener('click', function () {
    if (standingsCtx === 'online') { if (net) net.socket.emit('backToLobby'); return; }
    goHome(); openChamp();
  });
  $('st-menu').addEventListener('click', function () { if (standingsCtx === 'online') askLeaveRoom(false); else goHome(); });
  $('st-car').addEventListener('change', function () { if (net && standingsCtx === 'online') net.socket.emit('pickDriver', this.value); });

  // ------------------------------------------------------------- navigation
  document.querySelectorAll('[data-go]').forEach(function (b) {
    b.addEventListener('click', function () {
      const go = b.dataset.go;
      if (go === 'practice') openPractice();
      else if (go === 'gp') openGp();
      else if (go === 'champ') openChamp();
      else if (go === 'tt') openTT();
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
    segInit($('set-zoom'), d.zoom || 'normal', function (v) { d.zoom = v; Settings.save(); });
    segInit($('set-units'), d.units === 'mph' ? 'mph' : 'kmh', function (v) { d.units = v; Settings.save(); });
    $('set-labels').checked = !!d.labels;
    $('set-labels').onchange = function () { d.labels = this.checked; Settings.save(); };
    $('set-ghost').checked = d.ghost !== false;
    $('set-ghost').onchange = function () { d.ghost = this.checked; Settings.save(); };
    ['master', 'engine', 'effects'].forEach(function (k) {
      const inp = $('set-vol-' + k), out = $('set-vol-' + k + '-val');
      inp.value = Math.round(GameAudio.vol[k] * 100); out.textContent = inp.value;
      inp.oninput = function () { out.textContent = this.value; GameAudio.setVolume(k, Number(this.value) / 100); };
    });
    $('set-mute').checked = !!GameAudio.vol.muted;
    $('set-mute').onchange = function () { if (!!GameAudio.vol.muted !== this.checked) GameAudio.setMuted(this.checked); syncSoundUI(); };
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
    if (game && game.kind === 'local') { game.paused = true; game.cancelResume(); }
    $('pause-restart').style.display = mode === 'practice' || mode === 'gp' || mode === 'tt' ? '' : 'none';
    $('pause-restart').textContent = mode === 'gp' ? 'Restart this session' : mode === 'tt' ? 'Restart time trial' : 'Restart practice';
    // end practice or qualifying early (online: the host ends it for everyone)
    const live = game && (game.kind === 'online' ? !game.ended && game.phase !== 3 : game.S && game.S.phase !== 'done');
    const canEnd = live && (game.type === 'practice' || game.type === 'quali') &&
      ((mode === 'gp' && gp && game.kind === 'local') || (mode === 'online' && game.kind === 'online' && room && net && room.hostId === net.id()));
    $('pause-end').style.display = canEnd ? '' : 'none';
    $('pause-end').textContent = game && game.type === 'quali' ? 'End qualifying now' : 'End session now';
    updatePauseBtn();
    $('pause-note').textContent = mode === 'online' ? 'The session keeps running while this menu is open.' : '';
    $('pause-quit').textContent = mode === 'online' ? 'Leave the room' : mode === 'tt' ? 'Quit time trial' : 'Quit to menu';
    Input.active = false;
  }
  /* Back to the game. Offline sessions count down 3-2-1 first (still frozen) so you can see where you are;
     now = true skips that (restarting or ending the session). */
  function resume(now) {
    $('pause').classList.add('hidden');
    $('settings').classList.add('hidden');
    if (game && game.kind === 'local') {
      if (now !== true && game.paused && !game.ended && game.S.phase !== 'done') game.startResume();
      else { game.cancelResume(); game.paused = false; }
    }
    Input.active = mode !== 'menu' && $('overlay').classList.contains('hidden');
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    updatePauseBtn();
  }
  $('pausebtn').querySelector('button').addEventListener('click', function (e) { e.currentTarget.blur(); openPause(); });
  $('pause-resume').addEventListener('click', function () { resume(); });
  $('pause-restart').addEventListener('click', function () {
    resume(true);
    if (mode === 'gp' && gp) startGpStage(gp.idx); else if (mode === 'tt') startTT(); else startPractice();
  });
  function sessionLive() { return game && (game.kind === 'online' ? !game.ended && game.phase !== 3 : game.S && game.S.phase !== 'done'); }
  $('pause-end').addEventListener('click', function () {
    if (!sessionLive()) { resume(true); return; }
    if (game.type !== 'quali') { resume(true); endSessionNow(); return; }
    // qualifying: a warning first
    let text;
    if (game.kind === 'online') text = 'This ends qualifying for everyone. Drivers who haven\'t set a lap time will start the race from the back of the grid.';
    else {
      const me = game.me, n = game.S.cars.length;
      text = me && me.bestLap !== null
        ? 'You keep your best lap (' + F1.fmtLap(me.bestLap) + '), which is P' + me.pos + ' right now. The other drivers will finish their laps, so you could drop back if they go faster.'
        : 'You haven\'t set a lap time yet, so you will start the race from the back of the grid (P' + n + ').';
    }
    confirmAction = null;
    $('confirm-title').textContent = 'End qualifying now?';
    $('confirm-yes').textContent = 'End qualifying';
    $('confirm-no').textContent = 'Keep driving';
    $('confirm-text').textContent = text;
    $('pause').classList.add('hidden');
    $('confirm').classList.remove('hidden');
  });
  /* The warning dialog is also used for other questions (leaving a season): o = { title, text, yes, no, onYes, onNo }. */
  let confirmAction = null;
  function askConfirm(o) {
    confirmAction = o;
    $('confirm-title').textContent = o.title;
    $('confirm-text').textContent = o.text;
    $('confirm-yes').textContent = o.yes;
    $('confirm-no').textContent = o.no;
    $('confirm').classList.remove('hidden');
  }
  function closeConfirm(backToPause, now) {
    $('confirm').classList.add('hidden');
    if (confirmAction) { const a = confirmAction; confirmAction = null; if (a.onNo) a.onNo(); return; }
    if (backToPause) $('pause').classList.remove('hidden'); else resume(now);
  }
  $('confirm-no').addEventListener('click', function () { closeConfirm(false); });
  $('confirm-yes').addEventListener('click', function () {
    if (confirmAction) { const a = confirmAction; confirmAction = null; $('confirm').classList.add('hidden'); a.onYes(); return; }
    closeConfirm(false, true); endSessionNow();
  });
  function endSessionNow() {
    if (!sessionLive()) return;
    if (game.kind === 'online') { if (net) net.emit('endSession'); return; }
    if (game.type === 'quali') {
      $('busy-fill').style.width = '0%';
      $('busy').classList.remove('hidden');
      game.endEarly(function (f) { $('busy-fill').style.width = Math.round(f * 100) + '%'; });
    } else game.endEarly();
  }
  $('pause-quit').addEventListener('click', function () {
    if (mode === 'online') askLeaveRoom(true); else if (mode === 'tt') { goHome(); openTT(); } else goHome();
  });
  $('soundbtn').querySelector('button').addEventListener('click', function (e) { e.currentTarget.blur(); toggleSound(); });
  $('fsbtn').querySelector('button').addEventListener('click', function (e) { e.currentTarget.blur(); toggleFullscreen(); });
  // the game open in another tab, or brought back from the browser's cache: use the saved sound settings
  window.addEventListener('storage', function (e) { if (e.key === 'topdowngp.settings') { GameAudio.reload(); syncSoundUI(); } });
  window.addEventListener('pageshow', function () { GameAudio.reload(); syncSoundUI(); });
  window.addEventListener('keydown', function (e) {
    const tg = e.target && e.target.tagName;
    // M works everywhere except while typing (your name, a room code)
    const typing = tg === 'TEXTAREA' || tg === 'SELECT' || (tg === 'INPUT' && !/^(checkbox|radio|range|button|submit)$/i.test(e.target.type || ''));
    if (e.code === 'KeyM' && !e.repeat && !typing) {
      toggleSound();
      return;
    }
    // F: full screen on / off
    if (e.code === 'KeyF' && !e.repeat && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (fsSupported) toggleFullscreen();
      return;
    }
    // C: camera distance (close / normal / far) while driving
    if (e.code === 'KeyC' && !e.repeat && tg !== 'INPUT' && tg !== 'SELECT' && mode !== 'menu' && game && game.kind !== 'attract') {
      const order = ['close', 'normal', 'far'], d = Settings.data;
      d.zoom = order[(order.indexOf(d.zoom || 'normal') + 1) % order.length];
      Settings.save();
      toast('Camera: ' + d.zoom.charAt(0).toUpperCase() + d.zoom.slice(1));
      return;
    }
    if (e.code !== 'Escape' && e.code !== 'KeyP') return;
    const tag = e.target && e.target.tagName;
    if (e.code === 'KeyP' && (tag === 'INPUT' || tag === 'SELECT')) return;
    if (!$('settings').classList.contains('hidden')) { $('settings-close').click(); return; }
    if (!$('confirm').classList.contains('hidden')) { closeConfirm(true); return; }
    if (pauseOpen()) resume(); else openPause();
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { GameAudio.reload(); syncSoundUI(); }
    GameAudio.suspend(document.hidden);
    if (document.hidden && (mode === 'practice' || mode === 'gp' || mode === 'tt') && !pauseOpen()) openPause();
    if (document.hidden) {
      Input.keys = {};
      if (game && game.kind === 'online') game.sendNeutral();
    }
  });

  // ------------------------------------------------------------- online
  function ensureNet() {
    if (net) return net;
    const socket = window.io({ transports: ['websocket', 'polling'], tryAllTransports: true });
    net = { socket: socket, ping: null, jitWorst: 0, id: function () { return socket.id; }, emit: function () { socket.emit.apply(socket, arguments); } };
    socket.on('room', onRoom);
    socket.on('session', onSession);
    socket.on('snap', function (m) { if (game && game.kind === 'online') game.onSnap(m); });
    socket.on('timing', function (m) { if (game && game.kind === 'online') game.onTiming(m); });
    socket.on('ev', function (m) { if (game && game.kind === 'online') game.onEvents(m); });
    socket.on('sessionEnd', onSessionEnd);
    socket.on('season', onSeason);
    socket.on('seasonEnded', function (m) {
      if (game && game.kind === 'online') game.ended = true;
      season = null;
      const sv = OnlineSeason.load();
      if (sv && room && sv.code === room.code) OnlineSeason.clear();
      if (!(m && m.finished)) toast('The host has ended the championship');
    });
    socket.on('disconnect', function () {
      if (room) {
        const hosting = season && !season.done && room.hostId === net.id();
        room = null; goHome();
        toast(hosting ? 'Lost connection — your season is paused: press Rejoin season to carry on' : 'Lost connection to the server');
      }
    });
    socket.on('connect_error', function () { $('online-error').textContent = 'Cannot reach the game server.'; });
    // ping every 2 s; also tell the room how our connection is doing (shown on their connection indicator)
    setInterval(function () {
      if (!socket.connected) return;
      const t0 = performance.now();
      socket.emit('lat', { p: net.ping || 0, j: net.jitWorst || 0 }, function () { net.ping = Math.round(performance.now() - t0); });
      net.jitWorst = 0;
    }, 2000);
    return net;
  }

  function openOnline(code) {
    $('online-name').value = Settings.data.name || '';
    if (code) $('online-code').value = code;
    $('online-error').textContent = '';
    updateSeasonButtons();
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
    n.socket.emit('createRoom', { name: playerName(), token: myToken() }, function (res) {
      if (!res || !res.ok) { $('online-error').textContent = (res && res.error) || 'Could not create a room'; return; }
      history.replaceState(null, '', '?room=' + res.code);
    });
  });
  function joinCode() {
    const n = ensureNet();
    const code = $('online-code').value.trim().toUpperCase();
    if (code.length !== 4) { $('online-error').textContent = 'Room codes have 4 characters'; return; }
    $('online-error').textContent = '';
    const sv = OnlineSeason.load();      // your own season's room: you come back as its host
    n.socket.emit('joinRoom', { code: code, name: playerName(), token: myToken(), key: sv && sv.code === code ? sv.key : undefined }, function (res) {
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
  /* Leaving: the host of a season is warned that it pauses for everyone until they come back. */
  function askLeaveRoom(fromPause) {
    const hosting = room && net && season && !season.done && room.hostId === net.id();
    if (!hosting) { leaveRoom(); return; }
    $('pause').classList.add('hidden');
    askConfirm({
      title: 'Leave the season?', yes: 'Pause and leave', no: 'Stay',
      text: 'The season pauses for everyone until you come back. It is saved in this browser: press Rejoin season on the home screen to carry on.',
      onYes: leaveRoom,
      onNo: function () { if (fromPause) $('pause').classList.remove('hidden'); }
    });
  }
  $('lobby-leave').addEventListener('click', function () { askLeaveRoom(false); });
  $('hostaway-leave').addEventListener('click', leaveRoom);
  /* Your season: open the room again (as the host) from the copy in this browser. */
  function rejoinSeason() {
    const sv = OnlineSeason.load();
    if (!sv) { updateSeasonButtons(); return; }
    openOnline();
    const n = ensureNet();
    $('online-error').textContent = 'Opening your season…';
    n.socket.emit('rejoinSeason', { code: sv.code, key: sv.key, season: sv.season, name: playerName(), token: myToken() }, function (res) {
      if (!res || !res.ok) { $('online-error').textContent = (res && res.error) || 'Could not open the season'; return; }
      $('online-error').textContent = '';
      history.replaceState(null, '', '?room=' + res.code);
      if (res.moved) toast('Your season is in room ' + res.code + ' now — send your friends the new invite link');
    });
  }
  $('home-rejoin').addEventListener('click', rejoinSeason);
  $('os-rejoin').addEventListener('click', rejoinSeason);
  $('os-end').addEventListener('click', function () {
    const sv = OnlineSeason.load();
    if (!sv) return;
    askConfirm({
      title: 'End your season?', yes: 'End the season', no: 'Keep it',
      text: 'The championship ends for everyone and can\'t be continued. Results so far are not kept.',
      onYes: function () {
        const n = ensureNet();
        n.socket.emit('endSeason', { code: sv.code, key: sv.key });
        OnlineSeason.clear();
        updateSeasonButtons();
        toast('Season ended');
      }
    });
  });
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
    // championship: a calendar of 2 to 11 tracks instead of one track
    const champ = s.mode === 'champ', cal = s.calendar || [];
    $('set-mode').value = champ ? 'champ' : 'single';
    $('lobby-cal').classList.toggle('hidden', !champ);
    $('set-track-wrap').classList.toggle('hidden', champ);
    const chips = $('lobby-cal-chips'), ckey = JSON.stringify([cal, isHost]);
    if (chips.dataset.key !== ckey) {
      chips.dataset.key = ckey;
      chips.innerHTML = '';
      Object.keys(F1.TRACK_DEFS).forEach(function (id) {
        const k = cal.indexOf(id), b = el('button', 'cal-chip' + (k >= 0 ? ' on' : ''));
        b.type = 'button';
        b.disabled = !isHost;
        if (k >= 0) b.appendChild(el('b', null, String(k + 1)));
        b.appendChild(document.createTextNode(F1.TRACK_DEFS[id].short || F1.TRACK_DEFS[id].name));
        b.addEventListener('click', function () {
          const next = cal.slice(), at = next.indexOf(id);
          if (at >= 0) next.splice(at, 1); else next.push(id);
          if (net) net.socket.emit('settings', { calendar: next });
        });
        chips.appendChild(b);
      });
    }
    $('lobby-cal-n').textContent = cal.length ? '(' + cal.length + (cal.length === 1 ? ' race' : ' races') + ')' : (isHost ? '(click tracks in race order)' : '');
    fillSelect($('set-track'), Object.keys(F1.TRACK_DEFS).map(function (id) { return [id, F1.TRACK_DEFS[id].name]; }), s.track);
    ['p1', 'p2', 'p3'].forEach(function (k) { fillSelect($('set-' + k), [[0, 'Skip'], [1, '1 lap'], [2, '2 laps'], [3, '3 laps']], s[k] || 0); });
    fillSelect($('set-quali'), [[0, 'None (random grid)'], [1, '1 lap'], [2, '2 laps'], [3, '3 laps'], [4, '4 laps'], [5, '5 laps']], s.qualiLaps);
    const raceOpts = []; for (let i = 1; i <= 7; i++) raceOpts.push([i, i + (i === 1 ? ' lap' : ' laps')]);
    fillSelect($('set-race'), raceOpts, Math.min(7, s.raceLaps));
    const aiMax = 22 - r.players.length, aiOpts = [];
    for (let i = 0; i <= 21; i++) aiOpts.push([i, i > aiMax ? i + ' (max ' + aiMax + ')' : (i === aiMax ? i + ' (full grid)' : String(i))]);
    fillSelect($('set-ai'), aiOpts, s.aiCount);
    $('set-level').value = s.aiLevel;
    ['set-mode', 'set-track', 'set-p1', 'set-p2', 'set-p3', 'set-quali', 'set-race', 'set-ai', 'set-level'].forEach(function (id) { $(id).disabled = !isHost; });
    $('lobby-hostnote').textContent = isHost ? '' : '(host decides)';
    $('lobby-start').style.display = isHost ? '' : 'none';
    const first = ['p1', 'p2', 'p3'].find(function (k) { return s[k] > 0; }) || (s.qualiLaps > 0 ? 'quali' : 'race');
    $('lobby-start').textContent = champ ? (cal.length >= 2 ? 'Start season (' + cal.length + ' races)' : 'Pick at least 2 tracks')
      : first === 'race' ? 'Start race' : 'Start ' + STAGE_NAME[first];
    $('lobby-start').disabled = champ && cal.length < 2;
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
  ['set-mode', 'set-track', 'set-p1', 'set-p2', 'set-p3', 'set-quali', 'set-race', 'set-ai', 'set-level'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      const map = { 'set-mode': 'mode', 'set-track': 'track', 'set-p1': 'p1', 'set-p2': 'p2', 'set-p3': 'p3', 'set-quali': 'qualiLaps', 'set-race': 'raceLaps', 'set-ai': 'aiCount', 'set-level': 'aiLevel' };
      const v = this.value, msg = {};
      msg[map[id]] = (id === 'set-mode' || id === 'set-track' || id === 'set-level') ? v : Number(v);
      if (net) net.socket.emit('settings', msg);
    });
  });

  let roomAt = 0;
  function onRoom(r) {
    room = r;
    roomAt = performance.now();
    mode = 'online';
    const inSession = game && game.kind === 'online' && !game.ended;
    // an online season waits while its host is away, then carries on after a 3-2-1
    $('hostaway').classList.toggle('hidden', !r.hostAway);
    if (r.hostAway) $('hostaway-text').textContent = (r.awayName || 'The host') + ' has left the room. The season carries on as soon as they come back.';
    if (game && game.kind === 'online') game.setPause(!!r.hostAway, r.resumeIn || 0);
    if (r.hostAway) $('pause').classList.add('hidden');
    updatePauseBtn();
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
    maybeShowSeasonBreak();
    updateResultsButtons();
    if ($('standings').classList.contains('active') && standingsCtx === 'online') showOnlineStandings();
  }

  /* Between two rounds of a season with nothing else on screen (the host opened the season again): the standings. */
  function maybeShowSeasonBreak() {
    if (!room || room.state !== 'seasonBreak' || !season) return;
    if (game && game.kind === 'online' && !game.ended) return;
    if ($('results').classList.contains('active') || $('standings').classList.contains('active')) return;
    showOnlineStandings();
  }

  /* The season of this room (championship standings, your car), from the server. The host keeps a copy. */
  function onSeason(sv) {
    const first = !season;
    season = sv;
    if (sv && sv.save) {
      if (sv.done) OnlineSeason.clear();
      else OnlineSeason.save({ code: sv.save.code, key: sv.save.key, season: sv.save.season, at: Date.now() });
    }
    if (sv && first && sv.rounds.length && !sv.done) {
      const me = sv.entrants.find(function (e) { return e.eid === sv.you; });
      const raced = me && sv.rounds.some(function (rd) { return rd.res.some(function (x) { return x.eid === me.eid; }); });
      const d = me ? F1.driver(me.driverId) : null;
      if (!me) toast('Every car is taken this season — you can watch the races');
      else if (raced) toast('Welcome back: you are driving #' + d.number + ' ' + d.name + ' again');
      else toast('You have joined the season as #' + d.number + ' ' + d.name + ' — your points start now');
    }
    if ($('standings').classList.contains('active') && standingsCtx === 'online') showOnlineStandings();
    maybeShowSeasonBreak();
    updateResultsButtons();
  }

  function onSession(info) {
    mode = 'online';
    clearInterval(resultsTimer);
    $('pause').classList.add('hidden');
    $('settings').classList.add('hidden');
    game = new window.OnlineGame(net, info);
    // joining a paused season (or the host coming back): wait with everyone else
    if (room && (room.hostAway || room.resumeIn)) game.setPause(!!room.hostAway, Math.max(0, (room.resumeIn || 0) - (performance.now() - roomAt)));
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
    $('busy').classList.add('hidden');
    $('confirm').classList.add('hidden');
    lastResults = m;
    resultsCtx = ctx;
    const T = F1.getTrack(m.track);
    $('results-title').textContent = (m.round ? 'Round ' + m.round + ' · ' : '') + (m.stage ? STAGE_NAME[m.stage] : m.type === 'quali' ? 'Qualifying' : 'Race') + ' results — ' + T.name;
    const body = $('results-body');
    body.innerHTML = '';
    $('results-table').classList.toggle('no-pts', m.type !== 'race');
    const me = net && net.id();
    const local = ctx === 'gp' || ctx === 'champ';
    const myPlayer = local ? { driverId: gp && gp.opts.driverId } : room && room.players.find(function (p) { return p.id === me; });
    let fastest = null;
    m.results.forEach(function (r) { if (r.best !== null && (fastest === null || r.best < fastest)) fastest = r.best; });
    m.results.forEach(function (r) {
      const d = F1.driver(r.driverId), t = F1.team(d.team);
      const tr = el('tr', myPlayer && myPlayer.driverId === r.driverId ? 'me' : '');
      tr.appendChild(el('td', 'pos', String(r.pos)));
      const td = el('td', 'drv');
      const bar = el('span', 'bar'); bar.style.background = teamColor(t);
      td.append(bar, document.createTextNode(d.name + (r.isAI ? '' : '  (' + (local ? 'You' : r.name || 'Player') + ')')));
      tr.appendChild(td);
      tr.appendChild(el('td', null, t.name));
      const gapTd = el('td', 'r', r.gap);
      if (r.pen) gapTd.appendChild(el('span', 'pen', '+' + r.pen + 's pen'));
      tr.appendChild(gapTd);
      tr.appendChild(el('td', 'r' + (r.best !== null && r.best === fastest && m.type === 'race' ? ' purple' : ''), r.best !== null ? F1.fmtLap(r.best) : '—'));
      tr.appendChild(el('td', 'r', String(r.laps)));
      // grid slot and places gained / lost
      const gridTd = el('td', 'r race-col', r.grid ? 'P' + r.grid : '');
      if (r.grid && !r.out && r.gained) gridTd.appendChild(el('span', r.gained > 0 ? 'up' : 'down', (r.gained > 0 ? '▲' : '▼') + Math.abs(r.gained)));
      tr.appendChild(gridTd);
      tr.appendChild(el('td', 'r race-col', r.ovt !== undefined ? String(r.ovt) : ''));
      const ptsTd = el('td', 'r pts-col' + (r.pts ? ' pts' : ''), r.pts ? String(r.pts) : '');
      if (r.flPt) ptsTd.title = 'Includes 1 point for the fastest lap';
      tr.appendChild(ptsTd);
      body.appendChild(tr);
    });
    showRaceStats(m, myPlayer, local);
    clearInterval(resultsTimer);
    if (local) {
      const mine = m.results.find(function (r) { return !r.isAI; });
      if (m.type === 'practice') $('results-note').textContent = mine && mine.best !== null ? 'Your best lap ' + F1.fmtLap(mine.best) + ' — P' + mine.pos : 'No lap time set';
      else if (m.type === 'quali') $('results-note').textContent = mine ? 'You start the race from P' + mine.pos : '';
      else $('results-note').textContent = mine ? 'You finished P' + mine.pos + (mine.pts ? ' — ' + mine.pts + (mine.pts === 1 ? ' point' : ' points') : '') : '';
    } else if (m.next && m.nextIn) {
      let left = m.nextIn;
      const say = function () {
        return (m.next === 'race' ? 'The race' : STAGE_NAME[m.next]) + ' starts in ' + left + ' s' +
          (m.next === 'race' && m.type === 'quali' ? ' — you start from your qualifying position' : '');
      };
      $('results-note').textContent = say();
      resultsTimer = setInterval(function () {
        left--;
        if (left <= 0) { clearInterval(resultsTimer); $('results-note').textContent = 'Starting…'; return; }
        $('results-note').textContent = say();
      }, 1000);
    } else {
      $('results-note').textContent = '';
    }
    $('pause').classList.add('hidden');
    show('results');
    updateResultsButtons();
  }
  /* Race stat cards: Driver of the day, fastest lap, most overtakes, biggest climber. */
  function showRaceStats(m, myPlayer, local) {
    const box = $('race-stats'), st = m.stats;
    box.innerHTML = '';
    box.classList.toggle('hidden', !(m.type === 'race' && st));
    if (m.type !== 'race' || !st) return;
    const nameOf = function (driverId) {
      const r = m.results.find(function (x) { return x.driverId === driverId; });
      return F1.driver(driverId).name + (r && !r.isAI ? (local ? ' (You)' : ' (' + (r.name || 'Player') + ')') : '');
    };
    const card = function (cls, label, driverId, detail) {
      const c = el('div', 'stat-card ' + cls + (myPlayer && myPlayer.driverId === driverId ? ' mine' : ''));
      c.appendChild(el('div', 'lbl', label));
      const who = el('div', 'who');
      if (driverId) {
        const bar = el('span', 'bar'); bar.style.background = teamColor(F1.team(F1.driver(driverId).team));
        who.append(bar, document.createTextNode(nameOf(driverId)));
      } else who.textContent = '—';
      c.append(who, el('div', 'det', detail));
      box.appendChild(c);
    };
    const d = st.dotd;
    card('dotd', 'Driver of the day', d && d.driverId, d ? 'P' + d.grid + ' → P' + d.pos + (d.ovt ? ' · ' + d.ovt + (d.ovt === 1 ? ' overtake' : ' overtakes') : '') + (d.fl ? ' · fastest lap' : '') : '');
    const f = st.fastest;
    card('fl', 'Fastest lap', f && f.driverId, f ? F1.fmtLap(f.time) + (f.point ? ' · +1 point' : ' · no point (outside the top 10)') : 'No laps completed');
    const o = st.mostOvertakes;
    card('', 'Most overtakes', o && o.driverId, o ? o.n + (o.n === 1 ? ' overtake' : ' overtakes') : 'No overtakes');
    const c2 = st.climber;
    card('', 'Biggest climber', c2 && c2.driverId, c2 ? 'P' + c2.from + ' → P' + c2.to + ' (+' + c2.n + ')' : 'Nobody gained places');
  }
  function updateResultsButtons() {
    const isChamp = resultsCtx === 'champ', isGp = resultsCtx === 'gp' || isChamp;
    const isHost = !isGp && room && net && room.hostId === net.id();
    const raceDone = lastResults && lastResults.type === 'race';
    const onlineSeason = !isGp && raceDone && !!lastResults.season;
    $('results-lobby').style.display = !isGp && isHost && raceDone && !onlineSeason ? '' : 'none';
    const next = isGp && gp && !raceDone ? gp.stages[gp.idx + 1] : null;
    $('results-next').style.display = next ? '' : 'none';
    if (next) $('results-next').textContent = next === 'race' ? 'Start the race' : 'Start ' + STAGE_NAME[next];
    $('results-again').style.display = isGp && !isChamp && raceDone ? '' : 'none';
    $('results-restart').style.display = isGp && !isChamp && raceDone && gp && gp.stages.length > 1 ? '' : 'none';
    $('results-standings').style.display = (isChamp || onlineSeason) && raceDone ? '' : 'none';
    $('results-menu').style.display = isGp ? '' : 'none';
    if (onlineSeason) {
      const done = season && season.done;
      $('results-note').textContent = isHost ? (done ? 'The season is over: see the final standings.' : 'Next: the championship standings, then start the next round.')
        : (done ? 'The season is over!' : 'Waiting for the host to start the next round…');
    } else if (!isGp && raceDone && !isHost) $('results-note').textContent = 'Waiting for the host to return to the lobby…';
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
    const audioOn = mode !== 'menu' && game.kind !== 'attract' && $('overlay').classList.contains('hidden') && $('pause').classList.contains('hidden') && !(game.resumeT > 0) && !game.frozen;
    GameAudio.setActive(audioOn);
    if (audioOn && game.audioState) { try { const st = game.audioState(); if (st) GameAudio.update(st, dt); } catch (err) { console.error(err); } }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
