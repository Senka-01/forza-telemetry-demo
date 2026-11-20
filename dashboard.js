// WebSocket connection with retry logic
let ws = null;
let charts = {};
let telemetryHistory = [];
let sessionActive = false;
let reconnectAttempts = 0;
const maxReconnectAttempts = 10;
const reconnectDelay = 2000; // 2 seconds

// Telemetry data
let currentData = {
  speed: 0,
  rpm: 0,
  horsepower: 0,
  torque: 0,
  gear: 'N',
  racePosition: 0,
  isRaceOn: false
};

function createWebSocket() {
  try {
    ws = new WebSocket(`ws://${window.location.host}`);
    
    ws.addEventListener('open', () => {
      updateConnectionStatus(true);
      reconnectAttempts = 0;
      console.log('✅ WebSocket connected to telemetry server');
      postMeta(); // re-send track + field size (the server may have restarted)
    });

    ws.addEventListener('close', () => {
      updateConnectionStatus(false);
      console.log('❌ WebSocket disconnected');
      
      // Attempt reconnection
      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        console.log(`🔄 Reconnect attempt ${reconnectAttempts}/${maxReconnectAttempts} in ${reconnectDelay/1000}s...`);
        setTimeout(createWebSocket, reconnectDelay);
      }
    });

    ws.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data);
        
        if (message.type === 'telemetry' && message.data) {
          handleTelemetryData(message.data);
        }
      } catch (err) {
        console.error('❌ Error parsing WebSocket message:', err);
      }
    });

    ws.addEventListener('error', (error) => {
      console.error('❌ WebSocket error:', error);
      updateConnectionStatus(false);
    });
  } catch (err) {
    console.error('❌ Failed to create WebSocket:', err);
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  console.log('🚀 Dashboard initializing...');
  initializeCharts();
  setupEventListeners();
  
  // Create WebSocket connection
  createWebSocket();
  
  console.log('✅ Dashboard ready');
});

// Initialize Chart.js line charts for telemetry trends
function initializeCharts() {
  const ctxHpTorque = document.getElementById('hpTorqueChart').getContext('2d');
  const ctxRpmSpeed = document.getElementById('rpmSpeedChart').getContext('2d');

  // HP/Torque Chart
  charts.hpTorque = new Chart(ctxHpTorque, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Horsepower',
          data: [],
          borderColor: '#e94560',
          backgroundColor: 'rgba(233, 69, 96, 0.1)',
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          pointRadius: 0
        },
        {
          label: 'Torque',
          data: [],
          borderColor: '#fbbf24',
          backgroundColor: 'rgba(251, 191, 36, 0.1)',
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      plugins: {
        legend: { labels: { color: '#a0a0a0' } }
      },
      scales: {
        y: {
          grid: { color: '#333' },
          ticks: { color: '#a0a0a0' },
          min: 0,
          max: 1000
        },
        x: {
          grid: { color: '#333' },
          ticks: { color: '#a0a0a0' }
        }
      }
    }
  });

  // RPM/Speed Chart
  charts.rpmSpeed = new Chart(ctxRpmSpeed, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'RPM',
          data: [],
          borderColor: '#fbbf24',
          backgroundColor: 'rgba(251, 191, 36, 0.1)',
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          pointRadius: 0
        },
        {
          label: 'Speed (mph)',
          data: [],
          borderColor: '#4ade80',
          backgroundColor: 'rgba(74, 222, 128, 0.1)',
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      plugins: {
        legend: { labels: { color: '#a0a0a0' } }
      },
      scales: {
        y: {
          grid: { color: '#333' },
          ticks: { color: '#a0a0a0' },
          min: 0,
          max: 7000
        },
        x: {
          grid: { color: '#333' },
          ticks: { color: '#a0a0a0' }
        }
      }
    }
  });
}

