'use strict';
/* Top-Down GP — accounts (version 17): Google sign-in, the daily challenge board and friends.
   Switched on by two settings on the server: DATABASE_URL (a Postgres database, e.g. Neon) and GOOGLE_CLIENT_ID (the
   web client ID from Google). Without them the game works as before: the daily challenge is played without a board,
   and there is no sign-in or friends.
   What is kept for a player: a scrambled form of Google's account number (never the email or the Google name), the
   name shown in the game, a friend code, the daily challenge results, friends, and a summary of the statistics that
   friends can see. "Delete my online data" removes all of it. */
const crypto = require('crypto');

const SESSION_DAYS = 180;          // a sign-in lasts this long without being used
const MAX_FRIENDS = 100;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function cleanName(n) {
  const s = String(n || '').replace(/[\u0000-\u001f\u007f<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s;
}
function cleanCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); }
function showCode(c) { return c.slice(0, 4) + '-' + c.slice(4); }
function newFriendCode() { let c = ''; const b = crypto.randomBytes(8); for (let i = 0; i < 8; i++) c += CODE_CHARS[b[i] % CODE_CHARS.length]; return c; }

/* ---- Google's ID tokens: checked here with Google's public keys (no extra package needed) */
function GoogleCheck(clientId) {
  this.clientId = clientId;
  this.keys = null; this.until = 0; this.loading = null; this.fetched = 0; this.fixed = false;
  const test = process.env.TEST_GOOGLE_JWKS;          // (the tests sign their own tokens)
  if (test) { this.keys = JSON.parse(test).keys; this.until = Infinity; this.fixed = true; }
}
GoogleCheck.prototype.getKeys = function () {
  const self = this;
  if (this.keys && Date.now() < this.until) return Promise.resolve(this.keys);
  if (this.loading) return this.loading;
  const ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 8000);
  this.loading = fetch('https://www.googleapis.com/oauth2/v3/certs', { signal: ctl.signal }).then(function (r) {
    if (!r.ok) throw new Error('Google keys: ' + r.status);
    const m = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
    self.until = Date.now() + Math.min(24 * 3600, m ? Number(m[1]) : 3600) * 1000;
    return r.json();
  }).then(function (j) { self.keys = j.keys || []; self.fetched = Date.now(); return self.keys; }, function (e) {
    // (Google could not be reached: the keys from before are still good for a while)
    if (self.keys) { self.until = Date.now() + 60000; return self.keys; }
    throw e;
  }).finally(function () { clearTimeout(t); self.loading = null; });
  return this.loading;
};
/* The Google account number in a valid ID token for this game (rejects anything else). */
GoogleCheck.prototype.verify = function (token) {
  const self = this;
  return Promise.resolve().then(function () {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || token.length > 4096) throw new Error('bad token');
    const head = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const body = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (head.alg !== 'RS256' || !head.kid) throw new Error('bad token');
    return self.getKeys().then(function (keys) {
      const jwk = keys.find(function (k) { return k.kid === head.kid; });
      // (Google changes its keys now and then: a key not seen yet means fetching them again, at most once a minute)
      if (!jwk) { if (!self.fixed && Date.now() - self.fetched > 60000) self.until = 0; throw new Error('unknown key'); }
      const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'));
      if (!ok) throw new Error('bad signature');
      const now = Date.now() / 1000;
      if (body.iss !== 'accounts.google.com' && body.iss !== 'https://accounts.google.com') throw new Error('bad issuer');
      if (body.aud !== self.clientId) throw new Error('not for this game');
      if (!(body.exp > now - 60) || (body.iat && body.iat > now + 300)) throw new Error('expired');
      if (!body.sub || typeof body.sub !== 'string') throw new Error('no account');
      return body.sub;                     // (only this: the email and the name in the token are not kept)
    });
  });
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tdgp_users (
     id BIGSERIAL PRIMARY KEY,
     gid TEXT UNIQUE NOT NULL,
     name TEXT NOT NULL,
     code TEXT UNIQUE NOT NULL,
     stats JSONB,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     seen_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS tdgp_sessions (
     token TEXT PRIMARY KEY,
     user_id BIGINT NOT NULL REFERENCES tdgp_users(id) ON DELETE CASCADE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     used_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS tdgp_sessions_user ON tdgp_sessions (user_id)`,
  `CREATE TABLE IF NOT EXISTS tdgp_friends (
     a BIGINT NOT NULL REFERENCES tdgp_users(id) ON DELETE CASCADE,
     b BIGINT NOT NULL REFERENCES tdgp_users(id) ON DELETE CASCADE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (a, b))`,
  `CREATE TABLE IF NOT EXISTS tdgp_daily (
     day DATE NOT NULL,
     user_id BIGINT NOT NULL REFERENCES tdgp_users(id) ON DELETE CASCADE,
     score DOUBLE PRECISION NOT NULL,
     medal SMALLINT NOT NULL DEFAULT 0,
     attempts INT NOT NULL DEFAULT 0,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (day, user_id))`,
  `CREATE INDEX IF NOT EXISTS tdgp_daily_day ON tdgp_daily (day, score)`
];

/* app: the Express app; F1: the shared game code; roomOf(socket) -> { code, open, full, racing } or null. */
module.exports = function setupAccounts(app, express, F1, roomOf) {
  const dbUrl = process.env.DATABASE_URL || '', clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  let pg = null;
  try { pg = require('pg'); } catch (e) { pg = null; }
  const A = { ready: false, pool: null, google: clientId ? new GoogleCheck(clientId) : null, online: new Map() };
  const why = !dbUrl ? 'no DATABASE_URL' : !clientId ? 'no GOOGLE_CLIENT_ID' : !pg ? 'the pg package is missing' : null;

  function init() {
    A.pool.query(SCHEMA.join(';\n')).then(function () {
      A.ready = true;
      console.log('Accounts: on (sign-in, daily board, friends)');
      // old sign-ins that have not been used for half a year
      A.pool.query("DELETE FROM tdgp_sessions WHERE used_at < now() - interval '" + SESSION_DAYS + " days'").catch(function () {});
    }).catch(function (e) {
      console.error('Accounts: the database is not reachable (' + e.message + '); trying again in a minute');
      setTimeout(init, 60000);
    });
  }
  if (why) console.log('Accounts: off (' + why + '). The game works without sign-in, the daily board and friends.');
  else {
    A.pool = new pg.Pool({ connectionString: dbUrl, max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 });
    A.pool.on('error', function (e) { console.error('Accounts: database error: ' + e.message); });
    init();
  }
  const q = function (sql, args) { return A.pool.query(sql, args || []); };

  // ---- a light limit on how often each address can call (sign-in and adding friends: tighter)
  const hits = new Map();
  setInterval(function () { hits.clear(); }, 60000).unref();
  function limited(req, kind, max) {
    const k = kind + '|' + (req.ip || req.socket.remoteAddress || '?'), n = (hits.get(k) || 0) + 1;
    hits.set(k, n);
    return n > max;
  }

  const api = express.Router();
  api.use(express.json({ limit: '48kb' }));
  api.use(function (req, res, next) {
    res.set('Cache-Control', 'no-store');
    if (limited(req, 'all', 600)) return res.status(429).json({ error: 'Too many requests: try again in a minute' });
    next();
  });
  /* Whether sign-in is on, and the Google client ID the page needs for the button. */
  api.get('/config', function (req, res) { res.json({ signIn: A.ready && !!A.google, clientId: A.ready ? clientId : null }); });
  api.use(function (req, res, next) {
    if (!A.ready) return res.status(503).json({ error: 'Sign-in is not switched on for this game' });
    next();
  });
  // ---- who is calling (a sign-in token in the Authorization header)
  const seenAt = new Map();
  function who(req) {
    const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.get('authorization') || '');
    if (!m) return Promise.resolve(null);
    const t = sha(m[1]);
    return q('UPDATE tdgp_sessions SET used_at = now() WHERE token = $1 RETURNING user_id', [t]).then(function (r) {
      if (!r.rows.length) return null;
      const id = Number(r.rows[0].user_id);
      if (Date.now() - (seenAt.get(id) || 0) > 10 * 60000) { seenAt.set(id, Date.now()); q('UPDATE tdgp_users SET seen_at = now() WHERE id = $1', [id]).catch(function () {}); }
      return { id: id, token: t };
    });
  }
  function auth(req, res, next) {
    who(req).then(function (u) {
      if (!u) return res.status(401).json({ error: 'Signed out: sign in again' });
      req.user = u; next();
    }).catch(next);
  }
  function me(id) {
    return q('SELECT name, code FROM tdgp_users WHERE id = $1', [id]).then(function (r) {
      return r.rows.length ? { name: r.rows[0].name, code: showCode(r.rows[0].code) } : null;
    });
  }

  // ---- signing in and out
  api.post('/signin', function (req, res, next) {
    if (limited(req, 'signin', 20)) return res.status(429).json({ error: 'Too many sign-ins: try again in a minute' });
    const b = req.body || {};
    A.google.verify(b.credential).then(function (sub) {
      const gid = sha('tdgp|' + sub), name = cleanName(b.name) || 'Driver ' + (100 + crypto.randomInt(900));
      const tryInsert = function (k) {
        return q('INSERT INTO tdgp_users (gid, name, code) VALUES ($1, $2, $3) ON CONFLICT (gid) DO UPDATE SET seen_at = now() RETURNING id',
          [gid, name, newFriendCode()]).catch(function (e) { if (k < 4 && /code/.test(e.detail || e.message)) return tryInsert(k + 1); throw e; });
      };
      return tryInsert(0).then(function (r) {
        const id = Number(r.rows[0].id), token = crypto.randomBytes(32).toString('base64url');
        return q('INSERT INTO tdgp_sessions (token, user_id) VALUES ($1, $2)', [sha(token), id]).then(function () { return me(id); })
          .then(function (m) { res.json({ token: token, me: m }); });
      });
    }, function (e) { res.status(401).json({ error: 'Google sign-in did not work (' + e.message + ')' }); }).catch(next);
  });
  api.post('/signout', auth, function (req, res, next) {
    q('DELETE FROM tdgp_sessions WHERE token = $1', [req.user.token]).then(function () { res.json({ ok: true }); }).catch(next);
  });
  api.get('/me', auth, function (req, res, next) { me(req.user.id).then(function (m) { res.json({ me: m }); }).catch(next); });
  api.post('/me', auth, function (req, res, next) {
    const name = cleanName(req.body && req.body.name);
    if (!name) return res.status(400).json({ error: 'Type a name' });
    q('UPDATE tdgp_users SET name = $2 WHERE id = $1', [req.user.id, name]).then(function () { return me(req.user.id); })
      .then(function (m) { res.json({ me: m }); }).catch(next);
  });
  /* Delete my online data: the account and everything kept with it (the results in this browser stay). */
  api.delete('/me', auth, function (req, res, next) {
    q('DELETE FROM tdgp_users WHERE id = $1', [req.user.id]).then(function () { res.json({ ok: true }); }).catch(next);
  });

  // ---- statistics friends can see
  function cleanStats(s) {
    if (!s || typeof s !== 'object') return null;
    const n = function (v, max) { v = Number(v); return isFinite(v) && v >= 0 ? Math.min(max, Math.round(v * 10) / 10) : 0; };
    const o = { time: n(s.time, 1e8), races: n(s.races, 1e6), wins: n(s.wins, 1e6), podiums: n(s.podiums, 1e6), titles: n(s.titles, 1e5),
      ach: n(s.ach, 1000), achOf: n(s.achOf, 1000), medals: n(s.medals, 1e5), golds: n(s.golds, 1e5), pbs: {} };
    if (s.pbs && typeof s.pbs === 'object') Object.keys(s.pbs).forEach(function (id) {
      const t = Number(s.pbs[id]);
      if (F1.TRACK_DEFS[id] && isFinite(t) && t > 10 && t < 1000) o.pbs[id] = Math.round(t * 1000) / 1000;
    });
    return o;
  }
  api.post('/stats', auth, function (req, res, next) {
    const st = cleanStats(req.body && req.body.stats);
    if (!st) return res.status(400).json({ error: 'No statistics' });
    q('UPDATE tdgp_users SET stats = $2 WHERE id = $1', [req.user.id, JSON.stringify(st)]).then(function () { res.json({ ok: true }); }).catch(next);
  });

  // ---- the daily challenge board
  function keep(user, key, score, attempts) {
    const ch = F1.dailyChallenge(key);
    if (!ch || !F1.dailyPlausible(ch, score)) return Promise.resolve(false);
    const better = ch.better === 'high' ? 'EXCLUDED.score > tdgp_daily.score' : 'EXCLUDED.score < tdgp_daily.score';
    const a = Math.max(1, Math.min(100000, Math.floor(Number(attempts)) || 1));
    return q('INSERT INTO tdgp_daily (day, user_id, score, medal, attempts) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (day, user_id) DO UPDATE SET ' +
      'score = CASE WHEN ' + better + ' THEN EXCLUDED.score ELSE tdgp_daily.score END, medal = GREATEST(tdgp_daily.medal, EXCLUDED.medal), ' +
      'attempts = GREATEST(tdgp_daily.attempts, EXCLUDED.attempts), updated_at = CASE WHEN ' + better + ' THEN now() ELSE tdgp_daily.updated_at END',
    [key, user, score, F1.dailyMedal(ch, score), a]).then(function () { return true; });
  }
  /* { key, players, top: [{ r, n, s, m, me, f }], me: { r, s, m, a } | null, friends: [...] } */
  function board(key, user) {
    const ch = F1.dailyChallenge(key), dir = ch.better === 'high' ? 'DESC' : 'ASC', cmp = ch.better === 'high' ? '>' : '<';
    const out = { key: key, players: 0, top: [], me: null, friends: [] };
    const fr = user ? q('SELECT b FROM tdgp_friends WHERE a = $1', [user]) : Promise.resolve({ rows: [] });
    return fr.then(function (f) {
      const friends = new Set(f.rows.map(function (x) { return Number(x.b); }));
      const row = function (x, r) { const id = Number(x.user_id); return { r: r, n: x.name, s: x.score, m: x.medal, me: id === user, f: friends.has(id) }; };
      return Promise.all([
        q('SELECT count(*)::int AS n FROM tdgp_daily WHERE day = $1', [key]),
        q('SELECT d.user_id, d.score, d.medal, u.name FROM tdgp_daily d JOIN tdgp_users u ON u.id = d.user_id WHERE d.day = $1 ORDER BY d.score ' + dir + ', d.updated_at ASC LIMIT 10', [key]),
        user ? q('SELECT d.score, d.medal, d.attempts, (SELECT count(*)::int FROM tdgp_daily o WHERE o.day = $1 AND o.score ' + cmp + ' d.score) AS better FROM tdgp_daily d WHERE d.day = $1 AND d.user_id = $2', [key, user]) : Promise.resolve({ rows: [] }),
        user ? q('SELECT d.user_id, d.score, d.medal, u.name FROM tdgp_daily d JOIN tdgp_users u ON u.id = d.user_id WHERE d.day = $1 AND (d.user_id = $2 OR d.user_id IN (SELECT b FROM tdgp_friends WHERE a = $2)) ORDER BY d.score ' + dir + ', d.updated_at ASC LIMIT ' + (MAX_FRIENDS + 1), [key, user]) : Promise.resolve({ rows: [] })
      ]).then(function (r) {
        out.players = r[0].rows[0].n;
        let rank = 0, last = null;
        out.top = r[1].rows.map(function (x, i) { if (x.score !== last) { rank = i + 1; last = x.score; } return row(x, rank); });
        if (r[2].rows.length) { const x = r[2].rows[0]; out.me = { r: x.better + 1, s: x.score, m: x.medal, a: x.attempts }; }
        let fr2 = 0, fl = null;
        out.friends = r[3].rows.map(function (x, i) { if (x.score !== fl) { fr2 = i + 1; fl = x.score; } return row(x, fr2); });
        return out;
      });
    });
  }
  api.get('/daily', function (req, res, next) {
    const key = F1.dailyValidKey(req.query.key) ? req.query.key : F1.dailyKey();
    who(req).then(function (u) { return board(key, u ? u.id : null); }).then(function (b) { res.json(b); }).catch(next);
  });
  api.post('/daily', auth, function (req, res, next) {
    const b = req.body || {}, key = String(b.key || '');
    // today's challenge (or yesterday's, for an attempt that ran past midnight)
    const today = F1.dailyKey(), yest = F1.dailyKeyOf(F1.dailyNum(today) - 1);
    if (key !== today && key !== yest) return res.status(400).json({ error: 'That challenge is over' });
    keep(req.user.id, key, Number(b.score), b.attempts).then(function (ok) {
      if (!ok) return res.status(400).json({ error: 'That result could not be kept' });
      return board(key, req.user.id).then(function (x) { res.json(x); });
    }).catch(next);
  });
  /* Your results of the last 90 days (to bring another device up to date), and the ones only this device has. */
  api.get('/daily/mine', auth, function (req, res, next) {
    q("SELECT to_char(day, 'YYYY-MM-DD') AS k, score, attempts FROM tdgp_daily WHERE user_id = $1 AND day > current_date - 90", [req.user.id]).then(function (r) {
      const days = {};
      r.rows.forEach(function (x) { days[x.k] = { s: x.score, a: x.attempts }; });
      res.json({ days: days });
    }).catch(next);
  });
  api.post('/daily/sync', auth, function (req, res, next) {
    const days = (req.body && req.body.days) || {}, today = F1.dailyNum(F1.dailyKey());
    const keys = Object.keys(days).filter(function (k) { return F1.dailyValidKey(k) && F1.dailyNum(k) <= today && F1.dailyNum(k) > today - 90; }).slice(0, 90);
    let p = Promise.resolve();
    keys.forEach(function (k) { const d = days[k]; if (d && typeof d.s === 'number') p = p.then(function () { return keep(req.user.id, k, d.s, d.a); }); });
    p.then(function () { res.json({ ok: true }); }).catch(next);
  });

  // ---- friends
  function friendList(user) {
    return q('SELECT u.id, u.name, u.code, u.stats, extract(epoch FROM u.seen_at) * 1000 AS seen FROM tdgp_friends f JOIN tdgp_users u ON u.id = f.b WHERE f.a = $1 ORDER BY lower(u.name)', [user]).then(function (r) {
      return r.rows.map(function (x) {
        const id = Number(x.id), socks = A.online.get(id);
        let online = false, room = null;
        if (socks) socks.forEach(function (s) { online = true; const ro = roomOf(s); if (ro && (!room || ro.open)) room = ro; });
        return { code: showCode(x.code), name: x.name, seen: Number(x.seen), online: online,
          room: room ? { open: !!room.open, full: !!room.full, racing: !!room.racing, code: room.open ? room.code : null } : null, stats: x.stats || null };
      });
    });
  }
  api.get('/friends', auth, function (req, res, next) { friendList(req.user.id).then(function (l) { res.json({ friends: l }); }).catch(next); });
  api.post('/friends', auth, function (req, res, next) {
    if (limited(req, 'friend', 30)) return res.status(429).json({ error: 'Too many tries: wait a minute' });
    const code = cleanCode(req.body && req.body.code);
    if (code.length !== 8) return res.status(400).json({ error: 'A friend code has 8 letters and numbers' });
    q('SELECT id FROM tdgp_users WHERE code = $1', [code]).then(function (r) {
      if (!r.rows.length) return res.status(404).json({ error: 'No player has that code' });
      const other = Number(r.rows[0].id), mine = req.user.id;
      if (other === mine) return res.status(400).json({ error: 'That is your own code' });
      return q('SELECT count(*)::int AS n FROM tdgp_friends WHERE a = $1', [mine]).then(function (c) {
        if (c.rows[0].n >= MAX_FRIENDS) return res.status(400).json({ error: 'You have ' + MAX_FRIENDS + ' friends already' });
        return q('INSERT INTO tdgp_friends (a, b) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING', [mine, other])
          .then(function () { return friendList(mine); }).then(function (l) { res.json({ friends: l }); });
      });
    }).catch(next);
  });
  api.delete('/friends/:code', auth, function (req, res, next) {
    const code = cleanCode(req.params.code);
    q('DELETE FROM tdgp_friends WHERE (a = $1 AND b = (SELECT id FROM tdgp_users WHERE code = $2)) OR (b = $1 AND a = (SELECT id FROM tdgp_users WHERE code = $2))', [req.user.id, code])
      .then(function () { return friendList(req.user.id); }).then(function (l) { res.json({ friends: l }); }).catch(next);
  });

  api.use(function (err, req, res, next) {     // eslint-disable-line no-unused-vars
    console.error('Accounts: ' + (err && err.message));
    res.status(500).json({ error: 'Something went wrong on the server' });
  });
  app.use('/api', api);

  /* A socket says who it is (signed in): friends see you online, and in which room. */
  A.socket = function (socket) {
    socket.on('hello', function (msg) {
      if (!A.ready || !msg || typeof msg.token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(msg.token)) return;
      const now = Date.now();
      if (now - (socket.data.helloAt || 0) < 2000) return;           // (at most once every 2 seconds)
      socket.data.helloAt = now;
      q('SELECT user_id FROM tdgp_sessions WHERE token = $1', [sha(msg.token)]).then(function (r) {
        if (!r.rows.length || socket.disconnected) return;
        const id = Number(r.rows[0].user_id);
        if (socket.data.uid && socket.data.uid !== id) gone(socket);
        socket.data.uid = id;
        if (!A.online.has(id)) A.online.set(id, new Set());
        A.online.get(id).add(socket);
        q('UPDATE tdgp_users SET seen_at = now() WHERE id = $1', [id]).catch(function () {});
      }).catch(function () {});
    });
    socket.on('bye', function () { gone(socket); });
    socket.on('disconnect', function () { gone(socket); });
  };
  function gone(socket) {
    const id = socket.data.uid;
    if (!id) return;
    const s = A.online.get(id);
    if (s) { s.delete(socket); if (!s.size) A.online.delete(id); }
    socket.data.uid = null;
  }
  return A;
};
