/* Ghost car: your best lap on each track, replayed as a see-through car in practice sessions.
   While you drive, your car's position is recorded; whenever you beat the saved ghost lap on that track,
   the lap is saved in this browser (20 samples a second, about 40 KB per track). */
(function () {
  'use strict';
  const RATE = 20;                 // saved samples per second
  const KEEP = 300;                // seconds of driving kept while recording

  const Ghost = {
    key: function (track) { return 'topdowngp.ghost.' + track; },
    load: function (track) {
      try {
        const g = JSON.parse(window.localStorage.getItem(this.key(track)) || 'null');
        return g && g.t > 0 && g.p && g.p.length >= 6 ? g : null;
      } catch (e) { return null; }
    },
    save: function (track, g) {
      try { window.localStorage.setItem(this.key(track), JSON.stringify(g)); return true; } catch (e) { return false; }
    }
  };

  /* Keeps the last few minutes of one car's positions. */
  function Recorder() {
    this.n = 0;
    this.cap = KEEP * 60 + 64;
    this.buf = new Float64Array(this.cap * 4);
    this.head = 0;
  }
  Recorder.prototype.sample = function (time, c) {
    const i = (this.head % this.cap) * 4;
    this.buf[i] = time; this.buf[i + 1] = c.x; this.buf[i + 2] = c.y; this.buf[i + 3] = c.a;
    this.head++;
    if (this.n < this.cap) this.n++;
  };
  /* Position at time t (linear between samples), or null if not recorded. */
  Recorder.prototype.at = function (t) {
    const n = this.n, cap = this.cap, b = this.buf, first = this.head - n;
    let lo = first, hi = this.head - 1;
    if (n < 2 || t < b[(lo % cap) * 4] || t > b[(hi % cap) * 4]) return null;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (b[(mid % cap) * 4] <= t) lo = mid; else hi = mid; }
    const i = (lo % cap) * 4, j = (hi % cap) * 4;
    const f = b[j] > b[i] ? (t - b[i]) / (b[j] - b[i]) : 0;
    let da = b[j + 3] - b[i + 3];
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    return [b[i + 1] + (b[j + 1] - b[i + 1]) * f, b[i + 2] + (b[j + 2] - b[i + 2]) * f, b[i + 3] + da * f];
  };
  /* The lap that ran from t0 to t1 (session time), resampled for saving. */
  Recorder.prototype.lap = function (t0, t1) {
    const p = [];
    for (let k = 0; ; k++) {
      const t = Math.min(t1, t0 + k / RATE);
      const q = this.at(t);
      if (!q) return null;
      p.push(Math.round(q[0] * 100) / 100, Math.round(q[1] * 100) / 100, Math.round(q[2] * 1000) / 1000);
      if (t >= t1) break;
    }
    return p;
  };

  /* Where the ghost is t seconds into its lap: {x, y, a, vx, vy}, or null once its lap is over. */
  function ghostAt(g, t, out) {
    if (t < 0 || t > g.t) return null;
    const p = g.p, n = p.length / 3, f = t * RATE;
    const i = Math.min(n - 2, Math.floor(f)), k = f - i;
    const a = i * 3, b = a + 3;
    let da = p[b + 2] - p[a + 2];
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    out.x = p[a] + (p[b] - p[a]) * k;
    out.y = p[a + 1] + (p[b + 1] - p[a + 1]) * k;
    out.a = p[a + 2] + da * k;
    out.vx = (p[b] - p[a]) * RATE;
    out.vy = (p[b + 1] - p[a + 1]) * RATE;
    return out;
  }

  /* How long the ghost took to reach distance s round the lap (for the live gap in time trial). */
  function ghostTimeAtS(g, T, s) {
    if (!g._s) {
      const n = g.p.length / 3, arr = new Float32Array(n), Q = {};
      let hint = -1, last = 0;
      for (let i = 0; i < n; i++) {
        window.F1.queryTrack(T, g.p[i * 3], g.p[i * 3 + 1], hint, Q);
        hint = Q.idx;
        let v = Q.s;
        if (i < n / 2 && v > T.length * 0.75) v -= T.length;             // just before the line at the start
        else if (i > n / 2 && v < T.length * 0.25) v += T.length;        // just past it at the end
        last = Math.max(last, v);
        arr[i] = last;                                                   // never goes backwards
      }
      g._s = arr;
    }
    const a = g._s, n = a.length;
    if (s <= a[0]) return 0;
    if (s >= a[n - 1]) return g.t;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m] < s) lo = m; else hi = m; }
    const f = a[hi] > a[lo] ? (s - a[lo]) / (a[hi] - a[lo]) : 0;
    return (lo + f) / RATE;
  }

  /* Time trial: your 10 best laps on each track, kept in this browser. */
  const TTBoard = {
    key: 'topdowngp.tt',
    data: null,
    load: function () {
      if (this.data) return this.data;
      try { this.data = JSON.parse(window.localStorage.getItem(this.key) || '{}') || {}; } catch (e) { this.data = {}; }
      return this.data;
    },
    list: function (track) { return (this.load()[track] || []).slice(); },
    /* Returns where the lap lands in your list (1 = your best), or 0 if it is not in the top 10. */
    offer: function (track, t, driverId) {
      const d = this.load(), l = d[track] || (d[track] = []);
      const e = { t: Math.round(t * 1000) / 1000, d: driverId, at: Date.now() };
      l.push(e);
      l.sort(function (a, b) { return a.t - b.t; });
      if (l.length > 10) l.length = 10;
      const rank = l.indexOf(e) + 1;
      if (rank) { try { window.localStorage.setItem(this.key, JSON.stringify(d)); } catch (err) { /* ignore */ } }
      return rank;
    }
  };

  window.Ghost = Ghost;
  window.GhostRecorder = Recorder;
  window.ghostAt = ghostAt;
  window.ghostTimeAtS = ghostTimeAtS;
  window.TTBoard = TTBoard;
})();
