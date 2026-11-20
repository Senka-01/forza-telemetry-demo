'use strict';

const TrackAnalysis = (() => {
  const GAP_MS = 1000;
  const FIELDS = ['x', 'z', 'speed', 'throttle', 'brake', 'gLat', 'gLong', 'steer', 'lineErr', 'aiBrake'];
  const validPosition = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.z) && (p.x !== 0 || p.z !== 0);
  const validPoint = (p) => validPosition(p) && Number.isFinite(p.speed) && p.speed >= 0;
  const connected = (a, b) => validPoint(a) && validPoint(b) && b.t > a.t && b.t - a.t <= GAP_MS &&
    Math.hypot(b.x - a.x, b.z - a.z) <= 300;

  function interpolate(a, b, fraction) {
    const result = { t: a.t + (b.t - a.t) * fraction };
    FIELDS.forEach((key) => {
      result[key] = Number.isFinite(a[key]) && Number.isFinite(b[key])
        ? a[key] + (b[key] - a[key]) * fraction : null;
    });
    return result;
  }

  function pointAtTime(points, time) {
    let low = 0, high = points.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (points[mid].t < time) low = mid + 1;
      else high = mid;
    }
    if (low < points.length && points[low].t === time) return validPoint(points[low]) ? { ...points[low] } : null;
    if (!low || low === points.length || !connected(points[low - 1], points[low])) return null;
    const a = points[low - 1], b = points[low];
    return interpolate(a, b, (time - a.t) / (b.t - a.t));
  }

  function buildLaps(points, runs) {
    return runs.map((run) => {
      const first = pointAtTime(points, run.startedAt);
      if (!first) return null;
      const end = Math.min(run.endedAt ?? Infinity, run.invalidAt ?? Infinity);
      const samples = [{ ...first, distance: 0 }];
      let interrupted = false;
      const append = (point) => {
        const previous = samples[samples.length - 1];
        if (!connected(previous, point)) { interrupted = true; return false; }
        samples.push({ ...point, distance: previous.distance + (previous.speed + point.speed) / 2 * (point.t - previous.t) / 1000 });
        return true;
      };
      for (const point of points) {
        if (point.t <= run.startedAt) continue;
        if (point.t >= end) break;
        if (!append(point)) break;
      }
      if (!interrupted && run.endedAt !== null && run.endedAt <= (run.invalidAt ?? Infinity)) {
        const last = pointAtTime(points, run.endedAt);
        if (!last || !append(last)) interrupted = true;
      }
      if (samples.length < 2) return null;
      return { lap: run.lap, startedAt: run.startedAt, endedAt: run.endedAt, anchored: true,
        interrupted: interrupted || run.invalidAt !== null, samples, length: samples[samples.length - 1].distance };
    }).filter(Boolean);
  }

  function partialLap(points) {
    let best = [], current = [];
    for (const point of points) {
      if (!validPoint(point) || !Number.isFinite(point.t)) { current = []; continue; }
      const previous = current[current.length - 1];
      if (previous && (!connected(previous, point) || point.lap !== previous.lap ||
          !Number.isFinite(point.lapTime) || !Number.isFinite(previous.lapTime) ||
          Math.abs(point.lapTime - previous.lapTime - (point.t - previous.t) / 1000) > 0.5)) current = [];
      const last = current[current.length - 1];
      current.push({ ...point, distance: last ? last.distance + (last.speed + point.speed) / 2 * (point.t - last.t) / 1000 : 0 });
      if (current.length > best.length) best = current;
    }
    if (best.length < 2) return null;
    return { lap: Number.isFinite(best[0].lap) ? best[0].lap + 1 : '?', startedAt: best[0].t, endedAt: null,
      anchored: false, interrupted: false, samples: best, length: best[best.length - 1].distance };
  }

  function atDistance(lap, distance) {
    const samples = lap.samples;
    if (!Number.isFinite(distance) || distance < 0 || distance > lap.length) return null;
    let low = 0, high = samples.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (samples[mid].distance < distance) low = mid + 1;
      else high = mid;
    }
    if (low === 0 || samples[low].distance === distance) return { ...samples[low] };
    const a = samples[low - 1], b = samples[low], span = b.distance - a.distance;
    if (span <= 0) return { ...b };
    return { ...interpolate(a, b, (distance - a.distance) / span), distance };
  }

  function estimateTurns(lap) {
    const candidates = [];
    for (let d = 40; d + 40 <= lap.length; d += 20) {
      const a = atDistance(lap, d - 40), b = atDistance(lap, d), c = atDistance(lap, d + 40);
      const x1 = b.x - a.x, z1 = b.z - a.z, x2 = c.x - b.x, z2 = c.z - b.z;
      if (Math.hypot(x1, z1) < 5 || Math.hypot(x2, z2) < 5) continue;
      const angle = Math.abs(Math.atan2(x1 * z2 - z1 * x2, x1 * x2 + z1 * z2));
      if (angle >= 0.12) candidates.push({ distance: d, angle });
    }
    const turns = [];
    for (const candidate of candidates) {
      const previous = turns[turns.length - 1];
      if (previous && candidate.distance - previous.last <= 40) {
        previous.last = candidate.distance;
        if (candidate.angle > previous.angle) { previous.distance = candidate.distance; previous.angle = candidate.angle; }
      } else turns.push({ ...candidate, last: candidate.distance });
    }
    return turns.map((turn) => turn.distance);
  }

  function pedalOnsets(lap, field, threshold = 0.05) {
    const result = [];
    for (let i = 1; i < lap.samples.length; i++) {
      const a = lap.samples[i - 1], b = lap.samples[i];
      if (Number.isFinite(a[field]) && Number.isFinite(b[field]) && a[field] <= threshold && b[field] > threshold) result.push(b);
    }
    return result;
  }

  // Nearest point of a lap to the map position (x, z), searched within +-window metres of the expected distance.
  // With a heading (hx, hz), segments pointing more than 60 degrees away from it are skipped.
  function locate(lap, x, z, expected, window, hx = 0, hz = 0, maxError = 35) {
    if (!lap || !lap.samples || lap.samples.length < 2) return null;
    const headingLength = Math.hypot(hx, hz);
    let best = null;
    for (let i = 1; i < lap.samples.length; i++) {
      const a = lap.samples[i - 1], b = lap.samples[i];
      if (b.distance < expected - window || a.distance > expected + window) continue;
      const dx = b.x - a.x, dz = b.z - a.z, length2 = dx * dx + dz * dz;
      if (!length2) continue;
      if (headingLength && (dx * hx + dz * hz) / (Math.sqrt(length2) * headingLength) < 0.5) continue;
      const f = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / length2));
      const error = Math.hypot(x - a.x - dx * f, z - a.z - dz * f);
      if (!best || error < best.error) best = { ...interpolate(a, b, f), distance: a.distance + (b.distance - a.distance) * f, error };
    }
    return best && best.error <= maxError ? best : null;
  }

  function matchPosition(reference, other, point) {
    if (!point || !other || !reference.length || !other.length) return null;
    const expected = point.distance / reference.length * other.length;
    const window = Math.max(150, other.length * 0.12);
    const before = atDistance(reference, Math.max(0, point.distance - 8));
    const after = atDistance(reference, Math.min(reference.length, point.distance + 8));
    return locate(other, point.x, point.z, expected, window, after.x - before.x, after.z - before.z);
  }

  function compareRegion(reference, other, startDistance, endDistance) {
    const start = atDistance(reference, startDistance), end = atDistance(reference, endDistance);
    if (!start || !end || !other) return null;
    const otherStart = matchPosition(reference, other, start), otherEnd = matchPosition(reference, other, end);
    const length = endDistance - startDistance;
    if (length <= 0 || !otherStart || !otherEnd || otherEnd.t <= otherStart.t ||
        otherEnd.distance - otherStart.distance < length * 0.4 ||
        otherEnd.distance - otherStart.distance > length * 1.8) return null;
    const referenceSeconds = (end.t - start.t) / 1000;
    const otherSeconds = (otherEnd.t - otherStart.t) / 1000;
    return { referenceSeconds, otherSeconds, delta: referenceSeconds - otherSeconds };
  }

  function compareTurn(reference, other, distance) {
    const start = atDistance(reference, distance - 60), end = atDistance(reference, distance + 60);
    if (!start || !end || !other) return null;
    const otherStart = matchPosition(reference, other, start), otherEnd = matchPosition(reference, other, end);
    if (!otherStart || !otherEnd || otherEnd.t <= otherStart.t ||
        otherEnd.distance - otherStart.distance < 50 || otherEnd.distance - otherStart.distance > 220) return null;
    const referenceSeconds = (end.t - start.t) / 1000;
    const otherSeconds = (otherEnd.t - otherStart.t) / 1000;
    return { referenceSeconds, otherSeconds, delta: referenceSeconds - otherSeconds };
  }

  function cornerRegions(lap, turns) {
    const regions = turns.map((apex, index) => {
      const lower = index ? (turns[index - 1] + apex) / 2 : 0;
      const upper = index + 1 < turns.length ? (apex + turns[index + 1]) / 2 : lap.length;
      const curvature = (distance) => {
        const a = atDistance(lap, Math.max(lower, distance - 20));
        const b = atDistance(lap, distance);
        const c = atDistance(lap, Math.min(upper, distance + 20));
        const x1 = b.x - a.x, z1 = b.z - a.z, x2 = c.x - b.x, z2 = c.z - b.z;
        if (Math.hypot(x1, z1) < 3 || Math.hypot(x2, z2) < 3) return 0;
        return Math.atan2(x1 * z2 - z1 * x2, x1 * x2 + z1 * z2);
      };
      const angleAtApex = curvature(apex);
      const detected = Math.abs(angleAtApex) >= 0.06;
      let entry = Math.max(lower, apex - 30), exit = Math.min(upper, apex + 30);
      if (detected) {
        entry = apex;
        exit = apex;
        while (entry - 10 >= lower && curvature(entry - 10) * Math.sign(angleAtApex) >= 0.04) entry -= 10;
        while (exit + 10 <= upper && curvature(exit + 10) * Math.sign(angleAtApex) >= 0.04) exit += 10;
        entry = Math.max(lower, entry - 10);
        exit = Math.min(upper, exit + 10);
      }
      const before = atDistance(lap, entry), middle = atDistance(lap, apex), after = atDistance(lap, exit);
      const x1 = middle.x - before.x, z1 = middle.z - before.z;
      const x2 = after.x - middle.x, z2 = after.z - middle.z;
      const angle = Math.abs(Math.atan2(x1 * z2 - z1 * x2, x1 * x2 + z1 * z2));
      const radius = Math.abs(angleAtApex) > 0 ? 20 / (2 * Math.sin(Math.abs(angleAtApex) / 2)) : 0;
      return { index, apex, entry, exit, detected, direction: Math.sign(angleAtApex), angle, minRadius: radius };
    });
    regions.forEach((region, index) => {
      region.zoneStart = index ? (regions[index - 1].exit + region.entry) / 2 : 0;
      region.zoneEnd = index + 1 < regions.length ? (region.exit + regions[index + 1].entry) / 2 : lap.length;
      region.approachStart = region.zoneStart;
    });
    return regions;
  }

  function cornerMetrics(lap, region) {
    const inRange = (start, end) => lap.samples.filter((p) => p.distance >= start && p.distance <= end);
    const maximum = (points, field) => {
      const values = points.map((p) => p[field]).filter(Number.isFinite);
      return values.length ? Math.max(...values) : null;
    };
    const average = (points, field, absolute = false) => {
      const values = points.map((p) => p[field]).filter(Number.isFinite);
      return values.length ? values.reduce((sum, value) => sum + (absolute ? Math.abs(value) : value), 0) / values.length : null;
    };
    const corner = inRange(region.entry, region.exit);
    const speeds = corner.map((p) => p.speed).filter(Number.isFinite);
    const braking = pedalOnsets(lap, 'brake').filter((p) => p.distance >= region.approachStart && p.distance <= region.apex);
    const throttle = pedalOnsets(lap, 'throttle', 0.5).find((p) => p.distance >= region.apex && p.distance <= region.zoneEnd);
    const exit = atDistance(lap, region.exit);
    return {
      brakeBefore: braking.length ? region.entry - braking[braking.length - 1].distance : null,
      peakBrake: maximum(inRange(region.approachStart, region.exit), 'brake'),
      minSpeed: speeds.length ? Math.min(...speeds) : null,
      exitSpeed: exit && Number.isFinite(exit.speed) ? exit.speed : null,
      throttleAfter: throttle ? throttle.distance - region.apex : null,
      lineErr: average(corner, 'lineErr', true),
      aiBrake: average(inRange(region.approachStart, region.entry), 'aiBrake')
    };
  }

  function deltaProfile(reference, other) {
    const start = atDistance(reference, 0);
    const otherStart = matchPosition(reference, other, start);
    const profile = [];
    for (let distance = 0; distance <= reference.length; distance += 10) {
      const point = atDistance(reference, distance);
      const match = otherStart && matchPosition(reference, other, point);
      profile.push({ distance, delta: match && match.distance >= otherStart.distance
        ? ((point.t - start.t) - (match.t - otherStart.t)) / 1000 : null });
    }
    return profile;
  }

  // ---- Coaching ----
  // Turn markers saved by the analysis page ({x, z, h} map positions) projected onto a lap, as distances
  function projectMarkers(lap, saved) {
    const found = [];
    (saved || []).forEach((t) => {
      if (!t || !Number.isFinite(t.x) || !Number.isFinite(t.z)) return;
      let best = null;
      for (let i = 1; i < lap.samples.length; i++) {
        const a = lap.samples[i - 1], b = lap.samples[i], dx = b.x - a.x, dz = b.z - a.z, length2 = dx * dx + dz * dz;
        if (!length2) continue;
        if (Number.isFinite(t.h) && Math.cos(Math.atan2(dz, dx) - t.h) < 0.5) continue;
        const f = Math.max(0, Math.min(1, ((t.x - a.x) * dx + (t.z - a.z) * dz) / length2));
        const error = Math.hypot(t.x - a.x - f * dx, t.z - a.z - f * dz);
        if (!best || error < best.error) best = { error, distance: a.distance + (b.distance - a.distance) * f };
      }
      if (best && best.error <= 40) found.push(best.distance);
    });
    found.sort((x, y) => x - y);
    return found.filter((d, i) => !i || d - found[i - 1] > 10);
  }

  // Does this lap carry the game's AI brake comparison? (sessions recorded before it was added have none)
  function hasAiBrake(lap) {
    if (!lap) return false;
    if (lap.hasAiBrake === undefined) lap.hasAiBrake = lap.samples.some((p) => Number.isFinite(p.aiBrake) && p.aiBrake !== 0);
    return lap.hasAiBrake;
  }

  // Braking phases between the start of a corner's approach and its apex. source 'brake' = your pedal;
  // 'ai' = the game AI at the same spot: aiBrake is the AI's braking minus yours (-1..1), so the AI brakes brake + aiBrake.
  // A release shorter than 15 m does not split a phase. drop = speed lost during the phase (m/s).
  function brakePhases(lap, region, source = 'brake') {
    if (!lap || !region) return [];
    if (source === 'ai' && !hasAiBrake(lap)) return [];
    const threshold = source === 'ai' ? 0.1 : 0.05;
    const value = source === 'ai'
      ? (p) => (Number.isFinite(p.aiBrake) && Number.isFinite(p.brake) ? p.brake + p.aiBrake : null)
      : (p) => (Number.isFinite(p.brake) ? p.brake : null);
    const phases = [];
    let current = null;
    for (const p of lap.samples) {
      if (p.distance < region.approachStart) continue;
      if (p.distance > region.apex) break;
      const v = value(p);
      if (v === null || v <= threshold) {
        if (current && p.distance - current.endDistance > 15) current = null;
        continue;
      }
      if (!current) {
        current = { distance: p.distance, speed: p.speed, point: p, peak: v, endDistance: p.distance, minSpeed: p.speed };
        phases.push(current);
      }
      current.peak = Math.max(current.peak, v);
      current.endDistance = p.distance;
      current.minSpeed = Math.min(current.minSpeed, p.speed);
    }
    phases.forEach((ph) => { ph.drop = ph.speed - ph.minSpeed; });
    return phases;
  }

  // Where the braking for a corner starts. Without near: the last strong phase before the apex (losing at least half
  // as much speed as the biggest one, or for the AI reaching half its biggest peak). With near (a distance on this lap):
  // the phase starting closest to it, within 150 m, so the same braking is compared on two laps or against the AI.
  function brakePoint(lap, region, source = 'brake', near = null) {
    const phases = brakePhases(lap, region, source);
    if (!phases.length) return null;
    if (Number.isFinite(near)) {
      const best = phases.reduce((m, ph) => (!m || Math.abs(ph.distance - near) < Math.abs(m.distance - near) ? ph : m), null);
      return Math.abs(best.distance - near) <= 150 ? best : null;
    }
    const score = (ph) => (source === 'ai' ? ph.peak : Math.max(ph.drop, 0.01));
    const top = Math.max(...phases.map(score));
    return phases.filter((ph) => score(ph) >= top * 0.5).pop();
  }

  // Time every lap spends in each corner zone (halfway from the previous corner to halfway to the next),
  // measured at the reference lap's map positions. best = the quickest run through that zone.
  function cornerTimes(reference, laps, regions) {
    return regions.map((region) => {
      const runs = [];
      laps.forEach((l, index) => {
        let seconds = null;
        if (l === reference) {
          const a = atDistance(reference, region.zoneStart), b = atDistance(reference, Math.min(reference.length, region.zoneEnd));
          if (a && b) seconds = (b.t - a.t) / 1000;
        } else {
          const c = compareRegion(reference, l, region.zoneStart, Math.min(reference.length, region.zoneEnd));
          if (c) seconds = c.otherSeconds;
        }
        if (Number.isFinite(seconds) && seconds > 0) runs.push({ lap: l, index, seconds });
      });
      const best = runs.reduce((m, r) => (!m || r.seconds < m.seconds ? r : m), null);
      const mine = runs.find((r) => r.lap === reference) || null;
      return { region, runs, best, mine, lost: mine && best ? mine.seconds - best.seconds : null };
    });
  }

  // Seconds into the lap at a distance along it
  function lapTimeAt(lap, distance) {
    const p = atDistance(lap, Math.max(0, Math.min(lap.length, distance)));
    return p ? (p.t - lap.samples[0].t) / 1000 : null;
  }

  // ---- Off-track detection ----
  // Recorded per point: surf = SurfaceRumble per tire (about 0.0 on asphalt), kerb = WheelOnRumbleStrip per tire (1 on a kerb).
  // A tire is off track when its surface rumble is above the threshold and it is not on a kerb.
  // threshold:    SurfaceRumble above this counts as off the asphalt (the page lets you change it)
  // minSeconds:   shorter events are ignored (one 30 Hz sample is 0.033 s)
  // mergeSeconds: two events closer together than this count as one
  const OFF_TRACK = { threshold: 0.1, minSeconds: 0.1, mergeSeconds: 0.25 };
  const TIRES = ['fl', 'fr', 'rl', 'rr'];
  const hasSurface = (p) => !!(p && p.surf && typeof p.surf === 'object');

  // Tires off track at one point: [] = all on track, null = no surface data (sessions recorded before this was added)
  function tiresOff(p, threshold = OFF_TRACK.threshold) {
    if (!hasSurface(p)) return null;
    return TIRES.filter((k) => Number.isFinite(p.surf[k]) && p.surf[k] > threshold && !(p.kerb && p.kerb[k]));
  }
  function tiresOnKerb(p) {
    return p && p.kerb ? TIRES.filter((k) => p.kerb[k]) : [];
  }

  // Off-track events along a lap, or null when the lap has no surface data
  function offTrackEvents(lap, options = {}) {
    const o = { ...OFF_TRACK, ...options };
    const s = lap && lap.samples;
    if (!s || !s.some(hasSurface)) return null;
    const events = [];
    let current = null;
    for (let i = 0; i < s.length; i++) {
      const p = s[i], off = tiresOff(p, o.threshold);
      if (!off || !off.length) continue;
      const next = s[i + 1];
      // time this sample stands for: up to the next sample (a gap longer than 1 s counts as one 30 Hz sample)
      const dt = next && next.t - p.t <= GAP_MS ? (next.t - p.t) / 1000 : 1 / 30;
      const endT = p.t + dt * 1000;
      if (!current || (p.t - current.endT) / 1000 > o.mergeSeconds) {
        current = { startDistance: p.distance, endDistance: p.distance, startT: p.t, endT, seconds: 0,
          tireSeconds: { fl: 0, fr: 0, rl: 0, rr: 0 }, maxTires: 0, peak: 0, worst: p };
        events.push(current);
      }
      current.seconds += dt;
      current.endT = endT;
      current.endDistance = next ? next.distance : p.distance;
      off.forEach((k) => {
        current.tireSeconds[k] += dt;
        current.peak = Math.max(current.peak, p.surf[k]);
      });
      if (off.length > current.maxTires) { current.maxTires = off.length; current.worst = p; }
    }
    return events
      .filter((e) => e.seconds >= o.minSeconds - 1e-9)
      .map((e) => ({ ...e, tires: TIRES.filter((k) => e.tireSeconds[k] > 0), allFour: e.maxTires === 4 }));
  }

  // Totals for a list of events (all of a lap's, or the ones in one corner)
  function offTrackTotals(events) {
    const totals = { count: 0, seconds: 0, allFour: 0, tireSeconds: { fl: 0, fr: 0, rl: 0, rr: 0 } };
    (events || []).forEach((e) => {
      totals.count++; totals.seconds += e.seconds; if (e.allFour) totals.allFour++;
      TIRES.forEach((k) => { totals.tireSeconds[k] += e.tireSeconds[k]; });
    });
    return totals;
  }

  // Surface rumble readings off the kerbs on a lap, to help pick a threshold (asphalt should sit near 0)
  function surfaceStats(lap) {
    const values = [];
    (lap && lap.samples || []).forEach((p) => {
      if (!hasSurface(p)) return;
      TIRES.forEach((k) => { if (Number.isFinite(p.surf[k]) && !(p.kerb && p.kerb[k])) values.push(p.surf[k]); });
    });
    if (!values.length) return null;
    values.sort((a, b) => a - b);
    const at = (q) => values[Math.min(values.length - 1, Math.floor(q * values.length))];
    return { median: at(0.5), p95: at(0.95), max: values[values.length - 1] };
  }

  return { buildLaps, partialLap, atDistance, estimateTurns, pedalOnsets, locate, matchPosition, compareTurn,
    cornerRegions, cornerMetrics, compareRegion, deltaProfile,
    projectMarkers, hasAiBrake, brakePhases, brakePoint, cornerTimes, lapTimeAt,
    OFF_TRACK, TIRES, tiresOff, tiresOnKerb, offTrackEvents, offTrackTotals, surfaceStats };
})();

if (typeof module !== 'undefined') module.exports = TrackAnalysis;