// Handle incoming telemetry data
function handleTelemetryData(data) {
  latest = data;
  trackPoint(data);
  if (typeof LiveCoach !== 'undefined') LiveCoach.onTelemetry(data);   // delta bar, corner results (live-coach.js)
  currentData = {
    speed: data.speed || 0,
    rpm: data.rpm || 0,
    horsepower: data.horsepower || 0,
    torque: (data.torque || 0) * 0.7376, // N·m -> lb-ft
    gear: getGearLabel(data.gear),
    racePosition: data.racePosition || 0,
    isRaceOn: data.isRaceOn || false
  };

  // Update DOM elements
  updateDashboard();

  // Add to history
  telemetryHistory.push({
    timestamp: new Date().getTime(),
    speed: currentData.speed * 2.237, // stored in mph
    rpm: currentData.rpm,
    hp: currentData.horsepower,
    torque: currentData.torque
  });

  // Keep last 300 points (5 seconds at 60Hz)
  if (telemetryHistory.length > 300) {
    telemetryHistory.shift();
  }

  // Update charts
  updateCharts();
}

// Convert gear number to label
function getGearLabel(gearNum) {
  if (gearNum === undefined) return 'N';
  if (gearNum === 0) return currentData.speed < 1 ? 'N' : 'R'; // 0 = reverse/neutral
  return gearNum.toString();
}

// Update dashboard display
function updateDashboard() {
  // Convert m/s to mph: 1 m/s = 2.237 mph
  const speedMph = (currentData.speed * 2.237).toFixed(1);
  
  document.getElementById('speed').textContent = Math.round(currentData.speed * 2.237); // m/s -> mph
  document.getElementById('rpm').textContent = Math.round(currentData.rpm);
  document.getElementById('hp').textContent = Math.round(currentData.horsepower);
  document.getElementById('torque').textContent = Math.round(currentData.torque);
  document.getElementById('gear').textContent = currentData.gear;
  const fieldN = parseInt(document.getElementById('fieldSize').value, 10);
  document.getElementById('position').textContent = currentData.racePosition > 0
    ? (fieldN > 0 ? `${currentData.racePosition}/${fieldN}` : currentData.racePosition) : '-';

  // Update racing status
  const raceStatus = document.getElementById('raceStatus');
  const raceText = document.getElementById('raceText');
  
  if (currentData.isRaceOn) {
    raceStatus.classList.add('racing');
    raceText.textContent = 'Racing';
    sessionActive = true;
  } else {
    raceStatus.classList.remove('racing');
    raceText.textContent = 'Not Racing';
  }
}

// Update line charts with telemetry history
function updateCharts() {
  if (telemetryHistory.length === 0) return;

  // Create labels (every 60 points = 1 second)
  const labels = telemetryHistory.map((_, i) => {
    const secondsAgo = Math.floor((telemetryHistory.length - i - 1) / 60);
    return secondsAgo > 0 ? `-${secondsAgo}s` : 'now';
  });

  // Update HP/Torque chart
  charts.hpTorque.data.labels = labels;
  charts.hpTorque.data.datasets[0].data = telemetryHistory.map(d => d.hp);
  charts.hpTorque.data.datasets[1].data = telemetryHistory.map(d => d.torque);
  charts.hpTorque.update('none');

  // Update RPM/Speed chart
  charts.rpmSpeed.data.labels = labels;
  charts.rpmSpeed.data.datasets[0].data = telemetryHistory.map(d => d.rpm);
  charts.rpmSpeed.data.datasets[1].data = telemetryHistory.map(d => d.speed);
  charts.rpmSpeed.update('none');
}

// Update connection status indicator
function updateConnectionStatus(connected) {
  const statusEl = document.getElementById('connectionStatus');
  const statusText = document.getElementById('connectionText');
  
  if (connected) {
    statusEl.classList.add('connected');
    statusText.textContent = 'Connected';
  } else {
    statusEl.classList.remove('connected');
    statusText.textContent = 'Connecting...';
  }
}

