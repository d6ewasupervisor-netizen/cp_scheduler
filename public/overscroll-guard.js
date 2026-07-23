/**
 * Block browser pull-to-refresh / overscroll bounce that nukes in-progress
 * Schedule, Shift Day, Planning Desk, and visit-flow work on phones.
 *
 * CSS overscroll-behavior covers modern browsers; touch listeners cover
 * Chrome Android when the document is already at scrollTop 0.
 */
(function () {
  'use strict';

  if (window.__cpOverscrollGuard) return;
  window.__cpOverscrollGuard = true;

  document.documentElement.classList.add('cp-no-overscroll');

  let startY = 0;
  let tracking = false;

  function scrollTop() {
    return (
      window.scrollY
      || document.documentElement.scrollTop
      || document.body.scrollTop
      || 0
    );
  }

  /** True when the touch target (or a parent) can still scroll up. */
  function canScrollUp(target) {
    let node = target;
    while (node && node !== document.body && node !== document.documentElement) {
      if (node instanceof HTMLElement) {
        const style = window.getComputedStyle(node);
        const oy = style.overflowY;
        if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && node.scrollTop > 0) {
          return true;
        }
      }
      node = node.parentElement;
    }
    return scrollTop() > 0;
  }

  function onTouchStart(e) {
    if (e.touches.length !== 1) {
      tracking = false;
      return;
    }
    tracking = true;
    startY = e.touches[0].clientY;
  }

  function onTouchMove(e) {
    if (!tracking || e.touches.length !== 1) return;
    const dy = e.touches[0].clientY - startY;
    // Finger dragged down while nothing above can scroll → browser PTR.
    if (dy > 8 && !canScrollUp(e.target)) {
      e.preventDefault();
    }
  }

  function onTouchEnd() {
    tracking = false;
  }

  document.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
  document.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
  document.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
  document.addEventListener('touchcancel', onTouchEnd, { passive: true, capture: true });
})();
