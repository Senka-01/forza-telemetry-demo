const MPH = 2.237;
const charts = {};

const $ = (id) => document.getElementById(id);

function fmtTime(t) {
  if (t === null || t === undefined || t <= 0) return '--:--.---';
  const m = Math.floor(t / 60);
  return m + ':' + (t % 60).toFixed(3).padStart(6, '0');
}

// one dash tile: label, big value, optional unit line and a 0-100 meter bar
function tile(label, value, unit, cls, meter) {
  const bar = meter ? `<div class="st-meter"><i style="width:${Math.min(100, Math.max(0, meter.pct))}%;background:${meter.color}"></i></div>` : '';
  return `<div class="st-tile${cls ? ' ' + cls : ''}"><div class="st-label">${label}</div><div class="st-val" title="${esc(value)}">${value}</div><div class="st-unit">${unit || ''}</div>${bar}</div>`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function init() {
  let list = [];
  try { list = await (await fetch('/api/sessions')).json(); } catch (e) {}
  if (!list.length) { $('empty').style.display = 'block'; $('sessionSelect').style.display = 'none'; return; }

  $('sessionSelect').innerHTML = list.map((s) => {
    const when = new Date(s.date).toLocaleString();
    const parts = [s.track || 'Unknown track', when];
    if (s.car) parts.push(s.car);
    if (s.bestLap) parts.push('best ' + fmtTime(s.bestLap));
    return `<option value="${esc(s.filename)}">${esc(parts.join(' • '))}</option>`;
  }).join('');
  $('sessionSelect').addEventListener('change', () => load($('sessionSelect').value));
  load(list[0].filename);
}

async function load(file) {
  const s = await (await fetch('/api/sessions/' + encodeURIComponent(file))).json();
  render(s);
}

function render(s) {
  const pts = s.telemetryPoints || [];
  const res = s.results || {};
  const laps = s.laps || [];
  $('content').style.display = 'block';

  // ---- summary cards ----
  const top = pts.length ? Math.max(...pts.map((p) => p.speed)) : (s.maxSpeed || 0);
  const avg = res.avgSpeed || (pts.length ? pts.reduce((a, p) => a + p.speed, 0) / pts.length : 0);
  const fullThrottle = pts.length ? pts.filter((p) => p.throttle > 0.95).length / pts.length * 100 : 0;
  const braking = pts.length ? pts.filter((p) => p.brake > 0.1).length / pts.length * 100 : 0;
  const peakLat = pts.length ? Math.max(...pts.map((p) => Math.abs(p.gLat))) : (s.maxLatG || 0);
  const peakLong = pts.length ? Math.max(...pts.map((p) => Math.abs(p.gLong))) : (s.maxLongG || 0);
  const dur = s.startTime && s.endTime ? (new Date(s.endTime) - new Date(s.startTime)) / 1000 : 0;
  const carName = s.car ? (s.car.name || `Car #${s.car.ordinal}`) : '-';

  $('trackName').textContent = s.track || 'Unknown';
  $('carName').textContent = carName;
  $('sessionDate').textContent = new Date(s.startTime || Date.now()).toLocaleString();

  // row 1: the result. row 2: how the car was driven.
  $('cards').innerHTML =
    '<div class="st-row st-result">' + [
      tile('Finish', res.finalPosition ? 'P' + res.finalPosition : '-', res.fieldSize ? `of ${res.fieldSize} cars` : '', 'st-finish'),
      tile('Laps', res.totalLaps ?? laps.length, 'completed'),
      tile('Best Lap', fmtTime(res.bestLap), '', 'st-best'),
      tile('Avg Lap', fmtTime(res.avgLap)),
      tile('Race Time', fmtTime(res.totalTime || dur)),
      tile('Rewinds', (s.rewinds || []).length)
    ].join('') + '</div>' +
    '<div class="st-row st-perf">' + [
      tile('Top Speed', Math.round(top * MPH), 'mph'),
      tile('Avg Speed', Math.round(avg * MPH), 'mph'),
      tile('Peak Power', Math.round(s.maxHP || 0), 'HP'),
      tile('Peak RPM', Math.round(s.maxRPM || 0), 'rpm'),
      tile('Peak Lat G', peakLat.toFixed(2), 'g'),
      tile('Peak Brake G', peakLong.toFixed(2), 'g'),
      tile('Full Throttle', fullThrottle.toFixed(0) + '%', 'of the race', '', { pct: fullThrottle, color: '#4ade80' }),
      tile('Braking', braking.toFixed(0) + '%', 'of the race', '', { pct: braking, color: '#fb4f60' })
    ].join('') + '</div>';

  // ---- lap table (the game's lap counter starts at 0) ----
  const best = laps.length ? Math.min(...laps.map((l) => l.time)) : null;
  $('lapRows').innerHTML = laps.length ? laps.map((l) => {
    const lp = pts.filter((p) => p.lap === l.lap - 1);
    const rw = (s.rewinds || []).filter((w) => w.lap === l.lap - 1).length;
    const tops = lp.length ? Math.round(Math.max(...lp.map((p) => p.speed)) * MPH) + ' mph' : '-';
    const gap = l.time === best ? 'BEST' : '+' + (l.time - best).toFixed(3);
    return `<tr class="${l.time === best ? 'best' : ''}"><td>${l.lap}${rw ? ` <span class="rw" title="${rw} rewind(s) during this lap">⏪${rw}</span>` : ''}</td><td title="${l.estimated ? 'Estimated from the lap clock (the game did not send this lap time)' : ''}">${l.estimated ? '~' : ''}${fmtTime(l.time)}</td><td>${gap}</td><td>${tops}</td><td>${l.position || '-'}</td></tr>`;
  }).join('') : '<tr><td colspan="5" class="empty">No completed laps recorded</td></tr>';

  // ---- charts ----
  const t0 = pts.length ? pts[0].t : 0;
  // race clock when available (continuous after rewinds are removed), else wall-clock time for old sessions
  const labels = pts.map((p) => (p.rt !== undefined ? Math.round(p.rt) : Math.round((p.t - t0) / 1000)) + 's');
  const line = (label, data, color, extra) => ({
    label, data, borderColor: color, backgroundColor: color + '22', borderWidth: 2, pointRadius: 0, tension: 0.2, ...extra
  });
  const axes = (extra) => ({
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { labels: { color: '#b6b6bf' } } },
    scales: {
      x: { grid: { color: '#26262d' }, border: { color: '#34333b' }, ticks: { color: '#9999a4', maxTicksLimit: 12, maxRotation: 0 } },
      y: { grid: { color: '#26262d' }, border: { color: '#34333b' }, ticks: { color: '#9999a4' }, ...extra }
    }
  });
  const mk = (id, config) => {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart($(id), config);
  };

  mk('speedChart', { type: 'line', data: { labels, datasets: [line('Speed (mph)', pts.map((p) => +(p.speed * MPH).toFixed(1)), '#ff8248', { fill: true })] }, options: axes({ min: 0 }) });
  mk('inputChart', { type: 'line', data: { labels, datasets: [
    line('Throttle %', pts.map((p) => Math.round(p.throttle * 100)), '#4ade80', { borderWidth: 1.2 }),
    line('Brake %', pts.map((p) => Math.round(p.brake * 100)), '#fb4f60', { borderWidth: 1.2 })
  ] }, options: axes({ min: 0, max: 100 }) });
  mk('lapChart', { type: 'bar', data: { labels: laps.map((l) => 'Lap ' + l.lap), datasets: [{
    label: 'Lap time (s)', data: laps.map((l) => l.time),
    backgroundColor: laps.map((l) => (l.time === best ? '#cf91fa' : '#4b4b55')), borderRadius: 4
  }] }, options: axes({}) });
  mk('posChart', { type: 'line', data: { labels, datasets: [line('Position', pts.map((p) => p.pos || null), '#fbbf24', { stepped: true })] },
    options: axes({ reverse: true, min: 1, ticks: { color: '#9999a4', precision: 0 } }) });

  drawMap(pts, s.track, s.rewinds);
}

