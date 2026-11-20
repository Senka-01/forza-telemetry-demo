'use strict';

const GAP_MS = 1000;
const HISTORY_MS = 50000;
const MPH = 2.237;
const LB_FT = 0.7376;

function lastIndexAt(points, time) {
  let low = 0, high = points.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (points[mid].t <= time) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

function pointAt(points, time) {
  const index = lastIndexAt(points, time);
  return index >= 0 && time - points[index].t <= GAP_MS ? points[index] : null;
}

function sectorMarkerLocations(points, runs) {
  let best = null;
  for (const run of runs) {
    const boundaries = [{ number: 1, time: run.startedAt },
      ...run.sectors.filter((sector) => !sector.partial).map((sector) => ({ number: sector.number + 1, time: sector.end }))];
    const markers = [];
    for (const boundary of boundaries) {
      let index = lastIndexAt(points, boundary.time);
      if (index === points.length - 1) index--;
      if (index < 0 || !points[index + 1]) continue;
      const a = points[index], b = points[index + 1], dt = b.t - a.t;
      if (dt <= 0 || dt > GAP_MS || boundary.time < a.t || boundary.time > b.t ||
          !Number.isFinite(a.x) || !Number.isFinite(a.z) || !Number.isFinite(b.x) || !Number.isFinite(b.z) ||
          (a.x === 0 && a.z === 0) || (b.x === 0 && b.z === 0)) continue;
      const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
      if (length < 0.1 || length > 300) continue;
      const fraction = (boundary.time - a.t) / dt;
      markers.push({ number: boundary.number, x: a.x + dx * fraction, z: a.z + dz * fraction, dx, dz });
    }
    if (markers.length && (!best || markers.length > best.markers.length)) best = { lap: run.lap, markers };
  }
  return best;
}

function sectorRunsAt(runs, time) {
  const grouped = new Map();
  runs.forEach((run) => {
    if (run.startedAt <= time) {
      if (!grouped.has(run.lap)) grouped.set(run.lap, []);
      grouped.get(run.lap).push(run);
    }
  });
  return [...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([lap, attempts]) => {
    const latest = attempts[attempts.length - 1], sectors = new Map();
    attempts.forEach((run) => run.sectors.forEach((sector) => {
      if (sector.end <= time) sectors.set(sector.number, { ...sector, previous: run !== latest });
    }));
    return {
      lap,
      invalid: latest.invalidAt !== null && latest.invalidAt <= time ? latest.invalidReason : null,
      sectors: [...sectors.values()]
    };
  });
}

if (typeof module !== 'undefined') module.exports = { lastIndexAt, pointAt, sectorMarkerLocations, sectorRunsAt, GAP_MS };

if (typeof document !== 'undefined') {
  const $ = (id) => document.getElementById(id);
  const controls = ['seek', 'back', 'play', 'forward', 'rate'];
  let session = null, points = [], charts = [], mapPath = null, sectorRuns = [], sectorRenderKey = '';
  let elapsed = 0, duration = 0, playing = false, previousFrame = 0, lastDraw = 0, requestId = 0;

  function status(message, error = false) {
    $('status').textContent = message;
    $('status').classList.toggle('error', error);
  }

  function setControls(enabled) {
    controls.forEach((id) => { $(id).disabled = !enabled; });
  }

  function clock(ms) {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    const rest = String(seconds % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
  }

  function lapTime(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '--:--.---';
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${(seconds % 60).toFixed(3).padStart(6, '0')}`;
  }

  function setText(id, value) { $(id).textContent = String(value); }
  function displayNumber(value, factor = 1) {
    return Number.isFinite(value) ? Math.round(value * factor) : '-';
  }
  function displayDecimal(value) {
    return Number.isFinite(value) ? value.toFixed(2) : '-';
  }

  function chart(id, labels, colors, y, speedAxis = false) {
    return new Chart($(id), {
      type: 'line',
      data: { datasets: labels.map((label, i) => ({
        label, data: [], borderColor: colors[i], borderWidth: 2,
        pointRadius: 0, tension: 0, spanGaps: false,
        yAxisID: speedAxis && i === 2 ? 'ySpeed' : 'y'
      })) },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
        plugins: { legend: { labels: { color: '#a0a0a0' } } },
        scales: {
          x: { type: 'linear', title: { display: true, text: 'Recording time (seconds)', color: '#a0a0a0' }, grid: { color: '#303038' }, ticks: { color: '#a0a0a0' } },
          y: { ...y, grid: { color: '#303038' }, ticks: { color: '#a0a0a0' } },
          ...(speedAxis ? { ySpeed: { position: 'right', suggestedMin: 0, suggestedMax: 160, title: { display: true, text: 'mph', color: '#a0a0a0' }, grid: { drawOnChartArea: false }, ticks: { color: '#a0a0a0' } } } : {})
        }
      }
    });
  }

  const chartFields = [
    [(p) => Number.isFinite(p.throttle) ? p.throttle * 100 : null,
      (p) => Number.isFinite(p.brake) ? p.brake * 100 : null,
      (p) => Number.isFinite(p.speed) ? p.speed * MPH : null],
    [(p) => p.gLat],
    [(p) => Number.isFinite(p.steer) ? p.steer * 100 : null],
    [(p) => p.hp, (p) => Number.isFinite(p.torque) ? p.torque * LB_FT : null],
    [(p) => p.rpm, (p) => Number.isFinite(p.speed) ? p.speed * MPH : null]
  ];

  function drawCharts(time) {
    const start = points[0].t;
    const begin = Math.max(0, lastIndexAt(points, time - HISTORY_MS));
    const end = lastIndexAt(points, time);
    const series = chartFields.map((fields) => fields.map(() => []));
    const addGap = (x) => series.forEach((group) => group.forEach((data) => data.push({ x, y: null })));
    for (let i = begin; i <= end; i++) {
      const p = points[i];
      if (i > begin && p.t - points[i - 1].t > GAP_MS) {
        addGap((points[i - 1].t + GAP_MS - start) / 1000);
      }
      const x = (p.t - start) / 1000;
      chartFields.forEach((fields, group) => {
        fields.forEach((field, j) => {
          const value = field(p);
          series[group][j].push({ x, y: Number.isFinite(value) ? value : null });
        });
      });
    }
    if (!pointAt(points, time) && end >= begin) {
      addGap((points[end].t + GAP_MS - start) / 1000);
    }
    const left = Math.max(0, (time - start - HISTORY_MS) / 1000);
    charts.forEach((c, i) => {
      c.data.datasets.forEach((dataset, j) => { dataset.data = series[i][j]; });
      c.options.scales.x.min = left;
      c.options.scales.x.max = Math.max(50, (time - start) / 1000);
      c.update('none');
    });
  }

  function renderSectors(time) {
    const visible = sectorRunsAt(sectorRuns, time);
    const key = JSON.stringify(visible);
    if (key === sectorRenderKey) return;
    sectorRenderKey = key;
    const table = $('sectorTable');
    const head = table.tHead, body = table.tBodies[0];
    head.replaceChildren(); body.replaceChildren();
    const invalid = visible.filter((run) => run.invalid);
    const message = invalid.length ? invalid.map((run) => `L${run.lap} interrupted: ${run.invalid.toLowerCase()}; completed sectors retained.`).join(' ')
      : visible.length ? 'Times appear as sectors are completed.' : 'Waiting for an observed start/finish crossing.';
    setText('sectorMessage', message);
    const count = visible.reduce((max, run) => Math.max(max, run.sectors.length), 0);
    if (!count) return;
    const row = head.insertRow();
    ['Sector', 'Best', ...visible.map((run) => `L${run.lap}`)].forEach((title) => {
      const th = document.createElement('th'); th.scope = 'col'; th.textContent = title; row.appendChild(th);
    });
    for (let number = 1; number <= count; number++) {
      const tr = body.insertRow(), label = tr.insertCell();
      label.textContent = `S${number}`;
      const sectors = visible.map((run) => run.sectors.find((sector) => sector.number === number));
      const full = sectors.filter((sector) => sector && !sector.partial);
      const partial = sectors.filter((sector) => sector && sector.partial);
      const bestFull = full.length ? Math.min(...full.map((sector) => sector.seconds)) : null;
      const bestPartial = partial.length ? Math.min(...partial.map((sector) => sector.seconds)) : null;
      const best = tr.insertCell();
      if (bestFull !== null) best.textContent = `${bestFull.toFixed(3)}s${bestPartial !== null ? ' full' : ''}`;
      if (bestPartial !== null) {
        const winner = partial.find((sector) => sector.seconds === bestPartial);
        const note = document.createElement('small');
        note.textContent = `${bestPartial.toFixed(3)}s final · ${Math.round(winner.meters)} m`;
        best.appendChild(note);
      }
      best.className = 'best-sector';
      sectors.forEach((sector) => {
        const cell = tr.insertCell();
        if (!sector) { cell.textContent = '—'; return; }
        cell.textContent = sector.seconds.toFixed(3) + 's';
        const best = sector.partial ? bestPartial : bestFull;
        if (sector.seconds === best) cell.className = 'best-sector';
        if (sector.partial || sector.previous) {
          const note = document.createElement('small');
          note.textContent = [sector.partial ? `${Math.round(sector.meters)} m final` : '',
            sector.previous ? 'previous attempt' : ''].filter(Boolean).join(' · ');
          cell.appendChild(note);
        }
      });
    }
  }

  function drawG(p) {
    const c = $('gCanvas'), ctx = c.getContext('2d');
    const cx = c.width / 2, cy = c.height / 2, rad = c.width / 2 - 15;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.strokeStyle = '#333';
    for (let g = 1; g <= 2; g++) {
      ctx.beginPath(); ctx.arc(cx, cy, rad * g / 2, 0, 2 * Math.PI); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(cx - rad, cy); ctx.lineTo(cx + rad, cy);
    ctx.moveTo(cx, cy - rad); ctx.lineTo(cx, cy + rad); ctx.stroke();
    if (p && Number.isFinite(p.gLat) && Number.isFinite(p.gLong)) {
      const x = cx + Math.max(-2, Math.min(2, p.gLat)) / 2 * rad;
      const y = cy - Math.max(-2, Math.min(2, p.gLong)) / 2 * rad;
      ctx.fillStyle = '#e94560'; ctx.beginPath(); ctx.arc(x, y, 8, 0, 2 * Math.PI); ctx.fill();
    }
  }

  function prepareMap() {
    const c = $('mapCanvas');
    const valid = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.z) && (p.x !== 0 || p.z !== 0));
    if (valid.length < 2) { mapPath = null; return; }
    let view = { rot: 0, flip: false };
    try {
      const saved = JSON.parse(localStorage.getItem('mapView:' + (session.track || '_')));
      if (saved && Number.isFinite(saved.rot)) view = { rot: saved.rot, flip: !!saved.flip };
    } catch (error) {
      console.warn('Could not read the saved map view:', error);
    }
    const theta = view.rot * Math.PI / 180, cs = Math.cos(theta), sn = Math.sin(theta), flip = view.flip ? -1 : 1;
    const transform = (p) => ({ x: p.x * flip * cs - p.z * sn, z: p.x * flip * sn + p.z * cs });
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    valid.forEach((p) => {
      const q = transform(p);
      minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
      minZ = Math.min(minZ, q.z); maxZ = Math.max(maxZ, q.z);
    });
    const scale = Math.min((c.width - 80) / (maxX - minX || 1), (c.height - 80) / (maxZ - minZ || 1));
    const project = (p) => {
      const q = transform(p);
      return [c.width / 2 + (q.x - (minX + maxX) / 2) * scale, c.height / 2 + (q.z - (minZ + maxZ) / 2) * scale];
    };
    const path = new Path2D();
    let previous = null;
    points.forEach((p) => {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z) || (p.x === 0 && p.z === 0)) { previous = null; return; }
      const [x, y] = project(p);
      if (!previous || p.t - previous.t > GAP_MS || Math.hypot(p.x - previous.x, p.z - previous.z) > 300) path.moveTo(x, y);
      else path.lineTo(x, y);
      previous = p;
    });
    const reference = sectorMarkerLocations(points, sectorRuns);
    mapPath = { path, project, reference };
    setText('mapSectorNote', reference
      ? `Sector lines are estimated from L${reference.lap}'s recorded driving line.`
      : 'Sector lines unavailable: no recorded crossing with usable position data.');
  }

  function drawMap(p) {
    const c = $('mapCanvas'), ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    if (!mapPath) {
      ctx.fillStyle = '#a0a0a0'; ctx.font = '22px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('No recorded position data', c.width / 2, c.height / 2);
      return;
    }
    ctx.strokeStyle = '#4a90b8'; ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.stroke(mapPath.path);
    if (mapPath.reference) {
      mapPath.reference.markers.forEach((marker) => {
        const [x, y] = mapPath.project(marker);
        const [nextX, nextY] = mapPath.project({ x: marker.x + marker.dx, z: marker.z + marker.dz });
        const length = Math.hypot(nextX - x, nextY - y);
        if (!length) return;
        const nx = -(nextY - y) / length, ny = (nextX - x) / length;
        ctx.strokeStyle = '#ffb56f'; ctx.lineWidth = 7; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x - nx * 28, y - ny * 28); ctx.lineTo(x + nx * 28, y + ny * 28); ctx.stroke();
        ctx.font = 'bold 34px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 8; ctx.strokeStyle = '#111116'; ctx.fillStyle = '#fff';
        const label = `S${marker.number}`, labelX = x + nx * 50, labelY = y + ny * 50;
        ctx.strokeText(label, labelX, labelY); ctx.fillText(label, labelX, labelY);
      });
    }
    if (p && Number.isFinite(p.x) && Number.isFinite(p.z) && (p.x !== 0 || p.z !== 0)) {
      const [x, y] = mapPath.project(p);
      ctx.fillStyle = '#e94560'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    }
  }

  function render() {
    if (!session) return;
    const time = points[0].t + elapsed;
    const p = pointAt(points, time);
    $('seek').value = elapsed / 1000;
    setText('clock', `${clock(elapsed)} / ${clock(duration)}`);
    status(p ? (playing ? 'Playing recorded telemetry' : 'Paused') : 'No telemetry recorded at this time');
    ['speed', 'rpm', 'hp', 'torque'].forEach((id) => {
      const factor = id === 'speed' ? MPH : id === 'torque' ? LB_FT : 1;
      setText(id, p ? displayNumber(p[id], factor) : '-');
    });
    setText('gear', p && Number.isFinite(p.gear) ? (p.gear === 0 ? (p.speed < 1 ? 'N' : 'R') : p.gear) : '-');
    setText('position', p && p.pos > 0 ? (session.fieldSize ? `${p.pos}/${session.fieldSize}` : p.pos) : '-');
    setText('lapNum', p && Number.isFinite(p.lap) ? p.lap + 1 : '-');
    setText('lapCurrent', p ? lapTime(p.lapTime) : '--:--.---');
    const completed = (Array.isArray(session.laps) ? session.laps : []).filter((l) => Number.isFinite(l.time) && Date.parse(l.endedAt) <= time);
    setText('lapLast', completed.length ? lapTime(completed[completed.length - 1].time) : '--:--.---');
    setText('lapBest', completed.length ? lapTime(Math.min(...completed.map((l) => l.time))) : '--:--.---');
    ['throttle', 'brake'].forEach((name) => {
      const value = p && Number.isFinite(p[name]) ? Math.round(Math.max(0, Math.min(1, p[name])) * 100) : null;
      $(name + 'Fill').style.height = (value === null ? 0 : value) + '%';
      setText(name + 'Val', value === null ? '-' : value + '%');
    });
    setText('gLat', p ? displayDecimal(p.gLat) : '-');
    setText('gLong', p ? displayDecimal(p.gLong) : '-');
    drawG(p);
    const angle = p && Number.isFinite(p.steer) ? p.steer * 30 : null;
    setText('steerAngle', angle === null ? '-' : Math.round(angle));
    ['FL', 'FR', 'RL', 'RR'].forEach((key) => {
      const temp = p && p.tire && p.tire[key.toLowerCase()];
      const valid = Number.isFinite(temp) && temp > 0;
      const ratio = valid ? Math.max(0, Math.min(1, (temp - 120) / 140)) : 0;
      $('tire' + key).setAttribute('fill', valid ? `hsl(${240 - 240 * ratio}, 80%, 50%)` : '#444');
      setText('temp' + key, valid ? Math.round(temp) + '°F' : '--');
    });
    $('wheelFL').setAttribute('transform', `translate(70,100) rotate(${angle === null ? 0 : angle})`);
    $('wheelFR').setAttribute('transform', `translate(230,100) rotate(${angle === null ? 0 : angle})`);
    drawMap(p);
    drawCharts(time);
    renderSectors(time);
  }

  function clearDisplay() {
    ['carName', 'trackName', 'fieldSize', 'speed', 'rpm', 'hp', 'torque', 'gear', 'position',
      'lapNum', 'throttleVal', 'brakeVal', 'gLat', 'gLong', 'steerAngle'].forEach((id) => setText(id, '-'));
    ['lapCurrent', 'lapLast', 'lapBest'].forEach((id) => setText(id, '--:--.---'));
    ['FL', 'FR', 'RL', 'RR'].forEach((key) => {
      $('tire' + key).setAttribute('fill', '#444');
      setText('temp' + key, '--');
    });
    $('wheelFL').setAttribute('transform', 'translate(70,100)');
    $('wheelFR').setAttribute('transform', 'translate(230,100)');
    $('throttleFill').style.height = '0%';
    $('brakeFill').style.height = '0%';
    $('seek').value = 0;
    setText('clock', '0:00 / 0:00');
    sectorRenderKey = '';
    $('sectorTable').tHead.replaceChildren();
    $('sectorTable').tBodies[0].replaceChildren();
    setText('sectorMessage', 'Select a session to calculate sectors.');
    setText('mapSectorNote', 'Sector lines appear when a crossing and position are recorded.');
    drawG(null);
    drawMap(null);
    charts.forEach((c) => {
      c.data.datasets.forEach((dataset) => { dataset.data = []; });
      c.update('none');
    });
  }

  function pause() {
    playing = false;
    previousFrame = 0;
    setText('play', 'Play');
  }

  function seek(ms) {
    elapsed = Math.max(0, Math.min(duration, ms));
    previousFrame = 0;
    if (elapsed >= duration && playing) pause();
    render();
  }

  function togglePlay() {
    if (!session) return;
    if (playing) pause();
    else {
      if (elapsed >= duration) elapsed = 0;
      playing = true;
      previousFrame = 0;
      setText('play', 'Pause');
    }
    render();
  }

  function tick(now) {
    if (playing) {
      if (previousFrame) elapsed = Math.min(duration, elapsed + (now - previousFrame) * Number($('rate').value));
      previousFrame = now;
      if (elapsed >= duration) pause();
      if (!playing || now - lastDraw >= 100) { render(); lastDraw = now; }
    }
    requestAnimationFrame(tick);
  }

  async function loadSession(filename, initialTime = null) {
    const id = ++requestId;
    pause(); session = null; points = []; mapPath = null; sectorRuns = []; elapsed = 0; duration = 0;
    setControls(false);
    clearDisplay();
    status('Loading session...');
    try {
      const response = await fetch('/api/sessions/' + encodeURIComponent(filename));
      if (!response.ok) throw new Error(`Session request failed (${response.status})`);
      const data = await response.json();
      if (id !== requestId) return;
      if (!Array.isArray(data.telemetryPoints) || !data.telemetryPoints.length) throw new Error('This session has no recorded telemetry.');
      if (data.telemetryPoints.some((p) => !p || !Number.isFinite(p.t))) throw new Error('The session contains invalid telemetry timestamps.');
      const sorted = data.telemetryPoints.slice().sort((a, b) => a.t - b.t);
      if (sorted.some((p, i) => i > 0 && p.t === sorted[i - 1].t)) throw new Error('The session contains duplicate telemetry timestamps.');
      session = data;
      points = sorted;
      sectorRuns = SectorAnalysis.calculate(points);
      duration = points[points.length - 1].t - points[0].t;
      setText('carName', data.car ? (data.car.name || `Car #${data.car.ordinal}`) : 'Unknown');
      setText('trackName', data.track || 'Unknown');
      setText('fieldSize', data.fieldSize || '-');
      $('seek').max = duration / 1000;
      $('seek').step = '0.001';
      $('analysisLink').href = `analysis.html?session=${encodeURIComponent(filename)}`;
      prepareMap();
      setControls(true);
      if (Number.isFinite(initialTime)) seek(initialTime - points[0].t);
      else render();
    } catch (error) {
      if (id !== requestId) return;
      session = null; points = [];
      status(`Could not load session: ${error.message}`, true);
    }
  }

  async function initialize() {
    if (typeof Chart === 'undefined') {
      status('Chart library could not be loaded. Check your internet connection and reload.', true);
      return;
    }
    charts = [
      chart('inputChart', ['Throttle (%)', 'Brake (%)', 'Speed (mph)'], ['#42a9f5', '#fb4f60', '#a8d75a'], { min: 0, max: 100 }, true),
      chart('lateralChart', ['Lateral G'], ['#42a9f5'], { suggestedMin: -2, suggestedMax: 2 }),
      chart('steeringChart', ['Steering input (%)'], ['#42a9f5'], { min: -100, max: 100 }),
      chart('hpTorqueChart', ['Horsepower', 'Torque (lb-ft)'], ['#ff8248', '#fbbf24'], { suggestedMin: 0, suggestedMax: 1000 }),
      chart('rpmSpeedChart', ['RPM', 'Speed (mph)'], ['#fbbf24', '#a8d75a'], { suggestedMin: 0, suggestedMax: 7000 })
    ];
    try {
      const response = await fetch('/api/sessions?all=1');
      if (!response.ok) throw new Error(`Session list request failed (${response.status})`);
      const list = await response.json();
      if (!Array.isArray(list)) throw new Error('Invalid session list.');
      $('sessionSelect').replaceChildren();
      if (!list.length) {
        $('sessionSelect').add(new Option('No saved sessions', ''));
        status('No saved sessions yet. Finish a race with the server running.');
        return;
      }
      list.forEach((item) => {
        const date = new Date(item.date);
        const when = Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString();
        $('sessionSelect').add(new Option(`${item.track || 'Unknown track'} · ${when} · ${item.filename}`, item.filename));
      });
      $('sessionSelect').disabled = false;
      const params = new URLSearchParams(location.search);
      const requested = params.get('session');
      if (requested && list.some((item) => item.filename === requested)) $('sessionSelect').value = requested;
      const timestamp = params.get('t');
      await loadSession($('sessionSelect').value, requested === $('sessionSelect').value && timestamp !== null ? Number(timestamp) : null);
    } catch (error) {
      status(`Could not load sessions: ${error.message}`, true);
    }
  }

  $('sessionSelect').addEventListener('change', (event) => loadSession(event.target.value));
  $('play').addEventListener('click', togglePlay);
  $('back').addEventListener('click', () => seek(elapsed - 10000));
  $('forward').addEventListener('click', () => seek(elapsed + 10000));
  $('seek').addEventListener('input', (event) => seek(Number(event.target.value) * 1000));
  $('rate').addEventListener('change', () => { previousFrame = 0; });
  document.addEventListener('keydown', (event) => {
    if (!session || /^(INPUT|SELECT|BUTTON|TEXTAREA)$/.test(event.target.tagName) || event.target.isContentEditable) return;
    if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); seek(elapsed - 10000); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); seek(elapsed + 10000); }
  });
  initialize();
  requestAnimationFrame(tick);
}
