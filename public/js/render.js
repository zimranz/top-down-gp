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
    city: '#25272c', runoffSt: '#5d6168', bld: ['#3a3d44', '#444851', '#4f535c'], roof: 'rgba(255,255,255,0.07)'
  };

  function lerpAngle(a, b, t) { return a + F1.wrapAngle(b - a) * t; }

  function Renderer(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.tracks = {};
    this.cam = { x: 0, y: 0, a: -Math.PI / 2, z: 8, ready: false, lx: 0, ly: 0 };
    this.skids = [];
    this.parts = [];
    this.wheelPrev = {};
    this.lastFrame = performance.now();
    this.resize();
    const self = this;
    window.addEventListener('resize', function () { self.resize(); });
  }

  Renderer.prototype.resize = function () {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.cv.width = Math.round(this.w * this.dpr);
    this.cv.height = Math.round(this.h * this.dpr);
    this.cv.style.width = this.w + 'px';
    this.cv.style.height = this.h + 'px';
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
    const CH = 40;
    function off(i, d) { return [X[i] + NX[i] * d, Y[i] + NY[i] * d]; }
    for (let c0 = 0; c0 < N; c0 += CH) {
      const c1 = Math.min(N, c0 + CH);
      const ch = { center: new Path2D(), runoff: [], edges: new Path2D(), kerbR: new Path2D(), kerbW: new Path2D(), kerbAll: new Path2D(), gravel: new Path2D(), cx: 0, cy: 0, r: 0 };
      let sx = 0, sy = 0;
      for (let k = c0; k <= c1; k++) {
        const i = k % N;
        if (k === c0) ch.center.moveTo(X[i], Y[i]); else ch.center.lineTo(X[i], Y[i]);
        sx += X[i]; sy += Y[i];
      }
      ch.cx = sx / (c1 - c0 + 1); ch.cy = sy / (c1 - c0 + 1);
      for (let k = c0; k <= c1; k++) { const i = k % N; ch.r = Math.max(ch.r, Math.hypot(X[i] - ch.cx, Y[i] - ch.cy)); }
      ch.r += T.maxWall + 6;
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
      // white edge lines
      for (const side of [-1, 1]) {
        for (let k = c0; k <= c1; k++) {
          const i = k % N, p = off(i, side * (hw - 0.45));
          if (k === c0) ch.edges.moveTo(p[0], p[1]); else ch.edges.lineTo(p[0], p[1]);
        }
      }
      // kerbs + gravel quads
      for (let k = c0; k < c1; k++) {
        const i = k % N, j = (k + 1) % N;
        if (T.kerb[i] && T.kerb[j]) {
          // the whole kerb is filled white, then the red blocks go on top: no seams between blocks
          const path = k % 2 === 0 ? ch.kerbR : ch.kerbW;
          for (const side of [-1, 1]) {
            const a = off(i, side * (hw - 0.2)), b = off(j, side * (hw - 0.2)), c = off(j, side * (hw + T.kerbW)), d = off(i, side * (hw + T.kerbW));
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
      G.chunks.push(ch);
    }

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
          G.blocks.get(key).push({ pts: pts, shade: Math.floor(rand() * 3) });
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
    tracePath(); mc.strokeStyle = '#e9edf1'; mc.lineWidth = 3; mc.stroke();
    const s0 = F1.trackPoint(T, 0, 0);
    mc.fillStyle = '#e10600'; mc.beginPath(); mc.arc(s0.x * sc + ox, s0.y * sc + oy, 3.5, 0, TAU); mc.fill();
    G.mini = { canvas: mm, size: MS, sc: sc, ox: ox, oy: oy };

    // grass stripes pattern (in world metres)
    const pc = document.createElement('canvas');
    pc.width = 24; pc.height = 24;
    const pcx = pc.getContext('2d');
    pcx.fillStyle = COL.grassA; pcx.fillRect(0, 0, 24, 24);
    pcx.fillStyle = COL.grassB; pcx.fillRect(0, 0, 12, 24);
    G.grassPattern = this.ctx.createPattern(pc, 'repeat');
    const gc = document.createElement('canvas');
    gc.width = 16; gc.height = 16;
    const gcx = gc.getContext('2d');
    gcx.fillStyle = COL.gravel; gcx.fillRect(0, 0, 16, 16);
    for (let i = 0; i < 26; i++) { gcx.fillStyle = i % 2 ? COL.gravelDot : '#ddcca3'; gcx.fillRect(Math.floor(rand() * 16), Math.floor(rand() * 16), 1, 1); }
    G.gravelPattern = this.ctx.createPattern(gc, 'repeat');
    if (G.gravelPattern && G.gravelPattern.setTransform && window.DOMMatrix) G.gravelPattern.setTransform(new DOMMatrix().scale(0.25));

    this.tracks[T.id] = G;
    return G;
  };

  // ------------------------------------------------------------- camera
  /* The car always stays in the upper-middle of the screen, clear of the dashboard at the bottom. */
  /* Camera distance: close / normal / far (zoom multiplier). */
  const ZOOM = { close: 1.45, normal: 1, far: 0.62 };

  Renderer.prototype.updateCamera = function (focus, dt, rotate, distance) {
    const cam = this.cam, W = this.w, H = this.h;
    const sp = focus ? Math.hypot(focus.vx || 0, focus.vy || 0) : 0;
    const base = F1.clamp(Math.min(W, H) / 88, 4.2, 13) * (ZOOM[distance] || 1);
    const zT = this.zoomOverride || base * (1 - 0.3 * Math.min(1, sp / 85));
    const dash = 130;                                   // space taken by the dashboard at the bottom
    if (!cam.ready && focus) {
      cam.x = focus.x; cam.y = focus.y; cam.a = focus.a; cam.z = zT; cam.lx = 0; cam.ly = 0; cam.ready = true;
    }
    if (!focus) return;
    cam.z += (zT - cam.z) * Math.min(1, dt * 2.4);
    cam.a += F1.wrapAngle(focus.a - cam.a) * Math.min(1, dt * 7);
    cam.rotate = rotate;
    cam.ax = W / 2;
    if (rotate) {
      cam.ay = F1.clamp(H * 0.58, Math.min(150, H * 0.4), H - dash - 100);
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

    // trees
    const tx0 = Math.floor((vc[0] - vr) / 100), tx1 = Math.floor((vc[0] + vr) / 100);
    const ty0 = Math.floor((vc[1] - vr) / 100), ty1 = Math.floor((vc[1] + vr) / 100);
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
    ctx.fillStyle = COL.tree1; ctx.fill(p1);
    ctx.fillStyle = COL.tree2; ctx.fill(p2);
    ctx.fillStyle = COL.treeHi; ctx.fill(ph);
    // city blocks (street circuits)
    if (G.blocks.size) {
      const bp = [new Path2D(), new Path2D(), new Path2D()], roof = new Path2D();
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
        }
      }
      for (let v = 0; v < 3; v++) { ctx.fillStyle = COL.bld[v]; ctx.fill(bp[v]); }
      ctx.fillStyle = COL.roof; ctx.fill(roof);
    }

    // decorations
    G.deco.forEach(function (d) {
      ctx.fillStyle = d.color;
      ctx.beginPath(); ctx.moveTo(d.pts[0].x, d.pts[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(d.pts[i].x, d.pts[i].y); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = d.stripe; ctx.lineWidth = 0.6; ctx.stroke();
    });

    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    // barriers + run-off
    for (const ch of vis) for (const g of ch.runoff) { ctx.strokeStyle = COL.armco; ctx.lineWidth = 2 * g.w + 2.4; ctx.stroke(g.path); }
    for (const ch of vis) for (const g of ch.runoff) { ctx.strokeStyle = COL.barrier; ctx.lineWidth = 2 * g.w + 1.2; ctx.stroke(g.path); }
    ctx.strokeStyle = T.street ? COL.runoffSt : G.grassPattern || COL.grassA;
    for (const ch of vis) for (const g of ch.runoff) { ctx.lineWidth = 2 * g.w; ctx.stroke(g.path); }
    // the visible track sections are merged into one shape per layer and drawn in one go:
    // drawing them section by section leaves hairline seams where the sections meet
    const merge = function (key) { const p = new Path2D(); for (const ch of vis) p.addPath(ch[key]); return p; };
    ctx.fillStyle = G.gravelPattern || COL.gravel;
    ctx.fill(merge('gravel'));
    if (G.pit && Math.hypot(G.pit.cx - vc[0], G.pit.cy - vc[1]) < G.pit.r + vr) {
      ctx.save(); this.drawPit(ctx, G.pit, T, frame); ctx.restore();
    }
    // asphalt
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = COL.asphalt; ctx.lineWidth = 2 * T.hw;
    ctx.stroke(merge('center'));
    ctx.fillStyle = COL.kerbW; ctx.fill(merge('kerbAll'));
    ctx.fillStyle = COL.kerbR; ctx.fill(merge('kerbR'));
    ctx.strokeStyle = COL.line; ctx.lineWidth = 0.28; ctx.lineCap = 'butt';
    ctx.stroke(merge('edges'));
    ctx.fillStyle = '#f5f5f5'; ctx.fill(G.chequerW);
    ctx.fillStyle = '#111'; ctx.fill(G.chequerB);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 0.22; ctx.stroke(G.marks);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 0.5; ctx.stroke(G.drsLines);
    ctx.setLineDash([1.2, 1.2]); ctx.lineWidth = 0.3; ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.stroke(G.drsDet); ctx.setLineDash([]);

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


    // cars
    const cars = frame.cars;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (Math.abs(c.x - vc[0]) > vr + 6 || Math.abs(c.y - vc[1]) > vr + 6) continue;
      if (c.me) this.drawMeGlow(ctx, c);
      ctx.globalAlpha = c.replay ? 0.38 : c.ghost ? 0.42 : 1;
      this.drawCar(ctx, c, c.team, c.delta || 0, c.drsOpen);
      ctx.globalAlpha = 1;
      if (!c.replay) this.trackSkids(c, T);
    }

    // particles
    this.updateParticles(ctx, dt);
    // start-light gantry over the cars
    if (G.gantry && Math.hypot(G.gantry.cx - vc[0], G.gantry.cy - vc[1]) < vr + T.hw + 10) this.drawGantry(ctx, G.gantry, frame.lights || 0);

    // labels in screen space
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      const sp = this.toScreen(c.x, c.y);
      if (sp[0] < -60 || sp[1] < -60 || sp[0] > this.w + 60 || sp[1] > this.h + 60) continue;
      if (c.me) this.drawYouTag(ctx, sp[0], sp[1] - 3.6 * cam.z - 14);
      else if (frame.labels) this.drawLabel(ctx, sp[0], sp[1] - 3.2 * cam.z - 8, c);
    }
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
    // garages: shadow, roof, team fronts, open doors, names, dividers
    ctx.save(); ctx.translate(0.7, 0.9); ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fill(pit.building); ctx.restore();
    ctx.fillStyle = '#2a2d33'; ctx.fill(pit.building);
    ctx.strokeStyle = '#41464f'; ctx.lineWidth = 0.35; ctx.stroke(pit.building);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 0.25; ctx.stroke(pit.ribs);
    for (let i = 0; i < pit.garages.length; i++) {
      const g = pit.garages[i];
      ctx.fillStyle = g.color; quadPath(ctx, g.front); ctx.fill();
      ctx.fillStyle = '#0d0e11'; quadPath(ctx, g.door); ctx.fill();
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

  /* Draws a car centred at (c.x, c.y) heading c.a in world metres. */
  Renderer.prototype.drawCar = function (ctx, c, team, delta, drsOpen) {
    ctx.save();
    // shadow (offset fixed in world space)
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.translate(c.x + 0.28, c.y + 0.34);
    ctx.rotate(c.a);
    ctx.fillRect(-2.6, -0.85, 5.25, 1.7);
    ctx.restore();
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.a);
    drawCarLocal(ctx, team, delta, drsOpen);
    ctx.restore();
  };

  function drawCarLocal(ctx, team, delta, drsOpen) {
    ctx.fillStyle = '#121212';
    // rear tyres
    ctx.fillRect(-2.32, -0.95, 0.74, 0.42);
    ctx.fillRect(-2.32, 0.53, 0.74, 0.42);
    // front tyres (steer)
    for (const sy of [-0.77, 0.77]) {
      ctx.save(); ctx.translate(1.55, sy); ctx.rotate(delta * 1.6);
      ctx.fillRect(-0.34, -0.16, 0.68, 0.32);
      ctx.restore();
    }
    // suspension arms
    ctx.strokeStyle = '#2b2b2b'; ctx.lineWidth = 0.06;
    ctx.beginPath();
    ctx.moveTo(1.2, -0.22); ctx.lineTo(1.55, -0.62); ctx.moveTo(1.2, 0.22); ctx.lineTo(1.55, 0.62);
    ctx.moveTo(1.0, -0.3); ctx.lineTo(1.5, -0.62); ctx.moveTo(1.0, 0.3); ctx.lineTo(1.5, 0.62);
    ctx.moveTo(-1.6, -0.4); ctx.lineTo(-1.95, -0.55); ctx.moveTo(-1.6, 0.4); ctx.lineTo(-1.95, 0.55);
    ctx.stroke();
    // floor
    ctx.fillStyle = '#1b1b1d'; poly(ctx, FLOOR); ctx.fill();
    // body
    ctx.fillStyle = team.primary; poly(ctx, BODY); ctx.fill();
    if (team.split) {
      ctx.save(); ctx.beginPath(); ctx.rect(-3, 0, 6, 1.5); ctx.clip();
      ctx.fillStyle = team.secondary; poly(ctx, BODY); ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = team.split ? team.accent : team.secondary; poly(ctx, COVER); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.04; poly(ctx, BODY); ctx.stroke();
    // front wing
    ctx.fillStyle = team.secondary; ctx.fillRect(2.3, -0.93, 0.36, 1.86);
    ctx.fillStyle = team.primary; ctx.fillRect(2.28, -0.95, 0.4, 0.08); ctx.fillRect(2.28, 0.87, 0.4, 0.08);
    // rear wing (flap opens with DRS)
    ctx.fillStyle = team.primary; ctx.fillRect(-2.72, -0.52, 0.2, 1.04);
    ctx.fillStyle = drsOpen ? '#7CFF6B' : team.secondary; ctx.fillRect(drsOpen ? -2.47 : -2.52, -0.5, 0.16, 1.0);
    ctx.fillStyle = '#111'; ctx.fillRect(-2.74, -0.55, 0.3, 0.06); ctx.fillRect(-2.74, 0.49, 0.3, 0.06);
    // cockpit, helmet, halo
    ctx.fillStyle = '#0b0b0c'; ctx.beginPath(); ctx.ellipse(0.5, 0, 0.46, 0.25, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = team.accent; ctx.beginPath(); ctx.arc(0.42, 0, 0.16, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#2c2c2e'; ctx.lineWidth = 0.08;
    ctx.beginPath(); ctx.ellipse(0.47, 0, 0.36, 0.27, 0, -1.25, 1.25); ctx.moveTo(0.83, 0); ctx.lineTo(1.0, 0); ctx.stroke();
  }
  Renderer.drawCarLocal = drawCarLocal;

  Renderer.prototype.drawYouTag = function (ctx, x, y) {
    ctx.save();
    ctx.font = '800 12px "Titillium Web", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const w = 38, h = 18;
    ctx.fillStyle = '#ffd600';
    roundRect(ctx, x - w / 2, y - h, w, h, 4); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 7); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#111'; ctx.fillText('YOU', x, y - h / 2 + 1);
    ctx.restore();
  };

  Renderer.prototype.drawLabel = function (ctx, x, y, c) {
    ctx.save();
    ctx.font = '700 11px "Titillium Web", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const txt = c.label || c.code;
    const w = ctx.measureText(txt).width + 14, h = 16;
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
    const compact = W < 820;

    // ---- timing tower (top-left)
    if (hud.tower && hud.tower.length) {
      const rows = hud.tower;
      const rh = F1.clamp(Math.floor((H - 150) / (rows.length + 2)), 13, 22);
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
      ctx.fillText(right, x0 + tw - 10, y0 + rh * 0.8);
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
        if (r.pen) {
          const pw2 = Math.round(rh * 1.45), px2 = x0 + (compact ? 70 : 92);
          ctx.fillStyle = '#e10600'; roundRect(ctx, px2, y + 3, pw2, rh - 7, 3); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.font = '800 ' + Math.round(rh * 0.5) + 'px ' + FONT; ctx.textAlign = 'center';
          ctx.fillText('+' + r.pen + 's', px2 + pw2 / 2, y + rh / 2);
        }
        ctx.textAlign = 'right';
        ctx.font = '600 ' + Math.round(rh * 0.56) + 'px ' + FONT;
        ctx.fillStyle = r.me ? '#111' : (r.purple ? '#c77dff' : (r.out ? '#777' : '#d7dbe0'));
        ctx.fillText(r.info || '', x0 + tw - 8, y + rh / 2);
        if (r.done) {
          const fx = x0 + 76, fy = y + 4, s = Math.max(2, Math.floor((rh - 8) / 3));
          for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) { ctx.fillStyle = (a + b) % 2 ? '#111' : '#fff'; ctx.fillRect(fx + a * s, fy + b * s, s, s); }
        }
        y += rh;
      }
    }

    // ---- minimap (top-right)
    if (frame && frame.track) {
      const G = this.prep(frame.track), mm = G.mini;
      const ms = compact ? 130 : mm.size;
      const mx = W - ms - 12, my = 12;
      ctx.fillStyle = 'rgba(10,10,14,0.55)';
      roundRect(ctx, mx, my, ms, ms, 8); ctx.fill();
      ctx.drawImage(mm.canvas, mx, my, ms, ms);
      const k = ms / mm.size;
      const cars = frame.cars;
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < cars.length; i++) {
          const c = cars[i];
          if (!!c.me !== (pass === 1) || c.replay) continue;
          const px = mx + (c.x * mm.sc + mm.ox) * k, py = my + (c.y * mm.sc + mm.oy) * k;
          ctx.beginPath(); ctx.arc(px, py, c.me ? 5 : 3, 0, TAU);
          ctx.fillStyle = F1.teamUiColor(c.team); ctx.fill();
          ctx.lineWidth = c.me ? 2 : 1; ctx.strokeStyle = c.me ? '#ffd600' : 'rgba(0,0,0,0.7)'; ctx.stroke();
        }
      }
      let fy = my + ms + 8;
      if (hud.timeLeft) {
        ctx.fillStyle = 'rgba(10,10,14,0.86)';
        roundRect(ctx, mx, fy, ms, 26, 5); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = '700 13px ' + FONT; ctx.textAlign = 'center';
        ctx.fillText(hud.timeLeft, mx + ms / 2, fy + 13);
        fy += 34;
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

    // ---- centre messages
    let my2 = hud.lights !== undefined && hud.lights !== null ? 128 : 26;
    if (hud.msgs) {
      for (let i = 0; i < hud.msgs.length; i++) {
        const m = hud.msgs[i];
        ctx.font = '600 14px ' + FONT;
        const subW = m.sub ? ctx.measureText(m.sub).width : 0;
        ctx.font = '800 ' + (m.big ? 30 : 20) + 'px ' + FONT;
        const w = Math.max(ctx.measureText(m.text).width, subW) + 40;
        const h = (m.big ? 46 : 34) + (m.sub ? 20 : 0);
        ctx.globalAlpha = m.alpha === undefined ? 1 : m.alpha;
        if (m.sign) {
          // a warning sign: yellow (warning) or red (penalty) with a hazard triangle
          const sw = w + 56, sx = W / 2 - sw / 2, pen = m.sign === 'pen';
          ctx.fillStyle = pen ? '#d40a00' : '#ffd400';
          roundRect(ctx, sx, my2, sw, h, 7); ctx.fill();
          ctx.lineWidth = 3; ctx.strokeStyle = pen ? '#ffffff' : '#111111';
          roundRect(ctx, sx + 4, my2 + 4, sw - 8, h - 8, 5); ctx.stroke();
          const tx = sx + 30, ty = my2 + h / 2, ts = Math.min(17, h / 2 - 6);
          ctx.beginPath(); ctx.moveTo(tx, ty - ts); ctx.lineTo(tx + ts * 1.1, ty + ts * 0.85); ctx.lineTo(tx - ts * 1.1, ty + ts * 0.85); ctx.closePath();
          ctx.fillStyle = pen ? '#ffffff' : '#111111'; ctx.fill();
          ctx.fillStyle = pen ? '#d40a00' : '#ffd400'; ctx.font = '900 ' + Math.round(ts * 1.15) + 'px ' + FONT; ctx.textAlign = 'center';
          ctx.fillText('!', tx, ty + ts * 0.25);
          ctx.fillStyle = pen ? '#ffffff' : '#111111';
          ctx.font = '900 ' + (m.big ? 30 : 21) + 'px ' + FONT;
          ctx.fillText(m.text, W / 2 + 16, my2 + (m.big ? 24 : 18));
          if (m.sub) { ctx.font = '700 14px ' + FONT; ctx.fillText(m.sub, W / 2 + 16, my2 + h - 14); }
        } else {
          ctx.fillStyle = 'rgba(10,10,14,0.88)';
          roundRect(ctx, W / 2 - w / 2, my2, w, h, 6); ctx.fill();
          ctx.fillStyle = m.color || '#e10600'; ctx.fillRect(W / 2 - w / 2, my2, 4, h);
          ctx.textAlign = 'center';
          ctx.fillStyle = '#fff';
          ctx.fillText(m.text, W / 2, my2 + (m.big ? 24 : 18));
          if (m.sub) { ctx.font = '600 14px ' + FONT; ctx.fillStyle = m.subColor || '#cfd3d8'; ctx.fillText(m.sub, W / 2, my2 + h - 14); }
        }
        ctx.globalAlpha = 1;
        my2 += h + 8;
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

    // ---- bottom dashboard
    if (hud.speed !== undefined) {
      const bw = compact ? Math.min(W - 24, 400) : 560, bh = compact ? 84 : 96;
      const bx = W / 2 - bw / 2, by = H - bh - 14;
      // gap to the ghost, just above the dashboard
      if (hud.delta) {
        ctx.font = '900 26px ' + FONT;
        const dw = ctx.measureText(hud.delta.text).width + 92;
        ctx.fillStyle = 'rgba(10,10,14,0.88)';
        roundRect(ctx, W / 2 - dw / 2, by - 50, dw, 40, 8); ctx.fill();
        ctx.fillStyle = hud.delta.color; ctx.fillRect(W / 2 - dw / 2, by - 50, 4, 40);
        ctx.textAlign = 'left'; ctx.font = '800 11px ' + FONT; ctx.fillStyle = '#9aa1a8';
        ctx.fillText('GHOST', W / 2 - dw / 2 + 14, by - 30);
        ctx.textAlign = 'right'; ctx.font = '900 26px ' + FONT; ctx.fillStyle = hud.delta.color;
        ctx.fillText(hud.delta.text, W / 2 + dw / 2 - 14, by - 29);
      }
      ctx.fillStyle = 'rgba(10,10,14,0.88)';
      roundRect(ctx, bx, by, bw, bh, 10); ctx.fill();
      // gear + speed
      ctx.font = '800 30px ' + FONT; ctx.fillStyle = '#ffd600'; ctx.textAlign = 'center';
      ctx.fillText(String(hud.gear), bx + 28, by + 34);
      ctx.font = '700 10px ' + FONT; ctx.fillStyle = '#9aa1a8'; ctx.fillText('GEAR', bx + 28, by + 55);
      ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.font = '800 42px ' + FONT;
      ctx.fillText(String(hud.speed), bx + 146, by + 36);
      ctx.font = '700 11px ' + FONT; ctx.fillStyle = '#9aa1a8'; ctx.textAlign = 'left';
      ctx.fillText('KM/H', bx + 150, by + 46);
      // DRS indicator
      const dx = bx + 14, dy = by + bh - 28, dw = 172;
      const st = hud.drs;
      if (hud.pit) {
        ctx.fillStyle = Math.floor(performance.now() / 400) % 2 ? '#1f6bff' : '#1752c4';
        roundRect(ctx, dx, dy, dw, 18, 4); ctx.fill();
        ctx.font = '800 11px ' + FONT; ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
        ctx.fillText('PIT LIMITER  80 KM/H', dx + dw / 2, dy + 9.5);
      } else {
        ctx.fillStyle = st === 'open' ? '#19c94a' : 'rgba(40,40,48,0.95)';
        roundRect(ctx, dx, dy, dw, 18, 4); ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = st === 'open' ? '#19c94a' : st === 'avail' ? (Math.floor(performance.now() / 250) % 2 ? '#7dff9b' : '#19c94a') : '#3b3b45';
        ctx.stroke();
        ctx.font = '800 11px ' + FONT; ctx.textAlign = 'center';
        ctx.fillStyle = st === 'open' ? '#04210c' : st === 'avail' ? '#7dff9b' : '#7b7f88';
        ctx.fillText(st === 'open' ? 'DRS OPEN' : st === 'avail' ? 'DRS — PRESS SHIFT / SPACE' : 'DRS', dx + dw / 2, dy + 9.5);
      }
      // position + lap
      const cx2 = bx + 206;
      ctx.textAlign = 'left'; ctx.fillStyle = '#fff'; ctx.font = '800 26px ' + FONT;
      ctx.fillText(hud.posText || '', cx2, by + 28);
      ctx.font = '700 13px ' + FONT; ctx.fillStyle = '#cfd3d8';
      ctx.fillText(hud.lapText || '', cx2, by + 54);
      if (compact) {
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
    if (hud.ping !== undefined && hud.ping !== null) {
      ctx.fillStyle = hud.ping < 80 ? '#7dff9b' : hud.ping < 160 ? '#ffd600' : '#ff5a4f';
      ctx.textAlign = 'right';
      ctx.fillText('PING ' + hud.ping + ' ms', W - 92, H - 18);
    }
  };

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
