/* Sign-in with Google, the daily challenge board, friends and the Account tab (version 17). The server has the say on
   whether sign-in is on (/api/config); without it the game works as before. Kept in this browser: the sign-in token
   (topdowngp.session) and your name and friend code (topdowngp.me). Your email is never stored or shown: the server
   checks Google's sign-in token and keeps only Google's account number from it (scrambled). */
(function () {
  'use strict';
  const F1 = window.F1;
  const $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  const units = function () { return window.Settings && window.Settings.data.units === 'mph' ? 'mph' : 'kmh'; };
  function load(k) { try { return JSON.parse(window.localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function store(k, v) { try { if (v === null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  const MEDAL = ['', '🥉', '🥈', '🥇'];

  const Account = {
    cfg: null,                    // { signIn, clientId } from the server
    token: load('topdowngp.session'),
    me: load('topdowngp.me'),     // { name, code }
    friends: null, sel: null,     // the friends list, and the one shown beside it
    boardTab: 'all', lastBoard: null,
    hooks: { toast: function () {}, confirm: null, join: null, net: null, nameChanged: null },
    on: function () { return !!(this.cfg && this.cfg.signIn); },
    signedIn: function () { return this.on() && !!this.token; }
  };

  // ------------------------------------------------------------- talking to the server
  function api(method, path, body) {
    const h = { 'content-type': 'application/json' };
    if (Account.token) h.authorization = 'Bearer ' + Account.token;
    return fetch('/api' + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && Account.token && path !== '/signin') { forget(); refreshAll(); }
        if (!r.ok) { const e = new Error(j.error || 'The server did not answer'); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  function forget() {
    Account.token = null; Account.me = null; Account.friends = null; Account.sel = null;
    store('topdowngp.session', null); store('topdowngp.me', null);
  }
  Account.start = function () {
    return fetch('/api/config').then(function (r) { return r.json(); }).catch(function () { return { signIn: false }; }).then(function (c) {
      Account.cfg = c || { signIn: false };
      if (Account.signedIn()) {
        api('GET', '/me').then(function (j) { setMe(j.me); hello(); syncDaily(); pushStats(true); }).catch(function () { /* (offline) */ });
      }
      refreshAll();
    });
  };
  function setMe(m) {
    if (!m) return;
    Account.me = m; store('topdowngp.me', m);
    const S = window.Settings;
    if (S && S.data.name !== m.name) { S.data.name = m.name; S.save(); if (Account.hooks.nameChanged) Account.hooks.nameChanged(m.name); }
  }
  /* The connection the online rooms use: it tells the server who you are, so friends see you online (and your room). */
  function hello() {
    if (!Account.signedIn() || !Account.hooks.net) return;
    const n = Account.hooks.net(), s = n.socket;
    if (!s.__tdgpHello) { s.__tdgpHello = true; s.on('connect', function () { if (Account.token) s.emit('hello', { token: Account.token }); }); }
    if (s.connected) s.emit('hello', { token: Account.token });
  }

  // ------------------------------------------------------------- Google's sign-in button
  let gisLoading = null, gisReady = false;
  function loadGis() {
    if (gisReady) return Promise.resolve();
    if (gisLoading) return gisLoading;
    gisLoading = new Promise(function (ok, fail) {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true;
      s.onload = function () {
        try {
          window.google.accounts.id.initialize({ client_id: Account.cfg.clientId, callback: onCredential, auto_select: false, cancel_on_tap_outside: true, ux_mode: 'popup', itp_support: true });
          gisReady = true; ok();
        } catch (e) { fail(e); }
      };
      s.onerror = function () { gisLoading = null; fail(new Error('Google sign-in could not be loaded')); };
      document.head.appendChild(s);
    });
    return gisLoading;
  }
  /* Put Google's own button in box (after the page has Google's script). */
  function googleButton(box) {
    const slot = el('div', 'gsi-slot');
    box.appendChild(slot);
    loadGis().then(function () {
      window.google.accounts.id.renderButton(slot, { type: 'standard', theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', logo_alignment: 'left', width: 240 });
    }).catch(function () { slot.appendChild(el('p', 'mu', 'Google sign-in could not be loaded. Check your connection and try again.')); });
  }
  function onCredential(resp) {
    if (!resp || !resp.credential) return;
    const name = window.Settings ? window.Settings.data.name : '';
    api('POST', '/signin', { credential: resp.credential, name: name }).then(function (j) {
      Account.token = j.token; store('topdowngp.session', j.token);
      setMe(j.me);
      Account.hooks.toast('Signed in as ' + j.me.name);
      hello(); syncDaily(); pushStats(true);
      refreshAll();
    }).catch(function (e) { Account.hooks.toast(e.message || 'Sign-in did not work'); });
  }
  Account.signOut = function () {
    const done = function () {
      forget();
      try { if (gisReady) window.google.accounts.id.disableAutoSelect(); } catch (e) { /* ignore */ }
      if (Account.hooks.net) { const s = Account.hooks.net().socket; if (s.connected) s.emit('bye'); }
      Account.hooks.toast('Signed out');
      refreshAll();
    };
    api('POST', '/signout').then(done, done);
  };
  Account.deleteData = function () {
    const go = function () {
      api('DELETE', '/me').then(function () { forget(); Account.hooks.toast('Your online data is deleted'); refreshAll(); })
        .catch(function (e) { Account.hooks.toast(e.message); });
    };
    if (Account.hooks.confirm) Account.hooks.confirm({ title: 'Delete your online data?', text: 'Your name, friend code, friends and daily challenge results on the server are deleted, and you are signed out. Your results in this browser stay.', yes: 'Delete', go: go });
    else go();
  };
  Account.rename = function (name) {
    if (!Account.signedIn()) return Promise.resolve();
    return api('POST', '/me', { name: name }).then(function (j) { setMe(j.me); refreshAll(); }).catch(function (e) { Account.hooks.toast(e.message); });
  };

  // ------------------------------------------------------------- your results on the server
  let synced = false;
  /* Results from other devices come here; results only this browser has go to the server. */
  function syncDaily() {
    if (!Account.signedIn() || synced) return;
    synced = true;
    api('GET', '/daily/mine').then(function (j) {
      const srv = j.days || {}, D = window.Daily, mine = D.load().days, up = {};
      D.merge(srv);
      Object.keys(mine).forEach(function (k) {
        const r = mine[k], s = srv[k], ch = F1.dailyChallenge(k);
        if (ch && r.s !== null && (!s || F1.dailyBetter(ch, r.s, s.s) || r.a > s.a)) up[k] = { s: r.s, a: r.a };
      });
      if (Object.keys(up).length) return api('POST', '/daily/sync', { days: up });
    }).then(function () { if (window.DailyUI && $('daily').classList.contains('active')) refreshDaily(); }).catch(function () { synced = false; });
  }
  function refreshDaily() { const ch = window.Daily.today(); if (ch) { window.DailyUI.render(ch); Account.board(ch); } }
  /* After an attempt: your best of the day goes on the board. */
  Account.dailyDone = function (ch) {
    pushStats(false);
    if (!Account.signedIn()) return;
    const r = window.Daily.day(ch.key);
    if (!r || r.s === null) return;
    api('POST', '/daily', { key: ch.key, score: r.s, attempts: r.a }).then(function (b) { Account.lastBoard = b; }).catch(function () { /* (kept here; synced later) */ });
  };
  /* What friends see of you: totals, achievements, daily medals and your best lap on each track. */
  let statsAt = 0;
  function pushStats(now) {
    if (!Account.signedIn() || (!now && Date.now() - statsAt < 30000)) return;
    statsAt = Date.now();
    const C = window.Career.load(), got = window.Ach.got(), D = window.Daily.counts(), pbs = {};
    Object.keys(F1.TRACK_DEFS).forEach(function (id) { const p = window.PB.get(id); if (p) pbs[id] = p.t; });
    api('POST', '/stats', { stats: { time: C.time, races: C.races, wins: C.wins, podiums: C.podiums, titles: C.titles,
      ach: window.Ach.LIST.filter(function (a) { return got[a.id]; }).length, achOf: window.Ach.LIST.length, medals: D.medals, golds: D.golds, pbs: pbs } }).catch(function () {});
  }
  Account.pushStats = pushStats;

  // ------------------------------------------------------------- the board (daily challenge screen)
  function boardRows(list, ch, tb) {
    list.forEach(function (x) {
      const tr = el('tr', x.me ? 'me' : null);
      tr.append(el('td', 'rk', String(x.r)), el('td', 'nm', x.me ? x.n + ' (you)' : x.n), el('td', 'r', F1.dailyFormat(ch, x.s, units()) + (x.m ? ' ' + MEDAL[x.m] : '')));
      tb.appendChild(tr);
    });
  }
  Account.board = function (ch) {
    const box = $('daily-board');
    if (!box) return;
    box.innerHTML = '';
    box.appendChild(el('h3', null, 'Today’s board'));
    if (!Account.on()) {
      box.appendChild(el('p', 'mu', Account.cfg ? 'The board and friends need sign-in, which is not switched on for this game yet.' : 'Loading…'));
      return;
    }
    if (!Account.signedIn()) {
      box.appendChild(el('p', null, 'Sign in to get on the board, and to keep your daily medals and streak on every device.'));
      googleButton(box);
      box.appendChild(el('p', 'mu', 'Your email is never stored or shown. You can play and win medals without signing in.'));
      return;
    }
    const seg = el('div', 'seg board-seg');
    [['all', 'Everyone'], ['friends', 'Friends']].forEach(function (t) {
      const b = el('button', Account.boardTab === t[0] ? 'on' : null, t[1]); b.type = 'button';
      b.addEventListener('click', function () { Account.boardTab = t[0]; Account.board(ch); });
      seg.appendChild(b);
    });
    box.appendChild(seg);
    const table = el('table', 'board'), tb = el('tbody');
    table.appendChild(tb); box.appendChild(table);
    const foot = el('p', 'mu board-foot', 'Loading…');
    box.appendChild(foot);
    api('GET', '/daily?key=' + encodeURIComponent(ch.key)).then(function (b) {
      if (!$('daily-board').contains(table)) return;
      Account.lastBoard = b;
      if (Account.boardTab === 'friends') {
        boardRows(b.friends, ch, tb);
        foot.textContent = b.friends.length ? b.friends.length + (b.friends.length === 1 ? ' of you has' : ' of you have') + ' played today' : 'None of your friends has played today yet.';
        if (!b.friends.length && !b.me) foot.textContent = 'Add friends in Career statistics › Friends.';
      } else {
        boardRows(b.top, ch, tb);
        if (b.me && !b.top.some(function (x) { return x.me; })) {
          const gap = el('tr', 'gap'); gap.appendChild(el('td', null, '…')); tb.appendChild(gap);
          boardRows([{ r: b.me.r, n: Account.me ? Account.me.name : 'You', s: b.me.s, m: b.me.m, me: true }], ch, tb);
        }
        foot.textContent = b.players ? b.players + (b.players === 1 ? ' player today' : ' players today') : 'Nobody has a result yet today: be the first!';
      }
    }).catch(function (e) { foot.textContent = e.message; });
  };

  // ------------------------------------------------------------- friends (Career statistics)
  function ago(t) {
    const m = Math.floor((Date.now() - t) / 60000);
    if (m < 60) return 'Played ' + (m < 2 ? 'just now' : m + ' min ago');
    const d0 = new Date(), d1 = new Date(t), days = Math.round((new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()) - new Date(d1.getFullYear(), d1.getMonth(), d1.getDate())) / 864e5);
    return days === 0 ? 'Played today' : days === 1 ? 'Played yesterday' : 'Played ' + days + ' days ago';
  }
  function status(f) {
    if (f.online && f.room && f.room.open) return f.room.racing ? 'Playing now · racing in an open room' : 'Playing now · in an open room';
    if (f.online && f.room) return 'Playing now · in a private room';
    if (f.online) return 'Online now';
    return ago(f.seen);
  }
  function myStats() {
    const C = window.Career.load(), got = window.Ach.got(), D = window.Daily.counts();
    return { time: C.time, wins: C.wins, titles: C.titles, ach: window.Ach.LIST.filter(function (a) { return got[a.id]; }).length, medals: D.medals };
  }
  function fmtPlayed(s) { const m = Math.floor((s || 0) / 60); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h'; }
  function versus(box, f) {
    box.innerHTML = '';
    const h = el('h3', null, 'You vs ' + f.name);
    const rm = el('button', 'linkbtn', 'Remove friend'); rm.type = 'button';
    rm.addEventListener('click', function () {
      const go = function () {
        api('DELETE', '/friends/' + encodeURIComponent(f.code)).then(function (j) { Account.friends = j.friends; Account.sel = null; Account.renderFriends(); })
          .catch(function (e) { Account.hooks.toast(e.message); });
      };
      if (Account.hooks.confirm) Account.hooks.confirm({ title: 'Remove ' + f.name + '?', text: 'You stop seeing each other’s statistics. You can add each other again with your friend codes.', yes: 'Remove', go: go });
      else go();
    });
    h.appendChild(rm);
    box.appendChild(h);
    const s = f.stats || {}, me = myStats();
    const cards = el('div', 'vs');
    [['Time played', me.time, s.time, fmtPlayed], ['Wins', me.wins, s.wins], ['Championships', me.titles, s.titles], ['Achievements', me.ach, s.ach], ['Daily medals', me.medals, s.medals]].forEach(function (c) {
      const fm = c[3] || String, a = c[1] || 0, b = c[2] || 0, d = el('div', a > b ? 'lead' : null);
      d.append(el('div', 'l', c[0]), el('div', 'y', fm(a)), el('div', 'f', f.name + ' ' + fm(b)));
      cards.appendChild(d);
    });
    box.appendChild(cards);
    if (!f.stats) box.appendChild(el('p', 'mu', f.name + ' has not shared statistics yet: they appear after their next session.'));
    // best laps on the tracks either of you has one
    const pbs = s.pbs || {}, rows = [];
    Object.keys(F1.TRACK_DEFS).forEach(function (id) { const mine = window.PB.get(id), t = mine ? mine.t : null, o = pbs[id] || null; if (t || o) rows.push([id, t, o]); });
    const tw = el('div', 'vs-scroll'), table = el('table', 'board vs-laps'), tb = el('tbody'), hd = el('tr', 'hd');
    hd.append(el('td', null, 'Best laps'), el('td', 'r', 'You'), el('td', 'r', f.name), el('td', 'r', 'Gap'));
    tb.appendChild(hd);
    rows.forEach(function (x) {
      const tr = el('tr'), g = x[1] && x[2] ? x[1] - x[2] : null;
      const gc = el('td', 'r' + (g === null ? '' : g < 0 ? ' faster' : g > 0 ? ' slower' : ''), g === null ? '' : (g < 0 ? '−' : '+') + Math.abs(g).toFixed(3));
      tr.append(el('td', null, F1.TRACK_DEFS[x[0]].name), el('td', 'r', x[1] ? F1.fmtLap(x[1]) : '—'), el('td', 'r', x[2] ? F1.fmtLap(x[2]) : '—'), gc);
      tb.appendChild(tr);
    });
    table.appendChild(tb); tw.appendChild(table); box.appendChild(tw);
    if (!rows.length) box.appendChild(el('p', 'mu', 'No best laps yet on either side.'));
    else box.appendChild(el('p', 'mu small', 'Green: you are faster.'));
  }
  Account.renderFriends = function () {
    const page = $('career-page-friends');
    if (!page) return;
    const left = $('friends-left'), right = $('friends-right');
    left.innerHTML = ''; right.innerHTML = '';
    if (!Account.on()) {
      left.appendChild(el('h3', null, 'Friends'));
      left.appendChild(el('p', 'mu', Account.cfg ? 'Friends need sign-in, which is not switched on for this game yet.' : 'Loading…'));
      canDo(right);
      return;
    }
    if (!Account.signedIn()) {
      left.appendChild(el('h3', null, 'Friends'));
      left.appendChild(el('p', null, 'Sign in to get your friend code and add friends.'));
      googleButton(left);
      left.appendChild(el('p', 'mu', 'Your email is never stored or shown.'));
      canDo(right);
      return;
    }
    left.appendChild(el('h3', null, 'Your friend code'));
    const code = el('div', 'codebig', Account.me ? Account.me.code : '…');
    const cp = el('button', 'btn small', 'Copy'); cp.type = 'button';
    cp.addEventListener('click', function () { copy(Account.me && Account.me.code); });
    code.appendChild(cp);
    left.appendChild(code);
    left.appendChild(el('p', 'mu', 'Send it to a friend. With it, you both see each other’s statistics.'));
    left.appendChild(el('h3', 'sp', 'Add a friend'));
    const row = el('form', 'addrow'), inp = el('input'), add = el('button', 'btn', 'Add');
    inp.placeholder = 'FRIEND CODE'; inp.maxLength = 9; inp.autocomplete = 'off'; inp.id = 'friend-code'; inp.setAttribute('aria-label', 'Friend code');
    add.type = 'submit';
    row.append(inp, add);
    const err = el('p', 'form-err');
    row.addEventListener('submit', function (e) {
      e.preventDefault();
      err.textContent = '';
      api('POST', '/friends', { code: inp.value }).then(function (j) {
        Account.friends = j.friends; inp.value = '';
        Account.hooks.toast('Friend added');
        Account.renderFriends();
      }).catch(function (x) { err.textContent = x.message; });
    });
    left.append(row, err);
    left.appendChild(el('h3', 'sp', 'Friends'));
    const list = el('div', 'flist');
    left.appendChild(list);
    const fl = Account.friends;
    if (!fl) list.appendChild(el('p', 'mu', 'Loading…'));
    else if (!fl.length) list.appendChild(el('p', 'mu', 'No friends yet. Add one with their code, or send them yours.'));
    else fl.forEach(function (f) {
      const r = el('div', 'frow' + (Account.sel === f.code ? ' sel' : ''));
      r.tabIndex = 0; r.setAttribute('role', 'button');
      const dot = el('i', 'dot' + (f.online ? '' : ' off')), nm = el('div', 'nm');
      nm.append(el('b', null, f.name), el('span', null, status(f)));
      r.append(dot, nm);
      if (f.room && f.room.open && f.room.code && !f.room.full) {
        const j = el('button', 'btn small', 'Join'); j.type = 'button';
        j.addEventListener('click', function (e) { e.stopPropagation(); if (Account.hooks.join) Account.hooks.join(f.room.code); });
        r.appendChild(j);
      }
      const pick = function () { Account.sel = f.code; Account.renderFriends(); };
      r.addEventListener('click', pick);
      r.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      list.appendChild(r);
    });
    const sel = fl && (fl.find(function (f) { return f.code === Account.sel; }) || fl[0]);
    if (sel) { Account.sel = sel.code; list.querySelectorAll('.frow').forEach(function (r, i) { r.classList.toggle('sel', fl[i] === sel); }); versus(right, sel); }
    else canDo(right);
  };
  function canDo(box) {
    box.appendChild(el('h3', null, 'With friends you can'));
    const ul = el('ul', 'can');
    ['See each other’s statistics and best laps', 'Join their open online rooms with one tap', 'Compare daily challenge results'].forEach(function (t) { ul.appendChild(el('li', null, t)); });
    box.appendChild(ul);
  }
  let friendsTimer = null;
  /* The Friends tab is open: the list now, and again every 15 seconds (who is playing, which room). */
  Account.openFriends = function () {
    Account.renderFriends();
    clearInterval(friendsTimer);
    if (!Account.signedIn()) return;
    pushStats(false);
    const load1 = function () {
      if (!$('career-page-friends') || $('career-page-friends').classList.contains('hidden') || !$('career').classList.contains('active')) { clearInterval(friendsTimer); return; }
      api('GET', '/friends').then(function (j) {
        const before = JSON.stringify(Account.friends);
        Account.friends = j.friends;
        if (JSON.stringify(j.friends) !== before && !(document.activeElement && document.activeElement.id === 'friend-code')) Account.renderFriends();
      }).catch(function () {});
    };
    load1();
    friendsTimer = setInterval(load1, 15000);
  };
  function copy(t) {
    if (!t) return;
    const ok = function () { Account.hooks.toast('Copied ' + t); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(ok, function () { Account.hooks.toast('Your code: ' + t); });
    else Account.hooks.toast('Your code: ' + t);
  }

  // ------------------------------------------------------------- the Account tab (Settings)
  Account.renderSettings = function () {
    const box = $('set-page-account');
    if (!box) return;
    box.innerHTML = '';
    if (!Account.on()) {
      box.appendChild(el('p', 'note', Account.cfg ? 'Sign-in is not switched on for this game yet. The daily challenge works without it; the board and friends need it.' : 'Loading…'));
      return;
    }
    if (!Account.signedIn()) {
      box.appendChild(el('p', null, 'Sign in with Google to get on the daily challenge board, add friends and keep your daily medals and streak on every device.'));
      googleButton(box);
      box.appendChild(el('p', 'note', 'Your email is never stored or shown: the game keeps only a scrambled form of Google’s account number, your name and your results.'));
      return;
    }
    const who = el('div', 'acct-who'); who.append(el('i', 'dot'), el('b', null, 'Signed in with Google'));
    box.appendChild(who);
    const lab = el('label', 'acct-name');
    lab.appendChild(el('span', null, 'Your name'));
    const inp = el('input'); inp.maxLength = 16; inp.value = Account.me ? Account.me.name : ''; inp.id = 'acct-name'; inp.autocomplete = 'off';
    const save = function () { const v = inp.value.replace(/\s+/g, ' ').trim(); if (v && (!Account.me || v !== Account.me.name)) Account.rename(v); };
    inp.addEventListener('change', save);
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
    lab.appendChild(inp);
    box.appendChild(lab);
    box.appendChild(el('p', 'note', 'Shown on the daily board, to your friends and in online rooms.'));
    const cr = el('div', 'acct-row');
    cr.append(el('span', 'acct-lbl', 'Your friend code'), el('b', 'acct-code', Account.me ? Account.me.code : ''));
    const cp = el('button', 'btn small', 'Copy'); cp.type = 'button'; cp.addEventListener('click', function () { copy(Account.me && Account.me.code); });
    cr.appendChild(cp);
    box.appendChild(cr);
    const br = el('div', 'acct-row acct-btns');
    const so = el('button', 'btn', 'Sign out'); so.type = 'button'; so.addEventListener('click', Account.signOut);
    const del = el('button', 'btn danger', 'Delete my online data'); del.type = 'button'; del.addEventListener('click', Account.deleteData);
    br.append(so, del);
    box.appendChild(br);
    box.appendChild(el('p', 'note', 'Your email is never stored or shown.'));
  };

  /* Sign-in changed (or the server's answer came): every place that shows it. */
  function refreshAll() {
    Account.renderSettings();
    if ($('career') && $('career').classList.contains('active') && $('career-page-friends') && !$('career-page-friends').classList.contains('hidden')) Account.openFriends();
    else Account.renderFriends();
    if ($('daily') && $('daily').classList.contains('active')) { const ch = window.Daily.today(); if (ch) Account.board(ch); }
    if (Account.hooks.changed) Account.hooks.changed();
  }
  Account.refreshAll = refreshAll;
  window.Account = Account;
})();
