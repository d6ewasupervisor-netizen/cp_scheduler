/**
 * Analyze Downloads/prod completion.har — compare request-body quality vs prior multi-part HAR.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HAR = 'C:/Users/tgaut/Downloads/prod completion.har';
const OUT_DIR = path.join(__dirname, '..', 'output', 'prod-completion-har-analysis');

function bodyText(content) {
  if (!content?.text) return '';
  if (content.encoding === 'base64') {
    try {
      return Buffer.from(content.text, 'base64').toString('utf8');
    } catch {
      return '';
    }
  }
  return String(content.text);
}

function tryJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const har = JSON.parse(fs.readFileSync(HAR, 'utf8'));
  const entries = har.log.entries || [];

  const muts = [];
  for (const e of entries) {
    const url = e.request?.url || '';
    if (!/sasretail\.com\/api\//i.test(url)) continue;
    const method = (e.request.method || '').toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) continue;
    if (/\/api\/v2\/rum|event_logging/i.test(url)) continue;

    const apiPath = url.replace(/^https?:\/\/[^/]+/, '');
    const reqText = e.request.postData?.text ?? null;
    const resText = bodyText(e.response?.content);
    muts.push({
      t: e.startedDateTime,
      method,
      status: e.response?.status,
      path: apiPath,
      reqMime: e.request.postData?.mimeType || null,
      req: tryJson(reqText),
      reqRaw: reqText,
      res: tryJson(resText),
      hasReqText: reqText != null && String(reqText).length > 0,
    });
  }

  // Also grab important GETs for context
  const gets = [];
  for (const e of entries) {
    const url = e.request?.url || '';
    if (!/sasretail\.com\/api\//i.test(url)) continue;
    const method = (e.request.method || '').toUpperCase();
    if (method !== 'GET') continue;
    const apiPath = url.replace(/^https?:\/\/[^/]+/, '');
    if (
      !/shift-complete|\/shifts\/|to_store|to_home|travel|category-resets|time-change|spent-time|visits\/\d+\/?$/i.test(
        apiPath
      )
    ) {
      continue;
    }
    const resText = bodyText(e.response?.content);
    gets.push({
      t: e.startedDateTime,
      method: 'GET',
      status: e.response?.status,
      path: apiPath,
      res: tryJson(resText),
    });
  }

  fs.writeFileSync(path.join(OUT_DIR, 'mutations.json'), JSON.stringify(muts, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'key-gets.json'), JSON.stringify(gets, null, 2));

  const lines = [];
  lines.push('# prod completion.har analysis');
  lines.push('');
  lines.push(`Entries: ${entries.length} · API mutations: ${muts.length} · with postData.text: ${muts.filter((m) => m.hasReqText).length}`);
  lines.push('');
  lines.push('## Quality vs prior multi-part HAR');
  lines.push('');
  lines.push('| | Prior parts HAR | This file |');
  lines.push('|--|-----------------|-----------|');
  lines.push('| Size | ~309 MB (3 parts) | ~17 MB |');
  lines.push('| JSON postData.text | **Missing** (empty params) | **Present** |');
  lines.push(`| API writes captured | many | ${muts.length} |`);
  lines.push('');

  lines.push('## Mutation timeline (request + response)');
  lines.push('');
  for (const m of muts) {
    lines.push(`### ${m.t} · ${m.method} ${m.status}`);
    lines.push(`\`${m.path}\``);
    lines.push('- **request:**');
    lines.push('```json');
    lines.push(JSON.stringify(m.req, null, 2).slice(0, 5000));
    lines.push('```');
    if (m.res != null) {
      const rs = JSON.stringify(m.res, null, 2);
      lines.push('- **response:**');
      lines.push('```json');
      lines.push(rs.slice(0, 3000));
      lines.push('```');
    }
    lines.push('');
  }

  // Focus shifts / travel / complete
  const focus = muts.filter((m) =>
    /shifts\/|to_store|to_home|shift-complete|category-resets|visits\/\d+\/?$|travel/i.test(m.path)
  );
  lines.push('## Focus: field-app spine');
  lines.push('');
  for (const m of focus) {
    lines.push(`- \`${m.t}\` **${m.method} ${m.status}** \`${m.path}\``);
    lines.push(`  - req: \`${JSON.stringify(m.req)}\``.slice(0, 500));
  }

  fs.writeFileSync(path.join(OUT_DIR, 'REPORT.md'), lines.join('\n'));

  console.log(
    JSON.stringify(
      {
        out: OUT_DIR,
        entries: entries.length,
        muts: muts.length,
        withText: muts.filter((m) => m.hasReqText).length,
        focus: focus.map((m) => ({
          t: m.t,
          m: m.method,
          s: m.status,
          p: m.path,
          req: m.req,
        })),
      },
      null,
      2
    )
  );

  for (const m of focus) {
    console.log('\n====', m.t, m.method, m.status, m.path);
    console.log('REQ', JSON.stringify(m.req, null, 2));
    const r = JSON.stringify(m.res, null, 2);
    console.log('RES', r && r.length > 2000 ? r.slice(0, 2000) + '…' : r);
  }
}

main();
