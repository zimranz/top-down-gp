/* Sound: everything is synthesised with the Web Audio API (no sound files).
   - Your engine (Onboard): a V6 modelled from its exhaust pulses (see engine-worklet.js).
   - Your engine (TV camera): the same kind of voice as the other cars, as heard by a camera following you.
   - Other cars: the 4 nearest get their own engine voice, panned left/right with distance and Doppler.
   - Effects: start lights, contact, DRS, pit limiter, chequered flag, fastest lap, personal best, menu clicks.
   Browsers only allow sound after the first click or key press, so everything starts then. */
(function () {
  'use strict';

  const GEARS = [0, 82, 122, 158, 192, 226, 262, 298, 350];   // km/h at each upshift (same as the dashboard)
  const SOUND_C = 343;                                          // speed of sound (Doppler)

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function gearOf(kmh) { let g = 1; while (g < 8 && kmh >= GEARS[g]) g++; return g; }

  /* Engine speed for a road speed: rises through each gear, drops at every upshift. */
  function rpmFor(kmh) {
    if (kmh < 1) return 0;
    const g = gearOf(kmh), lo = GEARS[g - 1], hi = GEARS[g];
    if (g === 1) return 5600 + 6400 * Math.pow(clamp(kmh / hi, 0, 1), 0.85);
    return 10300 + 1900 * clamp((kmh - lo) / (hi - lo), 0, 1.15);
  }

  function distCurve(k) {
    const n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i * 2 / n - 1; c[i] = (1 + k) * x / (1 + k * Math.abs(x)); }
    return c;
  }

  // ------------------------------------------------------------- oscillator engine voice (other cars, TV camera)
  function EngineVoice(A, dest) {
    const ac = A.ac;
    this.A = A;
    this.out = ac.createGain(); this.out.gain.value = 0;
    this.pan = ac.createStereoPanner ? ac.createStereoPanner() : null;
    this.filter = ac.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.frequency.value = 1500; this.filter.Q.value = 1.1;
    this.shaper = ac.createWaveShaper(); this.shaper.curve = distCurve(2.2);
    this.mix = ac.createGain(); this.mix.gain.value = 0.32;
    this.osc = [];
    const parts = [['sawtooth', 1, 0.65], ['square', 0.5, 0.18]];
    for (let i = 0; i < parts.length; i++) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = parts[i][0]; o.frequency.value = 200 * parts[i][1]; g.gain.value = parts[i][2];
      o.connect(g); g.connect(this.mix);
      o.start();
      this.osc.push({ o: o, mul: parts[i][1] });
    }
    // roughness: a fast wobble on the pitch so it does not sound like a synthesiser
    this.lfo = ac.createOscillator(); this.lfo.frequency.value = 19;
    this.lfoG = ac.createGain(); this.lfoG.gain.value = 10;
    this.lfo.connect(this.lfoG);
    for (let i = 0; i < this.osc.length; i++) this.lfoG.connect(this.osc[i].o.detune);
    this.lfo.start();
    this.mix.connect(this.shaper); this.shaper.connect(this.filter); this.filter.connect(this.out);
    if (this.pan) { this.out.connect(this.pan); this.pan.connect(dest); } else this.out.connect(dest);
  }
  /* rpm, throttle 0..1, level 0..1, pan -1..1, doppler factor */
  EngineVoice.prototype.set = function (rpm, thr, level, pan, dop) {
    const t = this.A.ac.currentTime, k = 0.035;
    const f = Math.max(20, (rpm / 20) * (dop || 1));            // V6 firing note = rpm / 60 * 3
    for (let i = 0; i < this.osc.length; i++) this.osc[i].o.frequency.setTargetAtTime(f * this.osc[i].mul, t, k);
    this.filter.frequency.setTargetAtTime(700 + thr * 3000 + rpm * 0.12, t, 0.05);
    this.out.gain.setTargetAtTime(level * (0.5 + 0.5 * thr), t, 0.05);
    if (this.pan) this.pan.pan.setTargetAtTime(clamp(pan || 0, -1, 1), t, 0.05);
  };
  EngineVoice.prototype.silence = function () { this.out.gain.setTargetAtTime(0, this.A.ac.currentTime, 0.08); };

  // ------------------------------------------------------------- the sound system
  const Audio = {
    ac: null, ready: false, active: false, demoing: false,
    vol: { master: 0.8, engine: 0.8, effects: 0.8, muted: false, style: 'onboard' },
    st: null,      // per-session state (edges, timers)

    load: function () {
      const d = window.Settings.data.audio;
      if (d) Object.assign(this.vol, d);
      if (this.vol.style !== 'tv') this.vol.style = 'onboard';
    },
    save: function () {
      window.Settings.data.audio = Object.assign({}, this.vol);
      window.Settings.save();
    },

    /* Create the audio graph on the first user gesture. */
    unlock: function () {
      if (this.ready) { if (this.ac.state === 'suspended' && !document.hidden) this.ac.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ac = this.ac = new AC();
      this.master = ac.createGain();
      this.comp = ac.createDynamicsCompressor();
      this.comp.threshold.value = -12; this.comp.ratio.value = 3.5; this.comp.attack.value = 0.004; this.comp.release.value = 0.2;
      this.master.connect(this.comp); this.comp.connect(ac.destination);
      this.engBus = ac.createGain(); this.engBus.connect(this.master);
      this.fxBus = ac.createGain(); this.fxBus.connect(this.master);
      this.engGate = ac.createGain(); this.engGate.gain.value = 0; this.engGate.connect(this.engBus);   // fades engines in/out
      // 2 s of white noise for the noisy effects
      const len = ac.sampleRate * 2, buf = ac.createBuffer(1, len, ac.sampleRate), ch = buf.getChannelData(0);
      for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
      this.noise = buf;
      this.ownTV = new EngineVoice(this, this.engGate);
      this.others = [];
      for (let i = 0; i < 4; i++) this.others.push({ v: new EngineVoice(this, this.engGate), id: null });
      // the onboard engine runs in the audio thread (needs a secure page: https or localhost)
      this.v6 = null;
      if (ac.audioWorklet && window.isSecureContext !== false) {
        ac.audioWorklet.addModule('js/engine-worklet.js').then(function () {
          const node = new AudioWorkletNode(ac, 'v6-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
          node.connect(Audio.engGate);
          Audio.v6 = node;
          Audio.v6p = { rpm: node.parameters.get('rpm'), thr: node.parameters.get('throttle'), level: node.parameters.get('level') };
        }).catch(function (err) { console.warn('Onboard engine sound unavailable, using TV camera sound', err); });
      }
      this.ready = true;
      this.applyVolumes();
    },

    applyVolumes: function () {
      if (!this.ready) return;
      const t = this.ac.currentTime, v = this.vol;
      this.master.gain.setTargetAtTime(v.muted ? 0 : v.master, t, 0.05);
      this.engBus.gain.setTargetAtTime(v.engine, t, 0.05);
      this.fxBus.gain.setTargetAtTime(v.effects, t, 0.05);
    },
    setVolume: function (key, value) {
      this.vol[key] = value;
      this.applyVolumes();
      this.save();
    },
    setStyle: function (style) {
      this.vol.style = style === 'tv' ? 'tv' : 'onboard';
      this.save();
    },
    onboardAvailable: function () { return !!this.v6; },
    toggleMute: function () {
      this.vol.muted = !this.vol.muted;
      this.applyVolumes();
      this.save();
      return this.vol.muted;
    },

    /* Engines play only while you are actually driving or watching a session (not in menus / pause). */
    setActive: function (on) {
      if (!this.ready || on === this.active) return;
      this.active = on;
      if (!this.demoing) this.engGate.gain.setTargetAtTime(on ? 1 : 0, this.ac.currentTime, on ? 0.12 : 0.06);
    },
    suspend: function (hidden) {
      if (!this.ready) return;
      if (hidden) this.ac.suspend(); else this.ac.resume();
    },
    newSession: function () { this.st = { lights: 0, drsOpen: false, drsAllowed: false, limT: 0, gear: 0, cd: 0 }; },

    /* Your engine: rpm, throttle, gear (gear changes trigger the shift / downshift effects). */
    driveOwn: function (rpm, thr, gear) {
      const t = this.ac.currentTime, st = this.st || (this.st = {});
      const onboard = this.vol.style !== 'tv' && this.v6;
      if (onboard && st.gear && gear !== st.gear) this.v6.port.postMessage(gear > st.gear ? 'shift' : 'down');
      st.gear = gear;
      if (onboard) {
        this.v6p.rpm.setTargetAtTime(rpm, t, 0.01);
        this.v6p.thr.setTargetAtTime(thr, t, 0.012);
        this.v6p.level.setTargetAtTime(1.15, t, 0.05);
        this.ownTV.silence();
      } else {
        this.ownTV.set(rpm, thr, 0.6, 0, 1);
        if (this.v6) this.v6p.level.setTargetAtTime(0, t, 0.05);
      }
    },
    silenceOwn: function () {
      this.ownTV.silence();
      if (this.v6) this.v6p.level.setTargetAtTime(0, this.ac.currentTime, 0.06);
      if (this.st) this.st.gear = 0;
    },

    // ---------------------------------------------------------- per-frame update
    /* s = { listener:{x,y,a,vx,vy}, own:{speed, vf, throttle, inPit, drsOpen, drsAllowed} | null,
             cars:[{id, x, y, vx, vy, throttle}], lights, countdown } */
    update: function (s, dt) {
      if (!this.ready || !this.active || this.demoing) return;
      if (!this.st) this.newSession();
      const st = this.st, t = this.ac.currentTime;
      const L = s.listener;
      // start lights: a beep for each light; qualifying countdown 3-2-1
      if (s.lights > st.lights) this.beep(560, 0.18, 0.32, 'square', 2200);
      st.lights = s.lights || 0;
      if (s.countdown && s.countdown !== st.cd) this.countdown();
      st.cd = s.countdown || 0;
      // your engine
      const own = s.own;
      if (own) {
        const kmh = own.speed * 3.6;
        let rpm = rpmFor(Math.abs(kmh));
        const thr = own.throttle;
        if (kmh < 3) rpm = 4300 + 7200 * thr;                     // revving on the grid / in the box
        if (own.inPit && own.vf > 21.2) rpm = rpm - 350 + 700 * (Math.floor(t * 22) % 2);   // bouncing off the pit limiter
        if (own.vf < -0.5) rpm = 5000 + Math.abs(kmh) * 60;        // reverse
        st.rpm = st.rpm === undefined ? rpm : st.rpm + (rpm - st.rpm) * Math.min(1, dt * 25);
        this.driveOwn(st.rpm, thr, kmh < 3 ? 1 : gearOf(kmh));
        // DRS
        if (own.drsOpen && !st.drsOpen) this.drsClack();
        else if (own.drsAllowed && !st.drsAllowed && !own.drsOpen) { this.beep(1320, 0.06, 0.2, 'sine'); this.beep(1320, 0.06, 0.2, 'sine', 0, 0.1); }
        st.drsOpen = own.drsOpen; st.drsAllowed = own.drsAllowed;
        // pit limiter beeps
        if (own.inPit) {
          st.limT -= dt;
          if (st.limT <= 0) { this.beep(980, 0.07, 0.14, 'square', 3000); st.limT = 0.5; }
        } else st.limT = 0;
      } else this.silenceOwn();
      // other cars: the four nearest
      const near = [];
      for (let i = 0; i < s.cars.length; i++) {
        const c = s.cars[i];
        const dx = c.x - L.x, dy = c.y - L.y, d2 = dx * dx + dy * dy;
        if (d2 < 260 * 260) near.push({ c: c, d2: d2 });
      }
      near.sort(function (a, b) { return a.d2 - b.d2; });
      const keep = near.slice(0, 4);
      const voices = this.others;
      // keep voices on the same car where possible
      for (let v = 0; v < voices.length; v++) {
        const vo = voices[v];
        if (vo.id !== null && !keep.some(function (k) { return k.c.id === vo.id; })) vo.id = null;
      }
      for (let k = 0; k < keep.length; k++) {
        const c = keep[k].c;
        let vo = voices.find(function (x) { return x.id === c.id; });
        if (!vo) { vo = voices.find(function (x) { return x.id === null; }); if (!vo) continue; vo.id = c.id; }
        const dx = c.x - L.x, dy = c.y - L.y, dist = Math.sqrt(keep[k].d2);
        // pan by where the car is on screen (left / right of the way you are facing)
        const side = -dx * Math.sin(L.a) + dy * Math.cos(L.a);
        const pan = clamp(side / 40, -0.9, 0.9);
        // Doppler: closing speed along the line between the cars
        let vr = 0;
        if (dist > 0.5) vr = -((c.vx - (L.vx || 0)) * dx + (c.vy - (L.vy || 0)) * dy) / dist;
        const dop = clamp(SOUND_C / (SOUND_C - clamp(vr, -120, 120)), 0.7, 1.5);
        const level = 0.5 * Math.min(1, 14 / Math.max(14, dist)) * (own ? 0.75 : 1.2);
        const kmh = Math.hypot(c.vx, c.vy) * 3.6;
        vo.v.set(kmh < 3 ? 4300 + 6500 * (c.throttle || 0) : rpmFor(kmh), c.throttle === undefined ? 0.7 : c.throttle, level, pan, dop);
        vo.used = true;
      }
      for (let v = 0; v < voices.length; v++) { if (!voices[v].used) { voices[v].v.silence(); voices[v].id = null; } voices[v].used = false; }
    },

    /* "Test engine" in Settings: launch, up through the gears, lift off, back down. */
    demo: function () {
      this.unlock();
      if (!this.ready || this.demoing) return;
      const self = this, t0 = performance.now();
      this.demoing = true;
      this.st = { gear: 0 };
      for (let i = 0; i < this.others.length; i++) this.others[i].v.silence();
      this.engGate.gain.setTargetAtTime(1, this.ac.currentTime, 0.05);
      let kmh = 0;
      const timer = setInterval(function () {
        const t = (performance.now() - t0) / 1000;
        let thr = 0, rpm;
        if (t < 0.9) { thr = 0; rpm = 4300; }
        else if (t < 1.6) { thr = t < 1.25 ? 0.9 : 0.15; rpm = 4300 + 7000 * thr; }    // blip on the grid
        else if (t < 6.4) { thr = 1; kmh = Math.min(330, kmh + (kmh < 100 ? 3.2 : kmh < 200 ? 2.2 : 1.3)); }
        else if (t < 9.0) { thr = 0; kmh = Math.max(80, kmh - 4.4); }                    // brake, downshifts
        else if (t < 9.8) { thr = 0.6; }
        if (t >= 1.6) rpm = rpmFor(kmh);
        self.driveOwn(rpm, thr, t >= 1.6 ? gearOf(kmh) : 1);
        if (t > 10.2) {
          clearInterval(timer);
          self.demoing = false;
          self.silenceOwn();
          if (!self.active) self.engGate.gain.setTargetAtTime(0, self.ac.currentTime, 0.3);
        }
      }, 30);
    },

    // ---------------------------------------------------------- one-shots
    env: function (g, t0, peak, attack, decay) {
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    },
    beep: function (freq, dur, vol, type, lp, delay, glideTo) {
      if (!this.ready) return;
      const ac = this.ac, t0 = ac.currentTime + (delay || 0);
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t0);
      if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
      let node = o;
      if (lp) { const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; o.connect(f); node = f; }
      node.connect(g); g.connect(this.fxBus);
      this.env(g, t0, vol, 0.004, dur);
      o.start(t0); o.stop(t0 + dur + 0.05);
    },
    noiseHit: function (type, freq, q, vol, dur, delay) {
      if (!this.ready) return;
      const ac = this.ac, t0 = ac.currentTime + (delay || 0);
      const src = ac.createBufferSource(); src.buffer = this.noise;
      const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ac.createGain();
      src.connect(f); f.connect(g); g.connect(this.fxBus);
      this.env(g, t0, vol, 0.003, dur);
      src.start(t0, Math.random() * 1.5); src.stop(t0 + dur + 0.05);
    },
    /* Menu clicks: 'go' for the big red buttons, 'back' for leaving a screen, 'tap' for everything else. */
    click: function (kind) {
      this.unlock();
      if (!this.ready) return;
      if (kind === 'go') {
        this.beep(620, 0.09, 0.42, 'triangle', 0, 0);
        this.beep(930, 0.16, 0.4, 'triangle', 0, 0.07);
      } else if (kind === 'back') {
        this.beep(760, 0.08, 0.38, 'triangle', 0, 0);
        this.beep(500, 0.13, 0.36, 'triangle', 0, 0.06);
      } else {
        this.beep(1250, 0.07, 0.45, 'triangle', 0, 0, 700);
        this.noiseHit('highpass', 3200, 0.7, 0.22, 0.015);
      }
    },
    drsClack: function () {
      this.noiseHit('highpass', 2500, 0.8, 0.3, 0.05);
      this.beep(190, 0.08, 0.35, 'triangle');
      this.noiseHit('bandpass', 700, 0.5, 0.15, 0.35, 0.03);   // the rush of air with the flap open
    },
    /* Car contact or wall hit: a carbon crunch and a thud, louder the harder and closer it is. */
    contact: function (power, dist) {
      if (!this.ready || !this.active) return;
      const k = clamp(Math.log(power / 1200) / Math.log(12), 0.08, 1) * Math.min(1, 25 / Math.max(25, dist || 0));
      if (k < 0.03) return;
      const ac = this.ac, t0 = ac.currentTime;
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(150, t0); o.frequency.exponentialRampToValueAtTime(45, t0 + 0.18);
      o.connect(g); g.connect(this.fxBus);
      this.env(g, t0, 0.9 * k, 0.004, 0.2);
      o.start(t0); o.stop(t0 + 0.3);
      this.noiseHit('bandpass', 1800 + Math.random() * 1200, 0.8, 0.8 * k, 0.12 + 0.12 * k);
      if (k > 0.45) this.noiseHit('highpass', 5000, 0.7, 0.35 * k, 0.25, 0.02);   // bits of carbon
    },
    lightsOut: function () { this.beep(1046, 0.14, 0.3, 'square', 3500); },
    go: function () { this.beep(880, 0.25, 0.3, 'square', 3000); },
    countdown: function () { this.beep(560, 0.16, 0.3, 'square', 2200); },
    chime: function (notes, vol, spacing) {
      for (let i = 0; i < notes.length; i++) {
        this.beep(notes[i], 0.5, vol, 'sine', 0, i * spacing);
        this.beep(notes[i] * 2, 0.3, vol * 0.3, 'sine', 0, i * spacing);     // a bell-like overtone
      }
    },
    fastestLap: function (mine) { this.chime(mine ? [784, 988, 1319] : [988, 1319], mine ? 0.26 : 0.12, 0.09); },
    personalBest: function () { this.chime([659, 880], 0.25, 0.11); },
    chequered: function () {
      const seq = [523, 659, 784, 1046];
      for (let i = 0; i < seq.length; i++) this.beep(seq[i], i === 3 ? 0.6 : 0.16, 0.24, 'triangle', 0, i * 0.13);
      this.beep(1568, 0.6, 0.09, 'sine', 0, 0.39);
    },

    /* Session events (lights out, laps, finish). */
    event: function (e, myId) {
      if (!this.ready || !this.active) return;
      if (e.k === 'lightsOut') this.lightsOut();
      else if (e.k === 'go') this.go();
      else if (e.k === 'lap') {
        if (e.id === myId && e.record) this.personalBest();
        if (e.fastest) this.fastestLap(e.id === myId);
      } else if (e.k === 'finish' && e.id === myId) this.chequered();
      else if (e.k === 'chequered' && myId === null) this.chequered();
    }
  };

  // sound starts on the first click or key press (browser rule)
  const unlock = function () { Audio.unlock(); };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);

  Audio.rpmFor = rpmFor;
  window.GameAudio = Audio;
})();
