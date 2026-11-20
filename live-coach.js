'use strict';

// Live driving coach for the main page: delta against the best lap, a result after each corner, an end-of-lap
// summary with a marker at the corner that cost the most, and the chase (heading-up) map view.
// Corner detection and lap matching come from TrackAnalysis (analysis-core.js), the same code as the analysis page.
// Reads dashboard.js globals: trackSelect, canonicalTrack, carTable, LAP_OFFSET, trackOutline, trackPts, mapFlip,
// refAligned, refShown, refOption.
const LiveCoach = (() => {
  const MPH = 2.237;
  const FLASH_MS = 6000;           // a corner result stays bright this long, then dims until the next corner
  const DELTA_FULL = 1.0;          // seconds shown as a full bar
  const CHASE_KEY = 'liveMap:chase';
  const $ = (id) => document.getElementById(id);

  let key = '';                    // track|car the best lap belongs to
  let best = null;                 // { lap, seconds, t0, label, regions, saved }
  let sessionBest = null;          // best clean lap driven while this page was open
  let loadId = 0, loading = false;
  let cur = null;                  // lap being driven
  let flash = null;                // { at, index, delta, text }
  let summary = null;              // end-of-lap summary
  let marker = null;               // { x, z, label } corner that cost the most on the last lap
  let heading = null, headingFrom = null;
  let chase = false;
  let lastDraw = 0;

  // ---------- best lap ----------
  const fmt = (t) => {
    if (!Number.isFinite(t) || t <= 0) return '--:--.---';
    const m = Math.floor(t / 60);
    return m + ':' + (t - m * 60).toFixed(3).padStart(6, '0');
  };
  const signed = (v, digits = 2) => {
    const r = Number(v.toFixed(digits));
    return (r > 0 ? '+' : r < 0 ? '−' : '±') + Math.abs(r).toFixed(digits);
  };

  function savedTurns(lap) {
    try {
      const raw = localStorage.getItem('trackAnalysis:track:' + canonicalTrack(trackSelect.value).toLowerCase());
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && Array.isArray(parsed.turns) && parsed.turns.length) {
        const turns = TrackAnalysis.projectMarkers(lap, parsed.turns);
        if (turns.length) return turns;
      }
    } catch (e) { /* fall back to estimated turns */ }
    return TrackAnalysis.estimateTurns(lap);
  }

  function setBest(lap, seconds, t0, label, saved) {
    const regions = TrackAnalysis.cornerRegions(lap, savedTurns(lap)).map((r) => {
      const apex = TrackAnalysis.atDistance(lap, r.apex);
      const inCorner = lap.samples.filter((p) => p.distance >= r.entry && p.distance <= r.exit).map((p) => p.speed);
      const exit = TrackAnalysis.atDistance(lap, r.exit);
      return {
        ...r, x: apex.x, z: apex.z,
        flashAt: Math.min(r.zoneEnd, r.exit + 40),
        brake: TrackAnalysis.brakePoint(lap, r),
        minSpeed: inCorner.length ? Math.min(...inCorner) : null,
        exitSpeed: exit ? exit.speed : null
      };
    });
    best = { lap, seconds, t0, label, regions, saved };
    if (cur) { cur.corners = []; cur.matched = false; }
  }

  const lapDuration = (l) => (l.samples[l.samples.length - 1].t - l.samples[0].t) / 1000;
  // Complete laps from a recorded session; a last lap without a recorded finish counts when it covers the whole distance
  // (restarts and rewinds can leave short pieces that look like laps: a lap must also end where it started and be
  // about as long as the longest one)
  function fullLaps(points) {
    const closed = (l) => {
      const a = l.samples[0], b = l.samples[l.samples.length - 1];
      return l.length > 500 && Math.hypot(a.x - b.x, a.z - b.z) < 150;
    };
    const laps = TrackAnalysis.buildLaps(points, SectorAnalysis.calculate(points)).filter((l) => l.anchored && !l.interrupted && closed(l));
    const finished = laps.filter((l) => l.endedAt !== null);
    const longest = finished.length ? Math.max(...finished.map((l) => l.length)) : 0;
    return laps.filter((l) => longest && (l.endedAt !== null ? l.length >= longest * 0.9 : l.length >= longest * 0.985));
  }
  function fastest(points) {
    const sorted = (points || []).filter((p) => p && Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
    if (sorted.length < 100) return null;
    return fullLaps(sorted).reduce((m, l) => (!m || lapDuration(l) < lapDuration(m) ? l : m), null);
  }
  const sameCar = (ord, name, d) => (Number.isFinite(ord) && ord === d.carOrdinal) ||
    (!!name && name === (carTable[d.carOrdinal] || `Car #${d.carOrdinal}`));

  // Best lap for this track and car: the current server session or the quickest saved session
  async function loadBest(d) {
    const id = ++loadId, track = canonicalTrack(trackSelect.value).toLowerCase();
    loading = true; render(true);
    const candidates = [];
    try {
      const res = await fetch('/api/session', { cache: 'no-store' });
      const s = res.ok ? await res.json() : null;
      if (s && s.car && canonicalTrack(s.track).toLowerCase() === track && sameCar(s.car.ordinal, null, d)) {
        const lap = fastest(s.telemetryPoints);
        if (lap) candidates.push({ lap, seconds: lapDuration(lap), label: `L${lap.lap} this session` });
      }
    } catch (e) { /* no current session */ }
    try {
      const res = await fetch('/api/sessions?all=1', { cache: 'no-store' });
      const list = res.ok ? await res.json() : [];
      const matches = (Array.isArray(list) ? list : [])
        .filter((s) => s.track && canonicalTrack(s.track).toLowerCase() === track && sameCar(s.carOrdinal, s.car, d))
        .sort((a, b) => (a.bestLap || Infinity) - (b.bestLap || Infinity))
        .slice(0, 3);
      for (const s of matches) {
        if (id !== loadId) return;
        const r = await fetch('/api/sessions/' + encodeURIComponent(s.filename));
        if (!r.ok) continue;
        const data = await r.json();
        const lap = fastest(data.telemetryPoints);
        if (!lap) continue;
        const date = new Date(s.date);
        candidates.push({ lap, seconds: lapDuration(lap), saved: true,
          label: `saved ${Number.isNaN(date.getTime()) ? s.filename : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` });
        break; // the list is sorted by best lap, so the first usable one is the quickest
      }
    } catch (e) { /* no saved sessions */ }
    if (id !== loadId) return;
    loading = false;
    if (sessionBest) candidates.push(sessionBest);
    const pick = candidates.reduce((m, c) => (!m || c.seconds < m.seconds ? c : m), null);
    if (pick && (!best || pick.seconds < best.seconds)) setBest(pick.lap, pick.seconds, pick.lap.samples[0].t, pick.label, !!pick.saved);
    render(true);
  }

  function checkKey(d) {
    const k = canonicalTrack(trackSelect.value).toLowerCase() + '|' + d.carOrdinal;
    if (k === key) return;
    key = k; best = null; sessionBest = null; cur = null; flash = null; summary = null; marker = null;
    if (trackSelect.value && d.carOrdinal) loadBest(d); else render(true);
  }

  // ---------- recording the current lap ----------
  function newLap(d, clock) {
    cur = { lapNo: d.lap, samples: [], clean: clock < 500, corners: [], matched: false };
  }

  function updateHeading(p) {
    if (!headingFrom) { headingFrom = { x: p.x, z: p.z }; return; }
    const dx = p.x - headingFrom.x, dz = p.z - headingFrom.z, len = Math.hypot(dx, dz);
    if (len > 300) { headingFrom = { x: p.x, z: p.z }; return; }   // teleport
    if (len < 2.5) return;
    const h = Math.atan2(dz, dx);
    if (heading === null) heading = h;
    else heading += Math.atan2(Math.sin(h - heading), Math.cos(h - heading)) * 0.35;
    headingFrom = { x: p.x, z: p.z };
  }

  function onTelemetry(d) {
    if (!d || !d.isRaceOn || !d.position || d.lap === undefined || !Number.isFinite(d.currentLap)) return;
    checkKey(d);
    updateHeading(d.position);
    const clock = d.currentLap * 1000;
    if (!cur || d.lap !== cur.lapNo) {
      if (cur && d.lap === cur.lapNo + 1) finishLap(cur, d.lastLap);
      newLap(d, clock);
    }
    const prev = cur.samples[cur.samples.length - 1];
    if (prev && clock < prev.t - 50) rewind(clock);
    else if (prev && clock - prev.t < 30) return;     // keep about 30 samples per second
    addSample(d, clock);
  }

  function rewind(clock) {
    cur.clean = false;
    while (cur.samples.length && cur.samples[cur.samples.length - 1].t > clock) cur.samples.pop();
    const last = cur.samples[cur.samples.length - 1];
    const ref = last ? last.ref : null;
    cur.corners = cur.corners.map((c, i) => (c && ref !== null && best && best.regions[i].zoneStart <= ref ? c : undefined));
  }

  function addSample(d, clock) {
    const s = cur.samples, prev = s[s.length - 1], p = d.position;
    let distance = 0;
    if (prev) {
      if (Math.hypot(p.x - prev.x, p.z - prev.z) > 300) cur.clean = false;
      distance = prev.distance + (prev.speed + d.speed) / 2 * (clock - prev.t) / 1000;
    }
    const sample = { t: clock, x: p.x, z: p.z, speed: d.speed, throttle: d.throttle, brake: d.brake,
      aiBrake: d.aiBrakeDiff, lineErr: d.drivingLine, distance, ref: null, delta: null };
    if (best) {
      const known = prev && prev.ref !== null;
      const expected = known ? prev.ref + (distance - prev.distance) : distance;
      const window = known ? 60 : !s.length && cur.clean ? 150 : best.lap.length;
      const m = TrackAnalysis.locate(best.lap, p.x, p.z, expected, window,
        prev ? p.x - prev.x : 0, prev ? p.z - prev.z : 0);
      if (m) {
        sample.ref = m.distance;
        sample.delta = clock / 1000 - (m.t - best.t0) / 1000;
      }
    }
    s.push(sample);
    if (sample.ref !== null) progress(prev, sample);
  }

  // Corner zones crossed between two samples: start, result flash, end
  function progress(prev, sample) {
    if (!prev || prev.ref === null) {
      // a clean lap starts at the line with no time gained or lost
      if (cur.clean && cur.samples.length <= 2 && best.regions.length) cur.corners[0] = { startDelta: 0 };
      return;
    }
    const a = prev.ref, b = sample.ref;
    if (b <= a || b - a > 100) return;
    best.regions.forEach((r, i) => {
      if (a < r.zoneStart && r.zoneStart <= b) cur.corners[i] = { startDelta: sample.delta };
      const c = cur.corners[i];
      if (!c) return;
      if (a < r.flashAt && r.flashAt <= b && c.flash === undefined) {
        c.flash = sample.delta - c.startDelta;
        c.why = cornerWhy(r, c.flash);
        flash = { at: performance.now(), index: i, delta: c.flash, text: c.why };
        render(true);
      }
      if (a < r.zoneEnd && r.zoneEnd <= b && c.zone === undefined) c.zone = sample.delta - c.startDelta;
    });
  }

  // What was different in a corner, compared with the best lap
  function cornerWhy(r, delta) {
    const view = [];
    for (const s of cur.samples) {
      if (s.ref === null || s.ref < r.approachStart - 1 || s.ref > r.exit + 25) continue;
      if (view.length && s.ref <= view[view.length - 1].distance) continue;
      view.push({ ...s, distance: s.ref });
    }
    if (view.length < 3) return '';
    const items = [];
    if (r.brake) {
      const mine = TrackAnalysis.brakePoint({ samples: view }, r, 'brake', r.brake.distance);
      if (mine) {
        const gap = Math.round(mine.distance - r.brake.distance);
        if (Math.abs(gap) >= 8) items.push({ bad: gap < 0, weight: Math.abs(gap) / 8, text: `braked ${Math.abs(gap)} m ${gap < 0 ? 'early' : 'late'}` });
      }
    }
    const corner = view.filter((s) => s.distance >= r.entry && s.distance <= r.exit).map((s) => s.speed);
    if (corner.length && r.minSpeed !== null) {
      const diff = (Math.min(...corner) - r.minSpeed) * MPH;
      if (Math.abs(diff) >= 2) items.push({ bad: diff < 0, weight: Math.abs(diff) / 2, text: `${Math.abs(diff).toFixed(0)} mph ${diff < 0 ? 'slower' : 'faster'} at the apex` });
    }
    const exit = view.find((s) => s.distance >= r.exit);
    if (exit && r.exitSpeed !== null) {
      const diff = (exit.speed - r.exitSpeed) * MPH;
      if (Math.abs(diff) >= 2) items.push({ bad: diff < 0, weight: Math.abs(diff) / 2 + 0.5, text: diff < 0 ? `exited ${Math.abs(diff).toFixed(0)} mph slow` : `exited ${diff.toFixed(0)} mph quicker` });
    }
    const wanted = delta > 0.03 ? items.filter((x) => x.bad) : delta < -0.03 ? items.filter((x) => !x.bad) : [];
    if (!wanted.length) return Math.abs(delta) <= 0.03 ? 'matched your best' : '';
    return wanted.sort((x, y) => y.weight - x.weight).slice(0, 2).map((x) => x.text).join(', ');
  }

  function finishLap(lap, lapTime) {
    const valid = Number.isFinite(lapTime) && lapTime > 0;
    if (best && valid) {
      const total = lapTime - best.seconds;
      const n = best.regions.length;
      const last = lap.corners[n - 1];
      if (last && last.zone === undefined) last.zone = total - last.startDelta;
      let worst = null;
      lap.corners.forEach((c, i) => {
        if (c && Number.isFinite(c.zone) && c.zone > 0.02 && (!worst || c.zone > worst.zone)) worst = { ...c, index: i };
      });
      summary = { lapNo: lap.lapNo + LAP_OFFSET, time: lapTime, total, worst, newBest: total < 0 && lap.clean,
        clean: lap.clean, at: performance.now() };
      if (worst) {
        const r = best.regions[worst.index];
        if (!worst.why) worst.why = cornerWhy(r, worst.zone);
        marker = { x: r.x, z: r.z, index: worst.index, label: `T${worst.index + 1} ${signed(worst.zone)} s` };
      } else marker = null;
    }
    // a clean lap that beats the best becomes the new best
    if (!valid || !lap.clean || lap.samples.length < 50) return;
    const first = lap.samples[0], end = lap.samples[lap.samples.length - 1];
    const length = end.distance;
    if (Math.hypot(first.x - end.x, first.z - end.z) > 150 || length < 500) return;
    if (best && (length < best.lap.length * 0.9 || length > best.lap.length * 1.1)) return;
    if (best && lapTime >= best.seconds - 0.0005) return;
    const built = { lap: lap.lapNo + LAP_OFFSET, anchored: true, interrupted: false, startedAt: first.t, endedAt: end.t,
      samples: lap.samples.map(({ ref, delta, ...p }) => p), length };
    sessionBest = { lap: built, seconds: lapTime, label: `L${lap.lapNo + LAP_OFFSET} this session` };
    setBest(built, lapTime, 0, sessionBest.label, false);
    render(true);
  }

  // ---------- page elements ----------
  function setText(id, text) { const el = $(id); if (el && el.textContent !== text) el.textContent = text; }

  function render(force) {
    const now = performance.now();
    if (!force && now - lastDraw < 100) return;
    lastDraw = now;
    const last = cur && cur.samples.length ? cur.samples[cur.samples.length - 1] : null;
    const delta = last ? last.delta : null;
    const tile = $('deltaTile');
    if (tile) {
      tile.classList.toggle('ahead', delta !== null && delta < -0.005);
      tile.classList.toggle('behind', delta !== null && delta > 0.005);
      setText('deltaVal', delta === null ? '--' : signed(delta));
      setText('deltaRef', best ? `${fmt(best.seconds)} · ${best.label}` : loading ? 'loading best lap…' : 'no best lap yet');
      setText('deltaPred', delta === null || !best ? 'Predicted --:--.---' : `Predicted ${fmt(best.seconds + delta)}`);
      setText('deltaHint', best ? (delta === null ? 'Waiting for a match on the best lap' : '') : 'Drive a clean lap to set one');
      const fill = $('deltaFill');
      if (fill) {
        const w = delta === null ? 0 : Math.min(1, Math.abs(delta) / DELTA_FULL) * 50;
        fill.style.width = w + '%';
        fill.style.left = delta !== null && delta < 0 ? (50 - w) + '%' : '50%';
      }
    }
    const fl = $('cornerFlash');
    if (fl) {
      if (flash) {
        fl.classList.toggle('fresh', now - flash.at < FLASH_MS);
        fl.classList.toggle('loss', flash.delta > 0.03);
        fl.classList.toggle('gain', flash.delta < -0.03);
        setText('flashTurn', `T${flash.index + 1}`);
        setText('flashDelta', `${signed(flash.delta)} s`);
        setText('flashText', flash.text || (flash.delta > 0 ? 'lost time' : 'gained time'));
      } else {
        fl.classList.remove('fresh', 'loss', 'gain');
        setText('flashTurn', '--');
        setText('flashDelta', '');
        setText('flashText', best ? 'Corner results appear here as you drive' : 'Corner results start once there is a best lap');
      }
    }
    const sum = $('lapSummary');
    if (sum) {
      sum.hidden = !summary;
      if (summary) {
        sum.classList.toggle('loss', summary.total > 0);
        sum.classList.toggle('gain', summary.total < 0);
        setText('sumLap', `Lap ${summary.lapNo}`);
        setText('sumTime', `${fmt(summary.time)} · ${signed(summary.total, 3)} s`);
        setText('sumText', summary.newBest ? 'New best lap' + (summary.worst ? `. Still most to gain at T${summary.worst.index + 1}: ${signed(summary.worst.zone)} s${summary.worst.why ? ', ' + summary.worst.why : ''}` : '')
          : summary.worst ? `T${summary.worst.index + 1} cost the most: ${signed(summary.worst.zone)} s${summary.worst.why ? ', ' + summary.worst.why : ''}`
            : 'No corner lost more than 0.02 s');
      }
    }
  }

  function setChase(on) {
    chase = !!on;
    const btn = $('chaseBtn');
    if (btn) { btn.classList.toggle('active', chase); btn.setAttribute('aria-pressed', String(chase)); }
    document.querySelectorAll('#autoAlignBtn, #mapRot, #rotVal, #rot90Btn').forEach((el) => el.classList.toggle('lv-off', chase));
    try { localStorage.setItem(CHASE_KEY, chase ? '1' : '0'); } catch (e) {}
  }

  // ---------- map: marker on the north-up map ----------
  // canvas pixels per CSS pixel, relative to the desktop layout the sizes were picked for (keeps text readable on a phone)
  const uiScale = (c) => Math.max(1, Math.min(2.5, c.width / Math.max(1, c.clientWidth || c.width) / 1.8));
  function drawMarkerAt(ctx, x, y, label, k = 1) {
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 260);
    ctx.save();
    ctx.strokeStyle = `rgba(255, 130, 72, ${0.35 + 0.4 * pulse})`; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, (20 + 8 * pulse) * k, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#ff8248'; ctx.strokeStyle = '#16161b'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, 10 * k, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.font = `bold ${Math.round(26 * k)}px Segoe UI, sans-serif`;
    const w = ctx.measureText(label).width + 22 * k, h = 38 * k, bx = x - w / 2, by = y - 70 * k;
    ctx.fillStyle = 'rgba(22, 22, 27, 0.92)'; ctx.strokeStyle = '#ff8248'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, by, w, h, 8) : ctx.rect(bx, by, w, h); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ffb08a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x, by + h / 2 + 1);
    ctx.restore();
  }
  function drawOverlay(ctx, S) {
    if (!marker) return;
    const [x, y] = S(marker.x, marker.z);
    drawMarkerAt(ctx, x, y, marker.label, uiScale(ctx.canvas));
  }

  // ---------- map: chase view (behind the car, looking along the direction of travel) ----------
  let range = 220;
  function drawChase(ctx, c, d) {
    const W = c.width, H = c.height, k = uiScale(c);
    ctx.fillStyle = '#111116'; ctx.fillRect(0, 0, W, H);
    if (!d || !d.position || heading === null) {
      ctx.fillStyle = '#707070'; ctx.font = `${Math.round(22 * k)}px sans-serif`; ctx.textAlign = 'center';
      ctx.fillText('Chase view starts once the car is moving', W / 2, H / 2);
      ctx.textAlign = 'start';
      return true;
    }
    const target = Math.max(150, Math.min(340, 110 + (d.speed || 0) * 2.6));
    range += (target - range) * 0.04;
    const R = range, phi = 36 * Math.PI / 180, cs = Math.cos(phi), sn = Math.sin(phi);
    const camH = 0.42 * R, camD = 0.30 * R, F = 0.62 * W, near = 0.06 * R;
    const depth0 = camD * cs + camH * sn, y0 = H * 0.8 + F * (camD * sn - camH * cs) / depth0;
    const fl = mapFlip ? -1 : 1;
    const fu = Math.cos(heading) * fl, fv = Math.sin(heading);       // forward, in north-up screen axes
    const ru = -fv, rv = fu;                                           // right of travel
    const cx = d.position.x, cz = d.position.z;
    // world point -> ground (lateral a, ahead b) -> screen
    const ground = (x, z) => {
      const u = (x - cx) * fl, v = z - cz;
      return { a: u * ru + v * rv, b: u * fu + v * fv };
    };
    const depthOf = (g) => (g.b + camD) * cs + camH * sn;
    const screen = (g) => {
      const dp = depthOf(g), yc = (g.b + camD) * sn - camH * cs;
      return [W / 2 + F * g.a / dp, y0 - F * yc / dp];
    };
    const far = R * 4;
    // polyline clipped at the near plane (nothing behind the camera); closed = join the last point to the first
    const path = (list, closed) => {
      const n = list.length;
      if (n < 2) return;
      let prev = ground(list[0].x, list[0].z), open = false;
      for (let i = 1, count = closed ? n + 1 : n; i < count; i++) {
        const A = prev, B = ground(list[i % n].x, list[i % n].z), da = depthOf(A), db = depthOf(B);
        prev = B;
        if ((da <= near && db <= near) || (A.b > far && B.b > far)) { open = false; continue; }
        const lerp = (t) => ({ a: A.a + (B.a - A.a) * t, b: A.b + (B.b - A.b) * t });
        const t0 = da <= near ? (near - da) / (db - da) + 1e-6 : 0;
        const t1 = db <= near ? (near - da) / (db - da) - 1e-6 : 1;
        if (!open || t0) ctx.moveTo(...screen(t0 ? lerp(t0) : A));
        ctx.lineTo(...screen(t1 < 1 ? lerp(t1) : B));
        open = t1 === 1;
      }
    };
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    // horizon glow
    const sky = ctx.createLinearGradient(0, 0, 0, H * 0.35);
    sky.addColorStop(0, 'rgba(255, 130, 72, 0.06)'); sky.addColorStop(1, 'rgba(255, 130, 72, 0)');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H * 0.35);

    const ra = typeof refShown === 'function' && refShown() ? refAligned : null;
    if (ra && refOption('refEdges') && ra.left.length === ra.right.length) {
      ctx.beginPath();
      const n = ra.left.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const q = [ra.left[i], ra.left[j], ra.right[j], ra.right[i]].map((p) => ground(p.x, p.z));
        if (q.some((g) => depthOf(g) <= near || g.b > far)) continue;
        const s = q.map(screen);
        ctx.moveTo(...s[0]); ctx.lineTo(...s[1]); ctx.lineTo(...s[2]); ctx.lineTo(...s[3]); ctx.closePath();
      }
      ctx.fillStyle = 'rgba(150, 165, 190, 0.16)'; ctx.fill('nonzero');
      ctx.strokeStyle = 'rgba(190, 205, 230, 0.55)'; ctx.lineWidth = 2;
      ctx.beginPath(); path(ra.left, true); ctx.stroke();
      ctx.beginPath(); path(ra.right, true); ctx.stroke();
    }
    if (ra && refOption('refRaceline') && ra.raceline.length) {
      ctx.strokeStyle = '#facc15'; ctx.lineWidth = 2.5; ctx.setLineDash([12, 9]);
      ctx.beginPath(); path(ra.raceline, true); ctx.stroke(); ctx.setLineDash([]);
    }
    const pts = trackOutline ? trackOutline.points : trackPts;
    if (pts.length > 1) {
      ctx.strokeStyle = '#4a90b8'; ctx.lineWidth = ra ? 4 : 7;
      ctx.beginPath(); path(pts, !!trackOutline); ctx.stroke();
    }

    // corner labels ahead; the corner that cost the most on the last lap is highlighted
    const ref = cur && cur.samples.length ? cur.samples[cur.samples.length - 1].ref : null;
    if (best) {
      best.regions.forEach((r, i) => {
        const g = ground(r.x, r.z);
        if (depthOf(g) <= near || g.b > R * 1.6 || g.b < -camD * 0.5) return;
        const [x, y] = screen(g);
        if (marker && marker.index === i) return;
        ctx.font = `bold ${Math.round(18 * k)}px Segoe UI, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.lineWidth = 4; ctx.strokeStyle = '#111116'; ctx.strokeText(`T${i + 1}`, x, y - 8 * k);
        ctx.fillStyle = '#cda3fa'; ctx.fillText(`T${i + 1}`, x, y - 8 * k);
        ctx.beginPath(); ctx.arc(x, y, 4 * k, 0, Math.PI * 2); ctx.fill();
      });
    }
    if (marker) {
      const g = ground(marker.x, marker.z);
      if (depthOf(g) > near && g.b < far) { const [x, y] = screen(g); drawMarkerAt(ctx, x, y, marker.label, k); }
    }

    // the car: a chevron pointing up
    const [carX, carY] = screen({ a: 0, b: 0 });
    ctx.fillStyle = '#ff8248'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(carX, carY - 22 * k); ctx.lineTo(carX + 15 * k, carY + 14 * k); ctx.lineTo(carX, carY + 6 * k); ctx.lineTo(carX - 15 * k, carY + 14 * k);
    ctx.closePath(); ctx.fill(); ctx.stroke();

    // distance to the marked corner
    if (marker && best && ref !== null) {
      const L = best.lap.length, r = best.regions[marker.index];
      const togo = ((r.apex - ref) % L + L) % L;
      ctx.font = `bold ${Math.round(22 * k)}px Segoe UI, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(22, 22, 27, 0.85)';
      const text = `${marker.label.split(' ')[0]} in ${togo >= 1000 ? (togo / 1000).toFixed(1) + ' km' : Math.round(togo / 10) * 10 + ' m'}`;
      const w = ctx.measureText(text).width + 24 * k;
      ctx.fillRect(16, 16, w, 38 * k);
      ctx.fillStyle = '#ffb08a'; ctx.fillText(text, 16 + 12 * k, 16 + 19 * k);
    }
    ctx.font = `${Math.round(15 * k)}px Segoe UI, sans-serif`; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillStyle = '#80808c';
    ctx.fillText('Chase view · heading up', W - 14, H - 10);
    ctx.restore();
    return true;
  }

  // ---------- start ----------
  function init() {
    try { setChase(localStorage.getItem(CHASE_KEY) === '1'); } catch (e) { setChase(false); }
    const btn = $('chaseBtn');
    if (btn) btn.addEventListener('click', () => setChase(!chase));
    if (typeof trackSelect !== 'undefined') trackSelect.addEventListener('change', () => { key = ''; });
    const tick = () => { render(false); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    render(true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  return {
    onTelemetry, drawOverlay, drawChase,
    get chase() { return chase; },
    get state() { return { best, cur, flash, summary, marker, heading }; }
  };
})();
