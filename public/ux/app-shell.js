/**
 * App chrome: bottom nav (consistent on every authenticated page) + theme toggle.
 */

import { initTheme, mountThemeToggle } from '/ux/theme.js';
import { initNavGuard } from '/ux/nav-guard.js';

/**
 * Canonical bottom tabs — same order and labels on every screen.
 * Planning is admin-only (week builder / PROD tools), not the field path.
 */
const TABS = [
  {
    key: 'dashboard',
    href: '/dashboard.html',
    label: 'Schedule',
    title: 'Team schedule board',
    match: (p) => p.includes('dashboard.html'),
  },
  {
    key: 'shiftday',
    href: '/shiftday.html',
    label: 'Shift Day',
    title: 'Field week & start visits',
    match: (p) => p.includes('shiftday.html'),
  },
  {
    key: 'rep',
    href: '/rep.html',
    label: 'My Week',
    title: 'Your planning calendar',
    match: (p) => p.includes('rep.html'),
  },
  {
    key: 'planning',
    href: '/',
    label: 'Plan',
    title: 'Admin Planning Desk — build & sync weeks',
    adminOnly: true,
    match: (p) => p === '/' || p.endsWith('/index.html') || p === '',
  },
];

function detectActive(path) {
  // Prefer specific pages before Plan (/)
  for (const t of TABS) {
    if (t.key === 'planning') continue;
    if (t.match(path)) return t.key;
  }
  if (TABS.find((t) => t.key === 'planning').match(path)) return 'planning';
  return 'dashboard';
}

/**
 * @param {{ isAdmin?: boolean, active?: string }} opts
 */
export function mountBottomNav(opts = {}) {
  const path = location.pathname || '';
  const active = opts.active || detectActive(path);
  const isAdmin = !!opts.isAdmin;

  const items = TABS.filter((t) => !t.adminOnly || isAdmin);

  let nav = document.getElementById('cpBottomNav');
  if (!nav) {
    nav = document.createElement('nav');
    nav.id = 'cpBottomNav';
    nav.className = 'cp-bottom-nav';
    nav.setAttribute('aria-label', 'Main navigation');
    document.body.appendChild(nav);
  }

  nav.innerHTML = items
    .map(
      (it) =>
        `<a href="${it.href}" class="cp-bottom-nav-item${it.key === active ? ' active' : ''}" data-nav="${it.key}" title="${it.title || it.label}">
          <span class="cp-bottom-nav-label">${it.label}</span>
        </a>`
    )
    .join('');

  document.body.classList.add('has-bottom-nav');
  // Visit workspace sets body.visit-workspace-open → CSS hides this nav
  return nav;
}

export function mountChromeThemeToggle() {
  const bar = document.querySelector('.user-bar') || document.getElementById('userBar');
  if (!bar) return null;
  if (bar.querySelector('[data-theme-toggle]')) return bar.querySelector('[data-theme-toggle]');
  return mountThemeToggle(bar);
}

/**
 * @param {{
 *   isAdmin?: boolean,
 *   active?: string,
 *   bottomNav?: boolean,
 *   navGuard?: object,
 *   preload?: { repKey?: string, weekStart?: string|null, api?: Function }|false,
 * }} opts
 */
export function initAppShell(opts = {}) {
  initTheme();
  mountChromeThemeToggle();
  if (opts.bottomNav !== false) {
    mountBottomNav({
      isAdmin: !!opts.isAdmin,
      active: opts.active,
    });
  }
  initNavGuard(opts.navGuard || {});

  // Fire-and-forget: warm IndexedDB + register shell SW so the next tab is instant.
  if (opts.preload !== false) {
    import('/ux/schedule-cache.js')
      .then((m) => {
        m.registerAppServiceWorker();
        const repKey = opts.preload?.repKey;
        const api = opts.preload?.api;
        if (repKey && api) {
          return m.preloadFieldData({
            api,
            repKey,
            weekStart: opts.preload?.weekStart || null,
          });
        }
        return null;
      })
      .catch(() => {});
  }
}

export { initTheme, mountThemeToggle, TABS, detectActive };
