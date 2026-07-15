(function () {
  'use strict';

  var SESSION_KEY = 'dumpBinSession';
  var LEGACY_KEY = 'eodSession';
  var SIGNIN_PATH = '/signin.html';
  var PUBLIC_PATHS = [SIGNIN_PATH];

  var EOD_API_BASE = (function () {
    var hashApi = (location.hash.match(/eod=([^&]+)/) || [])[1];
    if (hashApi) return decodeURIComponent(hashApi).replace(/\/+$/, '');
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      return 'http://localhost:3001';
    }
    return 'https://eod-api.the-dump-bin.com';
  })();

  /**
   * Accept a Dump Bin / eod-api session JWT handed off from the host hub.
   * localStorage is per-origin, so the-dump-bin.com cannot share the key
   * directly; the hub redirects here with #dbSession=<jwt> (or ?session=).
   * JWT_SECRET is shared with eod-api, so the same token validates.
   */
  function acceptHostSessionHandoff() {
    try {
      var qp = new URLSearchParams(location.search);
      var fromQuery = qp.get('session') || qp.get('dbSession') || '';
      var hash = (location.hash || '').replace(/^#/, '');
      var hashParams = new URLSearchParams(hash.indexOf('=') >= 0 ? hash : '');
      var fromHash =
        hashParams.get('dbSession') ||
        hashParams.get('session') ||
        '';
      // Also support raw #dbSession=token without nested params edge cases
      var rawHashMatch = (location.hash || '').match(/(?:^#|&)dbSession=([^&]+)/i);
      if (!fromHash && rawHashMatch) fromHash = decodeURIComponent(rawHashMatch[1]);

      var handed = fromQuery || fromHash;
      if (!handed) return false;

      setSession(handed);

      // Strip token from URL so it is not left in history / referrers.
      qp.delete('session');
      qp.delete('dbSession');
      var clean =
        location.pathname +
        (qp.toString() ? '?' + qp.toString() : '') +
        (fromHash ? '' : location.hash && !/dbSession|session=/i.test(location.hash) ? location.hash : '');
      try {
        history.replaceState({}, '', clean);
      } catch (_) {}
      return true;
    } catch (_) {
      return false;
    }
  }

  function getSession() {
    try {
      var v = localStorage.getItem(SESSION_KEY);
      if (v) return v;
      var legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        localStorage.setItem(SESSION_KEY, legacy);
        localStorage.removeItem(LEGACY_KEY);
        return legacy;
      }
    } catch (_) {}
    return '';
  }

  function setSession(v) {
    try {
      localStorage.setItem(SESSION_KEY, v);
    } catch (_) {}
  }

  function clearSession() {
    try {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(LEGACY_KEY);
    } catch (_) {}
  }

  function isPublicPath() {
    var p = (location.pathname || '/').toLowerCase();
    for (var i = 0; i < PUBLIC_PATHS.length; i++) {
      if (p === PUBLIC_PATHS[i].toLowerCase()) return true;
    }
    return false;
  }

  function bounceToSignIn(reason) {
    clearSession();
    if (isPublicPath()) return;
    try {
      console.warn('[cp-auth] redirect to signin:', reason || '');
    } catch (_) {}
    var next = encodeURIComponent(location.pathname + location.search + location.hash);
    location.replace(SIGNIN_PATH + '?next=' + next);
  }

  var _hideStyle = null;
  function hidePage() {
    if (_hideStyle) return;
    _hideStyle = document.createElement('style');
    _hideStyle.textContent = 'html, body { visibility: hidden !important; }';
    (document.head || document.documentElement).appendChild(_hideStyle);
  }
  function revealPage() {
    if (_hideStyle && _hideStyle.parentNode) _hideStyle.parentNode.removeChild(_hideStyle);
    _hideStyle = null;
  }

  async function exchangeLinkToken() {
    var qp = new URLSearchParams(location.search);
    var linkToken = qp.get('token');
    if (!linkToken) return !!getSession();

    hidePage();
    try {
      var verifyUrl =
        (location.origin || '').replace(/\/+$/, '') +
        '/api/auth/verify-token?token=' +
        encodeURIComponent(linkToken);
      var res = await fetch(verifyUrl);
      var data = await res.json().catch(function () {
        return {};
      });
      qp.delete('token');
      var newUrl = location.pathname + (qp.toString() ? '?' + qp.toString() : '') + location.hash;
      try {
        history.replaceState({}, '', newUrl);
      } catch (_) {}

      if (!res.ok || !data.ok || !data.token) {
        try {
          sessionStorage.setItem(
            'cpSignInError',
            (data && data.error) || 'This sign-in link is invalid or has been used.'
          );
        } catch (_) {}
        return !!getSession();
      }
      setSession(data.token);
      return true;
    } catch (err) {
      return !!getSession();
    }
  }

  async function cpAuthFetch(url, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    var tok = getSession();
    if (tok) headers.Authorization = 'Bearer ' + tok;

    var passThru = Object.assign({}, opts);
    delete passThru.noBounceOn401;
    passThru.headers = headers;

    var res = await fetch(url, passThru);
    if (res.status === 401 && !opts.noBounceOn401) {
      bounceToSignIn('401 from ' + url);
    }
    return res;
  }

  function signOut() {
    clearSession();
    location.assign(SIGNIN_PATH);
  }

  var bootPromise = (async function boot() {
    if (isPublicPath()) {
      // Sign-in page: still accept host handoff so a hub deep-link can skip re-entry.
      acceptHostSessionHandoff();
      revealPage();
      return;
    }

    acceptHostSessionHandoff();

    var qp = new URLSearchParams(location.search);
    var hasToken = !!qp.get('token');
    var hadSession = !!getSession();

    if (!hadSession && !hasToken) {
      hidePage();
      bounceToSignIn('no session');
      return;
    }

    if (hasToken) {
      hidePage();
      var ok = await exchangeLinkToken();
      if (!ok) {
        bounceToSignIn('verify-token failed');
        return;
      }
    }
    revealPage();

    var path = (location.pathname || '/').toLowerCase();
    // Reps landing on Planning Desk → their rep week view.
    // Admins on /rep.html without ?preview stay on Planning Desk (not locked to one rep).
    // Shift Day (/shiftday.html) is available to both layers.
    if (path === '/' || path === '/index.html') {
      try {
        var meRes = await cpAuthFetch('/api/auth/me', { noBounceOn401: true });
        if (meRes.ok) {
          var me = await meRes.json();
          if (me.layer === 'rep') {
            location.replace('/shiftday.html' + location.search);
            return;
          }
        }
      } catch (_) {}
    }
    if (path === '/rep.html') {
      try {
        var meRes2 = await cpAuthFetch('/api/auth/me', { noBounceOn401: true });
        if (meRes2.ok) {
          var me2 = await meRes2.json();
          if (me2.layer === 'admin' && !new URLSearchParams(location.search).has('preview')) {
            location.replace('/');
            return;
          }
        }
      } catch (_) {}
    }
  })();

  window.cpAuth = {
    EOD_API_BASE: EOD_API_BASE,
    getSession: getSession,
    signOut: signOut,
    fetch: cpAuthFetch,
    bootPromise: bootPromise,
  };
  window.cpAuthFetch = cpAuthFetch;
  window.cpSignOut = signOut;
})();
