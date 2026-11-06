/* Track geometry: circuit outlines, centreline sampling, surfaces, run-off, racing line.
   Units are metres. Screen-style coordinates: x to the right (east), y downwards (south).
   Heading 0 points right, +90deg points down; a right-hand turn increases the heading.

   Circuit outlines derived from "f1-circuits" by Tomislav Bacinger (MIT licence):
   https://github.com/bacinger/f1-circuits  */
(function (root) {
  'use strict';
  const F1 = (root.F1 = root.F1 || {});

  F1.SURF = { ASPHALT: 0, KERB: 1, GRASS: 2, GRAVEL: 3 };

  F1.TRACK_DEFS = {
    monza: {
      id: 'monza', name: 'Monza', country: 'Italy', officialLength: 5793,
      halfWidth: 7, runoff: 30, startAt: 0,
      pts: [
        -417.7,491.6,-381.2,65.1,-364.6,-113.7,-362.8,-121,-357.6,-125.2,-351.3,-126.2,-343.4,-125.2,-336,-124.7,
        -329.2,-125.2,-324.5,-128.9,-320.8,-134.1,-319.9,-138.7,-319.9,-143.9,-345.7,-241.4,-349.4,-268,-350.8,-292,
        -348.9,-318,-339.3,-445.2,-335.5,-466,-330.9,-485.3,-324,-506.1,-314.8,-528.6,-304.2,-550.5,-288.6,-575,
        -272.5,-595.3,-250.8,-618.3,-227.2,-638.6,-201,-657.3,-172.9,-673.4,-141.1,-689.1,-109.3,-700.1,-74.3,-709.9,
        -34.6,-716.8,5.9,-720.4,164,-733.9,357.5,-745.4,369,-746.4,375,-749.6,380.1,-754.8,386.5,-777.3,
        389.3,-783.5,393.9,-787.7,401.7,-790.2,428,-795,456.6,-801.1,497.1,-814.2,678.2,-874.7,693.8,-878.3,
        708.6,-878.3,722.9,-875.7,733,-871.6,742.7,-865.8,751.9,-859.5,763.5,-847,769.9,-837.2,774.5,-825.1,
        776.8,-811.6,784.6,-726.2,799.4,-580.2,799,-567.2,796.6,-558.8,793,-551.5,787,-546.3,775.9,-539,
        657.5,-475.4,561.2,-421.8,501.2,-388.9,472.2,-372.2,439.5,-349.3,416,-331.5,395.7,-313.8,290.6,-224.2,
        216.1,-156.9,58.4,-19.4,-36.5,63.5,-49.4,76.6,-54.5,84.9,-55.4,93.2,-55.4,103.1,-52.1,125,
        -51.2,137,-51.2,154.2,-52.6,163.6,-56.4,175.6,-61.9,189.6,-71.1,203.8,-83.5,218.3,-97.8,230.3,
        -109.3,239.1,-115.3,246,-119.9,255.3,-124.1,272.5,-133.7,351.3,-143.9,435.2,-222.2,1187.7,-225.5,1214.8,
        -228.6,1227.4,-235.1,1240.4,-243.9,1250.9,-254,1260.3,-268.3,1269.6,-283.9,1275.3,-301.9,1278.5,-317.2,1277.4,
        -331.4,1274.3,-348,1268,-364.1,1260.7,-376.1,1252.4,-390.4,1241.5,-406.5,1224.2,-417.6,1208.6,-427.2,1192,
        -435.6,1172.2,-443.4,1150.3,-449.4,1127.8,-452.2,1108.6,-455.4,1079.4,-455.8,1050.2,-456.3,1022.6,-457.7,967.8,
        -458.6,919.8,-457.7,867.7,-451.7,799.5,-429.1,583.7
      ]
    },
    silverstone: {
      id: 'silverstone', name: 'Silverstone', country: 'Great Britain', officialLength: 5891,
      halfWidth: 7.5, runoff: 30, startAt: 72.4, startShift: -265,
      pts: [
        69,-776,255.8,-792.1,288.9,-790.1,314.5,-781.7,331.1,-770.8,350.9,-747.9,363.5,-721.8,373.6,-689,
        387.8,-633.2,402.4,-578.5,410.9,-518,414.5,-480,419.4,-387.8,421.4,-309,424.6,-278.3,436.4,-249.5,
        458.6,-209.4,468,-186.5,467.6,-169.3,463.5,-149,431.9,-66.1,429.9,-32.7,434.8,-8.8,446.1,11.5,
        477.3,54.8,484.6,74.7,485.4,98.1,480.1,119.4,461.1,142.9,436.8,160.1,403.6,179.4,377.7,194.5,
        359.4,212.2,338.4,247.1,297.1,324.2,69.8,739.6,-4.7,854.9,-25.7,883.1,-42.7,898.1,-62.6,908.1,
        -83.2,913.2,-102.2,911.7,-123.3,906.9,-141.1,899.2,-156.9,886.7,-170.3,866.8,-174.4,859.1,-194.6,815.3,
        -217.3,776.1,-241.6,743.8,-258.2,724.1,-276.8,703.7,-309.6,670.3,-382.9,583.3,-390.3,578.7,-400.4,577.5,
        -410.4,582.3,-441.2,609.9,-451.8,613.6,-462.3,612.5,-471.2,608.8,-483.8,596.9,-497.1,583.3,-513.8,561.4,
        -525.9,538,-534.4,514,-541.7,486.9,-542.5,475.9,-540.4,465,-534.4,454.6,-519.8,431.6,-296.2,141.9,
        -246,77.8,-235.5,65.7,-217.3,53.8,-195.4,48.6,-177.6,48,-152.9,50.1,-84,60.5,-61.3,63.2,
        -37.9,64.1,-11.1,60.5,13.2,54.3,35,42.3,177.6,-70.3,186.9,-76.5,198.3,-82.3,210,-83.4,
        218.9,-80.1,227,-72.9,231.9,-64.6,256.2,19.9,263.5,31.9,273.5,39.2,285.3,39.7,298.3,34,
        306.4,23.6,311.7,12.6,321.8,-15,329.9,-38.5,335.9,-61.5,339.2,-83.8,341.2,-107.4,339.6,-131.8,
        334.7,-142.7,322.2,-156.8,-140,-575.9,-152.5,-583.7,-169.9,-592.5,-191.3,-595.6,-213.6,-593.1,-236.3,-582.2,
        -244.4,-572.2,-250.1,-557.6,-259.4,-481.5,-264.7,-465.9,-276,-453.3,-293,-445,-311.6,-442.4,-332.3,-447.7,
        -346.9,-457.5,-355.8,-469,-362.7,-482.5,-363.9,-497.1,-361,-512.8,-349.7,-538.4,-290.2,-655.6,-271.1,-678,
        -252.5,-696.8,-225.8,-719.7,-203.9,-734.9,-176.4,-746.4,-152.5,-754.1,-101.8,-760.4
      ]
    }
  };

  function wrapS(s, L) { s %= L; return s < 0 ? s + L : s; }
  function wrapAngle(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

  /* Centripetal Catmull-Rom through the outline points, sampled densely. */
  function splineDense(P, sub) {
    const n = P.length, out = [];
    const knot = function (a, b) { return Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5) || 1e-4; };
    for (let i = 0; i < n; i++) {
      const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
      const t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
      for (let k = 0; k < sub; k++) {
        const t = t1 + (t2 - t1) * (k / sub);
        const pt = [0, 0];
        for (let c = 0; c < 2; c++) {
          const a1 = (t1 - t) / (t1 - t0) * p0[c] + (t - t0) / (t1 - t0) * p1[c];
          const a2 = (t2 - t) / (t2 - t1) * p1[c] + (t - t1) / (t2 - t1) * p2[c];
          const a3 = (t3 - t) / (t3 - t2) * p2[c] + (t - t2) / (t3 - t2) * p3[c];
          const b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2;
          const b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3;
          pt[c] = (t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2;
        }
        out.push({ x: pt[0], y: pt[1], v: i + k / sub });
      }
    }
    return out;
  }

  F1.buildTrack = function (def) {
    const P = [];
    for (let i = 0; i < def.pts.length; i += 2) P.push([def.pts[i], def.pts[i + 1]]);
    const dense = splineDense(P, 32);
    const D = dense.length;
    // cumulative length of the dense polyline
    const cum = new Float64Array(D + 1);
    for (let i = 0; i < D; i++) {
      const a = dense[i], b = dense[(i + 1) % D];
      cum[i + 1] = cum[i] + Math.hypot(b.x - a.x, b.y - a.y);
    }
    const rawL = cum[D];
    const scale = def.officialLength / rawL;
    const L = def.officialLength;
    // where the start/finish line is (outline vertex index, may be fractional)
    let sStart = 0;
    {
      const target = def.startAt;
      for (let i = 0; i < D; i++) {
        if (dense[i].v <= target && (i === D - 1 || dense[i + 1].v > target)) {
          const nextV = i === D - 1 ? P.length : dense[i + 1].v;
          const f = (target - dense[i].v) / Math.max(1e-9, nextV - dense[i].v);
          sStart = (cum[i] + f * (cum[i + 1] - cum[i])) * scale;
          break;
        }
      }
    }
    sStart = wrapS(sStart + (def.startShift || 0), L);
    const N = Math.round(L / 2);
    const ds = L / N;
    const hw = def.halfWidth;
    const X = new Float64Array(N), Y = new Float64Array(N);
    let j = 0;
    for (let i = 0; i < N; i++) {
      const sr = wrapS(sStart + i * ds, L) / scale;
      if (i === 0 || sr < cum[j]) j = 0;
      while (j < D - 1 && cum[j + 1] < sr) j++;
      const a = dense[j], b = dense[(j + 1) % D];
      const f = (sr - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j]);
      X[i] = (a.x + (b.x - a.x) * f) * scale;
      Y[i] = (a.y + (b.y - a.y) * f) * scale;
    }
    // light smoothing to remove kinks left by the sparse outline
    const tmpX = new Float64Array(N), tmpY = new Float64Array(N);
    for (let it = 0; it < (def.smooth || 16); it++) {
      for (let i = 0; i < N; i++) {
        let sx = 0, sy = 0;
        for (let k = -3; k <= 3; k++) { const q = (i + k + N) % N; const w = 4 - Math.abs(k); sx += X[q] * w; sy += Y[q] * w; }
        tmpX[i] = sx / 16; tmpY[i] = sy / 16;
      }
      X.set(tmpX); Y.set(tmpY);
    }
    // re-parameterise by arc length after smoothing so spacing is exactly uniform
    {
      const c2 = new Float64Array(N + 1);
      for (let i = 0; i < N; i++) c2[i + 1] = c2[i] + Math.hypot(X[(i + 1) % N] - X[i], Y[(i + 1) % N] - Y[i]);
      const k2 = L / c2[N];
      const nx = new Float64Array(N), ny = new Float64Array(N);
      let q = 0;
      for (let i = 0; i < N; i++) {
        const s = (i * ds) / k2;
        while (q < N - 1 && c2[q + 1] < s) q++;
        const f = (s - c2[q]) / Math.max(1e-9, c2[q + 1] - c2[q]);
        const b = (q + 1) % N;
        nx[i] = (X[q] + (X[b] - X[q]) * f) * k2;
        ny[i] = (Y[q] + (Y[b] - Y[q]) * f) * k2;
      }
      X.set(nx); Y.set(ny);
    }

    const T = {
      id: def.id, name: def.name, country: def.country,
      length: L, n: N, ds: ds, hw: hw, kerbW: 1.3, runoff: def.runoff,
      x: X, y: Y, hd: new Float64Array(N), tx: new Float64Array(N), ty: new Float64Array(N),
      nx: new Float64Array(N), ny: new Float64Array(N), curv: new Float64Array(N),
      kerb: new Uint8Array(N), gravel: new Uint8Array(N), wall: new Float32Array(N),
      drsZone: new Int8Array(N).fill(-1)
    };
    for (let i = 0; i < N; i++) {
      const a = (i - 1 + N) % N, b = (i + 1) % N;
      const h = Math.atan2(Y[b] - Y[a], X[b] - X[a]);
      T.hd[i] = h; T.tx[i] = Math.cos(h); T.ty[i] = Math.sin(h);
      T.nx[i] = -T.ty[i]; T.ny[i] = T.tx[i];
    }
    const rawK = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i - 2 + N) % N, b = (i + 2) % N;
      rawK[i] = wrapAngle(T.hd[b] - T.hd[a]) / (4 * ds);
    }
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let k = -4; k <= 4; k++) s += rawK[(i + k + N) % N];
      T.curv[i] = s / 9;
    }

    markCorners(T);
    computeWalls(T, hw + def.runoff);
    findDrsZones(T);
    // pole position goes on the inside of the first proper corner
    T.poleSide = 1;
    for (let i = 0; i < N; i++) {
      if (Math.abs(T.curv[i]) > 1 / 150) { T.poleSide = T.curv[i] > 0 ? 1 : -1; break; }
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < N; i++) {
      if (X[i] < minX) minX = X[i]; if (X[i] > maxX) maxX = X[i];
      if (Y[i] < minY) minY = Y[i]; if (Y[i] > maxY) maxY = Y[i];
    }
    T.bounds = { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
    computeRacingLine(T);
    return T;
  };

  function forRange(T, s0, s1, fn) {
    const N = T.n, ds = T.ds;
    for (let k = Math.ceil(s0 / ds); k <= Math.floor(s1 / ds); k++) fn(((k % N) + N) % N);
  }

  /* Kerbs at every real corner; gravel on the outside of the slower/bigger ones. */
  function markCorners(T) {
    const N = T.n, ds = T.ds, K = T.curv;
    // start scanning from the straightest point so runs never wrap awkwardly
    let start = 0, minAbs = Infinity;
    for (let i = 0; i < N; i++) if (Math.abs(K[i]) < minAbs) { minAbs = Math.abs(K[i]); start = i; }
    const corners = [];
    let run = null;
    for (let k = 0; k <= N; k++) {
      const i = (start + k) % N;
      const kv = K[i], sign = kv > 0 ? 1 : -1;
      const inCorner = Math.abs(kv) > 1 / 260;
      if (inCorner && run && run.sign === sign) { run.end = start + k; run.turn += kv * ds; }
      else {
        if (run) corners.push(run);
        run = inCorner ? { begin: start + k, end: start + k, sign: sign, turn: kv * ds } : null;
      }
    }
    if (run) corners.push(run);
    T.cornerList = [];
    corners.forEach(function (c) {
      const turnDeg = Math.abs(c.turn) * 180 / Math.PI;
      if (turnDeg < 12) return;
      const s0 = c.begin * ds, s1 = c.end * ds;
      forRange(T, s0 - 10, s1 + 10, function (i) { T.kerb[i] = 3; });
      if (turnDeg > 25) {
        const outBit = c.sign > 0 ? 1 : 2;
        forRange(T, s0 - 15, s1 + 85, function (i) { T.gravel[i] |= outBit; });
      }
      T.cornerList.push({ s: wrapS((s0 + s1) / 2, T.length), turn: turnDeg * c.sign });
    });
  }

  /* Barrier distance: normally hw + runoff, closer where two parts of the circuit run near each other. */
  function computeWalls(T, maxWall) {
    const N = T.n, X = T.x, Y = T.y, L = T.length, ds = T.ds;
    const cell = 60, grid = new Map();
    const key = function (cx, cy) { return cx * 100003 + cy; };
    for (let i = 0; i < N; i++) {
      const k = key(Math.floor(X[i] / cell), Math.floor(Y[i] / cell));
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
    const reach = Math.ceil((2 * maxWall + 10) / cell);
    for (let i = 0; i < N; i++) {
      const cx = Math.floor(X[i] / cell), cy = Math.floor(Y[i] / cell);
      let best = Infinity;
      for (let gx = cx - reach; gx <= cx + reach; gx++) for (let gy = cy - reach; gy <= cy + reach; gy++) {
        const list = grid.get(key(gx, gy));
        if (!list) continue;
        for (let q = 0; q < list.length; q++) {
          const jj = list[q];
          let sd = Math.abs(i - jj) * ds; if (sd > L / 2) sd = L - sd;
          if (sd < 3 * maxWall + 60) continue;
          const d = Math.hypot(X[i] - X[jj], Y[i] - Y[jj]);
          if (d < best) best = d;
        }
      }
      T.wall[i] = Math.max(T.hw + 4, Math.min(maxWall, best / 2 - 3));
    }
    // smooth so barriers do not zig-zag
    const tmp = new Float32Array(N);
    for (let it = 0; it < 3; it++) {
      for (let i = 0; i < N; i++) {
        let m = T.wall[i];
        for (let k = -12; k <= 12; k++) m = Math.min(m, T.wall[(i + k + N) % N] + Math.abs(k) * 0.8);
        tmp[i] = m;
      }
      T.wall.set(tmp);
    }
    T.maxWall = maxWall;
  }

  /* DRS zones on the two longest straights. Detection point 180 m before each zone. */
  function findDrsZones(T) {
    const N = T.n, ds = T.ds, K = T.curv, L = T.length;
    let start = 0, maxAbs = 0;
    for (let i = 0; i < N; i++) if (Math.abs(K[i]) > maxAbs) { maxAbs = Math.abs(K[i]); start = i; }
    const runs = [];
    let run = null;
    for (let k = 0; k <= N; k++) {
      const i = (start + k) % N;
      const straight = Math.abs(K[i]) < 1 / 900;
      if (straight) { if (!run) run = { a: start + k, b: start + k }; else run.b = start + k; }
      else if (run) { runs.push(run); run = null; }
    }
    if (run) runs.push(run);
    // merge runs separated by tiny kinks
    const merged = [];
    runs.forEach(function (r) {
      const last = merged[merged.length - 1];
      if (last && (r.a - last.b) * ds < 70) last.b = r.b; else merged.push({ a: r.a, b: r.b });
    });
    merged.sort(function (p, q) { return (q.b - q.a) - (p.b - p.a); });
    T.drs = [];
    merged.slice(0, 2).forEach(function (r) {
      const s0 = wrapS(r.a * ds + 40, L), s1 = wrapS(r.b * ds - 110, L);
      T.drs.push({ start: s0, end: s1, detect: wrapS(s0 - 180, L) });
    });
    T.drs.sort(function (p, q) { return p.start - q.start; });
    T.drs.forEach(function (z, zi) {
      const len = wrapS(z.end - z.start, L);
      forRange(T, z.start, z.start + len, function (i) { T.drsZone[i] = zi; });
    });
  }

  function computeRacingLine(T) {
    const N = T.n, X = T.x, Y = T.y, NX = T.nx, NY = T.ny;
    const lim = T.hw - 1.3;
    const o = new Float64Array(N);
    const passes = [[24, 120], [12, 140], [6, 160], [3, 200], [1, 260]];
    for (const pass of passes) {
      const k = pass[0];
      for (let it = 0; it < pass[1]; it++) {
        for (let i = 0; i < N; i++) {
          const a = (i - k + N) % N, b = (i + k) % N;
          const mx = 0.5 * (X[a] + NX[a] * o[a] + X[b] + NX[b] * o[b]);
          const my = 0.5 * (Y[a] + NY[a] * o[a] + Y[b] + NY[b] * o[b]);
          let t = (mx - X[i]) * NX[i] + (my - Y[i]) * NY[i];
          if (t > lim) t = lim; else if (t < -lim) t = -lim;
          o[i] = t;
        }
      }
    }
    const RX = new Float64Array(N), RY = new Float64Array(N), RK = new Float64Array(N);
    for (let i = 0; i < N; i++) { RX[i] = X[i] + NX[i] * o[i]; RY[i] = Y[i] + NY[i] * o[i]; }
    const st = 3;
    const raw = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i - st + N) % N, b = (i + st) % N;
      const ax = RX[a], ay = RY[a], bx = RX[i], by = RY[i], cx = RX[b], cy = RY[b];
      const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const d1 = Math.hypot(bx - ax, by - ay), d2 = Math.hypot(cx - ax, cy - ay), d3 = Math.hypot(cx - bx, cy - by);
      raw[i] = (2 * cross) / Math.max(1e-6, d1 * d2 * d3);
    }
    for (let i = 0; i < N; i++) {
      let sum = 0;
      for (let k = -3; k <= 3; k++) sum += raw[(i + k + N) % N];
      RK[i] = sum / 7;
    }
    T.rlOff = o; T.rlX = RX; T.rlY = RY; T.rlK = RK;
  }

  /* Nearest point on the centreline. hint = previous index (fast local search) or -1 (full search).
     Writes idx, s, d (signed: + is right of the travel direction), dist, cx, cy into out. */
  F1.queryTrack = function (T, x, y, hint, out) {
    const N = T.n, X = T.x, Y = T.y;
    let bi = 0, bd = Infinity;
    if (hint === undefined || hint === null || hint < 0) {
      for (let i = 0; i < N; i++) {
        const dx = x - X[i], dy = y - Y[i];
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; bi = i; }
      }
    } else {
      for (let k = -28; k <= 28; k++) {
        let i = hint + k;
        if (i < 0) i += N; else if (i >= N) i -= N;
        const dx = x - X[i], dy = y - Y[i];
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; bi = i; }
      }
    }
    let best = Infinity, bpx = X[bi], bpy = Y[bi], bs = bi, bvx = T.tx[bi], bvy = T.ty[bi];
    for (let side = 0; side < 2; side++) {
      const i0 = side === 0 ? (bi - 1 + N) % N : bi;
      const i1 = side === 0 ? bi : (bi + 1) % N;
      const ax = X[i0], ay = Y[i0];
      const vx = X[i1] - ax, vy = Y[i1] - ay;
      const l2 = vx * vx + vy * vy;
      let t = l2 > 0 ? ((x - ax) * vx + (y - ay) * vy) / l2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const px = ax + vx * t, py = ay + vy * t;
      const dx = x - px, dy = y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) { best = d2; bpx = px; bpy = py; bs = i0 + t; bvx = vx; bvy = vy; }
    }
    const dist = Math.sqrt(best);
    const cross = bvx * (y - bpy) - bvy * (x - bpx);
    out.idx = bi;
    let s = bs * T.ds;
    if (s >= T.length) s -= T.length;
    out.s = s;
    out.dist = dist;
    out.d = cross >= 0 ? dist : -dist;
    out.cx = bpx; out.cy = bpy;
    return out;
  };

  F1.surfaceAt = function (T, idx, d) {
    const ad = d < 0 ? -d : d;
    if (ad <= T.hw) return 0;
    if (ad <= T.hw + T.kerbW && T.kerb[idx]) return 1;
    const bit = d < 0 ? 1 : 2;
    if ((T.gravel[idx] & bit) && ad >= T.hw + 1.5) return 3;
    return 2;
  };

  F1.idxAt = function (T, s) {
    let i = Math.floor(s / T.ds) % T.n;
    if (i < 0) i += T.n;
    return i;
  };

  /* Point at distance s along the track with lateral offset d (interpolated). */
  F1.trackPoint = function (T, s, d) {
    s = wrapS(s, T.length);
    const f = s / T.ds;
    const i0 = Math.floor(f) % T.n, i1 = (i0 + 1) % T.n;
    const t = f - Math.floor(f);
    const x = T.x[i0] + (T.x[i1] - T.x[i0]) * t;
    const y = T.y[i0] + (T.y[i1] - T.y[i0]) * t;
    const h = T.hd[i0] + wrapAngle(T.hd[i1] - T.hd[i0]) * t;
    const nx = -Math.sin(h), ny = Math.cos(h);
    return { x: x + nx * (d || 0), y: y + ny * (d || 0), h: h };
  };

  /* Grid slot k (0 = pole): staggered, 8 m apart. */
  F1.gridSlot = function (T, k) {
    const s = T.length - 7 - 8 * k;
    const side = (k % 2 === 0 ? 1 : -1) * T.poleSide;
    return F1.trackPoint(T, s, side * 2.6);
  };

  F1.wrapS = wrapS;
  F1.wrapAngle = wrapAngle;

  const cache = {};
  F1.getTrack = function (id) {
    if (!cache[id]) cache[id] = F1.buildTrack(F1.TRACK_DEFS[id]);
    return cache[id];
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = F1;
})(typeof window !== 'undefined' ? window : globalThis);
