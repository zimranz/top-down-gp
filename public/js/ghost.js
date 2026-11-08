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

  window.Ghost = Ghost;
  window.GhostRecorder = Recorder;
  window.ghostAt = ghostAt;
})();
