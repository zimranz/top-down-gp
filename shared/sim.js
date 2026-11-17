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
    { grip: 1.0, traction: 1.0, roll: 0, drag2: 0 },          // pit lane (80 km/h limiter)
    { grip: 0.8, traction: 0.82, roll: 0.7, drag2: 0.0012 }    // paved run-off on street circuits (dusty, less grip)
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
      resetCd: 0, wallHit: 0, out: false, dirty: 1, lockFx: false,
      px: g.x, py: g.y, pa: g.h
    };
    F1.queryTrack(T, c.x, c.y, -1, Q);
    c.seg = Q.idx; c.s = Q.s; c.d = Q.d; c.dist = Q.dist;
    return c;
  };

  F1.resetCar = function (c, T) {
    F1.queryTrack(T, c.x, c.y, c.seg, Q);
    const hwE = T.hwE ? T.hwE[Q.idx] : T.hw;
    const p = F1.trackPoint(T, Q.s, clamp(Q.d, -hwE + 2, hwE - 2));
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
    const tg = c.tg || 1;                     // the tyres: compound, wear (and a wet track)
    const grip = (A.grip + B.grip) * 0.5 * tg;
    const traction = (A.traction + B.traction) * 0.5 * tg;
    const roll = (A.roll + B.roll) * 0.5, drag2 = (A.drag2 + B.drag2) * 0.5;
    const sl2 = sL === 4 ? 0 : sL, sr2 = sR === 4 ? 0 : sR;
    c.surf = sl2 > sr2 ? sl2 : sr2;       // pit lane counts as asphalt for effects
    // in the pit lane: a wheel on the pit road and the car's middle past the edge of the track (just clipping
    // the start of the pit entry or the end of the exit, on the racing line, is not going into the pits)
    c.inPit = (sL === 4 || sR === 4) && Q.d * T.pit.side > T.hw;

    let thr = clamp(inp.throttle || 0, 0, 1);
    const brk = clamp(inp.brake || 0, 0, 1);
    c.lockFx = !!inp.lock && brk > 0.05 && sp > 8;   // locked front tyres (smoke)
    if (inp.drs && c.drsAllowed) c.drsOpen = true;
    if (!c.drsAllowed || brk > 0.05) c.drsOpen = false;

    const ca = Math.cos(c.a), sa = Math.sin(c.a);
    let vf = c.vx * ca + c.vy * sa;
    let vl = -c.vx * sa + c.vy * ca;
    let latRef = Math.min(P.LAT_MAX, P.LAT0 + P.LAT_K * sp * sp);
    if (T.bank) latRef *= T.bank[Q.idx];           // a banked corner: more grip
    let latAvail = latRef * grip;
    if (c.dirty < 1) latAvail *= c.dirty;          // dirty air behind another car
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
    const drag = P.DRAG * (c.drsOpen ? P.DRS_DRAG : 1) * (c.tow || 1);     // slipstream: less air to push through
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

    // how hard the tyres are working (cornering and braking against what they can do): for tyre wear
    c.load = Math.min(1, Math.abs(vf * c.w) / Math.max(4, latAvail) + 0.35 * brk);
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
  // spread   = how much the drivers' pace differs (up to this much slower); slowStart = chance of a slow getaway
  // attack   = 0..1: goes for a pass from further back / with less of a speed advantage
  // defend   = 0..1: with a car close behind on the way into a braking zone, makes one early move to cover the inside
  const AI_LEVELS = (F1.AI_LEVELS = {
    easy: { lat: 0.8, brake: 0.72, pace: 0.965, mistake: 0.34, divebomb: 0.05, gap: 0.2, react: [0.2, 0.55] },
    medium: { lat: 0.88, brake: 0.84, pace: 0.985, mistake: 0.18, divebomb: 0.025, gap: 0.16, react: [0.15, 0.4] },
    hard: { lat: 0.95, brake: 0.93, pace: 1.0, mistake: 0.1, divebomb: 0.015, gap: 0.13, react: [0.1, 0.28] },
    extrahard: { lat: 0.975, brake: 0.965, pace: 1.0, spread: 0.008, mistake: 0.05, divebomb: 0.008, gap: 0.12, react: [0.07, 0.2], slowStart: 0.05, attack: 0.5, defend: 0.5 },
    expert: { lat: 1.0, brake: 1.0, pace: 1.0, spread: 0.004, mistake: 0.015, divebomb: 0.004, gap: 0.11, react: [0.05, 0.15], slowStart: 0.03, attack: 1, defend: 1 }
  });
  F1.AI_LEVEL_IDS = ['easy', 'medium', 'hard', 'extrahard', 'expert'];
  F1.isAILevel = function (v) { return typeof v === 'string' && F1.AI_LEVEL_IDS.indexOf(v) >= 0; };
  const LIMIT = { lat: 1, brake: 1 };   // what the car can really do (used when an AI overdoes it)
  const MK_MIX = [0.3, 0.55, 0.78];     // share of lock-ups / running wide / snaps (the rest: kerb strikes)

  /* The AI's target speed all round the lap (the racing line). g: grip from the tyres (1 = new softs, dry), rounded
     to 1% steps (a profile is kept for each). */
  F1.speedProfile = function (T, level, g) {
    T._prof = T._prof || {};
    const gq = g === undefined || g >= 0.995 ? 1 : Math.max(0.5, Math.round(g * 100) / 100);
    const key = gq === 1 ? level : level + '@' + gq;
    if (T._prof[key]) return T._prof[key];
    const L0 = level === 'limit' ? LIMIT : AI_LEVELS[level] || AI_LEVELS.medium;
    const Lv = gq === 1 ? L0 : { lat: L0.lat * gq, brake: L0.brake * (0.35 + 0.65 * gq) };
    const N = T.n, K = T.rlK, ds = T.ds, BK = T.bank;
    const v = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      // banked corners can be taken faster (the AI uses a little over half of the extra grip, to keep a margin)
      const k = Math.abs(K[i]), m = BK ? Lv.lat * (1 + (BK[i] - 1) * 0.55) : Lv.lat;
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
    T._prof[key] = v;
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
      out.push({ s: i * T.ds, apex: apexI * T.ds, turn: T.curv[apexI] >= 0 ? 1 : -1, vMin: minV, drop: b - minV });
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
      if (o === c || o.out || o.gar) continue;
      const dS = wrapD(o.s - c.s, L);
      if (dS < 4 || dS > 30.4) continue;
      if (o.vx * o.vx + o.vy * o.vy < 9) continue;       // a stopped car leaves no wake
      const dD = o.d - c.d;
      if (dD > 2.2 || dD < -2.2) continue;
      const g = 1 - DIRTY * Math.min(1, (30.4 - dS) / 25);
      if (g < f) f = g;
    }
    return f;
  };

  /* Slipstream (drafting): right behind another car there is less air to push through, so up to 10% less drag:
     a few km/h more by the end of a straight. Full within 15 m, gone at 50 m; you have to be in line with the car
     ahead. Only matters at speed (in corners grip decides the speed, not drag). Same for players and AI.
     Returns the drag factor (1 = no slipstream). */
  const TOW = 0.10;
  F1.slipstream = function (c, cars, L) {
    if (c.vx * c.vx + c.vy * c.vy < 900) return 1;    // only matters above ~110 km/h
    let f = 1;
    for (let q = 0; q < cars.length; q++) {
      const o = cars[q];
      if (o === c || o.out || o.gar || o.inPit) continue;
      const dS = wrapD(o.s - c.s, L);
      if (dS < 5 || dS > 50) continue;
      if (o.vx * o.vx + o.vy * o.vy < 900) continue;     // a slow car punches no useful hole in the air
      const dD = Math.abs(o.d - c.d);
      if (dD > 2.6) continue;
      const g = 1 - TOW * Math.min(1, (50 - dS) / 35) * (dD < 1 ? 1 : (2.6 - dD) / 1.6);
      if (g < f) f = g;
    }
    return f;
  };

  // ---------------------------------------------------------------- tyres
  /* Soft, medium and hard for the dry; intermediate (green) and full wet (blue) for the rain.
     grip: a new tyre on a dry track (the soft is the car as it always was; 1% of grip is about 0.4 s a lap, so the
     medium is about 0.4 s a lap slower and the hard about 0.8 s). life: laps on a normal racing lap until the tyre is
     worn out (wear 1.0), after which it falls off a cliff. */
  const TYRES = (F1.TYRES = {
    S: { name: 'Soft', col: '#ff3b30', grip: 1.0, life: 6 },
    M: { name: 'Medium', col: '#ffd60a', grip: 0.99, life: 10 },
    H: { name: 'Hard', col: '#f4f4f4', grip: 0.98, life: 14 },
    I: { name: 'Intermediate', col: '#19c94a', grip: 0.93, life: 9 },
    W: { name: 'Wet', col: '#2f8bff', grip: 0.9, life: 12 }
  });
  const TYRE_KEYS = (F1.TYRE_KEYS = ['S', 'M', 'H', 'I', 'W']);
  const SLICK = { S: true, M: true, H: true };
  F1.isSlick = function (k) { return !!SLICK[k]; };
  /* Grip left as a tyre wears: a slow fade to 75% worn (-2.5%), then the cliff (-7% when worn out, much worse after). */
  function wearGrip(w) {
    if (w <= 0.75) return 1 - 0.025 * (w / 0.75);
    if (w <= 1) { const x = (w - 0.75) / 0.25; return 0.975 - 0.045 * x * x; }
    return 0.93 - 0.17 * Math.min(1, (w - 1) / 0.35);
  }
  /* A wet track (0 dry .. 1 pouring): slicks lose grip fast; intermediates are best when it is damp, full wets when it
     pours; on a dry track the rain tyres are slow. */
  function wetGrip(k, wet) {
    if (SLICK[k]) return wet <= 0 ? 1 : 1 - 0.5 * Math.pow(wet, 0.8);
    if (k === 'I') return wet < 0.5 ? 1 - 0.06 * wet : 0.97 - 0.24 * (wet - 0.5);
    return 0.97 + 0.03 * Math.min(1, wet / 0.6) - (wet > 0.6 ? 0.05 * (wet - 0.6) : 0);
  }
  /* How fast a tyre wears in these conditions (x normal): rain tyres on a drying track overheat and wear out fast. */
  function wetWear(k, wet) {
    if (SLICK[k]) return 1 - 0.5 * Math.min(1, wet);
    if (k === 'I') return wet < 0.15 ? 1 + 2 * (0.15 - wet) / 0.15 : 1;
    return wet < 0.4 ? 1 + 3 * (0.4 - wet) / 0.4 : 1;
  }
  /* Grip from the tyres (1 = a new soft on a dry track). wear 0 (new) .. 1 (worn out); wet 0 .. 1. */
  F1.tyreGrip = function (k, wear, wet) {
    const t = TYRES[k] || TYRES.S;
    return t.grip * wearGrip(wear > 0 ? wear : 0) * wetGrip(k, wet > 0 ? wet : 0);
  };
  /* The best tyre for a track this wet. */
  F1.wetTyre = function (wet) { return wet < 0.1 ? null : wet < 0.52 ? 'I' : 'W'; };
  const WEAR_K = 1.35;                         // (calibrated: a normal AI racing lap wears 1 / life)
  /* Wear for one step: by distance (so a tyre lasts the same number of laps on a long or a short track) and by how
     hard the car is working it: cornering and braking at the limit, sliding and locking up wear it faster. */
  function tyreWear(c, L, dt, wet) {
    const t = TYRES[c.tyre.c] || TYRES.S, sp = Math.hypot(c.vx, c.vy);
    if (sp < 0.5) return;
    let k = 0.55 + 0.75 * (c.load || 0);
    if (c.slide) k *= 2.2;
    if (c.lockFx) k *= 2.5;
    c.tyre.w += (sp * dt) / (t.life * L) * WEAR_K * k * wetWear(c.tyre.c, wet);
  }
  /* Seconds a lap lost for a grip factor g (from the speed-profile calibration: 1% of grip = 0.43% of the lap). */
  function lapLoss(T, g) { return 0.43 * (1 - g) * F1.refLapTime(T); }
  /* Time lost by a pit stop: the pit lane at the speed limit instead of the track, the stop itself, slowing and
     speeding up again. */
  F1.pitLoss = function (T) {
    if (T._pitLoss !== undefined) return T._pitLoss;
    const pi = F1.pitInfo(T);
    if (!pi) return (T._pitLoss = 20);
    const prof = F1.speedProfile(T, 'medium');
    let tTrack = 0;
    for (let u = 0; u < pi.total; u += T.ds) tTrack += T.ds / Math.max(10, prof[F1.idxAt(T, T.pit.s0 + u)]);
    const tLane = pi.total / (PIT_LIMIT - 0.8) + 2.6 + 2.5;
    return (T._pitLoss = Math.max(8, tLane - tTrack));
  };
  /* Race strategy (tyre wear on): which tyres to start on and on which laps to stop. Every plan with no stop (when
     allowed), one stop, or two in longer races is costed: the tyres' pace, the wear (worse near the end of a tyre's
     life) and the time lost in the pit lane. rng: picks one of the plans close to the best (or null = the best),
     so not every car does the same. Returns { start, stops: [{ lap, c }] }: "lap" = come in at the end of that lap. */
  F1.planStrategy = function (T, laps, mustStop, rng) {
    const loss = F1.pitLoss(T), dry = ['S', 'M', 'H'];
    const stint = {};                       // stint[k][n]: seconds lost over n laps on a new set of k (vs a new soft)
    for (let a = 0; a < 3; a++) {
      const k = dry[a], t = TYRES[k], arr = [0];
      let sum = 0;
      for (let n = 1; n <= laps; n++) {
        const w = (n - 0.5) / t.life;
        sum += lapLoss(T, F1.tyreGrip(k, w, 0));
        arr.push(n / t.life > 1.08 ? Infinity : sum);   // (not past the cliff)
      }
      stint[k] = arr;
    }
    const plans = [];
    const add = function (cost, start, stops) { if (isFinite(cost)) plans.push({ cost: cost, start: start, stops: stops }); };
    for (let a = 0; a < 3; a++) {
      const A = dry[a];
      if (!mustStop) add(stint[A][laps], A, []);
      for (let b = 0; b < 3; b++) {
        const B = dry[b];
        for (let k1 = 1; k1 < laps; k1++) {
          add(stint[A][k1] + stint[B][laps - k1] + loss, A, [{ lap: k1, c: B }]);
          if (laps >= 8) {
            for (let c2 = 0; c2 < 3; c2++) {
              const C = dry[c2];
              for (let k2 = k1 + 1; k2 < laps; k2++) add(stint[A][k1] + stint[B][k2 - k1] + stint[C][laps - k2] + 2 * loss, A, [{ lap: k1, c: B }, { lap: k2, c: C }]);
            }
          }
        }
      }
    }
    if (!plans.length) return { start: 'H', stops: mustStop && laps > 1 ? [{ lap: Math.floor(laps / 2), c: 'H' }] : [] };
    plans.sort(function (p, q) { return p.cost - q.cost; });
    if (!rng) return plans[0];
    const best = plans[0].cost, near = plans.filter(function (p) { return p.cost <= best + 1.5; }).slice(0, 14);
    return near[Math.floor(rng() * near.length)];
  };
  /* For a stop now: the softest dry tyre that lasts the laps that are left. */
  F1.tyreForLaps = function (left) {
    for (let a = 0; a < 3; a++) { const k = ['S', 'M', 'H'][a]; if (left <= TYRES[k].life * 0.95) return k; }
    return 'H';
  };

  // ---------------------------------------------------------------- weather
  /* The chance of rain in a session at each track (from how often it rains there on a race weekend). */
  const RAIN = { spa: 0.38, silverstone: 0.33, interlagos: 0.33, zandvoort: 0.27, suzuka: 0.25, montreal: 0.25, redbullring: 0.25,
    singapore: 0.22, monaco: 0.16, monza: 0.14, baku: 0.06, jeddah: 0.03, lasvegas: 0.03, abudhabi: 0.02,
    australia: 0.22, china: 0.25, miami: 0.2, barcelona: 0.1, bahrain: 0.02 };
  F1.rainChance = function (T) { return RAIN[T.id] !== undefined ? RAIN[T.id] : 0.2; };
  /* A session's weather, from its seed: the rain showers over the session (start, end, how hard at their peak).
     Sometimes it is already raining when the session starts; a long session can have a second shower. */
  F1.weatherPlan = function (T, seed, horizon) {
    const r = mulberry32((seed ^ 0x6d2b79f5) >>> 0), p = F1.rainChance(T), spells = [];
    const peak = function () { return r() < 0.6 ? 0.22 + r() * 0.23 : 0.6 + r() * 0.35; };   // light or heavy
    let t = null;
    if (r() < p * 0.35) { const len = 150 + r() * 330; spells.push({ t0: -90 - r() * 120, t1: len, peak: peak() }); t = len; }
    while (spells.length < 4) {
      if (r() >= (spells.length ? p * 0.6 : p)) break;
      const start = (t === null ? 30 : t + 240) + r() * Math.max(60, horizon * 0.7);
      if (start > horizon) break;
      const len = 150 + r() * 330;
      spells.push({ t0: start, t1: start + len, peak: peak() });
      t = start + len;
    }
    return spells;
  };
  /* How hard it is raining at time t (0 none .. 1 a downpour): showers build up and ease off over 40 s. */
  F1.rainAt = function (plan, t) {
    let v = 0;
    for (let i = 0; i < plan.length; i++) {
      const sp = plan[i];
      if (t <= sp.t0 || t >= sp.t1) continue;
      const k = Math.min(1, (t - sp.t0) / 40, (sp.t1 - t) / 40), x = t - sp.t0;
      v = Math.max(v, sp.peak * k * (1 + 0.16 * Math.sin(x / 23) * Math.sin(x / 7.3)));
    }
    return clamp(v, 0, 1);
  };
  /* The tyres a car on these tyres should be on now, from how wet the racing line is (with a margin, so nobody swaps
     back and forth): null = keep them, 'I' / 'W' = rain tyres, 'dry' = back on slicks. */
  function weatherNeed(cur, lw) {
    if (SLICK[cur]) return lw > 0.6 ? 'W' : lw > 0.14 ? 'I' : null;
    if (cur === 'I') return lw > 0.68 ? 'W' : lw < 0.07 ? 'dry' : null;
    return lw < 0.07 ? 'dry' : lw < 0.46 ? 'I' : null;
  }
  F1.weatherNeed = weatherNeed;

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

  /* Is the track from s0 to s1 a straight (or nearly)? Defensive moves are only made on a straight. */
  function straightTo(T, s0, s1) {
    const n = Math.ceil(F1.wrapS(s1 - s0, T.length) / T.ds);
    for (let k = 0; k < n; k += 2) if (Math.abs(T.curv[F1.idxAt(T, s0 + k * T.ds)]) > 0.004) return false;
    return true;
  }

  /* Fresh AI driver state for car c. */
  F1.newAI = function (c, lvl, rng) {
    return {
      inp: { throttle: 0, brake: 0, steer: 0, drs: false, reset: false, lock: false },
      bias: 0, stuck: 0, backward: 0, wait: 0,
      latT: c.d, gridLane: c.d, along: {}, pass: null, mk: null, lastMk: -99, dispT: -99,
      pace: lvl.pace * (1 - rng() * (lvl.spread === undefined ? 0.012 : lvl.spread)),
      // reaction to lights out: quicker on harder levels, and now and then a slow getaway
      react: lvl.react[0] + rng() * (lvl.react[1] - lvl.react[0]) + (rng() < (lvl.slowStart === undefined ? 0.08 : lvl.slowStart) ? 0.2 + rng() * 0.35 : 0),
      cover: null, coveredS: -1
    };
  };

  F1.aiDrive = function (c, S) {
    const T = S.track, ai = c.ai, inp = ai.inp, L = T.length, now = S.time;
    inp.reset = false; inp.drs = false; inp.lock = false;
    if (S.phase === 'countdown' || c.locked) { inp.throttle = 0; inp.brake = 1; inp.steer = 0; return inp; }
    const lvl = AI_LEVELS[S.aiLevel] || AI_LEVELS.medium;
    const sp = Math.hypot(c.vx, c.vy);
    const prof = F1.speedProfile(T, S.aiLevel, c.tg);       // (slower on worn or harder tyres)
    const look = 8 + sp * 0.3;
    const i = F1.idxAt(T, c.s + look);
    const hwE = Math.min(T.hwE[i], T.hwE[c.seg]);          // usable half width (less in narrow sections)
    const room = hwE - 1.05;
    const cv = c.vx * T.tx[c.seg] + c.vy * T.ty[c.seg];      // speed along the track
    const zones = F1.brakeZones(T, S.aiLevel);
    const race = S.type === 'race';
    const iv = F1.idxAt(T, c.s + sp * 0.12);
    // practice: out laps and in laps are driven a little gently
    const vFree = prof[iv] * ai.pace * (c.run && (c.run.n === 0 || c.run.n >= c.run.goal) ? 0.93 : 1);

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
    let atk = null, atkDS = -Infinity, atkV = 0;           // the nearest car close behind (for defending)
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
          if (dS <= -5.2 && dS > -45 && dD < 5 && dD > -5 && dS > atkDS) { atk = o; atkDS = dS; atkV = ov; }
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
        const gap = dS - CAR.length;
        // a car stopped beside the track: keep a car's width away from it instead of braking for it
        // (unless we would reach it before we could move out of the way)
        const oExt = halfWidthOnTrack(o, T);
        if (o.vx * o.vx + o.vy * o.vy < 9 && Math.abs(o.d) > T.hw + 0.35) {
          if (dS >= 90) continue;                     // far away: deal with it when we get closer
          const keep = myExt + oExt + 0.9, touch = myExt + oExt + 0.2, dAway = Math.abs(dD);
          const tReach = gap > 0 ? gap / Math.max(0.5, cv) : 0;
          if (dAway >= touch || tReach >= (touch - dAway) / 3 + 0.25) {
            if (o.d > 0) { const lim = o.d - keep; if (lim < hi) hi = lim; } else { const lim = o.d + keep; if (lim > lo) lo = lim; }
            continue;
          }
        }
        // ahead: will we run into it on our current line?
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

    // overtaking, or getting round a slow / stopped car
    let passing = false, urgent = false;
    if (ai.pass) {
      const o = S.byId[ai.pass.id];
      const dS = o && !o.out ? wrapD(o.s - c.s, L) : 999;
      if (dS < -9 || dS > 80 || now - ai.pass.t > 12) ai.pass = null;
      else {
        const lane = clamp(o.d + ai.pass.side * 2.9, -room - 0.3, room + 0.3);
        if (Math.abs(lane - o.d) < 2.6 || !laneClear(S, c, lane, o.id, -6, Math.max(12, dS + 25))) ai.pass = null;
        else { want = lane; passing = true; urgent = ai.pass.urgent; }
      }
    }
    if (!ai.pass && lead) {
      const closing = cv - leadV, ak = lvl.attack || 0;
      const slow = leadV < Math.max(8, cv * 0.6);
      if (leadGap < (slow ? 90 : 38 + 12 * ak) && (slow || closing > 1 - 0.6 * ak || (leadGap < 14 + 6 * ak && vFree > leadV + 2 - ak))) {
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

    // defending (extra hard, expert): a car close behind on the way into a proper braking zone - one early move
    // to cover the inside, held through the braking zone to the apex (the slower, tighter line). Never a move
    // towards a car that has already pulled out to the inside (we stop where we are), and never into a car
    // alongside (see lo / hi).
    const pl = c.pitPlan;
    let covering = false;
    if (ai.cover) {
      const cv2 = ai.cover, o = S.byId[cv2.id];
      const toApex = F1.wrapS(cv2.apex - c.s, L), braking = F1.wrapS(cv2.s - c.s, L) > toApex;
      if (!o || o.out || toApex > 600 || passing || ai.mk) ai.cover = null;
      else {
        const dS = wrapD(o.s - c.s, L);
        if (dS < -60 || dS > 4) ai.cover = null;           // dropped back, or it is past
        else {
          const lane = Math.max(0, room - 2.4);         // just enough that there is no room for a car up the inside
          let tgt = cv2.side * (braking ? Math.max(lane, cv2.side * T.rlOff[i]) : lane);
          if (!braking && (o.d - c.d) * cv2.side > 1.0) tgt = cv2.hold === undefined ? (cv2.hold = c.d) : cv2.hold;   // it went inside first
          want = tgt; covering = true;
        }
      }
    } else if (lvl.defend && race && atk && !passing && !ai.mk && !(pl && pl.stage === 'in') && S.firstBrake !== null && c.raceDist > S.firstBrake + 30) {
      // the next braking zone ahead
      let Zn = null, toB = Infinity;
      for (let z = 0; z < zones.length; z++) {
        const d = F1.wrapS(zones[z].s - c.s, L);
        if (d < toB) { toB = d; Zn = zones[z]; }
      }
      const reach = 10 + 15 * lvl.defend;                 // how close the car behind must be
      if (Zn && Zn.drop >= 25 && toB > 40 && toB < 300 && Zn.s !== ai.coveredS && -atkDS < reach && atkV - cv > -2 &&
          Math.abs(atk.d - c.d) < 1.4 && c.d * Zn.turn < room - 2.4 && straightTo(T, c.s, Zn.s)) {
        ai.coveredS = Zn.s;                               // one decision per braking zone (expert: always covers)
        if (S.rng() < 0.5 + 0.5 * lvl.defend) {
          ai.cover = { id: atk.id, s: Zn.s, apex: Zn.apex, side: Zn.turn };
          want = Zn.turn * Math.max(0, room - 2.4); covering = true;
        }
      }
    }

    // heading for the pits: over to the pit side of the track before the entry, slowing for the speed limit
    let pitV = Infinity;
    if (pl && pl.stage === 'in' && !pl.entered && T.pit) {
      const Pt = T.pit, du = F1.wrapS(Pt.s0 - c.s, L);
      if (du < 450) {
        const k = clamp((450 - du) / 280, 0, 1);
        // going round a stopped car comes first (we may miss the entry and come in next lap instead)
        const po = ai.pass && ai.pass.urgent ? S.byId[ai.pass.id] : null;
        if (!(po && po.vx * po.vx + po.vy * po.vy < 16)) {
          want = want * (1 - k) + Pt.side * (T.hw - 2.4) * k;
          if (k > 0.25) { ai.pass = null; passing = false; urgent = false; }
        }
        pitV = Math.sqrt((PIT_LIMIT - 0.8) * (PIT_LIMIT - 0.8) + 2 * 13 * Math.max(0, du + F1.pitInfo(T).limit0 - 6));
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
        if (hwE < T.hw - 0.05) edge = Math.min(edge, hwE - 0.4);     // between walls: a mistake stays off them
      }
    }

    // ---- steering: pure pursuit towards the chosen line
    const r = (urgent ? 6 : passing || covering ? 3.4 : 2.6) * F1.DT;
    const db = want - T.rlOff[i] - ai.bias;
    ai.bias += db > r ? r : db < -r ? -r : db;
    let latT = T.rlOff[i] + ai.bias;
    if (lo > hi) lo = hi = (lo + hi) / 2;               // squeezed between two cars: hold the middle
    if (latT < lo) latT = lo; else if (latT > hi) latT = hi;
    // squeezed towards the edge by a car alongside: we get forced wide onto the kerb / grass
    if (lo > edge || hi < -edge) edge = Math.min(Math.max(lo, -hi), hwE < T.hw - 0.05 ? hwE - 0.3 : T.hw + 1.6);
    if (offTrack && rejoinBlocked) latT = c.d;          // wait at the edge until the cars have gone past
    latT = clamp(latT, -Math.max(edge, c.dist), Math.max(edge, c.dist));
    ai.latT = latT;
    const tx = T.x[i] + T.nx[i] * latT, ty = T.y[i] + T.ny[i] * latT;
    const ca = Math.cos(c.a), sa = Math.sin(c.a);
    const dx = tx - c.x, dy = ty - c.y;
    const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;
    const curv = (2 * ly) / Math.max(1, lx * lx + ly * ly);
    const vf = c.vx * ca + c.vy * sa, vfa = Math.abs(vf);
    let latRef = Math.min(P.LAT_MAX, P.LAT0 + P.LAT_K * sp * sp);
    if (T.bank) latRef *= T.bank[c.seg];             // the same steering range as the car has there (banked corner)
    const maxDelta = Math.min(P.STEER_MAX, Math.atan(CAR.WB * latRef / Math.max(vfa * vfa, 1)) * 1.05);
    let steer = Math.atan(CAR.WB * curv) / maxDelta;
    if (lx < 0) steer = ly > 0 ? 1 : -1;
    inp.steer = clamp(steer, -1, 1);

    // ---- speed
    let vt = vFree;
    if (c.dirty < 1 && vt < 80) vt *= Math.sqrt(c.dirty);            // lift a touch in dirty air
    const offLine = Math.abs(latT - T.rlOff[i]);
    if (offLine > 1.5 && vt < 70) vt *= 1 - Math.min(0.08, (offLine - 1.5) * 0.015);   // off line = less grip
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
    if (pitV < vt) vt = pitV;
    if (F1.DEBUG_AI) { ai.dbg = { lo: lo, hi: hi, want: want, latT: latT, vt: vt, vFree: vFree, lead: lead ? lead.id : -1, leadGap: leadGap, leadV: leadV, pass: ai.pass ? ai.pass.id + (ai.pass.side > 0 ? 'R' : 'L') : '', mk: mkType || '', chased: chased }; }
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
        // a late lunge only into a proper braking zone (hairpins, chicanes), not quick esses
        const attacking = ai.pass && !ai.pass.urgent && ai.pass.side === Z.turn && race && Z.drop >= 25;
        let p = attacking ? lvl.divebomb : lvl.mistake / zones.length;
        if (race && c.lapsDone === 0) p *= 0.6;                 // a bit more careful in the opening-lap pack
        else if (chased) p *= 1.5;                              // pressure from the car behind
        if (c.dirty < 0.99) p *= 1.4;                           // fighting dirty air
        if (c.tyre && c.tyre.w > 0.9) p *= 1.5;                 // tyres past their best
        if (S.wet > 0) p *= 1 + 1.2 * S.wetAt(c);               // a wet track
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
  /* ---- Track limits.
     A car is off the track when all four wheels are past the kerb (or past the edge where there is no kerb).
     It has cut a corner when it comes back on further round having driven a shorter way than the track allows:
     running wide, spinning or using the pit roads never counts. */
  const TL_WHEELS = 0.8;                       // wheels sit 0.8 m either side of the car's centre
  function tlEdge(T, i) { return T.hw + (T.kerb[i] ? T.kerbW : 0) + TL_WHEELS; }
  // length of the track-limit line on one side between two points along the track
  function tlLegal(T, s0, s1, side) {
    const L = T.length, ds = T.ds, span = F1.wrapS(s1 - s0, L);
    const a = F1.trackPoint(T, s0, side * tlEdge(T, F1.idxAt(T, s0)));
    let len = 0, px = a.x, py = a.y;
    let i = (Math.floor(F1.wrapS(s0, L) / ds) + 1) % T.n;
    for (let k = 0; k < span / ds - 1 && k < T.n; k++, i = (i + 1) % T.n) {
      const off = side * tlEdge(T, i), x = T.x[i] + T.nx[i] * off, y = T.y[i] + T.ny[i] * off;
      len += Math.hypot(x - px, y - py); px = x; py = y;
    }
    const b = F1.trackPoint(T, s1, side * tlEdge(T, F1.idxAt(T, s1)));
    return len + Math.hypot(b.x - px, b.y - py);
  }
  F1.tlLegal = tlLegal;
  // the quickest a hard AI could get between two points on the racing line (no time lost accelerating)
  function tlRefTime(T, s0, s1) {
    if (!T._tlCum) {
      const prof = F1.speedProfile(T, 'hard'), N = T.n, cum = new Float64Array(N + 1);
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        cum[i + 1] = cum[i] + Math.hypot(T.rlX[j] - T.rlX[i], T.rlY[j] - T.rlY[i]) / Math.max(5, 0.5 * (prof[i] + prof[j]));
      }
      T._tlCum = cum;
    }
    const cum = T._tlCum, N = T.n;
    const at = function (s) { const f = F1.wrapS(s, T.length) / T.ds, i = Math.floor(f) % N; return cum[i] + (cum[i + 1] - cum[i]) * (f - Math.floor(f)); };
    let t = at(s1) - at(s0);
    if (t < 0) t += cum[N];
    return t;
  }

  function passed(ps, ns, x, L) {
    let d = ns - ps;
    if (d < -L / 2) d += L; else if (d > L / 2) d -= L;
    if (d <= 0 || d > 60) return false;
    let rel = x - ps;
    if (rel < 0) rel += L;
    return rel > 0 && rel <= d;
  }

  // ---------------------------------------------------------------- pit lane, pit boxes and garages
  /* Along the pit lane, positions are u = metres from the start of the entry road (s0); the lane ends at u = total. */
  F1.pitInfo = function (T) {
    if (T._pi !== undefined) return T._pi;
    const P = T.pit;
    if (!P) { T._pi = null; return null; }
    const L = T.length, u = function (sv) { return F1.wrapS(sv - P.s0, L); };
    T._pi = { total: u(P.s3), limit0: u(P.s1), limit1: u(P.s2), u: u };
    return T._pi;
  };
  function teamIdx(driverId) {
    const d = F1.driver(driverId);
    return d ? F1.TEAMS.findIndex(function (t) { return t.id === d.team; }) : 0;
  }
  /* A car's garage (its team's), where it stops in front of it, and where it parks inside it.
     The team's two cars park side by side, facing out; each stops a little ahead of its own spot, so it can
     roll back in. In a race both cars use the painted box (one at a time). */
  F1.garageSpots = function (T, c) {
    const P = T.pit, n = P.garages.length, g = P.garages[n - 1 - (((c.team % n) + n) % n)];
    const sSpot = g.mid + (c.gSlot ? 3.4 : -3.0), sStop = c.gSlot ? g.mid + 6.8 : g.mid + 0.4;
    const spot = F1.trackPoint(T, sSpot, P.side * (P.garFront + 3.4));
    const i = F1.idxAt(T, sSpot);
    spot.h = Math.atan2(-P.side * T.ny[i], -P.side * T.nx[i]);          // nose out, towards the pit lane
    const stop = F1.trackPoint(T, sStop, P.side * P.boxOff);
    const box = F1.trackPoint(T, g.mid + 0.4, P.side * P.boxOff);
    return { g: g, spot: spot, sSpot: sSpot, stop: stop, sStop: sStop, box: box, sBox: g.mid + 0.4 };
  };
  function smooth01(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }

  /* Rolling into or out of the garage (no driving: the car just moves, as if pushed). k: 'in' | 'out'. */
  function garageMove(S, c, k) {
    const T = S.track, G = F1.garageSpots(T, c), P = T.pit;
    const from = k === 'in' ? { x: c.x, y: c.y, a: c.a } : { x: G.spot.x, y: G.spot.y, a: G.spot.h };
    const to = k === 'in' ? { x: G.spot.x, y: G.spot.y, a: G.spot.h } : { x: G.stop.x, y: G.stop.y, a: G.stop.h };
    // the curve goes through the point in front of the spot, on the line the car stops on
    F1.queryTrack(T, k === 'in' ? c.x : G.stop.x, k === 'in' ? c.y : G.stop.y, -1, Q2);
    const mid = F1.trackPoint(T, G.sSpot, k === 'in' ? Q2.d : P.side * P.boxOff);
    c.gar = { k: k, t0: S.time, dur: k === 'in' ? 3.2 : 2.6, from: from, to: to, cx: mid.x, cy: mid.y, at: S.time };
    c.vx = 0; c.vy = 0; c.w = 0; c.drsOpen = false; c.slide = false; c.delta = 0;
    c.lapStart = null; c.lapPen = 0; c.tlOff = false;
  }
  function garageStep(S, c) {
    const G = c.gar;
    if (G.k === 'park') return;
    const t = Math.min(1, (S.time - G.t0) / G.dur), e = smooth01(t), u = 1 - e;
    const A = G.from, B = G.to, ox = c.x, oy = c.y;
    c.x = u * u * A.x + 2 * u * e * G.cx + e * e * B.x;
    c.y = u * u * A.y + 2 * u * e * G.cy + e * e * B.y;
    c.vx = t < 1 ? (c.x - ox) / F1.DT : 0; c.vy = t < 1 ? (c.y - oy) / F1.DT : 0;
    c.a = A.a + F1.wrapAngle(B.a - A.a) * smooth01(t * 1.15 - 0.1);
    if (t < 1) return;
    if (G.k === 'in') { c.gar = { k: 'park', at: S.time }; S.events.push({ k: 'garage', id: c.id, on: true }); return; }
    // out of the garage: in front of it, ready to drive down the pit lane
    c.gar = null;
    c.gExitT = S.time;
    const k = c.isAI ? c.runTyre || 'M' : c.tyreNext || S.defaultTyre(c);
    c.tyre = { c: k, w: 0, laps: 0 }; c.tyreMsg = 0; c.tg = F1.tyreGrip(k, 0, S.wet);
    if (!SLICK[k]) c.usedWet = true;
    F1.queryTrack(S.track, c.x, c.y, -1, Q2);
    c.seg = Q2.idx; c.s = Q2.s; c.d = Q2.d; c.dist = Q2.dist; c.prevS = c.s;
    c.px = c.x; c.py = c.y; c.pa = c.a;
    if (c.isAI) c.pitPlan = { stage: 'out', why: 'garage', entered: true, stopU: F1.pitInfo(S.track).u(c.s) };
    S.events.push({ k: 'garage', id: c.id, on: false });
  }

  /* An AI car driving in the pit lane: in to its box (and stop), or out of it to the end of the lane. */
  function aiPitDrive(c, S) {
    const T = S.track, P = T.pit, PH = F1.PHYS, pi = F1.pitInfo(T), pl = c.pitPlan, L = T.length;
    const inp = c.ai ? c.ai.inp : c.pitInp || (c.pitInp = { throttle: 0, brake: 0, steer: 0, drs: false, reset: false, lock: false });
    inp.reset = false; inp.drs = false; inp.lock = false;
    const u = pi.u(c.s), sp = Math.hypot(c.vx, c.vy);
    // a race stop with the team-mate in (or heading for) the box: queue behind it in the working lane, not in the fast lane
    if (pl.why === 'stop' && pl.stage === 'in' && !pl.early) {
      for (let q = 0; q < S.cars.length; q++) {
        const o = S.cars[q];
        if (o !== c && o.team === c.team && !o.out && (o.pitStop || (o.pitPlan && o.pitPlan.entered && o.pitPlan.stage === 'in' && pi.u(o.s) > u))) { pl.early = true; break; }
      }
    }
    const dAt = function (uu) {
      uu = clamp(uu, 0, pi.total);
      let d = T.pitOff[F1.idxAt(T, P.s0 + uu)];
      if (d !== d) d = P.off;
      // into the working lane only just before the box (not past the other teams' boxes), and out of it soon after
      if (pl.stage !== 'out') {
        const a = pl.stopU - (pl.early ? 36 : 19), b = pl.stopU - (pl.early ? 18 : 3);
        if (uu > a) d += (P.boxOff - P.off) * smooth01((uu - a) / (b - a));
      } else {
        const a = pl.stopU + 1, b = pl.stopU + 20;
        if (uu < b) d = P.boxOff + (d - P.boxOff) * smooth01((uu - a) / (b - a));
      }
      return P.side * d;
    };
    // steering: towards a point a little way down the lane
    const look = 4.5 + sp * 0.35, tp = F1.trackPoint(T, P.s0 + Math.min(u + look, pi.total + 30), dAt(u + look));
    const ca = Math.cos(c.a), sa = Math.sin(c.a), dx = tp.x - c.x, dy = tp.y - c.y;
    const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;
    const curv = (2 * ly) / Math.max(1, lx * lx + ly * ly);
    const vfa = Math.abs(c.vx * ca + c.vy * sa);
    const latRef = Math.min(PH.LAT_MAX, PH.LAT0 + PH.LAT_K * sp * sp);
    const maxDelta = Math.min(PH.STEER_MAX, Math.atan(CAR.WB * latRef / Math.max(vfa * vfa, 1)) * 1.05);
    inp.steer = clamp(lx < 0 ? (ly > 0 ? 1 : -1) : Math.atan(CAR.WB * curv) / maxDelta, -1, 1);
    // speed: down to the limit before the line, stop in the box, wait for a gap before pulling out
    let v = PIT_LIMIT - 0.8;
    if (u < pi.limit0) v = Math.sqrt(v * v + 2 * 12 * Math.max(0, pi.limit0 - 6 - u));
    if (pl.stage === 'in') { const dist = pl.stopU - u; v = Math.min(v, dist > 0.3 ? Math.sqrt(2 * 4.2 * dist) : 0); }
    if (pl.stage === 'out' && u > pi.limit1 + 2) v = 45;
    let blocked = false;
    for (let q = 0; q < S.cars.length; q++) {
      const o = S.cars[q];
      if (o === c || o.out || o.gar) continue;
      const dS = wrapD(o.s - c.s, L);
      const ov = o.vx * T.tx[o.seg] + o.vy * T.ty[o.seg];
      // a car ahead on the way we are going (where we will be across the lane when we get to it)
      if (dS > 0 && dS < 32 && Math.abs(o.d - dAt(u + dS)) < 2.6) {
        const cap = Math.max(0, ov + (dS - 8) * 0.7);
        if (cap < v) { v = cap; if (cap < 0.5) blocked = true; }
      }
      // leaving the box: let the cars in the fast lane go by first
      if (pl.stage === 'out' && u < pl.stopU + 14 && dS < 4 && dS > -38 && ov > 4 && Math.abs(o.d - P.side * P.off) < 2.4 && Math.abs(c.d - P.side * P.off) > 1.6) v = 0;
    }
    // waiting behind a car that is not moving (a player sitting in a box): how long for (see pitLogic)
    pl.waitT = blocked && sp < 0.6 ? (pl.waitT || 0) + F1.DT : 0;
    // knocked sideways (or round) in the narrow pit lane and not getting anywhere: put straight on the lane again
    const hdErr = Math.abs(F1.wrapAngle(c.a - T.hd[c.seg]));
    pl.stuckT = !c.pitStop && sp < 1 && !blocked && (v > 1 || hdErr > 1.6) ? (pl.stuckT || 0) + F1.DT : 0;
    if (pl.stuckT > 2.5) {
      const p = F1.trackPoint(T, P.s0 + u, dAt(u));
      c.x = p.x; c.y = p.y; c.a = p.h; c.vx = 0; c.vy = 0; c.w = 0; c.slide = false;
      pl.stuckT = 0;
    }
    // gentle at walking pace (stopping in the box), full throttle only when well below the speed wanted.
    // (Holding the brake at a standstill is reverse gear: to wait, just let the car stand.)
    const vf = c.vx * ca + c.vy * sa;                // forward speed (below 0 = rolling backwards)
    if (v < 0.3) { inp.throttle = vf < -0.3 ? 0.3 : 0; inp.brake = vf > 0.5 ? 1 : 0; }
    else if (vf > v + 0.6) { inp.throttle = 0; inp.brake = Math.min(1, (vf - v) / 4 + 0.2); }
    else if (vf > v - 0.3) { inp.throttle = 0.12; inp.brake = 0; }
    else { inp.throttle = clamp((v - vf) * 0.35 + 0.2, 0, 1); inp.brake = 0; }
    return inp;
  }

  /* Practice: how many of the AI cars should be out on track at this point of the session. Busy at the start,
     quieter in the middle, busiest at the end (in an open practice the pattern repeats); never fewer than 4
     (mostly 5 or 6), and a small field stays out more. */
  function runShare(f) {
    if (f < 0.15) return 0.7;
    if (f < 0.3) return 0.7 - (f - 0.15) / 0.15 * 0.3;
    if (f < 0.6) return 0.4;
    if (f < 0.8) return 0.4 + (f - 0.6) / 0.2 * 0.48;
    return 0.88;
  }
  function newRun(S, c) {
    const x = S.rng();
    c.run = { n: 0, goal: 1 + (x < 0.35 ? 1 : x < 0.75 ? 2 : 3) };     // out lap, 1-3 fast laps, in lap
    const y = S.rng();
    const lw = S.lineWet();
    c.runTyre = (lw > 0.12 ? F1.wetTyre(lw) : null) || (y < 0.45 ? 'S' : y < 0.85 ? 'M' : 'H');   // a new set for each run
  }

  /* opts: {type:'practice'|'quali'|'race', track, entries:[{id, driverId, isAI, name}], laps, aiLevel, collisions, seed} */
  function Session(opts) {
    const T = opts.track;
    this.type = opts.type;
    this.track = T;
    this.laps = opts.laps || 0;
    this.aiLevel = F1.isAILevel(opts.aiLevel) ? opts.aiLevel : 'medium';
    this.collisions = opts.type === 'quali' ? false : opts.collisions !== false;
    this.drafting = opts.drafting !== false;                       // slipstream on straights (a switch before the session)
    // practice: AI cars do runs of a few laps and go back to their garages in between
    this.runs = opts.type === 'practice' && opts.runs === true && !!T.pit;
    this.runMin = 5; this.runMinAt = -99; this.runRelease = -99;
    this.rng = mulberry32(opts.seed || 1234567);
    // tyres: with wear on they wear out, and a race of 3 laps or more needs at least one pit stop
    this.tyres = opts.tyres === true;
    this.mustStop = this.tyres && opts.type === 'race' && this.laps >= 3;
    this.weatherOn = opts.weather === true;                        // the weather switch (off = always dry)
    const ref = F1.refLapTime(T);
    this.refLap = ref;
    // the weather: rain showers over the session (from the seed), how hard it rains, how wet the track is
    // (0 dry .. 1 standing water) and how much drier the racing line is than the rest (0 .. 1: cars dry it)
    this.rain = 0; this.wet = 0; this.lineDry = 0; this.wplan = [];
    this.wx = { soon: -1, rain: 0, stop: true };                   // (for the rain messages)
    if (this.weatherOn) {
      const horizon = opts.type === 'race' ? 20 + this.laps * ref * 1.1 : this.laps > 0 ? (this.laps + 2.5) * ref * 1.3 : 3600;
      this.wplan = F1.weatherPlan(T, (opts.seed || 1234567) + 17, horizon);
      // already raining (or it has just rained): how wet the track is when the session starts
      for (let t = -300; t < 0; t += 1) this.weatherStep(1, t);
      this.wx.rain = this.rain > 0.08 ? (this.rain > 0.55 ? 2 : 1) : 0; this.wx.stop = this.rain <= 0.08;
    }
    // a race with tyre wear (or on a wet track): a few seconds on the grid to pick the starting tyres before the lights
    this.gridT = opts.type === 'race' && (this.tyres || (this.weatherOn && this.lineWet() > 0.1)) ? 3 : 0;
    this.tick = 0;
    this.time = 0;
    this.cars = [];
    this.byId = {};
    this.events = [];
    this.fx = [];
    this.phase = opts.type === 'practice' ? 'running' : 'countdown';
    this.lights = 0;
    this.startTime = opts.type === 'practice' ? 0 : null;
    this.lightsOutAt = opts.type === 'race' ? this.gridT + 5.5 + 0.4 + this.rng() * 2.0 : null;
    this.leaderFinishTime = null;
    this.lastHumanFinish = null;
    this.humansDoneAt = null;
    this.finishCount = 0;
    this.finalLapAnnounced = false;
    this.fastest = null;
    this.secBest = [null, null, null];     // fastest time anyone has set in each sector this session
    this.loopFirst = [];
    this.detLast = T.drs.map(function () { return null; });
    this.results = null;
    // first braking zone after the start line (AI hold their grid lanes until then on lap 1)
    const bz = F1.brakeZones(T, this.aiLevel).filter(function (z) { return z.s > 30; });
    this.firstBrake = bz.length ? bz[0].s : null;
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
      c.tlOff = false; c.tlWarn = 0; c.penalty = 0; c.lapPen = 0; c.jumped = false;
      c.grid = k + 1; c.overtakes = 0; c.troubleT = -99;
      c.secRef = undefined; c.secN = 0; c.secAt = 0; c.secT = [0, 0, 0];    // sector timing on the current lap
      c.drsElig = T.drs.map(function () { return opts.type !== 'race'; });
      c.input = F1.NEUTRAL;
      c.prevS = c.s;
      c.tow = 1;                                       // slipstream: drag factor (1 = none)
      c.team = teamIdx(e.driverId);
      c.gSlot = self.cars.some(function (o) { return o.team === c.team; }) ? 1 : 0;   // the team's first or second car (garage spot)
      c.pitPlan = null;                                // AI: heading into (or out of) the pits
      c.gar = null;                                    // in the garage, or rolling in / out of it
      c.gStill = 0; c.gExitT = 0; c.gMoved = false; c.gHome = null; c.goHold = 0;
      c.run = null;                                    // AI in practice: { n: laps across the line this run, goal }
      c.tyre = { c: 'S', w: 0, laps: 0 };              // compound (F1.TYRES), wear (0 new .. 1 worn out), laps on the set
      c.tyreNext = null;                               // a player's pick for the next set (pit stop or garage)
      c.tg = 1; c.load = 0;                            // grip from the tyres now; how hard they are working
      c.stops = 0; c.tyreHist = ['S']; c.pitStop = null; c.pitDone = false; c.usedWet = false; c.strat = null; c.tyreMsg = 0;
      if (c.isAI) c.ai = F1.newAI(c, lvl, self.rng);
      self.cars.push(c);
      self.byId[c.id] = c;
    });
    // the tyres everyone starts on: rain tyres on a wet track; in a race with tyre wear each AI car picks a plan (tyres
    // to start on, laps to stop on) and a player starts on the best plan's tyres (unless they pick on the grid)
    const wetStart = F1.wetTyre(this.lineWet() > 0.1 ? Math.max(0.12, this.lineWet()) : 0);
    this.startTyre = wetStart || 'S';
    if (this.type === 'race' && this.tyres) {
      const rs = mulberry32((opts.seed || 1234567) ^ 0x2545f491);
      this.bestPlan = F1.planStrategy(T, this.laps, this.mustStop, null);
      this.cars.forEach(function (c) {
        if (c.isAI) {
          const p = F1.planStrategy(T, self.laps, self.mustStop, rs);
          c.strat = { start: p.start, stops: p.stops.map(function (x) { return { lap: x.lap, c: x.c }; }) };
          // team-mates don't plan to stop on the same lap (they share the box)
          const mate = self.cars.find(function (o) { return o !== c && o.isAI && o.team === c.team && o.strat; });
          if (mate && mate.strat.stops.length && c.strat.stops.length && mate.strat.stops[0].lap === c.strat.stops[0].lap) {
            const st = c.strat.stops[0], up = st.lap + 1 < self.laps && (c.strat.stops.length < 2 || st.lap + 1 < c.strat.stops[1].lap);
            st.lap += up ? 1 : st.lap > 1 ? -1 : 0;
          }
          c.tyre.c = c.strat.start;
        } else c.tyre.c = self.bestPlan.start;
        c.tyreHist = [c.tyre.c];
      });
      if (!wetStart) this.startTyre = this.bestPlan.start;
    }
    if (wetStart) this.cars.forEach(function (c) { c.tyre.c = wetStart; c.tyreHist = [wetStart]; c.usedWet = true; });
    this.cars.forEach(function (c) { c.tg = F1.tyreGrip(c.tyre.c, 0, self.wetAt(c)); });
    if (opts.startMode === 'pit' && T.pit) this.placeForPitStart();
    else if (opts.startMode === 'flying') this.placeFlying();
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
    const inBox = {};
    // realistic practice: about 70% of the AI cars start out on track, the others in their garages
    const self = this, nOut = this.runs ? this.runTarget() : ais.length;
    const outSet = new Set(ais.slice().sort(function () { return self.rng() - 0.5; }).slice(0, nOut));
    let kOut = 0;
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      // (realistic practice: a player starts in their garage too, and goes out when ready)
      if (this.runs && (!c.isAI || !outSet.has(c))) {
        const G = F1.garageSpots(T, c);
        c.x = G.spot.x; c.y = G.spot.y; c.a = G.spot.h; c.vx = 0; c.vy = 0;
        c.gar = { k: 'park', at: -10 - this.rng() * 25 };
        c.px = c.x; c.py = c.y; c.pa = c.a;
        F1.queryTrack(T, c.x, c.y, -1, Q);
        c.seg = Q.idx; c.s = Q.s; c.d = Q.d; c.dist = Q.dist; c.prevS = c.s;
        continue;
      }
      if (c.isAI) {
        const k = this.runs ? kOut++ : ais.indexOf(c), nk = this.runs ? nOut : ais.length;
        if (this.runs) {
          newRun(this, c); c.run.n = Math.floor(this.rng() * c.run.goal);
          c.tyre = { c: c.runTyre, w: this.tyres ? c.run.n / TYRES[c.runTyre].life : 0, laps: c.run.n }; c.tyreHist = [c.runTyre];
        }
        const s = F1.wrapS(L * (k + 1) / (nk + 1) + 260, L);
        const idx = F1.idxAt(T, s);
        const v = prof[idx] * 0.8;
        c.x = T.rlX[idx]; c.y = T.rlY[idx]; c.a = T.hd[idx];
        c.vx = Math.cos(c.a) * v; c.vy = Math.sin(c.a) * v;
      } else {
        const ti = teamIdx(c.driverId);
        const p = F1.pitSpot(T, ti, !!inBox[ti]);
        inBox[ti] = true;
        c.x = p.x; c.y = p.y; c.a = p.h; c.vx = 0; c.vy = 0;
      }
      c.px = c.x; c.py = c.y; c.pa = c.a;
      F1.queryTrack(T, c.x, c.y, -1, Q);
      c.seg = Q.idx; c.s = Q.s; c.d = Q.d; c.dist = Q.dist; c.prevS = c.s;
      c.raceDist = c.s;
      if (c.ai) { c.ai.latT = c.d; c.ai.bias = c.d - T.rlOff[c.seg]; }
    }
  };

  /* Time trial: a flying start, already at speed 320 m before the line, so the first lap is timed. */
  Session.prototype.placeFlying = function () {
    const T = this.track, L = T.length, prof = F1.speedProfile(T, 'hard');
    const idx = F1.idxAt(T, F1.wrapS(L - 320, L));
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i], v = prof[idx] * 0.85;
      c.x = T.rlX[idx]; c.y = T.rlY[idx]; c.a = T.hd[idx];
      c.vx = Math.cos(c.a) * v; c.vy = Math.sin(c.a) * v;
      c.px = c.x; c.py = c.y; c.pa = c.a;
      F1.queryTrack(T, c.x, c.y, -1, Q);
      c.seg = Q.idx; c.s = Q.s; c.d = Q.d; c.dist = Q.dist; c.prevS = c.s;
    }
  };

  Session.prototype.step = function (inputs) {
    const T = this.track, dt = F1.DT;
    this.tick++;
    this.time += dt;
    this.updatePhase();
    if (this.weatherOn) { this.weatherStep(dt); if (this.tick % 30 === 0) this.weatherNews(); }
    const cars = this.cars, L = T.length;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      c.px = c.x; c.py = c.y; c.pa = c.a; c.prevS = c.s;
      if (c.out) continue;
      if (c.gar) {                                     // in the garage (or rolling in / out): no driving
        c.tow = 1; c.dirty = 1; c.drsAllowed = false;
        if (!c.isAI && inputs && inputs[c.id]) this.garageInput(c, inputs[c.id]);
        garageStep(this, c);
        continue;
      }
      c.dirty = this.collisions ? F1.dirtyAir(c, cars, L) : 1;
      c.tow = this.drafting ? F1.slipstream(c, cars, L) : 1;
      c.locked = this.phase === 'countdown' || !!c.pitStop;      // (held still while the tyres are changed)
      if (c.isAI) c.input = c.pitPlan && c.pitPlan.entered ? aiPitDrive(c, this) : F1.aiDrive(c, this);
      else if (c.pitPlan && c.pitPlan.entered) c.input = aiPitDrive(c, this);   // a player's pit stop: the car drives itself
      else if (inputs && inputs[c.id]) c.input = inputs[c.id];
      if (c.locked && this.type === 'race' && !c.isAI) this.checkJumpStart(c);
      const z = T.drsZone[F1.idxAt(T, c.s)];
      c.drsAllowed = z >= 0 && c.drsElig[z] && this.phase !== 'countdown';
    }
    const sub = dt / F1.SUBSTEPS;
    const contactOn = this.collisions && this.phase !== 'countdown';
    for (let k = 0; k < F1.SUBSTEPS; k++) {
      for (let i = 0; i < cars.length; i++) if (!cars[i].out && !cars[i].gar) F1.stepCar(cars[i], cars[i].input, T, sub);
      if (contactOn) this.resolveContacts();
    }
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (c.wallHit > 2500) this.fx.push([Math.round(c.x * 10) / 10, Math.round(c.y * 10) / 10, Math.round(c.wallHit)]);
      c.wallHit = 0;
      if (!c.out && !c.gar) {
        this.updateProgress(c, dt); this.pitLogic(c, dt);
        const wet = this.wetAt(c);
        if (c.pitStop) this.pitStopStep(c);
        else if (this.tyres && this.phase !== 'countdown') tyreWear(c, L, dt, wet);
        c.tg = F1.tyreGrip(c.tyre.c, c.tyre.w, wet);
        if (!c.isAI && this.tyres) {                  // warnings for a player: wearing out (75%), worn out
          const n = c.tyre.w >= 1 ? 2 : c.tyre.w >= 0.75 ? 1 : 0;
          if (n > c.tyreMsg) { c.tyreMsg = n; this.events.push({ k: 'tyres', id: c.id, n: n }); }
        }
      }
    }
    if (this.runs && this.tick % 30 === 0) this.practiceTraffic();
    this.updateOrder();
    this.checkEnd();
  };

  /* Pit lane bookkeeping after each step: an AI car taking the pit entry (or missing it), stopping in front of its
     garage, leaving the pit lane; a player stopping in front of their own garage (practice and qualifying). */
  Session.prototype.pitLogic = function (c, dt) {
    const T = this.track, Pt = T.pit;
    if (!Pt) return;
    const pi = F1.pitInfo(T), L = T.length, pl = c.pitPlan;
    if (pl) {
      if (pl.stage === 'in' && !pl.entered) {
        if (passed(c.prevS, c.s, Pt.s0, L)) {
          if (Math.abs(c.d - Pt.side * (T.hw - 2.5)) < 3.4 || c.inPit) {
            pl.entered = true;
            const G = F1.garageSpots(T, c);
            pl.stopU = pi.u(pl.why === 'garage' ? G.sStop : G.sBox);
          } else pl.missed = (pl.missed || 0) + 1;      // could not get across in time: next lap
        }
      } else if (pl.entered) {
        const u = pi.u(c.s), sp = Math.hypot(c.vx, c.vy);
        // stopped at the box (or close to it behind a car that is not moving)
        const atBox = sp < 0.6 && ((u - pl.stopU > -3 && u - pl.stopU < 9) || (pl.waitT > 2 && Math.abs(u - pl.stopU) < 14));
        if (pl.stage === 'in' && atBox) {
          if (pl.why === 'garage') { c.pitPlan = null; garageMove(this, c, 'in'); }
          else { pl.stage = 'box'; this.startPitStop(c, (!c.isAI && c.tyreNext) || pl.tyre || this.defaultTyre(c)); }
        } else if (pl.stage === 'in' && pl.why === 'stop' && pl.waitT > 6) {
          // held up behind a car in the box for a long time: the tyres are changed where it stands
          pl.stage = 'box'; this.startPitStop(c, (!c.isAI && c.tyreNext) || pl.tyre || this.defaultTyre(c));
        } else if (pl.stage === 'in' && pl.waitT > 12 && pl.why === 'garage') {
          // held up for a long time further back: the car is wheeled into its garage
          const G = F1.garageSpots(T, c);
          c.pitPlan = null; c.x = G.spot.x; c.y = G.spot.y; c.a = G.spot.h; c.vx = 0; c.vy = 0; c.w = 0;
          c.gar = { k: 'park', at: this.time };
          this.events.push({ k: 'garage', id: c.id, on: true });
        } else if (pl.stage === 'out' && u > pi.total - 2 && u < pi.total + 300) c.pitPlan = null;
        else if (u > pi.total + 300 && u < L - 600) c.pitPlan = null;        // (lost: drive on)
      }
    }
    // a player in a race: into the pit lane = a pit stop. The car drives itself to your box, the tyres are changed
    // (the set you picked, or the best one for the laps left) and it drives itself out to the end of the pit lane.
    if (!c.isAI && this.type === 'race' && this.phase !== 'countdown' && !c.finished) {
      if (!c.inPit && !c.pitPlan) c.pitDone = false;
      else if (!c.pitPlan && !c.pitDone && c.inPit && c.d * Pt.side > T.hw + 1 && pi.u(c.s) < pi.limit0 + 10) {
        c.pitDone = true;
        c.pitPlan = { stage: 'in', why: 'stop', entered: true, stopU: pi.u(F1.garageSpots(T, c).sBox), auto: true };
        this.events.push({ k: 'pitIn', id: c.id });
      }
    }
    // a player: stop in front of your own garage (practice or qualifying) and the car is rolled in
    if (!c.isAI && (this.type === 'practice' || this.type === 'quali') && this.phase === 'running' && !c.qualiDone && !c.finished) {
      if (!c.gHome) c.gHome = { x: c.x, y: c.y };
      if (!c.gMoved && Math.hypot(c.x - c.gHome.x, c.y - c.gHome.y) > 25) c.gMoved = true;
      const G = F1.garageSpots(T, c);
      const near = c.inPit && Math.abs(wrapD(c.s - G.g.mid, L)) < 10 && Math.abs(c.d - Pt.side * Pt.boxOff) < 3.2;
      const sp = Math.hypot(c.vx, c.vy);
      c.gStill = near && sp < 0.6 ? c.gStill + dt : 0;
      if (c.gStill > 0.8 && c.gMoved && this.time - c.gExitT > 4) { c.gStill = 0; garageMove(this, c, 'in'); }
    }
  };

  /* A player in the garage: the "Go back out" button (or holding the accelerator) rolls the car out. */
  Session.prototype.garageInput = function (c, inp) {
    if (c.gar.k !== 'park') { c.goHold = 0; return; }
    if (inp.garageOut) { garageMove(this, c, 'out'); c.goHold = 0; return; }
    c.goHold = inp.throttle > 0.5 ? c.goHold + F1.DT : 0;
    if (c.goHold > 0.6) { garageMove(this, c, 'out'); c.goHold = 0; }
  };

  /* Tyres. A player picks: on the grid before the start = the tyres you start on; otherwise the set you get at your
     next pit stop (or when you leave your garage). k: 'S' | 'M' | 'H' | 'I' | 'W', or null = no pick. */
  Session.prototype.setTyreChoice = function (id, k) {
    const c = this.byId[id];
    if (!c || (k !== null && !TYRES[k])) return;
    if (k && this.type === 'race' && this.phase === 'countdown') {
      c.tyre = { c: k, w: 0, laps: 0 }; c.tyreHist = [k]; c.tg = F1.tyreGrip(k, 0, this.wetAt(c));
      c.usedWet = !SLICK[k] || F1.wetTyre(this.lineWet()) !== null;
    }
    else c.tyreNext = k;
  };
  /* The tyres a car gets when nobody has picked: rain tyres on a wet track; in a race the softest that lasts to the end. */
  Session.prototype.defaultTyre = function (c) {
    const lw = this.lineWet(), w = lw > 0.1 ? F1.wetTyre(Math.max(0.12, lw)) : null;
    if (w) return w;
    if (this.type !== 'race') return 'S';
    return F1.tyreForLaps(Math.max(1, this.laps - c.lapsDone - 1));
  };
  /* The weather over dt seconds (t: the time it is for; the session's own time if left out). Rain makes the track wet
     within a minute or two (a light shower: damp, intermediates; heavy rain: standing water, full wets); when it stops
     the track dries over several minutes, the racing line first (the cars running on it dry it). */
  Session.prototype.weatherStep = function (dt, t) {
    const r = F1.rainAt(this.wplan, t === undefined ? this.time : t);
    this.rain = r;
    const target = r > 0.02 ? Math.min(1, 0.12 + 1.05 * r) : 0;
    if (target > this.wet) this.wet += (target - this.wet) * Math.min(1, dt / 50);
    else this.wet = Math.max(target, this.wet - dt * 0.0016);
    if (r > 0.05) this.lineDry = Math.max(0, this.lineDry - dt * r / 25);
    else this.lineDry = Math.min(1, this.lineDry + dt / 110);
    if (target === 0 && this.wet < 0.003) { this.wet = 0; this.lineDry = 0; }      // dry again
  };
  /* How wet the racing line is (it dries before the rest of the track). */
  Session.prototype.lineWet = function () { return this.wet * (1 - 0.65 * this.lineDry); };
  /* How wet the track is under a car: drier on the racing line (within a metre or so of it) once it has started to dry. */
  Session.prototype.wetAt = function (c) {
    if (this.wet <= 0) return 0;
    const off = Math.abs(c.d - this.track.rlOff[c.seg]);
    return this.wet * (1 - 0.65 * this.lineDry * clamp(1 - (off - 1) / 3, 0, 1));
  };
  /* Weather messages: rain on the way (a minute before), rain (light / heavy), rain stopped; and for a player, when it
     is time for rain tyres or for slicks again. */
  Session.prototype.weatherNews = function () {
    const r = this.rain, wx = this.wx;
    if (r < 0.02 && this.wet < 0.1) {
      for (let i = 0; i < this.wplan.length; i++) {
        const sp = this.wplan[i];
        if (sp.t0 > this.time + 45 && sp.t0 < this.time + 75 && wx.soon !== i) { wx.soon = i; this.events.push({ k: 'rainSoon', heavy: sp.peak > 0.55 }); }
      }
    }
    const lvl = r > 0.55 ? 2 : r > 0.08 ? 1 : 0;
    if (lvl > wx.rain && (wx.stop || lvl === 2)) { this.events.push({ k: 'rain', n: lvl }); wx.rain = lvl; wx.stop = false; }
    if (r < 0.04 && !wx.stop) { this.events.push({ k: 'rainStop' }); wx.stop = true; wx.rain = 0; }
    const lw = this.lineWet();
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      if (c.isAI || c.out || c.finished || c.qualiDone || c.gar) continue;
      const need = weatherNeed(c.tyre.c, lw), key = need || '';
      if (key !== (c.wxTip || '')) {
        c.wxTip = key;
        if (need) this.events.push({ k: 'wxTyres', id: c.id, need: need });
      }
    }
  };

  /* A pit stop in a race: the car stands in its box while the tyres are changed (about 2.5 s; now and then a slow one). */
  Session.prototype.startPitStop = function (c, k) {
    let dur = 2.2 + this.rng() * 0.6;
    if (c.isAI && this.rng() < 0.05) dur += 1.5 + this.rng() * 2.5;
    c.pitStop = { t0: this.time, dur: dur, k: k };
    c.vx = 0; c.vy = 0; c.w = 0; c.slide = false;
    c.pitDone = true;
    this.events.push({ k: 'stop', id: c.id, tyre: k });
  };
  Session.prototype.pitStopStep = function (c) {
    const ps = c.pitStop;
    c.vx = 0; c.vy = 0; c.w = 0;
    if (this.time < ps.t0 + ps.dur) return;
    c.pitStop = null; c.stops++;
    c.tyre = { c: ps.k, w: 0, laps: 0 }; c.tyreHist.push(ps.k); c.tyreMsg = 0;
    if (!SLICK[ps.k]) c.usedWet = true;
    if (!c.isAI) c.tyreNext = null;
    if (c.pitPlan) c.pitPlan.stage = 'out';
    this.events.push({ k: 'stopDone', id: c.id, t: Math.round(ps.dur * 10) / 10, tyre: ps.k });
  };
  /* An AI car in a race (at the line, and at the start): time to come in at the end of this lap? As planned; earlier if
     the tyres are worn out; before the end if the compulsory stop is still to do; (the weather: see part 4). */
  Session.prototype.aiPitCall = function (c) {
    if (!c.isAI || c.finished || c.out || c.pitPlan || !this.track.pit || this.type !== 'race') return;
    const left = this.laps - c.lapsDone;              // laps to go, counting this one
    if (left < 1) return;
    let k = null, urgent = false;
    const next = c.strat && c.strat.stops.length > c.stops ? c.strat.stops[c.stops] : null;
    const lw = this.lineWet(), need = this.weatherOn ? weatherNeed(c.tyre.c, lw) : null;
    if (need) {
      // the weather has changed: rain tyres (or slicks again); on the last lap only for rain on slicks
      if (left >= 2 || (need !== 'dry' && lw > 0.35)) { k = need === 'dry' ? F1.tyreForLaps(Math.max(1, left - 1)) : need; urgent = true; }
    } else if (!SLICK[c.tyre.c]) {
      // on rain tyres in the rain: the dry plan waits; a worn-out set is changed for a new one
      if (this.tyres && c.tyre.w > 0.9 && left >= 3) { k = c.tyre.c; urgent = true; }
    }
    else if (next && c.lapsDone + 1 >= next.lap && left >= 2) k = next.c;
    else if (this.tyres && c.tyre.w > 0.86 && left >= 2) { k = F1.tyreForLaps(left - 1); urgent = true; }
    else if (this.mustStop && c.stops === 0 && !c.usedWet && left <= 2) { k = F1.tyreForLaps(left - 1); urgent = true; }
    if (k === null) return;
    // the team-mate is in the pits right now: wait a lap if there is time (they share the box)
    const mate = this.cars.find(function (o) { return o !== c && o.team === c.team && !o.out && o.pitPlan && o.pitPlan.why === 'stop'; });
    if (mate && !urgent && left > 2) return;
    c.pitPlan = { stage: 'in', why: 'stop', entered: false, tyre: k };
  };

  /* How many AI cars should be out on track now (see runShare). */
  Session.prototype.runTarget = function () {
    const ais = this.cars.filter(function (c) { return c.isAI && !c.out; }), n = ais.length;
    if (n <= 4) return n;
    let f;
    if (this.laps > 0) f = Math.min(1, this.time / ((this.laps + 1.6) * this.refLap * 1.02));
    else { const per = clamp(6 * this.refLap, 420, 720); f = (this.time % per) / per; }
    if (this.time - this.runMinAt > 45) {             // the quietest it gets: mostly 5 or 6 cars, sometimes 4
      const x = this.rng();
      this.runMin = x < 0.2 ? 4 : x < 0.6 ? 5 : 6;
      this.runMinAt = this.time;
    }
    let t = Math.max(Math.round(n * runShare(f)), Math.min(n, this.runMin));
    if (n <= 6) t = Math.max(t, n - 1);               // a small field stays out more
    return Math.min(n, t);
  };

  /* Practice traffic (twice a second): let cars out of their garages when too few are on track, bring a car in
     early when too many are. Runs end by themselves after their laps. */
  Session.prototype.practiceTraffic = function () {
    const self = this, target = this.runTarget();
    const ais = this.cars.filter(function (c) { return c.isAI && !c.out; });
    const isOut = function (c) { return !c.gar ? !(c.pitPlan && c.pitPlan.why === 'garage' && c.pitPlan.stage === 'in') : c.gar.k === 'out'; };
    const out = ais.filter(isOut);
    const short = this.laps > 0;
    if (out.length < target && this.time - this.runRelease > (short ? 2.5 : 4)) {
      let best = null;
      ais.forEach(function (c) {
        if (!c.gar || c.gar.k !== 'park') return;
        if (c.gDwell === undefined) c.gDwell = short ? 18 + self.rng() * 30 : 35 + self.rng() * 70;
        if (self.time - c.gar.at < c.gDwell) return;
        if (!best || c.gar.at < best.gar.at) best = c;
      });
      if (best) { best.gDwell = undefined; newRun(this, best); garageMove(this, best, 'out'); this.runRelease = this.time; }
    } else if (out.length > target + 1) {
      // too many out: the car that has done the most laps on this run comes in at the end of this lap
      let pick = null;
      out.forEach(function (c) { if (!c.gar && !c.pitPlan && c.run && c.run.n >= 1 && (!pick || c.run.n > pick.run.n)) pick = c; });
      if (pick) { pick.run.goal = pick.run.n; pick.pitPlan = { stage: 'in', why: 'garage', entered: false }; }
    }
  };

  /* Throttle while the red lights are on = jump start: the car creeps forward, the brakes hold it again,
     and 5 seconds are added to the race time. */
  Session.prototype.checkJumpStart = function (c) {
    if (!c.jumped) {
      if (this.lights < 1 || !c.input || !(c.input.throttle > 0.3)) return;
      c.jumped = true; c.penalty += 5; c.jumpX = c.x; c.jumpY = c.y;
      this.events.push({ k: 'jump', id: c.id });
    }
    if (Math.hypot(c.x - c.jumpX, c.y - c.jumpY) < 1.5) c.locked = false;
  };

  Session.prototype.resolveContacts = function () {
    const cars = this.cars, T = this.track;
    for (let i = 0; i < cars.length; i++) {
      const A = cars[i];
      if (A.out || A.gar) continue;
      for (let j = i + 1; j < cars.length; j++) {
        const B = cars[j];
        if (B.out || B.gar) continue;
        const dx = B.x - A.x, dy = B.y - A.y;
        if (dx * dx + dy * dy > 33) continue;
        if (T.bridge && F1.levelAt(T, A.s) * F1.levelAt(T, B.s) < 0) continue;   // one on the bridge, one underneath
        const imp = F1.collideCars(A, B, true);
        if (imp > 1500) this.fx.push([Math.round(F1.lastContact.x * 10) / 10, Math.round(F1.lastContact.y * 10) / 10, Math.round(imp)]);
      }
    }
  };

  Session.prototype.updatePhase = function () {
    if (this.phase !== 'countdown') return;
    const t = this.time;
    if (this.type === 'race') {
      const tl = t - this.gridT;                    // (with tyre wear: a few seconds to pick tyres before the lights)
      this.lights = tl >= 5.5 ? 5 : tl >= 4.5 ? 4 : tl >= 3.5 ? 3 : tl >= 2.5 ? 2 : tl >= 1.5 ? 1 : 0;
      if (t >= this.lightsOutAt) {
        this.phase = 'running';
        this.lights = 0;
        this.startTime = this.lightsOutAt;
        for (let i = 0; i < this.cars.length; i++) { this.cars[i].lapStart = this.startTime; this.aiPitCall(this.cars[i]); }
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
    // sector lines at one third and two thirds of the lap: each sector of a timed lap is timed on its own
    if (c.lapStart !== null && !c.finished) {
      if (c.secRef !== c.lapStart) { c.secRef = c.lapStart; c.secN = 0; }
      if (c.secN < 2) {
        const b = L * (c.secN + 1) / 3;
        if (passed(ps, ns, b, L)) {
          let d = ns - ps; if (d < 0) d += L;
          let rel = b - ps; if (rel < 0) rel += L;
          const at = this.time - dt + (rel / Math.max(1e-6, d)) * dt - c.lapStart;     // lap time at the sector line
          this.onSector(c, c.secN, at - (c.secN ? c.secAt : 0));
          c.secAt = at; c.secN++;
        }
      }
    }
    for (let z = 0; z < T.drs.length; z++) if (passed(ps, ns, T.drs[z].detect, L)) this.onDetection(c, z);
    c.raceDist = (c.lineCount - 1) * L + c.s;
    this.trackLimits(c, dt);
    // in trouble: off the track, pointing the wrong way or far slower than normal there (passing it is no overtake)
    if (this.type === 'race') {
      const prof = F1.speedProfile(T, 'medium');
      if (c.dist > T.hw + 0.5 || Math.abs(F1.wrapAngle(c.a - T.hd[c.seg])) > 0.6 || Math.hypot(c.vx, c.vy) < 0.55 * prof[c.seg]) c.troubleT = this.time;
    }
    if (this.type === 'race' && this.phase !== 'countdown' && c.raceDist >= 0 && !c.finished) {
      const li = Math.floor(c.raceDist / 50);
      if (li > c.loopIdx) {
        c.loopIdx = li;
        const f = this.loopFirst[li];
        if (f === undefined) { this.loopFirst[li] = this.time; c.gap = 0; } else c.gap = this.time - f;
      }
    }
  };

  Session.prototype.trackLimits = function (c, dt) {
    const T = this.track;
    if (this.phase === 'countdown' || this.phase === 'done' || c.finished || c.qualiDone) { c.tlOff = false; return; }
    const side = c.d > 0 ? 1 : -1;
    if (c.dist > tlEdge(T, c.seg)) {
      if (!c.tlOff) { c.tlOff = true; c.tlSide = side; c.tlS = c.s; c.tlDist = c.raceDist; c.tlT0 = this.time; c.tlPath = 0; c.tlBad = false; }
      c.tlPath += Math.hypot(c.vx, c.vy) * dt;
      // the pit entry and exit roads, a spin or a reset are not corner cutting
      if ((T.pit && side === T.pit.side && T.pitOff[c.seg] === T.pitOff[c.seg]) || c.inPit || side !== c.tlSide ||
          Math.abs(F1.wrapAngle(c.a - T.hd[c.seg])) > 1.2 || this.time - c.tlT0 > 40) c.tlBad = true;
      return;
    }
    if (!c.tlOff) return;
    c.tlOff = false;
    const prog = c.raceDist - c.tlDist;
    if (c.tlBad || c.resetCd > 2 || prog < 12) return;
    // a cut: a clearly shorter way than the track allows, or quicker than is possible on the track
    const legal = tlLegal(T, c.tlS, c.s, c.tlSide);
    const shorter = c.tlPath < legal - (2 + 0.04 * legal);
    const quicker = prog >= 30 && this.time - c.tlT0 < tlRefTime(T, c.tlS, c.s);
    if (shorter || quicker) this.cutCorner(c);
  };

  /* Practice and time trial: a warning only. Race and qualifying: 3 warnings, then 5 seconds for every cut
     (added to the race time, or in qualifying to the lap you are on). */
  Session.prototype.cutCorner = function (c) {
    const e = { k: 'tl', id: c.id, n: 0 };
    if (this.type !== 'practice') {
      e.n = ++c.tlWarn;
      if (c.tlWarn > 3) {
        if (this.type === 'race') { c.penalty += 5; e.pen = 5; }
        else if (c.lapStart !== null) { c.lapPen += 5; e.pen = 5; e.lap = true; }
      }
    }
    this.events.push(e);
  };

  Session.prototype.onLine = function (c, t) {
    c.tyre.laps++;
    if (c.run && !c.inPit) {
      c.run.n++;
      if (this.weatherOn && weatherNeed(c.tyre.c, this.lineWet())) c.run.goal = c.run.n;    // wrong tyres now: come in
      if (c.run.n >= c.run.goal && !c.pitPlan) c.pitPlan = { stage: 'in', why: 'garage', entered: false };
    }
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
      if (!c.finished) {
        this.aiPitCall(c);
        // a player who still has to make the compulsory stop: reminders over the last laps
        const left = this.laps - c.lapsDone;
        if (!c.isAI && this.mustStop && c.stops === 0 && !c.usedWet && !c.pitStop && left <= 3 && left >= 1) this.events.push({ k: 'mustStop', id: c.id, left: left });
      }
      return;
    }
    if (this.phase !== 'running' || c.qualiDone) return;
    if (c.inPit) { c.lapStart = null; c.lapPen = 0; return; }
    if (c.lapStart !== null) {
      this.recordLap(c, t - c.lapStart + c.lapPen, c.lapPen);
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
    c.lapPen = 0;
  };

  /* A sector of a timed lap is done (n = 0, 1, 2). Players get an event; 'best' = the fastest by anyone so far. */
  Session.prototype.onSector = function (c, n, t) {
    c.secT[n] = t;
    const best = this.secBest[n] === null || t < this.secBest[n];
    if (best) this.secBest[n] = t;
    if (!c.isAI) this.events.push({ k: 'sec', id: c.id, n: n, t: Math.round(t * 1000) / 1000, best: best && this.cars.length > 1 });
  };

  Session.prototype.recordLap = function (c, lt, pen) {
    // the third sector is the rest of the lap (when the first two were timed on this lap)
    let sec = null;
    if (c.secRef === c.lapStart && c.secN === 2) {
      const s3 = lt - (pen || 0) - c.secAt;
      c.secN = 3;
      if (s3 > 0) {
        this.onSector(c, 2, s3);
        sec = [Math.round(c.secT[0] * 1000) / 1000, Math.round(c.secT[1] * 1000) / 1000, Math.round(s3 * 1000) / 1000];
      }
    }
    c.lastLap = lt;
    c.laps.push(lt);
    const pb = c.bestLap === null || lt < c.bestLap;
    if (pb) c.bestLap = lt;
    const fastest = this.fastest === null || lt < this.fastest.time;
    if (fastest) this.fastest = { id: c.id, time: lt };
    const e = { k: 'lap', id: c.id, t: lt, pb: pb, fastest: fastest, n: c.laps.length };
    if (pen) e.pen = pen;
    if (sec && !c.isAI) e.sec = sec;
    this.events.push(e);
  };

  Session.prototype.finishCar = function (c, t) {
    c.finished = true;
    c.finishTime = t;
    if (this.mustStop && c.stops === 0 && !c.usedWet) {    // the compulsory pit stop was not made
      c.penalty += 30;
      this.events.push({ k: 'noStop', id: c.id });
    }
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
        // drivers who left: behind everyone still running, the later they left the higher they are placed
        if (a.out && b.out && (a.outAt || 0) !== (b.outAt || 0)) return (b.outAt || 0) - (a.outAt || 0);
        if (a.finished && b.finished) return a.finishPos - b.finishPos;
        if (a.finished !== b.finished) return a.finished ? -1 : 1;
        return b.raceDist - a.raceDist;
      });
    } else {
      arr.sort(function (a, b) {
        const da = a.out && !a.parked, db = b.out && !b.parked;
        if (da !== db) return da ? 1 : -1;
        const ab = a.bestLap === null ? Infinity : a.bestLap, bb = b.bestLap === null ? Infinity : b.bestLap;
        if (ab !== bb) return ab - bb;
        if (!!a.parked !== !!b.parked) return a.parked ? 1 : -1;     // gave up without a time: behind the others without one
        return a.slot - b.slot;
      });
    }
    for (let i = 0; i < arr.length; i++) arr[i].pos = i + 1;
    this.order = arr.map(function (c) { return c.id; });
    if (this.type === 'race') this.trackPasses();
  };

  /* Overtakes: a car has passed another once it is 8 m clear of it, having been 8 m behind (so two cars
     side by side don't count again and again). Lapping, passing a stopped or very slow car, or a car in
     the pit lane does not count. */
  Session.prototype.trackPasses = function () {
    if (this.phase !== 'running' && this.phase !== 'finishing') return;
    const cars = this.cars, n = cars.length;
    let st = this.passSt;
    if (!st) {
      st = this.passSt = new Int8Array(n * n);
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) st[i * n + j] = cars[i].raceDist >= cars[j].raceDist ? 1 : -1;
      return;
    }
    for (let i = 0; i < n; i++) {
      const A = cars[i];
      for (let j = i + 1; j < n; j++) {
        const B = cars[j], d = A.raceDist - B.raceDist, k = i * n + j;
        if (d > 8) { if (st[k] === -1) this.countPass(A, B); st[k] = 1; }
        else if (d < -8) { if (st[k] === 1) this.countPass(B, A); st[k] = -1; }
      }
    }
  };
  Session.prototype.countPass = function (A, B) {
    if (A.out || B.out || A.finished || B.finished || A.inPit || B.inPit) return;
    if (this.time - B.troubleT < 3) return;          // it had just gone off, spun or slowed right down
    A.overtakes++;
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
        if (this.humansDoneAt !== null && !this.waitForAll && this.time - this.humansDoneAt > (this.type === 'practice' ? 2.5 : 20)) end = true;
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
    let order = this.order.map(function (id) { return self.byId[id]; });
    if (this.type === 'race') {
      // time penalties: cars that end on the same lap are ordered by their time plus penalties (a car still on its
      // last lap: the leader's time plus its gap), so a big penalty (no pit stop: 30 s) can drop a car behind one
      // that has not crossed the line yet
      const lf = this.leaderFinishTime;
      const idx = new Map(order.map(function (c, i) { return [c, i]; }));
      const live = order.filter(function (c) { return !c.out; });
      const done = function (c) { return c.finished ? c.lapsDone : c.lapsDone + 1; };
      const est = function (c) { return c.finished ? c.finishTime + c.penalty : lf === null ? Infinity : lf + c.gap + c.penalty; };
      live.sort(function (a, b) {
        const d = done(b) - done(a);
        if (d) return d;
        const lead = done(a) >= self.laps;
        if (lead || (a.finished && b.finished)) return (est(a) - est(b)) || (idx.get(a) - idx.get(b));
        return idx.get(a) - idx.get(b);
      });
      order = live.concat(order.filter(function (c) { return c.out; }));
      this.order = order.map(function (c) { return c.id; });
      order.forEach(function (c, i) { c.pos = i + 1; });
      const w = order[0];
      const fl = this.fastest ? this.byId[this.fastest.id] : null;
      const rows = order.map(function (c, i) {
        let gap;
        if (c.out) gap = c.left ? 'LEFT' : 'DNF';
        else if (i === 0) gap = isFinite(est(w)) ? F1.fmtLap(est(w) - self.startTime) : 'LEADER';
        else if (done(c) >= done(w) && isFinite(est(c)) && isFinite(est(w))) gap = '+' + (est(c) - est(w)).toFixed(3) + 's';
        else {
          // not yet across the line: still on the lead lap -> time gap from the timing loops
          const behind = (w.lapsDone || self.laps) - c.lapsDone - (c.finished ? 0 : 1);
          if (behind <= 0) gap = '+' + (c.gap + c.penalty).toFixed(3) + 's';
          else gap = '+' + behind + (behind === 1 ? ' LAP' : ' LAPS');
        }
        // F1 points for the position (drivers who left are still classified, behind the others),
        // +1 for the fastest lap if that driver is in the top 10
        const isFl = c === fl, flPt = isFl && i < 10;
        const pts = (POINTS[i] || 0) + (flPt ? 1 : 0);
        return { pos: i + 1, id: c.id, driverId: c.driverId, isAI: c.isAI, name: c.name, laps: c.lapsDone, best: c.bestLap, gap: gap, out: c.out, left: !!c.left, pts: pts,
          grid: c.grid, gained: c.out ? 0 : c.grid - (i + 1), ovt: c.overtakes, pen: c.penalty, fl: isFl, flPt: flPt,
          tyres: self.tyres || self.weatherOn ? c.tyreHist.join('') : '' };
      });
      this.stats = this.raceStats(rows);
      return rows;
    }
    const pole = order.length && order[0].bestLap !== null ? order[0].bestLap : null;
    return order.map(function (c, i) {
      let gap = '';
      const dnf = c.out && !c.parked;
      if (dnf) gap = 'DNF';
      else if (c.bestLap === null) gap = 'NO TIME';
      else if (i === 0) gap = F1.fmtLap(c.bestLap);
      else gap = '+' + (c.bestLap - pole).toFixed(3) + 's';
      return { pos: i + 1, id: c.id, driverId: c.driverId, isAI: c.isAI, name: c.name, laps: c.lapsDone, best: c.bestLap, gap: gap, out: dnf, tl: c.tlWarn };
    });
  };

  /* Reverse grid: the qualifying order flipped, so the fastest starts last. Drivers without a lap time
     stay at the back (not setting a time must not put you on pole). Takes qualifying results, gives driver ids. */
  F1.reverseGrid = function (results) {
    const timed = results.filter(function (r) { return !r.out && r.best !== null && r.best !== undefined && r.best > 0; });
    const rest = results.filter(function (r) { return timed.indexOf(r) < 0; });
    return timed.slice().reverse().concat(rest).map(function (r) { return r.driverId; });
  };

  /* After the race: fastest lap, most overtakes, biggest climber and the Driver of the day
     (places gained, overtakes, a strong result and the fastest lap; penalties count against you). */
  Session.prototype.raceStats = function (rows) {
    const ok = rows.filter(function (r) { return !r.out; });
    const fl = rows.find(function (r) { return r.fl; });
    let most = null, climb = null, dotd = null, best = -Infinity;
    ok.forEach(function (r) {
      if (r.ovt > 0 && (!most || r.ovt > most.ovt)) most = r;
      if (r.gained > 0 && (!climb || r.gained > climb.gained)) climb = r;
      const score = 2 * r.gained + 1.5 * r.ovt + (r.pos === 1 ? 3 : r.pos <= 3 ? 2 : 0) + (r.fl ? 2 : 0) - r.pen / 2.5;
      if (score > best) { best = score; dotd = r; }
    });
    return {
      fastest: fl && this.fastest ? { id: fl.id, driverId: fl.driverId, time: this.fastest.time, point: fl.flPt } : null,
      mostOvertakes: most ? { id: most.id, driverId: most.driverId, n: most.ovt } : null,
      climber: climb ? { id: climb.id, driverId: climb.driverId, n: climb.gained, from: climb.grid, to: climb.pos } : null,
      dotd: dotd ? { id: dotd.id, driverId: dotd.driverId, grid: dotd.grid, pos: dotd.pos, ovt: dotd.ovt, fl: dotd.fl } : null
    };
  };

  /* Ending your practice or qualifying early: your car goes back to the garage and your best lap stands;
     the session then runs until everyone else has finished their laps. */
  Session.prototype.park = function (id) {
    const c = this.byId[id];
    if (!c || c.out) return;
    c.parked = true; c.out = true; c.qualiDone = true;
    c.vx = 0; c.vy = 0; c.w = 0; c.lapStart = null;
    this.waitForAll = true;
    this.updateOrder();
  };

  /* A driver leaves (online): the car is taken off the track. reason 'left' = the player left the room. */
  Session.prototype.retire = function (id, reason) {
    const c = this.byId[id];
    if (!c || c.out) return;
    c.out = true;
    c.outAt = this.time;
    if (reason === 'left') c.left = true;
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