// slow -> fast colour ramp, same stops as the legend bar in stats.css
const RAMP = [[59, 130, 246], [34, 211, 238], [74, 222, 128], [250, 204, 21], [255, 130, 72], [239, 68, 68]];
function rampColor(f) {
  const x = Math.min(1, Math.max(0, f)) * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(x)), k = x - i;
  const a = RAMP[i], b = RAMP[i + 1];
  return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * k)).join(',')})`;
}

let lastMap = null;
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (lastMap) drawMap(...lastMap); }, 120);
});

function drawMap(pts, track, rewinds) {
  lastMap = [pts, track, rewinds];
  const c = $('mapCanvas');
  // match the drawing buffer to the on-screen size so the line stays sharp
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.max(1, c.clientWidth), chh = Math.max(1, c.clientHeight);
  c.width = Math.round(cw * dpr); c.height = Math.round(chh * dpr);
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, chh);
  const xy = pts.filter((p) => p.x || p.z);
  if (xy.length < 2) {
    ctx.fillStyle = '#80808c'; ctx.font = '15px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('No position data in this session', cw / 2, chh / 2);
    $('mapSlow').textContent = '- mph'; $('mapFast').textContent = '- mph'; $('mapInfo').textContent = '';
    return;
  }

  // Reuse the rotation/mirror saved for this track on the dashboard
  let rot = 0, flip = false;
  try {
    const v = JSON.parse(localStorage.getItem('mapView:' + (track || '_')));
    if (v) { rot = v.rot || 0; flip = !!v.flip; }
  } catch (e) {}
  const th = rot * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th), fl = flip ? -1 : 1;
  const cx0 = (Math.min(...xy.map((p) => p.x)) + Math.max(...xy.map((p) => p.x))) / 2;
  const cz0 = (Math.min(...xy.map((p) => p.z)) + Math.max(...xy.map((p) => p.z))) / 2;
  const q = xy.map((p) => { const u = (p.x - cx0) * fl, v = p.z - cz0; return { x: u * cs - v * sn, z: u * sn + v * cs, speed: p.speed }; });

  const xs = q.map((p) => p.x), zs = q.map((p) => p.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const pad = 28;
  const scale = Math.min((cw - pad * 2) / ((maxX - minX) || 1), (chh - pad * 2) / ((maxZ - minZ) || 1));
  const ox = (cw - (maxX - minX) * scale) / 2, oy = (chh - (maxZ - minZ) * scale) / 2;
  const sx = (x) => ox + (x - minX) * scale, sz = (z) => oy + (z - minZ) * scale;
  const speeds = q.map((p) => p.speed);
  const maxSpeed = Math.max(...speeds) || 1;
  // colour range starts at the 3rd percentile so a standing start does not wash out the slow end
  const minSpeed = Math.min(maxSpeed * 0.95, [...speeds].sort((m, n) => m - n)[Math.floor(speeds.length * 0.03)]);
  const span = (maxSpeed - minSpeed) || 1;
  const jump = (a, b) => Math.hypot(b.x - a.x, b.z - a.z) > 300; // skip teleports

  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // dark road underneath so the coloured line reads as a track
  ctx.strokeStyle = '#2a2a31'; ctx.lineWidth = 12;
  ctx.beginPath();
  q.forEach((p, i) => { if (i === 0 || jump(q[i - 1], p)) ctx.moveTo(sx(p.x), sz(p.z)); else ctx.lineTo(sx(p.x), sz(p.z)); });
  ctx.stroke();

  ctx.lineWidth = 4;
  for (let i = 1; i < q.length; i++) {
    const a = q[i - 1], b = q[i];
    if (jump(a, b)) continue;
    ctx.strokeStyle = rampColor((b.speed - minSpeed) / span);
    ctx.beginPath();
    ctx.moveTo(sx(a.x), sz(a.z));
    ctx.lineTo(sx(b.x), sz(b.z));
    ctx.stroke();
  }

  // start of the recording
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#111116'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(sx(q[0].x), sz(q[0].z), 6, 0, Math.PI * 2); ctx.stroke(); ctx.fill();
  ctx.strokeStyle = '#ff8248'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(sx(q[0].x), sz(q[0].z), 9, 0, Math.PI * 2); ctx.stroke();

  // White rings mark where each rewind put you back on the track
  let rwCount = 0;
  for (const w of rewinds || []) {
    if (!w.x && !w.z) continue;
    rwCount++;
    const u = (w.x - cx0) * fl, v = w.z - cz0;
    const qx = u * cs - v * sn, qz = u * sn + v * cs;
    ctx.strokeStyle = '#111116'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(sx(qx), sz(qz), 8, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(sx(qx), sz(qz), 8, 0, Math.PI * 2); ctx.stroke();
  }

  $('mapSlow').textContent = Math.round(minSpeed * MPH) + ' mph';
  $('mapFast').textContent = Math.round(maxSpeed * MPH) + ' mph';
  $('mapInfo').textContent = (rot || flip ? `Rotated ${rot}°${flip ? ', mirrored' : ''}` : 'Default orientation') + (rwCount ? ` · ${rwCount} rewind${rwCount > 1 ? 's' : ''}` : '');
}

init();