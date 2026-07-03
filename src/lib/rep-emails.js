'use strict';

// Maps a signed-in rep email to their repKey (as used by /api/central-pet/reps).
// Edit data/rep-emails.json to add mappings, e.g.:
//   { "someone@gmail.com": "Patricia Marks Z" }
// An empty value means "no mapping yet" — the rep page falls back to its
// one-time device picker, and draft scoping is not enforced for that user.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../../data/rep-emails.json');

function loadMap() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const map = {};
    for (const [email, repKey] of Object.entries(raw)) {
      if (typeof repKey === 'string' && repKey.trim()) {
        map[email.trim().toLowerCase()] = repKey.trim();
      }
    }
    return map;
  } catch {
    return {};
  }
}

function repKeyForEmail(email) {
  const map = loadMap();
  return map[(email || '').trim().toLowerCase()] || null;
}

module.exports = { repKeyForEmail };
