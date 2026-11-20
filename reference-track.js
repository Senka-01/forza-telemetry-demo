'use strict';

// Reference track data (TUMFTM/racetrack-database): centerline, widths and raceline in a local real-world frame.
// Forza reports positions in its own world frame, so the reference is aligned to a driven lap first:
// rotation, offset, optional mirror and a small scale are fitted automatically. Everything here is plain maths,
// shared by the analysis page and any other page that wants the track edges.
const ReferenceTrack = (() => {
  const SCALE_MIN = 0.93, SCALE_MAX = 1.07; // a fit outside this range means it is a different layout

  // Compact JSON ({center: [[x, y, wRight, wLeft], ...], raceline: [[x, y], ...]}) to point objects
  function parse(json) {
    if (!json || !Array.isArray(json.center) || json.center.length < 20) throw new Error('Invalid reference track data');
    const center = json.center.map((c) => ({ x: c[0], y: c[1], wr: c[2], wl: c[3] }));
    const raceline = Array.isArray(json.raceline) ? json.raceline.map((c) => ({ x: c[0], y: c[1] })) : [];
    return { name: json.name || '', length: json.length_m || 0, center, raceline };
  }

  // n points spaced evenly along a closed polyline
  function resampleClosed(points, n) {
    const m = points.length, cumulative = [0], lengths = [];
    for (let i = 0; i < m; i++) {
      const a = points[i], b = points[(i + 1) % m], d = Math.hypot(b.x - a.x, b.y - a.y);
      lengths.push(d); cumulative.push(cumulative[i] + d);
    }
    const total = cumulative[m], out = [];
    let j = 0;
    for (let i = 0; i < n; i++) {
      const s = total * i / n;
      while (j < m - 1 && cumulative[j + 1] < s) j++;
      const a = points[j], b = points[(j + 1) % m], f = lengths[j] ? (s - cumulative[j]) / lengths[j] : 0;
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    }
    return out;
  }

  // Scale, rotation and offset that best map points A onto points B (same order), least squares
  function procrustes(A, B) {
    const n = A.length;
    let ax = 0, ay = 0, bx = 0, by = 0;
    for (let i = 0; i < n; i++) { ax += A[i].x; ay += A[i].y; bx += B[i].x; by += B[i].y; }
    ax /= n; ay /= n; bx /= n; by /= n;
    let sx = 0, sy = 0, saa = 0;
    for (let i = 0; i < n; i++) {
      const p = A[i].x - ax, q = A[i].y - ay, u = B[i].x - bx, v = B[i].y - by;
      sx += p * u + q * v; sy += p * v - q * u; saa += p * p + q * q;
    }
    const rot = Math.atan2(sy, sx), scale = saa ? Math.hypot(sx, sy) / saa : 1;
    const c = Math.cos(rot), s = Math.sin(rot);
    return { scale, rot, tx: bx - scale * (c * ax - s * ay), tz: by - scale * (s * ax + c * ay) };
  }

  // Reference point (x, y) to Forza world (x, z)
  function apply(t, x, y) {
    const yy = t.mirror ? -y : y, c = Math.cos(t.rot), s = Math.sin(t.rot);
    return { x: t.scale * (c * x - s * yy) + t.tx, z: t.scale * (s * x + c * yy) + t.tz };
  }

  function rms(A, B, t) {
    let sum = 0;
    for (let i = 0; i < A.length; i++) { const p = apply(t, A[i].x, A[i].y); sum += (p.x - B[i].x) ** 2 + (p.z - B[i].y) ** 2; }
    return Math.sqrt(sum / A.length);
  }

  // Distance from a point to the closest point of a closed polyline (x, z)
  function distanceToPolyline(poly, x, z) {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
      const f = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
      best = Math.min(best, Math.hypot(x - a.x - f * dx, z - a.z - f * dz));
    }
    return best;
  }

  // Fit the reference to a driven lap. lapPoints: [{x, z}] along one lap (it should be a complete, closed lap).
  // Returns { mirror, reversed, rot, scale, tx, tz, rms, p95, median, ok }
  function fit(reference, lapPoints) {
    const lap = lapPoints.map((p) => ({ x: p.x, y: p.z }));
    const center = reference.center.map((c) => ({ x: c.x, y: c.y }));
    const N = 160, L = resampleClosed(lap, N);

    // 1. coarse search: try both mirror states, both directions and every circular shift
    let best = null;
    for (const mirror of [false, true]) {
      const base = resampleClosed(center.map((p) => ({ x: p.x, y: mirror ? -p.y : p.y })), N);
      for (const reversed of [false, true]) {
        const R = reversed ? base.slice().reverse() : base;
        for (let k = 0; k < N; k++) {
          const A = new Array(N);
          for (let i = 0; i < N; i++) A[i] = R[(i + k) % N];
          const t = procrustes(A, L);
          const c = Math.cos(t.rot), s = Math.sin(t.rot);
          let sum = 0;
          for (let i = 0; i < N; i++) {
            const x = t.scale * (c * A[i].x - s * A[i].y) + t.tx - L[i].x, y = t.scale * (s * A[i].x + c * A[i].y) + t.tz - L[i].y;
            sum += x * x + y * y;
          }
          const err = Math.sqrt(sum / N);
          if (!best || err < best.err) best = { err, mirror, t };
        }
      }
    }
    let t = { mirror: best.mirror, rot: best.t.rot, scale: best.t.scale, tx: best.t.tx, tz: best.t.tz };

    // 2. refine with ICP on dense points (nearest lap point for each reference point, worst 15% ignored)
    const lapDense = resampleClosed(lap, 700);
    const ref = center.map((p) => ({ x: p.x, y: t.mirror ? -p.y : p.y }));
    for (let iteration = 0; iteration < 30; iteration++) {
      const c = Math.cos(t.rot), s = Math.sin(t.rot), pairs = [];
      for (let i = 0; i < ref.length; i++) {
        const x = t.scale * (c * ref[i].x - s * ref[i].y) + t.tx, z = t.scale * (s * ref[i].x + c * ref[i].y) + t.tz;
        let nearest = 0, d2 = Infinity;
        for (let j = 0; j < lapDense.length; j++) {
          const d = (lapDense[j].x - x) ** 2 + (lapDense[j].y - z) ** 2;
          if (d < d2) { d2 = d; nearest = j; }
        }
        pairs.push({ i, j: nearest, d2 });
      }
      const keep = pairs.slice().sort((a, b) => a.d2 - b.d2).slice(0, Math.floor(pairs.length * 0.85));
      const next = procrustes(keep.map((p) => ref[p.i]), keep.map((p) => lapDense[p.j]));
      next.scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, next.scale));
      const moved = Math.hypot(next.tx - t.tx, next.tz - t.tz) + Math.abs(next.rot - t.rot) * 100;
      t = { mirror: t.mirror, rot: next.rot, scale: next.scale, tx: next.tx, tz: next.tz };
      if (moved < 0.01) break;
    }

    // 3. direction of travel: does the file order run with or against the lap? (majority vote, so figure-8 tracks work)
    const c = Math.cos(t.rot), s = Math.sin(t.rot), idx = [];
    for (let i = 0; i < ref.length; i++) {
      const x = t.scale * (c * ref[i].x - s * ref[i].y) + t.tx, z = t.scale * (s * ref[i].x + c * ref[i].y) + t.tz;
      let nearest = 0, d2 = Infinity;
      for (let j = 0; j < lapDense.length; j++) {
        const d = (lapDense[j].x - x) ** 2 + (lapDense[j].y - z) ** 2;
        if (d < d2) { d2 = d; nearest = j; }
      }
      idx.push(nearest);
    }
    let votes = 0;
    for (let i = 0; i < idx.length; i++) {
      let delta = idx[(i + 1) % idx.length] - idx[i];
      const half = lapDense.length / 2;
      if (delta > half) delta -= lapDense.length; else if (delta < -half) delta += lapDense.length;
      votes += Math.sign(delta);
    }
    const reversed = votes < 0;

    // 4. how well do they agree? distance from every driven point to the transformed centerline
    const poly = ref.map((p) => ({ x: t.scale * (c * p.x - s * p.y) + t.tx, z: t.scale * (s * p.x + c * p.y) + t.tz }));
    const errors = lapDense.map((p) => distanceToPolyline(poly, p.x, p.y)).sort((a, b) => a - b);
    const rmsValue = Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length);
    const p95 = errors[Math.floor(errors.length * 0.95)], median = errors[Math.floor(errors.length / 2)];
    const roundTo = (v, d) => +v.toFixed(d);
    return {
      mirror: t.mirror, reversed, rot: roundTo(t.rot, 5), scale: roundTo(t.scale, 5), tx: roundTo(t.tx, 2), tz: roundTo(t.tz, 2),
      rms: roundTo(rmsValue, 2), p95: roundTo(p95, 2), median: roundTo(median, 2),
      ok: p95 <= 40 && t.scale > SCALE_MIN + 0.001 && t.scale < SCALE_MAX - 0.001
    };
  }

  // Reference geometry in Forza coordinates, ordered along the driving direction:
  // center, left and right edges (left/right as seen driving, using Forza's x/z axes), and the raceline
  function align(reference, t) {
    const m = reference.center.length;
    const ordered = t.reversed ? reference.center.slice().reverse() : reference.center;
    const raw = ordered.map((c, i) => {
      // normals in the reference frame (x right, y up): right of travel = (dy, -dx)
      const a = ordered[(i - 1 + m) % m], b = ordered[(i + 1) % m];
      let dx = b.x - a.x, dy = b.y - a.y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      // widths belong to the original file direction, so swap them if the order was reversed
      const wr = t.reversed ? c.wl : c.wr, wl = t.reversed ? c.wr : c.wl;
      return {
        center: apply(t, c.x, c.y),
        right: apply(t, c.x + dy * wr, c.y - dx * wr),
        left: apply(t, c.x - dy * wl, c.y + dx * wl)
      };
    });
    // which transformed edge is on the left of travel in Forza's x/z plane? (left normal = (-dz, dx))
    let score = 0;
    for (let i = 0; i < m; i++) {
      const a = raw[(i - 1 + m) % m].center, b = raw[(i + 1) % m].center, p = raw[i];
      const nx = -(b.z - a.z), nz = b.x - a.x;
      score += (p.left.x - p.center.x) * nx + (p.left.z - p.center.z) * nz;
    }
    const swap = score < 0;
    const center = raw.map((p) => p.center);
    const left = raw.map((p) => (swap ? p.right : p.left)), right = raw.map((p) => (swap ? p.left : p.right));
    const raceline = (t.reversed ? reference.raceline.slice().reverse() : reference.raceline).map((p) => apply(t, p.x, p.y));
    return { center, left, right, raceline };
  }

  // Where a driven point sits on the track: signed offset from the centerline (positive = left of travel),
  // the half-width on that side, and the fraction of the way to the edge (+-1 = on the edge)
  function position(aligned, x, z) {
    const { center, left, right } = aligned, m = center.length;
    let best = null;
    for (let i = 0; i < m; i++) {
      const a = center[i], b = center[(i + 1) % m], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
      if (!l2) continue;
      const f = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
      const px = a.x + f * dx, pz = a.z + f * dz, d = Math.hypot(x - px, z - pz);
      if (!best || d < best.d) best = { d, i, f, px, pz, dx, dz, l: Math.sqrt(l2) };
    }
    if (!best) return null;
    const side = (-best.dz * (x - best.px) + best.dx * (z - best.pz)) / best.l;       // + = left of travel
    const j = (best.i + 1) % m;
    const edge = (list, k) => Math.hypot(list[k].x - center[k].x, list[k].z - center[k].z);
    const halfLeft = edge(left, best.i) * (1 - best.f) + edge(left, j) * best.f;
    const halfRight = edge(right, best.i) * (1 - best.f) + edge(right, j) * best.f;
    const half = side >= 0 ? halfLeft : halfRight;
    return { offset: side, halfLeft, halfRight, fraction: half ? side / half : 0, index: best.i };
  }

  return { parse, fit, apply, align, position, resampleClosed, SCALE_MIN, SCALE_MAX };
})();

if (typeof module !== 'undefined') module.exports = ReferenceTrack;
