'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('analysisMap'), ctx = canvas.getContext('2d');
  const MPH = 2.237, pointers = new Map();
  let filename = '', laps = [], lap = null, other = null;
  let turns = [], selectedTurn = -1, selectedPoint = null, editing = false, requestId = 0;
  let regions = [], trackName = '', trackNames = new Map(), deltaCache = null;
  // Reference track (centerline, widths, raceline) aligned to this session's driven laps
  let reference = null, aligned = null, refFit = null, refRequest = 0;
  const trackEntries = new Map();
  const DELTA_FULL = 0.03; // seconds gained or lost per 50 m that is drawn at full colour
  const DELTA_PAD = { l: 44, r: 10, t: 16, b: 18 };
  let view = { scale: 1, x: 0, y: 0 }, orientation = { rot: 0, flip: false };
  let drag = null, pinch = null, moved = false;
  // Off-track detection (see TrackAnalysis.OFF_TRACK); the threshold is editable on the page and remembered per browser
  const OFF_KEY = 'trackAnalysis:offTrackThreshold';
  const TIRE_NAMES = { fl: 'FL', fr: 'FR', rl: 'RL', rr: 'RR' };
  const OFF_COLORS = ['#4a4a53', '#fbbf24', '#fb923c', '#f4613a', '#fb4f60']; // by number of tires off
  const KERB_COLOR = '#7dd3fc';
  let offThreshold = TrackAnalysis.OFF_TRACK.threshold, offCache = new Map();

  function status(message, error = false) {
    $('status').textContent = message;
    $('status').classList.toggle('error', error);
  }
  function text(id, value) { $(id).textContent = value; }
  // Turn markers belong to the track, not to one lap: they are stored as map positions (plus driving direction)
  // and projected onto whichever lap is open, so they survive distance drift and are shared by every session.
  function trackKey() {
    const name = String(trackName || '').trim();
    const canonical = trackNames.get(name.toLowerCase()) || name;
    return canonical ? `trackAnalysis:track:${canonical.toLowerCase()}` : `trackAnalysis:session:${filename}`;
  }
  function oldTurnKey() { return `trackAnalysis:turns:${filename}:${lap.startedAt}`; }
  function stored(key) { try { return localStorage.getItem(key); } catch (error) { return null; } }
  const seconds = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(3)} s`;
  const sgn = (v, digits = 0) => { const n = Math.abs(v).toFixed(digits); return `${v < 0 && Number(n) !== 0 ? '−' : '+'}${n}`; };
  function transform(p) {
    const theta = orientation.rot * Math.PI / 180, cs = Math.cos(theta), sn = Math.sin(theta);
    const x = p.x * (orientation.flip ? -1 : 1);
    return { x: x * cs - p.z * sn, y: x * sn + p.z * cs };
  }
  function screen(p) {
    const q = transform(p);
    return { x: q.x * view.scale + view.x, y: q.y * view.scale + view.y };
  }
  function dimensions() { const r = canvas.getBoundingClientRect(); return { width: r.width, height: r.height }; }
  function resize() {
    const { width, height } = dimensions(), ratio = window.devicePixelRatio || 1;
    if (!width || !height) return;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (lap) fit(); else draw();
  }
  function fit() {
    if (!lap) return;
    const { width, height } = dimensions();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    lap.samples.forEach((point) => {
      const p = transform(point);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    });
    const scale = Math.min((width - 80) / Math.max(1, maxX - minX), (height - 80) / Math.max(1, maxY - minY));
    view = { scale, x: width / 2 - (minX + maxX) / 2 * scale, y: height / 2 - (minY + maxY) / 2 * scale };
    draw();
  }
  function zoom(factor, x, y) {
    if (!lap) return;
    const next = Math.max(0.005, Math.min(20, view.scale * factor));
    const ratio = next / view.scale;
    view.x = x - (x - view.x) * ratio; view.y = y - (y - view.y) * ratio; view.scale = next;
    draw();
  }
  function line(a, b, color, width, offset = 0) {
    const p = screen(a), q = screen(b), length = Math.hypot(q.x - p.x, q.y - p.y);
    if (!length) return;
    const dx = -(q.y - p.y) / length * offset, dy = (q.x - p.x) / length * offset;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(p.x + dx, p.y + dy); ctx.lineTo(q.x + dx, q.y + dy); ctx.stroke();
  }
  function pedalColor(field, value) {
    if (!Number.isFinite(value)) return '#45454d';
    const v = Math.max(0, Math.min(1, value));
    return field === 'throttle' ? `rgb(${Math.round(35 + 39 * v)},${Math.round(58 + 164 * v)},${Math.round(43 + 85 * v)})`
      : `rgb(${Math.round(65 + 186 * v)},${Math.round(38 + 41 * v)},${Math.round(43 + 53 * v)})`;
  }
  // Signed channels (line error, brake vs AI): one hue per side, brighter = bigger. Full colour at +/-0.5.
  function divergeColor(value) {
    if (!Number.isFinite(value)) return '#45454d';
    const v = Math.min(1, Math.abs(value) / 0.5);
    return `hsl(${value >= 0 ? 28 : 205}, 85%, ${22 + 38 * v}%)`;
  }
  function marker(p, label, color, radius = 4) {
    const q = screen(p);
    ctx.fillStyle = color; ctx.strokeStyle = '#111116'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(q.x, q.y, radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    if (label) {
      ctx.font = 'bold 11px Segoe UI, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3; ctx.strokeStyle = '#111116'; ctx.strokeText(label, q.x, q.y - radius - 3);
      ctx.fillStyle = color; ctx.fillText(label, q.x, q.y - radius - 3);
    }
  }
  function crossLine(distance, label, color, halfWidth) {
    const p = TrackAnalysis.atDistance(lap, distance);
    const before = TrackAnalysis.atDistance(lap, Math.max(0, distance - 5));
    const after = TrackAnalysis.atDistance(lap, Math.min(lap.length, distance + 5));
    if (!p || !before || !after) return;
    const a = screen(before), b = screen(after), q = screen(p), len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!len) return;
    const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    ctx.strokeStyle = color; ctx.lineWidth = label.startsWith('S') ? 3 : 1;
    ctx.beginPath(); ctx.moveTo(q.x - nx * halfWidth, q.y - ny * halfWidth); ctx.lineTo(q.x + nx * halfWidth, q.y + ny * halfWidth); ctx.stroke();
    ctx.font = 'bold 11px Segoe UI, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = '#111116'; ctx.strokeText(label, q.x + nx * (halfWidth + 12), q.y + ny * (halfWidth + 12));
    ctx.fillStyle = color; ctx.fillText(label, q.x + nx * (halfWidth + 12), q.y + ny * (halfWidth + 12));
  }
  function draw() {
    const { width, height } = dimensions();
    ctx.clearRect(0, 0, width, height);
    if (!lap) {
      ctx.fillStyle = '#a0a0a0'; ctx.font = '14px Segoe UI'; ctx.textAlign = 'center';
      ctx.fillText('No usable lap trace', width / 2, height / 2);
      drawDelta();
      return;
    }
    drawReference();
    const mode = $('overlaySelect').value;
    const profile = mode === 'delta' ? currentDelta() : null;
    for (let i = 1; i < lap.samples.length; i++) {
      const a = lap.samples[i - 1], b = lap.samples[i];
      line(a, b, '#35353d', 12);
    }
    for (let i = 1; i < lap.samples.length; i++) {
      const a = lap.samples[i - 1], b = lap.samples[i];
      if (mode === 'both') {
        line(a, b, pedalColor('throttle', b.throttle), 4, -3);
        line(a, b, pedalColor('brake', b.brake), 4, 3);
      } else if (mode === 'speed') {
        const ratio = Math.max(0, Math.min(1, b.speed / 80));
        line(a, b, `hsl(${220 - ratio * 220}, 80%, 55%)`, 7);
      } else if (mode === 'acceleration') {
        const value = b.gLong;
        const color = Number.isFinite(value)
          ? `hsl(${value >= 0 ? 175 : 10}, 80%, ${25 + 35 * Math.min(1, Math.abs(value))}%)` : '#45454d';
        line(a, b, color, 7);
      } else if (mode === 'delta') {
        line(a, b, deltaColor(profile, (a.distance + b.distance) / 2), 7);
      } else if (mode === 'offTrack') {
        const off = TrackAnalysis.tiresOff(b, offThreshold);
        line(a, b, off === null ? '#2c2c33' : off.length ? OFF_COLORS[off.length] : TrackAnalysis.tiresOnKerb(b).length ? KERB_COLOR : OFF_COLORS[0], off && off.length ? 8 : 6);
      } else if (mode === 'lineError' || mode === 'aiBrake') {
        line(a, b, divergeColor(mode === 'lineError' ? b.lineErr : b.aiBrake), 7);
      } else line(a, b, pedalColor(mode, b[mode]), 7);
    }
    if ($('distances').checked && view.scale * 200 > 26) {
      for (let d = 200; d < lap.length; d += 200) if (d % 1000) crossLine(d, `${d}m`, '#8e8e98', 4);
    }
    if (lap.anchored) {
      for (let d = 0, n = 1; d < lap.length; d += 1000, n++) crossLine(d, `S${n}`, '#ffb56f', 11);
    }
    drawApproach();
    if ($('onsets').checked) {
      TrackAnalysis.pedalOnsets(lap, 'throttle').forEach((p) => marker(p, view.scale > 0.3 ? 'A' : '', '#4ade80', 3));
      TrackAnalysis.pedalOnsets(lap, 'brake').forEach((p) => marker(p, view.scale > 0.3 ? 'B' : '', '#fb4f60', 3));
    }
    if (!$('offMarkers') || $('offMarkers').checked) {
      (offEvents(lap) || []).forEach((e) => marker(e.worst, view.scale > 0.15 ? `${e.maxTires}W` : '', OFF_COLORS[e.maxTires], e.allFour ? 6 : 5));
    }
    turns.forEach((distance, i) => {
      const point = TrackAnalysis.atDistance(lap, distance);
      if (point) marker(point, `T${i + 1}`, i === selectedTurn ? '#fff' : '#cda3fa', i === selectedTurn ? 6 : 4);
    });
    if (selectedPoint) marker(selectedPoint, '', '#fff', 6);
    drawDelta();
  }
  // Ticks 50, 100, 150 and 200 m before each corner's entry, perpendicular to the line
  function drawApproach() {
    if (!$('approach') || !$('approach').checked) return;
    const zoomedIn = view.scale * 50 > 12;
    regions.forEach((r, i) => {
      if (!zoomedIn && i !== selectedTurn) return;
      const color = i === selectedTurn ? '#ffffff' : '#cda3fa';
      const floor = i ? regions[i - 1].exit + 10 : 0;
      for (const meters of [50, 100, 150, 200]) {
        const d = r.entry - meters;
        if (d < floor) break;
        crossLine(d, String(meters), color, 6);
      }
    });
  }
  // Running time difference along the reference lap, cached per pair of laps
  function currentDelta() {
    if (!lap || !other) return null;
    if (!deltaCache || deltaCache.lap !== lap || deltaCache.other !== other) {
      deltaCache = { lap, other, profile: TrackAnalysis.deltaProfile(lap, other) };
    }
    return deltaCache.profile;
  }
  function deltaAt(profile, distance) {
    const step = profile.length > 1 ? profile[1].distance - profile[0].distance : 10;
    const x = Math.max(0, Math.min(profile.length - 1, distance / step));
    const i = Math.floor(x), a = profile[i], b = profile[Math.min(profile.length - 1, i + 1)];
    if (!a || !b || a.delta === null || b.delta === null) return null;
    return a.delta + (b.delta - a.delta) * (x - i);
  }
  // Red where the reference lap is losing time, green where it is gaining (rate over 50 m)
  function deltaColor(profile, distance) {
    if (!profile) return '#45454d';
    const before = deltaAt(profile, distance - 25), after = deltaAt(profile, distance + 25);
    if (before === null || after === null) return '#45454d';
    const rate = after - before, v = Math.min(1, Math.abs(rate) / DELTA_FULL);
    return `hsl(${rate > 0 ? 355 : 140}, 75%, ${22 + 38 * v}%)`;
  }
  function drawDelta() {
    const chart = $('deltaChart');
    if (!chart) return;
    const profile = currentDelta();
    chart.hidden = !profile;
    if (!profile) return;
    const box = chart.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
    if (!box.width || !box.height) return;
    if (chart.width !== Math.round(box.width * ratio) || chart.height !== Math.round(box.height * ratio)) {
      chart.width = Math.round(box.width * ratio); chart.height = Math.round(box.height * ratio);
    }
    const c = chart.getContext('2d');
    c.setTransform(ratio, 0, 0, ratio, 0, 0); c.clearRect(0, 0, box.width, box.height);
    const values = profile.filter((p) => p.delta !== null);
    c.font = '11px Segoe UI, sans-serif';
    if (values.length < 2) { c.fillStyle = '#a0a0a0'; c.textAlign = 'center'; c.fillText('The comparison lap could not be aligned with this lap.', box.width / 2, box.height / 2); return; }
    const limit = Math.max(0.1, ...values.map((p) => Math.abs(p.delta))) * 1.15;
    const { l, r, t, b } = DELTA_PAD, w = box.width - l - r, h = box.height - t - b;
    const X = (d) => l + d / lap.length * w, Y = (v) => t + h / 2 - v / limit * (h / 2);
    regions.forEach((region, i) => {
      c.fillStyle = i === selectedTurn ? 'rgba(255,255,255,0.18)' : 'rgba(205,163,250,0.10)';
      c.fillRect(X(region.entry), t, Math.max(1, X(region.exit) - X(region.entry)), h);
      c.fillStyle = '#cda3fa'; c.textAlign = 'center'; c.textBaseline = 'top';
      c.fillText(`T${i + 1}`, (X(region.entry) + X(region.exit)) / 2, 2);
    });
    c.strokeStyle = '#55555e'; c.lineWidth = 1; c.beginPath(); c.moveTo(l, Y(0)); c.lineTo(l + w, Y(0)); c.stroke();
    c.fillStyle = '#a0a0a0'; c.textAlign = 'right'; c.textBaseline = 'middle';
    c.fillText(`+${limit.toFixed(1)} s`, l - 4, Y(limit)); c.fillText('0', l - 4, Y(0)); c.fillText(`−${limit.toFixed(1)} s`, l - 4, Y(-limit));
    c.textAlign = 'left'; c.textBaseline = 'top'; c.fillText('behind', l + 4, t); c.textBaseline = 'bottom'; c.fillText('ahead', l + 4, t + h);
    c.strokeStyle = '#f2f2f5'; c.lineWidth = 2; c.beginPath();
    let open = false;
    profile.forEach((p) => {
      if (p.delta === null) { open = false; return; }
      if (open) c.lineTo(X(p.distance), Y(p.delta)); else { c.moveTo(X(p.distance), Y(p.delta)); open = true; }
    });
    c.stroke();
    const last = values[values.length - 1];
    c.fillStyle = last.delta > 0 ? '#fb4f60' : '#4ade80'; c.textAlign = 'right'; c.textBaseline = 'bottom';
    c.fillText(`${seconds(last.delta)} at the end`, l + w, t + h);
    if (selectedPoint) {
      const x = X(selectedPoint.distance), v = deltaAt(profile, selectedPoint.distance);
      c.strokeStyle = '#ffffff'; c.lineWidth = 1; c.beginPath(); c.moveTo(x, t); c.lineTo(x, t + h); c.stroke();
      if (v !== null) { c.fillStyle = '#ffffff'; c.beginPath(); c.arc(x, Y(v), 4, 0, Math.PI * 2); c.fill(); }
    }
  }
  function nearest(x, y) {
    if (!lap) return null;
    let best = null;
    for (let i = 1; i < lap.samples.length; i++) {
      const a = lap.samples[i - 1], b = lap.samples[i], p = screen(a), q = screen(b);
      const dx = q.x - p.x, dy = q.y - p.y, length2 = dx * dx + dy * dy;
      if (!length2) continue;
      const f = Math.max(0, Math.min(1, ((x - p.x) * dx + (y - p.y) * dy) / length2));
      const error = Math.hypot(x - p.x - f * dx, y - p.y - f * dy);
      if (!best || error < best.error) best = { error, distance: a.distance + (b.distance - a.distance) * f };
    }
    return best && best.error <= 18 ? TrackAnalysis.atDistance(lap, best.distance) : null;
  }
  // ---- reference track ----
  function canonicalTrack() {
    const name = String(trackName || '').trim();
    return (trackNames.get(name.toLowerCase()) || name).toLowerCase();
  }
  function trackEntry() { return trackEntries.get(canonicalTrack()) || null; }
  function alignKey() { return `trackAnalysis:align:${canonicalTrack()}`; }
  function savedAlignment() {
    try {
      const t = JSON.parse(stored(alignKey()));
      return t && ['rot', 'scale', 'tx', 'tz'].every((k) => Number.isFinite(t[k])) ? t : null;
    } catch (error) { return null; }
  }
  function setRefInfo(message, warn = false) {
    if (!$('referenceInfo')) return;
    $('referenceInfo').textContent = message; $('referenceInfo').style.color = warn ? '#fbbf24' : '';
  }
  // A complete, roughly closed lap to fit the reference to: the open lap if it qualifies, else the longest that does
  function fitLap() {
    const closed = (l) => { const f = l.samples[0], e = l.samples[l.samples.length - 1]; return Math.hypot(f.x - e.x, f.z - e.z) < 150; };
    const complete = (l) => l.anchored && l.endedAt !== null && !l.interrupted && closed(l);
    if (lap && complete(lap)) return lap;
    const pool = laps.filter(complete);
    return (pool.length ? pool : laps.filter((l) => closed(l) && l.length > 500)).sort((x, y) => y.length - x.length)[0] || null;
  }
  async function prepareReference(force = false) {
    const request = ++refRequest, entry = trackEntry(), info = entry && entry.reference;
    const panel = $('referencePanel');
    if (panel) panel.hidden = !(info && info.data);
    if (!info || !info.data || typeof ReferenceTrack === 'undefined') { reference = aligned = refFit = null; draw(); return; }
    if (!reference || reference.source !== info.data) {
      try {
        const response = await fetch(info.data);
        if (!response.ok) throw new Error(`request failed (${response.status})`);
        reference = ReferenceTrack.parse(await response.json()); reference.source = info.data;
      } catch (error) { reference = aligned = refFit = null; setRefInfo(`Reference data unavailable: ${error.message}`, true); draw(); return; }
      if (request !== refRequest) return;
    }
    let t = force ? null : savedAlignment() || info.align || null;
    if (!t) {
      const source = fitLap();
      if (!source) { aligned = refFit = null; setRefInfo('Reference track found. Open a complete lap to align it.'); updateReferencePlots(info); draw(); return; }
      t = ReferenceTrack.fit(reference, source.samples);
      if (t.ok) { try { localStorage.setItem(alignKey(), JSON.stringify(t)); } catch (error) { /* alignment is just recomputed next time */ } }
    }
    refFit = t;
    aligned = t.ok === false ? null : ReferenceTrack.align(reference, t);
    const label = `${trackEntry().name}${info.layout ? ` · ${info.layout}` : ''}`;
    if (aligned) {
      setRefInfo(`${label}. Alignment: typically ${Number.isFinite(t.median) ? t.median.toFixed(1) : '?'} m from the driven line (95% within ${Number.isFinite(t.p95) ? t.p95.toFixed(1) : '?'} m)${t.mirror ? ', mirrored' : ''}.`);
    } else {
      setRefInfo(`${label}: does not match this lap (95% of the line is within ${t.p95} m, scale ${t.scale}), so it is hidden. The recorded layout probably differs.`, true);
    }
    updateReferencePlots(info); draw();
  }
  function updateReferencePlots(info) {
    const details = $('referencePlots');
    if (!details) return;
    details.dataset.raceline = info.raceline_png || ''; details.dataset.curvature = info.curvature_png || '';
    details.hidden = !(info.raceline_png || info.curvature_png);
    if (details.open) loadReferencePlots();
  }
  function loadReferencePlots() {
    const details = $('referencePlots');
    if ($('refRacelinePng')) $('refRacelinePng').src = details.dataset.raceline || '';
    if ($('refCurvaturePng')) $('refCurvaturePng').src = details.dataset.curvature || '';
  }
  function drawReference() {
    if (!aligned) return;
    const edges = !$('edges') || $('edges').checked, raceline = $('refRaceline') && $('refRaceline').checked;
    const trace = (points) => {
      points.forEach((p, i) => { const q = screen(p); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
      ctx.closePath();
    };
    if (edges) {
      ctx.beginPath(); trace(aligned.left); trace(aligned.right);
      ctx.fillStyle = 'rgba(150, 165, 190, 0.13)'; ctx.fill('evenodd');
      ctx.strokeStyle = 'rgba(190, 205, 230, 0.5)'; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
      ctx.beginPath(); trace(aligned.left); ctx.stroke(); ctx.beginPath(); trace(aligned.right); ctx.stroke();
    }
    if (raceline && aligned.raceline.length) {
      ctx.strokeStyle = '#facc15'; ctx.lineWidth = 2; ctx.setLineDash([9, 6]);
      ctx.beginPath(); trace(aligned.raceline); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  // Where a driven point sits on the reference track
  function trackPosition(p) {
    if (!aligned) return '—';
    const pos = ReferenceTrack.position(aligned, p.x, p.z);
    if (!pos) return '—';
    const edge = Math.abs(pos.fraction);
    return `${Math.abs(pos.offset).toFixed(1)} m ${pos.offset >= 0 ? 'left' : 'right'} of center · ${edge > 1 ? 'past the reference edge' : `${Math.round(edge * 100)}% to the edge`}`;
  }
  // Where a point sits relative to the marked corners (entry = where the corner starts to turn the car)
  function cornerPosition(distance) {
    for (let i = 0; i < regions.length; i++) {
      const r = regions[i], next = regions[i + 1];
      if (distance >= r.entry - 250 && distance < r.entry && (!i || distance > regions[i - 1].exit)) return `${Math.round(r.entry - distance)} m before T${i + 1}`;
      if (distance >= r.entry && distance <= r.exit) return `In T${i + 1}, ${Math.round(distance - r.entry)} m after entry`;
      if (distance > r.exit && distance <= r.exit + 250 && (!next || distance < next.entry - 250)) return `${Math.round(distance - r.exit)} m after T${i + 1}`;
    }
    return '—';
  }
  function signed(v) { return Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}` : '—'; }
  // ---- off track ----
  function loadThreshold() {
    const saved = Number(stored(OFF_KEY));
    offThreshold = stored(OFF_KEY) !== null && Number.isFinite(saved) && saved >= 0 ? saved : TrackAnalysis.OFF_TRACK.threshold;
    if ($('offThreshold')) $('offThreshold').value = String(offThreshold);
  }
  // Events for a lap at the current threshold (null = the session has no surface rumble data)
  function offEvents(l) {
    if (!l) return null;
    const key = l;
    const hit = offCache.get(key);
    if (hit && hit.threshold === offThreshold) return hit.events;
    const events = TrackAnalysis.offTrackEvents(l, { threshold: offThreshold });
    offCache.set(key, { threshold: offThreshold, events });
    return events;
  }
  const eventsIn = (events, start, end) => (events || []).filter((e) => e.startDistance >= start && e.startDistance < end);
  const tireText = (list) => list.map((k) => TIRE_NAMES[k]).join(' ');
  // 2x2 car-layout chip: lit squares are the tires that left the track
  function tireChip(tires) {
    const chip = document.createElement('span');
    chip.className = 'tire-chip'; chip.title = tires.length ? `Off track: ${tireText(tires)}` : 'All tires on track';
    TrackAnalysis.TIRES.forEach((k) => {
      const cell = document.createElement('i');
      cell.textContent = TIRE_NAMES[k]; if (tires.includes(k)) cell.className = 'off';
      chip.appendChild(cell);
    });
    return chip;
  }
  function offTrackAt(p) {
    const off = TrackAnalysis.tiresOff(p, offThreshold);
    if (off === null) return '—';
    const kerb = TrackAnalysis.tiresOnKerb(p);
    const parts = [];
    if (off.length) parts.push(`Off: ${off.map((k) => `${TIRE_NAMES[k]} ${p.surf[k].toFixed(2)}`).join(', ')}`);
    if (kerb.length) parts.push(`Kerb: ${tireText(kerb)}`);
    return parts.length ? parts.join(' · ') : 'All four on track';
  }
  function cornerName(distance) {
    const i = regions.findIndex((r) => distance >= r.zoneStart && distance < r.zoneEnd);
    return i >= 0 ? `T${i + 1}` : null;
  }
  function cell(tr, value, className) {
    const td = document.createElement('td');
    if (value instanceof Node) td.appendChild(value); else td.textContent = value;
    if (className) td.className = className;
    tr.appendChild(td); return td;
  }
  function renderOffTrack() {
    const panel = $('offTrackPanel');
    if (!panel) return;
    const summary = $('offSummary'), eventBody = $('offEventTable').querySelector('tbody'), lapBody = $('offLapTable').querySelector('tbody');
    summary.replaceChildren(); eventBody.replaceChildren(); lapBody.replaceChildren();
    const events = offEvents(lap);
    $('offContent').hidden = !events;
    if (!lap) { text('offHint', 'Select a lap to see off-track events.'); return; }
    if ($('overlaySelect').value === 'offTrack') updateLegend();
    if (!events) {
      text('offHint', 'This session was recorded before surface rumble was saved, so off-track events are not available. New sessions record it automatically.');
      return;
    }
    const stats = TrackAnalysis.surfaceStats(lap);
    text('offHint', `A tire counts as off track when its surface rumble is above ${offThreshold} and it is not on a kerb. ` +
      `Events shorter than ${TrackAnalysis.OFF_TRACK.minSeconds} s are ignored. ` +
      (stats ? `Surface rumble off the kerbs on this lap: median ${stats.median.toFixed(3)}, 95% below ${stats.p95.toFixed(3)}, highest ${stats.max.toFixed(3)}.` : ''));
    const totals = TrackAnalysis.offTrackTotals(events);
    const byCorner = new Map();
    events.forEach((e) => { const name = cornerName(e.startDistance); if (name) byCorner.set(name, (byCorner.get(name) || 0) + e.seconds); });
    const worst = [...byCorner.entries()].sort((a, b) => b[1] - a[1])[0];
    const tireTotal = TrackAnalysis.TIRES.filter((k) => totals.tireSeconds[k] > 0)
      .map((k) => `${TIRE_NAMES[k]} ${totals.tireSeconds[k].toFixed(1)} s`).join(' · ');
    [['Events', String(totals.count), ''], ['Time off track', `${totals.seconds.toFixed(2)} s`, tireTotal || 'No tire left the track'],
      ['All four off', String(totals.allFour), 'Events where every tire was off at once'],
      ['Worst corner', worst ? worst[0] : '—', worst ? `${worst[1].toFixed(2)} s off track` : '']].forEach(([label, value, note]) => {
      const tile = document.createElement('div'); tile.className = 'off-tile';
      const l = document.createElement('span'); l.className = 'label'; l.textContent = label;
      const v = document.createElement('strong'); v.textContent = value;
      tile.append(l, v);
      if (note) { const n = document.createElement('small'); n.textContent = note; tile.appendChild(n); }
      summary.appendChild(tile);
    });
    if (!events.length) {
      const tr = document.createElement('tr'); const td = cell(tr, 'No off-track events on this lap.'); td.colSpan = 6; td.className = 'empty';
      eventBody.appendChild(tr);
    }
    events.forEach((e, i) => {
      const tr = document.createElement('tr');
      if (e.allFour) tr.className = 'all-four';
      cell(tr, String(i + 1));
      cell(tr, `${Math.round(e.startDistance)}–${Math.round(e.endDistance)} m`);
      cell(tr, cornerPosition(e.startDistance));
      const tires = document.createElement('span'); tires.className = 'tire-cell';
      tires.append(tireChip(e.tires), document.createTextNode(e.allFour ? 'all four' : `${e.maxTires} at once`));
      cell(tr, tires);
      cell(tr, `${e.seconds.toFixed(2)} s`);
      cell(tr, e.peak.toFixed(2));
      tr.addEventListener('click', () => { selectedPoint = { ...e.worst }; showPoint(selectedPoint); draw(); });
      eventBody.appendChild(tr);
    });
    // Every lap of the session at the same threshold, for comparison (click a row to open that lap)
    laps.forEach((l, index) => {
      const t = TrackAnalysis.offTrackTotals(offEvents(l));
      const tr = document.createElement('tr');
      if (l === lap) tr.className = 'active';
      cell(tr, $('lapSelect').options[index] ? $('lapSelect').options[index].text.split(' · ').slice(0, -1).join(' · ') || `L${l.lap}` : `L${l.lap}`);
      cell(tr, String(t.count), t.count ? 'loss' : '');
      cell(tr, `${t.seconds.toFixed(2)} s`);
      cell(tr, String(t.allFour), t.allFour ? 'loss' : '');
      TrackAnalysis.TIRES.forEach((k) => cell(tr, t.tireSeconds[k] ? `${t.tireSeconds[k].toFixed(1)} s` : '—'));
      tr.addEventListener('click', () => { if (l !== lap) { $('lapSelect').value = String(index); selectLap(); } });
      lapBody.appendChild(tr);
    });
  }
  function showPoint(p) {
    if (!p) return;
    const rows = [
      ['Distance', `${Math.round(p.distance)} m`], ['Lap time', `${((p.t - lap.startedAt) / 1000).toFixed(2)} s`],
      ['Speed', Number.isFinite(p.speed) ? `${(p.speed * MPH).toFixed(1)} mph` : '—'],
      ['Throttle', Number.isFinite(p.throttle) ? `${Math.round(p.throttle * 100)}%` : '—'],
      ['Brake', Number.isFinite(p.brake) ? `${Math.round(p.brake * 100)}%` : '—'],
      ['Lateral G', Number.isFinite(p.gLat) ? `${p.gLat.toFixed(2)} g` : '—'],
      ['Longitudinal G', Number.isFinite(p.gLong) ? `${p.gLong.toFixed(2)} g` : '—'],
      ['Line error', signed(p.lineErr)], ['Brake vs AI', signed(p.aiBrake)], ['Off track', offTrackAt(p)],
      ['Corner position', cornerPosition(p.distance)], ['Track position', trackPosition(p)]
    ];
    const container = $('pointDetails'); container.replaceChildren();
    rows.forEach(([label, value]) => {
      const cell = document.createElement('div'), title = document.createElement('span'), val = document.createElement('strong');
      title.className = 'label'; title.textContent = label; val.textContent = value; cell.append(title, val); container.appendChild(cell);
    });
    const link = $('pointReplay');
    link.href = `playback.html?session=${encodeURIComponent(filename)}&t=${Math.round(p.t)}`;
    link.classList.remove('disabled-link'); link.removeAttribute('aria-disabled');
  }
  function turnPosition(distance) {
    const p = TrackAnalysis.atDistance(lap, distance);
    const a = TrackAnalysis.atDistance(lap, Math.max(0, distance - 5)), b = TrackAnalysis.atDistance(lap, Math.min(lap.length, distance + 5));
    if (!p || !a || !b) return null;
    return { x: +p.x.toFixed(1), z: +p.z.toFixed(1), h: +Math.atan2(b.z - a.z, b.x - a.x).toFixed(3) };
  }
  function saveTurns() {
    if (!lap) return;
    try { localStorage.setItem(trackKey(), JSON.stringify({ v: 1, turns: turns.map(turnPosition).filter(Boolean) })); }
    catch (error) { status(`Could not save turn markers: ${error.message}`, true); }
  }
  // Distance on the open lap of each saved marker: the nearest part of the line heading the same way
  function projectTurns(saved) { return TrackAnalysis.projectMarkers(lap, saved); }
  function loadTurns() {
    turns = [];
    let loaded = false;
    try {
      const raw = stored(trackKey());
      if (raw !== null) {
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.turns)) throw new Error('Invalid saved turn markers');
        turns = projectTurns(parsed.turns);
        loaded = parsed.turns.length === 0 || turns.length > 0;   // an empty saved list is a deliberate choice
      } else {
        const old = stored(oldTurnKey());   // markers saved by the previous version (per session and lap)
        if (old !== null) {
          const parsed = JSON.parse(old);
          if (Array.isArray(parsed) && parsed.every((d) => Number.isFinite(d) && d >= 0 && d <= lap.length)) {
            turns = parsed.slice().sort((x, y) => x - y); saveTurns(); loaded = true;
          }
        }
      }
    } catch (error) { status(`Could not load turn markers: ${error.message}`, true); }
    if (!loaded) {
      turns = TrackAnalysis.estimateTurns(lap);
      if (lap.anchored && stored(trackKey()) === null) saveTurns();   // first lap seen on this track sets the markers
    }
    selectedTurn = -1;
    renderTurns();
  }
  // The same corner region on the comparison lap, found by map position
  function mapRegion(r) { return mapRegionTo(other, r); }
  function mapRegionTo(target, r) {
    if (!target || !lap) return null;
    if (target === lap) return { ...r };
    const mapped = { ...r };
    let previous = -1;
    for (const key of ['approachStart', 'zoneStart', 'entry', 'apex', 'exit', 'zoneEnd']) {
      const p = TrackAnalysis.atDistance(lap, Math.min(lap.length, r[key]));
      const m = p && TrackAnalysis.matchPosition(lap, target, p);
      if (!m || m.distance < previous) return null;
      mapped[key] = previous = m.distance;
    }
    return mapped;
  }
  function cornerSummary(r) {
    let summary = r.detected
      ? `${r.direction > 0 ? 'Left' : 'Right'}, ${Math.round(r.angle * 180 / Math.PI)}°, min radius ${Math.round(r.minRadius)} m. `
      : 'Manual marker. ';
    summary += `Entry ${Math.round(r.entry)} m, exit ${Math.round(r.exit)} m. `;
    const mine = TrackAnalysis.cornerMetrics(lap, r), mapped = mapRegion(r);
    const theirs = mapped ? TrackAnalysis.cornerMetrics(other, mapped) : null;
    [['lineErr', 'Line error (avg)'], ['aiBrake', 'Brake vs AI on the approach (avg)']].forEach(([key, label]) => {
      if (mine[key] === null) return;
      summary += `${label}: ${mine[key].toFixed(2)}${theirs && theirs[key] !== null ? `, comparison ${theirs[key].toFixed(2)}` : ''}. `;
    });
    return summary;
  }
  // Plain-language differences between this lap and the comparison lap in one corner
  function reasons(m, c) {
    const out = [];
    if (m.brakeBefore !== null && c.brakeBefore !== null) {
      const diff = Math.round(m.brakeBefore - c.brakeBefore);
      if (Math.abs(diff) >= 5) out.push(`braked ${Math.abs(diff)} m ${diff > 0 ? 'earlier' : 'later'}`);
    }
    if (m.minSpeed !== null && c.minSpeed !== null) {
      const diff = (m.minSpeed - c.minSpeed) * MPH;
      if (Math.abs(diff) >= 2) out.push(`${Math.abs(diff).toFixed(0)} mph ${diff < 0 ? 'slower' : 'faster'} at the slowest point`);
    }
    if (m.throttleAfter !== null && c.throttleAfter !== null) {
      const diff = Math.round(m.throttleAfter - c.throttleAfter);
      if (Math.abs(diff) >= 5) out.push(`back on throttle ${Math.abs(diff)} m ${diff > 0 ? 'later' : 'earlier'}`);
    }
    if (m.exitSpeed !== null && c.exitSpeed !== null) {
      const diff = (m.exitSpeed - c.exitSpeed) * MPH;
      if (diff <= -2) out.push(`${Math.abs(diff).toFixed(0)} mph slower at the exit`);
    }
    if (m.lineErr !== null && c.lineErr !== null && m.lineErr - c.lineErr >= 0.05) {
      out.push(`further from the ideal line (${m.lineErr.toFixed(2)} vs ${c.lineErr.toFixed(2)})`);
    }
    return out.slice(0, 3);
  }
  // ---- Driving coach: where this lap loses time against the best run through each corner, and brake points ----
  // A full lap; the session's last lap often has no recorded finish crossing, so it counts when it covers the whole distance
  function fullLap(l) {
    if (!l || !l.anchored || l.interrupted) return false;
    if (l.endedAt !== null) return true;
    const finished = laps.filter((x) => x.anchored && !x.interrupted && x.endedAt !== null).map((x) => x.length);
    return finished.length > 0 && l.length >= Math.max(...finished) * 0.985;
  }
  const lapSeconds = (l) => (l.samples[l.samples.length - 1].t - l.samples[0].t) / 1000;
  function fmtLap(v) {
    const m = Math.floor(v / 60);
    return `${m}:${(v - m * 60).toFixed(3).padStart(6, '0')}`;
  }
  function coachEl(tag, className, content) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (content !== undefined) el.textContent = content;
    return el;
  }
  function selectCorner(index) {
    const r = regions[index];
    if (!r) return;
    selectedTurn = index; selectedPoint = TrackAnalysis.atDistance(lap, r.apex); showPoint(selectedPoint);
    renderTurns(); draw();
    canvas.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  // Metres between two brake points, as a position on the open lap: + = you brake earlier
  function brakeGap(mine, target, theirs) {
    if (!mine || !theirs) return null;
    if (target === lap) return theirs.distance - mine.distance;
    const m = TrackAnalysis.matchPosition(target, lap, { ...theirs.point, distance: theirs.distance });
    return m ? m.distance - mine.distance : null;
  }
  // The same braking on another lap: the phase that starts nearest to where yours does
  function pairedBrake(target, r, mine) {
    const mapped = mapRegionTo(target, r);
    if (!mapped || !mine) return null;
    const near = TrackAnalysis.matchPosition(lap, target, { ...mine.point, distance: mine.distance });
    return near ? TrackAnalysis.brakePoint(target, mapped, 'brake', near.distance) : null;
  }
  // reasons() with the brake point measured the same way as the brake list (start of the main braking, by map position)
  function coachReasons(r, target) {
    const mapped = mapRegionTo(target, r);
    if (!mapped) return [];
    const out = reasons(TrackAnalysis.cornerMetrics(lap, r), TrackAnalysis.cornerMetrics(target, mapped)).filter((w) => !w.startsWith('braked'));
    const mine = TrackAnalysis.brakePoint(lap, r), gap = brakeGap(mine, target, pairedBrake(target, r, mine));
    if (gap !== null && Math.abs(gap) >= 5) out.unshift(`braked ${Math.round(Math.abs(gap))} m ${gap > 0 ? 'earlier' : 'later'}`);
    return out.slice(0, 3);
  }
  function brakeWords(gap, who) {
    if (gap === null) return null;
    const m = Math.round(Math.abs(gap));
    return m < 5 ? `at the same point as ${who}` : `${m} m ${gap > 0 ? 'earlier' : 'later'} than ${who}`;
  }
  function renderCoach() {
    const top = $('coachTop'), brakes = $('coachBrakes');
    if (!top || !brakes) return;
    top.replaceChildren(); brakes.replaceChildren();
    const pool = laps.filter(fullLap);
    if (!lap || !regions.length) { text('coachHint', 'Select a lap with marked turns to get coaching.'); return; }
    if (!pool.includes(lap)) pool.push(lap);
    const best = laps.filter(fullLap).reduce((m, l) => (!m || lapSeconds(l) < lapSeconds(m) ? l : m), null);
    const times = TrackAnalysis.cornerTimes(lap, pool, regions);
    const sum = (key) => times.reduce((total, c) => (total === null || !c[key] ? null : total + c[key].seconds), 0);
    const mineTotal = sum('mine'), bestTotal = sum('best');
    let hint = pool.length > 1
      ? `Each corner on L${lap.lap} against the quickest run through it in this session (${pool.length} full laps). A corner runs from halfway after the previous one to halfway before the next.`
      : 'Only one full lap in this session, so there is nothing to compare corners against yet. Brake points are compared with the AI.';
    if (pool.length > 1 && mineTotal !== null && bestTotal !== null) {
      hint += ` Best of every corner: ${fmtLap(bestTotal)}, ${(mineTotal - bestTotal).toFixed(2)} s quicker than this lap.`;
    }
    text('coachHint', hint);

    // 1. Top 3 places to gain time
    const ranked = times.filter((c) => c.lost !== null && c.lost > 0.02 && c.best.lap !== lap).sort((a, b) => b.lost - a.lost).slice(0, 3);
    if (!ranked.length) {
      top.appendChild(coachEl('p', 'hint', pool.length > 1 ? 'This lap was the quickest (or within 0.02 s) through every corner.' : 'Drive more laps in one session to rank corners.'));
    }
    ranked.forEach((c, i) => {
      const r = c.region, card = coachEl('button', 'coach-card');
      card.type = 'button';
      const why = coachReasons(r, c.best.lap);
      const head = coachEl('div', 'coach-card-head');
      head.append(coachEl('span', 'coach-rank', String(i + 1)), coachEl('strong', '', `T${r.index + 1}`),
        coachEl('span', 'coach-loss', `+${c.lost.toFixed(2)} s`));
      card.append(head);
      card.append(coachEl('div', 'coach-sub', `${c.mine.seconds.toFixed(2)} s here vs ${c.best.seconds.toFixed(2)} s on L${c.best.lap.lap}`));
      let detail = why.length ? `Compared with L${c.best.lap.lap}: ${why.join(', ')}.` : 'No single input stands out; look at the line and the delta trace.';
      if (r.zoneStart <= 0 && lap.samples[0].speed < 10) detail += ' Includes the standing start.';
      card.append(coachEl('div', 'coach-why', detail));
      card.addEventListener('click', () => selectCorner(r.index));
      top.appendChild(card);
    });

    // 2. Brake point coaching per corner
    const ai = TrackAnalysis.hasAiBrake(lap);
    let rows = 0;
    regions.forEach((r, i) => {
      const mine = TrackAnalysis.brakePoint(lap, r);
      if (!mine) return;
      const parts = [];
      let target = best && best !== lap ? best : null, who = target ? `your best lap (L${target.lap})` : '';
      if (!target && times[i].best && times[i].best.lap !== lap) {
        target = times[i].best.lap; who = `your quickest run through T${i + 1} (L${target.lap})`;
      }
      let lapGap = null;
      if (target) {
        lapGap = brakeGap(mine, target, pairedBrake(target, r, mine));
        if (lapGap !== null) parts.push(brakeWords(lapGap, who));
      }
      const aiGap = ai ? brakeGap(mine, lap, TrackAnalysis.brakePoint(lap, r, 'ai', mine.distance)) : null;
      if (aiGap !== null) parts.push(brakeWords(aiGap, 'the AI'));
      const li = coachEl('li', 'coach-brake');
      li.tabIndex = 0;
      const tag = coachEl('strong', '', `T${i + 1}`);
      const gaps = [lapGap, aiGap].filter((g) => g !== null);
      const worst = gaps.length ? gaps.reduce((m, g) => (Math.abs(g) > Math.abs(m) ? g : m)) : 0;
      const meters = Math.round(Math.abs(worst));
      const chip = coachEl('span', `coach-chip ${meters < 5 ? 'even' : worst > 0 ? 'early' : 'late'}`,
        meters < 5 ? 'on point' : `${meters} m ${worst > 0 ? 'early' : 'late'}`);
      const sentence = parts.length
        ? `You brake ${parts.join(' and ')}.`
        : `You start braking ${Math.round(r.apex - mine.distance)} m before the apex at ${(mine.speed * MPH).toFixed(0)} mph.`;
      li.append(tag, coachEl('span', 'coach-brake-text', sentence), chip);
      li.addEventListener('click', () => selectCorner(i));
      li.addEventListener('keydown', (event) => { if (event.key === 'Enter') selectCorner(i); });
      brakes.appendChild(li);
      rows++;
    });
    if (!rows) brakes.appendChild(coachEl('li', 'hint', 'No braking before any marked corner on this lap.'));
    text('coachBrakeHint', ai
      ? 'Brake point = where the main braking for the corner starts. AI = where the game AI would start braking at the same spot (from the Brake vs AI channel).'
      : 'Brake point = where the main braking for the corner starts. This session was recorded before the AI brake channel was saved, so there is no AI comparison.');
  }
  function addCell(tr, value, compare, format, diffFormat) {
    const td = document.createElement('td');
    if (value === null || value === undefined) td.textContent = '—';
    else {
      td.textContent = format(value);
      if (compare !== null && compare !== undefined) {
        const diff = document.createElement('span');
        diff.className = 'diff'; diff.textContent = diffFormat(value - compare); td.appendChild(diff);
      }
    }
    tr.appendChild(td);
    return td;
  }
  function renderScorecard() {
    const table = $('cornerTable');
    if (!table) return;
    const body = table.querySelector('tbody'), improve = $('improveList');
    body.replaceChildren(); improve.replaceChildren();
    if (!lap || !regions.length) { text('scoreHint', 'Mark turns to see the corner scorecard.'); return; }
    const rows = regions.map((r) => {
      const mapped = mapRegion(r), zone = mapped ? TrackAnalysis.compareRegion(lap, other, r.zoneStart, r.zoneEnd) : null;
      return { r, mine: TrackAnalysis.cornerMetrics(lap, r), theirs: mapped ? TrackAnalysis.cornerMetrics(other, mapped) : null, lost: zone ? zone.delta : null };
    });
    const compared = rows.some((row) => row.lost !== null);
    text('scoreHint', compared
      ? 'Sorted by time lost against the comparison lap. Small grey numbers are this lap minus the comparison lap. A corner runs from entry to exit; its time covers the approach and exit too.'
      : other ? 'The comparison lap could not be aligned with this lap, so only this lap is shown.' : 'Select a comparison lap to rank corners by time lost. Showing this lap only.');
    if (compared) {
      rows.sort((x, y) => (y.lost ?? -Infinity) - (x.lost ?? -Infinity));
      const worst = rows.filter((row) => row.lost !== null && row.lost > 0.02).slice(0, 3);
      const add = (message) => { const li = document.createElement('li'); li.textContent = message; improve.appendChild(li); };
      if (!worst.length) add('No corner lost more than 0.02 s against the comparison lap.');
      worst.forEach((row) => {
        const why = row.theirs ? reasons(row.mine, row.theirs) : [];
        add(`T${row.r.index + 1}: lost ${row.lost.toFixed(3)} s${why.length ? ' — ' + why.join(', ') : ' — no clear difference in the measured inputs'}.`);
      });
    }
    rows.forEach(({ r, mine, theirs, lost }) => {
      const tr = document.createElement('tr');
      tr.classList.toggle('active', r.index === selectedTurn);
      const head = document.createElement('td');
      head.textContent = `T${r.index + 1}${r.detected ? ` ${r.direction > 0 ? 'L' : 'R'} ${Math.round(r.angle * 180 / Math.PI)}°` : ''}`;
      tr.appendChild(head);
      const them = (key) => (theirs ? theirs[key] : null);
      addCell(tr, mine.brakeBefore, them('brakeBefore'), (v) => `${Math.round(v)} m`, (v) => sgn(v));
      addCell(tr, mine.peakBrake, them('peakBrake'), (v) => `${Math.round(v * 100)}%`, (v) => sgn(v * 100));
      addCell(tr, mine.minSpeed, them('minSpeed'), (v) => `${(v * MPH).toFixed(0)} mph`, (v) => sgn(v * MPH));
      addCell(tr, mine.exitSpeed, them('exitSpeed'), (v) => `${(v * MPH).toFixed(0)} mph`, (v) => sgn(v * MPH));
      addCell(tr, mine.throttleAfter, them('throttleAfter'), (v) => `${sgn(Math.round(v))} m`, (v) => sgn(v));
      addCell(tr, mine.lineErr, them('lineErr'), (v) => v.toFixed(2), (v) => sgn(v, 2));
      const myOff = offEvents(lap), mapped = theirs ? mapRegion(r) : null;
      const offMine = myOff ? TrackAnalysis.offTrackTotals(eventsIn(myOff, r.zoneStart, r.zoneEnd)) : null;
      const theirOff = mapped ? offEvents(other) : null;
      const offTheirs = theirOff ? TrackAnalysis.offTrackTotals(eventsIn(theirOff, mapped.zoneStart, mapped.zoneEnd)) : null;
      const offCell = addCell(tr, offMine ? offMine.seconds : null, offTheirs ? offTheirs.seconds : null,
        (v) => (offMine.count ? `${offMine.count}× · ${v.toFixed(2)} s` : '0'), (v) => `${sgn(v, 2)} s`);
      if (offMine && offMine.count) offCell.classList.add(offMine.allFour ? 'loss' : 'warn');
      const time = document.createElement('td');
      time.textContent = lost === null ? '—' : seconds(lost);
      if (lost !== null && Math.abs(lost) >= 0.005) time.className = lost > 0 ? 'loss' : 'gain';
      tr.appendChild(time);
      tr.addEventListener('click', () => {
        selectedTurn = r.index; selectedPoint = TrackAnalysis.atDistance(lap, r.apex); showPoint(selectedPoint);
        renderTurns(); draw();
      });
      body.appendChild(tr);
    });
  }
  function renderTurns() {
    regions = lap ? TrackAnalysis.cornerRegions(lap, turns) : [];
    const list = $('turnList'); list.replaceChildren();
    if (!turns.length) text('turnDetails', 'No turns marked. Use edit mode to add them.');
    turns.forEach((distance, i) => {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = `T${i + 1}${editing ? ' ×' : ''}`;
      button.classList.toggle('active', i === selectedTurn);
      button.setAttribute('aria-label', `${editing ? 'Remove' : 'Select'} turn ${i + 1} at ${Math.round(distance)} meters`);
      button.addEventListener('click', () => {
        if (editing) { turns.splice(i, 1); selectedTurn = -1; saveTurns(); renderTurns(); draw(); return; }
        selectedTurn = i; selectedPoint = TrackAnalysis.atDistance(lap, distance); showPoint(selectedPoint);
        renderTurns(); draw();
      });
      list.appendChild(button);
    });
    if (selectedTurn >= 0 && regions[selectedTurn]) {
      const r = regions[selectedTurn];
      let description = `T${selectedTurn + 1} · apex ${Math.round(r.apex)} m. ${cornerSummary(r)}`;
      if (!other) description += 'Select a comparison lap to compare this corner.';
      else {
        const inside = TrackAnalysis.compareRegion(lap, other, r.entry, r.exit);
        const zone = TrackAnalysis.compareRegion(lap, other, r.zoneStart, r.zoneEnd);
        description += inside
          ? `Entry to exit: ${inside.referenceSeconds.toFixed(3)} s vs ${inside.otherSeconds.toFixed(3)} s (Δ ${seconds(inside.delta)}). `
          : 'Entry-to-exit comparison unavailable: the region is missing or could not be aligned. ';
        if (zone) description += `Including approach and exit (${Math.round(r.zoneStart)}–${Math.round(r.zoneEnd)} m): Δ ${seconds(zone.delta)}. `;
        description += 'Δ is reference minus comparison, so positive means the reference lap was slower.';
      }
      text('turnDetails', description);
    } else if (turns.length) text('turnDetails', 'Select a turn for a corner comparison.');
    $('clearTurns').disabled = !editing;
    renderScorecard();
    renderCoach();
    renderOffTrack();
  }
  function selectLap() {
    lap = laps[Number($('lapSelect').value)] || null;
    other = $('compareSelect').value === '' ? null : laps[Number($('compareSelect').value)] || null;
    selectedPoint = null; selectedTurn = -1; editing = false; deltaCache = null;
    $('editTurns').classList.remove('active'); $('editTurns').textContent = 'Edit turns';
    $('pointDetails').textContent = 'Hover or select a point on the map.';
    $('pointReplay').classList.add('disabled-link'); $('pointReplay').setAttribute('aria-disabled', 'true');
    if (!lap) { turns = []; renderTurns(); draw(); return; }
    loadTurns();
    text('mapInfo', `L${lap.lap} · ${Math.round(lap.length)} m${!lap.anchored ? ' · partial trace' : lap.interrupted ? ' · interrupted' : lap.endedAt === null ? ' · incomplete' : ''}`);
    text('mapHelp', `Scroll or pinch to zoom; drag to pan. Hover or click the line for readings. ${lap.anchored
      ? 'Distances are estimated from the start/finish line; gaps and rewinds stop a lap trace.'
      : 'No start/finish crossing was recorded: distances start at the first point and sector lines are unavailable.'}`);
    fit();
  }
  function selectComparison() {
    other = $('compareSelect').value === '' ? null : laps[Number($('compareSelect').value)] || null;
    deltaCache = null;
    renderTurns();
    $('overlaySelect').dispatchEvent(new Event('change'));   // refreshes the legend and redraws the map and delta chart
  }
  async function loadSession(file) {
    const request = ++requestId;
    filename = file; laps = []; lap = null; other = null; offCache = new Map(); turns = []; selectedPoint = null; selectedTurn = -1; editing = false; aligned = null; refFit = null;
    $('editTurns').classList.remove('active'); $('editTurns').textContent = 'Edit turns';
    $('lapSelect').replaceChildren(); $('compareSelect').replaceChildren();
    $('lapSelect').disabled = true; $('compareSelect').disabled = true;
    $('pointDetails').textContent = 'Hover or select a point on the map.';
    $('pointReplay').classList.add('disabled-link'); $('pointReplay').setAttribute('aria-disabled', 'true');
    text('trackName', '-'); text('carName', '-'); text('mapInfo', 'Select a lap'); draw(); renderTurns();
    status('Loading session...');
    try {
      const response = await fetch('/api/sessions/' + encodeURIComponent(file));
      if (!response.ok) throw new Error(`Session request failed (${response.status})`);
      const data = await response.json();
      if (request !== requestId) return;
      if (!Array.isArray(data.telemetryPoints) || !data.telemetryPoints.length) throw new Error('This session has no recorded telemetry.');
      if (data.telemetryPoints.some((p) => !p || !Number.isFinite(p.t))) throw new Error('Invalid telemetry timestamps.');
      const points = data.telemetryPoints.slice().sort((a, b) => a.t - b.t);
      if (points.some((p, i) => i && p.t === points[i - 1].t)) throw new Error('Duplicate telemetry timestamps.');
      laps = TrackAnalysis.buildLaps(points, SectorAnalysis.calculate(points));
      if (!laps.length) {
        const partial = TrackAnalysis.partialLap(points);
        if (partial) laps = [partial];
      }
      text('trackName', data.track || 'Unknown'); trackName = data.track || '';
      text('carName', data.car ? (data.car.name || `Car #${data.car.ordinal}`) : 'Unknown');
      if ($('replayLink')) $('replayLink').href = `playback.html?session=${encodeURIComponent(file)}`;   // not present in every version of the page
      let orientationWarning = '';
      try {
        const saved = JSON.parse(localStorage.getItem('mapView:' + (data.track || '_')));
        orientation = saved && Number.isFinite(saved.rot) ? { rot: saved.rot, flip: !!saved.flip } : { rot: 0, flip: false };
      } catch (error) { orientation = { rot: 0, flip: false }; orientationWarning = ` Could not read saved map rotation: ${error.message}`; }
      if (!laps.length) { status('No usable continuous position and speed data.' + orientationWarning, !!orientationWarning); return; }
      const counts = new Map();
      laps.forEach((item, i) => {
        const count = (counts.get(item.lap) || 0) + 1; counts.set(item.lap, count);
        const label = `L${item.lap}${count > 1 ? ` · attempt ${count}` : ''}${!item.anchored ? ' · partial trace' : item.interrupted ? ' · interrupted' : item.endedAt === null ? ' · incomplete' : ''} · ${Math.round(item.length)} m`;
        $('lapSelect').add(new Option(label, String(i)));
        $('compareSelect').add(new Option(label, String(i)));
      });
      $('compareSelect').add(new Option('None', ''), 0);
      const complete = laps.findIndex((item) => item.endedAt !== null && !item.interrupted);
      $('lapSelect').value = String(complete >= 0 ? complete : 0);
      $('compareSelect').value = '';
      $('lapSelect').disabled = false; $('compareSelect').disabled = false;
      status(`${laps.length} recorded lap attempt${laps.length === 1 ? '' : 's'} available.${orientationWarning}`, !!orientationWarning);
      selectLap();
      prepareReference();
    } catch (error) {
      if (request === requestId) status(`Could not load session: ${error.message}`, true);
    }
  }
  async function initialize() {
    resize();
    try {   // tracks.json can list "aliases" so different names for one circuit share the same turn markers
      const response = await fetch('/tracks.json');
      if (response.ok) {
        const json = await response.json();
        const list = Array.isArray(json) ? json : json.tracks || [];
        const entries = list
          .map((t) => ({ name: String(typeof t === 'string' ? t : t && t.name || '').trim(), aliases: t && Array.isArray(t.aliases) ? t.aliases : [], entry: t }))
          .filter((e) => e.name);
        entries.forEach((e) => { trackNames.set(e.name.toLowerCase(), e.name); trackEntries.set(e.name.toLowerCase(), e.entry); });
        // aliases are applied last so they win over a separate entry with the same name (e.g. "Daytona")
        entries.forEach((e) => e.aliases.forEach((alias) => trackNames.set(String(alias).trim().toLowerCase(), e.name)));
      }
    } catch (error) { /* markers fall back to the session's own track name */ }
    try {
      const response = await fetch('/api/sessions?all=1');
      if (!response.ok) throw new Error(`Session list request failed (${response.status})`);
      const list = await response.json();
      if (!Array.isArray(list)) throw new Error('Invalid session list.');
      $('sessionSelect').replaceChildren();
      if (!list.length) { $('sessionSelect').add(new Option('No saved sessions', '')); status('No saved sessions yet.'); return; }
      list.forEach((item) => {
        const date = new Date(item.date), when = Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString();
        $('sessionSelect').add(new Option(`${item.track || 'Unknown track'} · ${when} · ${item.filename}`, item.filename));
      });
      const requested = new URLSearchParams(location.search).get('session');
      if (requested && list.some((item) => item.filename === requested)) $('sessionSelect').value = requested;
      $('sessionSelect').disabled = false;
      await loadSession($('sessionSelect').value);
    } catch (error) { status(`Could not load sessions: ${error.message}`, true); }
  }
  function localPoint(event) {
    const r = canvas.getBoundingClientRect(); return { x: event.clientX - r.left, y: event.clientY - r.top };
  }
  canvas.addEventListener('pointerdown', (event) => {
    if (!lap) return;
    event.preventDefault(); canvas.setPointerCapture(event.pointerId);
    const p = localPoint(event); pointers.set(event.pointerId, p); moved = false;
    if (pointers.size === 1) drag = { start: p, x: view.x, y: view.y };
    else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]; pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) }; drag = null; moved = true;
    }
  });
  canvas.addEventListener('pointermove', (event) => {
    const p = localPoint(event);
    if (pointers.has(event.pointerId)) {
      pointers.set(event.pointerId, p);
      if (pointers.size >= 2 && pinch) {
        const [a, b] = [...pointers.values()], distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch.distance > 0) zoom(distance / pinch.distance, (a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch.distance = distance; moved = true;
      } else if (drag) {
        const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
        if (Math.hypot(dx, dy) > 3) moved = true;
        if (moved) { view.x = drag.x + dx; view.y = drag.y + dy; draw(); }
      }
    } else if (event.pointerType === 'mouse') {
      const point = nearest(p.x, p.y);
      if (point) { selectedPoint = point; showPoint(point); draw(); }
    }
  });
  canvas.addEventListener('pointerup', (event) => {
    const p = localPoint(event), wasClick = pointers.size === 1 && drag && !moved;
    pointers.delete(event.pointerId); drag = null; pinch = null;
    if (wasClick) {
      const point = nearest(p.x, p.y);
      if (point) {
        selectedPoint = point; showPoint(point);
        if (editing) { turns.push(point.distance); turns.sort((a, b) => a - b); selectedTurn = -1; saveTurns(); renderTurns(); }
        draw();
      }
    }
  });
  canvas.addEventListener('pointercancel', (event) => { pointers.delete(event.pointerId); drag = null; pinch = null; });
  canvas.addEventListener('wheel', (event) => {
    if (!lap) return;
    event.preventDefault(); const p = localPoint(event); zoom(Math.exp(-event.deltaY * 0.001), p.x, p.y);
  }, { passive: false });
  $('sessionSelect').addEventListener('change', (event) => loadSession(event.target.value));
  $('lapSelect').addEventListener('change', selectLap);
  $('compareSelect').addEventListener('change', selectComparison);
  ['overlaySelect', 'onsets', 'distances', 'approach', 'offMarkers'].forEach((id) => $(id) && $(id).addEventListener('change', () => {
    updateLegend();
    draw();
  }));
  function updateLegend() {
    const mode = $('overlaySelect').value;
    $('overlayLegend').textContent = mode === 'speed' ? 'Speed: blue = slower, red = faster (scale 0–179 mph)'
      : mode === 'acceleration' ? 'Longitudinal G: teal = acceleration, orange = deceleration · brighter = stronger (scale ±1 g)'
        : mode === 'delta' ? (other ? 'Time against the comparison lap: green = this lap gaining, red = this lap losing · brighter = more per 50 m (full colour at 0.03 s)' : 'Select a comparison lap to see where time is gained or lost')
          : mode === 'lineError' ? 'Racing line error: orange and blue are opposite sides of the game ideal line · brighter = further off (full colour at ±0.5)'
          : mode === 'aiBrake' ? 'Brake vs AI: orange and blue are braking more or less than the game AI · brighter = bigger difference (full colour at ±0.5)'
          : mode === 'offTrack' ? (offEvents(lap) ? 'Off track: yellow → red = 1 to 4 tires off the asphalt · light blue = on a kerb · grey = all four on track' : 'This session has no surface rumble data, so off-track sections cannot be shown')
            : 'Green = throttle, red = brake · brighter = more input';
  }
  $('zoomIn').addEventListener('click', () => { const d = dimensions(); zoom(1.4, d.width / 2, d.height / 2); });
  $('zoomOut').addEventListener('click', () => { const d = dimensions(); zoom(1 / 1.4, d.width / 2, d.height / 2); });
  $('resetView').addEventListener('click', fit);
  $('editTurns').addEventListener('click', () => {
    if (!lap) return;
    editing = !editing; $('editTurns').classList.toggle('active', editing);
    $('editTurns').textContent = editing ? 'Done editing' : 'Edit turns';
    renderTurns(); status(editing ? 'Click the line to add a turn; click a turn button to remove it.' : 'Turn editing closed.');
  });
  $('clearTurns').addEventListener('click', () => { if (!lap || !editing) return; turns = []; selectedTurn = -1; saveTurns(); renderTurns(); draw(); });
  $('resetTurns').addEventListener('click', () => { if (!lap) return; turns = TrackAnalysis.estimateTurns(lap); selectedTurn = -1; saveTurns(); renderTurns(); draw(); });
  [['delta', 'Time delta vs comparison'], ['lineError', 'Racing line error'], ['aiBrake', 'Brake vs AI'], ['offTrack', 'Off track']].forEach(([value, label]) => {
    const select = $('overlaySelect');
    if (![...select.options].some((o) => o.value === value)) select.add(new Option(label, value));
  });
  if ($('deltaChart')) $('deltaChart').addEventListener('click', (event) => {
    const profile = currentDelta();
    if (!profile) return;
    const box = $('deltaChart').getBoundingClientRect(), w = box.width - DELTA_PAD.l - DELTA_PAD.r;
    const distance = (event.clientX - box.left - DELTA_PAD.l) / w * lap.length;
    const point = TrackAnalysis.atDistance(lap, Math.max(0, Math.min(lap.length, distance)));
    if (point) { selectedPoint = point; showPoint(point); draw(); }
  });
  ['edges', 'refRaceline'].forEach((id) => $(id) && $(id).addEventListener('change', draw));
  if ($('refitReference')) $('refitReference').addEventListener('click', () => prepareReference(true));
  if ($('referencePlots')) $('referencePlots').addEventListener('toggle', () => { if ($('referencePlots').open) loadReferencePlots(); });
  if ($('offThreshold')) $('offThreshold').addEventListener('change', () => {
    const value = Number($('offThreshold').value);
    if (!Number.isFinite(value) || value < 0) { $('offThreshold').value = String(offThreshold); return; }
    offThreshold = value;
    try { localStorage.setItem(OFF_KEY, String(value)); } catch (error) { /* threshold just isn't remembered */ }
    renderScorecard(); renderOffTrack(); draw();
  });
  if ($('offReset')) $('offReset').addEventListener('click', () => {
    try { localStorage.removeItem(OFF_KEY); } catch (error) { /* nothing saved */ }
    loadThreshold(); renderScorecard(); renderOffTrack(); draw();
  });
  loadThreshold();
  new ResizeObserver(resize).observe(canvas);
  initialize();
})();