// Setup event listeners for dashboard controls
function setupEventListeners() {
  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      if (telemetryHistory.length === 0) {
        alert('No telemetry data to export');
        return;
      }
      
      const data = {
        timestamp: new Date().toISOString(),
        dataPoints: telemetryHistory.length,
        summary: {
          maxSpeed: Math.max(...telemetryHistory.map(d => d.speed)).toFixed(2),
          maxRPM: Math.max(...telemetryHistory.map(d => d.rpm)).toFixed(0),
          maxHP: Math.max(...telemetryHistory.map(d => d.hp)).toFixed(0),
          maxTorque: Math.max(...telemetryHistory.map(d => d.torque)).toFixed(0)
        },
        data: telemetryHistory
      };
      
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `telemetry_${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      
      // Show confirmation
      const infoPanel = document.getElementById('infoPanel');
      infoPanel.classList.add('show');
      setTimeout(() => infoPanel.classList.remove('show'), 3000);
    });
  }

  const clearBtn = document.getElementById('clearBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (confirm('Clear all telemetry data?')) {
        telemetryHistory = [];
        updateCharts();
      }
    });
  }
}


// =====================================================================
// Extra panels: pedals, G-force circle, tires, lap bar, car/track, map
// =====================================================================
const LAP_OFFSET = 1;       // Forza counts laps from 0; set to 0 if the lap number reads one too high
const GRAV = 9.81;
const MAX_G = 2;            // outer ring of the G circle
const INVERT_LAT = false;   // flip if the G dot moves the wrong way sideways
const INVERT_LONG = false;  // flip if accel/brake are swapped on the G dot
const MAX_STEER_DEG = 30;   // visual wheel angle at full steering lock

let latest = null;
let gTrail = [];
let trackPts = [];
let lastPt = null;
let mapRot = 0;             // map rotation in degrees (saved per track)
let mapFlip = false;        // mirror the map left/right
let trackOutline = null;    // {points, bounds, img} from a saved outline
let carTable = {};          // { "<carOrdinal>": "name" } from /cars.json (the server keeps it updated)
const trackInfo = {};
const trackAliases = {};    // lower-case alias -> track name (tracks.json "aliases")

// Reference track (TUMFTM racetrack-database via reference-track.js), aligned to Forza coordinates
let refTrack = null;        // parsed reference data for the selected track
let refAligned = null;      // {center, left, right, raceline} in Forza x/z, or null until a fit exists
let refFit = null;          // last fit result
let refAttempts = 0;        // fits tried since the track was selected (each one is a short pause)
let refLap = { lap: null, pts: [], bad: false, seenStart: false };
const REF_MAX_ATTEMPTS = 3;

const trackSelect = document.getElementById('trackSelect');
const trackHint = document.getElementById('trackHint');
const fieldInput = document.getElementById('fieldSize');
const rotSlider = document.getElementById('mapRot');

// ---------- helpers ----------
function fmtTime(t) {
  if (!t || t <= 0) return '--:--.---';
  const m = Math.floor(t / 60);
  return m + ':' + (t % 60).toFixed(3).padStart(6, '0');
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el && el.textContent !== text) el.textContent = text;
}

function tempColor(f) {
  const t = Math.min(1, Math.max(0, (f - 120) / 140)); // 120F..260F
  return `hsl(${240 - 240 * t}, 80%, 50%)`;
}

function boundsOf(pts) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ };
}

function postJSON(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// Tell the server which track / field size to stamp on saved sessions
function postMeta() {
  postJSON('/api/meta', { track: trackSelect.value, fieldSize: parseInt(fieldInput.value, 10) || null }).catch(() => {});
}

// ---------- track recording ----------
function trackPoint(d) {
  if (d.isRaceOn && d.position) refCollect(d);
  if (!d.isRaceOn || !d.position || trackOutline) return;
  const p = d.position;
  if (lastPt) {
    const dist = Math.hypot(p.x - lastPt.x, p.z - lastPt.z);
    if (dist > 300) trackPts = [];   // teleport / restart
    else if (dist < 3) return;
  }
  trackPts.push({ x: p.x, z: p.z });
  lastPt = { x: p.x, z: p.z };
  if (trackPts.length > 20000) trackPts.shift();
}

// ---------- drawing ----------
function drawG(d) {
  const c = document.getElementById('gCanvas');
  const ctx = c.getContext('2d');
  const cx = c.width / 2, cy = c.height / 2, rad = c.width / 2 - 15;
  const lat = (d.accel.x / GRAV) * (INVERT_LAT ? -1 : 1);
  const lon = (d.accel.z / GRAV) * (INVERT_LONG ? -1 : 1);
  const px = cx + Math.max(-MAX_G, Math.min(MAX_G, lat)) / MAX_G * rad;
  const py = cy - Math.max(-MAX_G, Math.min(MAX_G, lon)) / MAX_G * rad;

  gTrail.push({ x: px, y: py });
  if (gTrail.length > 40) gTrail.shift();

  ctx.clearRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
  for (let g = 1; g <= MAX_G; g++) {
    ctx.beginPath(); ctx.arc(cx, cy, rad * g / MAX_G, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx - rad, cy); ctx.lineTo(cx + rad, cy);
  ctx.moveTo(cx, cy - rad); ctx.lineTo(cx, cy + rad);
  ctx.stroke();
  ctx.fillStyle = '#707070'; ctx.font = '12px sans-serif';
  ctx.fillText('1g', cx + rad / MAX_G + 3, cy - 3);
  ctx.fillText('2g', cx + rad - 18, cy - 3);

  gTrail.forEach((p, i) => {
    ctx.fillStyle = `rgba(233, 69, 96, ${(i / gTrail.length) * 0.4})`;
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
  });
  ctx.fillStyle = '#e94560';
  ctx.beginPath(); ctx.arc(px, py, 8, 0, Math.PI * 2); ctx.fill();

  setText('gLat', lat.toFixed(2));
  setText('gLong', lon.toFixed(2));
}

function drawMap(d) {
  const c = document.getElementById('mapCanvas');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (typeof LiveCoach !== 'undefined' && LiveCoach.chase && LiveCoach.drawChase(ctx, c, d)) return;   // heading-up view

  const o = trackOutline;
  const pts = o ? o.points : trackPts;
  const ra = refShown() ? refAligned : null;
  const refEdge = ra ? ra.left.concat(ra.right) : [];
  const b = o ? o.bounds : ra ? boundsOf(refEdge) : (trackPts.length > 1 ? boundsOf(trackPts) : null);
  if (!b) {
    ctx.fillStyle = '#707070'; ctx.font = '22px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Drive a lap and the track will draw itself', c.width / 2, c.height / 2);
    ctx.textAlign = 'start';
    return;
  }

  // World -> map space: mirror (optional), then rotate around the track center
  const cx0 = (b.minX + b.maxX) / 2, cz0 = (b.minZ + b.maxZ) / 2;
  const th = mapRot * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th), fl = mapFlip ? -1 : 1;
  const T = (x, z) => {
    const u = (x - cx0) * fl, v = z - cz0;
    return { x: u * cs - v * sn, z: u * sn + v * cs };
  };

  const hasImg = o && o.img && o.img.complete && o.img.naturalWidth > 0;
  const ref = hasImg
    ? [[b.minX, b.minZ], [b.maxX, b.minZ], [b.minX, b.maxZ], [b.maxX, b.maxZ]].map(([x, z]) => T(x, z))
    : pts.map((p) => T(p.x, p.z));
  refEdge.forEach((p) => ref.push(T(p.x, p.z)));
  let qMinX = Infinity, qMaxX = -Infinity, qMinZ = Infinity, qMaxZ = -Infinity;
  for (const q of ref) {
    if (q.x < qMinX) qMinX = q.x; if (q.x > qMaxX) qMaxX = q.x;
    if (q.z < qMinZ) qMinZ = q.z; if (q.z > qMaxZ) qMaxZ = q.z;
  }
  const pad = 40;
  const scale = Math.min((c.width - pad * 2) / ((qMaxX - qMinX) || 1), (c.height - pad * 2) / ((qMaxZ - qMinZ) || 1));
  const mx = (qMinX + qMaxX) / 2, mz = (qMinZ + qMaxZ) / 2;
  const S = (x, z) => {
    const q = T(x, z);
    return [c.width / 2 + (q.x - mx) * scale, c.height / 2 + (q.z - mz) * scale];
  };

  if (ra) drawReference(ctx, ra, S);

  if (hasImg) {
    const [ix, iz] = S(cx0, cz0);
    const iw = (b.maxX - b.minX) * scale, ih = (b.maxZ - b.minZ) * scale;
    ctx.save();
    ctx.translate(ix, iz); ctx.rotate(th); ctx.scale(fl, 1);
    ctx.globalAlpha = 0.9;
    ctx.drawImage(o.img, -iw / 2, -ih / 2, iw, ih);
    ctx.restore();
  } else {
    ctx.strokeStyle = '#4a90b8'; ctx.lineWidth = 4; ctx.lineJoin = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => { const [x, y] = S(p.x, p.z); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  }
  if (ra && d.position) showRefPosition(ra, d.position);

  if (d.position) {
    const [x, y] = S(d.position.x, d.position.z);
    ctx.fillStyle = '#e94560'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
  }
  if (typeof LiveCoach !== 'undefined') LiveCoach.drawOverlay(ctx, S);   // marker at the corner that cost the most
}

// Track edges (filled band) and the dashed reference raceline, drawn under the driven line
function drawReference(ctx, ra, S) {
  const trace = (list) => {
    list.forEach((p, i) => { const [x, y] = S(p.x, p.z); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath();
  };
  ctx.save();
  ctx.lineJoin = 'round';
  if (refOption('refEdges')) {
    ctx.beginPath(); trace(ra.left); trace(ra.right);
    ctx.fillStyle = 'rgba(150, 165, 190, 0.13)'; ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(190, 205, 230, 0.5)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); trace(ra.left); ctx.stroke();
    ctx.beginPath(); trace(ra.right); ctx.stroke();
  }
  if (refOption('refRaceline') && ra.raceline.length) {
    ctx.strokeStyle = '#facc15'; ctx.lineWidth = 2; ctx.setLineDash([9, 6]);
    ctx.beginPath(); trace(ra.raceline); ctx.stroke();
  }
  ctx.restore();
}

function renderExtras() {
  requestAnimationFrame(renderExtras);
  const d = latest;
  if (!d) return;

  // Lap counter and timers (seconds)
  setText('lapNum', d.lap !== undefined ? String(d.lap + LAP_OFFSET) : '-');
  setText('lapCurrent', fmtTime(d.currentLap));
  setText('lapLast', fmtTime(d.lastLap));
  setText('lapBest', fmtTime(d.bestLap));

  // Pedals
  const th = Math.round((d.throttle || 0) * 100), br = Math.round((d.brake || 0) * 100);
  document.getElementById('throttleFill').style.height = th + '%';
  document.getElementById('brakeFill').style.height = br + '%';
  setText('throttleVal', th + '%');
  setText('brakeVal', br + '%');

  drawG(d);
  drawMap(d);

  // Tires
  const t = d.tireTemp || { fl: 0, fr: 0, rl: 0, rr: 0 };
  ['fl', 'fr', 'rl', 'rr'].forEach((k) => {
    const K = k.toUpperCase();
    document.getElementById('tire' + K).setAttribute('fill', t[k] > 0 ? tempColor(t[k]) : '#444');
    setText('temp' + K, t[k] > 0 ? Math.round(t[k]) + '°F' : '--');
  });
  const angle = (d.steer || 0) * MAX_STEER_DEG;
  document.getElementById('wheelFL').setAttribute('transform', `translate(70,100) rotate(${angle})`);
  document.getElementById('wheelFR').setAttribute('transform', `translate(230,100) rotate(${angle})`);
  setText('steerAngle', angle.toFixed(0));

  // Car name (looked up from cars.json by the game's car id)
  const ord = d.carOrdinal;
  const known = carTable[ord];
  setText('carName', known || `Car #${ord}`);
  setText('carHint', known ? '' : 'Click the name to label this car');
}

