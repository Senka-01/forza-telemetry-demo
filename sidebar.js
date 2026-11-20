'use strict';

(() => {
  const key = 'forza:sidebar-expanded';
  const sidebar = document.createElement('aside');
  sidebar.className = 'app-sidebar';
  sidebar.innerHTML = `
    <div class="sidebar-head">
      <span class="sidebar-brand" aria-hidden="true">F7<span>TELEMETRY</span></span>
      <button class="sidebar-toggle" type="button" aria-controls="page-navigation" aria-expanded="false" aria-label="Expand navigation" title="Expand navigation">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
      </button>
    </div>
    <nav id="page-navigation" class="sidebar-nav" aria-label="Pages">
      <a href="/" data-page="live" aria-label="Live Telemetry" title="Live Telemetry">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.6 18a9 9 0 1 1 14.8 0M12 5v2M5.5 10l1.8.7M18.5 10l-1.8.7M12 15l4-4"/><circle cx="12" cy="15" r="1.5"/></svg>
        <span>Live Telemetry</span>
      </a>
      <a href="stats.html" data-page="stats" aria-label="Race Stats" title="Race Stats">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4v16h16M7 15l4-4 3 2 5-6"/><circle cx="7" cy="15" r=".7"/><circle cx="11" cy="11" r=".7"/><circle cx="14" cy="13" r=".7"/><circle cx="19" cy="7" r=".7"/></svg>
        <span>Race Stats</span>
      </a>
      <a id="replayLink" href="playback.html" data-page="playback" aria-label="Race Playback" title="Race Playback">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/></svg>
        <span>Race Playback</span>
      </a>
      <a id="analysisLink" href="analysis.html" data-page="analysis" aria-label="Track Analysis" title="Track Analysis">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8c0-2 2-3 4-3h5c1.7 0 2.7.7 2.7 2s-1 2-2.7 2h-2c-1.3 0-2 .7-2 1.8s.7 1.7 2 1.7h5c2 0 3 1 3 2.8S18.8 19 17 19H8c-2.5 0-4-1.2-4-3s1-2.8 2.4-3.5S8 11 7 10.2 5 9.2 5 8Z"/></svg>
        <span>Track Analysis</span>
      </a>
    </nav>`;
  document.body.prepend(sidebar);
  const toggle = sidebar.querySelector('.sidebar-toggle');
  const page = location.pathname.split('/').pop();
  const active = page === 'stats.html' ? 'stats' : page === 'playback.html' ? 'playback'
    : page === 'analysis.html' ? 'analysis' : 'live';
  sidebar.querySelector(`[data-page="${active}"]`).setAttribute('aria-current', 'page');

  function setExpanded(expanded) {
    document.body.classList.toggle('sidebar-expanded', expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    const label = expanded ? 'Collapse navigation' : 'Expand navigation';
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  }
  try { setExpanded(localStorage.getItem(key) === 'true'); }
  catch (error) { console.warn('Could not read navigation preference:', error); setExpanded(false); }
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') !== 'true';
    setExpanded(expanded);
    try { localStorage.setItem(key, String(expanded)); }
    catch (error) { console.warn('Could not save navigation preference:', error); }
  });
})();
