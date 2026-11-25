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
  document.querySelectorAll('.cal-note').forEach(function (n) { n.textContent = 'Click the tracks in the order you want to race them (2 to ' + Object.keys(F1.TRACK_DEFS).length + ' races).'; });
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
  // (the ground is drawn from stored tiles when the graphics chip draws the page, see render.js)
  const R = new Renderer($('game'), { cpu: /[?&]cpu=1(&|$)/.test(location.search), tiles: 'auto' });

  let game = null;
  let mode = 'menu';          // 'menu' | 'practice' | 'tt' | 'gp' | 'online'
  let net = null;
  let room = null;
  let resultsTimer = null;
  let lastResults = null;
  const COND = { drafting: true, tyres: true, weather: true };     // race conditions: drafting, tyre wear, weather
  const practiceOpts = Object.assign({ track: 'monza', driverId: 'NOR', aiCount: 10, aiLevel: 'medium', collisions: true }, COND, Settings.data.practice || {});
  const gpOpts = Object.assign({ track: 'monza', driverId: 'NOR', aiCount: 15, aiLevel: 'medium', p1: 0, p2: 0, p3: 0, qualiLaps: 2, raceLaps: 5 }, COND, Settings.data.gp || {});
  // a track id, or 'random' ("Surprise me": a random track, revealed when the session starts)
  const trackOk = function (id) { return id === 'random' || !!F1.TRACK_DEFS[id]; };
  if (!trackOk(practiceOpts.track)) practiceOpts.track = 'monza';
  if (!trackOk(gpOpts.track)) gpOpts.track = 'monza';
  let gp = null;               // current Grand Prix weekend { opts, aiDrivers, grid, stages, idx, champ }
  const champOpts = Object.assign({ driverId: 'NOR', aiCount: 15, aiLevel: 'medium', p1: 0, p2: 0, p3: 0, qualiLaps: 2, raceLaps: 5,
    calendar: ['silverstone', 'spa', 'monza', 'interlagos', 'abudhabi'] }, COND, Settings.data.champ || {});
  /* The three condition switches on a setup screen (prefix-draft / -tyres / -weather) for an options object. */
  function condInit(prefix, o) {
    [['draft', 'drafting'], ['tyres', 'tyres'], ['weather', 'weather']].forEach(function (k) {
      const box = document.getElementById(prefix + '-' + k[0]);
      box.checked = o[k[1]] !== false;
      box.onchange = function () { o[k[1]] = this.checked; };
    });
  }
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
  /* A friend's season you are racing in, remembered so you can come back without the invite link:
     { code, host, played, of, at }. Forgotten after 45 days, or when the season is over. */
  const FriendSeason = {
    load: function () {
      try {
        const o = JSON.parse(window.localStorage.getItem('topdowngp.joinedSeason') || 'null');
        return o && /^[A-Z0-9]{4}$/.test(o.code || '') && Date.now() - (o.at || 0) < 45 * 86400000 ? o : null;
      } catch (e) { return null; }
    },
    save: function (o) { try { window.localStorage.setItem('topdowngp.joinedSeason', JSON.stringify(o)); } catch (e) { /* ignore */ } },
    clear: function () { try { window.localStorage.removeItem('topdowngp.joinedSeason'); } catch (e) { /* ignore */ } }
  };

  // ------------------------------------------------------------- helpers
  /* Clicking (or tapping) the dark area around a box closes it, as its back / close button would. Only a click that
     both starts and ends outside the box counts (dragging a slider and letting go outside it does not close it). */
  function closeDropdowns() { if (window.Dropdown) window.Dropdown.closeAll(); }
  function clickOutside(backdrop, isOutside, fn) {
    let downOut = false;
    backdrop.addEventListener('pointerdown', function (e) { downOut = isOutside(e.target); });
    backdrop.addEventListener('click', function (e) {
      const ok = downOut && isOutside(e.target);
      downOut = false;
      if (ok) fn(e);
    });
  }
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
    // the on-screen controls (phones and tablets) are up while you drive; with the pause menu open in an offline session
    // (everything frozen) they keep any finger that is still resting on them, so a thumb kept on the gas carries on at
    // "go". Online the session keeps running behind the menu, so there they let go as before.
    const paused = mode !== 'menu' && game && game.kind === 'local' && !$('pause').classList.contains('hidden');
    window.TouchUI.show(!!inGame, !!inGame || (mode === 'online' && !!room), paused);
  }
  /* Full screen (button or F): the game fills the whole screen, without the browser's bars. */
  const fsSupported = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function toggleFullscreen() {
    const de = document.documentElement;
    const fail = function () { toast('Full screen is not available here'); };
    try {
      const going = !fsElement();
      const p = going ? (de.requestFullscreen || de.webkitRequestFullscreen).call(de) : (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      if (p && p.catch) p.catch(fail);
      // on a phone, full screen also turns the picture sideways where the phone allows it
      if (going && Input.touch.active && window.screen && window.screen.orientation && window.screen.orientation.lock) {
        const lock = function () { try { const q = window.screen.orientation.lock('landscape'); if (q && q.catch) q.catch(function () { /* not allowed here */ }); } catch (e) { /* not supported */ } };
        if (p && p.then) p.then(lock, function () { /* no full screen */ }); else lock();
      }
    } catch (e) { fail(); }
  }
  /* Phones and tablets: before a session, ask to play in full screen (the browser's bars squash the game).
     iPhones cannot go full screen in the browser: there the notice explains Add to Home Screen instead. */
  let fsNext = null, lobbyNoticeShown = false;
  function standalone() {
    return window.navigator.standalone === true || !!(window.matchMedia && window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches);
  }
  function fsGate(next) {
    if (!Input.touch.active || fsElement() || standalone() || Settings.data.fsNotice === false) { next(); return; }
    fsNext = next;
    const ios = !fsSupported && /iPhone|iPod|iPad|Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
    $('fsn-title').textContent = fsSupported ? 'Play in full screen' : ios ? 'Add the game to your Home Screen' : 'Use the whole screen';
    $('fsn-text').textContent = fsSupported
      ? 'For the best experience, play in full screen. Without it, the browser\'s bars squash the game and some of the screen may be hidden.'
      : ios ? 'iPhones don\'t allow full screen in the browser. For the best experience, tap Share, then Add to Home Screen, and open Top-Down GP from there. Without it, the browser\'s bars squash the game and some of the screen may be hidden.'
        : 'This browser can\'t go full screen. For the best experience, hide the browser\'s bars or add the game to your home screen: without that, some of the screen may be hidden.';
    $('fsn-go').classList.toggle('hidden', !fsSupported);
    $('fsn-skip').textContent = fsSupported ? 'Continue anyway' : 'Continue';
    $('fsn-never').checked = false;
    $('fsnotice').classList.remove('hidden');
  }
  /* go = true: full screen first, then on. null (a click outside the box): back to where you were, nothing starts. */
  function fsNoticeClose(go) {
    $('fsnotice').classList.add('hidden');
    if ($('fsn-never').checked) { Settings.data.fsNotice = false; Settings.save(); }
    const next = fsNext;
    fsNext = null;
    if (go === null) return;
    if (go && fsSupported && !fsElement()) toggleFullscreen();
    if (next) next();
  }
  $('fsn-go').addEventListener('click', function () { fsNoticeClose(true); });
  $('fsn-skip').addEventListener('click', function () { fsNoticeClose(false); });
  clickOutside($('fsnotice'), function (t) { return t === $('fsnotice'); }, function () { fsNoticeClose(null); });
  function syncFsUI() {
    const on = !!fsElement();
    $('fsbtn').classList.toggle('on', on);
    $('fsbtn').querySelector('.lbl').textContent = on ? 'Exit full screen' : Input.touch.active ? 'Full screen' : 'Full screen (F)';
    $('pause-fs').textContent = on ? 'Exit full screen' : 'Full screen';
    $('fsbtn').querySelector('button').setAttribute('aria-label', on ? 'Exit full screen (F)' : 'Full screen (F)');
  }
  document.addEventListener('fullscreenchange', syncFsUI);
  document.addEventListener('webkitfullscreenchange', syncFsUI);
  /* Show the real sound state everywhere it appears. */
  function syncSoundUI() {
    const muted = !!GameAudio.vol.muted;
    $('soundbtn').classList.toggle('muted', muted);
    $('soundbtn').querySelector('button').setAttribute('aria-pressed', muted ? 'true' : 'false');
    $('soundbtn').querySelector('.lbl').textContent = (muted ? 'Sound off' : 'Sound on') + (Input.touch.active ? '' : ' (M)');
    if ($('set-mute')) $('set-mute').checked = muted;
  }
  function toggleSound() {
    const muted = GameAudio.toggleMute();
    syncSoundUI();
    toast(muted && !Input.touch.active ? 'Sound off (M to turn it back on)' : muted ? 'Sound off' : 'Sound on');
  }
  let toastT = null;
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('high', mode !== 'menu' && !!game && game.kind !== 'attract');   // above the dashboard while driving
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.classList.remove('show'); }, ms || 2600);
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function teamColor(t) { return F1.teamUiColor(t); }

  function startAttract(forceMid) {
    // the race behind the menus: on the track you have just raced (it is ready, so no wait), otherwise a random one
    const ids = Object.keys(F1.TRACK_DEFS);
    const was = game && game.T && F1.TRACK_DEFS[game.T.id] ? game.T.id : null;
    const id = was || ids[Math.floor(Math.random() * ids.length)];
    game = new window.LocalGame({ attract: true, type: 'practice', track: id, aiCount: 12, aiLevel: 'hard', collisions: true });
    keepTracks(id);
    // about half the time the race is already under way (somewhere mid-race, cars fighting for places); otherwise it
    // starts from the grid. Either way the camera follows a car in the thick of it.
    const mid = typeof forceMid === 'boolean' ? forceMid : Math.random() < 0.5;
    if (mid) { game.placeMidRace(); for (let i = 0; i < 150; i++) game.step(true); game.fx.length = 0; }    // (2.5 s to settle)
    game.pickAttractCar(!mid);
    R.resetEffects();
  }
  /* Only the tracks in use stay built in memory: the one on screen and the one before it (your statistics and best
     laps are saved separately). Going back to another track builds it again. */
  let tracksInUse = [];
  function keepTracks(id) {
    tracksInUse = [id].concat(tracksInUse.filter(function (t) { return t !== id; })).slice(0, 2);
    F1.forgetTracks(tracksInUse);
    R.keepTracks(tracksInUse);
  }

  // ---- getting a track ready
  /* Pressing Start: the first time a track is used, its shapes have to be built, which takes a moment (longer on a
     phone). A card with the track shows meanwhile instead of a frozen screen. A track that is ready already (a
     restart, the next session of a weekend) starts at once. go() starts the session. */
  const LC = { on: false, ready: false, tok: 0, at: 0, frames: 0, t: null };
  function withTrack(id, go) {
    const tok = ++LC.tok;
    if (!F1.TRACK_DEFS[id] || (F1.trackBuilt(id) && R.hasTrack(id))) { if (LC.on) hideLoadCard(true); go(); return; }
    const T0 = F1.trackOutline(id);
    $('lc-name').textContent = T0.name;
    $('lc-sub').textContent = T0.country + ' · ' + (T0.length / 1000).toFixed(3) + ' km';
    $('lc-fill').style.width = '12%';
    clearTimeout(LC.t);
    $('loadcard').classList.remove('hidden', 'gone');
    LC.on = true; LC.ready = false; LC.at = performance.now(); LC.frames = 0;
    Renderer.trackPreview($('lc-map'), T0);
    // one piece of work at a time, each after the card has been put on the screen
    const later = function (fn) { requestAnimationFrame(function () { setTimeout(function () { if (tok === LC.tok) fn(); }, 0); }); };
    later(function () {
      const T = F1.getTrack(id);              // the track itself: its shape, racing line and run-off
      $('lc-fill').style.width = '55%';
      later(function () {
        R.prep(T);                            // what is drawn: grass, gravel, kerbs, trees and buildings, the pit lane
        graphicsChip();                       // (and, the first time, whether the browser draws with the graphics chip)
        $('lc-fill').style.width = '100%';
        later(function () { LC.ready = true; go(); });
      });
    });
  }
  /* The card goes once the session's first picture is on the screen (and has been up long enough to read). */
  function loadCardFrame(now) {
    if (!LC.on || !LC.ready || LC.t) return;
    if (++LC.frames >= 2 && now - LC.at >= 350) hideLoadCard(false);
  }
  function hideLoadCard(now) {
    clearTimeout(LC.t); LC.t = null;
    if (now) { LC.on = false; $('loadcard').classList.add('hidden'); return; }
    $('loadcard').classList.add('gone');
    LC.t = setTimeout(function () { LC.t = null; LC.on = false; $('loadcard').classList.add('hidden'); }, 200);
  }
  function cancelLoading() { LC.tok++; onlineLoading = null; if (LC.on) hideLoadCard(true); }
  /* The Rejoin season button (home screen) and the season box (online screen), when you host a season. */
  function updateSeasonButtons() {
    const sv = OnlineSeason.load(), fr = sv ? null : FriendSeason.load();
    $('home-rejoin').classList.toggle('hidden', !sv && !fr);
    $('online-season').classList.toggle('hidden', !sv && !fr);
    if (sv) {
      const n = sv.season.rounds.length, of = sv.season.calendar.length, next = F1.TRACK_DEFS[sv.season.calendar[n]];
      $('home-rejoin-sub').textContent = 'Round ' + (n + 1) + ' of ' + of + (next ? ' · ' + next.name : '') + ' · room ' + sv.code;
      $('os-title').textContent = 'Your online championship';
      $('os-sub').textContent = (n ? n + ' of ' + of + ' races done' : 'Not started yet') + (next ? ' · next: ' + next.name : '') + ' · room ' + sv.code;
      $('os-end').textContent = 'End season';
    } else if (fr) {
      // a friend's season you are racing in
      const who = fr.host ? fr.host + "'s season" : 'Online season';
      $('home-rejoin-sub').textContent = who + (fr.of ? ' · round ' + Math.min(fr.of, (fr.played || 0) + 1) + ' of ' + fr.of : '') + ' · room ' + fr.code;
      $('os-title').textContent = fr.host ? fr.host + "'s championship" : 'Online championship';
      $('os-sub').textContent = 'You are racing in this season' + (fr.of ? ' · ' + (fr.played || 0) + ' of ' + fr.of + ' races done' : '') + ' · room ' + fr.code;
      $('os-end').textContent = 'Remove';
    }
  }
  function goHome() {
    PlayTime.flush();
    cancelLoading();
    lobbyNoticeShown = false;
    $('fsnotice').classList.add('hidden');
    $('busy').classList.add('hidden');
    $('confirm').classList.add('hidden');
    $('hostaway').classList.add('hidden');
    $('msgmenu').classList.add('hidden');
    $('msgpop').innerHTML = '';
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
    smoothTip();
  }

  // ------------------------------------------------------------- shared widgets
  // (the cards show each track's outline only: the whole track is built when a session starts)
  // surprise: a "Surprise me" card first (id 'random')
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

  // ------------------------------------------------------------- the track and driver pickers
  /* The setup pages show the track (or a championship's calendar) and your driver as one card each; choosing opens a
     picker over the page: every track, in two groups (the 2026 calendar, then the classic tracks) with filters, or
     every driver. A calendar is picked in the same picker: several tracks, in race order. */
  const Picker = {
    onClose: null,
    open: function (title, wide) {
      $('picker-title').textContent = title;
      $('picker-body').innerHTML = ''; $('picker-chips').innerHTML = ''; $('picker-foot').innerHTML = '';
      $('picker-chips').classList.add('hidden'); $('picker-foot').classList.add('hidden');
      $('picker').querySelector('.picker-box').classList.toggle('drivers-mode', !wide);
      $('picker').classList.remove('hidden');
      $('picker-body').scrollTop = 0;
      setTimeout(function () { $('picker-x').focus({ preventScroll: true }); }, 30);
    },
    close: function () {
      if ($('picker').classList.contains('hidden')) return;
      $('picker').classList.add('hidden');
      const f = this.onClose; this.onClose = null;
      if (f) f();
    },
    isOpen: function () { return !$('picker').classList.contains('hidden'); }
  };
  $('picker-x').addEventListener('click', function () { Picker.close(); });
  $('picker').addEventListener('click', function (e) { if (e.target === this) Picker.close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && Picker.isOpen()) { e.stopPropagation(); Picker.close(); } }, true);

  /* A track's card: its picture, name, length and country, and your best lap there (time trial: your best time trial
     lap, or if you have none there yet, your best lap from your other sessions). */
  function trackCard(id, tt) {
    const T = F1.trackOutline(id), b = el('button', 'track-card'), cv = el('canvas');
    b.type = 'button';
    let line, none = false, title = '';
    const pb = window.PB.get(id);
    if (tt) {
      const l = window.TTBoard.list(id);
      line = l.length ? 'Best ' + F1.fmtLap(l[0].t) : pb ? 'PB ' + F1.fmtLap(pb.t) : 'No time yet';
      none = !l.length && !pb;
      if (!l.length && pb) title = 'Your best lap here in a practice, qualifying or race (no time trial lap yet)';
    } else { line = pb ? 'PB ' + F1.fmtLap(pb.t) : 'No personal best yet'; none = !pb; }
    const tp = el('div', 'tpb' + (none ? ' none' : ''), line);
    if (title) tp.title = title;
    b.append(cv, el('div', 'tname', T.name), el('div', 'tlen', (T.length / 1000).toFixed(3) + ' km · ' + T.country), tp);
    if (T.night) b.appendChild(el('span', 'night-badge', 'Night'));
    b.dataset.id = id;
    requestAnimationFrame(function () { Renderer.trackPreview(cv, T); });
    return b;
  }
  function surpriseCard() {
    const b = el('button', 'track-card surprise');
    b.type = 'button';
    b.append(el('div', 'q', '?'), el('div', 'tname', 'Surprise me'), el('div', 'tlen', 'A random track'), el('div', 'tpb none', 'Revealed when you start'));
    b.dataset.id = 'random';
    return b;
  }
  /* o: { selected, surprise, tt, onPick(id) } for one track; { calendar: [ids], onChange() } for a calendar */
  function openTrackPicker(o) {
    const multi = !!o.calendar, ids = Object.keys(F1.TRACK_DEFS);
    const classic = function (id) { return !!F1.TRACK_DEFS[id].classic; };
    const timed = function (id) { return o.tt ? window.TTBoard.list(id).length > 0 || !!window.PB.get(id) : !!window.PB.get(id); };
    let filter = 'all';
    Picker.open(multi ? 'Choose your calendar' : 'Choose a track', true);
    const chips = $('picker-chips'), body = $('picker-body'), foot = $('picker-foot');
    chips.classList.remove('hidden');
    [['all', 'All'], ['calendar', '2026 calendar'], ['classic', 'Classic tracks'], ['night', 'Night races'], ['notime', 'No time yet']].forEach(function (c) {
      const b = el('button', 'chip' + (c[0] === filter ? ' on' : ''), c[1]);
      b.type = 'button';
      b.addEventListener('click', function () { filter = c[0]; chips.querySelectorAll('.chip').forEach(function (x) { x.classList.toggle('on', x === b); }); draw(); });
      chips.appendChild(b);
    });
    const mark = function () {
      if (!multi) return;
      body.querySelectorAll('.track-card').forEach(function (b) {
        const k = o.calendar.indexOf(b.dataset.id);
        b.classList.toggle('on', k >= 0);
        const old = b.querySelector('.round-badge'); if (old) old.remove();
        if (k >= 0) b.appendChild(el('span', 'round-badge', String(k + 1)));
      });
      const n = o.calendar.length;
      $('picker-n').textContent = n ? n + (n === 1 ? ' race' : ' races') : 'Click the tracks in the order you want to race them';
      $('picker-done').disabled = n < 2;
      $('picker-done').textContent = n < 2 ? 'Pick at least 2' : 'Done';
    };
    const draw = function () {
      body.innerHTML = '';
      let groups;
      if (filter === 'calendar') groups = [['2026 calendar', ids.filter(function (id) { return !classic(id); })]];
      else if (filter === 'classic') groups = [['Classic tracks', ids.filter(classic)]];
      else if (filter === 'night') groups = [['Night races', ids.filter(function (id) { return F1.TRACK_DEFS[id].night; })]];
      else if (filter === 'notime') groups = [[o.tt ? 'No time trial lap yet' : 'No personal best yet', ids.filter(function (id) { return !timed(id); })]];
      // (all: Bahrain 2 next to Bahrain 1)
      else groups = [['2026 calendar', ids.filter(function (id) { return !classic(id) || id === 'bahrainouter'; })], ['Classic tracks', ids.filter(function (id) { return classic(id) && id !== 'bahrainouter'; })]];
      groups.forEach(function (g, gi) {
        body.appendChild(el('div', 'pk-head', g[0]));
        const grid = el('div', 'pk-grid');
        if (gi === 0 && filter === 'all' && o.surprise) grid.appendChild(surpriseCard());
        g[1].forEach(function (id) { grid.appendChild(trackCard(id, o.tt)); });
        if (!g[1].length) grid.appendChild(el('div', 'pk-empty', 'None'));
        body.appendChild(grid);
      });
      body.querySelectorAll('.track-card').forEach(function (b) {
        const id = b.dataset.id;
        if (!multi && id === o.selected) b.classList.add('on');
        b.addEventListener('click', function () {
          if (!multi) { Picker.close(); o.onPick(id); return; }
          const k = o.calendar.indexOf(id);
          if (k >= 0) o.calendar.splice(k, 1); else o.calendar.push(id);
          mark(); o.onChange();
        });
      });
      mark();
    };
    if (multi) {
      foot.classList.remove('hidden');
      const n = el('span', 'pk-n'); n.id = 'picker-n';
      const all = el('button', 'btn small', '2026 calendar'); all.type = 'button'; all.title = 'Every track of the 2026 calendar, in order';
      const none = el('button', 'btn small ghost', 'Clear'); none.type = 'button';
      const done = el('button', 'btn red', 'Done'); done.type = 'button'; done.id = 'picker-done';
      all.addEventListener('click', function () { o.calendar.length = 0; Array.prototype.push.apply(o.calendar, F1.calendarTracks()); mark(); o.onChange(); });
      none.addEventListener('click', function () { o.calendar.length = 0; mark(); o.onChange(); });
      done.addEventListener('click', function () { Picker.close(); });
      foot.append(n, all, none, done);
    }
    draw();
  }
  function openDriverPicker(o) {
    Picker.open(o.title || 'Choose your driver', false);
    const box = el('div', 'drivers');
    $('picker-body').appendChild(box);
    buildDrivers(box, { selected: o.selected, takenBy: o.takenBy, onPick: function (id) { Picker.close(); o.onPick(id); } });
  }
  /* The card of the chosen track on a setup page (or none yet: then the card asks you to choose one). */
  function showTrackPick(pre, id, o) {
    const box = $(pre + '-trackpick');
    box.innerHTML = '';
    box.classList.toggle('empty', !id);
    const info = el('div', 'pinfo');
    let art;
    if (!id) {
      art = el('div', 'pq plus', '+');
      info.append(el('b', null, 'No track chosen'), el('span', null, 'Pick from ' + Object.keys(F1.TRACK_DEFS).length + ' circuits'));
    } else if (id === 'random') {
      art = el('div', 'pq', '?');
      info.append(el('b', null, 'Surprise me'), el('span', null, 'A random track, revealed when you start'));
    } else {
      const T = F1.trackOutline(id), pb = window.PB.get(id);
      art = el('canvas', 'pmap');
      info.append(el('b', null, T.name), el('span', null, (T.length / 1000).toFixed(3) + ' km · ' + T.country + (T.night ? ' · night' : '')));
      if (pre === 'tt') {
        const l = window.TTBoard.list(id);
        if (l.length) info.appendChild(el('span', 'pbl', 'Best ' + F1.fmtLap(l[0].t)));
        else if (pb) info.appendChild(el('span', 'pbl', 'PB ' + F1.fmtLap(pb.t)));
      } else if (pb) info.appendChild(el('span', 'pbl', 'PB ' + F1.fmtLap(pb.t)));
      requestAnimationFrame(function () { Renderer.trackPreview(art, T); });
    }
    const btn = el('button', 'btn small' + (id ? '' : ' red'), id ? 'Change' : 'Choose');
    btn.type = 'button';
    box.append(art, info, btn);
    box.onclick = function () { openTrackPicker(o); };
    box.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTrackPicker(o); } };
    // the small Surprise me button next to the box's title: lit while a surprise track is chosen
    const sb = document.querySelector('[data-surprise="' + pre + '"]');
    if (sb) { sb.classList.toggle('on', id === 'random'); sb.setAttribute('aria-pressed', id === 'random' ? 'true' : 'false'); }
  }
  /* Surprise me without opening the track list: the small button in the Track box (Practice, Time trial, Grand Prix). */
  document.querySelectorAll('[data-surprise]').forEach(function (b) {
    b.addEventListener('click', function () {
      const o = { practice: practicePickTrack, tt: ttPickTrack, gp: gpPickTrack }[b.dataset.surprise]();
      o.onPick('random');
    });
  });
  /* A championship's calendar on its setup page: how many races and the tracks in order. */
  function showCalendarPick(cal, o) {
    const box = $('champ-trackpick');
    box.innerHTML = '';
    box.classList.toggle('empty', !cal.length);
    const info = el('div', 'pinfo');
    if (!cal.length) info.append(el('b', null, 'No calendar yet'), el('span', null, 'Choose 2 or more tracks, in the order you want to race them'));
    else {
      info.appendChild(el('b', null, cal.length + (cal.length === 1 ? ' race' : ' races')));
      const list = el('div', 'cal-list'), shown = cal.length > 6 ? 5 : cal.length;
      cal.slice(0, shown).forEach(function (id, i) { list.appendChild(el('span', 'cal-item', (i + 1) + ' ' + (F1.TRACK_DEFS[id].short || F1.TRACK_DEFS[id].name))); });
      if (cal.length > shown) list.appendChild(el('span', 'cal-item more', '+' + (cal.length - shown) + ' more'));
      info.appendChild(list);
    }
    const btn = el('button', 'btn small' + (cal.length ? '' : ' red'), cal.length ? 'Change' : 'Choose');
    btn.type = 'button';
    box.append(el('div', 'pq cal', String(cal.length || '+')), info, btn);
    box.onclick = function () { openTrackPicker(o); };
    box.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTrackPicker(o); } };
  }
  /* The card of your driver (or your car, in a time trial): the car, number, name and team. */
  function showDriverPick(pre, driverId, onPick, title) {
    const box = $(pre + '-driverpick'), d = F1.driver(driverId) || F1.DRIVERS[0], team = F1.team(d.team);
    box.innerHTML = '';
    box.style.setProperty('--team', teamColor(team));
    const cv = el('canvas', 'pcar'), info = el('div', 'pinfo'), top = el('span', 'dteam');
    top.append(el('span', 'num', '#' + d.number), document.createTextNode(team.name));
    info.append(top, el('b', null, d.name));
    const btn = el('button', 'btn small', 'Change');
    btn.type = 'button';
    box.append(cv, info, btn);
    requestAnimationFrame(function () { Renderer.carPreview(cv, team); });
    const open = function () { openDriverPicker({ title: title, selected: d.id, onPick: function (id) { onPick(id); showDriverPick(pre, id, onPick, title); } }); };
    box.onclick = open;
    box.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  }
  /* The Start button of a setup page (and its copy in the bar at the bottom on narrow screens): until a track is chosen
     it says so, and opens the picker. */
  function setStart(pre, ready, label, choose) {
    [$(pre + '-start'), document.querySelector('[data-start="' + pre + '-start"]')].forEach(function (b) {
      if (!b) return;
      b.textContent = ready ? label : choose;
      b.classList.toggle('choose', !ready);
    });
  }
  document.querySelectorAll('[data-start]').forEach(function (b) { b.addEventListener('click', function () { $(b.dataset.start).click(); }); });

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
  /* (each setup page opens with no track chosen: you pick one) */
  function practicePickTrack() {
    const o = { selected: practiceOpts.track, surprise: true, onPick: function (id) { practiceOpts.track = id; practiceTrackShown(); } };
    return o;
  }
  function practiceTrackShown() {
    showTrackPick('practice', practiceOpts.track, practicePickTrack());
    setStart('practice', !!practiceOpts.track, 'Start practice', 'Choose a track');
  }
  function openPractice() {
    practiceOpts.track = null;
    practiceTrackShown();
    showDriverPick('practice', practiceOpts.driverId, function (id) { practiceOpts.driverId = id; });
    $('practice-ai').value = practiceOpts.aiCount;
    $('practice-ai-val').textContent = practiceOpts.aiCount;
    $('practice-ai').oninput = function () { practiceOpts.aiCount = Number(this.value); $('practice-ai-val').textContent = this.value; };
    segInit($('practice-level'), practiceOpts.aiLevel, function (v) { practiceOpts.aiLevel = v; });
    $('practice-coll').checked = practiceOpts.collisions;
    $('practice-coll').onchange = function () { practiceOpts.collisions = this.checked; };
    condInit('practice', practiceOpts);
    show('practice');
  }
  /* "Surprise me": a random track, not the same one twice in a row. The pick is shown when the session starts. */
  let lastSurprise = null;
  function surpriseTrack() {
    const ids = Object.keys(F1.TRACK_DEFS).filter(function (id) { return id !== lastSurprise; });
    lastSurprise = ids[Math.floor(Math.random() * ids.length)];
    return lastSurprise;
  }
  function revealTrack(id, lead) {
    const d = F1.TRACK_DEFS[id];
    toast('Surprise! ' + lead + ' ' + d.name + (d.country !== d.name ? ' (' + d.country + ')' : ''), 4500);
  }
  let practiceTrack = null;      // the track of the practice session on now (a restart keeps a surprise pick)
  function startPractice(again) {
    Settings.data.practice = Object.assign({}, practiceOpts);
    Settings.save();
    const surprise = practiceOpts.track === 'random';
    if (!again || !practiceTrack) practiceTrack = surprise ? surpriseTrack() : practiceOpts.track;
    withTrack(practiceTrack, function () {
      mode = 'practice';
      game = new window.LocalGame(Object.assign({ type: 'practice' }, practiceOpts, { track: practiceTrack }));
      keepTracks(practiceTrack);
      R.resetEffects();
      GameAudio.newSession();
      show(null);
      if (surprise && !again) revealTrack(practiceTrack, 'Today you practise at');
    });
  }
  $('practice-start').addEventListener('click', function () {
    if (!practiceOpts.track) { openTrackPicker(practicePickTrack()); return; }
    fsGate(startPractice);
  });

  // ------------------------------------------------------------- time trial
  const ttOpts = Object.assign({ track: 'monza', driverId: 'NOR' }, Settings.data.tt || {});
  if (!trackOk(ttOpts.track)) ttOpts.track = 'monza';
  function showTTBoard(track) {
    const body = $('tt-board');
    body.innerHTML = '';
    if (!track) {
      $('tt-board-title').textContent = 'Your best laps';
      const tr = el('tr'), td = el('td', 'empty', 'Choose a track to see your best laps on it');
      td.colSpan = 5; tr.appendChild(td); body.appendChild(tr);
      return;
    }
    if (track === 'random') {
      $('tt-board-title').textContent = 'Your best laps — Surprise me';
      const tr = el('tr'), td = el('td', 'empty', 'A random track: you find out which one when you start');
      td.colSpan = 5; tr.appendChild(td); body.appendChild(tr);
      return;
    }
    const list = window.TTBoard.list(track);
    $('tt-board-title').textContent = 'Your best laps — ' + F1.TRACK_DEFS[track].name;
    if (!list.length) {
      const pb = window.PB.get(track);
      const tr = el('tr'), td = el('td', 'empty', pb ? 'No time trial laps yet — your best lap here in other sessions is ' + F1.fmtLap(pb.t) : 'No laps yet — set the first time on this track');
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
  // (the track cards in the picker show your best time trial lap on each track, or if you have none there yet, your best
  // lap there in any other session: see trackCard)
  function ttPickTrack() { return { selected: ttOpts.track, surprise: true, tt: true, onPick: function (id) { ttOpts.track = id; ttTrackShown(); } }; }
  function ttTrackShown() {
    showTrackPick('tt', ttOpts.track, ttPickTrack());
    showTTBoard(ttOpts.track);
    setStart('tt', !!ttOpts.track, 'Start time trial', 'Choose a track');
  }
  function openTT(keep) {
    if (!keep) ttOpts.track = null;     // (quitting a time trial comes back here with its track still chosen)
    ttTrackShown();
    showDriverPick('tt', ttOpts.driverId, function (id) { ttOpts.driverId = id; }, 'Choose your car');
    show('tt');
  }
  let ttTrack = null;             // the track of the time trial on now (a restart keeps a surprise pick)
  function startTT(again) {
    Settings.data.tt = Object.assign({}, ttOpts);
    Settings.save();
    const surprise = ttOpts.track === 'random';
    if (!again || !ttTrack) ttTrack = surprise ? surpriseTrack() : ttOpts.track;
    withTrack(ttTrack, function () {
      mode = 'tt';
      game = new window.LocalGame({ type: 'practice', tt: true, track: ttTrack, driverId: ttOpts.driverId, aiCount: 0, title: 'TIME TRIAL' });
      keepTracks(ttTrack);
      R.resetEffects();
      GameAudio.newSession();
      show(null);
      if (surprise && !again) revealTrack(ttTrack, 'Your time trial is at');
    });
  }
  $('tt-start').addEventListener('click', function () {
    if (!ttOpts.track) { openTrackPicker(ttPickTrack()); return; }
    fsGate(startTT);
  });

  // ------------------------------------------------------------- grand prix
  const MAX_RACE_LAPS = 20;
  /* The Reverse grid switch of a weekend bar (needs qualifying: greyed out with a random grid). */
  function reverseInit(prefix, opts) {
    const sel = $(prefix + '-reverse'), q = $(prefix + '-quali');
    const sync = function () {
      sel.disabled = !(opts.qualiLaps > 0);
      sel.value = opts.reverseGrid && opts.qualiLaps > 0 ? '1' : '0';
    };
    sel.onchange = function () { opts.reverseGrid = this.value === '1'; };
    q.onchange = function () { opts.qualiLaps = Number(this.value); sync(); };
    sync();
  }
  function lapOptions(sel, min, max, value, noneLabel) {
    const opts = [];
    if (noneLabel) opts.push([0, noneLabel]);
    for (let i = min; i <= max; i++) opts.push([i, i + (i === 1 ? ' lap' : ' laps')]);
    fillSelect(sel, opts, value);
  }
  function gpPickTrack() { return { selected: gpOpts.track, surprise: true, onPick: function (id) { gpOpts.track = id; gpTrackShown(); } }; }
  function gpTrackShown() {
    showTrackPick('gp', gpOpts.track, gpPickTrack());
    setStart('gp', !!gpOpts.track, 'Start weekend', 'Choose a track');
  }
  function openGp() {
    gpOpts.track = null;
    gpTrackShown();
    showDriverPick('gp', gpOpts.driverId, function (id) { gpOpts.driverId = id; });
    $('gp-ai').value = gpOpts.aiCount;
    $('gp-ai-val').textContent = gpOpts.aiCount;
    $('gp-ai').oninput = function () { gpOpts.aiCount = Number(this.value); $('gp-ai-val').textContent = this.value; };
    segInit($('gp-level'), gpOpts.aiLevel, function (v) { gpOpts.aiLevel = v; });
    ['p1', 'p2', 'p3'].forEach(function (k) {
      lapOptions($('gp-' + k), 1, 3, gpOpts[k], 'Skip');
      $('gp-' + k).onchange = function () { gpOpts[k] = Number(this.value); };
    });
    lapOptions($('gp-quali'), 1, 5, gpOpts.qualiLaps, 'None (random grid)');
    lapOptions($('gp-race'), 1, MAX_RACE_LAPS, gpOpts.raceLaps);
    reverseInit('gp', gpOpts);
    condInit('gp', gpOpts);
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
    const opts = Object.assign({}, gpOpts);
    if (opts.track === 'random') { opts.track = surpriseTrack(); opts.surprise = true; }   // the same track all weekend
    newWeekend(opts, shuffled(pool).slice(0, gpOpts.aiCount), null);
  }
  function newWeekend(opts, aiDrivers, champ) {
    gp = { opts: opts, aiDrivers: aiDrivers, grid: null, stages: [], idx: 0, champ: champ, recorded: false };
    ['p1', 'p2', 'p3'].forEach(function (k) { if (opts[k] > 0) gp.stages.push(k); });
    if (opts.qualiLaps > 0) gp.stages.push('quali');
    gp.stages.push('race');
    startGpStage(0);
  }
  function startGpStage(i) { withTrack(gp.opts.track, function () { gpStage(i); }); }
  function gpStage(i) {
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
      // race conditions (a championship started before version 10 has none: it carries on as it was)
      drafting: gp.champ ? o.drafting === true : o.drafting !== false, tyres: gp.champ ? o.tyres === true : o.tyres !== false,
      weather: gp.champ ? o.weather === true : o.weather !== false,
      laps: type === 'race' ? o.raceLaps : type === 'quali' ? o.qualiLaps : o[stage],
      title: round ? 'R' + round + ' ' + STAGE_NAME[stage].toUpperCase() : type === 'practice' ? STAGE_NAME[stage].toUpperCase() : null,
      onEnd: function (results, g) {
        if (mode !== 'gp' || game.S.results !== results) return;
        const rev = type === 'quali' && !!o.reverseGrid;
        // career: races, wins, podiums, fastest laps and pole positions
        const own = results.find(function (r) { return !r.isAI; });
        if (own && type === 'race') Career.race({ track: o.track, pos: own.pos, out: !!own.out, fl: !!own.fl, pts: own.pts || 0, laps: own.laps || 0, online: false,
          grid: own.grid, ovt: own.ovt || 0, cars: results.length, rain: !!(g && g.rainSeen), level: o.aiLevel, full: gp.stages.length === 5 });
        if (own && type === 'quali' && own.pos === 1 && own.best !== null && !own.out) Career.pole();
        if (type === 'quali') gp.grid = rev ? F1.reverseGrid(results) : results.map(function (r) { return r.driverId; });
        if (type === 'race' && gp.champ && !gp.recorded) recordRound(gp.champ, o.track, results);
        showResults({ type: type, stage: stage, track: o.track, results: results, round: round, stats: g && g.S.stats, grid: rev ? gp.grid : null }, gp.champ ? 'champ' : 'gp');
      }
    });
    keepTracks(o.track);
    R.resetEffects();
    GameAudio.newSession();
    show(null);
    if (o.surprise && !gp.revealed) { gp.revealed = true; revealTrack(o.track, 'This weekend you race at'); }
  }
  $('gp-start').addEventListener('click', function () {
    if (!gpOpts.track) { openTrackPicker(gpPickTrack()); return; }
    fsGate(startGp);
  });
  $('results-next').addEventListener('click', function () { if (gp && gp.idx + 1 < gp.stages.length) startGpStage(gp.idx + 1); });
  $('results-again').addEventListener('click', function () { if (gp) startGpStage(gp.stages.length - 1); });   // same grid
  $('podium-next').addEventListener('click', function () { if (window.GameAudio) window.GameAudio.click('tap'); leavePodium(); });
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

  /* The calendar: picked in the track picker, several tracks in race order (the 2026 calendar in one click). */
  function champCalendarShown() {
    const o = { calendar: champOpts.calendar, onChange: champCalendarShown };
    showCalendarPick(champOpts.calendar, o);
    const n = champOpts.calendar.length;
    setStart('champ', n >= 2, 'Start season (' + n + ' races)', n ? 'Pick at least 2 tracks' : 'Choose the tracks');
  }
  function openChamp() {
    champOpts.calendar.length = 0;
    champCalendarShown();
    showDriverPick('champ', champOpts.driverId, function (id) { champOpts.driverId = id; });
    $('champ-ai').value = champOpts.aiCount; $('champ-ai-val').textContent = champOpts.aiCount;
    $('champ-ai').oninput = function () { champOpts.aiCount = Number(this.value); $('champ-ai-val').textContent = this.value; };
    segInit($('champ-level'), champOpts.aiLevel, function (v) { champOpts.aiLevel = v; });
    ['p1', 'p2', 'p3'].forEach(function (k) {
      lapOptions($('champ-' + k), 1, 3, champOpts[k], 'Skip');
      $('champ-' + k).onchange = function () { champOpts[k] = Number(this.value); };
    });
    lapOptions($('champ-quali'), 1, 5, champOpts.qualiLaps, 'None (random grid)');
    lapOptions($('champ-race'), 1, MAX_RACE_LAPS, champOpts.raceLaps);
    reverseInit('champ', champOpts);
    condInit('champ', champOpts);
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
        const next = F1.TRACK_DEFS[c.calendar[c.rounds.length]].name;
        $('cc-title').textContent = 'Season in progress: round ' + (c.rounds.length + 1) + ' of ' + c.calendar.length + ' — ' + next;
        $('cc-sub').textContent = (c.rounds.length ? 'You are P' + (me + 1) + ' with ' + st.drivers[me].pts + ' points. ' : '') + 'Starting a new season replaces it.';
        $('cc-go').style.display = '';
      }
    }
    show('champ');
  }
  function startSeason() {
    if (champOpts.calendar.length < 2) { openTrackPicker({ calendar: champOpts.calendar, onChange: champCalendarShown }); return; }
    Settings.data.champ = JSON.parse(JSON.stringify(champOpts));
    Settings.save();
    const pool = F1.DRIVERS.map(function (d) { return d.id; }).filter(function (id) { return id !== champOpts.driverId; });
    const o = champOpts;
    const c = { v: 1, opts: { driverId: o.driverId, aiCount: o.aiCount, aiLevel: o.aiLevel, p1: o.p1, p2: o.p2, p3: o.p3, qualiLaps: o.qualiLaps, raceLaps: o.raceLaps,
      reverseGrid: !!o.reverseGrid && o.qualiLaps > 0, drafting: o.drafting !== false, tyres: o.tyres !== false, weather: o.weather !== false },
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
    if (c.done) Career.season(standings(c).drivers[0].id === c.opts.driverId, c.calendar.length);
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
  const CODES = { suzuka: 'JPN', jeddah: 'KSA', montreal: 'CAN', monaco: 'MON', redbullring: 'AUT', silverstone: 'GBR', spa: 'BEL', zandvoort: 'NED', monza: 'ITA',
    baku: 'AZE', singapore: 'SGP', interlagos: 'BRA', lasvegas: 'LVG', abudhabi: 'UAE',
    australia: 'AUS', china: 'CHN', bahrain: 'BHR', miami: 'MIA', barcelona: 'ESP',
    hungaroring: 'HUN', madring: 'MAD', sepang: 'MAS', austin: 'USA', mexico: 'MEX', lusail: 'QAT', portimao: 'POR', istanbul: 'TUR',
    imola: 'EMI', paulricard: 'FRA', sochi: 'RUS', mugello: 'TUS', nurburgring: 'EIF', hockenheim: 'GER', bahrainouter: 'SKH',
    magnycours: 'MAG', kyalami: 'RSA', jacarepagua: 'RIO', watkinsglen: 'WGL' };
  function renderStandings(o) {
    $('st-title').textContent = o.title;
    const banner = $('st-banner');
    banner.classList.toggle('hidden', !o.banner);
    if (o.banner) {
      banner.innerHTML = '';
      banner.append(document.createTextNode(o.banner.text));
      banner.appendChild(el('small', null, o.banner.small));
    }
    // a long season (more than 8 rounds): the drivers' table gets the full width, the constructors go underneath
    document.querySelector('#standings .standings-wrap').classList.toggle('many', o.calendar.length > 8);
    // drivers: a column per round (finishing position), then the total
    const head = $('st-drivers-head');
    head.innerHTML = '';
    const hr = el('tr');
    hr.append(el('th', null, 'Pos'), el('th', null, 'Driver'));
    o.calendar.forEach(function (id) { const th = el('th', 'rd', CODES[id] || id.slice(0, 3).toUpperCase()); th.title = F1.TRACK_DEFS[id].name; hr.appendChild(th); });
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
    // an online season: the room code, the invite link and the messages are at hand between rounds
    $('st-room').classList.toggle('hidden', !o.code);
    $('st-copy').classList.toggle('hidden', !o.code);
    $('st-msg').classList.toggle('hidden', !o.code);
    if (o.code) $('st-code').textContent = o.code;
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
    const myTeam = F1.teamOfDriver(myId).id, next = done ? null : F1.TRACK_DEFS[c.calendar[n]];
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
    const next = done ? null : F1.TRACK_DEFS[sv.calendar[n]];
    const hostP = room.players.find(function (p) { return p.id === room.hostId; });
    const stageList = ['p1', 'p2', 'p3'].filter(function (k) { return sv.opts[k] > 0; }).concat(sv.opts.qualiLaps > 0 ? ['quali'] : [], ['race']);
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
        : 'Waiting for ' + (hostP ? hostP.name : 'the host') + (sv.cur > 0 ? ' to carry on with round ' + (n + 1) : ' to start ' + (n ? 'round ' + (n + 1) : 'the first round')) + '…',
      // a round that was interrupted carries on with its next session (the season is saved after every session)
      next: !(isHost && next) ? null : sv.cur > 0 && stageList[sv.cur]
        ? 'Continue round ' + (n + 1) + ': ' + STAGE_NAME[stageList[sv.cur]] + ' at ' + next.name : 'Start round ' + (n + 1) + ': ' + next.name,
      newb: isHost && done ? 'Back to lobby' : null,
      menu: 'Leave room', car: car, code: room.code
    });
  }
  $('champ-start').addEventListener('click', function () { if (champOpts.calendar.length < 2) startSeason(); else fsGate(startSeason); });
  // Select all: every track, in calendar order; Clear all: none (then click the ones you want)

  $('cc-go').addEventListener('click', function () { const c = Champ.load(); if (c && !c.done) fsGate(function () { startRound(c); }); });
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
      else if (go === 'career') openCareer();
      else show(go);
    });
  });
  document.querySelectorAll('[data-act="settings"]').forEach(function (b) { b.addEventListener('click', openSettings); });
  const BACK_HOME = ['practice', 'tt', 'gp', 'champ', 'career', 'online'];
  clickOutside($('overlay'), function (t) {
    const a = document.querySelector('.screen.active');
    return t === $('overlay') && !!a && BACK_HOME.indexOf(a.id) >= 0;
  }, function () { show('home'); });

  // ------------------------------------------------------------- career
  /* Your records across every mode: totals (with your time played), and for each track your best lap, races, wins,
     best finish and time played; and your achievements, in a second tab. */
  let careerTab = 'stats';
  /* New achievements: earned since you last opened the Achievements tab. A badge on Career statistics (home screen) and
     a dot on the tab until then; the new ones carry a NEW tag while you look at them that time. */
  let achSeenShown = 0;               // (when they were last seen before this look: for the NEW tags)
  function achNewCount() {
    const got = window.Ach.got(), seen = window.Ach.seen();
    return Object.keys(got).filter(function (k) { return got[k] > seen; }).length;
  }
  function updateAchBadge() {
    const n = achNewCount(), b = $('career-badge');
    b.textContent = n + ' new';
    b.classList.toggle('hidden', !n);
    $('career-ach-dot').classList.toggle('hidden', !n);
  }
  function showCareerTab(t, focus) {
    if (t === 'ach' && (careerTab !== 'ach' || !$('career').classList.contains('active'))) {
      // looking at them now: the NEW tags stay for this look, the badge and the dot go
      achSeenShown = window.Ach.seen();
      window.Ach.markSeen();
      renderAchievements();
      updateAchBadge();
    }
    careerTab = t;
    document.querySelectorAll('#career-tabs button').forEach(function (b) {
      const on = b.dataset.v === t;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    $('career-page-stats').classList.toggle('hidden', t !== 'stats');
    $('career-page-ach').classList.toggle('hidden', t !== 'ach');
    const sc = $('career').querySelector('.career-wrap:not(.hidden)');
    if (sc) sc.scrollTop = 0;
  }
  document.querySelectorAll('#career-tabs button').forEach(function (b) {
    b.addEventListener('click', function () { showCareerTab(b.dataset.v); });
    b.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); showCareerTab(careerTab === 'stats' ? 'ach' : 'stats', true); }
    });
  });
  function openCareer(tab) {
    PlayTime.flush();
    const d = window.Career.load(), box = $('career-stats'), Ach = window.Ach;
    const got = Ach.got(), nGot = Ach.LIST.filter(function (a) { return got[a.id]; }).length;
    box.innerHTML = '';
    const tile = function (label, num, sub, gold, cls) {
      const c = el('div', 'stat-card' + (gold ? ' gold' : '') + (cls ? ' ' + cls : ''));
      const n = el('div', 'num', String(num));
      if (sub) n.appendChild(el('small', null, ' ' + sub));
      c.append(el('div', 'lbl', label), n);
      box.appendChild(c);
      return c;
    };
    const mins = Math.floor(d.time / 60);
    if (mins >= 60) tile('Time played', Math.floor(mins / 60), 'h ' + (mins % 60) + ' min', false, 'played');
    else tile('Time played', mins, 'min', false, 'played');
    tile('Races', d.races);
    tile('Wins', d.wins, null, d.wins > 0);
    tile('Podiums', d.podiums);
    tile('Pole positions', d.poles);
    tile('Fastest laps', d.fl);
    tile('Championships', d.titles, d.seasons ? 'of ' + d.seasons : null, d.titles > 0);
    tile('Achievements', nGot, 'of ' + Ach.LIST.length, false, 'ach-tile').addEventListener('click', function () { showCareerTab('ach'); });
    box.lastChild.title = 'See your achievements';
    const since = new Date(d.since).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    $('career-note').textContent = 'Total time played: ' + window.fmtPlayed(d.time) + ' · ' + (d.races
      ? d.points + (d.points === 1 ? ' point and ' : ' points and ') + d.laps + (d.laps === 1 ? ' racing lap so far' : ' racing laps so far') + (d.online.races ? ' · online: ' + d.online.races + (d.online.races === 1 ? ' race, ' : ' races, ') + d.online.wins + (d.online.wins === 1 ? ' win' : ' wins') : '') + ' · counting since ' + since + '.'
      : 'races, wins and championships are counted in every mode (Grand Prix, Championship and online).');
    const body = $('career-tracks');
    body.innerHTML = '';
    Object.keys(F1.TRACK_DEFS).forEach(function (id) {
      const T = F1.TRACK_DEFS[id], pb = window.PB.get(id), t = d.tracks[id];
      const tr = el('tr');
      tr.appendChild(el('td', 'drv', T.name));
      tr.appendChild(el('td', 'r' + (pb ? ' purple' : ' none'), pb ? F1.fmtLap(pb.t) : '—'));
      const car = el('td', pb && pb.d && F1.driver(pb.d) ? null : 'none');
      if (pb && pb.d && F1.driver(pb.d)) {
        const dr = F1.driver(pb.d), bar = el('span', 'bar');
        bar.style.background = teamColor(F1.team(dr.team));
        car.append(bar, document.createTextNode(F1.team(dr.team).name));
      } else car.textContent = '—';
      tr.appendChild(car);
      tr.appendChild(el('td', 'r' + (t && t.races ? '' : ' none'), t && t.races ? String(t.races) : '—'));
      tr.appendChild(el('td', 'r' + (t && t.wins ? '' : ' none'), t && t.wins ? String(t.wins) : '—'));
      tr.appendChild(el('td', 'r' + (t && t.podiums ? '' : ' none'), t && t.podiums ? String(t.podiums) : '—'));
      tr.appendChild(el('td', 'r' + (t && t.best ? (t.best === 1 ? ' best1' : '') : ' none'), t && t.best ? 'P' + t.best : '—'));
      tr.appendChild(el('td', 'r' + (t && t.time >= 60 ? '' : ' none'), t && t.time >= 60 ? window.fmtPlayed(t.time) : '—'));
      body.appendChild(tr);
    });
    renderAchievements(got);
    showCareerTab(tab || 'stats');
    show('career');
  }
  /* The Achievements tab: in groups, unlocked ones in gold; the counted ones still to come show how far you are. */
  const ICON_TROPHY = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 4h10v3.5A5 5 0 0 1 12 12.5 5 5 0 0 1 7 7.5V4z" fill="currentColor"/>' +
    '<path d="M7 5.5H4.5v1.2A3.3 3.3 0 0 0 7.6 10M17 5.5h2.5v1.2A3.3 3.3 0 0 1 16.4 10" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10.6 12.3h2.8l.5 3.7h-3.8z" fill="currentColor"/><rect x="7.5" y="16.6" width="9" height="3" rx="1" fill="currentColor"/></svg>';
  const ICON_LOCK = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2" fill="currentColor"/>' +
    '<path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>';
  /* "today", "yesterday", "3 days ago" (by the calendar), or the date */
  function earnedWhen(t) {
    const day = function (x) { const d = new Date(x); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const n = Math.round((day(Date.now()) - day(t)) / 86400000);
    return n <= 0 ? 'today' : n === 1 ? 'yesterday' : n < 7 ? n + ' days ago' : new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  /* The Achievements tab: the ones earned in the last week first (newest first, NEW until you have seen them), then
     the rest in their groups; every earned one says when; the counted ones still to come show how far you are. */
  function renderAchievements(got) {
    const Ach = window.Ach, st = Ach.stats(), wrap = $('ach-groups');
    got = got || Ach.got();
    const n = Ach.LIST.filter(function (a) { return got[a.id]; }).length, now = Date.now();
    $('ach-count').textContent = n + ' of ' + Ach.LIST.length + ' unlocked';
    $('ach-total-bar').style.width = (100 * n / Ach.LIST.length).toFixed(1) + '%';
    $('career-ach-n').textContent = n + '/' + Ach.LIST.length;
    wrap.innerHTML = '';
    const card = function (a) {
      const on = !!got[a.id], c = el('div', 'ach' + (on ? ' on' : ''));
      const ico = el('span', 'ach-ico');
      ico.innerHTML = on ? ICON_TROPHY : ICON_LOCK;
      const txt = el('div', 'ach-txt');
      txt.append(el('b', null, a.name), el('span', null, Ach.desc(a)));
      c.append(ico, txt);
      const goal = Ach.goal(a);
      if (on) {
        c.appendChild(el('span', 'ach-when', 'Earned ' + earnedWhen(got[a.id])));
        if (got[a.id] > achSeenShown) { c.classList.add('is-new'); c.appendChild(el('span', 'ach-new', 'NEW')); }
      } else if (a.v && goal > 1) {
        const v = Math.min(goal, Math.floor(a.v(st))), bar = el('div', 'ach-bar'), fill = el('i');
        fill.style.width = (100 * v / goal).toFixed(1) + '%';
        bar.appendChild(fill);
        c.append(bar, el('span', 'ach-prog', v.toLocaleString() + ' / ' + goal.toLocaleString() + (a.unit ? ' ' + a.unit : '')));
      }
      return c;
    };
    // earned in the last 7 days: at the top, newest first (not in their groups then)
    const recent = Ach.LIST.filter(function (a) { return got[a.id] && now - got[a.id] < 7 * 86400000; })
      .sort(function (x, y) { return got[y.id] - got[x.id]; });
    const top = {};
    if (recent.length) {
      const grid = el('div', 'ach-grid ach-recent');
      recent.forEach(function (a) { top[a.id] = true; grid.appendChild(card(a)); });
      wrap.appendChild(grid);
    }
    let grid = null, group = null;
    Ach.LIST.forEach(function (a) {
      if (top[a.id]) return;
      if (a.group !== group) {
        group = a.group;
        wrap.appendChild(el('h3', 'ach-head', group));
        grid = el('div', 'ach-grid');
        wrap.appendChild(grid);
      }
      grid.appendChild(card(a));
    });
  }

  /* An achievement unlocked: while you drive, a message at the top of the screen (with the race's other messages);
     in the menus, a card at the top for a few seconds (one after another when there are more). */
  const achQueue = [];
  let achBusy = false;
  function achNext() {
    if (achBusy || !achQueue.length) return;
    const a = achQueue.shift(), box = $('achpop');
    achBusy = true;
    $('achpop-name').textContent = a.name;
    $('achpop-desc').textContent = a.text;
    box.querySelector('.ach-ico').innerHTML = ICON_TROPHY;
    box.classList.remove('hidden');
    requestAnimationFrame(function () { requestAnimationFrame(function () { box.classList.add('show'); }); });
    setTimeout(function () {
      box.classList.remove('show');
      setTimeout(function () { box.classList.add('hidden'); achBusy = false; achNext(); }, 380);
    }, a.ms || (achQueue.length ? 2700 : 3800));     // (shorter when more are waiting)
  }
  function showUnlocked(list) {
    const driving = mode !== 'menu' && game && game.kind !== 'attract' && game.msgs && $('overlay').classList.contains('hidden');
    list.forEach(function (a) {
      if (driving) game.msgs.add('ACHIEVEMENT UNLOCKED', { sub: a.name + ' — ' + window.Ach.desc(a), color: '#ffd600', subColor: '#ffe680', key: 'ach-' + a.id, dur: 5000 });
      else achQueue.push({ name: a.name, text: window.Ach.desc(a) });
    });
    achNext();
    updateAchBadge();
    if ($('career').classList.contains('active')) openCareer(careerTab);
  }
  // achievements earned before there were achievements (version 15): unlocked quietly, with one card saying so
  (function () {
    const before = window.Ach.refresh();
    window.Ach.onUnlock = showUnlocked;
    if (before.length) {
      achQueue.push({ name: before.length === 1 ? '1 achievement' : before.length + ' achievements', text: 'Unlocked from your racing so far: see Career statistics', ms: 5200 });
      setTimeout(achNext, 1800);
    }
    window.Ach.seen();                 // (the first time version 16 opens: what was earned so far counts as seen)
    updateAchBadge();
  })();

  // ------------------------------------------------------------- settings
  /* Three tabs: Driving, View, Sound (the last one used stays open next time, until the page is reloaded). */
  let setTab = 'driving';
  function showSetTab(t, focus) {
    setTab = t;
    document.querySelectorAll('#set-tabs button').forEach(function (b) {
      const on = b.dataset.v === t;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    document.querySelectorAll('#set-pages .set-page').forEach(function (p) { p.classList.toggle('on', p.dataset.tab === t); });
    $('set-pages').scrollTop = 0;
  }
  document.querySelectorAll('#set-tabs button').forEach(function (b) {
    b.addEventListener('click', function () { closeDropdowns(); showSetTab(b.dataset.v); });
    b.addEventListener('keydown', function (e) {
      const order = ['driving', 'view', 'sound'], k = order.indexOf(setTab);
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault(); e.stopPropagation();
        showSetTab(order[(k + (e.key === 'ArrowRight' ? 1 : 2)) % 3], true);
      }
    });
  });
  /* Every tab as tall as the tallest one, so the window keeps its size when you switch (measured each time the window
     opens, and again when something in it changes size: a longer note, the phone controls, a new window size). */
  function fitSetPages() {
    if ($('settings').classList.contains('hidden')) return;
    const wrap = $('set-pages'), pages = wrap.querySelectorAll('.set-page'), top = wrap.scrollTop;
    wrap.style.height = '';
    let h = 0;
    pages.forEach(function (p) {
      pages.forEach(function (q) { q.classList.toggle('on', q === p); });
      h = Math.max(h, p.offsetHeight);
    });
    pages.forEach(function (p) { p.classList.toggle('on', p.dataset.tab === setTab); });
    const cs = getComputedStyle(wrap);
    if (cs.boxSizing === 'border-box') h += parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    wrap.style.height = Math.ceil(h) + 'px';
    wrap.scrollTop = top;
  }
  window.addEventListener('resize', fitSetPages);
  new MutationObserver(fitSetPages).observe(document.body, { attributes: true, attributeFilter: ['class'] });   // (touch controls switched on)
  function openSettings() {
    const d = Settings.data;
    $('set-steer').value = d.steering;
    $('set-steer-val').textContent = d.steering;
    $('set-steer').oninput = function () { d.steering = Number(this.value); $('set-steer-val').textContent = this.value; Settings.save(); };
    segInit($('set-camera'), d.camera, function (v) { d.camera = v; Settings.save(); });
    segInit($('set-zoom'), d.zoom || 'normal', function (v) { d.zoom = v; Settings.save(); });
    segInit($('set-units'), d.units === 'mph' ? 'mph' : 'kmh', function (v) { d.units = v; Settings.save(); });
    const gfxWords = function () {
      $('set-graphics-note').textContent = d.graphics === 'sharp' ? 'High: always full graphics, even if the game can\'t keep up.'
        : d.graphics === 'light' ? 'Low: fewer effects, smoother on slow phones and computers.'
          : 'Auto: full graphics, eased off if the game can\'t keep up.';
      fitSetPages();
    };
    segInit($('set-graphics'), d.graphics, function (v) { d.graphics = v; Settings.save(); gfxWords(); applyGraphics(); });
    gfxWords();
    $('set-touch').value = d.touchSteer;
    $('set-touch-val').textContent = d.touchSteer;
    $('set-touch').oninput = function () { d.touchSteer = Number(this.value); $('set-touch-val').textContent = this.value; Settings.save(); window.TouchUI.refresh(); };
    const touchWords = function () {
      const arrows = d.touchMode !== 'slide';
      $('set-touch-lo').textContent = arrows ? 'Gentle' : 'Long slide';
      $('set-touch-hi').textContent = arrows ? 'Quick' : 'Short slide';
      $('set-touch-note').textContent = arrows
        ? 'Left thumb: hold ← or → to steer (the longer you hold, the more the car turns). Right thumb: GO and BRAKE. Slide up from GO onto DRS when it lights up.'
        : 'Left thumb: slide left and right to steer. Right thumb: GO and BRAKE. Slide up from GO onto DRS when it lights up.';
      fitSetPages();
    };
    segInit($('set-touchmode'), d.touchMode === 'slide' ? 'slide' : 'arrows', function (v) { d.touchMode = v; Settings.save(); touchWords(); window.TouchUI.refresh(); });
    segInit($('set-vibrate'), d.vibrate === 'off' ? 'off' : 'on', function (v) { d.vibrate = v; Settings.save(); if (v === 'on') window.Haptics.buzz(40); });
    $('set-vibrate-row').classList.toggle('hidden', !window.Haptics.can);
    touchWords();
    renderKeys();
    $('set-labels').checked = !!d.labels;
    $('set-labels').onchange = function () { d.labels = this.checked; Settings.save(); };
    $('set-ghost').checked = d.ghost !== false;
    $('set-ghost').onchange = function () { d.ghost = this.checked; Settings.save(); };
    ['master', 'engine', 'effects'].forEach(function (k) {
      const inp = $('set-vol-' + k), out = $('set-vol-' + k + '-val');
      inp.value = Math.round(GameAudio.vol[k] * 100); out.textContent = Math.round(GameAudio.vol[k] * 100);   // (the engines' 68 sits between two steps of the slider)
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
      fitSetPages();
    }
    engineNote();
    $('settings').classList.remove('hidden');
    showSetTab(setTab);
    fitSetPages();
    Input.active = false;
  }
  /* Driving keys: click a key button, then press the new key (Esc cancels, Backspace empties the slot). */
  const KeyBind = window.KeyBind, Career = window.Career;
  let keyListen = null;          // { action, slot } while waiting for a key press
  function renderKeys() {
    const grid = $('keys-grid');
    grid.innerHTML = '';
    KeyBind.ACTIONS.forEach(function (a) {
      grid.appendChild(el('span', null, KeyBind.LABELS[a]));
      [0, 1].forEach(function (slot) {
        const code = KeyBind.get(a)[slot], on = keyListen && keyListen.action === a && keyListen.slot === slot;
        const b = el('button', 'keybtn' + (on ? ' listening' : code ? '' : ' empty'), on ? 'Press a key…' : KeyBind.name(code));
        b.type = 'button';
        b.addEventListener('click', function () {
          keyListen = on ? null : { action: a, slot: slot };
          keyNote(keyListen ? 'Press the key for "' + KeyBind.LABELS[a] + '" (Esc to cancel, Backspace for no key).' : null);
          renderKeys();
          b.blur();
        });
        grid.appendChild(b);
      });
    });
    $('keys-reset').disabled = KeyBind.isDefault();
    renderKeyHints();
  }
  function keyNote(text, warn) {
    $('keys-note').textContent = text || 'Click a key, then press the new one. Each action can have two keys.';
    $('keys-note').classList.toggle('warn', !!warn);
    fitSetPages();
  }
  /* The key list on the home screen follows your choices. */
  function renderKeyHints() {
    const box = $('home-keys');
    box.innerHTML = '';
    [[KeyBind.label('accel'), 'throttle'], [KeyBind.label('brake'), 'brake'], [KeyBind.steerLabel(), 'steer'], [KeyBind.label('drs'), 'DRS'],
      ['R', 'reset car'], ['C', 'camera'], ['F', 'full screen'], ['Esc', 'pause']].forEach(function (k) {
      const sp = el('span');
      sp.append(el('b', null, k[0]), document.createTextNode(' ' + k[1]));
      box.appendChild(sp);
    });
  }
  renderKeyHints();
  $('keys-reset').addEventListener('click', function () { keyListen = null; KeyBind.reset(); keyNote(null); renderKeys(); });
  // while waiting for a key, the press goes to the key setting and nowhere else
  window.addEventListener('keydown', function (e) {
    if (!keyListen) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const code = KeyBind.norm(e.code);
    if (code === 'Escape') { keyListen = null; keyNote(null); renderKeys(); return; }
    if (code === 'Backspace' || code === 'Delete') { KeyBind.set(keyListen.action, keyListen.slot, null); keyListen = null; keyNote(null); renderKeys(); return; }
    const why = KeyBind.blocked(code);
    if (why) { keyNote(why + ' — press another key (Esc to cancel).', true); return; }
    KeyBind.set(keyListen.action, keyListen.slot, code);
    keyListen = null;
    keyNote(null);
    renderKeys();
  }, true);
  /* Settings are kept the moment you change them: Save, the X and a click outside the box all close it. */
  function closeSettings(saved) {
    keyListen = null;
    if ($('settings').classList.contains('hidden')) return;
    Settings.save();
    closeDropdowns();
    $('settings').classList.add('hidden');
    Input.active = mode !== 'menu' && $('overlay').classList.contains('hidden') && $('pause').classList.contains('hidden');
    if (saved) toast('Settings saved');
  }
  $('settings-close').addEventListener('click', function () { closeSettings(true); });
  $('settings-x').addEventListener('click', function () { closeSettings(false); });
  clickOutside($('settings'), function (t) { return t === $('settings'); }, function () { closeSettings(false); });

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
  // phones and tablets: the on-screen controls (touch.js)
  let uprightPaused = false;
  $('pause-fs').classList.toggle('hidden', !fsSupported);
  $('pause-fs').addEventListener('click', function () { toggleFullscreen(); });
  window.TouchUI.init({
    pause: openPause,
    /* A phone held upright while driving: a notice covers the screen. Offline the game waits, and counts down 3-2-1 once
       the phone is turned sideways again; online the session carries on, as it does behind the pause menu. */
    rotate: function (upright) {
      const local = !!game && game.kind === 'local' && mode !== 'menu';
      $('rotate-sub').textContent = local ? 'The game waits until you do' : 'The session carries on while you turn it';
      if (!local) { uprightPaused = false; return; }
      if (upright) {
        if (!game.paused || game.resumeT > 0) { game.paused = true; game.cancelResume(); uprightPaused = true; }
      } else if (uprightPaused) {
        uprightPaused = false;
        if (game.paused && !pauseOpen() && !game.ended && game.S.phase !== 'done') game.startResume();
      }
    },
    mode: function () { syncSoundUI(); syncFsUI(); }
  });
  $('pause-resume').addEventListener('click', function () { resume(); });
  /* Phones: a tap on a pause-menu button with another finger still on the screen (a thumb resting on the gas) makes no
     'click' in the browser: press the button ourselves when the tap starts and ends on it. */
  (function () {
    const started = {};
    $('pause').addEventListener('touchstart', function (e) {
      for (let i = 0; i < e.changedTouches.length; i++) { const t = e.changedTouches[i]; started[t.identifier] = t.target && t.target.closest ? t.target.closest('button') : null; }
    }, { passive: true });
    $('pause').addEventListener('touchend', function (e) {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i], b = started[t.identifier];
        delete started[t.identifier];
        if (!b || e.touches.length === 0) continue;                 // one finger only: the browser's own click does it
        const at = document.elementFromPoint(t.clientX, t.clientY);
        if (at && at.closest && at.closest('button') === b && !b.disabled) { if (e.cancelable) e.preventDefault(); b.click(); }
      }
    }, { passive: false });
  })();
  $('pause-restart').addEventListener('click', function () {
    resume(true);
    if (mode === 'gp' && gp) startGpStage(gp.idx); else if (mode === 'tt') startTT(true); else startPractice(true);
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
  clickOutside($('confirm'), function (t) { return t === $('confirm'); }, function () { closeConfirm(true); });
  clickOutside($('pause'), function (t) { return t === $('pause'); }, function () { resume(); });
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
    if (mode === 'online') askLeaveRoom(true); else if (mode === 'tt') { goHome(); openTT(true); } else goHome();
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
    if (!$('msgmenu').classList.contains('hidden')) { $('msgmenu').classList.add('hidden'); return; }
    if (!$('fsnotice').classList.contains('hidden')) { fsNoticeClose(null); return; }
    if (!$('settings').classList.contains('hidden')) { closeSettings(false); return; }
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
    socket.on('snap', function (m) { toOnline('onSnap', m); });
    socket.on('timing', function (m) { toOnline('onTiming', m); });
    socket.on('ev', function (m) { toOnline('onEvents', m); });
    socket.on('sessionEnd', function (m) { if (onlineLoading) onlineLoading.buf.push(['end', m]); else onSessionEnd(m); });
    socket.on('season', onSeason);
    socket.on('msg', onQuickMsg);
    socket.on('seasonEnded', function (m) {
      if (game && game.kind === 'online') game.ended = true;
      season = null;
      const sv = OnlineSeason.load(), fr = FriendSeason.load();
      if (sv && room && sv.code === room.code) OnlineSeason.clear();
      if (fr && room && fr.code === room.code) FriendSeason.clear();
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
    // (not on a phone: the on-screen keyboard would jump up and cover the screen)
    if (!Input.touch.active) setTimeout(function () { ($('online-name').value ? $('online-code') : $('online-name')).focus(); }, 50);
    ensureNet();
    showFinder(finder.open);
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

  /* Find a room: the rooms on the server, open ones first (Join), private ones locked (they are joined with the code
     from the host). While the list is open it is brought up to date every 3 seconds. */
  const finder = { open: false, timer: null, retry: null, last: null, shown: null };
  const ROOM_STATE = { lobby: 'In the lobby', results: 'In the lobby', stageResults: 'Between sessions', seasonBreak: 'Between races',
    p1: 'Practice 1 on', p2: 'Practice 2 on', p3: 'Practice 3 on', quali: 'Qualifying on', race: 'Race on', away: 'Paused: the host is away' };
  function roomWhat(r) {
    const parts = [];
    if (r.champ) parts.push('Championship' + (r.races ? (r.round ? ', round ' + r.round + ' of ' + r.races : ', ' + r.races + ' races') : ''));
    const T = r.track && F1.TRACK_DEFS[r.track];
    if (r.track === 'random') parts.push('Surprise track'); else if (T) parts.push(T.name);
    parts.push(ROOM_STATE[r.state] || 'In the lobby');
    parts.push(r.players + '/' + r.max + ' players');
    return parts.join(' · ');
  }
  const LOCK = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" class="rlock"><path d="M6 11h12v10H6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
  const UNLOCK = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" class="rlock"><path d="M6 11h12v10H6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8.5 11V7.5a3.5 3.5 0 0 1 6.8-1.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  function renderRooms(list) {
    finder.last = list;
    const nOpen = list.filter(function (r) { return r.open; }).length, nPriv = list.length - nOpen;
    $('online-find-n').textContent = list.length ? (nOpen ? nOpen + ' open' : '') + (nOpen && nPriv ? ' · ' : '') + (nPriv ? nPriv + ' private' : '') : '';
    if (!finder.open) return;
    // (the same list as on screen: left as it is, so a Join being clicked is not swapped for a new button mid-click)
    const key = JSON.stringify(list);
    if (key === finder.shown) return;
    finder.shown = key;
    const box = $('online-rooms');
    box.innerHTML = '';
    if (!list.length) { box.appendChild(el('div', 'room-empty', 'No rooms right now: create one and send your friends the link')); return; }
    list.forEach(function (r) {
      const row = el('div', 'room-row' + (r.open ? '' : ' locked'));
      row.insertAdjacentHTML('beforeend', r.open ? UNLOCK : LOCK);
      const info = el('div', 'rinfo');
      info.append(el('b', null, r.host + "'s room"), el('span', null, roomWhat(r)));
      row.appendChild(info);
      if (r.open) {
        const full = r.players >= r.max, b = el('button', 'btn small', full ? 'Full' : 'Join');
        b.type = 'button';
        b.disabled = full;
        b.addEventListener('click', function () { $('online-code').value = r.code; joinCode(); });
        row.appendChild(b);
      } else row.appendChild(el('span', 'rcode', 'Code only'));
      box.appendChild(row);
    });
  }
  function findRooms() {
    if (!$('online').classList.contains('active')) { clearInterval(finder.timer); finder.timer = null; return; }
    ensureNet().socket.emit('listRooms', function (res) {
      if (res && res.ok) renderRooms(res.rooms || []);
      else if (finder.open && !finder.retry) finder.retry = setTimeout(function () { finder.retry = null; findRooms(); }, 600);   // (asked too soon)
    });
  }
  function showFinder(on) {
    finder.open = on;
    $('online-rooms').classList.toggle('hidden', !on);
    $('online-find').setAttribute('aria-expanded', on ? 'true' : 'false');
    clearInterval(finder.timer); finder.timer = null;
    finder.shown = null;
    if (on) {
      if (finder.last) renderRooms(finder.last);       // (the list from a moment ago, at once)
      else if (!$('online-rooms').children.length) $('online-rooms').appendChild(el('div', 'room-empty', 'Looking for rooms…'));
      finder.timer = setInterval(findRooms, 3000);
    }
    findRooms();
  }
  $('online-find').addEventListener('click', function () { showFinder(!finder.open); });

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
    if (!sv) { rejoinFriendSeason(); return; }
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
  /* A friend's season: join its room again with the code this browser remembered. */
  function rejoinFriendSeason() {
    const fr = FriendSeason.load();
    if (!fr) { updateSeasonButtons(); return; }
    openOnline(fr.code);
    const n = ensureNet();
    $('online-error').textContent = 'Joining the season…';
    n.socket.emit('joinRoom', { code: fr.code, name: playerName(), token: myToken() }, function (res) {
      if (!res || !res.ok) {
        $('online-error').textContent = /No room/.test((res && res.error) || '')
          ? (fr.host || 'The host') + ' has not opened the season again yet. Try again when they are back.' : (res && res.error) || 'Could not join';
        return;
      }
      $('online-error').textContent = '';
      history.replaceState(null, '', '?room=' + res.code);
    });
  }
  $('home-rejoin').addEventListener('click', rejoinSeason);
  $('os-rejoin').addEventListener('click', rejoinSeason);
  $('os-end').addEventListener('click', function () {
    const sv = OnlineSeason.load();
    if (!sv) {
      // a friend's season: just forget it in this browser
      if (FriendSeason.load()) { FriendSeason.clear(); updateSeasonButtons(); toast('Removed — you can still join again with the room code'); }
      return;
    }
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
  $('st-copy').addEventListener('click', function () { $('lobby-copy').click(); });
  $('lobby-copy').addEventListener('click', function () {
    if (!room) return;
    const link = location.origin + location.pathname + '?room=' + room.code;
    const done = function () { toast('Invite link copied — send it to your friends'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, function () { window.prompt('Copy this link:', link); });
    else window.prompt('Copy this link:', link);
  });
  $('lobby-start').addEventListener('click', function () { if (net) net.socket.emit('start'); });
  $('lobby-open').querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () { if (net && room && room.hostId === net.id()) net.socket.emit('roomOpen', b.dataset.v === '1'); });
  });
  $('lobby-ready').addEventListener('click', function () {
    if (!net || !room) return;
    const meP = room.players.find(function (p) { return p.id === net.id(); });
    net.socket.emit('ready', !(meP && meP.ready));
  });

  // ------------------------------------------------------------- quick messages (online, ready-made)
  const bubbles = {};            // player id -> { text, until }: shown next to the name in the lobby
  let msgNext = 0;               // one message every 2 seconds
  (function buildMsgMenu() {
    const box = $('msg-groups');
    let i = 0;
    F1.QUICK_MSGS.forEach(function (g) {
      const grp = el('div', 'msg-group'), row = el('div', 'row');
      grp.appendChild(el('h4', null, g.title));
      g.items.forEach(function (text) {
        const idx = i++, b = el('button', 'msg-btn', text);
        b.type = 'button';
        b.addEventListener('click', function () { sendQuickMsg(idx); });
        row.appendChild(b);
      });
      grp.appendChild(row);
      box.appendChild(grp);
    });
  })();
  function sendQuickMsg(i) {
    if (!net || !room) return;
    const now = performance.now();
    if (now < msgNext) { toast('One message every 2 seconds'); return; }
    msgNext = now + 2000;
    net.socket.emit('msg', i);
    $('msgmenu').classList.add('hidden');
  }
  document.querySelectorAll('.msg-open').forEach(function (b) {
    b.addEventListener('click', function () { if (room && net) $('msgmenu').classList.remove('hidden'); });
  });
  $('msg-close').addEventListener('click', function () { $('msgmenu').classList.add('hidden'); });
  clickOutside($('msgmenu'), function (t) { return t === $('msgmenu'); }, function () { $('msgmenu').classList.add('hidden'); });
  /* A message from someone in the room: a bubble by their name in the lobby, a pop-up on the other screens. */
  function onQuickMsg(m) {
    if (!room || !m) return;
    const p = room.players.find(function (x) { return x.id === m.id; }), text = F1.QUICK_LIST[m.m];
    if (!p || !text) return;
    if ($('lobby').classList.contains('active')) {
      bubbles[p.id] = { text: text, until: performance.now() + 4500 };
      renderLobby(room);
      setTimeout(function () { if (room && $('lobby').classList.contains('active')) renderLobby(room); }, 4600);
      return;
    }
    const box = $('msgpop'), it = el('div', 'msgpop-item');
    it.append(el('b', null, p.name + (net && p.id === net.id() ? ' (you)' : '') + ':'), document.createTextNode(text));
    box.appendChild(it);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(function () { it.classList.add('out'); }, 4200);
    setTimeout(function () { if (it.parentNode) it.parentNode.removeChild(it); }, 4600);
  }
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

  /* "Ana", "Ana and Ben", "Ana, Ben and Cal" */
  function listNames(a) { return a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
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
      if (p.ready) li.appendChild(el('span', 'ready', '✓ READY'));
      li.appendChild(el('span', 'pdrv', d ? '#' + d.number + ' ' + d.name : 'picking…'));
      const bub = bubbles[p.id];
      if (bub && bub.until > performance.now()) li.appendChild(el('span', 'bubble', bub.text));
      list.appendChild(li);
    });
    $('lobby-open').querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', (b.dataset.v === '1') === !!r.open); b.disabled = !isHost; });
    $('lobby-open-note').textContent = r.open ? 'Anyone can join from Find a room' : 'Friends join with the code ' + r.code + (isHost ? '' : ' (the host decides)');
    const meP = r.players.find(function (p) { return p.id === me; });
    $('lobby-ready').classList.toggle('on', !!(meP && meP.ready));
    $('lobby-ready').textContent = meP && meP.ready ? '✓ Ready' : 'Ready';
    const s = r.settings;
    // championship: a calendar of 2 tracks or more (up to every track, each once) instead of one track
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
    $('lobby-cal-btns').classList.toggle('hidden', !isHost);
    fillSelect($('set-track'), [['random', 'Surprise me']].concat(Object.keys(F1.TRACK_DEFS).map(function (id) { return [id, F1.TRACK_DEFS[id].name]; })), s.track);
    ['p1', 'p2', 'p3'].forEach(function (k) { fillSelect($('set-' + k), [[0, 'Skip'], [1, '1 lap'], [2, '2 laps'], [3, '3 laps']], s[k] || 0); });
    fillSelect($('set-quali'), [[0, 'None (random grid)'], [1, '1 lap'], [2, '2 laps'], [3, '3 laps'], [4, '4 laps'], [5, '5 laps']], s.qualiLaps);
    const raceOpts = []; for (let i = 1; i <= MAX_RACE_LAPS; i++) raceOpts.push([i, i + (i === 1 ? ' lap' : ' laps')]);
    fillSelect($('set-race'), raceOpts, Math.min(MAX_RACE_LAPS, s.raceLaps));
    $('set-reverse').value = s.reverseGrid && s.qualiLaps > 0 ? '1' : '0';
    const aiMax = 22 - r.players.length, aiOpts = [];
    for (let i = 0; i <= 21; i++) aiOpts.push([i, i > aiMax ? i + ' (max ' + aiMax + ')' : (i === aiMax ? i + ' (full grid)' : String(i))]);
    fillSelect($('set-ai'), aiOpts, s.aiCount);
    $('set-level').value = s.aiLevel;
    $('set-draft').value = s.drafting === false ? '0' : '1';
    $('set-tyres').value = s.tyreWear === false ? '0' : '1';
    $('set-weather').value = s.weather === false ? '0' : '1';
    ['set-mode', 'set-track', 'set-p1', 'set-p2', 'set-p3', 'set-quali', 'set-race', 'set-ai', 'set-level', 'set-draft', 'set-tyres', 'set-weather'].forEach(function (id) { $(id).disabled = !isHost; });
    $('set-reverse').disabled = !isHost || !(s.qualiLaps > 0);       // a reverse grid needs qualifying
    $('lobby-hostnote').textContent = isHost ? '' : '(host decides)';
    $('lobby-start').style.display = isHost ? '' : 'none';
    const first = ['p1', 'p2', 'p3'].find(function (k) { return s[k] > 0; }) || (s.qualiLaps > 0 ? 'quali' : 'race');
    $('lobby-start').textContent = champ ? (cal.length >= 2 ? 'Start season (' + cal.length + ' races)' : 'Pick at least 2 tracks')
      : first === 'race' ? 'Start race' : 'Start ' + STAGE_NAME[first];
    // the session starts when everyone (the host too) has pressed Ready
    const notReady = r.players.filter(function (p) { return !p.ready; }).map(function (p) { return p.id === me ? 'you' : p.name; });
    if (notReady.length && !(champ && cal.length < 2)) $('lobby-start').appendChild(el('small', null, 'Waiting for ' + listNames(notReady) + ' to press Ready'));
    $('lobby-start').disabled = (champ && cal.length < 2) || notReady.length > 0;
    $('lobby-waiting').style.display = isHost ? 'none' : '';
    $('lobby-waiting').textContent = notReady.length ? 'Waiting for ' + listNames(notReady) + ' to press Ready' : 'Waiting for the host to start…';
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
  $('lobby-cal-all').addEventListener('click', function () { if (net) net.socket.emit('settings', { calendar: F1.calendarTracks() }); });
  $('lobby-cal-none').addEventListener('click', function () { if (net) net.socket.emit('settings', { calendar: [] }); });
  ['set-mode', 'set-track', 'set-p1', 'set-p2', 'set-p3', 'set-quali', 'set-reverse', 'set-race', 'set-ai', 'set-level', 'set-draft', 'set-tyres', 'set-weather'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      const map = { 'set-mode': 'mode', 'set-track': 'track', 'set-p1': 'p1', 'set-p2': 'p2', 'set-p3': 'p3', 'set-quali': 'qualiLaps', 'set-reverse': 'reverseGrid',
        'set-race': 'raceLaps', 'set-ai': 'aiCount', 'set-level': 'aiLevel', 'set-draft': 'drafting', 'set-tyres': 'tyreWear', 'set-weather': 'weather' };
      const v = this.value, msg = {}, onOff = id === 'set-reverse' || id === 'set-draft' || id === 'set-tyres' || id === 'set-weather';
      msg[map[id]] = onOff ? v === '1' : (id === 'set-mode' || id === 'set-track' || id === 'set-level') ? v : Number(v);
      if (net) net.socket.emit('settings', msg);
    });
  });

  let roomAt = 0;
  function onRoom(r) {
    room = r;
    roomAt = performance.now();
    mode = 'online';
    if (!r.season) { const fr = FriendSeason.load(); if (fr && fr.code === r.code) FriendSeason.clear(); }
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
        if (!lobbyNoticeShown) { lobbyNoticeShown = true; fsGate(function () { /* stay in the lobby */ }); }
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
    // career: the season just finished while you were in it
    if (sv && sv.done && season && !season.done && sv.you) {
      const st = onlineStandings(sv);
      Career.season(!!st.drivers.length && st.drivers[0].e.eid === sv.you, Array.isArray(sv.calendar) ? sv.calendar.length : 0);
    }
    season = sv;
    if (sv && sv.save) {
      if (sv.done) OnlineSeason.clear();
      else OnlineSeason.save({ code: sv.save.code, key: sv.save.key, season: sv.save.season, at: Date.now() });
    } else if (sv && sv.code) {
      // racing in a friend's season: remember the room, for the Rejoin season button
      if (sv.done || !sv.you) { const fr = FriendSeason.load(); if (fr && fr.code === sv.code) FriendSeason.clear(); }
      else FriendSeason.save({ code: sv.code, host: sv.host || null, played: sv.rounds.length, of: sv.calendar.length, at: Date.now() });
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

  /* An online session whose track is still getting ready (the card is up): what the server sends meanwhile is kept
     and passed on, in order, once the session is on. */
  let onlineLoading = null;
  function toOnline(fn, m) {
    if (onlineLoading) { onlineLoading.buf.push([fn, m]); return; }
    if (game && game.kind === 'online') game[fn](m);
  }
  function onSession(info) {
    const wait = onlineLoading = { buf: [] };
    withTrack(info.track, function () {
      if (onlineLoading !== wait) return;
      onlineLoading = null;
      startOnline(info);
      for (let i = 0; i < wait.buf.length; i++) {
        const x = wait.buf[i];
        if (x[0] === 'end') onSessionEnd(x[1]);
        else if (game && game.kind === 'online') game[x[0]](x[1]);
      }
    });
  }
  function startOnline(info) {
    mode = 'online';
    clearInterval(resultsTimer);
    $('pause').classList.add('hidden');
    $('settings').classList.add('hidden');
    $('msgmenu').classList.add('hidden');
    game = new window.OnlineGame(net, info);
    keepTracks(info.track);
    // joining a paused season (or the host coming back): wait with everyone else
    if (room && (room.hostAway || room.resumeIn)) game.setPause(!!room.hostAway, Math.max(0, (room.resumeIn || 0) - (performance.now() - roomAt)));
    R.resetEffects();
    GameAudio.newSession();
    show(null);
    if (info.surprise && F1.TRACK_DEFS[info.track]) revealTrack(info.track, 'This weekend you race at');
  }

  function onSessionEnd(m) {
    // career: only a session you were driving in, and only once (the results can be sent again)
    if (game && game.kind === 'online' && !game.ended && game.myId !== null && m && m.results) {
      const code = game.code(game.myId), own = m.results.find(function (r) { return r.driverId === code && !r.isAI; });
      const rs = room && room.settings;      // (the weekend's settings: AI difficulty, sessions)
      if (own && m.type === 'race' && !own.left) Career.race({ track: m.track, pos: own.pos, out: !!own.out, fl: !!own.fl, pts: own.pts || 0, laps: own.laps || 0, online: true,
        grid: own.grid, ovt: own.ovt || 0, cars: m.results.length, rain: !!game.rainSeen,
        level: rs && rs.aiCount > 0 ? rs.aiLevel : null, full: !!(rs && rs.p1 > 0 && rs.p2 > 0 && rs.p3 > 0 && rs.qualiLaps > 0) });
      if (own && m.type === 'quali' && own.pos === 1 && own.best !== null && !own.out) Career.pole();
    }
    if (game && game.kind === 'online') game.ended = true;
    mode = 'online';
    showResults(m, 'online');
  }
  function showResults(m, ctx) {
    PlayTime.flush();
    $('busy').classList.add('hidden');
    $('confirm').classList.add('hidden');
    lastResults = m;
    resultsCtx = ctx;
    const T = F1.TRACK_DEFS[m.track];
    $('results-title').textContent = (m.round ? 'Round ' + m.round + ' · ' : '') + (m.stage ? STAGE_NAME[m.stage] : m.type === 'quali' ? 'Qualifying' : 'Race') + ' results — ' + T.name;
    const body = $('results-body');
    body.innerHTML = '';
    $('results-table').classList.toggle('no-pts', m.type !== 'race');
    $('results-table').classList.toggle('ty', m.type === 'race' && m.results.some(function (r) { return !!r.tyres; }));
    // qualifying with a reverse grid: m.grid = driver ids in the order they start the race
    const revGrid = m.type === 'quali' && m.grid && m.grid.length ? m.grid : null;
    $('results-table').classList.toggle('rev', !!revGrid);
    $('results-grid-head').textContent = revGrid ? 'Starts' : 'Grid';
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
      // the tyres used, in order (a ring for each set)
      const tyTd = el('td', 'race-col ty-col');
      (r.tyres || '').split('').forEach(function (k) {
        const ty = F1.TYRES[k];
        if (!ty) return;
        const ring = el('span', 'mini-tyre', k); ring.style.setProperty('--tc', ty.col); ring.title = ty.name;
        tyTd.appendChild(ring);
      });
      tr.appendChild(tyTd);
      // grid slot and places gained / lost
      const gridTd = el('td', 'r race-col grid-col', revGrid ? 'P' + (revGrid.indexOf(r.driverId) + 1) : r.grid ? 'P' + r.grid : '');
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
      else if (m.type === 'quali') $('results-note').textContent = !mine ? '' : revGrid ? 'Reverse grid: you start the race from P' + (revGrid.indexOf(mine.driverId) + 1)
        : 'You start the race from P' + mine.pos;
      else $('results-note').textContent = mine ? 'You finished P' + mine.pos + (mine.pts ? ' — ' + mine.pts + (mine.pts === 1 ? ' point' : ' points') : '') : '';
    } else if (m.next && m.nextIn) {
      let left = m.nextIn;
      const say = function () {
        const myStart = revGrid && myPlayer ? revGrid.indexOf(myPlayer.driverId) + 1 : 0;
        return (m.next === 'race' ? 'The race' : STAGE_NAME[m.next]) + ' starts in ' + left + ' s' +
          (m.next === 'race' && m.type === 'quali' ? (revGrid ? ' — reverse grid' + (myStart ? ': you start P' + myStart : '') : ' — you start from your qualifying position') : '');
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
    // a race: the top three on the podium first (the results come up after a few seconds, or on a click)
    if (!(m.type === 'race' && showPodium(m, myPlayer, local))) show('results');
    updateResultsButtons();
  }

  /* The podium: the top three on their steps, with their cars, in the same panel as the results. */
  let podiumTimer = null;
  function showPodium(m, myPlayer, local) {
    const top = m.results.filter(function (r) { return !r.out && r.pos <= 3; }).sort(function (a, b) { return a.pos - b.pos; });
    if (!top.length) return false;
    const T = F1.TRACK_DEFS[m.track];
    $('podium-title').textContent = 'Podium — ' + T.name + (m.round ? ' (round ' + m.round + ')' : '');
    const box = $('podium-steps');
    box.innerHTML = '';
    const small = window.innerHeight <= 520, dpr = Math.min(2, window.devicePixelRatio || 1);
    [2, 1, 3].forEach(function (p) {
      const r = top.find(function (x) { return x.pos === p; });
      if (!r) return;
      const d = F1.driver(r.driverId), t = F1.team(d.team), mine = myPlayer && myPlayer.driverId === r.driverId;
      const col = el('div', 'pstep p' + p);
      // the car, nose up, in its colours
      const cw = small ? 32 : 46, ch = small ? 74 : 108, cv = document.createElement('canvas');
      cv.width = cw * dpr; cv.height = ch * dpr;
      const cx = cv.getContext('2d'), k = (ch - 6) / 5.6;
      cx.scale(dpr, dpr); cx.translate(cw / 2, ch / 2 + 2); cx.rotate(-Math.PI / 2); cx.scale(k, k);
      window.Renderer.drawCarLocal(cx, t, 0, false, r.tyres ? r.tyres.slice(-1) : null);
      col.appendChild(cv);
      const nm = el('div', 'pname'), bar = el('span', 'bar');
      bar.style.background = teamColor(t); nm.append(bar, d.name);
      if (mine) nm.appendChild(el('span', 'pyou', local ? 'YOU' : (myPlayer.name || 'YOU').toUpperCase().slice(0, 10)));
      else if (!r.isAI && !local) nm.appendChild(el('span', 'pyou', String(r.name || 'Player').toUpperCase().slice(0, 10)));
      col.append(nm, el('div', 'pteam', t.name));
      const blk = el('div', 'pblock');
      blk.appendChild(el('span', null, String(p)));
      col.appendChild(blk);
      box.appendChild(col);
    });
    const mine = myPlayer && m.results.find(function (r) { return r.driverId === myPlayer.driverId; });
    $('podium-note').textContent = !mine ? '' : mine.out ? 'You did not finish' : mine.pos <= 3 ? (mine.pos === 1 ? 'You won the race!' : 'You finished P' + mine.pos + ' — on the podium!') : 'You finished P' + mine.pos;
    show('podium');
    clearTimeout(podiumTimer);
    podiumTimer = setTimeout(leavePodium, 9000);
    return true;
  }
  function leavePodium() {
    clearTimeout(podiumTimer);
    if ($('podium').classList.contains('active')) show('results');
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
    $('results-msg').classList.toggle('hidden', isGp || !room);
    if (onlineSeason) {
      const done = season && season.done;
      $('results-note').textContent = isHost ? (done ? 'The season is over: see the final standings.' : 'Next: the championship standings, then start the next round.')
        : (done ? 'The season is over!' : 'Waiting for the host to start the next round…');
    } else if (!isGp && raceDone && !isHost) $('results-note').textContent = 'Waiting for the host to return to the lobby…';
  }

  // ------------------------------------------------------------- main loop
  const params = new URLSearchParams(location.search);

  if (params.get('debug') === '1') window.__tdgp = { onSessionEnd: onSessionEnd, net: function () { return net; }, game: function () { return game; }, R: R, attract: function (mid) { startAttract(mid); }, sess: function () { return { sess: sess, beat: pace.beat, chip: gfxChip }; } };

  let last = performance.now(), acc = 0;

  /* Steady pace. The screen shows a new picture at a fixed beat (60, 90, 120, 144 a second...). The times the browser
     gives for the pictures wobble a little around that beat, and moving the cars on by the wobbly times makes them
     shake. So the game learns the beat and moves everything on by whole beats; the small differences are kept aside
     and given back a little at a time, so the game's clock never drifts away from the real one. */
  const pace = { beat: 0, ring: new Float64Array(48), sorted: new Float64Array(48), n: 0, drift: 0 };
  function learnBeat() {
    const m = Math.min(pace.n, 48), a = pace.sorted.subarray(0, m);
    a.set(pace.ring.subarray(0, m)); a.sort();
    const mid = a[m >> 1];
    let sum = 0, near = 0;
    for (let i = 0; i < m; i++) if (Math.abs(a[i] - mid) < mid * 0.12) { sum += a[i]; near++; }
    const b = near >= m * 0.6 ? sum / near : 0;
    // only a screen's beat (48 to 240 pictures a second, or a steady 30 held by battery saver): when the game can't keep
    // up with the screen its pace is uneven, and that is used as it is (fitted to a "beat" it would speed up and slow
    // down)                                                            (no steady beat: the times are used as they are)
    pace.beat = (b >= 0.004 && b <= 0.021) || (b >= 0.031 && b <= 0.036) ? b : 0;
  }
  function steadyDt(raw) {
    if (raw > 0.003 && raw < 0.06) { pace.ring[pace.n % 48] = raw; pace.n++; if (pace.n >= 24 && pace.n % 24 === 0) learnBeat(); }
    const b = pace.beat;
    // off the beat (or none): the time as it is, plus what was held back so far (no time is ever lost or gained)
    if (!b) { const d = pace.drift; pace.drift = 0; return Math.max(0, raw + d); }
    const k = Math.round(raw / b);
    if (k < 1 || k > 4 || Math.abs(raw - k * b) > b * 0.3) { const d = pace.drift; pace.drift = 0; return Math.max(0, raw + d); }
    pace.drift += raw - k * b;
    const back = F1.clamp(pace.drift * 0.05, -b * 0.02, b * 0.02);
    pace.drift -= back;
    return k * b + back;
  }

  /* Does the browser draw with the graphics chip? true, false (a software stand-in draws instead), or null when it
     can't tell. Found out once (at a quiet moment: while a track gets ready, or a few seconds after the page opens). */
  let gfxChip;
  function graphicsChip() {
    if (gfxChip !== undefined) return gfxChip;
    gfxChip = null;
    try {
      const probe = function (o) { const c = document.createElement('canvas'); return c.getContext('webgl', o) || c.getContext('experimental-webgl', o); };
      const done = function (gl) { const x = gl && gl.getExtension('WEBGL_lose_context'); if (x) x.loseContext(); };
      const gl = probe(undefined);
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const name = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
        if (/swiftshader|llvmpipe|softpipe|lavapipe|basic render|software/i.test(name)) gfxChip = false;
        else { const hw = probe({ failIfMajorPerformanceCaveat: true }); gfxChip = !!hw; done(hw); }
        done(gl);
      }
    } catch (e) { gfxChip = null; }
    R.accel = gfxChip;               // (the stored tiles are used only when the graphics chip draws)
    return gfxChip;
  }
  // (found out as the page opens, before the race behind the menus is first drawn: the stored tiles are used from the
  // start when the graphics chip draws)

  /* Smoothness watch, while you drive (not in menus or paused), on Auto graphics:
     - phones and tablets: many late pictures for about 6 seconds → Low graphics for the rest of the visit;
     - computers: only when the browser draws without the graphics chip and the game can't keep up, a slightly softer
       picture (sharpness 2 → 1.5) for the rest of the visit. Never Low by itself; High is always the full picture.
     After a session that wasn't smooth, a tip in the menu, once, when the cause is one you can change. */
  const perf = { t: 0, slow: 0, since: 0, autoLite: false, autoSoft: false };
  const sess = { t: 0, late: 0, work: 0, frames: 0, race: false };
  applyGraphics();
  /* The Graphics setting: Low = lighter graphics always; High = never; Auto = full, lighter by itself when needed. */
  function applyGraphics() {
    const g = Settings.data.graphics;
    if (g === 'light') R.setLite(true);
    else if (g === 'sharp') { R.setLite(false); R.setSoft(false); }
    else { if (!perf.autoLite) R.setLite(false); R.setSoft(perf.autoSoft); }
  }
  function watchFrames(raw, driving, work) {
    if (!driving || document.hidden) { perf.t = 0; perf.slow = 0; perf.since = 0; return; }
    perf.since += raw;
    if (perf.since < 3) return;                      // the first moments of a session (loading) do not count
    // (for the tip after the session)
    sess.t += raw; sess.frames++; sess.work += work;
    if (raw > Math.max(0.022, (pace.beat || 1 / 60) * 1.5)) sess.late += raw;
    if (game && game.type === 'race') sess.race = true;
    const touch = document.body.classList.contains('touch');
    if (Settings.data.graphics !== 'auto' || (touch ? R.lite : perf.autoSoft || graphicsChip() !== false)) { perf.t = 0; perf.slow = 0; return; }
    perf.t += raw;
    if (raw > 0.022) perf.slow += raw;
    if (perf.t < 6) return;                            // (about 6 seconds of steady trouble, not a brief stutter)
    if (perf.slow / perf.t > 0.45) {
      if (touch) {
        R.setLite(true); perf.autoLite = true;
        toast('Graphics switched to Low to keep the game smooth (Settings → Graphics)', 6000);
      } else { perf.autoSoft = true; R.setSoft(true); }
    }
    perf.t = 0; perf.slow = 0;
  }
  /* Back in the menu after a session that wasn't smooth: a tip, once, if the cause is one you can change (the browser
     not using the graphics chip, or battery saver holding the game to 30 pictures a second). */
  function smoothTip() {
    const t = sess.t, lateShare = t > 0 ? sess.late / t : 0, work = sess.frames ? sess.work / sess.frames : 0, race = sess.race;
    sess.t = 0; sess.late = 0; sess.work = 0; sess.frames = 0; sess.race = false;
    if (t < 20) return;
    const b = pace.beat, capped = b > 0.031 && b < 0.036 && work < 0.006;     // a steady 30 a second, with time to spare
    if (lateShare < 0.15 && !capped) return;
    let seen = {};
    try { seen = JSON.parse(window.localStorage.getItem('topdowngp.tips') || '{}') || {}; } catch (e) { seen = {}; }
    const what = race ? 'Last race' : 'Last session';
    let kind = null, text = '';
    if (graphicsChip() === false) { kind = 'gpu'; text = what + ' wasn’t smooth: your browser isn’t using the graphics chip. Turn on graphics acceleration in its settings.'; }
    else if (capped) { kind = 'saver'; text = what + ' wasn’t smooth: battery saver is holding the game to 30 frames a second. Plug in or switch it off for smoother racing.'; }
    if (!kind || seen[kind]) return;
    const say = function () {
      seen[kind] = Date.now();
      try { window.localStorage.setItem('topdowngp.tips', JSON.stringify(seen)); } catch (e) { /* ignore */ }
      toast(text, 9000);
    };
    // (battery saver: not when the battery says it is charging)
    if (kind === 'saver' && navigator.getBattery) navigator.getBattery().then(function (bt) { if (!bt.charging && mode === 'menu') say(); }, function () { /* unknown */ });
    else say();
  }

  /* The frame counter (add ?fps to the address): pictures a second, the time the game takes for each, the screen's
     beat, whether the graphics chip draws, and the freeze recorder (pictures more than a fifth of a second late while
     you drive: how many, the longest, and whether the game's own work or the browser held it up). */
  const FPS = /[?&]fps(=|&|$)/.test(location.search) ? { n: 0, work: 0, at: 0, fps: 0, ms: 0, freezes: 0, longest: 0, cause: '', lastWork: 0, wait: [] } : null;
  /* What held a freeze up. The game's own work (working out the race and the drawing commands for the picture) is
     timed here. For the rest, Chrome keeps its own record of long pictures on the page ("long animation frames"), with
     how long scripts ran and how long the browser then took to lay out and draw the picture: if the page was busy
     drawing, it was the drawing; busy with other scripts (another part of the page, an add-on): other work on the page;
     not busy at all: the page was waiting for the graphics side (the graphics chip, the screen) or another program. */
  const loaf = [];
  if (FPS && window.PerformanceObserver && (PerformanceObserver.supportedEntryTypes || []).indexOf('long-animation-frame') >= 0) {
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          let sc = 0;
          (e.scripts || []).forEach(function (x) { sc += x.duration || 0; });
          const t1 = e.startTime + e.duration;
          // (the drawing: from when the browser starts laying out the picture, after the scripts that draw it, to the end)
          const ds = e.styleAndLayoutStart || e.renderStart || t1;
          loaf.push({ t0: e.startTime, t1: t1, script: sc, draw: Math.max(0, t1 - ds) });
        });
        if (loaf.length > 40) loaf.splice(0, loaf.length - 40);
      }).observe({ type: 'long-animation-frame' });
      FPS.loaf = true;
    } catch (e) { /* not available */ }
  }
  function freezeCause(t0, t1, work) {
    let busy = 0, script = 0, draw = 0;
    for (let i = 0; i < loaf.length; i++) {
      const L = loaf[i], o = Math.max(0, Math.min(t1, L.t1) - Math.max(t0, L.t0));
      if (!o) continue;
      busy += o; script += L.script; draw += L.draw;
    }
    if (busy < (t1 - t0) * 0.5) return 'waiting for graphics';
    return draw >= script - work ? 'drawing the picture' : 'other work on the page';
  }
  function countFrame(now, raw, work, driving) {
    const f = FPS;
    f.n++; f.work += work;
    if (!f.at) f.at = now;
    if (now - f.at >= 1000) { f.fps = Math.round(f.n * 1000 / (now - f.at)); f.ms = f.work / f.n * 1000; f.n = 0; f.work = 0; f.at = now; }
    if (driving && raw > 0.2) {
      f.freezes++; f.longest = Math.max(f.longest, raw);
      if (f.lastWork > raw * 0.5) f.cause = 'the game\u2019s own work';
      else if (f.loaf) { f.cause = '...'; f.wait.push([now - raw * 1000, now, f.lastWork * 1000]); }     // (Chrome's record comes a moment later)
      else f.cause = 'drawing the picture';
    }
    if (f.wait.length && now - f.wait[0][1] > 400) { const w = f.wait.shift(); f.cause = freezeCause(w[0], w[1], w[2]); }
    f.lastWork = work;
    const hz = pace.beat ? Math.round(1 / pace.beat) : 0, chip = R.cpu ? 'graphics chip off (test)' : gfxChip === true ? 'graphics chip on' : gfxChip === false ? 'no graphics chip' : 'graphics chip ?';
    R.fpsBox = { fps: f.fps, ms: f.ms, hz: hz, chip: chip, freezes: f.freezes, longest: f.longest, cause: f.cause, tiles: R.tileWhy };
  }
  /* Parked in your garage: a panel with your session so far and the way back out. */
  let garShown = null;
  function updateGarageUI() {
    const st = game && game.garageState ? game.garageState() : null;
    const show = !!st && mode !== 'menu' && $('overlay').classList.contains('hidden') && $('pause').classList.contains('hidden');
    if (!show) { if (garShown !== null) { $('garage').classList.add('hidden'); garShown = null; } return; }
    const key = [st.best, st.pos, st.laps, Input.touch.active, st.first, st.tyres ? st.tyres.cur : ''].join('|');
    if (key === garShown) return;
    garShown = key;
    $('gar-stats').innerHTML = '';
    const line = function (label, value) { const d = el('div'); d.append(document.createTextNode(label + ' '), el('b', null, value)); $('gar-stats').appendChild(d); };
    line('Your best lap', st.best !== null && st.best !== undefined ? F1.fmtLap(st.best) + '  ·  P' + st.pos + ' of ' + st.n : 'no time yet');
    line('Timed laps', String(st.laps));
    $('gar-go').textContent = st.first ? 'Go out' : 'Go back out';
    $('gar-tyres').classList.toggle('hidden', !st.tyres);
    if (st.tyres) tyreChips($('gar-chips'), st.tyres.opts, st.tyres.cur, !Input.touch.active, function (k) { if (game && game.pickTyre) game.pickTyre(k); });
    $('gar-hint').textContent = Input.touch.active ? 'or hold GO' : 'or hold ' + KeyBind.label('accel') + '  ·  Enter';
    $('garage').classList.remove('hidden');
  }
  $('gar-go').addEventListener('click', function (e) { e.currentTarget.blur(); if (game) game.goOut = true; });

  // ---- tyres: the choice in the garage (practice), and the picker in a race (on the grid, and for a pit stop)
  function tyreChips(box, opts, cur, keys, onPick) {
    const sig = opts.join('') + '|' + cur + '|' + keys;
    if (box._sig === sig) return;
    box._sig = sig;
    box.innerHTML = '';
    opts.forEach(function (k, i) {
      const ty = F1.TYRES[k], b = el('button', 'tyre-chip' + (k === cur ? ' on' : ''));
      b.type = 'button';
      b.style.setProperty('--tc', ty.col);
      b.append(el('span', 'tyre-ring', k), el('span', 'tc-name', k === 'I' ? 'Inter' : ty.name));
      if (keys) b.append(el('span', 'tc-key', String(i + 1)));
      if (onPick) b.addEventListener('click', function (e) { e.currentTarget.blur(); onPick(k); });
      box.appendChild(b);
    });
  }
  let tpShown = null;
  function updateTyreUI() {
    const st = game && game.tyreState ? game.tyreState() : null;
    const show = !!st && mode !== 'menu' && $('overlay').classList.contains('hidden') && $('pause').classList.contains('hidden');
    if (!show) { if (tpShown !== null) { $('tyrepick').classList.add('hidden'); tpShown = null; } return; }
    const touch = Input.touch.active;
    const key = [st.mode, st.cur, st.left !== undefined ? Math.ceil(st.left * 10) : '', touch].join('|');
    if (key === tpShown) return;
    tpShown = key;
    const title = $('tp-title');
    title.textContent = st.mode === 'grid' ? 'Starting tyres' : st.mode === 'pit' ? 'Pit stop — new tyres' : 'Changing tyres';
    if (st.mode === 'stop') title.appendChild(el('span', 'tp-time', Math.max(0, st.left).toFixed(1) + ' s'));
    tyreChips($('tp-chips'), st.mode === 'stop' ? [st.cur] : st.opts, st.cur, !touch && st.mode !== 'stop', st.mode === 'stop' ? null : function (k) { if (game && game.pickTyre) game.pickTyre(k); });
    let note = '';
    if (st.mode === 'grid' && st.wet > 0.1) note = st.wet > 0.55 ? 'Very wet track: full wets (blue)' : 'Wet track: intermediates (green)';
    else if (st.mode === 'grid') note = touch ? (st.must ? 'At least one pit stop this race' : '') : (st.must ? 'At least one pit stop this race · ' : '') + (st.wear ? 'Soft lasts about 6 laps, medium 10, hard 14' : '');
    else if (st.mode === 'pit') note = st.left > 0 ? (st.left === 1 ? 'Last lap' : st.left + ' laps to go') : '';
    $('tp-note').textContent = note;
    $('tyrepick').classList.toggle('stop', st.mode === 'stop');
    $('tyrepick').classList.remove('hidden');
  }
  // keys 1-5 pick a tyre while a choice is on screen (unless that key is one of your driving keys)
  window.addEventListener('keydown', function (e) {
    const m = /^(?:Digit|Numpad)([1-5])$/.exec(e.code);
    if (!m || !game || !game.pickTyre || e.repeat) return;
    const K = Settings.data.keys;
    if (Object.keys(K).some(function (a) { return K[a].indexOf(e.code) >= 0; })) return;
    let opts = null;
    if (tpShown !== null) { const st = game.tyreState(); if (st && st.opts) opts = st.opts; }
    else if (garShown !== null) { const g = game.garageState(); if (g && g.tyres) opts = g.tyres.opts; }
    const k = opts && opts[Number(m[1]) - 1];
    if (k) { game.pickTyre(k); e.preventDefault(); }
  });
  window.addEventListener('keydown', function (e) {
    if (e.code === 'Enter' && garShown !== null && !e.repeat && game) { game.goOut = true; e.preventDefault(); }
  });
  let menuOdd = false;
  /* Time played: counted while a session is on screen and running (not in the menus or results, not in the pause menu
     or its 3-2-1, not behind the loading card, not while this tab is hidden), for each track. Added to your career
     every 20 seconds, when a session ends and when the page is hidden or closed. */
  const PlayTime = {
    per: {}, n: 0,
    add: function (id, s) { this.per[id] = (this.per[id] || 0) + s; this.n += s; if (this.n >= 20) this.flush(); },
    flush: function () { if (!this.n) return; const per = this.per; this.per = {}; this.n = 0; window.Career.addTime(per); }
  };
  document.addEventListener('visibilitychange', function () { if (document.hidden) PlayTime.flush(); });
  window.addEventListener('pagehide', function () { PlayTime.flush(); });
  // (the page was hidden, or the computer asleep, since the last picture: that gap is not the game being slow)
  let wasAway = false;
  document.addEventListener('visibilitychange', function () { if (document.hidden) wasAway = true; });
  function frame(now) {
    const t0 = performance.now(), raw = (now - last) / 1000;
    last = now;
    let dt = raw > 0.25 ? 0.25 : steadyDt(raw);
    // paused (and the 3-2-1 after it): time stands still, and so does the in-between position the cars are drawn at,
    // so at "go" the picture carries on from exactly where it stopped (no jump back). The 3-2-1 is counted before the
    // game moves on, so the cars already move in the picture of "go" itself (no repeated picture).
    if (game.tickResume) game.tickResume(dt);
    if (!game.paused) {
      acc += dt;
      let steps = 0;
      while (acc >= F1.DT && steps < 6) { game.step(); acc -= F1.DT; steps++; }
      if (steps >= 6) acc = 0;
    }
    // phones and tablets: the race behind the menus is drawn less, so the menus stay quick to scroll: every other frame
    // behind the home screen, and not at all behind the other menus (they cover it)
    let draw = !(LC.on && !LC.ready);     // (a track getting ready behind the card: nothing to draw)
    if (draw && game.kind === 'attract' && Input.touch.active) {
      const scr = document.querySelector('#overlay .screen.active');
      if (scr && scr.id !== 'home') draw = false;
      else { menuOdd = !menuOdd; draw = menuOdd; }
    }
    if (draw) { try { game.render(R, acc / F1.DT, dt); } catch (err) { console.error(err); } }
    // sound: only while a session is on screen (not in menus, pause or results)
    const audioOn = mode !== 'menu' && game.kind !== 'attract' && $('overlay').classList.contains('hidden') && $('pause').classList.contains('hidden') && !(game.resumeT > 0) && !game.frozen;
    GameAudio.setActive(audioOn);
    if (audioOn && game.T) {
      if (!document.hidden && !LC.on && raw > 0 && raw < 1) PlayTime.add(game.T.id, raw);
      // (it rained in this session: for the Rain master achievement)
      const rain = game.kind === 'online' ? game.wxT && game.wxT.rain : game.S && game.S.rain;
      if (rain > 0.08) game.rainSeen = true;
    }
    updateGarageUI();
    updateTyreUI();
    if (audioOn && game.audioState) { try { const st = game.audioState(); if (st) { GameAudio.update(st, dt); window.Haptics.kerb(st.own); } } catch (err) { console.error(err); } }
    loadCardFrame(now);
    R.tileRush = LC.on && !LC.t;       // (behind the loading card: the stored tiles around the start are painted quickly)
    const work = (performance.now() - t0) / 1000, driving = audioOn && game.kind !== 'attract' && !wasAway && raw < 5;
    wasAway = false;
    watchFrames(raw, driving, work);
    if (FPS) countFrame(now, raw, work, driving);
    requestAnimationFrame(frame);
  }
  graphicsChip();
  goHome();
  if (params.get('room')) openOnline(params.get('room').toUpperCase().slice(0, 4));
  requestAnimationFrame(frame);
})();
