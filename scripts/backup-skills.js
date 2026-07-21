'use strict';

/**
 * Skills Backup versioning tool.
 *
 * Backup root: C:/Users/tgaut/OneDrive/Skills Backup
 *
 * Layout per skill:
 *   <skill-name>/
 *     base/                 # first-ever snapshot (immutable once written)
 *       …skill files…
 *     mods/
 *       <UTC-timestamp>/    # each later change
 *         MANIFEST.json
 *         DIFF.patch        # unified diff vs previous snapshot (base or prior mod)
 *         …full skill files snapshot…
 *     LATEST.txt            # relative path of newest snapshot (base or mods/…)
 *
 * Usage:
 *   node backup-skills.js                 # snapshot every discovered skill
 *   node backup-skills.js --skill NAME    # one skill
 *   node backup-skills.js --only-changed  # skip when identical to LATEST
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const BACKUP_ROOT =
  process.env.SKILLS_BACKUP_ROOT ||
  path.join(process.env.USERPROFILE || process.env.HOME, 'OneDrive', 'Skills Backup');

const SOURCES = [
  { label: 'user-skills', root: path.join(process.env.USERPROFILE || '', '.cursor', 'skills') },
  { label: 'cp_scheduler', root: path.join(process.env.USERPROFILE || '', 'cp_scheduler', '.cursor', 'skills') },
  { label: 'eod-api', root: path.join(process.env.USERPROFILE || '', 'eod-api', '.cursor', 'skills') },
  { label: 'kompass-netcap', root: path.join(process.env.USERPROFILE || '', 'kompass-netcap', '.cursor', 'skills') },
  { label: 'flow-automation', root: path.join(process.env.USERPROFILE || '', 'flow-automation', '.cursor', 'skills') },
  {
    label: 'the-dump-bin',
    root: path.join(process.env.USERPROFILE || '', 'OneDrive', 'Documents', 'GitHub', 'the-dump-bin', '.cursor', 'skills'),
  },
  { label: 'sas-retail-automator', root: path.join(process.env.USERPROFILE || '', 'sas-retail-automator', '.cursor', 'skills') },
];

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function listSkillDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, d.name))
    .filter((p) => fs.existsSync(path.join(p, 'SKILL.md')));
}

function walkFiles(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    // Backup metadata — never part of content identity
    if (ent.name === 'MANIFEST.json' || ent.name === 'DIFF.patch' || ent.name === 'LATEST.txt') continue;
    if (ent.isDirectory()) walkFiles(abs, base, out);
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out.sort();
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of walkFiles(src)) {
    const from = path.join(src, rel);
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function hashTree(dir) {
  const h = crypto.createHash('sha256');
  for (const rel of walkFiles(dir)) {
    h.update(rel);
    h.update('\0');
    h.update(fs.readFileSync(path.join(dir, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

function makeDiff(prevDir, nextDir, outPatch) {
  try {
    // Prefer git diff --no-index when available
    const out = execFileSync(
      'git',
      ['diff', '--no-index', '--', prevDir, nextDir],
      { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
    );
    fs.writeFileSync(outPatch, out);
    return true;
  } catch (err) {
    // git diff --no-index exits 1 when differences exist — stdout still has the patch
    if (err.stdout && String(err.stdout).length) {
      fs.writeFileSync(outPatch, err.stdout);
      return true;
    }
    fs.writeFileSync(
      outPatch,
      `# diff unavailable\n# prev=${prevDir}\n# next=${nextDir}\n# error=${err.message}\n`
    );
    return false;
  }
}

function backupOne(skillDir, sourceLabel, { onlyChanged }) {
  const skillName = path.basename(skillDir);
  const destRoot = path.join(BACKUP_ROOT, skillName);
  const baseDir = path.join(destRoot, 'base');
  const modsDir = path.join(destRoot, 'mods');
  const latestFile = path.join(destRoot, 'LATEST.txt');

  fs.mkdirSync(modsDir, { recursive: true });

  const newHash = hashTree(skillDir);
  let latestRel = null;
  if (fs.existsSync(latestFile)) latestRel = fs.readFileSync(latestFile, 'utf8').trim();
  const latestAbs = latestRel ? path.join(destRoot, latestRel) : null;

  if (!fs.existsSync(baseDir) || !fs.existsSync(path.join(baseDir, 'SKILL.md'))) {
    copyTree(skillDir, baseDir);
    fs.writeFileSync(
      path.join(baseDir, 'MANIFEST.json'),
      JSON.stringify(
        {
          skill: skillName,
          kind: 'base',
          source: sourceLabel,
          sourcePath: skillDir,
          createdAt: new Date().toISOString(),
          contentSha256: newHash,
        },
        null,
        2
      )
    );
    fs.writeFileSync(latestFile, 'base\n');
    console.log(`[base] ${skillName} ← ${sourceLabel}`);
    return { skill: skillName, action: 'base' };
  }

  const prevHash = latestAbs && fs.existsSync(latestAbs) ? hashTree(latestAbs) : null;
  if (onlyChanged && prevHash && prevHash === newHash) {
    console.log(`[skip] ${skillName} unchanged`);
    return { skill: skillName, action: 'skip' };
  }

  // Prefer user-skills as the canonical live copy when hashing equal across sources —
  // still write a mod when hash differs from LATEST.
  if (prevHash && prevHash === newHash) {
    console.log(`[skip] ${skillName} unchanged vs LATEST`);
    return { skill: skillName, action: 'skip' };
  }

  const ts = stamp();
  const modRel = path.join('mods', ts);
  const modAbs = path.join(destRoot, modRel);
  copyTree(skillDir, modAbs);

  const prevForDiff = latestAbs && fs.existsSync(latestAbs) ? latestAbs : baseDir;
  makeDiff(prevForDiff, modAbs, path.join(modAbs, 'DIFF.patch'));

  fs.writeFileSync(
    path.join(modAbs, 'MANIFEST.json'),
    JSON.stringify(
      {
        skill: skillName,
        kind: 'mod',
        source: sourceLabel,
        sourcePath: skillDir,
        createdAt: new Date().toISOString(),
        contentSha256: newHash,
        previous: latestRel || 'base',
        diffFile: 'DIFF.patch',
      },
      null,
      2
    )
  );
  fs.writeFileSync(latestFile, `${modRel.split(path.sep).join('/')}\n`);
  console.log(`[mod]  ${skillName} → ${modRel} ← ${sourceLabel}`);
  return { skill: skillName, action: 'mod', mod: modRel };
}

function discover() {
  const byName = new Map(); // skillName → { dir, label }
  for (const src of SOURCES) {
    for (const dir of listSkillDirs(src.root)) {
      const name = path.basename(dir);
      // Prefer user-skills as canonical when present
      if (!byName.has(name) || src.label === 'user-skills') {
        byName.set(name, { dir, label: src.label });
      }
    }
  }
  return byName;
}

function main() {
  const args = process.argv.slice(2);
  const onlyChanged = args.includes('--only-changed');
  const skillIdx = args.indexOf('--skill');
  const onlySkill = skillIdx >= 0 ? args[skillIdx + 1] : null;

  fs.mkdirSync(BACKUP_ROOT, { recursive: true });

  const map = discover();
  const names = [...map.keys()].sort();
  const selected = onlySkill ? names.filter((n) => n === onlySkill) : names;
  if (onlySkill && !selected.length) {
    console.error(`Skill not found: ${onlySkill}`);
    process.exit(1);
  }

  const summary = { backedUp: 0, mods: 0, bases: 0, skipped: 0 };
  for (const name of selected) {
    const { dir, label } = map.get(name);
    const r = backupOne(dir, label, { onlyChanged });
    if (r.action === 'base') summary.bases += 1;
    else if (r.action === 'mod') summary.mods += 1;
    else summary.skipped += 1;
    summary.backedUp += 1;
  }

  console.log('\nSummary:', summary);
  console.log('Backup root:', BACKUP_ROOT);
}

main();
