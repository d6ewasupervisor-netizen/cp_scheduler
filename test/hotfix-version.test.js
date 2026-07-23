'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const ROOT = path.join(__dirname, '..');
const VERSION_JSON = path.join(ROOT, 'public', 'app-version.json');
const HOTFIX_JS = path.join(ROOT, 'public', 'hotfix.js');

describe('hotfix version lockstep', () => {
  it('app-version.json and hotfix.js CP_APP_VERSION match', () => {
    const manifest = JSON.parse(fs.readFileSync(VERSION_JSON, 'utf8'));
    const js = fs.readFileSync(HOTFIX_JS, 'utf8');
    const m = js.match(/CP_APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
    assert.ok(m, 'CP_APP_VERSION constant missing from hotfix.js');
    assert.equal(String(manifest.version).trim(), m[1].trim());
  });

  it('authenticated HTML shells load hotfix.js', () => {
    const pages = [
      'shiftday.html',
      'index.html',
      'dashboard.html',
      'rep.html',
      'photo-training.html',
      'signin.html',
    ];
    for (const page of pages) {
      const html = fs.readFileSync(path.join(ROOT, 'public', page), 'utf8');
      assert.match(html, /src=["']\/hotfix\.js["']/, `${page} missing /hotfix.js`);
    }
  });
});
