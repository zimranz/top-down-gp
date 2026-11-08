/* Car physics, collisions, AI drivers and session logic (practice / qualifying / race).
   Runs on the server (authoritative online races) and in the browser (practice + prediction). */
(function (root) {
  'use strict';
  const F1 = (root.F1 = root.F1 || {});

  // ---------------------------------------------------------------- constants
  const CAR = (F1.CAR = { length: 5.4, width: 1.9, HL: 2.7, HW: 0.95, WB: 3.4, MASS: 800, INERTIA: 1950 });
  const P = (F1.PHYS = {
    POWER: 746000,        // ~1000 hp
    DRAG: 0.87,           // 0.5 * rho * CdA  -> ~342 km/h top speed
    ROLL: 0.15,
    ENGINE_BRAKE: 1.2,
    TRACT0: 11, TRACT_K: 0.0022, TRACT_MAX: 16,
    BRAKE0: 20, BRAKE_K: 0.0045, BRAKE_MAX: 52,
    LAT0: 20, LAT_K: 0.0062, LAT_MAX: 55,  // grip grows with downforce (speed squared)
    STEER_MAX: 0.38,
    REV_MAX: 7, REV_ACC: 4,
    DRS_DRAG: 0.86
  });
  // Grass and gravel scrub off speed hard when you arrive fast, but you can drive back out at a decent pace
  // (about 100 km/h on grass, about 65 km/h in gravel). Same rules for players and AI.
  const SURFS = [
    { grip: 1.0, traction: 1.0, roll: 0, drag2: 0 },          // asphalt
    { grip: 0.94, traction: 0.96, roll: 0.25, drag2: 0 },     // kerb
    { grip: 0.62, traction: 0.62, roll: 2.6, drag2: 0.0048 }, // grass
    { grip: 0.48, traction: 0.46, roll: 2.4, drag2: 0.007 },  // gravel
    { grip: 1.0, traction: 1.0, roll: 0, drag2: 0 }           // pit lane (80 km/h limiter)
  ];
  const PIT_LIMIT = (F1.PIT_LIMIT = 80 / 3.6);
  const POINTS = (F1.POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]);
  F1.DT = 1 / 60;
  F1.SUBSTEPS = 2;
  F1.NEUTRAL = { throttle: 0, brake: 0, steer: 0, drs: false, reset: false };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  F1.clamp = clamp;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  F1.rng = mulberry32;

  F1.fmtLap = function (t) {
    if (t === null || t === undefined || !isFinite(t)) return '--:--.---';
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(3);
  };

  // ---------------------------------------------------------------- cars
  const Q = {}, Q2 = {};

  F1.createCar = function (id, driverId, T, slot, isAI) {
    const g = F1.gridSlot(T, slot);
    const c = {
      id: id, driverId: driverId, isAI: !!isAI, slot: slot,
      x: g.x, y: g.y, a: g.h, vx: 0, vy: 0, w: 0, delta: 0,
      seg: -1, s: 0, d: 0, dist: 0, surf: 0,
      slide: false, drsOpen: false, drsAllowed: false, locked: false,
      resetCd: 0, wallHit: 0, out: false, dirty: 1, blue: -1, lockFx: false,
      px: g.x, py: g.y, pa: g.h
    };
    F1.queryTrack(T, c.x, c.y, -1, Q);
    c.seg = Q.idx; c.s = Q.s; c.d = Q.d; c.dist = Q.dist;
    return c;
  };

  F1.resetCar = function (c, T) {
    F1.queryTrack(T, c.x, c.y, c.seg, Q);
    const p = F1.trackPoint(T, Q.s, clamp(Q.d, -T.hw + 2, T.hw - 2));
    c.x = p.x; c.y = p.y; c.a = p.h;
    c.vx = 0; c.vy = 0; c.w = 0; c.delta = 0; c.slide = false; c.drsOpen = false;
    F1.queryTrack(T, c.x, c.y, Q.idx, Q);
    c.seg = Q.idx; c.s = Q.s; c.d = Q.d; c.dist = Q.dist;
  };

  /* Impulse-based contact. n points from B to A (pushes A along +n). B may be null (barrier). */
  F1.contactImpulse = function (A, B, px, py, nx, ny, e, mu, applyB) {
    const im = 1 / CAR.MASS, ii = 1 / CAR.INERTIA;
    const rax = px - A.x, ray = py - A.y;
    let rvx = A.vx - A.w * ray, rvy = A.vy + A.w * rax;
    let rbx = 0, rby = 0;
    if (B) {
      rbx = px - B.x; rby = py - B.y;
      rvx -= B.vx - B.w * rby; rvy -= B.vy + B.w * rbx;
    }
    const vn = rvx * nx + rvy * ny;
    if (vn >= 0) return 0;
    const ran = rax * ny - ray * nx;
    let denom = im + ran * ran * ii;
    let rbn = 0;
    if (B) { rbn = rbx * ny - rby * nx; denom += im + rbn * rbn * ii; }
    const j = (-(1 + e) * vn) / denom;
    A.vx += j * nx * im; A.vy += j * ny * im; A.w += ran * j * ii;
    if (B && applyB) { B.vx -= j * nx * im; B.vy -= j * ny * im; B.w -= rbn * j * ii; }
    // friction
    let tx = rvx - vn * nx, ty = rvy - vn * ny;
    const tl = Math.hypot(tx, ty);
    if (tl > 1e-4) {
      tx /= tl; ty /= tl;
      const rat = rax * ty - ray * tx;
      let dt2 = im + rat * rat * ii, rbt = 0;
      if (B) { rbt = rbx * ty - rby * tx; dt2 += im + rbt * rbt * ii; }
      let jt = -tl / dt2;
      const maxF = mu * j;
      if (jt < -maxF) jt = -maxF;
      A.vx += jt * tx * im; A.vy += jt * ty * im; A.w += rat * jt * ii;
      if (B && applyB) { B.vx -= jt * tx * im; B.vy -= jt * ty * im; B.w -= rbt * jt * ii; }
    }
    return j;
  };

  /* Pit wall: a thin barrier between the main straight and the pit lane. */
  function pitWallCollide(c, T) {
    const P = T.pit;
    if (!P || !T.pitWall[c.seg]) return;
    const dW = P.side * P.wallOff;
    if (Math.abs(c.d - dW) > 3.4) return;
    const ca = Math.cos(c.a), sa = Math.sin(c.a);
    const s0 = c.d - dW, sgn = s0 >= 0 ? 1 : -1;
    for (let k = 0; k < 4; k++) {
      const fx = k < 2 ? 1 : -1, fy = (k & 1) ? 1 : -1;
      const px = c.x + ca * CAR.HL * fx - sa * CAR.HW * fy;
      const py = c.y + sa * CAR.HL * fx + ca * CAR.HW * fy;
      F1.queryTrack(T, px, py, c.seg, Q2);
      if (!T.pitWall[Q2.idx]) continue;
      const pen = 0.35 - sgn * (Q2.d - dW);
      if (pen <= 0) continue;
      const nx = T.nx[Q2.idx] * sgn, ny = T.ny[Q2.idx] * sgn;
      const j = F1.contactImpulse(c, null, px, py, nx, ny, 0.25, 0.45, false);
      c.x += nx * pen; c.y += ny * pen;
      if (j > c.wallHit) c.wallHit = j;
    }
  }

  function wallCollide(c, T) {
    pitWallCollide(c, T);
    const wallHere = F1.wallAt(T, c.seg, c.d);
    if (c.dist < Math.min(wallHere, T.wall[c.seg]) - 3.2) return;
    const ca = Math.cos(c.a), sa = Math.sin(c.a);
    for (let k = 0; k < 4; k++) {
      const fx = k < 2 ? 1 : -1, fy = (k & 1) ? 1 : -1;
      const px = c.x + ca * CAR.HL * fx - sa * CAR.HW * fy;
      const py = c.y + sa * CAR.HL * fx + ca * CAR.HW * fy;
      F1.queryTrack(T, px, py, c.seg, Q2);
      const w = F1.wallAt(T, Q2.idx, Q2.d);
      if (Q2.dist > w && Q2.dist > 1e-6) {
        const pen = Q2.dist - w;
        const nx = (Q2.cx - px) / Q2.dist, ny = (Q2.cy - py) / Q2.dist;
        const j = F1.contactImpulse(c, null, px, py, nx, ny, 0.25, 0.45, false);
        c.x += nx * pen; c.y += ny * pen;
        if (j > c.wallHit) c.wallHit = j;
      }
    }
  }

  /* One physics sub-step for one car. inp: {throttle 0..1, brake 0..1, steer -1.8..1.8, drs, reset} */
  F1.stepCar = function (c, inp, T, dt) {
    if (c.out) return;
    if (c.resetCd > 0) c.resetCd -= dt;
    let sp = Math.hypot(c.vx, c.vy);
    if (inp.reset && c.resetCd <= 0 && sp < 30 && !c.locked) {
      F1.resetCar(c, T); c.resetCd = 3; return;
    }
    F1.queryTrack(T, c.x, c.y, c.seg, Q);
    c.seg = Q.idx; c.s = Q.s; c.d = Q.d; c.dist = Q.dist;
    if (c.locked) {
      c.vx = 0; c.vy = 0; c.w = 0; c.drsOpen = false;
      c.delta = clamp(inp.steer, -1, 1) * P.STEER_MAX * 0.6;
      return;
    }
    // surfaces under the left and right wheels
    const phi = c.a - T.hd[Q.idx];
    const lat = 0.8 * Math.cos(phi);
    const sL = F1.surfaceAt(T, Q.idx, Q.d - lat), sR = F1.surfaceAt(T, Q.idx, Q.d + lat);
    const A = SURFS[sL], B = SURFS[sR];
    const grip = (A.grip + B.grip) * 0.5;
    const traction = (A.traction + B.traction) * 0.5;
    const roll = (A.roll + B.roll) * 0.5, drag2 = (A.drag2 + B.drag2) * 0.5;
    const sl2 = sL === 4 ? 0 : sL, sr2 = sR === 4 ? 0 : sR;
    c.surf = sl2 > sr2 ? sl2 : sr2;       // pit lane counts as asphalt for effects
    c.inPit = sL === 4 || sR === 4;

    let thr = clamp(inp.throttle || 0, 0, 1);
    const brk = clamp(inp.brake || 0, 0, 1);
    c.lockFx = !!inp.lock && brk > 0.05 && sp > 8;   // locked front tyres (smoke)
    if (inp.drs && c.drsAllowed) c.drsOpen = true;
    if (!c.drsAllowed || brk > 0.05) c.drsOpen = false;

    const ca = Math.cos(c.a), sa = Math.sin(c.a);
    let vf = c.vx * ca + c.vy * sa;
    let vl = -c.vx * sa + c.vy * ca;
    const latRef = Math.min(P.LAT_MAX, P.LAT0 + P.LAT_K * sp * sp);
    let latAvail = latRef * grip;
    if (c.dirty < 1) latAvail *= c.dirty;          // dirty air behind another car
    if (brk > 0 && vf > 2) latAvail *= 1 - 0.28 * brk;
    const vfa = Math.abs(vf);

    // steering is a proportion of the grip-limited angle, so keyboard steering works at any speed
    const steer = clamp(inp.steer || 0, -1.8, 1.8);
    const maxDelta = Math.min(P.STEER_MAX, Math.atan(CAR.WB * latRef / Math.max(vfa * vfa, 1)) * 1.05);
    const delta = clamp(steer * maxDelta, -P.STEER_MAX, P.STEER_MAX);
    c.delta = delta;

    // yaw: follow the steering (kinematic bicycle) limited by grip; lose authority when sliding
    let wT = (vf * Math.tan(delta)) / CAR.WB;
    const wCap = (latAvail * 1.08) / Math.max(vfa, 1.5);
    if (wT > wCap) wT = wCap; else if (wT < -wCap) wT = -wCap;
    const beta = Math.atan2(Math.abs(vl), Math.max(vfa, 1));
    const werr = Math.abs(wT - c.w);
    if (!c.slide) { if (sp > 6 && (beta > 0.34 || werr > 1.9)) c.slide = true; }
    else if (sp < 3 || (beta < 0.12 && werr < 0.4)) c.slide = false;
    const auth = (c.slide ? 3.4 : 18) * (0.4 + 0.6 * grip) * Math.min(1, 0.2 + sp / 20);
    const dw = wT - c.w, lim = auth * dt;
    c.w += dw > lim ? lim : dw < -lim ? -lim : dw;
    c.a += c.w * dt;
    if (c.a > Math.PI) c.a -= 2 * Math.PI; else if (c.a < -Math.PI) c.a += 2 * Math.PI;

    const ca2 = Math.cos(c.a), sa2 = Math.sin(c.a);
    vf = c.vx * ca2 + c.vy * sa2;
    vl = -c.vx * sa2 + c.vy * ca2;

    // longitudinal
    const drag = P.DRAG * (c.drsOpen ? P.DRS_DRAG : 1);
    const aero = (drag * vf * Math.abs(vf)) / CAR.MASS;
    if (c.inPit && vf > PIT_LIMIT - 0.4) thr = 0;   // pit limiter
    if (vf > 0.4) {
      let acc = 0;
      if (c.inPit && vf > PIT_LIMIT + 0.4) acc -= Math.min(12, (vf - PIT_LIMIT) * 3);
      if (thr > 0) {
        const tr = Math.min(P.TRACT_MAX, P.TRACT0 + P.TRACT_K * sp * sp) * traction;
        acc += thr * Math.min(P.POWER / (CAR.MASS * Math.max(vf, 4)), tr);
      } else acc -= P.ENGINE_BRAKE;
      if (brk > 0) acc -= brk * Math.min(P.BRAKE_MAX, P.BRAKE0 + P.BRAKE_K * sp * sp) * (0.35 + 0.65 * grip);
      acc -= aero + P.ROLL;
      vf += acc * dt;
      if (vf < 0) vf = 0;
    } else if (vf < -0.4) {
      let acc = 0;
      if (thr > 0) acc += 14 * thr;
      else if (brk > 0) acc -= vf > -P.REV_MAX ? brk * P.REV_ACC : 0;
      else acc += 2.5;
      acc -= aero - P.ROLL;
      vf += acc * dt;
      if (thr === 0 && brk === 0 && vf > 0) vf = 0;
    } else {
      if (thr > 0) vf += thr * P.TRACT0 * traction * dt;
      else if (brk > 0) vf -= brk * P.REV_ACC * dt;
      else vf *= 0.9;
    }

    // lateral tyre grip
    const latCap = latAvail * (c.slide ? 0.8 : 1) * dt;
    if (vl > latCap) vl -= latCap; else if (vl < -latCap) vl += latCap; else vl = 0;

    c.vx = vf * ca2 - vl * sa2;
    c.vy = vf * sa2 + vl * ca2;

    // grass / gravel resistance
    const extra = roll + drag2 * sp * sp;
    if (extra > 0) {
      const s2 = Math.hypot(c.vx, c.vy);
      if (s2 > 0.01) { const f = Math.max(0, 1 - (extra * dt) / s2); c.vx *= f; c.vy *= f; }
    }
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    wallCollide(c, T);
  };

  function scrub(c) {
    const ca = Math.cos(c.a), sa = Math.sin(c.a);
    const vf = c.vx * ca + c.vy * sa, vl = (-c.vx * sa + c.vy * ca) * 0.86;
    c.vx = vf * ca - vl * sa; c.vy = vf * sa + vl * ca;
  }

  /* Car-to-car contact: oriented boxes, separating-axis test, impulse at the deepest point.
     applyB=false only moves A (used for client-side prediction). */
  F1.lastContact = { x: 0, y: 0 };
  const AX = [[0, 0], [0, 0], [0, 0], [0, 0]];
  F1.collideCars = function (A, B, applyB) {
    const dx = B.x - A.x, dy = B.y - A.y;
    if (dx * dx + dy * dy > 33) return 0;
    const ca = Math.cos(A.a), sa = Math.sin(A.a), cb = Math.cos(B.a), sb = Math.sin(B.a);
    AX[0][0] = ca; AX[0][1] = sa; AX[1][0] = -sa; AX[1][1] = ca;
    AX[2][0] = cb; AX[2][1] = sb; AX[3][0] = -sb; AX[3][1] = cb;
    let best = Infinity, bi = -1;
    for (let k = 0; k < 4; k++) {
      const ux = AX[k][0], uy = AX[k][1];
      const rA = CAR.HL * Math.abs(ca * ux + sa * uy) + CAR.HW * Math.abs(-sa * ux + ca * uy);
      const rB = CAR.HL * Math.abs(cb * ux + sb * uy) + CAR.HW * Math.abs(-sb * ux + cb * uy);
      const ov = rA + rB - Math.abs(dx * ux + dy * uy);
      if (ov <= 0) return 0;
      if (ov < best) { best = ov; bi = k; }
    }
    let nx = AX[bi][0], ny = AX[bi][1];
    if (dx * nx + dy * ny > 0) { nx = -nx; ny = -ny; }   // n points from B towards A
    // Contact point: clip the incident box's nearest edge against the reference face (proper manifold).
    const Rb = bi < 2 ? A : B, Ib = bi < 2 ? B : A;
    const rc = bi < 2 ? ca : cb, rs = bi < 2 ? sa : sb, ic = bi < 2 ? cb : ca, is = bi < 2 ? sb : sa;
    const nri = bi < 2 ? -1 : 1;                         // direction from reference towards incident = nri * n
    const ux = nri * nx, uy = nri * ny;
    const longFace = (bi % 2) === 0;
    const tx = longFace ? -rs : rc, ty = longFace ? rc : rs;   // tangent along the reference face
    const ext = longFace ? CAR.HW : CAR.HL, faceOff = longFace ? CAR.HL : CAR.HW;
    let p1x = 0, p1y = 0, p2x = 0, p2y = 0, d1 = Infinity, d2 = Infinity;
    for (let k = 0; k < 4; k++) {
      const fx = k < 2 ? 1 : -1, fy = (k & 1) ? 1 : -1;
      const px = Ib.x + ic * CAR.HL * fx - is * CAR.HW * fy;
      const py = Ib.y + is * CAR.HL * fx + ic * CAR.HW * fy;
      const pr = (px - Rb.x) * ux + (py - Rb.y) * uy;
      if (pr < d1) { d2 = d1; p2x = p1x; p2y = p1y; d1 = pr; p1x = px; p1y = py; }
      else if (pr < d2) { d2 = pr; p2x = px; p2y = py; }
    }
    let u1 = (p1x - Rb.x) * tx + (p1y - Rb.y) * ty, u2 = (p2x - Rb.x) * tx + (p2y - Rb.y) * ty;
    let q1x = p1x, q1y = p1y, q2x = p2x, q2y = p2y;
    if (Math.abs(u2 - u1) > 1e-6) {
      const clipT = function (u) { return (u - u1) / (u2 - u1); };
      let ta = clipT(-ext), tb = clipT(ext);
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
      ta = Math.max(0, ta); tb = Math.min(1, tb);
      if (ta <= tb) {
        q1x = p1x + (p2x - p1x) * ta; q1y = p1y + (p2y - p1y) * ta;
        q2x = p1x + (p2x - p1x) * tb; q2y = p1y + (p2y - p1y) * tb;
      }
    }
    // weight the two clipped points by how deep they are
    const w1 = Math.max(0, faceOff - ((q1x - Rb.x) * ux + (q1y - Rb.y) * uy)) + 1e-4;
    const w2 = Math.max(0, faceOff - ((q2x - Rb.x) * ux + (q2y - Rb.y) * uy)) + 1e-4;
    const cx = (q1x * w1 + q2x * w2) / (w1 + w2), cy = (q1y * w1 + q2y * w2) / (w1 + w2);
    // nearly inelastic (carbon and tyres don't bounce), modest rubbing friction, gentle separation
    const j = F1.contactImpulse(A, B, cx, cy, nx, ny, 0.06, 0.18, applyB);
    // Separate overlapping cars gently: the impulse handles the motion and each car's tyres decide
    // how far it gets pushed, so a car can't simply be bulldozed sideways off the track.
    const corr = Math.min(0.06, Math.max(0, best - 0.02) * 0.3);
    A.x += nx * corr; A.y += ny * corr;
    if (applyB) { B.x -= nx * corr; B.y -= ny * corr; }
    // tyres scrub while the cars lean on each other: sideways sliding dies away instead of drifting on
    scrub(A);
    if (applyB) scrub(B);
    F1.lastContact.x = cx; F1.lastContact.y = cy;
    return j > 0 ? j : 1;
  };

  F1.isWrongWay = function (c, T) {
    const i = c.seg < 0 ? 0 : c.seg;
    return c.vx * T.tx[i] + c.vy * T.ty[i] < -4;
  };

  // ---------------------------------------------------------------- AI
  // mistake  = chance per car per lap of a driving error: locking up, running wide, snapping sideways on
  //            the exit or hitting a kerb too hard (more likely with a car right behind, or in dirty air)
  // divebomb = chance that an overtake into a corner is braked for too late
  // gap      = following distance in seconds when stuck behind someone
  const AI_LEVELS = (F1.AI_LEVELS = {
    easy: { lat: 0.8, brake: 0.72, pace: 0.965, mistake: 0.34, divebomb: 0.05, gap: 0.2 },
    medium: { lat: 0.88, brake: 0.84, pace: 0.985, mistake: 0.18, divebomb: 0.025, gap: 0.16 },
    hard: { lat: 0.95, brake: 0.93, pace: 1.0, mistake: 0.1, divebomb: 0.015, gap: 0.13 }
  });
  const LIMIT = { lat: 1, brake: 1 };   // what the car can really do (used when an AI overdoes it)
  const MK_MIX = [0.3, 0.55, 0.78];     // share of lock-ups / running wide / snaps (the rest: kerb strikes)

  F1.speedProfile = function (T, level) {
    T._prof = T._prof || {};
    if (T._prof[level]) return T._prof[level];
    const Lv = level === 'limit' ? LIMIT : AI_LEVELS[level] || AI_LEVELS.medium;
    const N = T.n, K = T.rlK, ds = T.ds;
    const v = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const k = Math.abs(K[i]), m = Lv.lat;
      let vmax = 105;
      if (k > P.LAT_K * m) vmax = Math.min(vmax, Math.sqrt((P.LAT0 * m) / (k - P.LAT_K * m)));
      vmax = Math.min(vmax, Math.sqrt((P.LAT_MAX * m) / Math.max(k, 1e-6)));
      v[i] = vmax;
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let k = N - 1; k >= 0; k--) {
        const i = k, nI = (i + 1) % N, vn = v[nI];
        const dec = Math.min(P.BRAKE_MAX, P.BRAKE0 + P.BRAKE_K * vn * vn) * Lv.brake + (P.DRAG * vn * vn) / CAR.MASS;
        const limv = Math.sqrt(vn * vn + 2 * dec * ds);
        if (limv < v[i]) v[i] = limv;
      }
    }
    T._prof[level] = v;
    return v;
  };

  /* Braking zones: where the AI starts braking for a real corner (speed drops by more than 12 m/s),
     with the slowest point (apex) and the direction of the corner (+1 right, -1 left). */
  F1.brakeZones = function (T, level) {
    T._bz = T._bz || {};
    if (T._bz[level]) return T._bz[level];
    const v = F1.speedProfile(T, level), N = T.n, out = [];
    for (let i = 0; i < N; i++) {
      const a = v[(i - 1 + N) % N], b = v[i], c = v[(i + 1) % N];
      if (!(b >= a && b > c + 0.05)) continue;          // local peak: braking starts here
      let minV = b, minK = 0;
      for (let k = 1; k < 140; k++) { const j = (i + k) % N; if (v[j] < minV) { minV = v[j]; minK = k; } }
      if (b - minV < 12) continue;
      // middle of the slowest stretch = apex
      let k1 = minK;
      while (k1 < minK + 60 && v[(i + k1 + 1) % N] < minV + 0.6) k1++;
      const apexI = (i + Math.round((minK + k1) / 2)) % N;
      out.push({ s: i * T.ds, apex: apexI * T.ds, turn: T.curv[apexI] >= 0 ? 1 : -1, vMin: minV });
    }
    T._bz[level] = out;
    return out;
  };

  F1.refLapTime = function (T) {
    if (T._refLap) return T._refLap;
    const prof = F1.speedProfile(T, 'medium');
    let v = 20, t = 0;
    for (let lap = 0; lap < 2; lap++) {
      t = 0;
      for (let i = 0; i < T.n; i++) {
        const acc = Math.min(P.POWER / (CAR.MASS * Math.max(v, 4)), P.TRACT0) - (P.DRAG * v * v) / CAR.MASS;
        let vn = Math.sqrt(Math.max(1, v * v + 2 * acc * T.ds));
        if (vn > prof[i]) vn = prof[i];
        t += T.ds / ((v + vn) / 2);
        v = vn;
      }
    }
    T._refLap = t;
    return t;
  };

  function wrapD(d, L) { return d < -L / 2 ? d + L : d > L / 2 ? d - L : d; }

  /* Dirty air: following closely through a corner costs grip (up to 7%). Same for players and AI. */
  const DIRTY = 0.07;
  F1.dirtyAir = function (c, cars, L) {
    if (c.vx * c.vx + c.vy * c.vy < 900) return 1;    // only matters above ~110 km/h
    let f = 1;
    for (let q = 0; q < cars.length; q++) {
      const o = cars[q];
      if (o === c || o.out) continue;
      const dS = wrapD(o.s - c.s, L);
      if (dS < 4 || dS > 30.4) continue;
      const dD = o.d - c.d;
      if (dD > 2.2 || dD < -2.2) continue;
      const g = 1 - DIRTY * Math.min(1, (30.4 - dS) / 25);
      if (g < f) f = g;
    }
    return f;
  };

  /* How far a car reaches sideways across the track (more when it is at an angle to the track). */
  function halfWidthOnTrack(c, T) {
    const phi = c.a - T.hd[c.seg];
    return CAR.HW * Math.abs(Math.cos(phi)) + CAR.HL * Math.min(0.6, Math.abs(Math.sin(phi)));
  }

  /* Distance along the track between two cars, measured where they actually are: on the inside of a
     tight corner the cars are much closer together than the centre line suggests. */
  function realDS(T, c, o, dS) {
    const k = T.curv[F1.idxAt(T, c.s + dS * 0.5)];
    const f = 1 - k * (c.d + o.d) * 0.5;
    return dS * (f < 0.4 ? 0.4 : f > 1.6 ? 1.6 : f);
  }

  /* Is the line `lat` free of other cars from `from` to `to` metres ahead of car c? */
  function laneClear(S, c, lat, skipId, from, to) {
    const cars = S.cars, L = S.track.length;
    for (let q = 0; q < cars.length; q++) {
      const o = cars[q];
      if (o === c || o.out || o.id === skipId) continue;
      const dS = realDS(S.track, c, o, wrapD(o.s - c.s, L));
      if (dS < from || dS > to) continue;
      if (Math.abs(o.d - lat) < 2.5) return false;
    }
    return true;
  }

  /* Fresh AI driver state for car c. */
  F1.newAI = function (c, lvl, rng) {
    return {
      inp: { throttle: 0, brake: 0, steer: 0, drs: false, reset: false, lock: false },
      bias: 0, stuck: 0, backward: 0, wait: 0,
      latT: c.d, gridLane: c.d, along: {}, pass: null, mk: null, lastMk: -99, dispT: -99,
      pace: lvl.pace * (1 - rng() * 0.012),
      react: 0.12 + rng() * 0.25
    };
  };

  F1.aiDrive = function (c, S) {
    const T = S.track, ai = c.ai, inp = ai.inp, L = T.length, now = S.time;
    inp.reset = false; inp.drs = false; inp.lock = false;
    if (S.phase === 'countdown' || c.locked) { inp.throttle = 0; inp.brake = 1; inp.steer = 0; return inp; }
    const lvl = AI_LEVELS[S.aiLevel] || AI_LEVELS.medium;
    const sp = Math.hypot(c.vx, c.vy);
    const prof = F1.speedProfile(T, S.aiLevel);
    const look = 8 + sp * 0.3;
    const i = F1.idxAt(T, c.s + look);
    const room = T.hw - 1.05;
    const cv = c.vx * T.tx[c.seg] + c.vy * T.ty[c.seg];      // speed along the track
    const zones = F1.brakeZones(T, S.aiLevel);
    const yellow = S.yellowAt(c.s);
    const race = S.type === 'race';
    const iv = F1.idxAt(T, c.s + sp * 0.12);
    const vFree = prof[iv] * ai.pace;

    // next corner: which side is the inside?
    let inside = 0, toCorner = Infinity;
    for (let z = 0; z < zones.length; z++) {
      const dz = F1.wrapS(zones[z].apex - c.s, L);
      if (dz < toCorner) { toCorner = dz; inside = zones[z].turn; }
    }

    // ---- traffic: who is alongside, who is ahead in our path, who is behind
    let lo = -99, hi = 99;                          // limits set by cars alongside (leave a car's width)
    let lead = null, leadGap = Infinity, leadV = 0, yieldV = Infinity;
    let chased = false, rejoinBlocked = false, carComing = false;
    const offTrack = c.dist > T.hw + 0.8;
    const myExt = halfWidthOnTrack(c, T);
    if (S.collisions) {
      const cars = S.cars;
      for (let q = 0; q < cars.length; q++) {
        const o = cars[q];
        if (o === c || o.out) continue;
        let dS = wrapD(o.s - c.s, L);
        if (dS < -130 || dS > 110) continue;
        const dD = o.d - c.d;
        if (dD > 9 || dD < -9) continue;
        dS = realDS(T, c, o, dS);
        const ov = o.vx * T.tx[o.seg] + o.vy * T.ty[o.seg];
        if (dS < 0) {
          if (dS > -30 && dD < 4 && dD > -4) chased = true;
          if (dS > -130 && ov > 20) carComing = true;
          if (offTrack && dS > -80 && ov - cv > 3) {
            const edge = (c.d > 0 ? 1 : -1) * (T.hw - 1.6);
            if (Math.abs(o.d - edge) < 3.6) rejoinBlocked = true;
          }
        }
        // side by side: never turn into a car that is alongside (cars at an angle need more room)
        const wasAlong = ai.along[o.id] !== undefined && ai.along[o.id] > now - 0.5;
        if ((dS > -5.2 || (wasAlong && dS > -8.5)) && dS < 7.5 && (dD > 0.5 || dD < -0.5)) {
          ai.along[o.id] = now;
          const sep = myExt + halfWidthOnTrack(o, T) + 0.6;
          if (dD > 0) { const lim = o.d - sep; if (lim < hi) hi = lim; }
          else { const lim = o.d + sep; if (lim > lo) lo = lim; }
          // too close and mostly behind it: back off and let it go (the car behind gives way)
          if (dS > 1 && Math.abs(dD) < sep - 0.2) { const yv = ov - 1.5; if (yv < yieldV) yieldV = yv; }
          continue;
        }
        if (dS <= 0) continue;
        // ahead: will we run into it on our current line?
        const gap = dS - CAR.length;
        const dNow = Math.abs(dD), dTgt = Math.abs(o.d - ai.latT);
        let inPath = dTgt < 2.4;
        if (!inPath && dNow < 2.4) {
          const tReach = gap > 0 ? gap / Math.max(0.5, cv - ov) : 0;
          inPath = tReach < (2.4 - dNow) / 3 + 0.25;
        }
        if (inPath && gap < leadGap) { lead = o; leadGap = gap; leadV = ov; }
      }
    }

    // ---- where on the track do we want to be?
    let want = T.rlOff[i];
    // lap 1: hold the grid lane until the first braking zone, then merge
    if (race && c.lapsDone === 0 && S.firstBrake !== null) {
      const w = clamp((S.firstBrake - 30 - c.raceDist) / 170, 0, 1);
      if (w > 0) want = want * (1 - w) + ai.gridLane * w;
    }
    // blue flag: move off the racing line and let the faster car through
    let blueNear = false;
    if (c.blue >= 0) {
      const o = S.byId[c.blue];
      if (o) { const dS = wrapD(o.s - c.s, L); if (dS < 0 && dS > -110) blueNear = true; }
    }
    if (blueNear && vFree > 55) want = (T.rlOff[i] > 0 ? -1 : 1) * (room - 0.8);

    // overtaking, or getting round a slow / stopped car
    let passing = false, urgent = false;
    if (ai.pass) {
      const o = S.byId[ai.pass.id];
      const dS = o && !o.out ? wrapD(o.s - c.s, L) : 999;
      if (dS < -9 || dS > 80 || now - ai.pass.t > 12 || (yellow && !ai.pass.urgent && dS > 7.5) || blueNear) ai.pass = null;
      else {
        const lane = clamp(o.d + ai.pass.side * 2.9, -room - 0.3, room + 0.3);
        if (Math.abs(lane - o.d) < 2.6 || !laneClear(S, c, lane, o.id, -6, Math.max(12, dS + 25))) ai.pass = null;
        else { want = lane; passing = true; urgent = ai.pass.urgent; }
      }
    }
    if (!ai.pass && lead && !blueNear) {
      const closing = cv - leadV;
      const slow = leadV < Math.max(8, cv * 0.6);
      if (leadGap < (slow ? 90 : 38) && (slow || (!yellow && (closing > 1 || (leadGap < 14 && vFree > leadV + 2))))) {
        let best = 0, bestScore = -Infinity;
        for (let side = -1; side <= 1; side += 2) {
          const lane = lead.d + side * 2.9;
          if (lane > room + 0.3 || lane < -room - 0.3 || lane < lo || lane > hi) continue;
          if (!laneClear(S, c, lane, lead.id, -6, leadGap + 30)) continue;
          let score = -Math.abs(lane - c.d) * 0.25;
          if (toCorner < 260 && side === inside) score += 1.5;
          if (score > bestScore) { bestScore = score; best = side; }
        }
        if (best) {
          ai.pass = { id: lead.id, side: best, t: now, urgent: slow };
          want = clamp(lead.d + best * 2.9, -room - 0.3, room + 0.3);
          passing = true; urgent = slow;
        }
      }
    }

    // ---- mistakes (armed at a braking zone, see below)
    let mkType = null, mkRel = 0, edge = room + 0.3;
    const mk = ai.mk;
    if (mk) {
      mkRel = F1.wrapS(c.s - mk.s, L);                  // metres since the braking point
      if (mkRel > mk.end || now > mk.until) ai.mk = null;
      else {
        mkType = mk.type;
        if (mkType === 'wide' && mkRel > mk.apexRel - 5) { want -= mk.turn * (3.5 + 5 * mk.sev); edge = T.hw + 4; }
        if (mkType === 'kerb' && mkRel > mk.apexRel - 35 && mkRel < mk.apexRel + 12) { want = mk.turn * (T.hw + 0.7); edge = T.hw + 1.3; }
        if (mkType === 'lockup' || mkType === 'dive') edge = T.hw + 4;
      }
    }

    // ---- steering: pure pursuit towards the chosen line
    const r = (urgent ? 6 : passing ? 3.4 : 2.6) * F1.DT;
    const db = want - T.rlOff[i] - ai.bias;
    ai.bias += db > r ? r : db < -r ? -r : db;
    let latT = T.rlOff[i] + ai.bias;
    if (lo > hi) lo = hi = (lo + hi) / 2;               // squeezed between two cars: hold the middle
    if (latT < lo) latT = lo; else if (latT > hi) latT = hi;
    // squeezed towards the edge by a car alongside: we get forced wide onto the kerb / grass
    if (lo > edge || hi < -edge) edge = Math.min(Math.max(lo, -hi), T.hw + 1.6);
    if (offTrack && rejoinBlocked) latT = c.d;          // wait at the edge until the cars have gone past
    latT = clamp(latT, -Math.max(edge, c.dist), Math.max(edge, c.dist));
    ai.latT = latT;
    const tx = T.x[i] + T.nx[i] * latT, ty = T.y[i] + T.ny[i] * latT;
    const ca = Math.cos(c.a), sa = Math.sin(c.a);
    const dx = tx - c.x, dy = ty - c.y;
    const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;
    const curv = (2 * ly) / Math.max(1, lx * lx + ly * ly);
    const vf = c.vx * ca + c.vy * sa, vfa = Math.abs(vf);
    const latRef = Math.min(P.LAT_MAX, P.LAT0 + P.LAT_K * sp * sp);
    const maxDelta = Math.min(P.STEER_MAX, Math.atan(CAR.WB * latRef / Math.max(vfa * vfa, 1)) * 1.05);
    let steer = Math.atan(CAR.WB * curv) / maxDelta;
    if (lx < 0) steer = ly > 0 ? 1 : -1;
    inp.steer = clamp(steer, -1, 1);

    // ---- speed
    let vt = vFree;
    if (c.dirty < 1 && vt < 80) vt *= Math.sqrt(c.dirty);            // lift a touch in dirty air
    const offLine = Math.abs(latT - T.rlOff[i]);
    if (offLine > 1.5 && vt < 70) vt *= 1 - Math.min(0.08, (offLine - 1.5) * 0.015);   // off line = less grip
    if (yellow) vt *= 0.92;                                            // yellow flag: lift
    if (blueNear) vt *= vFree > 55 ? 0.97 : 0.93;
    const lim = F1.speedProfile(T, 'limit')[iv];
    if (mkType === 'wide' && mkRel > mk.apexRel - 40 && mkRel < mk.apexRel + 40) vt = Math.max(vt, lim * (1.03 + 0.07 * mk.sev));
    if (lead) {   // keep a safe gap to the car in front: always able to slow to its speed in time
      const gd = 1.5 + Math.max(0, cv) * lvl.gap;
      const lv = Math.max(0, leadV);
      const b = 0.55 * Math.min(P.BRAKE_MAX, P.BRAKE0 + P.BRAKE_K * lv * lv);
      const vCap = leadGap > gd ? Math.sqrt(lv * lv + 2 * b * (leadGap - gd)) : lv - (gd - leadGap) * 0.8;
      if (vCap < vt) vt = Math.max(0, vCap);
    }
    const diving = mkType === 'dive';                  // committed to a lunge: no backing out
    if (yieldV < vt && !diving) vt = Math.max(0, yieldV);
    // can we actually make the turn towards our target at this speed? if not, slow down
    // (only when we are well away from where we want to be: on the line the speed plan already covers it)
    // (only after traffic has pushed us off our line; on a clean lap the speed plan already covers it)
    if (passing || lo > -98 || hi < 98 || Math.abs(ai.bias) > 1) ai.dispT = now;
    const kArc = Math.abs(curv), mArc = Math.min(1, lvl.lat + 0.08);
    const offTarget = Math.abs(c.d - T.rlOff[c.seg] - ai.bias);
    if (!diving && now - ai.dispT < 2.5 && offTarget > 1.5 && kArc > P.LAT_K * mArc) {
      const vArc = Math.sqrt((P.LAT0 * mArc) / (kArc - P.LAT_K * mArc));
      if (vArc < vt) vt = vArc;
    }
    if (offTrack) { vt = Math.min(vt, 30); if (rejoinBlocked) vt = Math.min(vt, 12); }
    if (F1.DEBUG_AI) { ai.dbg = { lo: lo, hi: hi, want: want, latT: latT, vt: vt, vFree: vFree, lead: lead ? lead.id : -1, leadGap: leadGap, leadV: leadV, pass: ai.pass ? ai.pass.id + (ai.pass.side > 0 ? 'R' : 'L') : '', mk: mkType || '', yellow: yellow, blue: blueNear, chased: chased }; }
    if (sp > vt + 1.0) { inp.throttle = 0; inp.brake = Math.min(1, (sp - vt) / 5 + 0.3); }
    else if (sp > vt - 0.5) { inp.throttle = 0.35; inp.brake = 0; }
    else { inp.throttle = 1; inp.brake = 0; }

    // ---- mistakes in action
    if (mkType === 'lockup' && mkRel < mk.apexRel + 15 && (inp.brake > 0 || mk.locked)) {
      // fronts lock: the car barely slows and won't turn, so it slides on towards the outside
      mk.locked = true;
      inp.throttle = 0; inp.brake = 1; inp.lock = true;
      inp.steer *= 0.25;
      if (sp > 4) {
        const f = (P.BRAKE0 * (0.45 + 0.35 * (1 - mk.sev))) / Math.max(1, P.BRAKE0 + P.BRAKE_K * sp * sp);
        inp.brake = Math.min(1, f);
      }
      if (sp < mk.vMin * 0.85) mk.locked = false;
    }
    if (mkType === 'dive' && mkRel < mk.apexRel + 10 && sp > 4) {
      // divebomb: brakes far too late up the inside, still turning, and slides wide at the apex
      const f = (P.BRAKE0 * (0.75 + 0.35 * (1 - mk.sev))) / Math.max(1, P.BRAKE0 + P.BRAKE_K * sp * sp);
      if (inp.brake > f) inp.brake = f;
      if (inp.brake > 0) inp.lock = true;
    }
    if (mkType === 'snap' && mkRel > mk.apexRel + 4) {
      // too much throttle on the exit: the rear steps out
      if (!mk.kicked) { mk.kicked = true; mk.kickT = now; c.w += mk.turn * (0.9 + 1.9 * mk.sev); }
      if (now - mk.kickT < 0.6) { inp.throttle = 1; inp.brake = 0; }
    }
    if (mkType === 'kerb' && !mk.kicked && c.surf >= 1 && mkRel > mk.apexRel - 25) {
      // hits the sausage kerb: the car is thrown sideways and twitches
      mk.kicked = true;
      const ca2 = Math.cos(c.a), sa2 = Math.sin(c.a), push = -mk.turn * (1 + 3 * mk.sev);
      c.vx += -sa2 * push; c.vy += ca2 * push;
      c.w += (S.rng() < 0.5 ? mk.turn : -mk.turn) * (0.8 + 1.8 * mk.sev);
    }
    // one dice roll per braking zone
    if (ai.lastS !== undefined && !ai.mk && (now - ai.lastMk > 6 || F1.FORCE_MK)) {
      for (let z = 0; z < zones.length; z++) {
        const Z = zones[z];
        if (!passed(ai.lastS, c.s, Z.s, L)) continue;
        const attacking = ai.pass && !ai.pass.urgent && ai.pass.side === Z.turn && race;
        let p = attacking ? lvl.divebomb : lvl.mistake / zones.length;
        if (race && c.lapsDone === 0) p *= 0.6;                 // a bit more careful in the opening-lap pack
        else if (chased) p *= 1.5;                              // pressure from the car behind
        if (c.dirty < 0.99) p *= 1.4;                           // fighting dirty air
        if (F1.FORCE_MK || S.rng() < p) {
          const x = S.rng();
          const apexRel = F1.wrapS(Z.apex - Z.s, L);
          const type = F1.FORCE_MK || (attacking ? 'dive' : x < MK_MIX[0] ? 'lockup' : x < MK_MIX[1] ? 'wide' : x < MK_MIX[2] ? 'snap' : 'kerb');
          ai.mk = { type: type, s: Z.s, apexRel: apexRel, end: apexRel + 100, turn: Z.turn, vMin: Z.vMin, sev: S.rng(), until: now + 9, kicked: false, kickT: 0, locked: false };
          ai.lastMk = now;
        }
        break;
      }
    }
    ai.lastS = c.s;
    if (race && S.startTime !== null && now < S.startTime + ai.react) { inp.throttle = 0; inp.brake = 0; }
    inp.drs = c.drsAllowed;

    // ---- get unstuck (but wait for a gap if cars are coming)
    if (sp < 1.5) ai.stuck += F1.DT; else ai.stuck = 0;
    if (F1.isWrongWay(c, T) || (Math.abs(F1.wrapAngle(c.a - T.hd[c.seg])) > 2.2 && sp < 10)) ai.backward += F1.DT; else ai.backward = 0;
    if (ai.stuck > 3.0 || ai.backward > 2.5) {
      if (carComing && ai.wait < 6) ai.wait += F1.DT;
      else { inp.reset = true; ai.stuck = 0; ai.backward = 0; ai.wait = 0; }
    }
    return inp;
  };

  // ---------------------------------------------------------------- session
  function passed(ps, ns, x, L) {
    let d = ns - ps;
    if (d < -L / 2) d += L; else if (d > L / 2) d -= L;
    if (d <= 0 || d > 60) return false;
    let rel = x - ps;
    if (rel < 0) rel += L;
    return rel > 0 && rel <= d;
  }

  /* opts: {type:'practice'|'quali'|'race', track, entries:[{id, driverId, isAI, name}], laps, aiLevel, collisions, seed} */
  function Session(opts) {
    const T = opts.track;
    this.type = opts.type;
    this.track = T;
    this.laps = opts.laps || 0;
    this.aiLevel = AI_LEVELS[opts.aiLevel] ? opts.aiLevel : 'medium';
    this.collisions = opts.type === 'quali' ? false : opts.collisions !== false;
    this.rng = mulberry32(opts.seed || 1234567);
    this.tick = 0;
    this.time = 0;
    this.cars = [];
    this.byId = {};
    this.events = [];
    this.fx = [];
    this.phase = opts.type === 'practice' ? 'running' : 'countdown';
    this.lights = 0;
    this.startTime = opts.type === 'practice' ? 0 : null;
    this.lightsOutAt = opts.type === 'race' ? 5.5 + 0.4 + this.rng() * 2.0 : null;
    this.leaderFinishTime = null;
    this.lastHumanFinish = null;
    this.humansDoneAt = null;
    this.finishCount = 0;
    this.finalLapAnnounced = false;
    this.fastest = null;
    this.loopFirst = [];
    this.detLast = T.drs.map(function () { return null; });
    this.results = null;
    this.yellow = [];                     // yellow flag zones: {id, s, until}
    // first braking zone after the start line (AI hold their grid lanes until then on lap 1)
    const bz = F1.brakeZones(T, this.aiLevel).filter(function (z) { return z.s > 30; });
    this.firstBrake = bz.length ? bz[0].s : null;
    const ref = F1.refLapTime(T);
    this.refLap = ref;
    // practice with a lap limit (Grand Prix P1-P3) works like qualifying: N timed laps after an out lap
    this.timeLimit = opts.type === 'quali' || (opts.type === 'practice' && this.laps > 0) ? 3 + ref * 1.3 + this.laps * ref * 1.6 + 60
      : opts.type === 'race' ? 8 + this.laps * ref * 2.2 + 120 : Infinity;
    const self = this;
    const lvl = AI_LEVELS[this.aiLevel];
    opts.entries.forEach(function (e, k) {
      const c = F1.createCar(e.id !== undefined ? e.id : k, e.driverId, T, k, e.isAI);
      c.name = e.name || null;
      c.lineCount = 0; c.maxLine = 0; c.lapsDone = 0;
      c.lapStart = null; c.lastLap = null; c.bestLap = null; c.laps = [];
      c.finished = false; c.finishTime = null; c.finishPos = 0;
      c.raceDist = c.s - T.length; c.loopIdx = -1; c.gap = 0; c.pos = k + 1;
      c.qualiDone = false;
      c.drsElig = T.drs.map(function () { return opts.type !== 'race'; });
      c.input = F1.NEUTRAL;
      c.prevS = c.s;
      if (c.isAI) c.ai = F1.newAI(c, lvl, self.rng);
      self.cars.push(c);
      self.byId[c.id] = c;
    });
    if (opts.startMode === 'pit' && T.pit) this.placeForPitStart();
    this.updateOrder();
  }

  /* Practice: players start in front of their team's garage; AI cars are already out on track. */
  Session.prototype.placeForPitStart = function () {
    const T = this.track, L = T.length;
    const ais = this.cars.filter(function (c) { return c.isAI; });
    const prof = F1.speedProfile(T, this.aiLevel);
    const teamIdx = function (driverId) {
      const d = F1.driver(driverId);
      return F1.TEAMS.findIndex(function (t) { return t.id === d.team; });
    };
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      if (c.isAI) {
        const k = ais.indexOf(c);
        const s = F1.wrapS(L * (k + 1) / (ais.length + 1) + 260, L);
        const idx = F1.idxAt(T, s);
        const v = prof[idx] * 0.8;
        c.x = T.rlX[idx]; c.y = T.rlY[idx]; c.a = T.hd[idx];
        c.vx = Math.cos(c.a) * v; c.vy = Math.sin(c.a) * v;
      } else {
        const p = F1.pitSpot(T, teamIdx(c.driverId));
        c.x = p.x; c.y = p.y; c.a = p.h; c.vx = 0; c.vy = 0;
      }
      c.px = c.x; c.py = c.y; c.pa = c.a;
      F1.queryTrack(T, c.x, c.y, -1, Q);
      c.seg = Q.idx; c.s = Q.s; c.d = Q.d; c.dist = Q.dist; c.prevS = c.s;
      c.raceDist = c.s;
      if (c.ai) { c.ai.latT = c.d; c.ai.bias = c.d - T.rlOff[c.seg]; }
    }
  };

  Session.prototype.step = function (inputs) {
    const T = this.track, dt = F1.DT;
    this.tick++;
    this.time += dt;
    this.updatePhase();
    if (this.tick % 6 === 0) this.updateFlags();
    const cars = this.cars, L = T.length;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      c.px = c.x; c.py = c.y; c.pa = c.a; c.prevS = c.s;
      if (c.out) continue;
      c.dirty = this.collisions ? F1.dirtyAir(c, cars, L) : 1;
      c.locked = this.phase === 'countdown';
      if (c.isAI) c.input = F1.aiDrive(c, this);
      else if (inputs && inputs[c.id]) c.input = inputs[c.id];
      const z = T.drsZone[F1.idxAt(T, c.s)];
      c.drsAllowed = z >= 0 && c.drsElig[z] && this.phase !== 'countdown';
    }
    const sub = dt / F1.SUBSTEPS;
    const contactOn = this.collisions && this.phase !== 'countdown';
    for (let k = 0; k < F1.SUBSTEPS; k++) {
      for (let i = 0; i < cars.length; i++) if (!cars[i].out) F1.stepCar(cars[i], cars[i].input, T, sub);
      if (contactOn) this.resolveContacts();
    }
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (c.wallHit > 2500) this.fx.push([Math.round(c.x * 10) / 10, Math.round(c.y * 10) / 10, Math.round(c.wallHit)]);
      c.wallHit = 0;
      if (!c.out) this.updateProgress(c, dt);
    }
    this.updateOrder();
    this.checkEnd();
  };

  Session.prototype.resolveContacts = function () {
    const cars = this.cars;
    for (let i = 0; i < cars.length; i++) {
      const A = cars[i];
      if (A.out) continue;
      for (let j = i + 1; j < cars.length; j++) {
        const B = cars[j];
        if (B.out) continue;
        const dx = B.x - A.x, dy = B.y - A.y;
        if (dx * dx + dy * dy > 33) continue;
        const imp = F1.collideCars(A, B, true);
        if (imp > 1500) this.fx.push([Math.round(F1.lastContact.x * 10) / 10, Math.round(F1.lastContact.y * 10) / 10, Math.round(imp)]);
      }
    }
  };

  /* Yellow flags where a car has stopped, spun or is crawling off the track; blue flags for cars about
     to be lapped. Runs 10 times a second. */
  Session.prototype.updateFlags = function () {
    const T = this.track, L = T.length, now = this.time, cars = this.cars;
    if (this.phase === 'countdown') return;
    const started = this.type !== 'race' || (this.startTime !== null && now > this.startTime + 4);
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (c.out || c.inPit || !started) continue;
      const sp = Math.hypot(c.vx, c.vy);
      const ang = Math.abs(F1.wrapAngle(c.a - T.hd[c.seg]));
      if ((ang > 0.9 && sp < 35) || sp < 6 || (c.dist > T.hw + 2.5 && sp < 30)) {
        let z = null;
        for (let k = 0; k < this.yellow.length; k++) if (this.yellow[k].id === c.id) z = this.yellow[k];
        if (!z) { z = { id: c.id, s: c.s, until: 0 }; this.yellow.push(z); }
        z.s = c.s; z.until = now + 3;
      }
    }
    this.yellow = this.yellow.filter(function (z) { return z.until > now; });
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      c.blue = -1;
      if (this.type !== 'race' || c.out || c.finished || this.phase === 'countdown') continue;
      for (let j = 0; j < cars.length; j++) {
        const o = cars[j];
        if (o === c || o.out || o.raceDist - c.raceDist < L * 0.5) continue;
        const dS = wrapD(c.s - o.s, L);              // o is behind c on the road...
        if (dS > 0 && dS < 150) { c.blue = o.id; break; }   // ...but a lap ahead in the race
      }
    }
  };

  /* Is track position s inside a yellow flag zone (from 200 m before the incident to 50 m after)? */
  Session.prototype.yellowAt = function (s) {
    for (let k = 0; k < this.yellow.length; k++) {
      if (F1.wrapS(s - this.yellow[k].s + 200, this.track.length) < 250) return true;
    }
    return false;
  };

  Session.prototype.updatePhase = function () {
    if (this.phase !== 'countdown') return;
    const t = this.time;
    if (this.type === 'race') {
      this.lights = t >= 5.5 ? 5 : t >= 4.5 ? 4 : t >= 3.5 ? 3 : t >= 2.5 ? 2 : t >= 1.5 ? 1 : 0;
      if (t >= this.lightsOutAt) {
        this.phase = 'running';
        this.lights = 0;
        this.startTime = this.lightsOutAt;
        for (let i = 0; i < this.cars.length; i++) this.cars[i].lapStart = this.startTime;
        this.events.push({ k: 'lightsOut' });
      }
    } else if (this.type === 'quali' && t >= 3) {
      this.phase = 'running';
      this.startTime = 3;
      this.events.push({ k: 'go' });
    }
  };

  Session.prototype.updateProgress = function (c, dt) {
    const T = this.track, L = T.length;
    F1.queryTrack(T, c.x, c.y, c.seg, Q);
    c.seg = Q.idx; c.s = Q.s; c.d = Q.d; c.dist = Q.dist;
    const ps = c.prevS, ns = c.s;
    let crossed = 0, frac = 1;
    if (ps > L * 0.75 && ns < L * 0.25) { crossed = 1; frac = (L - ps) / Math.max(1e-6, L - ps + ns); }
    else if (ps < L * 0.25 && ns > L * 0.75) crossed = -1;
    if (crossed) {
      c.lineCount += crossed;
      if (crossed > 0 && c.lineCount > c.maxLine) {
        c.maxLine = c.lineCount;
        this.onLine(c, this.time - dt + frac * dt);
      }
    }
    for (let z = 0; z < T.drs.length; z++) if (passed(ps, ns, T.drs[z].detect, L)) this.onDetection(c, z);
    c.raceDist = (c.lineCount - 1) * L + c.s;
    if (this.type === 'race' && this.phase !== 'countdown' && c.raceDist >= 0 && !c.finished) {
      const li = Math.floor(c.raceDist / 50);
      if (li > c.loopIdx) {
        c.loopIdx = li;
        const f = this.loopFirst[li];
        if (f === undefined) { this.loopFirst[li] = this.time; c.gap = 0; } else c.gap = this.time - f;
      }
    }
  };

  Session.prototype.onLine = function (c, t) {
    if (this.type === 'race') {
      if (this.phase === 'countdown' || c.maxLine < 2) return;
      this.recordLap(c, t - c.lapStart);
      c.lapsDone = c.maxLine - 1;
      c.lapStart = t;
      if (!c.finished && (this.leaderFinishTime !== null || c.lapsDone >= this.laps)) this.finishCar(c, t);
      else if (!this.finalLapAnnounced && this.leaderFinishTime === null && c.lapsDone === this.laps - 1 && this.laps > 1) {
        this.finalLapAnnounced = true;
        this.events.push({ k: 'finalLap' });
      }
      return;
    }
    if (this.phase !== 'running' || c.qualiDone) return;
    if (c.inPit) { c.lapStart = null; return; }
    if (c.lapStart !== null) {
      this.recordLap(c, t - c.lapStart);
      c.lapsDone++;
      if ((this.type === 'quali' || this.laps > 0) && c.lapsDone >= this.laps) {
        c.qualiDone = true;
        c.lapStart = null;
        this.events.push({ k: 'qualiDone', id: c.id, p: this.type === 'practice' });
        if (!c.isAI && this.humansDoneAt === null && this.cars.every(function (o) { return o.isAI || o.out || o.qualiDone; })) this.humansDoneAt = this.time;
        return;
      }
    }
    c.lapStart = t;
  };

  Session.prototype.recordLap = function (c, lt) {
    c.lastLap = lt;
    c.laps.push(lt);
    const pb = c.bestLap === null || lt < c.bestLap;
    if (pb) c.bestLap = lt;
    const fastest = this.fastest === null || lt < this.fastest.time;
    if (fastest) this.fastest = { id: c.id, time: lt };
    this.events.push({ k: 'lap', id: c.id, t: lt, pb: pb, fastest: fastest, n: c.laps.length });
  };

  Session.prototype.finishCar = function (c, t) {
    c.finished = true;
    c.finishTime = t;
    c.finishPos = ++this.finishCount;
    if (this.leaderFinishTime === null) {
      this.leaderFinishTime = t;
      this.phase = 'finishing';
      this.events.push({ k: 'chequered', id: c.id });
    }
    if (!c.isAI) this.lastHumanFinish = t;
    this.events.push({ k: 'finish', id: c.id, pos: c.finishPos });
  };

  Session.prototype.onDetection = function (c, z) {
    if (this.type !== 'race') { c.drsElig[z] = true; return; }
    const prev = this.detLast[z];
    c.drsElig[z] = this.phase === 'running' && c.maxLine >= 2 && prev !== null && prev.id !== c.id && this.time - prev.t <= 1.0;
    this.detLast[z] = { id: c.id, t: this.time };
  };

  Session.prototype.updateOrder = function () {
    const arr = this.cars.slice();
    if (this.type === 'race') {
      arr.sort(function (a, b) {
        if (a.out !== b.out) return a.out ? 1 : -1;
        if (a.finished && b.finished) return a.finishPos - b.finishPos;
        if (a.finished !== b.finished) return a.finished ? -1 : 1;
        return b.raceDist - a.raceDist;
      });
    } else {
      arr.sort(function (a, b) {
        if (a.out !== b.out) return a.out ? 1 : -1;
        const ab = a.bestLap === null ? Infinity : a.bestLap, bb = b.bestLap === null ? Infinity : b.bestLap;
        if (ab !== bb) return ab - bb;
        return a.slot - b.slot;
      });
    }
    for (let i = 0; i < arr.length; i++) arr[i].pos = i + 1;
    this.order = arr.map(function (c) { return c.id; });
  };

  Session.prototype.checkEnd = function () {
    if (this.phase === 'done' || (this.type === 'practice' && !this.laps)) return;
    const active = this.cars.filter(function (c) { return !c.out; });
    const humans = active.filter(function (c) { return !c.isAI; });
    let end = false;
    if (this.type === 'quali' || this.type === 'practice') {
      if (this.phase === 'running') {
        if (this.type === 'quali' && active.every(function (c) { return c.qualiDone; })) end = true;
        // practice ends as soon as you have done your laps; qualifying waits up to 20 s for the AI
        if (this.humansDoneAt !== null && this.time - this.humansDoneAt > (this.type === 'practice' ? 2.5 : 20)) end = true;
      }
    } else if (this.leaderFinishTime !== null) {
      if (active.every(function (c) { return c.finished; })) end = true;
      else if (humans.length && humans.every(function (c) { return c.finished; }) && this.time - this.lastHumanFinish > 8) end = true;
      else if (this.time - this.leaderFinishTime > 75) end = true;
    }
    if (this.time > this.timeLimit) end = true;
    if (end) this.finish();
  };

  Session.prototype.finish = function () {
    if (this.phase === 'done') return;
    this.phase = 'done';
    this.updateOrder();
    this.results = this.buildResults();
    this.events.push({ k: 'end' });
  };

  Session.prototype.buildResults = function () {
    const self = this;
    const order = this.order.map(function (id) { return self.byId[id]; });
    if (this.type === 'race') {
      const w = order[0];
      return order.map(function (c, i) {
        let gap;
        if (c.out) gap = 'DNF';
        else if (i === 0) gap = w.finished ? F1.fmtLap(w.finishTime - self.startTime) : 'LEADER';
        else if (c.finished && c.lapsDone >= w.lapsDone) gap = '+' + (c.finishTime - w.finishTime).toFixed(3) + 's';
        else {
          // not yet across the line: still on the lead lap -> time gap from the timing loops
          const behind = (w.lapsDone || self.laps) - c.lapsDone - (c.finished ? 0 : 1);
          if (behind <= 0) gap = '+' + c.gap.toFixed(3) + 's';
          else gap = '+' + behind + (behind === 1 ? ' LAP' : ' LAPS');
        }
        const pts = c.out ? 0 : POINTS[i] || 0;
        return { pos: i + 1, id: c.id, driverId: c.driverId, isAI: c.isAI, name: c.name, laps: c.lapsDone, best: c.bestLap, gap: gap, out: c.out, pts: pts };
      });
    }
    const pole = order.length && order[0].bestLap !== null ? order[0].bestLap : null;
    return order.map(function (c, i) {
      let gap = '';
      if (c.out) gap = 'DNF';
      else if (c.bestLap === null) gap = 'NO TIME';
      else if (i === 0) gap = F1.fmtLap(c.bestLap);
      else gap = '+' + (c.bestLap - pole).toFixed(3) + 's';
      return { pos: i + 1, id: c.id, driverId: c.driverId, isAI: c.isAI, name: c.name, laps: c.lapsDone, best: c.bestLap, gap: gap, out: c.out };
    });
  };

  Session.prototype.retire = function (id) {
    const c = this.byId[id];
    if (!c || c.out) return;
    c.out = true;
    c.vx = 0; c.vy = 0; c.w = 0;
    this.updateOrder();
  };

  Session.prototype.drainEvents = function () {
    const e = this.events;
    this.events = [];
    return e;
  };
  Session.prototype.drainFx = function () {
    const f = this.fx;
    this.fx = [];
    return f;
  };

  F1.Session = Session;

  if (typeof module !== 'undefined' && module.exports) module.exports = F1;
})(typeof window !== 'undefined' ? window : globalThis);
