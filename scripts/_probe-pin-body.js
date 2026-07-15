'use strict';
const fs = require('fs');
const path = require('path');
const dir = 'C:/Users/tgaut/Downloads';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.har'));
const hits = [];
for (const f of files) {
  let har;
  try {
    har = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  } catch {
    continue;
  }
  for (const e of har.log?.entries || []) {
    const url = e.request?.url || '';
    if (!url.includes('prod.sasretail.com')) continue;
    const body = e.request?.postData?.text || '';
    if (body.includes('"pin"') || body.includes('pin":')) {
      hits.push({
        f,
        method: e.request.method,
        url: url.split('prod.sasretail.com')[1] || url,
        body: body.slice(0, 250),
        status: e.response?.status,
      });
    }
  }
}
console.log('hits', hits.length);
hits.slice(0, 20).forEach((h) => console.log(JSON.stringify(h)));