// ---------- car names (saved to public/cars.json by the server, one row per car id) ----------
function loadCars() {
  fetch('/cars.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : {}))
    .then((j) => { carTable = j && typeof j === 'object' ? j : {}; })
    .catch(() => {});
}
loadCars();

document.getElementById('carName').addEventListener('click', () => {
  if (!latest || !latest.carOrdinal) return;
  const id = latest.carOrdinal;
  const name = prompt(`Name for car #${id} (leave empty to remove):`, carTable[id] || '');
  if (name === null) return;
  postJSON('/api/cars', { id, name })
    .then((r) => r.json())
    .then((j) => { if (j.cars) carTable = j.cars; })
    .catch(() => alert('Could not save the car name. Is the server running?'));
});

// ---------- field size ----------
try { fieldInput.value = localStorage.getItem('fieldSize') || ''; } catch (e) {}
fieldInput.addEventListener('input', () => {
  try { localStorage.setItem('fieldSize', fieldInput.value); } catch (e) {}
  postMeta();
});

// ---------- map rotation / mirror (remembered per track in this browser) ----------
function viewKey() { return 'mapView:' + (trackSelect.value || '_'); }
function syncView() { rotSlider.value = mapRot; setText('rotVal', Math.round(mapRot) + '°'); }
function saveView() { try { localStorage.setItem(viewKey(), JSON.stringify({ rot: mapRot, flip: mapFlip })); } catch (e) {} }
function loadView() {
  mapRot = 0; mapFlip = false;
  try {
    const v = JSON.parse(localStorage.getItem(viewKey()));
    if (v) { mapRot = v.rot || 0; mapFlip = !!v.flip; }
  } catch (e) {}
  syncView();
}
function setRot(deg) {
  mapRot = ((deg + 180) % 360 + 360) % 360 - 180;
  syncView(); saveView();
}
rotSlider.addEventListener('input', () => setRot(+rotSlider.value));
document.getElementById('rot90Btn').addEventListener('click', () => setRot(mapRot + 90));
document.getElementById('flipBtn').addEventListener('click', () => { mapFlip = !mapFlip; saveView(); });
document.getElementById('autoAlignBtn').addEventListener('click', () => {
  let pts = trackOutline ? trackOutline.points : trackPts;
  if (pts.length < 10 && refShown()) pts = refAligned.center;
  if (pts.length < 10) return;
  let mx = 0, mz = 0;
  pts.forEach((p) => { mx += p.x; mz += p.z; });
  mx /= pts.length; mz /= pts.length;
  let vx = 0, vz = 0, cv = 0;
  pts.forEach((p) => { const a = p.x - mx, b = p.z - mz; vx += a * a; vz += b * b; cv += a * b; });
  const phi = 0.5 * Math.atan2(2 * cv, vx - vz) * 180 / Math.PI; // long axis angle
  setRot(mapFlip ? phi : -phi);
});

// ---------- track dropdown + saved outlines ----------
function savedTrack() {
  try { return localStorage.getItem('trackName') || ''; } catch (e) { return ''; }
}

function loadTrack(name) {
  loadView();
  trackOutline = null; trackPts = []; lastPt = null;
  loadReference(name);
  const info = trackInfo[name];
  if (!info || !info.outline) return;
  fetch(info.outline)
    .then((res) => res.json())
    .then((o) => {
      const pts = o.points || [];
      const img = info.image ? Object.assign(new Image(), { src: info.image }) : null;
      trackOutline = { points: pts, bounds: o.bounds || boundsOf(pts), img };
      refFitOutline();
    })
    .catch(() => { trackHint.textContent = 'Could not load ' + info.outline; });
}

fetch('/tracks.json')
  .then((res) => { if (!res.ok) throw new Error('not found'); return res.json(); })
  .then((json) => {
    const list = Array.isArray(json) ? json : json.tracks || [];
    const names = list.map((t) => (typeof t === 'string' ? t : t.name)).filter(Boolean);
    list.forEach((t) => { if (t && t.name) trackInfo[t.name] = t; });
    // aliases are applied after the plain names, as on the analysis page
    list.forEach((t) => {
      if (t && t.name && Array.isArray(t.aliases)) t.aliases.forEach((a) => { trackAliases[String(a).trim().toLowerCase()] = t.name; });
    });
    names.forEach((n) => {
      const opt = document.createElement('option');
      opt.value = n; opt.textContent = n;
      trackSelect.appendChild(opt);
    });
    const saved = savedTrack();
    if (names.includes(saved)) { trackSelect.value = saved; loadTrack(saved); }
    trackHint.textContent = `${names.length} tracks loaded`;
    postMeta();
  })
  .catch(() => { trackHint.textContent = 'Create public/tracks.json to fill this list'; });

trackSelect.addEventListener('change', () => {
  try { localStorage.setItem('trackName', trackSelect.value); } catch (e) {}
  loadTrack(trackSelect.value);
  postMeta();
});

document.getElementById('clearMapBtn').addEventListener('click', () => loadTrack(trackSelect.value));

// Save the path you just drove as an outline file (one click = one download)
document.getElementById('saveOutlineBtn').addEventListener('click', () => {
  if (trackPts.length < 20) { alert('Drive a lap first (and no saved outline should be loaded).'); return; }
  const name = trackSelect.value || 'track';
  const out = {
    name,
    bounds: boundsOf(trackPts),
    points: trackPts.map((p) => ({ x: +p.x.toFixed(1), z: +p.z.toFixed(1) }))
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
  a.download = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---------- reference track on the live map ----------
// The fit is stored under the same key as the analysis page, so a fit made on either page is reused by the other.
function canonicalTrack(name) {
  const n = String(name || '').trim();
  return trackAliases[n.toLowerCase()] || n;
}
function refAlignKey(name) { return 'trackAnalysis:align:' + canonicalTrack(name).toLowerCase(); }
function refOption(id) { const el = document.getElementById(id); return !el || el.checked; }
function refShown() { return !!refAligned && refOption('refShow'); }
function setRefInfo(text, warn) {
  const el = document.getElementById('refInfo');
  if (!el) return;
  el.textContent = text;
  el.style.color = warn ? '#fbbf24' : '';
}
function refLabel() {
  const info = refTrack && trackInfo[canonicalTrack(refTrack.track)];
  const layout = info && info.reference && info.reference.layout;
  return canonicalTrack(refTrack.track) + (layout ? ' · ' + layout : '');
}
function resetRefLap() { refLap = { lap: null, pts: [], bad: false, seenStart: false }; }

function useRefFit(t) {
  refFit = t;
  refAligned = t && t.ok !== false ? ReferenceTrack.align(refTrack, t) : null;
  if (refAligned) {
    const med = Number.isFinite(t.median) ? t.median.toFixed(1) + ' m' : 'saved';
    const p95 = Number.isFinite(t.p95) ? ` (95% within ${t.p95.toFixed(1)} m)` : '';
    setRefInfo(`${refLabel()}: aligned, typically ${med} from the driven line${p95}${t.mirror ? ', mirrored' : ''}.`);
  }
}

function loadReference(name) {
  const group = document.getElementById('refControls');
  const canon = canonicalTrack(name);
  const info = trackInfo[canon] && trackInfo[canon].reference;
  resetRefLap(); refAttempts = 0;
  if (group) group.hidden = !(info && info.data);
  if (!info || !info.data || typeof ReferenceTrack === 'undefined') {
    refTrack = refAligned = refFit = null;
    setRefInfo('');
    return;
  }
  if (refTrack && refTrack.source === info.data) { applySavedRefFit(); return; }
  refTrack = refAligned = refFit = null;
  setRefInfo('Loading reference track...');
  fetch(info.data)
    .then((res) => { if (!res.ok) throw new Error('request failed (' + res.status + ')'); return res.json(); })
    .then((json) => {
      if (canonicalTrack(trackSelect.value) !== canon) return;   // the track changed while loading
      refTrack = ReferenceTrack.parse(json);
      refTrack.source = info.data; refTrack.track = canon;
      applySavedRefFit();
    })
    .catch((err) => setRefInfo('Reference data unavailable: ' + err.message, true));
}

function applySavedRefFit() {
  const info = trackInfo[refTrack.track].reference;
  let t = null;
  try { t = JSON.parse(localStorage.getItem(refAlignKey(refTrack.track))); } catch (e) {}
  if (!(t && ['rot', 'scale', 'tx', 'tz'].every((k) => Number.isFinite(t[k])))) t = info.align || null;
  if (t) { useRefFit(t); return; }
  refAligned = refFit = null;
  setRefInfo(`${refLabel()}: drive one full lap to line up the reference track.`);
  refFitOutline();
}

// Fit to a closed lap of points [{x, z}]; returns true when the reference matched
function runRefFit(points, what) {
  if (!refTrack || refAttempts >= REF_MAX_ATTEMPTS) return false;
  refAttempts++;
  let t;
  try { t = ReferenceTrack.fit(refTrack, points); } catch (e) { setRefInfo('Reference fit failed: ' + e.message, true); return false; }
  if (t.ok) {
    try { localStorage.setItem(refAlignKey(refTrack.track), JSON.stringify(t)); } catch (e) {}
    useRefFit(t);
    return true;
  }
  refFit = t; refAligned = null;
  setRefInfo(`${refLabel()}: does not match ${what} (95% within ${t.p95} m, scale ${t.scale}). The layout probably differs` +
    (refAttempts < REF_MAX_ATTEMPTS ? '; trying again after the next lap.' : '.'), true);
  return false;
}

function closedLap(pts) {
  if (pts.length < 50) return false;
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  const f = pts[0], e = pts[pts.length - 1];
  return len > 500 && Math.hypot(f.x - e.x, f.z - e.z) < 150;
}

// A saved outline is a recorded lap, so it can be used straight away
function refFitOutline() {
  if (!refTrack || refAligned || !trackOutline || !closedLap(trackOutline.points)) return;
  runRefFit(trackOutline.points, 'the saved outline');
}

// Collect the current lap; when the lap counter ticks over, fit the reference to the lap just finished
function refCollect(d) {
  if (!refTrack || refAligned || refAttempts >= REF_MAX_ATTEMPTS || d.lap === undefined) return;
  const p = d.position;
  if (refLap.lap !== null && d.lap !== refLap.lap) {
    const done = refLap, finished = d.lap === done.lap + 1 && !done.bad && closedLap(done.pts);
    refLap = { lap: d.lap, pts: [], bad: false, seenStart: true };
    if (finished) { const pts = done.pts; setTimeout(() => runRefFit(pts, 'your lap'), 0); }
  } else if (refLap.lap === null) {
    refLap.lap = d.lap;
  }
  const last = refLap.pts[refLap.pts.length - 1];
  if (last) {
    const dist = Math.hypot(p.x - last.x, p.z - last.z);
    if (dist > 300) refLap.bad = true;   // teleport / rewind: this lap cannot be used
    else if (dist < 3) return;
  }
  refLap.pts.push({ x: p.x, z: p.z });
}

// Live readout of where the car sits on the reference track
let refPosAt = 0;
function showRefPosition(ra, pos) {
  const now = performance.now();
  if (now - refPosAt < 200) return;
  refPosAt = now;
  const el = document.getElementById('refPos');
  if (!el) return;
  const r = ReferenceTrack.position(ra, pos.x, pos.z);
  if (!r) { el.textContent = ''; return; }
  const edge = Math.abs(r.fraction);
  el.textContent = `${Math.abs(r.offset).toFixed(1)} m ${r.offset >= 0 ? 'left' : 'right'} of center · ` +
    (edge > 1 ? 'past the edge' : Math.round(edge * 100) + '% to the edge');
}

const refitBtn = document.getElementById('refitRefBtn');
if (refitBtn) refitBtn.addEventListener('click', () => {
  if (!refTrack) return;
  try { localStorage.removeItem(refAlignKey(refTrack.track)); } catch (e) {}
  refAligned = refFit = null; refAttempts = 0; resetRefLap();
  setRefInfo(`${refLabel()}: drive one full lap to line up the reference track.`);
  refFitOutline();
});

loadView();
requestAnimationFrame(renderExtras);