/**
 * Analyze multi-part SAS HAR for James FM53 full-shift recording.
 * Emits a timeline of API calls + extracts exception/time/pin/photo patterns.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PARTS = [
  'C:/Users/tgaut/Downloads/sas-har-20260715-180316-part1.json',
  'C:/Users/tgaut/Downloads/sas-har-20260715-180316-part2.json',
  'C:/Users/tgaut/Downloads/sas-har-20260715-180316-part3.json',
];
const OUT_DIR = path.join(__dirname, '..', 'output', 'james-fm53-har-analysis');

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function getHeader(headers, name) {
  if (!Array.isArray(headers)) return null;
  const h = headers.find((x) => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

function parseUrl(url) {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname, search: u.search, href: url };
  } catch {
    return { host: '', path: url, search: '', href: url };
  }
}

function bodyText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (content.text != null) {
    if (content.encoding === 'base64') {
      try {
        return Buffer.from(content.text, 'base64').toString('utf8');
      } catch {
        return '[base64 decode failed]';
      }
    }
    return String(content.text);
  }
  return '';
}

function postDataText(postData) {
  if (!postData) return '';
  if (postData.text != null) return String(postData.text);
  if (Array.isArray(postData.params)) {
    return postData.params.map((p) => `${p.name}=${p.value}`).join('&');
  }
  return '';
}

function tryJson(s) {
  if (!s || !s.trim()) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function summarizeBody(s, max = 400) {
  if (!s) return '';
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return one.slice(0, max) + '…';
}

function isApiInteresting(host, pathName, method) {
  if (!host) return false;
  // Keep SAS retail API + field app APIs
  if (/sasretail\.com/i.test(host)) return true;
  if (/amazonaws\.com|cloudfront\.net|s3\./i.test(host) && /photo|image|upload|presign|category/i.test(pathName)) {
    return true;
  }
  return false;
}

function pathBucket(pathName) {
  // normalize ids
  return pathName
    .replace(/\/\d{5,}\//g, '/{id}/')
    .replace(/\/\d{5,}$/g, '/{id}')
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{20,}/gi, '/{uuid}');
}

function classify(pathName, method, postPreview, status) {
  const p = pathName.toLowerCase();
  const body = (postPreview || '').toLowerCase();
  if (/exception|reason.?code|over.?hour|duration.?exception|time.?exception/i.test(p + body)) return 'exception';
  if (/pin|supervisor.?pin|validate.?pin/i.test(p + body)) return 'pin';
  if (/to_store|to-store|mileage|odometer|distance/i.test(p + body)) return 'mileage';
  if (/photo|picture|image|upload|presign|multipart/i.test(p + body)) return 'photo';
  if (/survey|question/i.test(p)) return 'survey';
  if (/checklist|write.?order|ewc/i.test(p + body)) return 'checklist';
  if (/shift.?complet|complete.?shift|end.?shift|finish/i.test(p)) return 'complete';
  if (/actual.?start|actual.?end|start.?time|end.?time|punch|time.?entry/i.test(p + body)) return 'time';
  if (/category.?reset|planogram|bay|section/i.test(p)) return 'category';
  if (/team.?schedul|visit|shift/i.test(p) && method !== 'GET') return 'visit_mutate';
  if (/team.?schedul|visit|shift/i.test(p)) return 'visit_read';
  if (/auth|token|login|session/i.test(p)) return 'auth';
  if (method === 'GET') return 'get';
  return 'other_write';
}

function main() {
  ensureDir(OUT_DIR);
  const all = [];
  let seq = 0;

  for (let partIdx = 0; partIdx < PARTS.length; partIdx++) {
    const partPath = PARTS[partIdx];
    console.error('Loading', path.basename(partPath), '…');
    const har = JSON.parse(fs.readFileSync(partPath, 'utf8'));
    const entries = har.log?.entries || [];
    for (const e of entries) {
      seq += 1;
      const req = e.request || {};
      const res = e.response || {};
      const { host, path: pathName, search } = parseUrl(req.url || '');
      const method = (req.method || 'GET').toUpperCase();
      const status = res.status || 0;
      const mime = res.content?.mimeType || '';
      const reqBody = postDataText(req.postData);
      const resBody = bodyText(res.content);
      const contentType = getHeader(req.headers, 'content-type') || '';
      const interesting = isApiInteresting(host, pathName, method);

      // Skip noise: static assets, analytics if not API
      const isStatic =
        /\.(js|css|woff2?|ttf|png|jpg|svg|ico|map)(\?|$)/i.test(pathName) ||
        /google-analytics|doubleclick|hotjar|segment|fullstory|sentry/i.test(host);

      if (!interesting && isStatic) continue;
      if (!interesting && method === 'GET' && status === 200 && /text\/html|javascript|css|font/i.test(mime)) continue;

      // Keep API-ish or mutates or errors
      const keep =
        interesting ||
        method !== 'GET' ||
        status >= 400 ||
        /api\//i.test(pathName);

      if (!keep) continue;

      const postJson = tryJson(reqBody);
      const resJson = tryJson(resBody);
      const cls = classify(pathName, method, reqBody, status);

      all.push({
        seq,
        part: partIdx + 1,
        startedDateTime: e.startedDateTime,
        timeMs: e.time,
        method,
        status,
        host,
        path: pathName,
        pathBucket: pathBucket(pathName),
        search: search || '',
        contentType,
        mime,
        class: cls,
        reqBytes: reqBody ? Buffer.byteLength(reqBody) : 0,
        resBytes: resBody ? Buffer.byteLength(resBody) : 0,
        reqPreview: summarizeBody(reqBody, 500),
        resPreview: summarizeBody(resBody, 500),
        // keep full bodies only for non-photo-ish small mutates
        reqBody:
          method !== 'GET' && reqBody.length < 50_000 && !/image|jpeg|png|multipart/i.test(contentType)
            ? reqBody
            : method !== 'GET' && reqBody.length < 2000
              ? reqBody
              : null,
        resBody:
          status >= 400 ||
          (method !== 'GET' && resBody.length < 30_000 && !/image|jpeg|png/i.test(mime))
            ? resBody.slice(0, 100_000)
            : resBody.length < 2000
              ? resBody
              : null,
        postJsonKeys: postJson && typeof postJson === 'object' ? Object.keys(postJson).slice(0, 40) : null,
        resJsonKeys: resJson && typeof resJson === 'object' ? Object.keys(resJson).slice(0, 40) : null,
      });
    }
  }

  // Sort by time
  all.sort((a, b) => String(a.startedDateTime).localeCompare(String(b.startedDateTime)) || a.seq - b.seq);

  // Focus list: mutations + exceptions + pin + time + mileage + photos + 4xx/5xx
  const focus = all.filter(
    (x) =>
      x.method !== 'GET' ||
      x.status >= 400 ||
      ['exception', 'pin', 'mileage', 'time', 'photo', 'survey', 'checklist', 'complete', 'visit_mutate', 'category'].includes(
        x.class
      ) ||
      /\/api\//i.test(x.path)
  );

  // Unique endpoint patterns for writes
  const writePatterns = {};
  for (const x of all) {
    if (x.method === 'GET' && x.status < 400) continue;
    const key = `${x.method} ${x.pathBucket}`;
    if (!writePatterns[key]) {
      writePatterns[key] = {
        method: x.method,
        pathBucket: x.pathBucket,
        count: 0,
        statuses: {},
        classes: new Set(),
        samples: [],
      };
    }
    const w = writePatterns[key];
    w.count += 1;
    w.statuses[x.status] = (w.statuses[x.status] || 0) + 1;
    w.classes.add(x.class);
    if (w.samples.length < 3) {
      w.samples.push({
        startedDateTime: x.startedDateTime,
        path: x.path,
        status: x.status,
        reqPreview: x.reqPreview,
        resPreview: x.resPreview,
        postJsonKeys: x.postJsonKeys,
      });
    }
  }

  const writeList = Object.values(writePatterns).map((w) => ({
    ...w,
    classes: [...w.classes],
  }));
  writeList.sort((a, b) => b.count - a.count);

  // Keyword search across all kept entries for exception language
  const keywordHits = all.filter((x) => {
    const blob = `${x.path} ${x.reqPreview} ${x.resPreview} ${x.search}`.toLowerCase();
    return /exception|reason_code|reasoncode|over.?hour|duration|less.?than|minimum|one.?hour|1.?hour|pin|supervisor|to_store|actual_start|actual_end|actualstart|actualend|completed_by|mileage|odometer/.test(
      blob
    );
  });

  // Timeline of only mutations + keyword hits
  const timeline = [];
  const seen = new Set();
  for (const x of [...focus, ...keywordHits]) {
    const k = `${x.startedDateTime}|${x.method}|${x.path}|${x.status}|${x.seq}`;
    if (seen.has(k)) continue;
    seen.add(k);
    timeline.push(x);
  }
  timeline.sort((a, b) => String(a.startedDateTime).localeCompare(String(b.startedDateTime)) || a.seq - b.seq);

  // Extract full bodies for high-value calls
  const highValue = timeline.filter((x) =>
    /exception|pin|to_store|mileage|actual|complete|shift|visit|photo|survey|time|punch|reason/i.test(
      x.path + x.reqPreview + x.class
    )
  );

  fs.writeFileSync(path.join(OUT_DIR, 'all-kept.json'), JSON.stringify(all, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'write-patterns.json'), JSON.stringify(writeList, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'timeline-focus.json'), JSON.stringify(timeline, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'keyword-hits.json'), JSON.stringify(keywordHits, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'high-value.json'), JSON.stringify(highValue, null, 2));

  // Compact markdown report
  const lines = [];
  lines.push('# James FM53 HAR analysis (2026-07-15 recording)');
  lines.push('');
  lines.push(`Parts: 3 · Kept API-ish entries: **${all.length}** · Focus timeline: **${timeline.length}** · Write patterns: **${writeList.length}**`);
  lines.push('');
  lines.push('## Write / non-GET endpoint patterns');
  lines.push('');
  lines.push('| Count | Method | Path pattern | Statuses | Class |');
  lines.push('|------:|--------|--------------|----------|-------|');
  for (const w of writeList.slice(0, 80)) {
    lines.push(
      `| ${w.count} | ${w.method} | \`${w.pathBucket}\` | ${JSON.stringify(w.statuses)} | ${w.classes.join(',')} |`
    );
  }
  lines.push('');
  lines.push('## Chronological mutations + key GETs (preview)');
  lines.push('');
  for (const x of timeline) {
    if (x.method === 'GET' && x.status < 400 && !/exception|pin|to_store|actual|complete|shift-complet|mileage|survey|photo|category-reset/i.test(x.path + x.reqPreview)) {
      continue;
    }
    lines.push(`### ${x.startedDateTime} · ${x.method} ${x.status} · ${x.class}`);
    lines.push(`\`${x.path}${x.search}\``);
    if (x.reqPreview) lines.push(`- **req:** ${x.reqPreview}`);
    if (x.resPreview) lines.push(`- **res:** ${x.resPreview}`);
    lines.push('');
  }

  fs.writeFileSync(path.join(OUT_DIR, 'REPORT.md'), lines.join('\n'));

  // Print summary to stdout
  console.log(
    JSON.stringify(
      {
        outDir: OUT_DIR,
        kept: all.length,
        timeline: timeline.length,
        writePatterns: writeList.length,
        keywordHits: keywordHits.length,
        topWrites: writeList.slice(0, 40).map((w) => ({
          n: w.count,
          m: w.method,
          p: w.pathBucket,
          s: w.statuses,
          c: w.classes,
        })),
        classes: all.reduce((acc, x) => {
          acc[x.class] = (acc[x.class] || 0) + 1;
          return acc;
        }, {}),
      },
      null,
      2
    )
  );
}

main();
