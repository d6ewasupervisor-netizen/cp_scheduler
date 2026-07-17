/**
 * Mobile bottom nav + theme toggle mount for field pages.
 */

import { initTheme, mountThemeToggle } from '/ux/theme.js';
import { initNavGuard } from '/ux/nav-guard.js';

const PAGES = {
  dashboard: { href: '/dashboard.html', label: 'Schedule', match: (p) => p.endsWith('/dashboard.html') || p === '/' },
  shiftday: { href: '/shiftday.html', label: 'Shift Day', match: (p) => p.includes('shiftday') },
  rep: { href: '/rep.html', label: 'My Week', match: (p) => p.includes('rep.html') },
  planning: { href: '/', label: 'Planning', match: (p) => p === '/' || p.endsWith('/index.html') },
};

/**
 * @param {{ isAdmin?: boolean, active?: 'dashboard'|'shiftday'|'rep'|'planning', hideWhenVisit?: boolean }} opts
 */
export function mountBottomNav(opts = {}) {
  const path = location.pathname || '';
  const active =
    opts.active ||
    (PAGES.shiftday.match(path)
      ? 'shiftday'
      : PAGES.rep.match(path)
        ? 'rep'
        : PAGES.planning.match(path) && !path.includes('dashboard')
          ? 'planning'
          : 'dashboard');

  const items = [
    { key: 'dashboard', ...PAGES.dashboard },
    { key: 'shiftday', ...PAGES.shiftday },
    { key: 'rep', ...PAGES.rep },
  ];
  if (opts.isAdmin) items.push({ key: 'planning', ...PAGES.planning });

  let nav = document.getElementById('cpBottomNav');
  if (!nav) {
    nav = document.createElement('nav');
    nav.id = 'cpBottomNav';
    nav.className = 'cp-bottom-nav';
    nav.setAttribute('aria-label', 'Main');
    document.body.appendChild(nav);
  }
  nav.innerHTML = items
    .map(
      (it) =>
        `<a href="${it.href}" class="cp-bottom-nav-item${it.key === active ? ' active' : ''}" data-nav="${it.key}">
          <span class="cp-bottom-nav-label">${it.label}</span>
        </a>`
    )
    .join('');

  document.body.classList.add('has-bottom-nav');
  if (opts.hideWhenVisit) {
    // visit workspace toggles body.visit-workspace-open which CSS uses to hide nav
  }
  return nav;
}

/**
 * Add theme toggle into #userBar or topbar user-bar.
 */
export function mountChromeThemeToggle() {
  const bar = document.querySelector('.user-bar') || document.getElementById('userBar');
  if (!bar) return null;
  if (bar.querySelector('[data-theme-toggle]')) return bar.querySelector('[data-theme-toggle]');
  return mountThemeToggle(bar);
}

/**
 * Standard field-page boot: theme + optional bottom nav.
 * @param {{ isAdmin?: boolean, active?: string, bottomNav?: boolean }} opts
 */
export function initAppShell(opts = {}) {
  initTheme();
  mountChromeThemeToggle();
  if (opts.bottomNav !== false) {
    mountBottomNav({
      isAdmin: !!opts.isAdmin,
      active: opts.active,
      hideWhenVisit: true,
    });
  }
  initNavGuard(opts.navGuard || {});
}

export { initTheme, mountThemeToggle };
