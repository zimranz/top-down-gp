/* Onboard F1 engine sound (runs in the audio thread as an AudioWorklet).
   A 1.6 litre V6 fires 6 cylinders every 2 revolutions. Each firing sends a pressure pulse down the
   exhaust; the sound you hear is that pulse train ringing through the pipes. So instead of oscillators:
   - every cylinder makes its own pulse, with tiny random differences from one firing to the next
     (that is what makes a real engine sound alive rather than like a synthesiser),
   - the two cylinder banks run into their own manifold, then one shared tailpipe; each pipe is a
     resonator with a fixed length, so the tone changes naturally as the revs sweep through them,
   - on the throttle the pulses are harder and noisier; off the throttle the combustion fades,
     you hear air and crackles; every upshift cuts the ignition for a split second.
   The DSP core (V6Core) is plain JavaScript so it can also be tested outside the browser. */
(function (scope) {
  'use strict';

  function Comb(len, g, a, b) {
    this.buf = new Float32Array(8192); this.i = 0;
    this.L = len; this.g = g; this.a = a; this.b = b;
  }
  Comb.prototype.tick = function (x) {
    const m = 8191, i = this.i;
    const y = x + this.g * (this.a * this.buf[(i - this.L) & m] + this.b * this.buf[(i - this.L - 1) & m]);
    this.buf[i] = y; this.i = (i + 1) & m;
    return y;
  };

  function V6Core(sr) {
    this.sr = sr;
    this.phase = 0;
    this.rpm = 4300; this.thr = 0; this.level = 0; this.thrS = 0; this.levelS = 0;
    // cylinder offsets within the 720 degree cycle (even firing every 120 degrees) plus small fixed
    // differences in timing and strength between cylinders: these give the V6 its growl
    this.off = [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6];
    this.tOff = [0, 0.0042, -0.0031, 0.0058, -0.0019, 0.0027];
    this.cg = [1.0, 1.03, 0.95, 0.97, 1.05, 1.0];      // both banks equally strong overall
    this.last = new Float32Array(6).fill(0.9999);
    this.amp = new Float32Array(6).fill(1);
    this.jit = new Float32Array(6);
    // pulse shapes (one firing slot = 1 unit), soft (off throttle) and hard (on throttle)
    this.TN = 2048; this.TMAX = 1.6;
    this.tabSoft = this.table(16, 6.5, [1, 0.3, 0.1, 0.04], 0.92);
    this.tabHard = this.table(40, 4.2, [1, 0.62, 0.42, 0.22, 0.12], 0.88);
    this.tabEnv = this.table(30, 5, null, 1);
    // pipes: two manifolds (one per bank, slightly different lengths) and the tailpipe after the turbo
    const L = function (metres) { return Math.round(sr * 2 * metres / 343); };
    this.resA = new Comb(L(0.55), 0.56, 0.66, 0.34);
    this.resB = new Comb(L(0.58), 0.56, 0.66, 0.34);
    this.resT = new Comb(L(1.12), 0.42, 0.55, 0.45);
    this.resI = new Comb(L(0.33), 0.5, 0.7, 0.3);      // airbox above the driver's head
    // filters
    this.lp = { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0, x1: 0, x2: 0, y1: 0, y2: 0, fc: 0 };
    this.nlp = 0; this.nlp2 = 0; this.ilp = 0; this.hpx = 0; this.hpy = 0;
    this.seed = 22222;
    // events
    this.cut = 0; this.cutG = 1;
    this.over = 0; this.pop = 0; this.popPending = 0; this.popProb = 0;
    this.turboPh = 0;
    this.blockFc = -1;
  }
  V6Core.prototype.rand = function () {   // xorshift, -1..1
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x >>> 0;
    return (this.seed / 4294967296) * 2 - 1;
  };
  V6Core.prototype.table = function (A, B, harm, nu) {
    const n = this.TN, t = new Float32Array(n + 2);
    let peak = 0;
    for (let k = 0; k <= n + 1; k++) {
      const u = (k / n) * this.TMAX;
      let env = (1 - Math.exp(-A * u)) * Math.exp(-B * u);
      if (u > this.TMAX - 0.2) env *= Math.max(0, (this.TMAX - u) / 0.2);   // fade to zero at the end
      let v = env;
      if (harm) {
        const ub = Math.pow(u, nu);                // the pulse sweeps down a little in pitch
        let s = 0;
        for (let h = 0; h < harm.length; h++) s += harm[h] * Math.sin(2 * Math.PI * (h + 1) * ub + h * 0.6);
        v = env * s;
      }
      t[k] = v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    for (let k = 0; k < t.length; k++) t[k] /= peak;
    return t;
  };
  V6Core.prototype.setLP = function (fc) {
    const f = this.lp, w = 2 * Math.PI * fc / this.sr, q = 0.7;
    const c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    f.b0 = (1 - c) / 2 / a0; f.b1 = (1 - c) / a0; f.b2 = f.b0; f.a1 = -2 * c / a0; f.a2 = (1 - al) / a0; f.fc = fc;
  };
  // upshift: ignition cut for 28 ms, then a crack; downshift: a couple of pops
  V6Core.prototype.shift = function () { this.cut = Math.round(this.sr * 0.028); this.popPending = 1; this.popProb = 0.05; };
  V6Core.prototype.down = function () { this.over = Math.max(this.over, 0.35); this.popPending = 2; this.popProb = 1 / (0.035 * this.sr); };

  /* Fill out[0..n) for rpm going from rpm0 to rpm1 over the block, throttle 0..1, level. */
  V6Core.prototype.render = function (out, n, rpm0, rpm1, thr, level) {
    const sr = this.sr, TN = this.TN, scale = TN / this.TMAX;
    const ts = this.tabSoft, th = this.tabHard, te = this.tabEnv;
    const fc = 1800 + 2600 * thr + Math.min(1, rpm1 / 12000) * 900;
    if (Math.abs(fc - this.lp.fc) > 20) this.setLP(fc);
    const f = this.lp;
    // the moment you lift at high revs: crackles for a while (fuel cut / anti-lag)
    if (this.thrS > 0.5 && thr < 0.15 && rpm1 > 8000) this.over = 0.75;
    for (let s = 0; s < n; s++) {
      const rpm = rpm0 + (rpm1 - rpm0) * (s / n);
      this.thrS += (thr - this.thrS) * 0.0016;
      this.levelS += (level - this.levelS) * 0.002;
      const tq = this.thrS;
      this.phase += rpm / 120 / sr;
      if (this.phase >= 1) this.phase -= 1;
      const fire = 0.22 + 0.78 * Math.pow(tq, 0.7);        // combustion strength
      const rough = 0.5 + tq;
      let bankA = 0, bankB = 0, env = 0;
      for (let i = 0; i < 6; i++) {
        let u = this.phase - this.off[i] - this.tOff[i];
        u -= Math.floor(u);
        if (u < this.last[i]) {                           // this cylinder just fired: a new pulse
          this.amp[i] = this.cg[i] * (1 + this.rand() * 0.075 * rough);
          this.jit[i] = this.rand() * 0.0022 * rough;
        }
        this.last[i] = u;
        const us = (u - this.jit[i]) * 6;
        if (us <= 0 || us >= this.TMAX) continue;
        const x = us * scale, k = x | 0, fr = x - k;
        const a = ts[k] + (ts[k + 1] - ts[k]) * fr, b = th[k] + (th[k + 1] - th[k]) * fr;
        const p = (a + (b - a) * tq) * this.amp[i];
        if (i & 1) bankB += p; else bankA += p;
        env += (te[k] + (te[k + 1] - te[k]) * fr) * this.amp[i];
      }
      // turbulence: noise that rides on each pulse (harsher with more throttle)
      const w = this.rand();
      this.nlp += (w - this.nlp) * 0.35;
      this.nlp2 += (this.nlp - this.nlp2) * 0.08;
      const turb = this.nlp - this.nlp2;
      bankA = bankA * fire * (1 + 0.55 * tq * turb) + turb * env * fire * 0.22;
      bankB = bankB * fire * (1 + 0.55 * tq * turb) + turb * env * fire * 0.22;
      // overrun crackles and pops
      let pop = 0;
      if (this.popPending > 0 && this.cut <= 0 && (this.rand() + 1) * 0.5 < this.popProb) { this.pop = 0.75 + 0.25 * this.rand(); this.popPending--; }
      if (this.over > 0) {
        this.over -= 1 / sr;
        if (tq < 0.3 && rpm > 6500 && this.rand() > 1 - 2 * 22 * (rpm - 6000) / 6000 / sr) this.pop = 0.5 + 0.5 * Math.abs(this.rand());
      }
      if (this.pop > 0.002) { pop = this.pop * w; this.pop *= 0.9965; }
      // manifolds, turbo (muffles the top end), tailpipe
      const yA = this.resA.tick(bankA), yB = this.resB.tick(bankB);
      const x0 = (yA + yB) * 0.5;
      const y = f.b0 * x0 + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
      f.x2 = f.x1; f.x1 = x0; f.y2 = f.y1; f.y1 = y;
      const tail = this.resT.tick(y * 0.55 + pop * 0.8);
      // intake roar from the airbox
      this.ilp += (env * turb * (0.3 + 0.7 * tq) - this.ilp) * 0.06;
      const intake = this.resI.tick(this.ilp + env * fire * 0.05);
      let o = 0.42 * y + 0.5 * tail + 0.35 * intake + pop * 0.25;
      // turbo / MGU-H whistle
      this.turboPh += (2300 + rpm * 0.38) / sr;
      if (this.turboPh > 1) this.turboPh -= 1;
      o += Math.sin(2 * Math.PI * this.turboPh) * 0.012 * tq * tq * Math.min(1, rpm / 9000);
      // ignition cut on an upshift
      if (this.cut > 0) { this.cut--; this.cutG += (0.06 - this.cutG) * 0.05; } else this.cutG += (1 - this.cutG) * 0.003;
      o *= this.cutG;
      // a bit of grit, then remove any DC
      o = Math.tanh(o * (1.1 + 0.9 * tq)) * 0.8;
      const hp = o - this.hpx + 0.997 * this.hpy;
      this.hpx = o; this.hpy = hp;
      out[s] = hp * this.levelS;
    }
  };

  if (typeof registerProcessor === 'function') {
    class V6Engine extends AudioWorkletProcessor {
      static get parameterDescriptors() {
        return [
          { name: 'rpm', defaultValue: 4300, minValue: 0, maxValue: 16000, automationRate: 'k-rate' },
          { name: 'throttle', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
          { name: 'level', defaultValue: 0, minValue: 0, maxValue: 2, automationRate: 'k-rate' }
        ];
      }
      constructor() {
        super();
        this.core = new V6Core(sampleRate);
        this.prevRpm = 4300;
        const self = this;
        this.port.onmessage = function (e) { if (e.data === 'shift') self.core.shift(); else if (e.data === 'down') self.core.down(); };
      }
      process(inputs, outputs, params) {
        const out = outputs[0];
        if (!out || !out[0]) return true;
        const rpm = params.rpm[0];
        this.core.render(out[0], out[0].length, this.prevRpm, rpm, params.throttle[0], params.level[0]);
        this.prevRpm = rpm;
        for (let c = 1; c < out.length; c++) out[c].set(out[0]);
        return true;
      }
    }
    registerProcessor('v6-engine', V6Engine);
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = V6Core;
  }
})(this);
