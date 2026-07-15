'use strict';
/**
 * One-off utility: extract plain-text (and stripped HTML) bodies from a .eml
 * file so they can be read/diffed as plain text. Not part of the app runtime.
 *
 * Usage: node scripts/extract-eml-text.js <path-to-eml> <output-txt>
 */

const fs = require('fs');

function decodeQuotedPrintable(input) {
  const joined = input.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === '=' && /[0-9A-Fa-f]{2}/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function parseHeaders(block) {
  const headers = {};
  const lines = block.split(/\r?\n/);
  let currentKey = null;
  for (const line of lines) {
    if (/^\s/.test(line) && currentKey) {
      headers[currentKey] += ' ' + line.trim();
    } else {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      currentKey = line.slice(0, idx).trim().toLowerCase();
      headers[currentKey] = line.slice(idx + 1).trim();
    }
  }
  return headers;
}

function splitHeaderBody(raw) {
  const idx = raw.search(/\r?\n\r?\n/);
  if (idx === -1) return { headers: raw, body: '' };
  const headerBlock = raw.slice(0, idx);
  const bodyStart = raw.slice(idx).replace(/^\r?\n\r?\n/, '');
  return { headers: headerBlock, body: bodyStart };
}

function getBoundary(contentType) {
  const m = /boundary="?([^";]+)"?/i.exec(contentType || '');
  return m ? m[1] : null;
}

function decodeBody(headers, body) {
  const cte = (headers['content-transfer-encoding'] || '').toLowerCase();
  if (cte === 'quoted-printable') return decodeQuotedPrintable(body);
  if (cte === 'base64') {
    try {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch (e) {
      return '[base64 decode error]';
    }
  }
  return body;
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function walkParts(raw, collected) {
  const { headers: headerBlock, body } = splitHeaderBody(raw);
  const headers = parseHeaders(headerBlock);
  const contentType = headers['content-type'] || '';
  const boundary = getBoundary(contentType);

  if (boundary) {
    const parts = body.split(new RegExp('--' + boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:--)?'));
    for (const part of parts) {
      const trimmed = part.replace(/^\r?\n/, '');
      if (!trimmed.trim()) continue;
      walkParts(trimmed, collected);
    }
    return;
  }

  if (/text\/plain/i.test(contentType)) {
    collected.plain.push(decodeBody(headers, body));
  } else if (/text\/html/i.test(contentType)) {
    collected.html.push(decodeBody(headers, body));
  }
}

function main() {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error('Usage: node scripts/extract-eml-text.js <in.eml> <out.txt>');
    process.exit(1);
  }
  const raw = fs.readFileSync(inPath, 'utf8');
  const { headers: headerBlock } = splitHeaderBody(raw);
  const headers = parseHeaders(headerBlock);

  const collected = { plain: [], html: [] };
  walkParts(raw, collected);

  let out = `SUBJECT: ${headers['subject'] || ''}\nFROM: ${headers['from'] || ''}\nDATE: ${headers['date'] || ''}\n\n`;
  if (collected.plain.length) {
    out += '=== PLAIN TEXT PARTS ===\n\n' + collected.plain.join('\n\n---\n\n');
  }
  if (collected.html.length) {
    out += '\n\n=== HTML (STRIPPED) PARTS ===\n\n' + collected.html.map(stripHtml).join('\n\n---\n\n');
  }
  fs.writeFileSync(outPath, out, 'utf8');
  console.log('Wrote', outPath, out.length, 'chars');
}

main();
