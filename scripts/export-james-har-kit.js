/**
 * Export James Duchene FM53 2026-07-15 sealed draft + photos for SAS HAR recording.
 * Usage: node scripts/export-james-har-kit.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DRAFT_ID = 'james-duchene/2026-07-15-53';
const DRAFT_PATH = path.join(ROOT, 'data', 'visit-drafts', 'james-duchene', '2026-07-15-53.json');
const PHOTOS_DIR = path.join(ROOT, 'data', 'visit-drafts', 'james-duchene', '2026-07-15-53-photos');
const OUT =
  process.env.HAR_KIT_OUT ||
  path.join(process.env.USERPROFILE || process.env.HOME || ROOT, 'Downloads', 'James-FM53-2026-07-15-HAR-kit');

// PROD match from shadow prep (not in draft JSON)
const PROD = {
  visitId: 27000977,
  shiftId: 44392384,
  supervisor: '800175315',
  employee: 'James Duchene',
  email: 'james.duchene@retailodyssey.com',
  store: 53,
  scheduledStore: 391,
  date: '2026-07-15',
  day: 'Wednesday',
};

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  return dest;
}

function localPath(p) {
  if (!p) return null;
  if (path.isAbsolute(p)) return p;
  return path.join(ROOT, p.replace(/\//g, path.sep));
}

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

function toLocalPacific(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  // en-US Pacific display for punch card
  return d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

function collectPhotoSlots(draft) {
  const slots = [];

  for (const p of draft.beforePhotos || []) {
    slots.push({
      slot: 'before',
      label: `before-${pad(p.seq, 2)}`,
      folder: '01-before',
      file: p,
    });
  }

  const checklistOrder = [
    'ewc-01',
    'ewc-02',
    'ewc-03',
    'ewc-04',
    'ewc-05',
    'cred-02',
    'litter-01',
    'allsections-01',
  ];
  for (const key of checklistOrder) {
    const item = (draft.checklist || {})[key];
    if (item && item.photo) {
      slots.push({
        slot: `checklist-${key}`,
        label: `checklist-${key}`,
        folder: '02-write-order-checklist',
        file: item.photo,
      });
    }
  }

  const catOrder = [
    'wing-panels',
    'cat-litter-pan-liners',
    'butcher-block-rack',
    'cp-serviced-section',
    'clipstrips',
    'endcaps',
  ];
  for (const cat of catOrder) {
    const arr = (draft.categoryPhotos || {})[cat] || [];
    for (const p of arr) {
      slots.push({
        slot: cat,
        label: `${cat}-${pad(p.seq, 2)}`,
        folder: `03-category/${cat}`,
        file: p,
      });
    }
  }

  for (const p of draft.afterPhotos || []) {
    slots.push({
      slot: 'after',
      label: `after-${pad(p.seq, 2)}`,
      folder: '04-after',
      file: p,
    });
  }

  return slots;
}

function main() {
  if (!fs.existsSync(DRAFT_PATH)) {
    console.error('Draft not found:', DRAFT_PATH);
    process.exit(1);
  }

  const draft = JSON.parse(fs.readFileSync(DRAFT_PATH, 'utf8'));
  ensureDir(OUT);

  const sealedPath = path.join(OUT, 'sealed-draft.json');
  fs.writeFileSync(sealedPath, JSON.stringify(draft, null, 2));

  const prodPath = path.join(OUT, 'prod-match.json');
  fs.writeFileSync(prodPath, JSON.stringify(PROD, null, 2));

  const rawDir = path.join(OUT, 'photos-raw');
  ensureDir(rawDir);
  const bySlotDir = path.join(OUT, 'photos-by-slot');
  ensureDir(bySlotDir);

  const slots = collectPhotoSlots(draft);
  const manifest = [];
  let copied = 0;
  let missing = 0;

  // Copy all files from photos dir into raw
  if (fs.existsSync(PHOTOS_DIR)) {
    for (const name of fs.readdirSync(PHOTOS_DIR)) {
      if (!/\.(jpe?g|png|webp)$/i.test(name)) continue;
      copyFile(path.join(PHOTOS_DIR, name), path.join(rawDir, name));
    }
  }

  for (const s of slots) {
    const src = localPath(s.file.path);
    const ext = path.extname(src || '') || '.jpg';
    const destName = `${s.label}${ext}`;
    const dest = path.join(bySlotDir, s.folder, destName);
    const entry = {
      slot: s.slot,
      label: s.label,
      folder: s.folder,
      dest: path.relative(OUT, dest).replace(/\\/g, '/'),
      source: s.file.path,
      seq: s.file.seq,
      capturedAt: s.file.capturedAt,
      capturedAtPacific: toLocalPacific(s.file.capturedAt),
      exists: false,
      bytes: 0,
    };
    if (src && fs.existsSync(src)) {
      copyFile(src, dest);
      entry.exists = true;
      entry.bytes = fs.statSync(src).size;
      copied += 1;
    } else {
      missing += 1;
      console.warn('MISSING photo:', s.file.path);
    }
    manifest.push(entry);
  }

  fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify({
    draftId: DRAFT_ID,
    exportedAt: new Date().toISOString(),
    prod: PROD,
    photoCount: { slotted: slots.length, copied, missing },
    photos: manifest,
  }, null, 2));

  // CSV for quick glance
  const csvLines = ['slot,label,folder,file,capturedAtPacific,bytes,exists'];
  for (const m of manifest) {
    csvLines.push(
      [m.slot, m.label, m.folder, m.dest, m.capturedAtPacific, m.bytes, m.exists]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    );
  }
  fs.writeFileSync(path.join(OUT, 'MANIFEST.csv'), csvLines.join('\n'));

  const startPac = toLocalPacific(draft.visitStart?.actual);
  const stopPac = toLocalPacific(draft.visitStop?.actual);
  const sealedPac = toLocalPacific(draft.sealedAt);

  const punch = `# PUNCH CARD — James Duchene · FM53 · Wed 2026-07-15

Use this while recording a full SAS PROD HAR (start → finish).
Do **not** invent times — match these values when the field app / shift-completion UI asks.

## PROD identifiers
| Field | Value |
|-------|-------|
| Employee | James Duchene |
| Email | james.duchene@retailodyssey.com |
| Store (actual) | **53** (Fred Meyer) |
| Scheduled store on export | 391 |
| Date | **2026-07-15** (Wednesday) |
| visitId | **27000977** |
| shiftId | **44392384** |
| Supervisor id | 800175315 |

## Visit times (Pacific)
| Event | ISO (UTC) | Pacific display |
|-------|-----------|-----------------|
| Visit START | ${draft.visitStart?.actual || ''} | **${startPac}** |
| Visit STOP | ${draft.visitStop?.actual || ''} | **${stopPac}** |
| Sealed (app) | ${draft.sealedAt || ''} | ${sealedPac} |

## Flags
| Field | Value |
|-------|-------|
| Write order | **true** (WO checklist completed) |
| Work load | **false** (service day only / no new order) |
| Last stop of day | **true** |
| Mileage 53 → home | **3.4** miles |
| Mileage note | N/A |

## Survey answers (as sealed)
| Q | Answer |
|---|--------|
| q1 | ${draft.survey?.q1} |
| q2 | ${draft.survey?.q2} |
| q3 | ${draft.survey?.q3} |
| q4 | ${draft.survey?.q4} |
| q5 | ${draft.survey?.q5} |
| q6 | ${draft.survey?.q6} |
| q7 | ${draft.survey?.q7} |
| q8 | ${draft.survey?.q8} |
| q9 | ${draft.survey?.q9} |
| q10 | ${draft.survey?.q10} |
| q11 | ${draft.survey?.q11} |
| q12 | ${draft.survey?.q12} |

## Write-order checklist (checked)
${Object.entries(draft.checklist || {})
  .map(([k, v]) => `- **${k}**: checked=${v.checked}${v.photo ? ' + photo' : ' (no photo)'}`)
  .join('\n')}

## Photo counts (upload in this order in SAS if prompted)
| Slot | Count | Folder in kit |
|------|------:|---------------|
| Before | ${(draft.beforePhotos || []).length} | photos-by-slot/01-before |
| Checklist (ewc-01, litter-01, allsections-01) | ${manifest.filter((m) => m.folder.includes('checklist')).length} | photos-by-slot/02-write-order-checklist |
| wing-panels | ${((draft.categoryPhotos || {})['wing-panels'] || []).length} | 03-category/wing-panels |
| cat-litter-pan-liners | ${((draft.categoryPhotos || {})['cat-litter-pan-liners'] || []).length} | 03-category/cat-litter-pan-liners |
| butcher-block-rack | ${((draft.categoryPhotos || {})['butcher-block-rack'] || []).length} | 03-category/butcher-block-rack |
| cp-serviced-section | ${((draft.categoryPhotos || {})['cp-serviced-section'] || []).length} | 03-category/cp-serviced-section |
| clipstrips | ${((draft.categoryPhotos || {})['clipstrips'] || []).length} | 03-category/clipstrips |
| endcaps | ${((draft.categoryPhotos || {})['endcaps'] || []).length} | 03-category/endcaps |
| After | ${(draft.afterPhotos || []).length} | photos-by-slot/04-after |
| **TOTAL slotted** | **${slots.length}** | |

## Suggested SAS walk-through order for HAR
1. Open **prod.sasretail.com** field app / Operations (Chrome DevTools → Network → Preserve log → Export HAR when done).
2. Find James Duchene visit **27000977** / shift **44392384** for store **53** on **2026-07-15**.
3. **Start visit** (or open in-progress if already active) — note every API call.
4. Upload **before** photos (8 files, seq order).
5. Complete **write-order** checklist items (photos where present).
6. Category / section photos in folder order under \`03-category\`.
7. Survey answers from table above.
8. Upload **after** photos (8 files).
9. Time / punches: start **${startPac}**, stop **${stopPac}**.
10. Mileage **3.4** (store 53 → home), last stop of day.
11. Complete / submit shift — capture PIN / supervisor prompts if any.
12. Export HAR → save as \`James-FM53-2026-07-15-full-shift.har\` next to this kit.

## Safety
- PROD may already have a **partial** live-transmit attempt (to_store failed). Prefer a clean first-time path if visit is still "Not started" / open; if mid-state, record what the UI actually requires to finish.
- Do not delete or reassign the shift while recording unless intentional.
`;

  fs.writeFileSync(path.join(OUT, 'PUNCH-CARD.md'), punch);

  const readme = `# James FM53 2026-07-15 — HAR recording kit

Sealed field draft + all photos so you can complete the **same shift in SAS PROD** once while Chrome records a full HAR (start → finish).

## Location
\`${OUT}\`

## Contents
| File / folder | Purpose |
|---------------|---------|
| \`sealed-draft.json\` | Full app draft (status ready_for_prod) |
| \`prod-match.json\` | visitId / shiftId / store / date |
| \`PUNCH-CARD.md\` | Times, survey, mileage, photo order |
| \`MANIFEST.json\` / \`.csv\` | Every photo mapped to slot + Pacific time |
| \`photos-by-slot/\` | Photos renamed and grouped for upload order |
| \`photos-raw/\` | Original filenames from the phone queue |

## How to record the HAR
1. Open \`PUNCH-CARD.md\` on a second monitor (or print).
2. Chrome → \`https://prod.sasretail.com\` → log in as normal ops user.
3. F12 → **Network** → check **Preserve log** → clear.
4. Walk the shift using punch card values and \`photos-by-slot\` folders.
5. When fully complete: Network → ⋮ → **Save all as HAR with content**.
6. Drop the \`.har\` file into this folder (or send it back) so the live executor can match the real API sequence.

## Key IDs
- **visitId:** 27000977
- **shiftId:** 44392384
- **Store:** 53 (actual) · date 2026-07-15
- **Employee:** James Duchene

## Photo total
- Slotted (with metadata): ${slots.length}
- Copied successfully: ${copied}
- Missing: ${missing}
- Raw folder: all JPGs from the draft photos directory

## Re-export
\`\`\`
node scripts/export-james-har-kit.js
\`\`\`
`;

  fs.writeFileSync(path.join(OUT, 'README.md'), readme);

  console.log(JSON.stringify({
    out: OUT,
    slotted: slots.length,
    copied,
    missing,
    before: (draft.beforePhotos || []).length,
    after: (draft.afterPhotos || []).length,
    status: draft.status,
    visitId: PROD.visitId,
    shiftId: PROD.shiftId,
  }, null, 2));
}

main();
