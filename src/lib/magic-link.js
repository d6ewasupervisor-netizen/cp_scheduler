'use strict';

function hubBase() {
  return (process.env.FRONTEND_BASE_URL || 'https://the-dump-bin.com').replace(/\/+$/, '');
}

function allowedReturnHosts() {
  const hosts = new Set();
  for (const entry of (process.env.MAGIC_LINK_RETURN_HOSTS || '').split(',')) {
    const h = entry.trim().toLowerCase();
    if (h) hosts.add(h);
  }
  for (const entry of (process.env.CP_SCHEDULER_PUBLIC_URL || '').split(',')) {
    const raw = entry.trim();
    if (!raw) continue;
    try {
      hosts.add(new URL(raw).host.toLowerCase());
    } catch {
      hosts.add(raw.toLowerCase());
    }
  }
  hosts.add('cpscheduler-production.up.railway.app');
  hosts.add('localhost');
  hosts.add('127.0.0.1');
  return hosts;
}

function isAllowedDestinationUrl(url) {
  const host = url.host.toLowerCase();
  if (allowedReturnHosts().has(host)) {
    return url.protocol === 'https:' || url.protocol === 'http:';
  }
  return false;
}

function buildDestinationUrl(token, returnTo) {
  if (returnTo) {
    try {
      const url = new URL(returnTo);
      if (!isAllowedDestinationUrl(url)) return null;
      url.searchParams.set('token', token);
      return url.toString();
    } catch {
      return null;
    }
  }
  const base = (process.env.CP_SCHEDULER_PUBLIC_URL || 'http://localhost:3847').replace(/\/+$/, '');
  return `${base}/rep.html?token=${encodeURIComponent(token)}`;
}

function wrapForExternalBrowser(destinationUrl) {
  const openUrl = new URL('/open-sign-in.html', `${hubBase()}/`);
  openUrl.searchParams.set('to', destinationUrl);
  return openUrl.toString();
}

function buildMagicLink(token, returnTo) {
  const destination = buildDestinationUrl(token, returnTo);
  if (!destination) return null;
  return wrapForExternalBrowser(destination);
}

module.exports = { buildMagicLink, buildDestinationUrl, isAllowedDestinationUrl };
