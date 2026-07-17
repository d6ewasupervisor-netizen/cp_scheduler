/**
 * Light / dark / system theme for Central Pet.
 * Persists localStorage.cp_theme; applies data-theme on <html>.
 */

const KEY = 'cp_theme';
const META_DARK = '#0b0f16';
const META_LIGHT = '#f4f7fb';

/** @returns {'dark'|'light'|'system'} */
export function getThemePref() {
  const v = (localStorage.getItem(KEY) || 'dark').toLowerCase();
  if (v === 'light' || v === 'system') return v;
  return 'dark';
}

export function systemPrefersDark() {
  return !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Resolved effective theme. */
export function resolveTheme(pref = getThemePref()) {
  if (pref === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return pref === 'light' ? 'light' : 'dark';
}

export function applyTheme(pref = getThemePref()) {
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePref = pref;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'light' ? META_LIGHT : META_DARK);
  else {
    const m = document.createElement('meta');
    m.name = 'theme-color';
    m.content = resolved === 'light' ? META_LIGHT : META_DARK;
    document.head.appendChild(m);
  }
  return resolved;
}

export function setThemePref(pref) {
  const next = pref === 'light' || pref === 'system' ? pref : 'dark';
  localStorage.setItem(KEY, next);
  applyTheme(next);
  document.querySelectorAll('[data-theme-toggle]').forEach(syncToggleLabel);
  return next;
}

/** Cycle dark → light → system → dark */
export function cycleTheme() {
  const order = ['dark', 'light', 'system'];
  const cur = getThemePref();
  const i = order.indexOf(cur);
  return setThemePref(order[(i + 1) % order.length]);
}

function syncToggleLabel(btn) {
  const pref = getThemePref();
  const resolved = resolveTheme(pref);
  const labels = {
    dark: 'Night',
    light: 'Light',
    system: 'Auto',
  };
  btn.textContent = labels[pref] || 'Theme';
  btn.title = `Theme: ${labels[pref]} (showing ${resolved}). Tap to change.`;
  btn.setAttribute('aria-label', `Color theme: ${labels[pref]}. Tap to change.`);
  btn.dataset.themeResolved = resolved;
}

/**
 * Mount a theme toggle button into a container (or return a free button).
 * @param {HTMLElement} [container]
 */
export function mountThemeToggle(container) {
  applyTheme();
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'subtle theme-toggle';
  btn.dataset.themeToggle = '1';
  syncToggleLabel(btn);
  btn.addEventListener('click', () => {
    cycleTheme();
  });
  if (container) container.appendChild(btn);
  return btn;
}

/** Call once on boot for every page. */
export function initTheme() {
  applyTheme();
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (getThemePref() === 'system') applyTheme('system');
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
}

if (typeof window !== 'undefined') {
  window.cpInitTheme = initTheme;
  window.cpCycleTheme = cycleTheme;
}
