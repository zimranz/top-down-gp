/* Canvas renderer: track, cars, effects, HUD, minimap. World units are metres. */
(function () {
  'use strict';
  const F1 = window.F1;
  const TAU = Math.PI * 2;

  const COL = {
    forest: '#173d24', tree1: '#1f5530', tree2: '#2a6a3b', treeHi: 'rgba(255,255,255,0.06)',
    grassA: '#3f8a46', grassB: '#3a8141', barrier: '#c9ced3', armco: '#7d858c',
    asphalt: '#3a3c40', line: '#f2f2f2', kerbR: '#d62b2b', kerbW: '#f4f4f4',
    gravel: '#cdb98d', gravelDot: '#b9a476',
    // street circuits
    city: '#25272c', runoffSt: '#5d6168', bld: ['#3a3d44', '#444851', '#4f535c'], roof: 'rgba(255,255,255,0.07)',
    // old-town walls (narrow sections) and bridges
    stone: '#9a8566', stoneEdge: '#6f5f48', deck: '#55595f', bridgeSide: '#757a81'
  };
  /* Night races: everything away from the floodlit track is dark. */
  const COL_NIGHT = Object.assign({}, COL, {
    forest: '#0b1711', tree1: '#10261a', tree2: '#153222', treeHi: 'rgba(255,255,255,0.03)',
    grassA: '#254d2b', grassB: '#224627', armco: '#6f767d', asphalt: '#36383c',
    gravel: '#a8976f', gravelDot: '#96855f',
    city: '#0c0d11', runoffSt: '#4b4f56', bld: ['#17191e', '#1c1f25', '#22252c'], roof: 'rgba(255,255,255,0.035)'
  });
  const NEON = ['#ff3fa4', '#3fe0ff', '#a66bff', '#ffb03f'];
  let lampSprite = null;
  /* A soft pool of light (floodlight), drawn additively. */
  function getLampSprite() {
    if (lampSprite) return lampSprite;
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,244,214,0.50)'); gr.addColorStop(0.35, 'rgba(255,240,205,0.18)'); gr.addColorStop(1, 'rgba(255,236,190,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    lampSprite = c;
    return c;
  }

  let wetLampSprite = null;
  /* The pool of light on a wet track: brighter, with a hard glint in the middle (the lamp reflected in the water). */
  function getWetLampSprite() {
    if (wetLampSprite) return wetLampSprite;
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,248,226,0.95)'); gr.addColorStop(0.12, 'rgba(255,244,214,0.6)'); gr.addColorStop(0.4, 'rgba(255,240,205,0.24)'); gr.addColorStop(1, 'rgba(255,236,190,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    wetLampSprite = c;
    return c;
  }
  /* '#rrggbb' colours mixed: a + (b - a) * t. */
  function mixHex(a, b, t) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const ch = function (sh) { const x = (pa >> sh) & 255, y = (pb >> sh) & 255; return Math.round(x + (y - x) * t); };
    return 'rgb(' + ch(16) + ',' + ch(8) + ',' + ch(0) + ')';
  }
  /* A fixed pseudo-random number 0..1 for n (puddles: the same places every time). */
  function hash01(n) { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

  function lerpAngle(a, b, t) { return a + F1.wrapAngle(b - a) * t; }

  function Renderer(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.tracks = {};
    this.cam = { x: 0, y: 0, a: -Math.PI / 2, z: 8, ready: false, lx: 0, ly: 0 };
    this.skids = [];
    this.parts = [];
    this.rainP = []; this.splash = [];       // rain streaks and splashes (screen space)
    this.wheelPrev = {};
    this.lastFrame = performance.now();
    this.resize();
    const self = this;
    // turning a phone sends a burst of size changes: stretch the picture at once, make the new canvas once it settles
    let rt = null;
    const later = function () {
      self.cv.style.width = window.innerWidth + 'px'; self.cv.style.height = window.innerHeight + 'px';
      clearTimeout(rt); rt = setTimeout(function () { self.resize(); }, 150);
    };
    window.addEventListener('resize', later);
    window.addEventListener('orientationchange', later);
  }

  Renderer.prototype.resize = function () {
    // lighter graphics: fewer canvas pixels. On a computer one per screen pixel; on a phone (whose screen packs in two or
    // three times as many) one and a half, so the picture stays sharp, not blurry
    const phone = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    this.dpr = Math.min(this.lite ? (phone ? 1.5 : 1) : 2, window.devicePixelRatio || 1);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.cv.width = Math.round(this.w * this.dpr);
    this.cv.height = Math.round(this.h * this.dpr);
    this.cv.style.width = this.w + 'px';
    this.cv.style.height = this.h + 'px';
  };

  /* Lighter graphics: fewer pixels to draw and no full-screen night effects. */
  Renderer.prototype.setLite = function (on) {
    if (!!this.lite === !!on) return;
    this.lite = !!on;
    this.resize();
  };

  Renderer.prototype.resetEffects = function () {
    this.skids = [];
    this.parts = [];
    this.wheelPrev = {};
    this.cam.ready = false;
  };

  // ------------------------------------------------------------- pit complex
  /* Short names that fit on a garage roof. */
  const GARAGE_NAMES = { mclaren: 'McLAREN', mercedes: 'MERCEDES', redbull: 'RED BULL', ferrari: 'FERRARI', williams: 'WILLIAMS', rb: 'RACING BULLS',
    aston: 'ASTON MARTIN', haas: 'HAAS', audi: 'AUDI', alpine: 'ALPINE', cadillac: 'CADILLAC' };

  /* Everything in the pit complex, built once per track. Offsets are measured from the track centre
     towards the pit side: track edge hw, pit wall, fast lane, working lane with the boxes, garages, paddock. */
  function buildPit(T, mctx) {
    const P = T.pit, side = P.side, L = T.length, ds = T.ds, hw = T.hw;
    const pt = function (s, d) { return F1.trackPoint(T, s, side * d); };
    const samp = function (arr, s) {
      s = F1.wrapS(s, L);
      const f = s / ds, i0 = Math.floor(f) % T.n, i1 = (i0 + 1) % T.n, t = f - Math.floor(f);
      const a = arr[i0], b = arr[i1];
      if (a !== a) return b;
      if (b !== b) return a;
      return a + (b - a) * t;
    };
    const offAt = function (s) { return samp(T.pitOff, s); };
    const inner = function (s) { return offAt(s) - P.half; };
    const outer = function (s) { return offAt(s) + P.half + samp(T.pitWork, s); };
    const konst = function (v) { return function () { return v; }; };
    const strip = function (sa, sb, fIn, fOut, step) {
      const path = new Path2D(), n = Math.max(1, Math.ceil((sb - sa) / (step || 2)));
      for (let k = 0; k <= n; k++) { const sv = sa + (sb - sa) * k / n, p = pt(sv, fIn(sv)); if (!k) path.moveTo(p.x, p.y); else path.lineTo(p.x, p.y); }
      for (let k = n; k >= 0; k--) { const sv = sa + (sb - sa) * k / n, p = pt(sv, fOut(sv)); path.lineTo(p.x, p.y); }
      path.closePath();
      return path;
    };
    const along = function (path, sa, sb, f, step) {
      const n = Math.max(1, Math.ceil((sb - sa) / (step || 2)));
      for (let k = 0; k <= n; k++) { const sv = sa + (sb - sa) * k / n, p = pt(sv, f(sv)); if (!k) path.moveTo(p.x, p.y); else path.lineTo(p.x, p.y); }
      return path;
    };
    const quad = function (sa, sb, da, db) { return [pt(sa, da), pt(sb, da), pt(sb, db), pt(sa, db)]; };
    const head = function (sv) { return F1.trackPoint(T, sv, 0).h; };
    const S0 = P.s0, S1 = P.s1, S2 = L + P.s2, S3 = L + P.s3;
    const pit = { texts: [], boxes: [], stands: [], garages: [], paddock: [] };

    // ground: concrete apron around the lanes, paddock behind the garages, the pit road itself
    pit.apron = strip(S1, S2, konst(P.wallOff + 0.3), konst(P.garFront + 0.2), 4);
    pit.ground = strip(P.gA - 10, P.gB + 10, konst(P.garBack - 0.5), konst(P.garBack + 28), 6);
    pit.road = strip(S0, S3, inner, outer, 2);
    let run = false;
    // pit wall between the track and the pit lane
    pit.wall = new Path2D();
    run = false;
    for (let k = 0; k <= Math.ceil((S3 - S0) / ds); k++) {
      const sv = S0 + k * ds, i = F1.idxAt(T, sv);
      if (T.pitWall[i]) { const p = pt(sv, P.wallOff); if (!run) pit.wall.moveTo(p.x, p.y); else pit.wall.lineTo(p.x, p.y); }
      run = !!T.pitWall[i];
    }
    // lane markings
    pit.lines = new Path2D();
    along(pit.lines, S0 + 28, S3 - 10, inner, 2);
    along(pit.lines, S0 + 28, S3 - 28, outer, 2);
    pit.dash = along(new Path2D(), P.gA - 6, P.gB + 6, function (sv) { return offAt(sv) + P.half; }, 3);
    pit.limit = [];
    [S1, S2].forEach(function (sv) { pit.limit.push([pt(sv, inner(sv) + 0.1), pt(sv, outer(sv) - 0.1)]); });
    // pit exit blend line: keeps the cars leaving the pits apart from the racing line
    let sb0 = S3;
    for (let sv = S2; sv < S3; sv += 1) if (inner(sv) < hw + 1.5) { sb0 = sv; break; }
    pit.blend = along(new Path2D(), sb0, S3 + 25, function (sv) { return sv <= S3 ? Math.min(hw - 0.3, inner(sv)) : hw - 0.3 - Math.min(2.2, (sv - S3) * 0.09); }, 2);
    pit.texts.push({ p: pt(S1 + 8, P.off), a: head(S1 + 8) + Math.PI / 2, t: '80', size: 3.6, color: 'rgba(255,255,255,0.8)' });
    pit.texts.push({ p: pt(S0 + 44, offAt(S0 + 44)), a: head(S0 + 44) + Math.PI / 2, t: 'PIT', size: 2.6, color: 'rgba(255,214,0,0.85)' });
    pit.texts.push({ p: pt(S2 - 8, P.off), a: head(S2 - 8) + Math.PI / 2, t: 'END', size: 2.0, color: 'rgba(255,255,255,0.6)' });
    // pit exit light (red while the race start is under way)
    pit.light = { p: pt(S2 + 2, outer(S2 + 2) + 1.4), a: head(S2 + 2) };

    const n = P.garages.length;
    const cont = function (sv) { return sv < P.gA - 1 ? sv + L : sv; };   // keep s increasing past the line
    pit.building = strip(P.gA - 1.2, P.gB + 1.2, konst(P.garFront), konst(P.garBack), 4);
    pit.roof = strip(P.gA - 1.2, P.gB + 1.2, konst(P.garFront + 1.7), konst(P.garBack), 4);     // over the cars parked inside
    pit.dividers = new Path2D();
    pit.ribs = new Path2D();
    along(pit.ribs, P.gA - 1.2, P.gB + 1.2, konst(P.garBack - 3), 6);
    F1.TEAMS.forEach(function (team, k) {
      const g = P.garages[n - 1 - k];
      const g0 = cont(g.s0), g1 = cont(g.s1), mid = cont(g.mid);
      const col = F1.teamUiColor(team);
      // painted box in the working lane: team outline, wheel marks, a stop bar for the front wing
      pit.boxes.push({
        color: col,
        outline: quad(mid - 4.4, mid + 4.4, P.boxOff - 2.5, P.boxOff + 2.5),
        marks: [[1.55, -0.77], [1.55, 0.77], [-1.95, -0.77], [-1.95, 0.77]].map(function (w) { return quad(mid + w[0] - 0.36, mid + w[0] + 0.36, P.boxOff + w[1] - 0.2, P.boxOff + w[1] + 0.2); }),
        stop: quad(mid + 2.95, mid + 3.2, P.boxOff - 1.2, P.boxOff + 1.2)
      });
      // team stand on the pit wall
      pit.stands.push({ color: col, body: quad(mid - 3.2, mid + 3.2, P.wallOff + 0.35, P.wallOff + 1.75), roof: quad(mid - 2.8, mid + 2.8, P.wallOff + 0.6, P.wallOff + 1.5) });
      // garage: coloured front, open door, name on the roof
      const label = GARAGE_NAMES[team.id] || team.name.toUpperCase();
      pit.garages.push({
        color: col,
        front: quad(g0, g1, P.garFront, P.garFront + 1.7),
        door: quad(g0 + 2.4, g1 - 2.4, P.garFront - 0.05, P.garFront + 0.7),
        // name on the roof, sized to the free depth when drawn (the web font may load later)
        name: { p: pt(mid, (P.garFront + 1.7 + P.garBack) / 2), a: head(mid) + Math.PI / 2, t: label, room: P.garBack - P.garFront - 1.7 - 1.6, color: tint(col, 0.35) }
      });
      const a = pt(g1 + 0.4, P.garFront), b = pt(g1 + 0.4, P.garBack);
      if (k > 0) { pit.dividers.moveTo(a.x, a.y); pit.dividers.lineTo(b.x, b.y); }
      // paddock: motorhome and two trucks behind the garage
      pit.paddock.push({ color: col, kind: 'home', q: quad(g0 + 1.6, g1 - 1.6, P.garBack + 4.5, P.garBack + 13.5), roof: quad(g0 + 2.6, g1 - 2.6, P.garBack + 5.5, P.garBack + 12.5) });
      [P.garBack + 17, P.garBack + 21.6].forEach(function (dd, q) {
        const t0 = g0 + 2 + q * 2.5;
        pit.paddock.push({ color: col, kind: 'truck', q: quad(t0, t0 + 13.6, dd, dd + 2.55), cab: quad(t0 + 13.9, t0 + 16.4, dd + 0.05, dd + 2.5) });
      });
    });
    // bounds for culling
    let sx = 0, sy = 0, cnt = 0;
    const pts = [];
    for (let sv = S0; sv <= S3; sv += 20) { pts.push(pt(sv, 0), pt(sv, P.garBack + 30)); }
    pts.forEach(function (p) { sx += p.x; sy += p.y; cnt++; });
    pit.cx = sx / cnt; pit.cy = sy / cnt; pit.r = 0;
    pts.forEach(function (p) { pit.r = Math.max(pit.r, Math.hypot(p.x - pit.cx, p.y - pit.cy)); });
    pit.r += 30;
    return pit;
  }

  /* Overhead start-light gantry just past the line: five light units that match the start sequence. */
  function buildGantry(T) {
    const hw = T.hw, s0 = 3.4, s1 = 4.9, span = hw + 3.4;
    const q = function (sa, sb, da, db) { return [F1.trackPoint(T, sa, da), F1.trackPoint(T, sb, da), F1.trackPoint(T, sb, db), F1.trackPoint(T, sa, db)]; };
    const g = { beam: q(s0, s1, -span, span), legs: [q(s0 - 0.5, s1 + 0.5, -span - 1.4, -span + 0.2), q(s0 - 0.5, s1 + 0.5, span - 0.2, span + 1.4)], units: [] };
    for (let k = 0; k < 5; k++) {
      const d = -4.4 + k * 2.2;
      g.units.push({ box: q(s0 - 0.25, s1 + 0.25, d - 0.85, d + 0.85), c1: F1.trackPoint(T, (s0 + s1) / 2, d - 0.42), c2: F1.trackPoint(T, (s0 + s1) / 2, d + 0.42) });
    }
    const c = F1.trackPoint(T, (s0 + s1) / 2, 0);
    g.cx = c.x; g.cy = c.y;
    return g;
  }

  /* Mix a #rrggbb colour with white (k = 0..1). */
  function tint(hex, k) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const m = function (c) { return Math.round(c + (255 - c) * k); };
    return 'rgb(' + m(r) + ',' + m(g) + ',' + m(b) + ')';
  }

  /* World-space text (size in metres). */
  function worldText(ctx, t) {
    ctx.save();
    ctx.translate(t.p.x, t.p.y); ctx.rotate(t.a); ctx.scale(t.size / 40, t.size / 40);
    ctx.font = '900 40px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = t.color; ctx.fillText(t.t, 0, 2);
    ctx.restore();
  }

  // ------------------------------------------------------------- track prep
  Renderer.prototype.prep = function (T) {
    if (this.tracks[T.id]) return this.tracks[T.id];
    const N = T.n, X = T.x, Y = T.y, NX = T.nx, NY = T.ny, hw = T.hw;
    const G = { chunks: [], trees: new Map(), deco: [] };
    const PAL = T.night ? COL_NIGHT : COL;
    G.pal = PAL;
    const CH = 40;
    function off(i, d) { return [X[i] + NX[i] * d, Y[i] + NY[i] * d]; }
    // how far the run-off reaches from the centre line at each sample: the run-off is a line as wide as the barrier
    // distance (rounded to a metre) with round ends, so next to a wider part it reaches a bit further
    const edgeAt = new Float32Array(N);
    {
      const RW = new Float32Array(N);
      for (let i = 0; i < N; i++) RW[i] = Math.round(T.wall[i]);
      for (let i = 0; i < N; i++) {
        let e = RW[i];
        const J = Math.ceil(T.maxWall / T.ds) + 1;
        for (let j = -J; j <= J; j++) {
          const w = RW[(i + j + N) % N], d = Math.abs(j) * T.ds;
          if (w > e && d < w) e = Math.max(e, Math.sqrt(w * w - d * d));
        }
        edgeAt[i] = e;
      }
    }
    for (let c0 = 0; c0 < N; c0 += CH) {
      const c1 = Math.min(N, c0 + CH);
      const ch = { center: new Path2D(), runoff: [], edges: new Path2D(), kerbR: new Path2D(), kerbW: new Path2D(), kerbAll: new Path2D(), gravel: new Path2D(),
        narrowFill: new Path2D(), narrowLine: new Path2D(), cx: 0, cy: 0, r: 0, c0: c0, c1: c1, pudL: [] };
      const HWE = T.hwE;
      let sx = 0, sy = 0;
      for (let k = c0; k <= c1; k++) {
        const i = k % N;
        if (k === c0) ch.center.moveTo(X[i], Y[i]); else ch.center.lineTo(X[i], Y[i]);
        sx += X[i]; sy += Y[i];
      }
      ch.cx = sx / (c1 - c0 + 1); ch.cy = sy / (c1 - c0 + 1);
      for (let k = c0; k <= c1; k++) { const i = k % N; ch.r = Math.max(ch.r, Math.hypot(X[i] - ch.cx, Y[i] - ch.cy)); }
      ch.r += T.maxWall + 6;
      // night races: floodlights behind the barriers on both sides, every 44 m
      if (T.night) {
        ch.lamps = [];
        for (let k = c0; k < c1; k++) {
          if (k % 22) continue;
          const i = k % N, side = (k / 22) % 2 ? 1 : -1, d = side * (T.wall[i] + 2.2);
          ch.lamps.push([X[i] + NX[i] * d, Y[i] + NY[i] * d]);
        }
      }
      // the barrier along the edge of the run-off: a grey (armco) line outside a coloured one, both sides
      // (at the edge of the run-off as drawn: where its width changes, the wider part's round edge reaches a little
      // further along, see edgeAt)
      ch.armcoLine = new Path2D(); ch.barrierLine = new Path2D();
      for (const side of [-1, 1]) {
        for (let k = c0; k <= c1; k++) {
          const i = k % N, w = edgeAt[i], a = off(i, side * (w + 0.9)), b = off(i, side * (w + 0.3));
          if (k === c0) { ch.armcoLine.moveTo(a[0], a[1]); ch.barrierLine.moveTo(b[0], b[1]); }
          else { ch.armcoLine.lineTo(a[0], a[1]); ch.barrierLine.lineTo(b[0], b[1]); }
        }
      }
      // the run-off (grass) as one outline: out to the edge on one side, back along the other. On the inside of a bend
      // tighter than the run-off is wide, the edge is kept short of the bend's centre (the outline would fold over
      // itself there); the parts of the track either side of the bend cover that ground anyway.
      ch.grass = new Path2D();
      const edgeOff = function (i, side) {
        const k = T.curv[i], inner = k !== 0 && Math.sign(k) === -side;
        return inner ? Math.min(edgeAt[i], 0.9 / Math.abs(k)) : edgeAt[i];
      };
      for (let k = c0; k <= c1; k++) { const i = k % N, a = off(i, edgeOff(i, 1)); if (k === c0) ch.grass.moveTo(a[0], a[1]); else ch.grass.lineTo(a[0], a[1]); }
      for (let k = c1; k >= c0; k--) { const i = k % N, a = off(i, -edgeOff(i, -1)); ch.grass.lineTo(a[0], a[1]); }
      ch.grass.closePath();
      // run-off groups by (rounded) barrier distance
      let gStart = c0, gW = Math.round(T.wall[c0 % N]);
      for (let k = c0 + 1; k <= c1 + 1; k++) {
        const wv = k <= c1 ? Math.round(T.wall[k % N]) : -1;
        if (wv !== gW) {
          const p = new Path2D();
          for (let q = gStart; q <= Math.min(k, c1); q++) { const i = q % N; if (q === gStart) p.moveTo(X[i], Y[i]); else p.lineTo(X[i], Y[i]); }
          ch.runoff.push({ w: gW, path: p });
          gStart = k - 1 < c0 ? c0 : k - 1; gW = wv;
        }
      }
      // white edge lines (closer together where the track narrows)
      for (const side of [-1, 1]) {
        for (let k = c0; k <= c1; k++) {
          const i = k % N, p = off(i, side * (HWE[i] - 0.45));
          if (k === c0) ch.edges.moveTo(p[0], p[1]); else ch.edges.lineTo(p[0], p[1]);
        }
      }
      // narrow sections: old stone walls cover the road beyond the usable width
      for (let k = c0; k < c1; k++) {
        const i = k % N, j = (k + 1) % N;
        if (HWE[i] > hw - 0.05 && HWE[j] > hw - 0.05) continue;
        ch.narrow = true;
        for (const side of [-1, 1]) {
          const a = off(i, side * (HWE[i] + 0.5)), b = off(j, side * (HWE[j] + 0.5)), c = off(j, side * (hw + 2.2)), d = off(i, side * (hw + 2.2));
          ch.narrowFill.moveTo(a[0], a[1]); ch.narrowFill.lineTo(b[0], b[1]); ch.narrowFill.lineTo(c[0], c[1]); ch.narrowFill.lineTo(d[0], d[1]); ch.narrowFill.closePath();
          ch.narrowLine.moveTo(a[0], a[1]); ch.narrowLine.lineTo(b[0], b[1]);
        }
      }
      // kerbs + gravel quads
      for (let k = c0; k < c1; k++) {
        const i = k % N, j = (k + 1) % N;
        if (T.kerb[i] && T.kerb[j]) {
          // the whole kerb is filled white, then the red blocks go on top: no seams between blocks
          const path = k % 2 === 0 ? ch.kerbR : ch.kerbW;
          for (const side of [-1, 1]) {
            const a = off(i, side * (HWE[i] - 0.2)), b = off(j, side * (HWE[j] - 0.2)), c = off(j, side * (HWE[j] + T.kerbW)), d = off(i, side * (HWE[i] + T.kerbW));
            for (const pth of [path, ch.kerbAll]) { pth.moveTo(a[0], a[1]); pth.lineTo(b[0], b[1]); pth.lineTo(c[0], c[1]); pth.lineTo(d[0], d[1]); pth.closePath(); }
          }
        }
        for (const side of [-1, 1]) {
          const bit = side < 0 ? 1 : 2;
          if ((T.gravel[i] & bit) && (T.gravel[j] & bit)) {
            const w1 = T.wall[i] - 1.2, w2 = T.wall[j] - 1.2;
            // starts just under the track edge (the kerbs are drawn on top), so no grass shows next to the kerbs or the track
            const g0 = hw - 0.25;
            const a = off(i, side * g0), b = off(j, side * g0), c = off(j, side * w2), d = off(i, side * w1);
            ch.gravel.moveTo(a[0], a[1]); ch.gravel.lineTo(b[0], b[1]); ch.gravel.lineTo(c[0], c[1]); ch.gravel.lineTo(d[0], d[1]); ch.gravel.closePath();
          }
        }
      }
      // the racing line (after rain it dries first) and where water collects in heavy rain (near the edges)
      ch.rline = new Path2D();
      for (let k = c0; k <= c1; k++) { const i = k % N; if (k === c0) ch.rline.moveTo(T.rlX[i], T.rlY[i]); else ch.rline.lineTo(T.rlX[i], T.rlY[i]); }
      ch.pud = new Path2D();
      for (let k = c0; k < c1; k++) {
        if (k % 8 || hash01(k) > 0.36) continue;
        const i = k % N, side = hash01(k + 0.5) < 0.5 ? -1 : 1, d = side * (HWE[i] - 1.0 - hash01(k + 0.25) * 2.2);
        const p = off(i, d), rx = 1.3 + hash01(k + 0.75) * 2.2, ry = 0.55 + hash01(k + 0.6) * 0.75;
        ch.pud.moveTo(p[0] + rx * Math.cos(T.hd[i]), p[1] + rx * Math.sin(T.hd[i]));
        ch.pud.ellipse(p[0], p[1], rx, ry, T.hd[i], 0, TAU);
        ch.pudL.push({ x: p[0], y: p[1], a: T.hd[i], l: rx * 1.25, w: ry * 1.35, v: Math.floor(hash01(k + 0.9) * 4) });
      }
      G.chunks.push(ch);
    }

    // a bridge (Suzuka): the upper road over the crossing, drawn after the cars underneath it
    if (T.bridge) {
      const B = T.bridge, iU = F1.idxAt(T, B.sU), wU = T.wall[iU];
      const road = new Path2D(), shadow = new Path2D(), edges = new Path2D();
      for (let s = B.sU - B.span, k = 0; s <= B.sU + B.span + 0.01; s += 2, k++) {
        const p = F1.trackPoint(T, s, 0);
        if (k) road.lineTo(p.x, p.y); else road.moveTo(p.x, p.y);
      }
      // the shadow falls beside the bridge (not past its ends, where the road is back on the ground)
      for (let s = B.sU - B.span + 4.5, k = 0; s <= B.sU + B.span - 4.5 + 0.01; s += 2, k++) {
        const p = F1.trackPoint(T, s, 0);
        if (k) shadow.lineTo(p.x + 2.4, p.y + 3.4); else shadow.moveTo(p.x + 2.4, p.y + 3.4);
      }
      for (const side of [-1, 1]) {
        for (let s = B.sU - B.span, k = 0; s <= B.sU + B.span + 0.01; s += 2, k++) {
          const p = F1.trackPoint(T, s, side * (hw - 0.45));
          if (k) edges.lineTo(p.x, p.y); else edges.moveTo(p.x, p.y);
        }
      }
      G.bridge = { road: road, shadow: shadow, edges: edges, w: wU, cx: B.x, cy: B.y, r: B.span + wU + 10 };
    }

    // banked corners: the road gets lighter towards the outside (the high side), with a barrier along the top
    G.banks = (T.banked || []).map(function (z) {
      const mid = F1.idxAt(T, (z.s0 + z.s1) / 2), out = T.curv[mid] > 0 ? -1 : 1;      // the outside of the corner
      // four layers, each starting and ending a little later: the shading fades in and out
      const b1 = new Path2D(), b2 = new Path2D(), top = new Path2D();
      let sx = 0, sy = 0, n = 0;
      for (let layer = 0; layer < 4; layer++) {
        let k = 0;
        for (let sv = z.s0 - 18 + layer * 9; sv <= z.s1 + 18 - layer * 9; sv += 2, k++) {
          const a = F1.trackPoint(T, sv, out * hw * 0.52), b = F1.trackPoint(T, sv, out * hw * 0.8);
          if (k) { b1.lineTo(a.x, a.y); b2.lineTo(b.x, b.y); } else { b1.moveTo(a.x, a.y); b2.moveTo(b.x, b.y); }
          if (!layer) { sx += a.x; sy += a.y; n++; }
        }
      }
      for (let sv = z.s0, k = 0; sv <= z.s1; sv += 2, k++) {
        const c = F1.trackPoint(T, sv, out * (hw + 0.5));
        if (k) top.lineTo(c.x, c.y); else top.moveTo(c.x, c.y);
      }
      return { b1: b1, b2: b2, top: top, cx: sx / n, cy: sy / n, r: (z.s1 - z.s0) / 2 + 40 };
    });

    // start/finish chequers, grid boxes, DRS lines
    G.marks = new Path2D();
    G.chequerB = new Path2D();
    G.chequerW = new Path2D();
    const sq = 1.0;
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < Math.round((2 * hw) / sq); col++) {
        const s0 = row * sq - sq, d0 = -hw + col * sq;
        const p1 = F1.trackPoint(T, s0, d0), p2 = F1.trackPoint(T, s0 + sq, d0), p3 = F1.trackPoint(T, s0 + sq, d0 + sq), p4 = F1.trackPoint(T, s0, d0 + sq);
        const path = (row + col) % 2 ? G.chequerB : G.chequerW;
        path.moveTo(p1.x, p1.y); path.lineTo(p2.x, p2.y); path.lineTo(p3.x, p3.y); path.lineTo(p4.x, p4.y); path.closePath();
      }
    }
    for (let k = 0; k < 22; k++) {
      const s = T.length - 7 - 8 * k + 2.9;
      const side = (k % 2 === 0 ? 1 : -1) * T.poleSide;
      const a = F1.trackPoint(T, s, side * 2.6 - 1.3), b = F1.trackPoint(T, s, side * 2.6 + 1.3);
      const a2 = F1.trackPoint(T, s - 1.2, side * 2.6 - 1.3), b2 = F1.trackPoint(T, s - 1.2, side * 2.6 + 1.3);
      G.marks.moveTo(a2.x, a2.y); G.marks.lineTo(a.x, a.y); G.marks.lineTo(b.x, b.y); G.marks.lineTo(b2.x, b2.y);
    }
    G.drsLines = new Path2D();
    G.drsDet = new Path2D();
    T.drs.forEach(function (z) {
      const a = F1.trackPoint(T, z.start, -hw + 0.4), b = F1.trackPoint(T, z.start, hw - 0.4);
      G.drsLines.moveTo(a.x, a.y); G.drsLines.lineTo(b.x, b.y);
      const c = F1.trackPoint(T, z.detect, -hw + 0.4), d = F1.trackPoint(T, z.detect, hw - 0.4);
      G.drsDet.moveTo(c.x, c.y); G.drsDet.lineTo(d.x, d.y);
    });
    G.drsText = T.drs.map(function (z) { return F1.trackPoint(T, z.start + 6, 0); });

    // grandstands opposite the pits
    const rand = F1.rng(T.n * 7 + 3);
    function block(s0, s1, d0, d1, color, stripe) {
      const pts = [F1.trackPoint(T, s0, d0), F1.trackPoint(T, s1, d0), F1.trackPoint(T, s1, d1), F1.trackPoint(T, s0, d1)];
      G.deco.push({ pts: pts, color: color, stripe: stripe });
    }
    const standSide = T.pit ? -T.pit.side : -T.poleSide;
    const wallS = T.wall[0];
    for (let s = -300; s < 200; s += 64) block(s, s + 56, standSide * (wallS + 5), standSide * (wallS + 19), '#2d4f8c', '#e8e8e8');

    // pit lane, garages, paddock; start-light gantry over the grid
    if (T.pit) G.pit = buildPit(T, this.ctx);
    G.gantry = buildGantry(T);

    // trees outside the barriers (spatial hash, 100 m cells)
    const b = T.bounds, pad = 260, sp = 13;
    const cell = 60, grid = new Map();
    for (let i = 0; i < N; i += 2) {
      const key = Math.floor(X[i] / cell) + ',' + Math.floor(Y[i] / cell);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(i);
    }
    function nearTrack(x, y) {
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      let best = Infinity, bi = 0;
      for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const list = grid.get(gx + ',' + gy);
        if (!list) continue;
        for (let q = 0; q < list.length; q++) { const i = list[q]; const d = (X[i] - x) * (X[i] - x) + (Y[i] - y) * (Y[i] - y); if (d < best) { best = d; bi = i; } }
      }
      return [Math.sqrt(best), bi];
    }
    for (let x = b.minX - pad; x < b.maxX + pad; x += sp) {
      for (let y = b.minY - pad; y < b.maxY + pad; y += sp) {
        const tx = x + (rand() - 0.5) * sp * 0.9, ty = y + (rand() - 0.5) * sp * 0.9;
        const nt = nearTrack(tx, ty);
        if (nt[0] < T.wall[nt[1]] + 9) continue;
        if (nt[0] < T.maxWall + 44 && (nt[1] * T.ds > T.length - 380 || nt[1] * T.ds < 230)) continue;
        if (rand() < 0.18) continue;
        if (T.street) continue;              // street circuits get buildings instead (below)
        const key = Math.floor(tx / 100) + ',' + Math.floor(ty / 100);
        if (!G.trees.has(key)) G.trees.set(key, []);
        G.trees.get(key).push([tx, ty, 3.2 + rand() * 3.6, rand() < 0.5 ? 0 : 1]);
      }
    }
    // street circuits: city blocks lined up with the nearest street, clear of the walls and the pits
    G.blocks = new Map();
    const nrand = F1.rng(T.n * 13 + 5);
    if (T.street) {
      const bs = 30;
      for (let x = b.minX - pad; x < b.maxX + pad; x += bs) {
        for (let y = b.minY - pad; y < b.maxY + pad; y += bs) {
          const cx = x + (rand() - 0.5) * 6, cy = y + (rand() - 0.5) * 6;
          const nt = nearTrack(cx, cy);
          const w = 12 + rand() * 12, h = 10 + rand() * 12, r = Math.hypot(w, h) / 2;
          if (nt[0] < T.wall[nt[1]] + 4 + r) continue;
          if (T.pit && nt[0] < T.pit.garBack + 14 && (nt[1] * T.ds > T.length - 420 || nt[1] * T.ds < 360)) continue;
          if (rand() < 0.12) continue;
          const a = T.hd[nt[1]], ca = Math.cos(a), sa = Math.sin(a);
          const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(function (q) { return [cx + q[0] * ca - q[1] * sa, cy + q[0] * sa + q[1] * ca]; });
          const key = Math.floor(cx / 100) + ',' + Math.floor(cy / 100);
          if (!G.blocks.has(key)) G.blocks.set(key, []);
          const blk = { pts: pts, shade: Math.floor(rand() * 3) };
          if (T.night) {
            // lit windows (a few per building); on the Las Vegas Strip some buildings are outlined in neon
            blk.win = [];
            const nw = Math.floor(nrand() * 5);
            for (let q = 0; q < nw; q++) {
              const u = (nrand() - 0.5) * (w - 4), v = (nrand() - 0.5) * (h - 4);
              blk.win.push([cx + u * ca - v * sa, cy + u * sa + v * ca]);
            }
            blk.neon = T.id === 'lasvegas' && nrand() < 0.38 ? Math.floor(nrand() * NEON.length) : -1;
            blk.ang = a;
          }
          G.blocks.get(key).push(blk);
        }
      }
    }

    // minimap
    const mm = document.createElement('canvas');
    const MS = 200, dpr = this.dpr;
    mm.width = MS * dpr; mm.height = MS * dpr;
    const mc = mm.getContext('2d');
    const w = b.maxX - b.minX, h = b.maxY - b.minY;
    const sc = (MS - 24) / Math.max(w, h);
    const ox = (MS - w * sc) / 2 - b.minX * sc, oy = (MS - h * sc) / 2 - b.minY * sc;
    mc.scale(dpr, dpr);
    mc.lineJoin = 'round';
    const tracePath = function () { mc.beginPath(); for (let i = 0; i <= N; i += 3) { const k = i % N; const px = X[k] * sc + ox, py = Y[k] * sc + oy; if (i === 0) mc.moveTo(px, py); else mc.lineTo(px, py); } mc.closePath(); };
    tracePath(); mc.strokeStyle = 'rgba(0,0,0,0.65)'; mc.lineWidth = 7; mc.stroke();
    // the pit lane: a thinner grey road beside the track line. At this size the real gap (about 20 m) would
    // be lost under the track line, so the lane is pushed out a little (and the cars in it with it, see miniXY)
    let miniPit = null;
    if (T.pit) {
      const P = T.pit, pi = F1.pitInfo(T), edge = T.hw - 2.5;
      const extra = Math.max(0, 7.5 / sc - P.off);       // at least 7.5 px from the centre of the track line
      const mapOff = function (idx, a) {                 // real distance from the centre line (pit side) -> on the map
        const po = T.pitOff[idx];
        if (po !== po || extra === 0) return a;
        const aa = Math.min(a, po);                      // cars in the garages sit on the lane
        return aa + extra * Math.max(0, Math.min(1, (aa - edge) / (P.off - edge)));
      };
      const pitPath = function () {
        mc.beginPath();
        const n = Math.max(2, Math.ceil(pi.total / 6));
        for (let j = 0; j <= n; j++) {
          const s = P.s0 + pi.total * j / n, idx = F1.idxAt(T, s), po = T.pitOff[idx];
          const p = F1.trackPoint(T, s, P.side * mapOff(idx, po === po ? po : edge));
          if (j) mc.lineTo(p.x * sc + ox, p.y * sc + oy); else mc.moveTo(p.x * sc + ox, p.y * sc + oy);
        }
      };
      pitPath(); mc.strokeStyle = 'rgba(0,0,0,0.65)'; mc.lineWidth = 5; mc.stroke();
      pitPath(); mc.strokeStyle = '#a7b0ba'; mc.lineWidth = 2.2; mc.stroke();
      miniPit = { side: P.side, mapOff: mapOff };
    }
    tracePath(); mc.strokeStyle = '#e9edf1'; mc.lineWidth = 3; mc.stroke();
    // a bridge (Suzuka): the upper road drawn again on top, with dark edges, so it reads as an overpass
    if (T.bridge) {
      const up = T.bridge.up, mbr = function () {
        mc.beginPath();
        for (let s = up[0] - 30, k = 0; s <= up[1] + 30; s += 6, k++) { const p = F1.trackPoint(T, s, 0); if (k) mc.lineTo(p.x * sc + ox, p.y * sc + oy); else mc.moveTo(p.x * sc + ox, p.y * sc + oy); }
      };
      mc.lineCap = 'butt';
      mbr(); mc.strokeStyle = 'rgba(0,0,0,0.85)'; mc.lineWidth = 8; mc.stroke();
      mbr(); mc.strokeStyle = '#e9edf1'; mc.lineWidth = 3; mc.stroke();
    }
    // start / finish: a small chequered stripe across the track line
    const s0 = F1.trackPoint(T, 0, 0);
    mc.save();
    mc.translate(s0.x * sc + ox, s0.y * sc + oy);
    mc.rotate(s0.h);
    mc.fillStyle = 'rgba(0,0,0,0.8)'; mc.fillRect(-3, -7, 6, 14);
    for (let a = 0; a < 2; a++) for (let b = 0; b < 6; b++) {
      mc.fillStyle = (a + b) % 2 ? '#111' : '#fff';
      mc.fillRect(-2 + a * 2, -6 + b * 2, 2, 2);
    }
    mc.restore();
    G.mini = { canvas: mm, size: MS, sc: sc, ox: ox, oy: oy, pit: miniPit, hints: {} };

    // grass stripes pattern (in world metres)
    const pc = document.createElement('canvas');
    pc.width = 24; pc.height = 24;
    const pcx = pc.getContext('2d');
    pcx.fillStyle = PAL.grassA; pcx.fillRect(0, 0, 24, 24);
    pcx.fillStyle = PAL.grassB; pcx.fillRect(0, 0, 12, 24);
    G.grassPattern = this.ctx.createPattern(pc, 'repeat');
    const gc = document.createElement('canvas');
    gc.width = 16; gc.height = 16;
    const gcx = gc.getContext('2d');
    gcx.fillStyle = PAL.gravel; gcx.fillRect(0, 0, 16, 16);
    for (let i = 0; i < 26; i++) { gcx.fillStyle = i % 2 ? PAL.gravelDot : (T.night ? '#b8a880' : '#ddcca3'); gcx.fillRect(Math.floor(rand() * 16), Math.floor(rand() * 16), 1, 1); }
    G.gravelPattern = this.ctx.createPattern(gc, 'repeat');
    if (G.gravelPattern && G.gravelPattern.setTransform && window.DOMMatrix) G.gravelPattern.setTransform(new DOMMatrix().scale(0.25));

    if (T.night) G.light = buildLightMaps(T, G);
    this.tracks[T.id] = G;
    return G;
  };

  /* Shapes of the trees and city blocks in the 100 m squares tx0..tx1, ty0..ty1. */
  function buildScene(G, tx0, tx1, ty0, ty1, night) {
    const p1 = new Path2D(), p2 = new Path2D(), ph = new Path2D();
    for (let gx = tx0; gx <= tx1; gx++) for (let gy = ty0; gy <= ty1; gy++) {
      const list = G.trees.get(gx + ',' + gy);
      if (!list) continue;
      for (let q = 0; q < list.length; q++) {
        const t = list[q], p = t[3] ? p2 : p1;
        p.moveTo(t[0] + t[2], t[1]); p.arc(t[0], t[1], t[2], 0, TAU);
        ph.moveTo(t[0] - t[2] * 0.25 + t[2] * 0.45, t[1] - t[2] * 0.3); ph.arc(t[0] - t[2] * 0.25, t[1] - t[2] * 0.3, t[2] * 0.45, 0, TAU);
      }
    }
    const out = { p1: p1, p2: p2, ph: ph, bp: null };
    if (!G.blocks.size) return out;
    const bp = [new Path2D(), new Path2D(), new Path2D()], roof = new Path2D();
    const win = new Path2D(), neon = NEON.map(function () { return new Path2D(); }), neonUsed = NEON.map(function () { return false; });
    for (let gx = tx0; gx <= tx1; gx++) for (let gy = ty0; gy <= ty1; gy++) {
      const list = G.blocks.get(gx + ',' + gy);
      if (!list) continue;
      for (let q = 0; q < list.length; q++) {
        const k = list[q], p = k.pts, path = bp[k.shade];
        path.moveTo(p[0][0], p[0][1]); path.lineTo(p[1][0], p[1][1]); path.lineTo(p[2][0], p[2][1]); path.lineTo(p[3][0], p[3][1]); path.closePath();
        // a lighter roof panel
        const mx = (p[0][0] + p[2][0]) / 2, my = (p[0][1] + p[2][1]) / 2;
        for (let v = 0; v < 4; v++) { const x = mx + (p[v][0] - mx) * 0.62, y = my + (p[v][1] - my) * 0.62; if (v) roof.lineTo(x, y); else roof.moveTo(x, y); }
        roof.closePath();
        if (!night || !k.win) continue;
        for (let v = 0; v < k.win.length; v++) { const wv = k.win[v]; win.rect(wv[0] - 0.9, wv[1] - 0.9, 1.8, 1.8); }
        if (k.neon >= 0) {
          const np = neon[k.neon];
          neonUsed[k.neon] = true;
          for (let v = 0; v < 4; v++) { const x = mx + (p[v][0] - mx) * 0.9, y = my + (p[v][1] - my) * 0.9; if (v) np.lineTo(x, y); else np.moveTo(x, y); }
          np.closePath();
        }
      }
    }
    out.bp = bp; out.roof = roof; out.win = win; out.neon = neon; out.neonUsed = neonUsed;
    return out;
  }

  /* Night races: the floodlight glow around the track is drawn once, into a picture of the whole circuit (about
     2 m per pixel). Each frame then only lays that picture under the track, instead of drawing eleven very wide
     soft strokes every frame (the slowest part of a night frame). */
  function buildLightMaps(T, G) {
    const N = T.n, X = T.x, Y = T.y;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < N; i++) { if (X[i] < x0) x0 = X[i]; if (X[i] > x1) x1 = X[i]; if (Y[i] < y0) y0 = Y[i]; if (Y[i] > y1) y1 = Y[i]; }
    const m = T.maxWall + 90;
    x0 -= m; y0 -= m; x1 += m; y1 += m;
    const sc = Math.max(2, Math.max(x1 - x0, y1 - y0) / 1800);          // metres per pixel
    const cw = Math.ceil((x1 - x0) / sc), chh = Math.ceil((y1 - y0) / sc);
    const make = function () {
      const c = document.createElement('canvas');
      c.width = cw; c.height = chh;
      const g = c.getContext('2d');
      g.setTransform(1 / sc, 0, 0, 1 / sc, -x0 / sc, -y0 / sc);
      return { c: c, g: g };
    };
    // the glow: many thin layers, each a little narrower, for a smooth fall-off into the dark
    const glow = make(), centre = new Path2D(), base = 2 * T.maxWall;
    for (let i = 0; i <= N; i++) { const k = i % N; if (i) centre.lineTo(X[k], Y[k]); else centre.moveTo(X[k], Y[k]); }
    glow.g.lineJoin = 'round'; glow.g.lineCap = 'round';
    glow.g.strokeStyle = 'rgba(255,236,190,0.024)';
    for (let v = 0; v < 11; v++) { glow.g.lineWidth = base + 126 - v * 11; glow.g.stroke(centre); }
    return { glow: glow.c, x0: x0, y0: y0, w: cw * sc, h: chh * sc };
  }

  // ------------------------------------------------------------- camera
  /* The car always stays in the upper-middle of the screen, clear of the dashboard at the bottom. */
  /* Camera distance: close / normal / far (zoom multiplier). */
  const ZOOM = { close: 1.45, normal: 1, far: 0.62 };

  Renderer.prototype.updateCamera = function (focus, dt, rotate, distance) {
    const cam = this.cam, W = this.w, H = this.h;
    const sp = focus ? Math.hypot(focus.vx || 0, focus.vy || 0) : 0;
    const base = F1.clamp(Math.min(W, H) / 88, 4.2, 13) * (ZOOM[distance] || 1);
    const zT = this.zoomOverride || base * (1 - 0.3 * Math.min(1, sp / 85));
    const TL = window.TouchUI ? window.TouchUI.L : null;
    const slim = !!(TL && TL.dash === 'slim');
    const dash = slim ? 78 : 130;                       // space taken by the dashboard at the bottom
    const gap = slim ? 60 : 100;                        // and between the car and the dashboard
    if (!cam.ready && focus) {
      cam.x = focus.x; cam.y = focus.y; cam.a = focus.a; cam.z = zT; cam.lx = 0; cam.ly = 0; cam.ready = true;
    }
    if (!focus) return;
    cam.z += (zT - cam.z) * Math.min(1, dt * 2.4);
    cam.a += F1.wrapAngle(focus.a - cam.a) * Math.min(1, dt * 7);
    cam.rotate = rotate;
    cam.ax = W / 2;
    if (rotate) {
      cam.ay = F1.clamp(H * 0.58, Math.min(150, H * 0.4), H - dash - gap);
      cam.lx = 0; cam.ly = 0;
    } else {
      cam.ay = (H - dash) / 2 + 8;
      // look ahead in the direction of travel, but never so far that the car leaves the safe area
      let tlx = F1.clamp((focus.vx || 0) * 0.45, -40, 40), tly = F1.clamp((focus.vy || 0) * 0.45, -40, 40);
      const z = cam.z;
      tlx = F1.clamp(tlx, (cam.ax - W * 0.82) / z, (cam.ax - W * 0.18) / z);
      tly = F1.clamp(tly, (cam.ay - (H - dash - 80)) / z, (cam.ay - 110) / z);
      const k = Math.min(1, dt * 2);
      cam.lx += (tlx - cam.lx) * k; cam.ly += (tly - cam.ly) * k;
    }
    cam.x = focus.x + cam.lx;
    cam.y = focus.y + cam.ly;
    cam.rot = rotate ? -Math.PI / 2 - cam.a : 0;
  };

  Renderer.prototype.toScreen = function (x, y) {
    const c = this.cam;
    const dx = x - c.x, dy = y - c.y, cs = Math.cos(c.rot), sn = Math.sin(c.rot);
    return [c.ax + (dx * cs - dy * sn) * c.z, c.ay + (dx * sn + dy * cs) * c.z];
  };
  Renderer.prototype.toWorld = function (sx, sy) {
    const c = this.cam;
    const rx = (sx - c.ax) / c.z, ry = (sy - c.ay) / c.z, cs = Math.cos(-c.rot), sn = Math.sin(-c.rot);
    return [c.x + rx * cs - ry * sn, c.y + rx * sn + ry * cs];
  };

  // ------------------------------------------------------------- frame
  /* frame = { track, cars:[{id,x,y,a,vx,vy,delta,team,code,number,me,ghost,drsOpen,label}], focus, ghostMode } */
  Renderer.prototype.drawWorld = function (frame, dt) {
    const ctx = this.ctx, T = frame.track, G = this.prep(T), cam = this.cam, dpr = this.dpr;
    const COL = G.pal, night = !!T.night;        // night races use the dark palette
    this.night = night;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = T.street ? COL.city : COL.forest;
    ctx.fillRect(0, 0, this.cv.width, this.cv.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(cam.ax, cam.ay);
    ctx.rotate(cam.rot);
    ctx.scale(cam.z, cam.z);
    ctx.translate(-cam.x, -cam.y);
    const vc = this.toWorld(this.w / 2, this.h / 2);
    const vr = Math.hypot(this.w, this.h) / 2 / cam.z + 8;
    const vis = G.chunks.filter(function (ch) { return Math.hypot(ch.cx - vc[0], ch.cy - vc[1]) < ch.r + vr; });

    // trees and city blocks: the shapes for the visible 100 m squares are put together only when that set of
    // squares changes (every few seconds), not every frame
    const tx0 = Math.floor((vc[0] - vr) / 100), tx1 = Math.floor((vc[0] + vr) / 100);
    const ty0 = Math.floor((vc[1] - vr) / 100), ty1 = Math.floor((vc[1] + vr) / 100);
    const sceneKey = tx0 + ',' + tx1 + ',' + ty0 + ',' + ty1;
    if (G.sceneKey !== sceneKey) { G.scene = buildScene(G, tx0, tx1, ty0, ty1, night); G.sceneKey = sceneKey; }
    const SC = G.scene;
    ctx.fillStyle = COL.tree1; ctx.fill(SC.p1);
    ctx.fillStyle = COL.tree2; ctx.fill(SC.p2);
    ctx.fillStyle = COL.treeHi; ctx.fill(SC.ph);
    if (SC.bp) {
      for (let v = 0; v < 3; v++) { ctx.fillStyle = COL.bld[v]; ctx.fill(SC.bp[v]); }
      ctx.fillStyle = COL.roof; ctx.fill(SC.roof);
      if (night) {
        // lit windows, and neon outlines on some Las Vegas buildings
        ctx.fillStyle = 'rgba(255,206,120,0.62)'; ctx.fill(SC.win);
        ctx.lineWidth = 0.9; ctx.lineJoin = 'miter';
        for (let v = 0; v < NEON.length; v++) { if (!SC.neonUsed[v]) continue; ctx.strokeStyle = NEON[v]; ctx.globalAlpha = 0.85; ctx.stroke(SC.neon[v]); }
        ctx.globalAlpha = 1;
      }
    }

    // decorations
    G.deco.forEach(function (d) {
      ctx.fillStyle = d.color;
      ctx.beginPath(); ctx.moveTo(d.pts[0].x, d.pts[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(d.pts[i].x, d.pts[i].y); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = d.stripe; ctx.lineWidth = 0.6; ctx.stroke();
    });

    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    // the visible track sections are merged into one shape per layer and drawn in one go:
    // drawing them section by section leaves hairline seams where the sections meet
    // (kept from frame to frame until the set of visible sections changes: less work and less garbage each frame)
    let visKey = '';
    for (const ch of vis) { if (ch.k === undefined) ch.k = G.chunks.indexOf(ch); visKey += ch.k + ','; }
    if (G.mergeKey !== visKey) { G.mergeKey = visKey; G.merged = {}; }
    const merged = G.merged;
    const merge = function (key) {
      let p = merged[key];
      if (!p) { p = new Path2D(); for (const ch of vis) p.addPath(ch[key]); merged[key] = p; }
      return p;
    };
    // night: the floodlights light up a corridor around the track, fading into the dark
    if (night && G.light && !this.lite) {
      const Lm = G.light;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(Lm.glow, Lm.x0, Lm.y0, Lm.w, Lm.h);
    }
    // barriers + run-off. (Drawn cheaply: where the track winds back on itself, as in the Interlagos infield, the
    // run-off of many parts of the track covers the same ground. The barriers used to be two more very wide bands under
    // the grass, and the grass was painted with its stripe pattern band over band: frames of 50-100 ms on a computer
    // without graphics acceleration. Now the barriers are thin lines, the grass is plain colour, and the stripes are
    // painted once through the shape of the stripes.)
    ctx.lineCap = 'butt';
    ctx.strokeStyle = COL.armco; ctx.lineWidth = 0.66; ctx.stroke(merge('armcoLine'));
    ctx.strokeStyle = COL.barrier; ctx.lineWidth = 0.66; ctx.stroke(merge('barrierLine'));
    ctx.lineCap = 'round';
    const grass = merge('grass');
    ctx.fillStyle = T.street ? COL.runoffSt : COL.grassA;
    ctx.fill(grass);
    if (!T.street && !this.lite && !night) {
      // mown stripes, 12 m wide, fixed to the ground (not at night: in the dark the two greens look the same)
      const st = new Path2D(), x0 = Math.floor((vc[0] - vr) / 24) * 24;
      for (let x = x0; x < vc[0] + vr; x += 24) st.rect(x, vc[1] - vr, 12, 2 * vr);
      ctx.save(); ctx.clip(st);
      ctx.fillStyle = COL.grassB; ctx.fill(grass);
      ctx.restore();
    }
    ctx.fillStyle = G.gravelPattern || COL.gravel;
    ctx.imageSmoothingEnabled = false;                 // (the gravel's grains: quicker without smoothing, looks the same)
    ctx.fill(merge('gravel'));
    ctx.imageSmoothingEnabled = true;
    // rain: everything off the track gets darker (deeper green grass, wet run-off and buildings)
    const wx = frame.weather, wet = wx ? wx.wet : 0, rain = wx ? wx.rain : 0, ld = wx ? wx.ld : 0;
    if (wet > 0.02) {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = T.street ? 'rgba(6,10,18,' + (0.26 * wet).toFixed(3) + ')' : 'rgba(2,24,10,' + (0.3 * wet).toFixed(3) + ')';
      ctx.fillRect(0, 0, this.cv.width, this.cv.height);
      ctx.restore();
    }
    if (G.pit && Math.hypot(G.pit.cx - vc[0], G.pit.cy - vc[1]) < G.pit.r + vr) {
      ctx.save(); this.drawPit(ctx, G.pit, T, frame); ctx.restore();
    }
    // asphalt: one plain colour (darker when wet)
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = wet > 0.02 ? mixHex(COL.asphalt, '#15171c', 0.66 * wet) : COL.asphalt;
    ctx.lineWidth = 2 * T.hw;
    ctx.stroke(merge('center'));
    // drying: the tyres squeeze the water away, so it starts as two patchy tracks where the wheels run, which
    // widen and join into one dry line as more cars go round
    if (wet > 0.03 && ld > 0.05) this.drawDryLine(ctx, T, vis, COL, Math.min(1, wet * 4), ld);
    // banked corners: lighter towards the high side
    for (let v = 0; v < G.banks.length; v++) {
      const bk = G.banks[v];
      if (Math.hypot(bk.cx - vc[0], bk.cy - vc[1]) > bk.r + vr) continue;
      ctx.lineCap = 'butt';
      ctx.strokeStyle = 'rgba(255,255,255,0.02)'; ctx.lineWidth = T.hw * 0.96; ctx.stroke(bk.b1);
      ctx.strokeStyle = 'rgba(255,255,255,0.022)'; ctx.lineWidth = T.hw * 0.4; ctx.stroke(bk.b2);
      ctx.strokeStyle = COL.armco; ctx.lineWidth = 0.9; ctx.stroke(bk.top);
      ctx.strokeStyle = COL.barrier; ctx.lineWidth = 0.45; ctx.stroke(bk.top);
      ctx.lineCap = 'round';
    }
    ctx.fillStyle = COL.kerbW; ctx.fill(merge('kerbAll'));
    ctx.fillStyle = COL.kerbR; ctx.fill(merge('kerbR'));
    ctx.strokeStyle = COL.line; ctx.lineWidth = 0.28; ctx.lineCap = 'butt';
    ctx.stroke(merge('edges'));
    if (T.hwE && vis.some(function (ch) { return ch.narrow; })) {
      ctx.fillStyle = COL.stone; ctx.fill(merge('narrowFill'));
      ctx.strokeStyle = COL.stoneEdge; ctx.lineWidth = 0.9; ctx.stroke(merge('narrowLine'));
      ctx.strokeStyle = COL.barrier; ctx.lineWidth = 0.35; ctx.stroke(merge('narrowLine'));
    }
    ctx.fillStyle = '#f5f5f5'; ctx.fill(G.chequerW);
    ctx.fillStyle = '#111'; ctx.fill(G.chequerB);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 0.22; ctx.stroke(G.marks);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 0.5; ctx.stroke(G.drsLines);
    ctx.setLineDash([1.2, 1.2]); ctx.lineWidth = 0.3; ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.stroke(G.drsDet); ctx.setLineDash([]);

    // heavy rain: standing water near the edges
    if (wet > 0.55 && !this.lite) this.drawPuddles(ctx, vis, Math.min(1, (wet - 0.55) / 0.35), rain, night, dt, vc, vr);

    // skid marks
    if (this.skids.length) {
      const sk = new Path2D();
      for (let i = 0; i < this.skids.length; i++) {
        const s = this.skids[i];
        if (Math.abs(s[0] - vc[0]) > vr || Math.abs(s[1] - vc[1]) > vr) continue;
        sk.moveTo(s[0], s[1]); sk.lineTo(s[2], s[3]);
      }
      ctx.strokeStyle = 'rgba(15,15,15,0.33)'; ctx.lineWidth = 0.34; ctx.lineCap = 'round';
      ctx.stroke(sk);
    }


    // night: floodlight posts behind the barriers, each with a pool of light
    if (night) {
      // (a wet track shines back: bigger, brighter pools of light)
      const sprite = wet > 0.15 ? getWetLampSprite() : getLampSprite(), R = 17 * (1 + 0.3 * wet);
      ctx.globalCompositeOperation = 'lighter';
      for (const ch of vis) {
        if (!ch.lamps) continue;
        for (let v = 0; v < ch.lamps.length; v++) { const lp = ch.lamps[v]; ctx.drawImage(sprite, lp[0] - R, lp[1] - R, 2 * R, 2 * R); }
      }
      ctx.globalCompositeOperation = 'source-over';
      const posts = new Path2D();
      for (const ch of vis) {
        if (!ch.lamps) continue;
        for (let v = 0; v < ch.lamps.length; v++) { const lp = ch.lamps[v]; posts.moveTo(lp[0] + 0.55, lp[1]); posts.arc(lp[0], lp[1], 0.55, 0, TAU); }
      }
      ctx.fillStyle = '#fff8e0'; ctx.fill(posts);
    }

    // cars (at a bridge: the cars underneath first, then the bridge, then everyone else)
    const cars = frame.cars, self = this;
    const drawOne = function (c) {
      if (Math.abs(c.x - vc[0]) > vr + 6 || Math.abs(c.y - vc[1]) > vr + 6) return;
      if (c.me) self.drawMeGlow(ctx, c);
      ctx.globalAlpha = c.replay ? 0.38 : c.ghost ? 0.42 : 1;
      self.drawCar(ctx, c, c.team, c.delta || 0, c.drsOpen);
      ctx.globalAlpha = 1;
      if (!c.replay) self.trackSkids(c, T);
    };
    const BR = G.bridge && Math.hypot(G.bridge.cx - vc[0], G.bridge.cy - vc[1]) < G.bridge.r + vr ? G.bridge : null;
    if (BR) {
      const lv = function (c) { return c.lvl !== undefined ? c.lvl : F1.levelNear(T, c.x, c.y, c.a); };
      for (let i = 0; i < cars.length; i++) if (lv(cars[i]) < 0) drawOne(cars[i]);
      this.drawBridge(ctx, BR, T);
      for (let i = 0; i < cars.length; i++) if (lv(cars[i]) >= 0) drawOne(cars[i]);
    } else {
      for (let i = 0; i < cars.length; i++) drawOne(cars[i]);
    }

    // spray behind the cars on a wet track (over the cars behind: in heavy rain it hides them)
    if (wet > 0.08) this.drawSpray(ctx, cars, wet * (1 - 0.5 * ld), vc, vr, night);
    else if (this.trails) this.trails = null;
    // particles
    this.updateParticles(ctx, dt);
    // start-light gantry over the cars
    if (G.gantry && Math.hypot(G.gantry.cx - vc[0], G.gantry.cy - vc[1]) < vr + T.hw + 10) this.drawGantry(ctx, G.gantry, frame.lights || 0);

    // labels in screen space
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (night && !this.lite) {
      // darker towards the edges of the screen: the light is where the cars are (painted once into a picture the
      // size of the screen: copying it is about three times quicker than working out the gradient every frame)
      const key = this.w + 'x' + this.h + 'x' + dpr;
      if (!this.vig || this.vigKey !== key) {
        const vc2 = document.createElement('canvas');
        vc2.width = Math.round(this.w * dpr); vc2.height = Math.round(this.h * dpr);
        const vx = vc2.getContext('2d');
        vx.scale(dpr, dpr);
        const d = Math.hypot(this.w, this.h) / 2, gr = vx.createRadialGradient(this.w / 2, this.h / 2, d * 0.35, this.w / 2, this.h / 2, d);
        gr.addColorStop(0, 'rgba(2,3,12,0)'); gr.addColorStop(1, 'rgba(2,3,12,0.5)');
        vx.fillStyle = gr; vx.fillRect(0, 0, this.w, this.h);
        this.vig = vc2; this.vigKey = key;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.vig, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    // rain falling (and a greyer, darker picture when it pours)
    if (rain > 0.01 || this.rainP.length) this.drawRain(ctx, rain, wet, dt);
    const small = !!(window.TouchUI && window.TouchUI.L && window.TouchUI.L.phone);     // a phone: smaller name tags
    const tagged = frame.garage && frame.garage.length ? cars.concat(frame.garage.filter(function (c) { return c.me; })) : cars;
    for (let i = 0; i < tagged.length; i++) {
      const c = tagged[i];
      const sp = this.toScreen(c.x, c.y);
      if (sp[0] < -60 || sp[1] < -60 || sp[0] > this.w + 60 || sp[1] > this.h + 60) continue;
      if (c.me) this.drawYouTag(ctx, sp[0], sp[1] - 3.6 * cam.z - (small ? 10 : 14), small);
      else if (frame.labels) this.drawLabel(ctx, sp[0], sp[1] - 3.2 * cam.z - (small ? 6 : 8), c, small);
    }
  };

  /* Spray: the fine mist a car throws up hangs in the air where the car has been and fades within a second. It is
     drawn as a smooth veil along the car's path: soft, see-through shapes laid closely one after another (so no
     separate puffs show), two narrow ones off the rear wheels that merge right behind the car, widening and fading
     further back, with faint streaks the way the car is going. Thickest a few metres behind the car; longer and
     denser at speed and in heavy rain, so a line of cars leaves a haze. Drawn over the cars: it hides the car behind. */
  Renderer.prototype.veilSprites = function () {
    if (this.veil) return this.veil;
    const mk = function (streaks) {
      const W = 96, H = 64, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      // a soft oval: full in the middle, fading smoothly to nothing at the edges
      g.save(); g.translate(W / 2, H / 2); g.scale(1, H / W);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, W / 2);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(255,255,255,0.78)'); gr.addColorStop(0.62, 'rgba(255,255,255,0.3)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(-W / 2, -W / 2, W, W);
      g.restore();
      if (streaks) {
        // thin lines along the length, kept only inside the oval
        g.globalCompositeOperation = 'source-in';
        g.fillStyle = 'rgba(255,255,255,0.22)'; g.fillRect(0, 0, W, H);
        g.globalCompositeOperation = 'source-atop';
        let seed = 5; const rnd = function () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
        for (let k = 0; k < 16; k++) { g.fillStyle = 'rgba(255,255,255,' + (0.4 + rnd() * 0.6).toFixed(2) + ')'; g.fillRect(rnd() * W * 0.3, 6 + rnd() * (H - 12), W * (0.4 + rnd() * 0.6), 1 + rnd() * 1.2); }
      }
      return cv;
    };
    this.veil = { soft: mk(false), streak: mk(true) };
    return this.veil;
  };
  Renderer.prototype.drawSpray = function (ctx, cars, wet, vc, vr, night) {
    const now = performance.now() / 1000, LIFE = 0.85, TR = this.trails || (this.trails = {}), seen = {};
    const lite = this.lite, V = this.veilSprites(), step = lite ? 2.6 : 1.3;
    const tint = night ? 0.72 : 1;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (c.ghost || c.replay || c.garage) continue;
      seen[c.id] = 1;
      let tr = TR[c.id];
      if (!tr) tr = TR[c.id] = [];
      const last = tr[tr.length - 1];
      if (last && Math.hypot(c.x - last.x, c.y - last.y) > 25) tr.length = 0;          // (put back on the track)
      if (!tr.length || Math.hypot(c.x - tr[tr.length - 1].x, c.y - tr[tr.length - 1].y) > 1.0) tr.push({ x: c.x, y: c.y, t: now });
      while (tr.length && now - tr[0].t > LIFE) tr.shift();
      if (Math.abs(c.x - vc[0]) > vr + 70 || Math.abs(c.y - vc[1]) > vr + 70) continue;
      const sp = Math.hypot(c.vx || 0, c.vy || 0), k = Math.min(1, Math.max(0, (sp - 12) / 50)) * wet;
      if (k < 0.04) continue;
      const ca = Math.cos(c.a), sa = Math.sin(c.a), rx = c.x - ca * 2.4, ry = c.y - sa * 2.4;
      // the path behind the car, newest first, from the rear wheels back
      const pts = [[rx, ry, 0]];
      for (let q = tr.length - 1; q >= 0; q--) {
        const p = tr[q];
        if ((p.x - c.x) * ca + (p.y - c.y) * sa > -2.9) continue;
        pts.push([p.x, p.y, now - p.t]);
      }
      if (pts.length < 2) continue;
      let total = 0;
      for (let q = 1; q < pts.length; q++) total += Math.hypot(pts[q][0] - pts[q - 1][0], pts[q][1] - pts[q - 1][1]);
      if (total < 2) continue;
      const len = total, strength = (0.5 + 0.5 * wet) * k * tint;
      // walk along the path laying the veil down every `step` metres
      let q = 1, segL = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]), along = 0, at = 0;
      for (let dist = 0.4; dist < len; dist += step) {
        while (q < pts.length - 1 && at + segL < dist) { at += segL; q++; segL = Math.hypot(pts[q][0] - pts[q - 1][0], pts[q][1] - pts[q - 1][1]); }
        const f = segL > 0 ? (dist - at) / segL : 0;
        const x = pts[q - 1][0] + (pts[q][0] - pts[q - 1][0]) * f, y = pts[q - 1][1] + (pts[q][1] - pts[q - 1][1]) * f;
        const dir = Math.atan2(pts[q - 1][1] - pts[q][1], pts[q - 1][0] - pts[q][0]);
        const u = dist / len;                                   // 0 right behind the car .. 1 the far end
        // thick just behind the car, then thinning out; wider further back
        const a = strength * Math.min(1, u * 6 + 0.25) * Math.pow(1 - u, 1.25) * (lite ? 0.48 : 0.32);
        const wid = 1.3 + 4.8 * Math.pow(u, 0.7) * (0.7 + 0.5 * k), lng = step * 2.6 + 1.5 * u;
        ctx.save(); ctx.translate(x, y); ctx.rotate(dir);
        if (dist < 5 && !lite) {
          // first metres: two narrow trails straight off the rear wheels, coming together
          const sep = 0.8 * (1 - dist / 5);
          ctx.globalAlpha = a * 0.9;
          ctx.drawImage(V.soft, -lng / 2, -sep - 0.5, lng, 1.0);
          ctx.drawImage(V.soft, -lng / 2, sep - 0.5, lng, 1.0);
        }
        ctx.globalAlpha = a;
        ctx.drawImage(V.soft, -lng / 2, -wid / 2, lng, wid);
        if (!lite) { ctx.globalAlpha = a * 0.6; ctx.drawImage(V.streak, -lng * 0.7, -wid * 0.42, lng * 1.4, wid * 0.84); }
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    for (const id in TR) if (!seen[id]) delete TR[id];
  };

  /* The dry line coming through after rain: two tyre tracks (a car's wheels are about 1.6 m apart) with ragged,
     broken edges, widening and joining into one dry line as the track dries (ld 0..1). Each track is a few thin
     strands broken up in different places, so the patches are irregular. Made the first time it is needed. */
  Renderer.prototype.drawDryLine = function (ctx, TT, vis, COL, a, ld) {
    const OFFS = [-1.1, -0.82, -0.55, 0.55, 0.82, 1.1, 0];
    const build = function (ch, d0) {
      const p = new Path2D(), N = TT.n;
      for (let k = ch.c0; k <= ch.c1; k++) {
        const i = k % N, nx = -Math.sin(TT.hd[i]), ny = Math.cos(TT.hd[i]);
        // cars don't all drive the exact same line: it wanders a little
        const wob = 0.3 * Math.sin(k * 0.045) + 0.16 * Math.sin(k * 0.13 + 2.1) + 0.06 * Math.sin(k * 0.71 + d0 * 9);
        const d = d0 + wob;
        const x = TT.rlX[i] + nx * d, y = TT.rlY[i] + ny * d;
        if (k === ch.c0) p.moveTo(x, y); else p.lineTo(x, y);
      }
      return p;
    };
    const P = OFFS.map(function () { return new Path2D(); });
    for (const ch of vis) {
      if (!ch.dryP) ch.dryP = OFFS.map(function (d) { return build(ch, d); });
      for (let j = 0; j < OFFS.length; j++) P[j].addPath(ch.dryP[j]);
    }
    const dry = mixHex(COL.asphalt, '#62666d', 0.2);
    ctx.save();
    ctx.lineCap = 'round'; ctx.strokeStyle = dry;
    // the middle between the wheels dries last
    if (ld > 0.45) {
      const f = (ld - 0.45) / 0.55;
      ctx.globalAlpha = a * f * 0.6;
      ctx.lineWidth = 0.6 + 1.8 * f;
      ctx.setLineDash([13, 3.5 * (1 - f), 6, 2.4 * (1 - f), 21, 4.2 * (1 - f), 9, 1.8 * (1 - f)]);
      ctx.stroke(P[6]);
    }
    const gap = Math.max(0.08, 1 - ld), w = 0.3 + 0.35 * ld;
    const DASH = [4.2, 3.1, 1.6, 1.9, 7.5, 4.4, 2.4, 1.2, 9.8, 2.7, 3.3, 5.1];
    const dash = DASH.map(function (v, q) { return q % 2 ? v * gap : v; });
    // [path, strength, dash offset]: the middle of each wheel track strongest, its edges fainter and more broken
    const strands = [[1, 0.75, 0], [4, 0.75, 6.1], [0, 0.35, 3.1], [2, 0.45, 9.4], [3, 0.45, 12.2], [5, 0.35, 1.7]];
    ctx.setLineDash(dash); ctx.lineWidth = w;
    for (const st of strands) {
      ctx.globalAlpha = a * st[1] * (0.75 + 0.25 * ld);
      ctx.lineDashOffset = st[2];
      ctx.stroke(P[st[0]]);
    }
    ctx.restore();
  };

  /* Standing water in heavy rain: soft-edged pools near the edges of the track, longer than they are wide, with
     no outline. In daylight they mirror the grey sky (a little lighter than the wet track, smooth); at night they
     are darker, like black glass. Rain drops landing on them make little rings. */
  Renderer.prototype.puddleSprite = function (v, night) {
    const cache = this.pudSpr || (this.pudSpr = {}), key = v + (night ? 'n' : 'd');
    if (cache[key]) return cache[key];
    const W = 160, H = 64, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    let seed = 31 + v * 977; const rnd = function () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    // a chain of overlapping ovals along the length: one smooth, slightly uneven pool
    const blobs = [], n = 3 + Math.floor(rnd() * 2);
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0.5;
      blobs.push({ x: W * (0.36 + 0.28 * t), y: H / 2 + (rnd() - 0.5) * 5, rx: W * (0.2 + rnd() * 0.06), ry: H * (0.26 + rnd() * 0.08) });
    }
    // soft edge: the same shape several times, each a little smaller, so the edge fades in
    for (let j = 0; j < 8; j++) {
      const sc = 1.08 - j * 0.04;
      g.fillStyle = night ? 'rgba(6,8,12,0.13)' : 'rgba(120,130,146,0.085)';
      g.beginPath();
      for (const b of blobs) { g.moveTo(b.x + b.rx * sc, b.y); g.ellipse(b.x, b.y, b.rx * sc, b.ry * sc, 0, 0, TAU); }
      g.fill();
    }
    // the reflection: a soft lighter band across the water
    g.globalCompositeOperation = 'source-atop';
    const gr = g.createLinearGradient(0, 0, W * 0.6, H);
    gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.55, night ? 'rgba(90,100,120,0.16)' : 'rgba(225,232,242,0.2)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    cache[key] = cv;
    return cv;
  };
  Renderer.prototype.drawPuddles = function (ctx, vis, a, rain, night, dt, vc, vr) {
    const rip = this.ripples || (this.ripples = []), live = [];
    ctx.save();
    ctx.globalAlpha = a;
    for (const ch of vis) {
      for (const p of ch.pudL) {
        if (Math.abs(p.x - vc[0]) > vr + 8 || Math.abs(p.y - vc[1]) > vr + 8) continue;
        live.push(p);
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a);
        ctx.drawImage(this.puddleSprite(p.v, night), -p.l, -p.w, 2 * p.l, 2 * p.w);
        ctx.restore();
      }
    }
    ctx.restore();
    // rain drops landing in them: small rings that spread and fade
    const st = Math.min(0.05, dt || 0);
    if (rain > 0.05 && live.length && st > 0) {
      let want = rain * live.length * 5 * st;
      while (want > 0 && rip.length < 300) {
        if (want >= 1 || Math.random() < want) {
          const p = live[Math.floor(Math.random() * live.length)], u = (Math.random() - 0.5) * 1.3 * p.l, v = (Math.random() - 0.5) * 0.9 * p.w;
          rip.push({ x: p.x + Math.cos(p.a) * u - Math.sin(p.a) * v, y: p.y + Math.sin(p.a) * u + Math.cos(p.a) * v, t: 0 });
        }
        want -= 1;
      }
    }
    if (rip.length) {
      const path = new Path2D();
      let k = 0;
      for (let i = 0; i < rip.length; i++) {
        const r = rip[i]; r.t += st;
        if (r.t > 0.5) continue;
        rip[k++] = r;
        const rad = 0.08 + r.t * 1.0;
        path.moveTo(r.x + rad, r.y); path.arc(r.x, r.y, rad, 0, TAU);
      }
      rip.length = k;
      ctx.strokeStyle = night ? 'rgba(170,185,210,' + (0.2 * a).toFixed(3) + ')' : 'rgba(235,242,250,' + (0.26 * a).toFixed(3) + ')';
      ctx.lineWidth = 0.045; ctx.stroke(path);
    }
  };

  /* Rain on the screen, seen from above: faint, short flicks of falling drops, each a little different (length,
     angle, brightness, speed), with gusts swaying them now and then; little splash rings; and the picture a little
     darker and greyer the harder it rains (a light haze in a downpour). */
  Renderer.prototype.drawRain = function (ctx, rain, wet, dt) {
    const W = this.w, H = this.h, area = (W * H) / (1366 * 768), ph = Math.min(1.2, Math.max(0.6, H / 768));
    // darker and a little greyer: in heavy rain a light haze hangs over everything (one wash over the screen)
    const shade = 0.05 * wet + 0.22 * Math.max(0, rain - 0.25) / 0.75, haze = Math.max(0, rain - 0.3) / 0.7;
    if (shade > 0.005) {
      const r = Math.round(30 + 40 * haze), g = Math.round(38 + 40 * haze), b = Math.round(50 + 40 * haze);
      ctx.fillStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + shade.toFixed(3) + ')'; ctx.fillRect(0, 0, W, H);
    }
    const now = performance.now() / 1000, mv = Math.min(dt, 0.05);
    const want = rain < 0.02 ? 0 : Math.round(area * (rain < 0.5 ? 50 + 320 * rain : 140 + 340 * rain) * (this.lite ? 0.5 : 1));
    const P = this.rainP;
    // gusts: the angle sways slowly
    const ang = 0.3 + 0.08 * Math.sin(now * 0.7) + 0.04 * Math.sin(now * 2.3);
    const spawn = function (p, top) {
      p.da = (Math.random() - 0.5) * 0.12;                      // each drop a little different
      p.y = top ? -20 - Math.random() * H * 0.2 : Math.random() * H;
      p.x = Math.random() * (W + H * 0.4) - H * 0.4 * (top ? 0.5 : 0);
      p.v = (1100 + Math.random() * 900) * ph * (0.85 + 0.3 * rain);
      p.l = (3 + Math.random() * 6 + 5 * rain) * ph;            // short flicks
      p.c = Math.floor(Math.random() * 3);                       // brightness: three shades
      return p;
    };
    while (P.length < want) P.push(spawn({}, false));
    if (P.length > want) P.length = Math.max(want, P.length - Math.ceil(P.length * 0.04 + 1));     // eases off
    const paths = [new Path2D(), new Path2D(), new Path2D()];
    for (let i = 0; i < P.length; i++) {
      const p = P[i], dx = Math.sin(ang + p.da), dy = Math.cos(ang + p.da);
      p.x += dx * p.v * mv; p.y += dy * p.v * mv;
      if (p.y - p.l > H || p.x - p.l > W) spawn(p, true);
      paths[p.c].moveTo(p.x, p.y); paths[p.c].lineTo(p.x - dx * p.l, p.y - dy * p.l);
    }
    ctx.lineCap = 'butt';
    ctx.lineWidth = rain > 0.55 ? 1.2 : 1;
    const AL = [0.11, 0.2, 0.32];
    for (let q = 0; q < 3; q++) { ctx.strokeStyle = 'rgba(215,226,244,' + AL[q] + ')'; ctx.stroke(paths[q]); }
    ctx.lineCap = 'butt';
    // splashes: little rings where drops land (fading as they grow: three shades, one stroke each)
    if (!this.lite) {
      const S = this.splash, now = performance.now() / 1000, life = 0.32;
      let add = rain * area * 110 * mv;
      while (add > 0) { if (add >= 1 || Math.random() < add) S.push({ x: Math.random() * W, y: Math.random() * H, t: now }); add -= 1; }
      const rings = [new Path2D(), new Path2D(), new Path2D()];
      let k = 0;
      for (let i = 0; i < S.length; i++) {
        const sp = S[i], f = (now - sp.t) / life;
        if (f >= 1) continue;
        S[k++] = sp;
        const r = (0.8 + 4.2 * f) * ph, g = rings[f < 0.33 ? 0 : f < 0.66 ? 1 : 2];
        g.moveTo(sp.x + r, sp.y); g.arc(sp.x, sp.y, r, 0, TAU);
      }
      S.length = k;
      ctx.lineWidth = 0.9;
      for (let q = 0; q < 3; q++) { ctx.strokeStyle = 'rgba(215,228,245,' + (0.26 - q * 0.08).toFixed(2) + ')'; ctx.stroke(rings[q]); }
    }
  };

  /* The bridge deck: shadow on the road below, concrete sides, barriers, the road and its edge lines. */
  Renderer.prototype.drawBridge = function (ctx, B, T) {
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
    ctx.strokeStyle = 'rgba(0,0,0,0.32)'; ctx.lineWidth = 2 * B.w + 3; ctx.stroke(B.shadow);
    ctx.strokeStyle = COL.bridgeSide; ctx.lineWidth = 2 * B.w + 3; ctx.stroke(B.road);
    ctx.strokeStyle = COL.armco; ctx.lineWidth = 2 * B.w + 1.6; ctx.stroke(B.road);
    ctx.strokeStyle = COL.barrier; ctx.lineWidth = 2 * B.w + 0.8; ctx.stroke(B.road);
    ctx.strokeStyle = COL.deck; ctx.lineWidth = 2 * B.w; ctx.stroke(B.road);
    ctx.strokeStyle = COL.asphalt; ctx.lineWidth = 2 * T.hw; ctx.stroke(B.road);
    ctx.strokeStyle = COL.line; ctx.lineWidth = 0.28; ctx.stroke(B.edges);
    ctx.restore();
  };

  Renderer.prototype.drawPit = function (ctx, pit, T, frame) {
    const now = performance.now() / 1000;
    ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
    // ground
    ctx.fillStyle = '#4b5058'; ctx.fill(pit.ground);
    ctx.fillStyle = '#5e636b'; ctx.fill(pit.apron);
    ctx.fillStyle = '#3d4045'; ctx.fill(pit.road);
    // markings
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 0.22; ctx.stroke(pit.lines);
    ctx.setLineDash([2.2, 2.2]); ctx.lineWidth = 0.18; ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.stroke(pit.dash); ctx.setLineDash([]);
    for (let i = 0; i < pit.limit.length; i++) {
      const a = pit.limit[i][0], b = pit.limit[i][1];
      ctx.strokeStyle = '#f2f2f2'; ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([0.9, 0.9]); ctx.strokeStyle = '#e10600'; ctx.lineWidth = 0.7; ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 0.3; ctx.stroke(pit.blend);
    for (let i = 0; i < pit.texts.length; i++) worldText(ctx, pit.texts[i]);
    // pit boxes
    for (let i = 0; i < pit.boxes.length; i++) {
      const b = pit.boxes[i];
      quadPath(ctx, b.outline); ctx.strokeStyle = b.color; ctx.lineWidth = 0.28; ctx.stroke();
      ctx.globalAlpha = 0.12; ctx.fillStyle = b.color; ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      for (let k = 0; k < b.marks.length; k++) { quadPath(ctx, b.marks[k]); ctx.fill(); }
      ctx.fillStyle = '#ffd600'; quadPath(ctx, b.stop); ctx.fill();
    }
    // pit wall with the team stands
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#7d858c'; ctx.lineWidth = 0.9; ctx.stroke(pit.wall);
    ctx.strokeStyle = '#e8e8e8'; ctx.lineWidth = 0.5; ctx.stroke(pit.wall);
    ctx.lineCap = 'butt';
    for (let i = 0; i < pit.stands.length; i++) {
      const st = pit.stands[i];
      ctx.fillStyle = '#1b1d22'; quadPath(ctx, st.body); ctx.fill();
      ctx.fillStyle = st.color; quadPath(ctx, st.roof); ctx.fill();
    }
    // garages: shadow, floor, team fronts, open doors; the cars in the garages (and rolling in or out of them);
    // the roof over them, see-through so the parked cars still show; names, dividers
    ctx.save(); ctx.translate(0.7, 0.9); ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fill(pit.building); ctx.restore();
    ctx.fillStyle = '#2a2d33'; ctx.fill(pit.building);
    for (let i = 0; i < pit.garages.length; i++) {
      const g = pit.garages[i];
      ctx.fillStyle = g.color; quadPath(ctx, g.front); ctx.fill();
      ctx.fillStyle = '#0d0e11'; quadPath(ctx, g.door); ctx.fill();
    }
    const inG = frame && frame.garage;
    if (inG && inG.length) {
      for (let i = 0; i < inG.length; i++) {
        const c = inG[i];
        if (c.me) this.drawMeGlow(ctx, c);
        this.drawCar(ctx, c, c.team, c.delta || 0, false);
      }
      ctx.globalAlpha = 0.6; ctx.fillStyle = '#2a2d33'; ctx.fill(pit.roof); ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = '#41464f'; ctx.lineWidth = 0.35; ctx.stroke(pit.building);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 0.25; ctx.stroke(pit.ribs);
    for (let i = 0; i < pit.garages.length; i++) {
      const g = pit.garages[i];
      ctx.font = '900 40px ' + FONT;
      const w40 = ctx.measureText(g.name.t).width / 40;
      g.name.size = Math.min(2.4, g.name.room / Math.max(0.1, w40));
      worldText(ctx, g.name);
    }
    ctx.strokeStyle = '#9aa1a8'; ctx.lineWidth = 0.3; ctx.stroke(pit.dividers);
    // paddock
    for (let i = 0; i < pit.paddock.length; i++) {
      const v = pit.paddock[i];
      ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.save(); ctx.translate(0.5, 0.6); quadPath(ctx, v.q); ctx.fill(); ctx.restore();
      if (v.kind === 'home') {
        ctx.fillStyle = '#e9ecef'; quadPath(ctx, v.q); ctx.fill();
        ctx.fillStyle = v.color; quadPath(ctx, v.roof); ctx.fill();
      } else {
        ctx.fillStyle = v.color; quadPath(ctx, v.q); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.15; ctx.stroke();
        ctx.fillStyle = '#1d2026'; quadPath(ctx, v.cab); ctx.fill();
      }
    }
    // pit exit light
    const L = pit.light, red = frame && frame.pitRed;
    ctx.save(); ctx.translate(L.p.x, L.p.y); ctx.rotate(L.a);
    ctx.fillStyle = '#111'; ctx.fillRect(-0.7, -0.45, 1.4, 0.9);
    ctx.fillStyle = red ? '#ff2a1f' : (Math.floor(now * 2) % 2 ? '#2bff6a' : '#19c94a');
    ctx.beginPath(); ctx.arc(0, 0, 0.32, 0, TAU); ctx.fill();
    ctx.restore();
  };

  /* Start-light gantry (drawn over the cars). */
  Renderer.prototype.drawGantry = function (ctx, g, lights) {
    ctx.save(); ctx.translate(0.9, 1.1); ctx.fillStyle = 'rgba(0,0,0,0.28)'; quadPath(ctx, g.beam); ctx.fill(); ctx.restore();
    ctx.fillStyle = '#5a5f67';
    for (let i = 0; i < g.legs.length; i++) { quadPath(ctx, g.legs[i]); ctx.fill(); }
    ctx.fillStyle = '#23262b'; quadPath(ctx, g.beam); ctx.fill();
    ctx.strokeStyle = '#3a3e45'; ctx.lineWidth = 0.15; ctx.stroke();
    for (let k = 0; k < g.units.length; k++) {
      const u = g.units[k], on = lights > k;
      ctx.fillStyle = '#0b0c0e'; quadPath(ctx, u.box); ctx.fill();
      ctx.fillStyle = on ? '#ff2a1f' : '#3a1210';
      if (on) { ctx.shadowColor = '#ff2a1f'; ctx.shadowBlur = 14; }
      ctx.beginPath(); ctx.arc(u.c1.x, u.c1.y, 0.32, 0, TAU); ctx.arc(u.c2.x, u.c2.y, 0.32, 0, TAU); ctx.fill();
      ctx.shadowBlur = 0;
    }
  };
  function quadPath(ctx, q) {
    ctx.beginPath(); ctx.moveTo(q[0].x, q[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y);
    ctx.closePath();
  }

  Renderer.prototype.drawMeGlow = function (ctx, c) {
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.fillStyle = 'rgba(255,214,0,0.16)';
    ctx.beginPath(); ctx.arc(0, 0, 4.4, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(255,214,0,0.85)'; ctx.lineWidth = 0.22;
    ctx.beginPath(); ctx.arc(0, 0, 4.4, 0, TAU); ctx.stroke();
    ctx.restore();
  };

  function poly(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.closePath();
  }
  const BODY = [-2.05, -0.22, -1.5, -0.5, -0.6, -0.66, 0.25, -0.64, 0.65, -0.38, 1.25, -0.2, 2.45, -0.11, 2.62, -0.06, 2.62, 0.06, 2.45, 0.11, 1.25, 0.2, 0.65, 0.38, 0.25, 0.64, -0.6, 0.66, -1.5, 0.5, -2.05, 0.22];
  const FLOOR = [-2.0, -0.62, -0.9, -0.74, 0.9, -0.62, 1.2, -0.3, 1.2, 0.3, 0.9, 0.62, -0.9, 0.74, -2.0, 0.62];
  const COVER = [-2.12, -0.1, -0.4, -0.2, 0.3, -0.15, 0.3, 0.15, -0.4, 0.2, -2.12, 0.1];

  /* Draws a car centred at (c.x, c.y) heading c.a in world metres: a soft shadow in the car's shape (offset fixed
     in world space, as if from the sun), the front wheels (they steer), then the rest of the car from a picture
     made once per team / tyre / DRS (shaded paint and all), so a full grid costs little to draw. */
  Renderer.prototype.drawCar = function (ctx, c, team, delta, drsOpen) {
    const sh = carShadow();
    ctx.save();
    ctx.translate(c.x + 0.32, c.y + 0.4);
    ctx.rotate(c.a);
    ctx.globalAlpha *= 0.5;
    ctx.drawImage(sh, -CAR_X0 - SH_PAD, -CAR_HW - SH_PAD, (CAR_X0 + CAR_X1) + 2 * SH_PAD, 2 * CAR_HW + 2 * SH_PAD);
    ctx.restore();
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.a);
    const tc = c.tyreC && F1.TYRES[c.tyreC] ? F1.TYRES[c.tyreC].col : null;
    for (const sy of [-0.77, 0.77]) {
      ctx.save(); ctx.translate(1.55, sy); ctx.rotate(delta * 1.6);
      tyreShape(ctx, -0.35, -0.17, 0.7, 0.34, tc);
      ctx.restore();
    }
    const spr = carSprite(team, tc, drsOpen);
    ctx.drawImage(spr, -CAR_X0, -CAR_HW, CAR_X0 + CAR_X1, 2 * CAR_HW);
    if (this.night) {
      // night races: the red rear light glows
      ctx.fillStyle = 'rgba(255,40,40,0.28)';
      ctx.beginPath(); ctx.arc(-2.72, 0, 0.75, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ff3b30'; ctx.fillRect(-2.8, -0.14, 0.16, 0.28);
    }
    ctx.restore();
  };

  // the car picture covers x -2.9 .. 2.8 m (rear to front wing), y -1.05 .. 1.05 m; 40 px a metre
  const CAR_X0 = 2.9, CAR_X1 = 2.8, CAR_HW = 1.05, SPR_K = 40, SH_PAD = 0.45;
  const sprites = {};
  function carSprite(team, tc, drsOpen) {
    const key = team.primary + team.secondary + team.accent + (team.split ? 's' : '') + (tc || '-') + (drsOpen ? 'd' : '');
    let cv = sprites[key];
    if (cv) return cv;
    cv = document.createElement('canvas');
    cv.width = Math.ceil((CAR_X0 + CAR_X1) * SPR_K); cv.height = Math.ceil(2 * CAR_HW * SPR_K);
    const g = cv.getContext('2d');
    g.scale(SPR_K, SPR_K); g.translate(CAR_X0, CAR_HW);
    drawCarLocal(g, team, 0, drsOpen, null, tc, true);
    sprites[key] = cv;
    return cv;
  }
  // the shadow: the car's outline, blurred (the same for every car)
  let shadowCv = null;
  function carShadow() {
    if (shadowCv) return shadowCv;
    const K = 20, cv = document.createElement('canvas');
    cv.width = Math.ceil((CAR_X0 + CAR_X1 + 2 * SH_PAD) * K); cv.height = Math.ceil((2 * CAR_HW + 2 * SH_PAD) * K);
    const g = cv.getContext('2d');
    // build the silhouette once, then lay it down several times, shifted a little each time: a soft edge
    const sil = document.createElement('canvas'); sil.width = cv.width; sil.height = cv.height;
    const s = sil.getContext('2d');
    s.scale(K, K); s.translate(CAR_X0 + SH_PAD, CAR_HW + SH_PAD);
    s.fillStyle = '#000';
    s.fillRect(-2.34, -0.97, 0.78, 0.44); s.fillRect(-2.34, 0.53, 0.78, 0.44);      // rear tyres
    s.fillRect(1.2, -0.94, 0.7, 0.34); s.fillRect(1.2, 0.6, 0.7, 0.34);             // front tyres
    poly(s, FLOOR); s.fill(); poly(s, BODY); s.fill();
    s.fillRect(2.3, -0.98, 0.36, 1.96);                                             // front wing
    s.fillRect(-2.78, -0.58, 0.36, 1.16);                                           // rear wing
    const offs = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [-2, 0], [0, 2], [0, -2]];
    g.globalAlpha = 1 / 5;
    for (const o of offs) g.drawImage(sil, o[0] * 2, o[1] * 2);
    shadowCv = cv;
    return cv;
  }

  function shadeHex(h, f) {           // f < 1 darker, > 1 lighter
    const n = parseInt(h.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    const m = function (v) { return Math.max(0, Math.min(255, Math.round(f < 1 ? v * f : v + (255 - v) * (f - 1)))); };
    return 'rgb(' + m(r) + ',' + m(g) + ',' + m(b) + ')';
  }
  function rrectPath(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  // a tyre from above: rounded, darker at the edges, a coloured band on each sidewall (the compound)
  function tyreShape(ctx, x, y, w, h, col) {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#141416'); g.addColorStop(0.5, '#38383c'); g.addColorStop(1, '#141416');
    ctx.fillStyle = g; rrectPath(ctx, x, y, w, h, 0.09); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 0.03; ctx.stroke();
    if (col) {
      ctx.fillStyle = col;
      ctx.fillRect(x + 0.1, y + 0.025, w - 0.2, 0.055); ctx.fillRect(x + 0.1, y + h - 0.08, w - 0.2, 0.055);
    }
  }

  /* The car in its own frame (metres, nose along +x). tc = the tyre colour (sidewall bands) or null;
     noFront: leave out the front tyres (drawCar draws them, turned with the steering). */
  function drawCarLocal(ctx, team, delta, drsOpen, tyreC, tc, noFront) {
    if (tc === undefined) tc = tyreC && F1.TYRES[tyreC] ? F1.TYRES[tyreC].col : null;
    // rear tyres
    tyreShape(ctx, -2.34, -0.97, 0.78, 0.44, tc);
    tyreShape(ctx, -2.34, 0.53, 0.78, 0.44, tc);
    // front tyres (steer)
    if (!noFront) for (const sy of [-0.77, 0.77]) {
      ctx.save(); ctx.translate(1.55, sy); ctx.rotate(delta * 1.6);
      tyreShape(ctx, -0.35, -0.17, 0.7, 0.34, tc);
      ctx.restore();
    }
    // suspension arms
    ctx.strokeStyle = '#3a3a3d'; ctx.lineWidth = 0.055; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(1.2, -0.22); ctx.lineTo(1.55, -0.62); ctx.moveTo(1.2, 0.22); ctx.lineTo(1.55, 0.62);
    ctx.moveTo(1.0, -0.3); ctx.lineTo(1.5, -0.62); ctx.moveTo(1.0, 0.3); ctx.lineTo(1.5, 0.62);
    ctx.moveTo(-1.6, -0.4); ctx.lineTo(-1.95, -0.55); ctx.moveTo(-1.6, 0.4); ctx.lineTo(-1.95, 0.55);
    ctx.stroke();
    // floor, with a lighter edge
    ctx.fillStyle = '#18181a'; poly(ctx, FLOOR); ctx.fill();
    ctx.strokeStyle = '#2e2e33'; ctx.lineWidth = 0.05; ctx.stroke();
    // body: rounded across its width (light along the top, darker down the sides)
    const bodyGrad = function (col) {
      const g = ctx.createLinearGradient(0, -0.66, 0, 0.66);
      g.addColorStop(0, shadeHex(col, 0.52)); g.addColorStop(0.28, shadeHex(col, 0.92)); g.addColorStop(0.5, shadeHex(col, 1.1));
      g.addColorStop(0.72, shadeHex(col, 0.92)); g.addColorStop(1, shadeHex(col, 0.52));
      return g;
    };
    ctx.fillStyle = bodyGrad(team.primary); poly(ctx, BODY); ctx.fill();
    if (team.split) {
      ctx.save(); ctx.beginPath(); ctx.rect(-3, 0, 6, 1.5); ctx.clip();
      ctx.fillStyle = bodyGrad(team.secondary); poly(ctx, BODY); ctx.fill();
      ctx.restore();
    }
    // sidepod inlets
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath(); ctx.ellipse(0.2, -0.55, 0.16, 0.07, 0.35, 0, TAU); ctx.ellipse(0.2, 0.55, 0.16, 0.07, -0.35, 0, TAU); ctx.fill();
    // engine cover in the second colour, also rounded
    const cov = team.split ? team.accent : team.secondary;
    const cg = ctx.createLinearGradient(0, -0.22, 0, 0.22);
    cg.addColorStop(0, shadeHex(cov, 0.62)); cg.addColorStop(0.5, shadeHex(cov, 1.08)); cg.addColorStop(1, shadeHex(cov, 0.62));
    ctx.fillStyle = cg; poly(ctx, COVER); ctx.fill();
    // a shine along the top of the nose and the engine cover
    ctx.strokeStyle = 'rgba(255,255,255,0.26)'; ctx.lineWidth = 0.06;
    ctx.beginPath(); ctx.moveTo(1.3, 0); ctx.lineTo(2.45, 0); ctx.moveTo(-0.5, 0); ctx.lineTo(-1.9, 0); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 0.035; poly(ctx, BODY); ctx.stroke();
    // front wing: main plane and flap, swept back at the tips, with end plates
    ctx.fillStyle = shadeHex(team.secondary, 0.95);
    ctx.beginPath(); ctx.moveTo(2.66, -0.25); ctx.lineTo(2.66, 0.25); ctx.lineTo(2.56, 0.95); ctx.lineTo(2.36, 0.95); ctx.lineTo(2.44, 0.25); ctx.lineTo(2.44, -0.25); ctx.lineTo(2.36, -0.95); ctx.lineTo(2.56, -0.95); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#151517'; ctx.fillRect(2.3, -0.9, 0.07, 1.8);
    ctx.fillStyle = team.primary; ctx.fillRect(2.3, -0.98, 0.32, 0.06); ctx.fillRect(2.3, 0.92, 0.32, 0.06);
    // rear wing (flap opens with DRS), end plates
    ctx.fillStyle = shadeHex(team.primary, 0.85); ctx.fillRect(-2.74, -0.54, 0.22, 1.08);
    ctx.fillStyle = drsOpen ? '#7CFF6B' : team.secondary; ctx.fillRect(drsOpen ? -2.46 : -2.52, -0.5, 0.15, 1.0);
    ctx.fillStyle = '#0f0f10'; ctx.fillRect(-2.78, -0.58, 0.36, 0.07); ctx.fillRect(-2.78, 0.51, 0.36, 0.07);
    // cockpit, helmet with visor, halo
    ctx.fillStyle = '#0a0a0b'; ctx.beginPath(); ctx.ellipse(0.5, 0, 0.46, 0.25, 0, 0, TAU); ctx.fill();
    const hg = ctx.createRadialGradient(0.46, -0.05, 0.02, 0.42, 0, 0.17);
    hg.addColorStop(0, shadeHex(team.accent, 1.35)); hg.addColorStop(1, shadeHex(team.accent, 0.8));
    ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(0.42, 0, 0.16, 0, TAU); ctx.fill();
    ctx.fillStyle = '#16181c'; ctx.fillRect(0.5, -0.09, 0.07, 0.18);
    ctx.strokeStyle = '#4a4b50'; ctx.lineWidth = 0.075;
    ctx.beginPath(); ctx.ellipse(0.47, 0, 0.36, 0.27, 0, -1.25, 1.25); ctx.moveTo(0.83, 0); ctx.lineTo(1.0, 0); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 0.03;
    ctx.beginPath(); ctx.ellipse(0.47, 0, 0.36, 0.27, 0, -1.0, -0.2); ctx.stroke();
    ctx.lineCap = 'butt';
  }
  Renderer.drawCarLocal = drawCarLocal;

  /* A radio-style message strip: your engineer (blue tag, with a little radio level meter for a moment) or race
     control (yellow tag for a warning, red for a penalty). Title and second line share one line when they fit,
     otherwise the second line goes underneath. Slim, so the road ahead stays in view. Returns its height. */
  Renderer.prototype.drawRadioStrip = function (ctx, m, cx, y, maxW, phone) {
    const rc = m.from === 'rc', pen = m.sign === 'pen';
    const tagTxt = rc ? 'RACE CONTROL' : 'ENGINEER';
    const tagBg = rc ? (pen ? '#e10600' : '#ffd400') : '#2f6fed', tagFg = rc && !pen ? '#111' : '#fff';
    const fTag = phone ? 9 : 10, fT = phone ? 13 : 16, fS = phone ? 11.5 : 13.5;
    const padX = phone ? 8 : 10, gap = phone ? 7 : 9, meterW = rc ? 0 : (phone ? 12 : 14);
    ctx.save();
    ctx.globalAlpha = m.alpha === undefined ? 1 : m.alpha;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.font = '800 ' + fTag + 'px ' + FONT;
    const tagW = ctx.measureText(tagTxt).width + (phone ? 10 : 12);
    let tFont = fT;
    ctx.font = '800 ' + tFont + 'px ' + FONT;
    let titleW = ctx.measureText(m.text).width;
    const head = padX + tagW + gap + (meterW ? meterW + gap : 0);
    while (tFont > 10 && head + titleW + padX > maxW) { tFont--; ctx.font = '800 ' + tFont + 'px ' + FONT; titleW = ctx.measureText(m.text).width; }
    ctx.font = '600 ' + fS + 'px ' + FONT;
    const sub = m.sub || '', subW = sub ? ctx.measureText(sub).width : 0;
    const one = !sub || head + titleW + 14 + subW + padX <= maxW;
    let subs = [];
    if (sub && !one) subs = wrapText(ctx, sub, maxW - head - padX);
    let w = one ? head + titleW + (sub ? 14 + subW : 0) + padX : head + Math.max(titleW, Math.max.apply(null, subs.map(function (t) { return ctx.measureText(t).width; }))) + padX;
    w = Math.min(w, maxW);
    const lh = phone ? 24 : 30, sh = phone ? 15 : 18;
    const h = one ? lh : lh + subs.length * sh - (phone ? 4 : 6);
    const x = cx - w / 2;
    ctx.fillStyle = 'rgba(10,10,14,0.86)'; roundRect(ctx, x, y, w, h, 5); ctx.fill();
    ctx.fillStyle = m.color || tagBg; ctx.fillRect(x, y, 3, h);
    // the label
    const tagH = phone ? 14 : 17, ty = y + lh / 2;
    ctx.fillStyle = tagBg; roundRect(ctx, x + padX, ty - tagH / 2, tagW, tagH, 3); ctx.fill();
    ctx.fillStyle = tagFg; ctx.font = '800 ' + fTag + 'px ' + FONT; ctx.textAlign = 'center';
    ctx.fillText(tagTxt, x + padX + tagW / 2, ty + 0.5);
    ctx.textAlign = 'left';
    let tx = x + padX + tagW + gap;
    if (meterW) {
      // radio level meter: bouncing while the message comes in, then resting
      const live = (m.age || 0) < 1400, t = (m.age || 0) / 1000;
      for (let k = 0; k < 4; k++) {
        const lvl = live ? 0.35 + 0.65 * Math.abs(Math.sin(t * (9 + k * 3.7) + k * 1.3)) : 0.3;
        const bh = Math.max(2, (tagH - 3) * lvl);
        ctx.fillStyle = live ? '#8fb4ff' : 'rgba(143,180,255,0.55)';
        ctx.fillRect(tx + k * (meterW / 4), ty + tagH / 2 - 1.5 - bh, meterW / 4 - 1.2, bh);
      }
      tx += meterW + gap;
    }
    ctx.fillStyle = '#fff'; ctx.font = '800 ' + tFont + 'px ' + FONT;
    ctx.fillText(m.text, tx, ty + 0.5);
    ctx.font = '600 ' + fS + 'px ' + FONT; ctx.fillStyle = m.subColor || '#cfd3d8';
    if (one && sub) ctx.fillText(sub, tx + titleW + 14, ty + 0.5);
    else for (let k = 0; k < subs.length; k++) ctx.fillText(subs[k], tx, y + lh - (phone ? 3 : 4) + k * sh + sh / 2);
    ctx.restore();
    return h;
  };

  Renderer.prototype.drawYouTag = function (ctx, x, y, small) {
    ctx.save();
    ctx.font = '800 ' + (small ? 10 : 12) + 'px "Titillium Web", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const w = small ? 30 : 38, h = small ? 14 : 18, a = small ? 4.5 : 6;
    ctx.fillStyle = '#ffd600';
    roundRect(ctx, x - w / 2, y - h, w, h, 4); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - a, y); ctx.lineTo(x + a, y); ctx.lineTo(x, y + a + 1); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#111'; ctx.fillText('YOU', x, y - h / 2 + 1);
    ctx.restore();
  };

  Renderer.prototype.drawLabel = function (ctx, x, y, c, small) {
    ctx.save();
    ctx.font = '700 ' + (small ? 9 : 11) + 'px "Titillium Web", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const txt = c.label || c.code;
    const w = ctx.measureText(txt).width + (small ? 10 : 14), h = small ? 13 : 16;
    ctx.globalAlpha = c.ghost ? 0.6 : 0.92;
    ctx.fillStyle = 'rgba(12,12,16,0.82)';
    roundRect(ctx, x - w / 2, y - h / 2, w, h, 3); ctx.fill();
    ctx.fillStyle = F1.teamUiColor(c.team);
    ctx.fillRect(x - w / 2, y - h / 2, 3, h);
    ctx.fillStyle = '#fff'; ctx.fillText(txt, x + 1.5, y + 0.5);
    ctx.restore();
  };

  Renderer.prototype.trackSkids = function (c, T) {
    const ca = Math.cos(c.a), sa = Math.sin(c.a);
    const vl = -(c.vx || 0) * sa + (c.vy || 0) * ca;
    const sp = Math.hypot(c.vx || 0, c.vy || 0);
    const rl = [c.x - ca * 1.95 + sa * 0.74, c.y - sa * 1.95 - ca * 0.74];
    const rr = [c.x - ca * 1.95 - sa * 0.74, c.y - sa * 1.95 + ca * 0.74];
    const prev = this.wheelPrev[c.id];
    this.wheelPrev[c.id] = [rl, rr];
    if (!prev) return;
    const moved = Math.hypot(rl[0] - prev[0][0], rl[1] - prev[0][1]);
    if (moved > 6) return;
    if (Math.abs(vl) > 2.4 && sp > 4) {
      this.skids.push([prev[0][0], prev[0][1], rl[0], rl[1]], [prev[1][0], prev[1][1], rr[0], rr[1]]);
      if (this.skids.length > 3000) this.skids.splice(0, this.skids.length - 3000);
    }
    if (c.lock && sp > 6) {
      // locked front tyres: flat-spot marks and white smoke
      const fl = [c.x + ca * 1.55 + sa * 0.77, c.y + sa * 1.55 - ca * 0.77];
      const fr = [c.x + ca * 1.55 - sa * 0.77, c.y + sa * 1.55 + ca * 0.77];
      const pf = this.wheelPrev['f' + c.id];
      if (pf) this.skids.push([pf[0][0], pf[0][1], fl[0], fl[1]], [pf[1][0], pf[1][1], fr[0], fr[1]]);
      this.wheelPrev['f' + c.id] = [fl, fr];
      if (Math.random() < 0.7) {
        const w = Math.random() < 0.5 ? fl : fr;
        this.parts.push({ x: w[0], y: w[1], vx: c.vx * 0.55 + (Math.random() - 0.5) * 2, vy: c.vy * 0.55 + (Math.random() - 0.5) * 2, life: 0.9, max: 0.9, r: 0.5, kind: 'smoke' });
      }
    } else if (this.wheelPrev['f' + c.id]) delete this.wheelPrev['f' + c.id];
    if ((c.surf === 2 || c.surf === 3) && sp > 12 && Math.random() < 0.5) {
      this.parts.push({ x: c.x - ca * 2.4, y: c.y - sa * 2.4, vx: c.vx * 0.2 + (Math.random() - 0.5) * 3, vy: c.vy * 0.2 + (Math.random() - 0.5) * 3, life: 0.7, max: 0.7, r: 1.0, kind: c.surf === 3 ? 'gravel' : 'grass' });
    }
  };

  Renderer.prototype.sparks = function (x, y, power) {
    const n = Math.min(18, 6 + Math.floor(power / 600));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, s = 6 + Math.random() * 16;
      this.parts.push({ x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.35 + Math.random() * 0.25, max: 0.6, r: 0.2, kind: 'spark' });
    }
    if (this.parts.length > 600) this.parts.splice(0, this.parts.length - 600);
  };

  Renderer.prototype.updateParticles = function (ctx, dt) {
    const keep = [];
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.94; p.vy *= 0.94;
      const t = p.life / p.max;
      if (p.kind === 'spark') {
        ctx.strokeStyle = 'rgba(255,' + Math.floor(170 + 80 * t) + ',60,' + t.toFixed(2) + ')';
        ctx.lineWidth = 0.18;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); ctx.stroke();
      } else if (p.kind === 'smoke') {
        ctx.fillStyle = 'rgba(235,235,235,' + (0.42 * t).toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r + (1 - t) * 2.4, 0, TAU); ctx.fill();
      } else {
        ctx.fillStyle = p.kind === 'gravel' ? 'rgba(200,180,130,' + (0.35 * t).toFixed(2) + ')' : 'rgba(90,120,60,' + (0.3 * t).toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r + (1 - t) * 1.8, 0, TAU); ctx.fill();
      }
      keep.push(p);
    }
    this.parts = keep;
  };

  // ------------------------------------------------------------- HUD
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  const FONT = '"Titillium Web", system-ui, sans-serif';

  /* hud = { title, lapText, tower:[{pos,code,color,info,me,out,done,purple}], lights, lightsOn, speed, gear, drs, cur, last, best,
             posText, msgs:[{text,sub,color}], wrongWay, timeLeft, hint, ping, cars (minimap dots), centre } */
  Renderer.prototype.drawHUD = function (hud, frame) {
    const ctx = this.ctx, W = this.w, H = this.h;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.textBaseline = 'middle';
    const TL = window.TouchUI ? window.TouchUI.L : null;     // the on-screen controls are in use (phones and tablets)
    const phone = !!(TL && TL.phone);
    const compact = W < 820 || phone;
    if (TL) window.TouchUI.hud(hud);

    // ---- timing tower (top-left)
    if (hud.tower && hud.tower.length) {
      let rows = hud.tower, cut = false;
      // a phone shows the leader and the cars around you: readable, and clear of the steering thumb
      if (phone) {
        const max = F1.clamp(Math.floor((H * 0.5 - 45) / 17), 4, 20);
        if (rows.length > max) {
          let me = 0;
          for (let i = 0; i < rows.length; i++) if (rows[i].me) me = i;
          const n = max - 1, start = F1.clamp(me - Math.floor(n / 2), 1, rows.length - n);
          cut = start > 1;
          rows = [rows[0]].concat(rows.slice(start, start + n));
        }
      }
      const rh = phone ? 17 : F1.clamp(Math.floor((H - 150) / (rows.length + 2)), 13, 22);
      const tw = compact ? 150 : 214, x0 = 12, y0 = 12;
      ctx.fillStyle = 'rgba(10,10,14,0.86)';
      roundRect(ctx, x0, y0, tw, rh * 1.6, 5); ctx.fill();
      ctx.fillStyle = '#e10600'; ctx.fillRect(x0, y0 + rh * 1.6 - 2, tw, 2);
      ctx.fillStyle = '#fff'; ctx.font = '800 ' + Math.round(rh * 0.62) + 'px ' + FONT; ctx.textAlign = 'left';
      ctx.fillText(hud.title || '', x0 + 10, y0 + rh * 0.8);
      const titleW = ctx.measureText(hud.title || '').width;
      let fs = Math.round(rh * 0.62);
      const right = hud.towerRight || '';
      ctx.font = '800 ' + fs + 'px ' + FONT;
      while (fs > 8 && ctx.measureText(right).width > tw - 28 - titleW) { fs--; ctx.font = '800 ' + fs + 'px ' + FONT; }
      ctx.textAlign = 'right'; ctx.fillStyle = '#cfd3d8';
      if (ctx.measureText(right).width <= tw - 24 - titleW) ctx.fillText(right, x0 + tw - 10, y0 + rh * 0.8);     // (left out when there is no room for it)
      let y = y0 + rh * 1.6 + 3;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        ctx.fillStyle = r.me ? '#ffd600' : (i % 2 ? 'rgba(18,18,24,0.82)' : 'rgba(26,26,34,0.82)');
        ctx.fillRect(x0, y, tw, rh - 1);
        ctx.fillStyle = r.me ? '#111' : (r.out ? '#777' : '#fff');
        ctx.font = '700 ' + Math.round(rh * 0.6) + 'px ' + FONT;
        ctx.textAlign = 'center';
        ctx.fillText(String(r.pos), x0 + 14, y + rh / 2);
        ctx.fillStyle = r.color; ctx.fillRect(x0 + 27, y + 3, 4, rh - 7);
        ctx.textAlign = 'left';
        ctx.fillStyle = r.me ? '#111' : (r.out ? '#777' : '#fff');
        ctx.font = '800 ' + Math.round(rh * 0.62) + 'px ' + FONT;
        ctx.fillText(r.code, x0 + 37, y + rh / 2);
        // after the name, one after another: tyre, chequered flag (finished), penalty
        let nx = x0 + (compact ? 66 : 77);
        if (r.tyre) {
          const tr = Math.max(4, rh * (compact ? 0.28 : 0.32));
          drawTyreIcon(ctx, nx + tr, y + rh / 2, tr, r.tyre, r.me);
          nx += 2 * tr + (compact ? 4 : 5);
        }
        if (r.done) {
          const s = Math.max(2, Math.floor((rh - 8) / 3)), fy = Math.round(y + rh / 2 - 1.5 * s);
          ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(nx - 1, fy - 1, 3 * s + 2, 3 * s + 2);
          for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) { ctx.fillStyle = (a + b) % 2 ? '#111' : '#fff'; ctx.fillRect(nx + a * s, fy + b * s, s, s); }
          nx += 3 * s + (compact ? 4 : 5);
        }
        if (r.pen) {
          const pw2 = Math.round(rh * (compact ? 1.3 : 1.45));
          ctx.fillStyle = '#e10600'; roundRect(ctx, nx, y + 3, pw2, rh - 7, 3); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.font = '800 ' + Math.round(rh * 0.5) + 'px ' + FONT; ctx.textAlign = 'center';
          ctx.fillText('+' + r.pen + 's', nx + pw2 / 2, y + rh / 2);
          nx += pw2 + 4;
        }
        r.infoX = nx;                                // (the time / gap on the right must start after this)
        ctx.textAlign = 'right';
        ctx.font = '600 ' + Math.round(rh * 0.56) + 'px ' + FONT;
        ctx.fillStyle = r.me ? '#111' : r.tag === 'pit' ? '#6ea2ff' : r.tag === 'gar' ? '#8f96a0' : (r.purple ? '#c77dff' : (r.out ? '#777' : '#d7dbe0'));
        if (r.tag) ctx.font = '800 ' + Math.round(rh * 0.5) + 'px ' + FONT;
        const room = x0 + tw - 8 - r.infoX, iw = ctx.measureText(r.info || '').width;
        if (iw > room && room > 10) { ctx.save(); ctx.translate(x0 + tw - 8, y + rh / 2); ctx.scale(room / iw, 1); ctx.fillText(r.info || '', 0, 0); ctx.restore(); }
        else ctx.fillText(r.info || '', x0 + tw - 8, y + rh / 2);
        y += rh;
        if (cut && i === 0) {
          // some cars are left out between the leader and the ones around you
          ctx.fillStyle = 'rgba(10,10,14,0.82)'; ctx.fillRect(x0, y, tw, 6);
          ctx.fillStyle = '#8f96a0';
          for (let d = 0; d < 3; d++) ctx.fillRect(x0 + 11 + d * 5, y + 2, 2, 2);
          y += 7;
        }
      }
      this.towerBox = [x0, y0, tw, y - y0];          // where the tower ended up (for the layout checks)
    } else this.towerBox = null;

    // ---- minimap (top-right)
    if (frame && frame.track) {
      const G = this.prep(frame.track), mm = G.mini;
      const ms = TL ? TL.mini : compact ? 130 : mm.size;
      const mx = W - ms - 12, my = 12;
      ctx.fillStyle = 'rgba(10,10,14,0.55)';
      roundRect(ctx, mx, my, ms, ms, 8); ctx.fill();
      ctx.drawImage(mm.canvas, mx, my, ms, ms);
      const k = ms / mm.size, T = frame.track;
      // where a car goes on the map: cars in the pit lane (and in the garages) are drawn on the pit lane line
      const q = this.miniQ || (this.miniQ = {}), pt = this.miniPt || (this.miniPt = [0, 0]);
      const miniXY = function (c) {
        let x = c.x, y = c.y;
        if (mm.pit) {
          const h = mm.hints[c.id] || (mm.hints[c.id] = { idx: -1, x: 0, y: 0 });
          const near = h.idx >= 0 && Math.abs(h.x - x) + Math.abs(h.y - y) < 40;   // (else it jumped: search the whole track)
          const r = F1.queryTrack(T, x, y, near ? h.idx : null, q);
          h.idx = r.idx; h.x = x; h.y = y;
          if (r.d * mm.pit.side > 0) {
            const a = Math.abs(r.d), m = mm.pit.mapOff(r.idx, a);
            if (m !== a) { const p = F1.trackPoint(T, r.s, mm.pit.side * m); x = p.x; y = p.y; }
          }
        }
        pt[0] = mx + (x * mm.sc + mm.ox) * k; pt[1] = my + (y * mm.sc + mm.oy) * k;
        return pt;
      };
      const dotR = phone ? 2.2 : compact ? 2.5 : 3;
      let meCar = null;
      // cars in the garages: fainter, smaller dots on the pit lane
      const gar = frame.garage || [];
      ctx.globalAlpha = 0.55;
      for (let i = 0; i < gar.length; i++) {
        const c = gar[i];
        if (c.me) { meCar = c; continue; }
        const p = miniXY(c);
        ctx.beginPath(); ctx.arc(p[0], p[1], dotR * 0.8, 0, TAU);
        ctx.fillStyle = F1.teamUiColor(c.team); ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // everyone else: small team-coloured dots
      const cars = frame.cars;
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        if (c.replay) continue;
        if (c.me) { meCar = c; continue; }
        const p = miniXY(c);
        ctx.beginPath(); ctx.arc(p[0], p[1], dotR, 0, TAU);
        ctx.fillStyle = F1.teamUiColor(c.team); ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.stroke();
      }
      // you: an arrow pointing the way you are driving, on top of everything
      if (meCar) {
        const mp = miniXY(meCar), px = mp[0], py = mp[1], as = phone ? 0.75 : compact ? 0.85 : 1;
        ctx.save();
        ctx.translate(px, py); ctx.rotate(meCar.a); ctx.scale(as, as);
        ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-6, -6.5); ctx.lineTo(-2.5, 0); ctx.lineTo(-6, 6.5); ctx.closePath();
        ctx.lineJoin = 'round';
        ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.stroke();
        ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; ctx.stroke();
        ctx.fillStyle = F1.teamUiColor(meCar.team); ctx.fill();
        ctx.restore();
      }
      let fy = my + ms + (phone ? 6 : 8);
      // with the on-screen controls, the boxes under the minimap also run under the two buttons beside it
      const ux = TL ? TL.pause.x : mx, uw = W - 12 - ux;
      if (hud.timeLeft) {
        const th = phone ? 20 : 26;
        ctx.fillStyle = 'rgba(10,10,14,0.86)';
        roundRect(ctx, ux, fy, uw, th, 5); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = '700 ' + (phone ? 12 : 13) + 'px ' + FONT; ctx.textAlign = 'center';
        ctx.fillText(hud.timeLeft, ux + uw / 2, fy + th / 2);
        fy += th + (phone ? 4 : 8);
      }
      // online: connection indicator (green good / amber / red, and whether it is the server, you or a friend)
      if (hud.conn) {
        const c = hud.conn, col = c.lvl >= 2 ? '#ff5a4f' : c.lvl === 1 ? '#ffd600' : '#19c94a';
        const ch = phone ? 20 : 24;
        ctx.fillStyle = 'rgba(10,10,14,0.86)';
        roundRect(ctx, ux, fy, uw, ch, 5); ctx.fill();
        if (c.lvl) { ctx.fillStyle = col; ctx.fillRect(ux, fy, 3, ch); }
        ctx.beginPath(); ctx.arc(ux + 14, fy + ch / 2, 4.5, 0, TAU); ctx.fillStyle = col; ctx.fill();
        ctx.font = '800 ' + (compact ? 10 : 11) + 'px ' + FONT; ctx.textAlign = 'left';
        ctx.fillStyle = c.lvl ? col : '#cfd3d8';
        ctx.fillText(c.text, ux + 25, fy + ch / 2 + 0.5);
        fy += ch + 8;
      }
      // the weather: a cloud (with rain falling from it when it rains) and what the track is like
      if (hud.weather) {
        const wh = phone ? 20 : 24, wxs = hud.weather;
        ctx.fillStyle = 'rgba(10,10,14,0.86)';
        roundRect(ctx, ux, fy, uw, wh, 5); ctx.fill();
        ctx.fillStyle = '#4fa8e8'; ctx.fillRect(ux, fy, 3, wh);
        const cx = ux + 15, cy = fy + wh / 2 - 2;
        ctx.fillStyle = '#c9d3df';
        ctx.beginPath(); ctx.arc(cx - 4, cy + 1, 3.4, 0, TAU); ctx.arc(cx + 0.5, cy - 1.6, 4.4, 0, TAU); ctx.arc(cx + 5, cy + 1, 3.2, 0, TAU); ctx.fill();
        ctx.fillRect(cx - 4, cy + 1, 9, 3.4);
        if (wxs.rain > 0.06) {
          ctx.strokeStyle = '#6ec1ff'; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
          ctx.beginPath();
          for (let d = 0; d < (wxs.rain > 0.55 ? 3 : 2); d++) { const x = cx - 3 + d * 3.6; ctx.moveTo(x, cy + 6.5); ctx.lineTo(x - 1.2, cy + 9.5); }
          ctx.stroke(); ctx.lineCap = 'butt';
        }
        ctx.font = '800 ' + (compact ? 10 : 11) + 'px ' + FONT; ctx.textAlign = 'left'; ctx.fillStyle = '#cfe6ff';
        const txt = ctx.measureText(wxs.text).width <= uw - 34 ? wxs.text : wxs.short;
        ctx.fillText(txt, ux + 27, fy + wh / 2 + 0.5);
        fy += wh + 8;
      }
    }

    // ---- start lights (top-centre)
    if (hud.lights !== undefined && hud.lights !== null) {
      const n = 5, pw = 34, gap = 10, tw2 = n * pw + (n - 1) * gap + 24;
      const lx = W / 2 - tw2 / 2, ly = 16;
      ctx.fillStyle = 'rgba(8,8,10,0.9)';
      roundRect(ctx, lx, ly, tw2, 84, 10); ctx.fill();
      for (let i = 0; i < n; i++) {
        const cx = lx + 12 + i * (pw + gap) + pw / 2;
        ctx.fillStyle = '#1d1d22'; roundRect(ctx, cx - pw / 2, ly + 8, pw, 68, 6); ctx.fill();
        for (let r = 0; r < 2; r++) {
          const on = i < hud.lights;
          ctx.beginPath(); ctx.arc(cx, ly + 26 + r * 32, 11, 0, TAU);
          ctx.fillStyle = on ? '#ff1a1a' : '#3a0d0d';
          if (on) { ctx.shadowColor = '#ff2a2a'; ctx.shadowBlur = 18; }
          ctx.fill(); ctx.shadowBlur = 0;
        }
      }
      if (hud.lightsNote) {
        ctx.font = '800 13px ' + FONT; ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText(hud.lightsNote, W / 2, ly + 100); ctx.fillText(hud.lightsNote, W / 2, ly + 100);
      }
    }

    // ---- centre messages (with the on-screen controls: kept inside the gap between the timing tower and the buttons
    //      by the minimap; the title shrinks and the second line wraps when they would not fit; smaller on a phone)
    const mcx = W / 2, mfit = !!TL;
    const mroom = mfit ? 2 * Math.min(W / 2 - (12 + (compact ? 150 : 214) + 8), TL.pause.x - 8 - W / 2) : 0;
    let my2 = hud.resume ? 152 : hud.lights !== undefined && hud.lights !== null ? 128 : phone ? 12 : 26;
    if (hud.msgs) {
      // a phone shows the two newest, so the road ahead stays in view
      const list = phone && hud.msgs.length > 2 ? hud.msgs.slice(-2) : hud.msgs;
      for (let i = 0; i < list.length; i++) {
        if (list[i].from === 'eng') { my2 += this.drawRadioStrip(ctx, list[i], mcx, my2, mfit ? mroom : Math.min(W - 40, 760), phone) + (phone ? 5 : 7); continue; }
        const m = list[i], sign = !!m.sign;
        // race control: a small tag sitting on top of the sign
        const tagH = sign && m.from === 'rc' ? (phone ? 15 : 18) : 0;
        my2 += tagH ? tagH - 4 : 0;
        let fT = m.big ? 30 : sign ? 21 : 20, fS = 14, subs = m.sub ? [m.sub] : [];
        const wT = sign ? '900 ' : '800 ', wS = sign ? '700 ' : '600 ';
        if (mfit) {
          if (phone) { fT = m.big ? 22 : 16; fS = 12; }
          const room = mroom - (sign ? (phone ? 80 : 100) : (phone ? 30 : 40));
          ctx.font = wT + fT + 'px ' + FONT;
          while (fT > 11 && ctx.measureText(m.text).width > room) { fT--; ctx.font = wT + fT + 'px ' + FONT; }
          if (m.sub) { ctx.font = wS + fS + 'px ' + FONT; subs = wrapText(ctx, m.sub, room); }
        }
        ctx.font = '600 ' + fS + 'px ' + FONT;
        let subW = 0;
        for (let k = 0; k < subs.length; k++) subW = Math.max(subW, ctx.measureText(subs[k]).width);
        ctx.font = '800 ' + (mfit ? fT : m.big ? 30 : 20) + 'px ' + FONT;
        const w = Math.max(ctx.measureText(m.text).width, subW) + (phone ? 30 : 40);
        const hT = phone ? fT + 14 : m.big ? 46 : 34, hS = phone ? 15 : 20;
        const h = hT + subs.length * hS;
        const ty = my2 + hT / 2 + 1, sy = my2 + hT + hS / 2 - 4;
        ctx.globalAlpha = m.alpha === undefined ? 1 : m.alpha;
        if (sign) {
          // a warning sign: yellow (warning) or red (penalty) with a hazard triangle
          const sw = w + (phone ? 46 : 56), sx = mcx - sw / 2, pen = m.sign === 'pen', off = phone ? 13 : 16;
          ctx.fillStyle = pen ? '#d40a00' : '#ffd400';
          roundRect(ctx, sx, my2, sw, h, 7); ctx.fill();
          ctx.lineWidth = phone ? 2 : 3; ctx.strokeStyle = pen ? '#ffffff' : '#111111';
          roundRect(ctx, sx + 4, my2 + 4, sw - 8, h - 8, 5); ctx.stroke();
          const tx = sx + (phone ? 25 : 30), tcy = my2 + h / 2, ts = Math.min(phone ? 13 : 17, h / 2 - 6);
          ctx.beginPath(); ctx.moveTo(tx, tcy - ts); ctx.lineTo(tx + ts * 1.1, tcy + ts * 0.85); ctx.lineTo(tx - ts * 1.1, tcy + ts * 0.85); ctx.closePath();
          ctx.fillStyle = pen ? '#ffffff' : '#111111'; ctx.fill();
          ctx.fillStyle = pen ? '#d40a00' : '#ffd400'; ctx.font = '900 ' + Math.round(ts * 1.15) + 'px ' + FONT; ctx.textAlign = 'center';
          ctx.fillText('!', tx, tcy + ts * 0.25);
          ctx.fillStyle = pen ? '#ffffff' : '#111111';
          ctx.font = wT + fT + 'px ' + FONT;
          ctx.fillText(m.text, mcx + off, ty);
          ctx.font = wS + fS + 'px ' + FONT;
          for (let k = 0; k < subs.length; k++) ctx.fillText(subs[k], mcx + off, sy + k * hS);
          if (tagH) {
            ctx.font = '900 ' + (phone ? 9 : 11) + 'px ' + FONT;
            const tw = ctx.measureText('RACE CONTROL').width + (phone ? 14 : 18), tx0 = sx + (phone ? 10 : 14), ty0 = my2 - tagH + 4;
            ctx.fillStyle = pen ? '#ffffff' : '#111111';
            roundRect(ctx, tx0, ty0, tw, tagH, 4); ctx.fill();
            ctx.fillStyle = pen ? '#d40a00' : '#ffd400'; ctx.textAlign = 'center';
            ctx.fillText('RACE CONTROL', tx0 + tw / 2, ty0 + tagH / 2 + 1);
          }
        } else {
          ctx.fillStyle = 'rgba(10,10,14,0.88)';
          roundRect(ctx, mcx - w / 2, my2, w, h, 6); ctx.fill();
          ctx.fillStyle = m.color || '#e10600'; ctx.fillRect(mcx - w / 2, my2, 4, h);
          ctx.textAlign = 'center';
          ctx.fillStyle = '#fff';
          ctx.fillText(m.text, mcx, ty);
          ctx.font = wS + fS + 'px ' + FONT; ctx.fillStyle = m.subColor || '#cfd3d8';
          for (let k = 0; k < subs.length; k++) ctx.fillText(subs[k], mcx, sy + k * hS);
        }
        ctx.globalAlpha = 1;
        my2 += h + (phone ? 6 : 8);
      }
    }
    if (hud.wrongWay) {
      ctx.font = '900 34px ' + FONT; ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(225,6,0,0.92)';
      roundRect(ctx, W / 2 - 150, H * 0.42 - 30, 300, 60, 8); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText('WRONG WAY', W / 2, H * 0.42);
    }
    if (hud.centre) {
      ctx.font = '900 ' + (hud.centre.size || 64) + 'px ' + FONT; ctx.textAlign = 'center';
      ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.strokeText(hud.centre.text, W / 2, H * 0.36);
      ctx.fillStyle = hud.centre.color || '#fff'; ctx.fillText(hud.centre.text, W / 2, H * 0.36);
    }
    // resuming after a pause: 3, 2, 1 with the game still frozen (at the top, so the road ahead stays in view)
    if (hud.resume) {
      const bw2 = 150, bh2 = 126, bx2 = W / 2 - bw2 / 2, by2 = 16;
      ctx.fillStyle = 'rgba(10,10,14,0.86)';
      roundRect(ctx, bx2, by2, bw2, bh2, 14); ctx.fill();
      ctx.fillStyle = '#e10600'; ctx.fillRect(bx2 + 16, by2 + bh2 - 28, bw2 - 32, 3);
      ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.font = '900 80px ' + FONT;
      ctx.fillText(String(hud.resume), W / 2, by2 + 54);
      ctx.font = '800 13px ' + FONT; ctx.fillStyle = '#cfd3d8';
      ctx.fillText('GET READY', W / 2, by2 + bh2 - 12);
    }

    // ---- bottom dashboard
    const dstyle = TL ? TL.dash : compact ? 'compact' : 'full', dc = dstyle === 'compact';
    if (hud.speed !== undefined && dstyle === 'slim') this.drawSlimDash(hud, TL);
    else if (hud.speed !== undefined) {
      const bw = dc ? Math.min(W - 24, 400) : 560, bh = dc ? 84 : 96;
      const dcx = TL ? TL.dashCx : W / 2;          // with the on-screen controls: in the space between the thumbs
      const bx = dcx - bw / 2, by = H - bh - 14;
      // gap to the ghost, just above the dashboard
      if (hud.delta) {
        ctx.font = '900 26px ' + FONT;
        const dw = ctx.measureText(hud.delta.text).width + 92;
        ctx.fillStyle = 'rgba(10,10,14,0.88)';
        roundRect(ctx, dcx - dw / 2, by - 50, dw, 40, 8); ctx.fill();
        ctx.fillStyle = hud.delta.color; ctx.fillRect(dcx - dw / 2, by - 50, 4, 40);
        ctx.textAlign = 'left'; ctx.font = '800 11px ' + FONT; ctx.fillStyle = '#9aa1a8';
        ctx.fillText('GHOST', dcx - dw / 2 + 14, by - 30);
        ctx.textAlign = 'right'; ctx.font = '900 26px ' + FONT; ctx.fillStyle = hud.delta.color;
        ctx.fillText(hud.delta.text, dcx + dw / 2 - 14, by - 29);
      }
      if (hud.tow) this.drawTow(bx + bw, by - 8, dc ? 1 : 1.12);
      if (hud.tyre) this.drawTyrePill(bx, by - 8, dc ? 1 : 1.12, hud.tyre, !dc);
      ctx.fillStyle = 'rgba(10,10,14,0.88)';
      roundRect(ctx, bx, by, bw, bh, 10); ctx.fill();
      // gear + speed
      ctx.font = '800 30px ' + FONT; ctx.fillStyle = '#ffd600'; ctx.textAlign = 'center';
      ctx.fillText(String(hud.gear), bx + 28, by + 34);
      if (!dc) { ctx.font = '700 10px ' + FONT; ctx.fillStyle = '#9aa1a8'; ctx.fillText('GEAR', bx + 28, by + 55); }   // (no room for the word on the small dashboard)
      ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.font = '800 42px ' + FONT;
      ctx.fillText(String(hud.speed), bx + 146, by + 36);
      ctx.font = '700 11px ' + FONT; ctx.fillStyle = '#9aa1a8'; ctx.textAlign = 'left';
      ctx.fillText(hud.unit || 'KM/H', bx + 150, by + 46);
      // DRS indicator
      const dx = bx + 14, dy = by + bh - 28, dw = 172;
      const st = hud.drs;
      if (hud.pit) {
        ctx.fillStyle = Math.floor(performance.now() / 400) % 2 ? '#1f6bff' : '#1752c4';
        roundRect(ctx, dx, dy, dw, 18, 4); ctx.fill();
        ctx.font = '800 11px ' + FONT; ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
        ctx.fillText(hud.unit === 'MPH' ? 'PIT LIMITER  50 MPH' : 'PIT LIMITER  80 KM/H', dx + dw / 2, dy + 9.5);
      } else {
        ctx.fillStyle = st === 'open' ? '#19c94a' : 'rgba(40,40,48,0.95)';
        roundRect(ctx, dx, dy, dw, 18, 4); ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = st === 'open' ? '#19c94a' : st === 'avail' ? (Math.floor(performance.now() / 250) % 2 ? '#7dff9b' : '#19c94a') : '#3b3b45';
        ctx.stroke();
        ctx.font = '800 11px ' + FONT; ctx.textAlign = 'center';
        ctx.fillStyle = st === 'open' ? '#04210c' : st === 'avail' ? '#7dff9b' : '#7b7f88';
        let dtxt = st === 'open' ? 'DRS OPEN' : st === 'avail' ? (hud.drsHint || 'DRS AVAILABLE') : 'DRS';
        if (ctx.measureText(dtxt).width > dw - 10) dtxt = 'DRS AVAILABLE';
        ctx.fillText(dtxt, dx + dw / 2, dy + 9.5);
      }
      // position + lap
      const cx2 = bx + 206;
      ctx.textAlign = 'left'; ctx.fillStyle = '#fff'; ctx.font = '800 26px ' + FONT;
      ctx.fillText(hud.posText || '', cx2, by + 28);
      // live gaps (races): the car ahead above, the car behind below, right of your position
      if (hud.gaps) {
        const posW = ctx.measureText(hud.posText || '').width;
        const gr = dc ? bx + bw - 14 : bx + 366, room = gr - (cx2 + posW + 10);
        const lines = [hud.gaps.a, hud.gaps.b].filter(function (g) { return !!g; });
        for (let i = 0; i < lines.length; i++) {
          let f = dc ? 12 : 13;
          ctx.font = '800 ' + f + 'px ' + FONT;
          while (f > 9 && ctx.measureText(lines[i].text).width > room) { f--; ctx.font = '800 ' + f + 'px ' + FONT; }
          ctx.textAlign = 'right'; ctx.fillStyle = lines[i].color;
          ctx.fillText(lines[i].text, gr, by + (dc ? 25 : 20) + i * (dc ? 15 : 17) + (lines.length === 1 ? (dc ? 7 : 8) : 0));
        }
        ctx.textAlign = 'left';
      }
      ctx.font = '700 13px ' + FONT; ctx.fillStyle = '#cfd3d8';
      ctx.fillText(hud.lapText || '', cx2, by + (dc ? 54 : 50));
      // sector blocks: S1 S2 S3 light up as you finish each sector (purple / green / yellow)
      if (hud.sectors) {
        const SC = { purple: '#a23cff', green: '#19c94a', yellow: '#ffd600' };
        const sw = dc ? 40 : 50, sg = 5, sh = dc ? 5 : 16;
        const sx0 = dc ? bx + bw - 14 - 3 * sw - 2 * sg : cx2, sy0 = dc ? by + 8 : by + 66;
        for (let i = 0; i < 3; i++) {
          const col = hud.sectors[i], x = sx0 + i * (sw + sg);
          ctx.fillStyle = col ? SC[col] : 'rgba(255,255,255,0.09)';
          roundRect(ctx, x, sy0, sw, sh, dc ? 2 : 4); ctx.fill();
          if (!dc) {
            ctx.font = '800 10px ' + FONT; ctx.textAlign = 'center';
            ctx.fillStyle = col ? (col === 'purple' ? '#fff' : '#111') : '#7b7f88';
            ctx.fillText('S' + (i + 1), x + sw / 2, sy0 + sh / 2 + 0.5);
          }
        }
        ctx.textAlign = 'left';
      }
      if (dc) {
        ctx.font = '700 13px ' + FONT; ctx.fillStyle = '#fff';
        ctx.fillText((hud.cur || '--:--.---') + (hud.best ? '   BEST ' + hud.best : hud.pb ? '   PB ' + hud.pb : ''), cx2, by + 74);
      } else {
        const lx = bx + 384, rx = bx + bw - 16;
        const lines = [['CURRENT', hud.cur], ['LAST', hud.last], ['BEST', hud.best], ['PB', hud.pb]];
        for (let i = 0; i < lines.length; i++) {
          const yy = by + 17 + i * 21;
          ctx.font = '700 11px ' + FONT; ctx.fillStyle = i === 3 ? '#19c94a' : '#8f96a0'; ctx.textAlign = 'left';
          ctx.fillText(lines[i][0], lx, yy);
          ctx.font = '700 15px ' + FONT; ctx.textAlign = 'right';
          ctx.fillStyle = i === 2 && hud.bestPurple ? '#c77dff' : i === 3 ? '#9ff0b4' : '#fff';
          ctx.fillText(lines[i][1] || '--:--.---', rx, yy);
        }
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(bx + 194, by + 12, 1, bh - 24);
        ctx.fillRect(bx + 372, by + 12, 1, bh - 24);
      }
    }

    // ---- hints / ping
    ctx.textAlign = 'left'; ctx.font = '600 12px ' + FONT;
    if (hud.hint) {
      const lines = hud.hint;
      const hh = lines.length * 17 + 14, hw2 = compact ? 230 : 290;
      ctx.fillStyle = 'rgba(10,10,14,0.75)';
      roundRect(ctx, 12, H - hh - 14, hw2, hh, 6); ctx.fill();
      ctx.fillStyle = '#e9edf1';
      for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], 22, H - hh - 14 + 16 + i * 17);
    }
  };

  /* Your tyres: a small sign on top of the dashboard's left-hand end (l = left edge, b = bottom): the compound and,
     with tyre wear on, how much is left (green, then yellow, red when they are nearly gone). */
  Renderer.prototype.drawTyrePill = function (l, b, k, t, named) {
    const ctx = this.ctx, h = Math.round(22 * k), f = Math.round(11 * k), ty = F1.TYRES[t.c];
    if (!ty) return;
    ctx.font = '800 ' + f + 'px ' + FONT;
    const name = named ? ty.name.toUpperCase() : '';
    const left = t.w === null ? null : Math.max(0, Math.round((1 - t.w) * 100));
    const nameW = name ? ctx.measureText(name).width + 8 * k : 0, barW = left === null ? 0 : 34 * k, pctW = left === null ? 0 : ctx.measureText('100%').width + 6 * k;
    const w = 26 * k + nameW + (left === null ? 2 * k : barW + 6 * k + pctW), x = l, y = b - h;
    ctx.fillStyle = 'rgba(10,10,14,0.88)';
    roundRect(ctx, x, y, w, h, 6 * k); ctx.fill();
    drawTyreIcon(ctx, x + 12 * k, y + h / 2, 7.2 * k, t.c, false);
    let cx = x + 23 * k;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    if (name) { ctx.fillStyle = '#e9edf1'; ctx.fillText(name, cx, y + h / 2 + 0.5); cx += nameW; }
    if (left !== null) {
      const col = left > 40 ? '#19c94a' : left > 15 ? '#ffd600' : '#ff3b30';
      ctx.fillStyle = 'rgba(255,255,255,0.12)'; roundRect(ctx, cx, y + h / 2 - 2.5 * k, barW, 5 * k, 2.5 * k); ctx.fill();
      ctx.fillStyle = col; roundRect(ctx, cx, y + h / 2 - 2.5 * k, Math.max(2, barW * left / 100), 5 * k, 2.5 * k); ctx.fill();
      ctx.fillStyle = col; ctx.fillText(left + '%', cx + barW + 5 * k, y + h / 2 + 0.5);
    }
  };

  /* "SLIPSTREAM": a small sign sitting on top of the dashboard's right-hand end (r = right edge, b = bottom). */
  Renderer.prototype.drawTow = function (r, b, k) {
    const ctx = this.ctx, h = Math.round(22 * k), f = Math.round(11 * k);
    ctx.font = '800 ' + f + 'px ' + FONT;
    const tw = ctx.measureText('SLIPSTREAM').width, w = tw + 34 * k, x = r - w, y = b - h;
    ctx.fillStyle = 'rgba(10,10,14,0.88)';
    roundRect(ctx, x, y, w, h, 6 * k); ctx.fill();
    ctx.strokeStyle = '#4fc3ff'; ctx.lineWidth = 1.5; ctx.stroke();
    // three lines of moving air
    const t = (performance.now() / 300) % 1;
    ctx.strokeStyle = '#4fc3ff'; ctx.lineWidth = 1.6 * k; ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const yy = y + h / 2 + (i - 1) * 4.5 * k, o = ((t + i * 0.33) % 1) * 3 * k;
      ctx.beginPath(); ctx.moveTo(x + 7 * k + o, yy); ctx.lineTo(x + (i === 1 ? 17 : 14) * k + o, yy); ctx.stroke();
    }
    ctx.lineCap = 'butt';
    ctx.fillStyle = '#bfe9ff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('SLIPSTREAM', x + 25 * k, y + h / 2 + 0.5);
  };

  /* Phones: a slim dashboard that fits between the two thumbs. (DRS is shown on its own button.) */
  Renderer.prototype.drawSlimDash = function (hud, TL) {
    const ctx = this.ctx, W = this.w, H = this.h;
    const bw = TL.dashW, bh = 56, bx = TL.dashX, by = H - bh - 8;
    // gap to the ghost, just above
    if (hud.delta) {
      ctx.font = '900 18px ' + FONT;
      const dw = ctx.measureText(hud.delta.text).width + 70, dx = TL.dashCx - dw / 2, dy = by - 32;
      ctx.fillStyle = 'rgba(10,10,14,0.88)';
      roundRect(ctx, dx, dy, dw, 27, 6); ctx.fill();
      ctx.fillStyle = hud.delta.color; ctx.fillRect(dx, dy, 4, 27);
      ctx.textAlign = 'left'; ctx.font = '800 10px ' + FONT; ctx.fillStyle = '#9aa1a8';
      ctx.fillText('GHOST', dx + 11, dy + 14);
      ctx.textAlign = 'right'; ctx.font = '900 18px ' + FONT; ctx.fillStyle = hud.delta.color;
      ctx.fillText(hud.delta.text, dx + dw - 10, dy + 14.5);
    }
    if (hud.tow) this.drawTow(bx + bw, by - 6, 0.86);
    if (hud.tyre) this.drawTyrePill(bx, by - 6, 0.86, hud.tyre, false);
    ctx.fillStyle = 'rgba(10,10,14,0.88)';
    roundRect(ctx, bx, by, bw, bh, 10); ctx.fill();
    // the three sectors: thin bars along the top edge
    if (hud.sectors) {
      const SC = { purple: '#a23cff', green: '#19c94a', yellow: '#ffd600' }, sw = (bw - 24 - 8) / 3;
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = hud.sectors[i] ? SC[hud.sectors[i]] : 'rgba(255,255,255,0.1)';
        roundRect(ctx, bx + 12 + i * (sw + 4), by + 5, sw, 4, 2); ctx.fill();
      }
    }
    // gear, speed
    ctx.textAlign = 'center'; ctx.font = '800 24px ' + FONT; ctx.fillStyle = '#ffd600';
    ctx.fillText(String(hud.gear), bx + 22, by + 28);
    ctx.textAlign = 'right'; ctx.font = '800 30px ' + FONT; ctx.fillStyle = '#fff';
    ctx.fillText(String(hud.speed), bx + 96, by + 28);
    ctx.textAlign = 'left';
    if (hud.pit) {
      ctx.font = '800 10px ' + FONT; ctx.fillStyle = Math.floor(performance.now() / 400) % 2 ? '#6ea2ff' : '#2f7bff';
      ctx.fillText('PIT', bx + 100, by + 22);
      ctx.fillText('LIMIT', bx + 100, by + 34);
    } else {
      ctx.font = '700 9px ' + FONT; ctx.fillStyle = '#9aa1a8';
      ctx.fillText(hud.unit || 'KM/H', bx + 100, by + 34);
    }
    // position
    ctx.textAlign = 'right'; ctx.font = '800 21px ' + FONT; ctx.fillStyle = '#fff';
    ctx.fillText(hud.posText || '', bx + bw - 12, by + 27);
    // bottom line: lap, (best lap when there is room), current lap time
    ctx.font = '700 11px ' + FONT; ctx.textAlign = 'left'; ctx.fillStyle = '#cfd3d8';
    ctx.fillText(hud.lapText || '', bx + 12, by + 46);
    const lapW = ctx.measureText(hud.lapText || '').width;
    ctx.textAlign = 'right'; ctx.font = '700 12px ' + FONT; ctx.fillStyle = '#fff';
    const cur = hud.cur || '--:--.---';
    ctx.fillText(cur, bx + bw - 12, by + 46);
    const best = hud.best ? 'BEST ' + hud.best : hud.pb ? 'PB ' + hud.pb : '';
    if (hud.gaps && (hud.gaps.a || hud.gaps.b)) {
      // races: the live gaps in the middle of the bottom line (ahead · behind)
      const l = bx + 12 + lapW + 10, r = bx + bw - 12 - ctx.measureText(cur).width - 10;
      const parts = [hud.gaps.a, hud.gaps.b].filter(function (g) { return !!g; });
      let f = 11;
      const width = function () { ctx.font = '800 ' + f + 'px ' + FONT; let w = 0; for (let i = 0; i < parts.length; i++) w += ctx.measureText(parts[i].text).width; return w + (parts.length > 1 ? ctx.measureText('  ·  ').width : 0); };
      while (f > 8 && width() > r - l) f--;
      let x = (l + r) / 2 - width() / 2;
      ctx.textAlign = 'left';
      for (let i = 0; i < parts.length; i++) {
        if (i) { ctx.fillStyle = '#6b7079'; ctx.fillText('  ·  ', x, by + 46); x += ctx.measureText('  ·  ').width; }
        ctx.fillStyle = parts[i].color; ctx.fillText(parts[i].text, x, by + 46); x += ctx.measureText(parts[i].text).width;
      }
    } else if (best) {
      ctx.font = '700 11px ' + FONT;
      const l = bx + 12 + lapW + 12, r = bx + bw - 12 - 62 - 12;
      if (r - l >= ctx.measureText(best).width) {
        ctx.textAlign = 'center'; ctx.fillStyle = hud.best && hud.bestPurple ? '#c77dff' : hud.best ? '#cfd3d8' : '#9ff0b4';
        ctx.fillText(best, (l + r) / 2, by + 46);
      }
    }
  };

  /* A tyre: a ring in the compound's colour (soft red, medium yellow, hard white, intermediate green, wet blue) with
     its letter in the middle when there is room. onLight: drawn on a light background (your row in the tower). */
  function drawTyreIcon(ctx, x, y, r, k, onLight) {
    const ty = F1.TYRES[k];
    if (!ty) return;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#16161c'; ctx.fill();
    ctx.lineWidth = Math.max(1.5, r * 0.32); ctx.strokeStyle = ty.col; ctx.stroke();
    if (onLight) { ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.beginPath(); ctx.arc(x, y, r + ctx.lineWidth, 0, Math.PI * 2); ctx.stroke(); }
    if (r >= 5.5) {
      ctx.font = '900 ' + Math.round(r * 1.05) + 'px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = ty.col; ctx.fillText(k, x, y + 0.5);
    }
  }

  /* Break a line of text into lines no wider than maxW (the context's current font), of about the same length
     (so the last line is not one lonely word). */
  function wrapText(ctx, text, maxW) {
    const words = String(text).split(' ');
    const wrap = function (w) {
      const lines = [];
      let cur = '';
      for (let i = 0; i < words.length; i++) {
        const t = cur ? cur + ' ' + words[i] : words[i];
        if (cur && ctx.measureText(t).width > w) { lines.push(cur); cur = words[i]; } else cur = t;
      }
      if (cur) lines.push(cur);
      return lines;
    };
    let best = wrap(maxW);
    if (best.length > 1) {
      for (let w = maxW * 0.94; w > maxW * 0.45; w -= maxW * 0.06) {
        const l = wrap(w);
        if (l.length > best.length) break;
        best = l;
      }
    }
    return best;
  }

  /* Small car preview for menus. */
  Renderer.carPreview = function (canvas, team) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 96, h = canvas.clientHeight || 34;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const sc = Math.min(w / 5.8, h / 2.2);
    ctx.translate(w / 2, h / 2);
    ctx.scale(sc, sc);
    drawCarLocal(ctx, team, 0, false);
  };

  Renderer.trackPreview = function (canvas, T) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 160, h = canvas.clientHeight || 110;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const b = T.bounds, bw = b.maxX - b.minX, bh = b.maxY - b.minY;
    const sc = Math.min((w - 16) / bw, (h - 16) / bh);
    const ox = (w - bw * sc) / 2 - b.minX * sc, oy = (h - bh * sc) / 2 - b.minY * sc;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i <= T.n; i += 4) { const k = i % T.n; const x = T.x[k] * sc + ox, y = T.y[k] * sc + oy; if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 6; ctx.stroke();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke();
    const s = F1.trackPoint(T, 0, 0);
    ctx.fillStyle = '#e10600'; ctx.beginPath(); ctx.arc(s.x * sc + ox, s.y * sc + oy, 3.5, 0, TAU); ctx.fill();
  };

  Renderer.lerpAngle = lerpAngle;
  window.Renderer = Renderer;
})();
