/* Sound: everything is synthesised with the Web Audio API (no sound files).
   - Your engine (Onboard): a V6 modelled from its exhaust pulses (see engine-worklet.js).
   - Your engine (TV camera): the same kind of voice as the other cars, as heard by a camera following you.
   - Other cars: the 4 nearest get their own engine voice, panned left/right with distance and Doppler.
   - Effects: start lights, contact, DRS, pit limiter, chequered flag, fastest lap, personal best, menu clicks.
   - Rain: a soft bed of rain (louder in heavy rain) and the hiss of spray off your tyres and the cars around you.
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
    vol: { master: 0.8, engine: 0.68, effects: 0.8, muted: false, style: 'onboard', engineV: 2 },
    st: null,      // per-session state (edges, timers)

    load: function () {
      const d = window.Settings.data.audio;
      if (d) {
        Object.assign(this.vol, d);
        // (13.1: the engines are 15% quieter by default. Sound settings saved before then with the engines left at the
        // old default, 80, get the new one, 68; a level of your own choosing is kept.)
        if (d.engineV !== 2 && Math.abs(Number(d.engine) - 0.8) < 0.001) this.vol.engine = 0.68;
      }
      this.vol.engineV = 2;
      this.vol.muted = this.vol.muted === true;
      if (this.vol.style !== 'tv') this.vol.style = 'onboard';
    },
    /* Pick up the saved sound settings again (another tab changed them, or the page came back from the browser's cache). */
    reload: function () {
      window.Settings.load();
      this.load();
      this.applyVolumes(true);
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
      this.master.gain.value = this.vol.muted ? 0 : this.vol.master;     // muted from the very first sound
      this.comp = ac.createDynamicsCompressor();
      this.comp.threshold.value = -12; this.comp.ratio.value = 3.5; this.comp.attack.value = 0.004; this.comp.release.value = 0.2;
      this.master.connect(this.comp); this.comp.connect(ac.destination);
      this.engBus = ac.createGain(); this.engBus.gain.value = this.vol.engine; this.engBus.connect(this.master);
      this.fxBus = ac.createGain(); this.fxBus.gain.value = this.vol.effects; this.fxBus.connect(this.master);
      // some browsers drop volume changes made while the sound is paused: set them again whenever it starts
      ac.onstatechange = function () { if (ac.state === 'running') Audio.applyVolumes(true); };
      this.engGate = ac.createGain(); this.engGate.gain.value = 0; this.engGate.connect(this.engBus);   // fades engines in/out
      this.wxGate = ac.createGain(); this.wxGate.gain.value = 0; this.wxGate.connect(this.fxBus);      // rain / spray, same fades
      this.wx = null;
      // 2 s of white noise for the noisy effects
      const len = ac.sampleRate * 2, buf = ac.createBuffer(1, len, ac.sampleRate), ch = buf.getChannelData(0);
      for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
      this.noise = buf;
      setTimeout(function () { Audio.rainPrep(); }, 3000);         // (the rain sound, made ahead of time: see rainPrep)
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

    /* now: set at once (start-up, sound restarting) instead of a quick fade */
    applyVolumes: function (now) {
      if (!this.ready) return;
      const ac = this.ac, t = ac.currentTime, v = this.vol, at = now || ac.state !== 'running';
      const set = function (param, value) {
        param.cancelScheduledValues(t);
        if (at) { param.value = value; param.setValueAtTime(value, t); }
        else { param.setValueAtTime(param.value, t); param.setTargetAtTime(value, t, 0.03); }
      };
      set(this.master.gain, v.muted ? 0 : v.master);
      set(this.engBus.gain, v.engine);
      set(this.fxBus.gain, v.effects);
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
    toggleMute: function () { return this.setMuted(!this.vol.muted); },
    setMuted: function (on) {
      this.vol.muted = !!on;
      this.applyVolumes();
      this.save();
      return this.vol.muted;
    },

    /* Engines play only while you are actually driving or watching a session (not in menus / pause). */
    setActive: function (on) {
      if (!this.ready || on === this.active) return;
      this.active = on;
      if (!this.demoing) this.engGate.gain.setTargetAtTime(on ? 1 : 0, this.ac.currentTime, on ? 0.12 : 0.06);
      this.wxGate.gain.setTargetAtTime(on ? 1 : 0, this.ac.currentTime, on ? 0.25 : 0.06);
    },
    suspend: function (hidden) {
      if (!this.ready) return;
      if (hidden) this.ac.suspend(); else this.ac.resume();
    },
    newSession: function () { this.st = { lights: 0, drsOpen: false, drsAllowed: false, limT: 0, gear: 0, cd: 0 }; if (this.wx) this.wxStop(); },

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
             cars:[{id, x, y, vx, vy, throttle}], lights, countdown, wx:{rain, wet} | null } */
    update: function (s, dt) {
      if (!this.ready || !this.active || this.demoing) return;
      if (!this.st) this.newSession();
      const st = this.st, t = this.ac.currentTime;
      const L = s.listener;
      // start lights: a beep for each light; qualifying countdown 3-2-1
      if (s.lights > st.lights) this.lightOn(s.lights);
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
      this.weatherSound(s, dt, own, keep);
    },

    // ---------------------------------------------------------- rain and spray
    /* The rain itself: a stereo loop, 4.6 s long (a soft wash with droplets in it). Made once, a few seconds after the
       sound starts, a little at a time (made all at once just as the rain began, it held the whole game up for a
       moment: picture and engine sound), and kept for the rest of the visit. */
    rainPrep: function () {
      if (this.rainBuf || this.rainWork || !this.ready) return;
      const ac = this.ac, sr = ac.sampleRate, len = Math.floor(sr * 4.6), buf = ac.createBuffer(2, len, sr);
      const steps = [], PIECE = Math.floor(sr * 0.2);
      for (let chn = 0; chn < 2; chn++) {
        const d = buf.getChannelData(chn), st = { b0: 0, b1: 0, b2: 0, sum: 0, g: 1 };
        for (let a = 0; a < len; a += PIECE) steps.push(function () {              // the wash: soft (pink) noise
          const e = Math.min(len, a + PIECE);
          let b0 = st.b0, b1 = st.b1, b2 = st.b2;
          for (let i = a; i < e; i++) {
            const w = Math.random() * 2 - 1;
            b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
            d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.5;
          }
          st.b0 = b0; st.b1 = b1; st.b2 = b2;
        });
        const drops = Math.floor(len / sr * 320);    // droplets: short ticks, mostly small, now and then a bigger one
        for (let k0 = 0; k0 < drops; k0 += 150) steps.push(function () {
          for (let k = k0; k < Math.min(drops, k0 + 150); k++) {
            const at = Math.floor(Math.random() * len), a = 0.6 + 3.2 * Math.pow(Math.random(), 3), dec = sr * (0.0015 + Math.random() * 0.005);
            for (let j = 0; j < dec * 5 && at + j < len; j++) d[at + j] += a * (Math.random() * 2 - 1) * Math.exp(-j / dec);
          }
        });
        for (let a = 0; a < len; a += PIECE * 3) steps.push(function () {
          const e = Math.min(len, a + PIECE * 3);
          let sum = 0;
          for (let i = a; i < e; i++) sum += d[i] * d[i];
          st.sum += sum;
        });
        steps.push(function () { st.g = 0.25 / Math.sqrt(st.sum / len); });       // same loudness every time
        for (let a = 0; a < len; a += PIECE * 3) steps.push(function () {
          const e = Math.min(len, a + PIECE * 3);
          for (let i = a; i < e; i++) d[i] *= st.g;
        });
        steps.push(function () {                                                  // no click where the loop joins
          const fade = Math.floor(sr * 0.02);
          for (let i = 0; i < fade; i++) { const t = i / fade; d[len - fade + i] = d[len - fade + i] * (1 - t) + d[i] * t; }
        });
      }
      const self = this, work = this.rainWork = { steps: steps, i: 0, buf: buf };
      const tick = function () {
        if (self.rainWork !== work) return;
        const t0 = performance.now();
        while (work.i < steps.length && performance.now() - t0 < 4) steps[work.i++]();     // (about 4 ms at a time)
        if (work.i < steps.length) setTimeout(tick, 25);
        else { self.rainBuf = buf; self.rainWork = null; }
      };
      setTimeout(tick, 0);
    },
    /* The rain is needed now: whatever is left of it is made at once (normally nothing is). */
    rainReady: function () {
      if (this.rainBuf) return this.rainBuf;
      if (!this.rainWork) this.rainPrep();
      const w = this.rainWork;
      while (w.i < w.steps.length) w.steps[w.i++]();
      this.rainBuf = w.buf; this.rainWork = null;
      return this.rainBuf;
    },
    /* The sounds of a wet session, set up the first time it rains in it: the rain loop, and spray hiss for your car
       and for the 4 nearest cars (each panned and pitched like their engines). */
    wxBuild: function () {
      const ac = this.ac, buf = this.rainReady();
      const W = { dry: 0 };
      W.rainSrc = ac.createBufferSource(); W.rainSrc.buffer = buf; W.rainSrc.loop = true;
      W.rainHP = ac.createBiquadFilter(); W.rainHP.type = 'highpass'; W.rainHP.frequency.value = 380; W.rainHP.Q.value = 0.5;
      W.rainLP = ac.createBiquadFilter(); W.rainLP.type = 'lowpass'; W.rainLP.frequency.value = 6000; W.rainLP.Q.value = 0.5;
      W.rainG = ac.createGain(); W.rainG.gain.value = 0;
      W.rainSrc.connect(W.rainHP); W.rainHP.connect(W.rainLP); W.rainLP.connect(W.rainG); W.rainG.connect(this.wxGate);
      W.rainSrc.start();
      const self = this;
      const hiss = function (panned) {
        const h = { id: null };
        h.src = ac.createBufferSource(); h.src.buffer = self.noise; h.src.loop = true;
        h.f = ac.createBiquadFilter(); h.f.type = 'bandpass'; h.f.frequency.value = 2000; h.f.Q.value = 0.55;
        h.g = ac.createGain(); h.g.gain.value = 0;
        h.src.connect(h.f); h.f.connect(h.g);
        h.pan = panned && ac.createStereoPanner ? ac.createStereoPanner() : null;
        if (h.pan) { h.g.connect(h.pan); h.pan.connect(self.wxGate); } else h.g.connect(self.wxGate);
        h.src.start(0, Math.random() * 1.9);
        return h;
      };
      W.own = hiss(false);
      W.cars = [];
      for (let i = 0; i < 4; i++) W.cars.push(hiss(true));
      this.wx = W;
    },
    wxStop: function () {
      const W = this.wx;
      if (!W) return;
      const all = [W.rainSrc, W.own.src].concat(W.cars.map(function (h) { return h.src; }));
      for (let i = 0; i < all.length; i++) { try { all[i].stop(); all[i].disconnect(); } catch (e) { /* already stopped */ } }
      W.rainG.disconnect(); W.own.g.disconnect();
      for (let i = 0; i < W.cars.length; i++) { W.cars[i].g.disconnect(); if (W.cars[i].pan) W.cars[i].pan.disconnect(); }
      this.wx = null;
    },
    /* rain 0..1 (how hard it is raining), wet 0..1 (water on the track: makes the spray) */
    weatherSound: function (s, dt, own, near) {
      const w = s.wx, rain = w ? clamp(w.rain || 0, 0, 1) : 0, wet = w ? clamp(w.wet || 0, 0, 1) : 0;
      if (rain < 0.01 && wet < 0.02) {
        // dry: fade out, and after a few seconds stop the sounds altogether
        if (this.wx) {
          const W = this.wx, t = this.ac.currentTime;
          W.rainG.gain.setTargetAtTime(0, t, 0.3); W.own.g.gain.setTargetAtTime(0, t, 0.2);
          for (let i = 0; i < W.cars.length; i++) W.cars[i].g.gain.setTargetAtTime(0, t, 0.2);
          W.dry += dt;
          if (W.dry > 4) this.wxStop();
        }
        return;
      }
      if (!this.wx) this.wxBuild();
      const W = this.wx, t = this.ac.currentTime, L = s.listener;
      W.dry = 0;
      // the rain itself: soft in a shower, a fuller roar in heavy rain
      W.rainG.gain.setTargetAtTime(rain > 0.01 ? 0.05 + 0.32 * Math.pow(rain, 0.9) : 0, t, 0.6);
      W.rainLP.frequency.setTargetAtTime(4200 + 4800 * rain, t, 0.6);
      // your tyres throwing up water
      const ownK = own ? wet * clamp((own.speed - 6) / 60, 0, 1) : 0;
      W.own.g.gain.setTargetAtTime(0.16 * ownK, t, 0.08);
      W.own.f.frequency.setTargetAtTime(1300 + 1500 * ownK, t, 0.1);
      // the cars around you: a rush of spray as they go past
      for (let i = 0; i < W.cars.length; i++) W.cars[i].used = false;
      for (let k = 0; k < near.length; k++) {
        const c = near[k].c;
        let h = null;
        for (let i = 0; i < W.cars.length; i++) if (W.cars[i].id === c.id) h = W.cars[i];
        if (!h) for (let i = 0; i < W.cars.length; i++) if (W.cars[i].id === null) { h = W.cars[i]; h.id = c.id; break; }
        if (!h) continue;
        h.used = true;
        const dx = c.x - L.x, dy = c.y - L.y, dist = Math.sqrt(near[k].d2), sp = Math.hypot(c.vx, c.vy);
        const side = -dx * Math.sin(L.a) + dy * Math.cos(L.a);
        let vr = 0;
        if (dist > 0.5) vr = -((c.vx - (L.vx || 0)) * dx + (c.vy - (L.vy || 0)) * dy) / dist;
        const dop = clamp(SOUND_C / (SOUND_C - clamp(vr, -120, 120)), 0.7, 1.5);
        const k2 = wet * clamp((sp - 12) / 50, 0, 1) * Math.min(1, 16 / Math.max(16, dist));
        h.g.gain.setTargetAtTime(0.42 * k2, t, 0.06);
        h.f.frequency.setTargetAtTime((1100 + 1700 * Math.min(1, 16 / Math.max(16, dist))) * dop, t, 0.06);
        if (h.pan) h.pan.pan.setTargetAtTime(clamp(side / 40, -0.9, 0.9), t, 0.06);
      }
      for (let i = 0; i < W.cars.length; i++) if (!W.cars[i].used) { W.cars[i].id = null; W.cars[i].g.gain.setTargetAtTime(0, t, 0.1); }
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
    /* Start lights: a firm tone as each red light comes on (a little higher each time), a bright one at lights out. */
    lightOn: function (n) {
      const f = 494 * Math.pow(1.06, (n || 1) - 1);
      this.beep(f, 0.24, 0.34, 'square', 1700);
      this.beep(f * 2, 0.16, 0.12, 'sine');
    },
    lightsOut: function () {
      this.beep(1175, 0.12, 0.3, 'square', 4200);
      this.beep(1568, 0.22, 0.24, 'sine', 0, 0.05);
    },
    /* The other cars on the grid hold their revs while the lights come on (a different rhythm for each car). */
    gridRev: function (id, t) { return 0.36 + 0.24 * (0.5 + 0.5 * Math.sin(t * (2.1 + (id % 5) * 0.41) + id * 1.7)); },
    /* The engines dip for a moment under a radio call or a race control alert (as on TV), so it can be heard.
       depth: how far down (0..1), hold: for how long (s); then they come back over 0.4 s. */
    duck: function (depth, hold) {
      if (!this.ready) return;
      const g = this.engBus.gain, t = this.ac.currentTime, base = this.vol.engine;
      g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(base * depth, t + 0.05);
      g.setValueAtTime(base * depth, t + hold);
      g.linearRampToValueAtTime(base, t + hold + 0.4);
    },
    // a short burst of filtered noise (radio static, clicks)
    burst: function (t0, type, freq, q, vol, attack, decay) {
      const ac = this.ac, src = ac.createBufferSource(); src.buffer = this.noise;
      const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ac.createGain(); src.connect(f); f.connect(g); g.connect(this.fxBus);
      this.env(g, t0, vol, attack, decay);
      src.start(t0, Math.random() * 1.5); src.stop(t0 + attack + decay + 0.05);
    },
    // a tone through a small speaker (only a narrow band of it gets through), for radio chirps and alerts
    tone: function (t0, freq, dur, vol, type, bp, q) {
      const ac = this.ac, o = ac.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t0);
      const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = bp; f.Q.value = q;
      const g = ac.createGain(); o.connect(f); f.connect(g); g.connect(this.fxBus);
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol, t0 + 0.006);
      g.gain.setValueAtTime(vol, t0 + Math.max(0.007, dur - 0.025)); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.start(t0); o.stop(t0 + dur + 0.03);
    },
    /* Your engineer on the radio: the click of the key going down, a crackle as the channel opens, the two-tone chirp
       with static under it, and the click of the channel closing. About half a second; the engines dip under it. */
    radio: function () {
      if (!this.ready || !this.active) return;
      this.duck(0.42, 0.6);
      const t0 = this.ac.currentTime + 0.01;
      this.burst(t0, 'highpass', 2500, 0.7, 0.55, 0.001, 0.012);                 // click: the key goes down
      this.burst(t0 + 0.004, 'bandpass', 2300, 0.8, 0.42, 0.006, 0.17);          // crackle as the channel opens
      this.burst(t0 + 0.02, 'bandpass', 1700, 0.6, 0.07, 0.03, 0.55);            // static under the call
      this.tone(t0 + 0.09, 1480, 0.07, 0.42, 'square', 1500, 1.1);               // the chirp: high ...
      this.tone(t0 + 0.18, 1110, 0.11, 0.42, 'square', 1150, 1.1);               // ... then low
      this.burst(t0 + 0.56, 'bandpass', 2600, 0.9, 0.3, 0.002, 0.05);            // click: the channel closes
    },
    /* Race control, a warning: an electronic alert like the timing screens', a clean high tone pulsed three times. */
    rcWarn: function () {
      if (!this.ready || !this.active) return;
      this.duck(0.55, 0.45);
      const t0 = this.ac.currentTime + 0.01;
      for (let i = 0; i < 3; i++) {
        this.tone(t0 + i * 0.13, 1245, 0.085, 0.34, 'square', 1250, 2.2);
        this.tone(t0 + i * 0.13, 1867, 0.085, 0.1, 'sine', 1870, 2.5);
      }
    },
    /* Race control, a penalty: the same alert, lower and longer, two long pulses. */
    rcPenalty: function () {
      if (!this.ready || !this.active) return;
      this.duck(0.5, 0.85);
      const t0 = this.ac.currentTime + 0.01;
      for (let i = 0; i < 2; i++) {
        this.tone(t0 + i * 0.44, 880, 0.32, 0.36, 'square', 885, 2.2);
        this.tone(t0 + i * 0.44, 1320, 0.32, 0.1, 'sine', 1320, 2.5);
      }
    },
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
      } else if (e.k === 'tl' && e.id === myId) { if (e.pen) this.rcPenalty(); else this.rcWarn(); }
      else if (e.k === 'jump' && e.id === myId) this.rcPenalty();
      else if (e.k === 'noStop' && e.id === myId) this.rcPenalty();
      else if (e.k === 'finish' && e.id === myId) this.chequered();
      else if (e.k === 'chequered' && myId === null) this.chequered();
    }
  };

  // sound starts on the first click or key press (browser rule)
  const unlock = function () { Audio.unlock(); };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  // phones only let sound start when a finger lifts or on a tap
  window.addEventListener('touchend', unlock, true);
  window.addEventListener('click', unlock, true);

  window.GameAudio = Audio;
})();
