FORZA TELEMETRY - PORTFOLIO DEMO
================================

A static copy of the app (live dashboard, stats, analysis, playback) that runs with no game and no server.
The live page replays laguna-seca-2026-11-20T08-22-09 in sync with the screen recording; the other pages
show the same session from static JSON. Nothing in this folder touches the working app in public/.

WHAT TO UPLOAD
Upload the whole demo folder (about 12 MB, 8 MB of it is the video) to any static host, for example
yoursite.com/projects/forza/. It works from any sub-folder. Needs no build step and no server code.
  index.html, stats.html, analysis.html, playback.html   the app pages (one extra <script> line each)
  replay/   demo.js (static API + replay player), replay.css (video panel), race.mp4 (720p), poster.jpg
  api/      sessions.json, sessions/<file>.parquet.json, session.json, current.json  (what /api/* returned)
  maps/, tracks.json, cars.json, *.js, *.css             copied from public/
Keep maps/reference/CREDITS.txt and LICENSE-racetrack-database.txt (the reference-track licence needs them).
The host must allow byte-range requests for the video so scrubbing works (GitHub Pages, Netlify, Vercel,
Cloudflare Pages and normal web hosts all do). Chart.js still loads from cdn.jsdelivr.net, as in the app.

EMBED SNIPPET (change the src to where you uploaded it)
<iframe src="/projects/forza/index.html"
        title="Forza Motorsport 7 telemetry dashboard - live demo"
        style="width:100%; height:860px; border:0; border-radius:12px;"
        loading="lazy" allow="autoplay; fullscreen"></iframe>
<p><a href="/projects/forza/index.html" target="_blank" rel="noopener">Open the demo full screen</a></p>

Or just link to index.html; the dashboard is easier to explore full screen than in a frame.

HOW THE SYNC WORKS
The video is the clock: race time = 167.936 s + video time. 167.936 s (2:47.936) is the HUD "Race time"
on the first frame, and the recorded speed and gear match the HUD speedometer across the clip.
Pause, scrub or loop the video and the dashboard follows. If the video can't load, the same window is
replayed from the page clock instead.

CHANGING THE CLIP
Replace replay/race.mp4 and set videoStartRaceTime at the top of replay/demo.js to the HUD race time
on the new video's first frame (in seconds). To show another session, also change "session" there and
put that session's JSON (what /api/sessions/<file> returns from the real server) in api/sessions/.

DEMO-ONLY DIFFERENCES
- tracks.json: Laguna Seca outline path fixed from maps/laguna_seca.json to maps/laguna-seca.json
  (the file on disk has a hyphen, so the real app can't load that outline either).
- Saving car names, track or field size is accepted and forgotten (no server).
