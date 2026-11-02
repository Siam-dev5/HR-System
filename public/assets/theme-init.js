// Applies the saved theme before first paint (no flash). Mirrors src/web/theme.ts.
(function () {
  var pref = 'auto';
  try {
    var v = localStorage.getItem('hr.theme');
    if (v === 'light' || v === 'dark') pref = v;
  } catch {
    /* storage blocked: follow the system */
  }
  var dark = pref === 'dark' || (pref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme-pref', pref);
})();
