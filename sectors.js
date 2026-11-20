'use strict';

const SectorAnalysis = (() => {
  const SECTOR_METERS = 1000;
  const MAX_GAP_MS = 1000;
  // Sample times are when the server received the packet, so allow a little jitter when locating the line crossing.
  const CROSSING_TOLERANCE_MS = 50;

  function distance(speedA, speedB, milliseconds) {
    return (speedA + speedB) / 2 * milliseconds / 1000;
  }

  function calculate(points) {
    const runs = [];
    let active = null;

    function invalidate(run, time, reason) {
      if (run && run.invalidAt === null) {
        run.invalidAt = time;
        run.invalidReason = reason;
      }
    }

    function integrate(start, end, speedA, speedB) {
      if (!active || active.invalidAt !== null || end <= start) return;
      let segmentStart = start, currentSpeed = speedA;
      while (segmentStart < end) {
        const remaining = SECTOR_METERS - active.distance;
        const length = distance(currentSpeed, speedB, end - segmentStart);
        if (length < remaining - 1e-8) {
          active.distance += length;
          break;
        }
        let low = 0, high = 1;
        for (let i = 0; i < 40; i++) {
          const fraction = (low + high) / 2;
          const speed = currentSpeed + (speedB - currentSpeed) * fraction;
          if (distance(currentSpeed, speed, (end - segmentStart) * fraction) < remaining) low = fraction;
          else high = fraction;
        }
        const fraction = (low + high) / 2;
        const crossing = segmentStart + (end - segmentStart) * fraction;
        active.sectors.push({
          number: active.sectors.length + 1,
          start: active.sectorStart, end: crossing,
          seconds: (crossing - active.sectorStart) / 1000,
          meters: SECTOR_METERS, partial: false
        });
        active.distance = 0;
        active.sectorStart = crossing;
        currentSpeed += (speedB - currentSpeed) * fraction;
        segmentStart = crossing;
      }
    }

    // Ends the active run at the start/finish line between samples a and b and starts lap b.lap + 1 there.
    // The next sample's lap timer locates the crossing.
    function crossLine(a, b, dt) {
      let crossing = b.t - b.lapTime * 1000;
      if (crossing < a.t - CROSSING_TOLERANCE_MS || crossing > b.t) {
        invalidate(active, b.t, 'Start/finish crossing could not be located');
        active = null;
        return;
      }
      crossing = Math.max(a.t, crossing);
      const crossingSpeed = a.speed + (b.speed - a.speed) * (crossing - a.t) / dt;
      integrate(a.t, crossing, a.speed, crossingSpeed);
      if (active && active.invalidAt === null) {
        if (active.distance > 1e-6) {
          active.sectors.push({
            number: active.sectors.length + 1,
            start: active.sectorStart, end: crossing,
            seconds: (crossing - active.sectorStart) / 1000,
            meters: active.distance, partial: true
          });
        }
        active.endedAt = crossing;
      }
      active = {
        lap: b.lap + 1, startedAt: crossing, endedAt: null, invalidAt: null,
        invalidReason: null, sectorStart: crossing, distance: 0, sectors: []
      };
      runs.push(active);
      integrate(crossing, b.t, crossingSpeed, b.speed);
    }

    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], dt = b.t - a.t;
      const valid = dt > 0 && dt <= MAX_GAP_MS &&
        Number.isFinite(a.lap) && Number.isFinite(b.lap) &&
        Number.isFinite(a.lapTime) && Number.isFinite(b.lapTime) &&
        Number.isFinite(a.speed) && Number.isFinite(b.speed) && a.speed >= 0 && b.speed >= 0;

      if (b.lap < a.lap) {
        runs.forEach((run) => {
          if (run.lap >= b.lap + 1) invalidate(run, b.t, 'Lap counter moved backwards');
        });
        active = null;
        continue;
      }
      if (!valid) {
        invalidate(active, b.t, 'Missing or invalid telemetry');
        active = null;
        continue;
      }
      if (b.lap === a.lap) {
        // FM7 keeps the lap counter at 0 for the whole first lap: from a standing start the timer runs from the
        // green light, then resets to 0 as the car crosses the start/finish line without the counter moving.
        // That reset is the start of lap 1, not a timer fault.
        if (b.lap === 0 && b.lapTime < a.lapTime && b.lapTime * 1000 <= dt + CROSSING_TOLERANCE_MS) {
          invalidate(active, b.t, 'Lap 1 restarted');   // only after a rewind; lap 1 normally has no run yet
          active = null;
          crossLine(a, b, dt);
          continue;
        }
        if (Math.abs(b.lapTime - a.lapTime - dt / 1000) > 0.5) {
          invalidate(active, b.t, 'Lap timer jumped');
          active = null;
        } else {
          integrate(a.t, b.t, a.speed, b.speed);
        }
        continue;
      }
      if (b.lap !== a.lap + 1) {
        invalidate(active, b.t, 'Lap counter skipped');
        active = null;
        continue;
      }

      crossLine(a, b, dt);
    }
    return runs;
  }

  return { calculate, SECTOR_METERS, MAX_GAP_MS };
})();

if (typeof module !== 'undefined') module.exports = SectorAnalysis;
