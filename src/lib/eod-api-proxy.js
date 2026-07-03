'use strict';

function eodApiBase() {
  return (
    process.env.EOD_API_BASE_URL ||
    'https://eod-api.the-dump-bin.com'
  ).replace(/\/+$/, '');
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || '';
}

async function forwardToEodApi(req, path, body) {
  const url = `${eodApiBase()}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const ip = clientIp(req);
  if (ip) headers['X-Forwarded-For'] = ip;

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  let data = {};
  const text = await resp.text();
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      ok: false,
      error: text?.slice(0, 200) || resp.statusText || 'Unexpected response from sign-in service.',
    };
  }

  return { status: resp.status, data };
}

module.exports = { eodApiBase, forwardToEodApi, clientIp };
