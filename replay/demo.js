'use strict';

// Static demo of the telemetry app: no game, no server.
// Loaded first on every page. It
//   1. answers the app's /api/* calls from static JSON in api/ (built from one recorded session),
//   2. makes root paths ("/tracks.json", "/") work when the demo sits in a sub-folder of a website,
//   3. on the live page, replaces the WebSocket with a player that replays the session at real speed,
//      locked to the screen recording: the video is the clock, so pausing or scrubbing it moves the dashboard too.
(() => {
  const DEMO = {
    session: 'laguna-seca-2026-11-20T08-22-09.parquet', // file name as the real server lists it
    track: 'Laguna Seca',
    fieldSize: 24,
    // In-game race clock (HUD "Race time") on the first frame of the video. Read off the HUD (2:47.936) and
    // checked against the recorded speed and gear across the clip. Change this if you re-cut the video.
    videoStartRaceTime: 167.936,
    noVideoWindow: [167.936, 195.17]   // race-clock window replayed if the video can't load
  };

  const BASE = new URL('../', document.currentScript.src).href; // demo root (this file lives in replay/)
  const api = (p) => BASE + 'api/' + p;
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  // ---------- 1 + 2: static API and root paths ----------
  function route(url) {
    if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return null;
    const [path] = url.split('?');
    if (path === '/api/sessions') return api('sessions.json');
    if (path.startsWith('/api/sessions/')) {
      const file = decodeURIComponent(path.slice('/api/sessions/'.length));
      return api('sessions/' + encodeURIComponent(file) + '.json');
    }
    if (path === '/api/session') return api('session.json');
    if (path === '/api/current') return api('current.json');
    return BASE + url.slice(1);
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : null;
    const method = String(init.method || 'GET').toUpperCase();
    if (url && method !== 'GET' && url.startsWith('/api/')) {
      // Writes (car names, track/field size) only matter to the real server; accept and forget them
      if (url.startsWith('/api/cars')) return realFetch(BASE + 'cars.json').then((r) => r.json()).then((cars) => json({ cars }));
      return Promise.resolve(json({ ok: true }));
    }
    const mapped = url ? route(url) : null;
    return realFetch(mapped || input, mapped ? { ...init, method: 'GET', body: undefined } : init);
  };

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('a[href="/"]').forEach((a) => { a.href = BASE + 'index.html'; });
  });

  // The live page remembers the track per browser; a first-time visitor should land on the replayed track
  try {
    if (!localStorage.getItem('trackName')) localStorage.setItem('trackName', DEMO.track);
    if (!localStorage.getItem('fieldSize')) localStorage.setItem('fieldSize', String(DEMO.fieldSize));
  } catch (e) { /* storage blocked: the player selects the track itself */ }

  // ---------- 3: replay socket ----------
  const sockets = new Set();
  class ReplaySocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url; this.readyState = 0; this.protocol = ''; this.extensions = ''; this.binaryType = 'blob';
      sockets.add(this);
      setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); if (this.onopen) this.onopen(new Event('open')); }, 0);
    }
    send() { /* the dashboard never needs to talk back */ }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3; sockets.delete(this);
      const e = new CloseEvent('close', { code: 1000, wasClean: true });
      this.dispatchEvent(e); if (this.onclose) this.onclose(e);
    }
    _push(data) {
      if (this.readyState !== 1) return;
      const e = new MessageEvent('message', { data: JSON.stringify({ type: 'telemetry', data }) });
      this.dispatchEvent(e); if (this.onmessage) this.onmessage(e);
    }
  }
  Object.assign(ReplaySocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = ReplaySocket;

  // ---------- the player (live page only) ----------
  document.addEventListener('DOMContentLoaded', () => {
    const video = document.getElementById('demoVideo');
    if (video) startPlayer(video).catch((e) => {
      console.error('Demo replay could not start:', e);
      const s = document.getElementById('demoState'); if (s) s.textContent = 'Replay data could not be loaded';
    });
  });

  async function startPlayer(video) {
    const $ = (id) => document.getElementById(id);
    const res = await realFetch(api('sessions/' + encodeURIComponent(DEMO.session) + '.json'));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const session = await res.json();
    const pts = session.telemetryPoints.filter((p) => Number.isFinite(p.rt)).sort((a, b) => a.rt - b.rt);
    const car = session.car || {};
    const laps = session.laps || [];
    const maxRpm = Math.ceil((session.maxRPM || 8000) / 500) * 500;
    const firstRt = pts[0].rt, lastRt = pts[pts.length - 1].rt;

    const analysisUrl = 'analysis.html?session=' + encodeURIComponent(DEMO.session);
    if ($('demoAnalysis')) $('demoAnalysis').href = analysisUrl;
    if ($('demoPlayback')) $('demoPlayback').href = 'playback.html?session=' + encodeURIComponent(DEMO.session);

    const fmt = (t) => {
      if (!Number.isFinite(t)) return '--:--.-';
      const m = Math.floor(t / 60);
      return m + ':' + (t - m * 60).toFixed(1).padStart(4, '0');
    };

    // Point at or before race-clock time rt (binary search), blended with the next point for smooth 60 fps output
    function sampleAt(rt) {
      rt = Math.min(Math.max(rt, firstRt), lastRt);
      let lo = 0, hi = pts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pts[mid].rt <= rt) lo = mid; else hi = mid - 1; }
      const a = pts[lo], b = pts[lo + 1];
      const f = b && b.rt - a.rt > 0 && b.rt - a.rt < 0.5 ? (rt - a.rt) / (b.rt - a.rt) : 0;
      const mix = (k) => (Number.isFinite(a[k]) && b && Number.isFinite(b[k]) ? a[k] + (b[k] - a[k]) * f : a[k] || 0);
      const mix4 = (k) => ({ fl: (a[k] || {}).fl || 0, fr: (a[k] || {}).fr || 0, rl: (a[k] || {}).rl || 0, rr: (a[k] || {}).rr || 0 });
      return { a, f, rt, mix, mix4 };
    }

    // Rebuild the packet the server would have broadcast at that moment (telemetry_server.js parseForzaPacket shape)
    function packet(rt) {
      const { a, mix, mix4 } = sampleAt(rt);
      const done = laps.filter((l) => l.lap <= a.lap);
      const lastLap = done.length ? done[done.length - 1].time : 0;
      const bestLap = done.length ? Math.min(...done.map((l) => l.time)) : 0;
      const gLat = mix('gLat'), gLong = mix('gLong');
      const d = {
        timestamp: Date.now(), isRaceOn: true,
        engineMaxRpm: maxRpm, engineIdleRpm: 1000, rpm: mix('rpm'),
        accel: { x: gLat * 9.81, y: 0, z: gLong * 9.81 },
        velocity: { x: 0, y: 0, z: mix('speed') }, angularVelocity: { x: 0, y: 0, z: 0 },
        onRumbleStrip: mix4('kerb'), surfaceRumble: mix4('surf'),
        carOrdinal: car.ordinal || 0, carClass: car.class || 0, carPI: car.pi || 0,
        drivetrain: car.drivetrain || 0, cylinders: car.cylinders || 0,
        position: { x: mix('x'), y: 0, z: mix('z') },
        tireTemp: { fl: (a.tire || {}).fl || 0, fr: (a.tire || {}).fr || 0, rl: (a.tire || {}).rl || 0, rr: (a.tire || {}).rr || 0 },
        speed: mix('speed'), horsepower: mix('hp'), torque: mix('torque'), boost: a.boost || 0, fuel: a.fuel || 0,
        bestLap, lastLap, currentLap: mix('lapTime'), raceTime: rt,
        lap: a.lap, racePosition: a.pos || 0,
        throttle: mix('throttle'), brake: mix('brake'), clutch: 0, handbrake: 0, gear: a.gear || 0, steer: mix('steer'),
        drivingLine: mix('lineErr'), aiBrakeDiff: mix('aiBrake')
      };
      d.accelX = d.accel.x; d.accelY = d.accel.y; d.accelZ = d.accel.z;
      return d;
    }

    let lastSent = null;
    function emit(rt) {
      if (lastSent !== null && Math.abs(rt - lastSent) < 0.012) return; // ~60 packets/s, like the game
      lastSent = rt;
      const d = packet(rt);
      sockets.forEach((s) => s._push(d));
      const lapNo = d.lap + 1;
      if ($('demoClock')) $('demoClock').textContent = fmt(rt);
      if ($('demoLap')) $('demoLap').textContent = 'Lap ' + Math.min(lapNo, laps.length || lapNo) + ' of ' + (laps.length || '?') + ' · P' + d.racePosition;
    }

    // Make sure the replayed track is selected once the track list has loaded (storage may be blocked)
    const pickTrack = () => {
      const sel = $('trackSelect');
      if (!sel || sel.value) return true;
      if (![...sel.options].some((o) => o.value === DEMO.track)) return false;
      sel.value = DEMO.track; sel.dispatchEvent(new Event('change'));
      return true;
    };
    const trackTimer = setInterval(() => { if (pickTrack()) clearInterval(trackTimer); }, 200);
    setTimeout(() => clearInterval(trackTimer), 10000);

    // Clock: the video when it can play, otherwise the page clock looping over the same window
    let useVideo = true, wallStart = null;
    const windowNoVideo = DEMO.noVideoWindow;
    const noVideo = () => { useVideo = false; wallStart = null; video.closest('.demo-video').classList.add('no-video'); setState(); };
    video.addEventListener('error', noVideo);
    const setState = () => {
      if ($('demoState')) $('demoState').textContent = !useVideo ? 'Replaying (no video)' : video.paused ? 'Paused · press play' : 'Replaying at real speed';
      document.body.classList.toggle('demo-paused', useVideo && video.paused);
    };
    ['play', 'pause', 'playing', 'waiting', 'error'].forEach((e) => video.addEventListener(e, setState));

    const rtNow = () => {
      if (useVideo) return DEMO.videoStartRaceTime + video.currentTime;
      const [a, b] = windowNoVideo;
      if (wallStart === null) wallStart = performance.now();
      return a + (((performance.now() - wallStart) / 1000) % (b - a));
    };
    if (video.error || video.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) noVideo(); // failed before we were listening
    emit(rtNow()); // first frame straight away, so the dashboard isn't empty before play
    setState();
    const tick = () => {
      if (!useVideo || !video.paused || video.seeking) emit(rtNow());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    video.addEventListener('seeked', () => emit(rtNow()));

    // Autoplay (muted) can be refused; the native play button then starts everything
    const p = video.play();
    if (p && p.catch) p.catch(setState);
  }
})();
