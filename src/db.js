'use strict';

const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../../data/schedule-drafts.json');

function readDb() {
  if (!fs.existsSync(DB_PATH)) return { drafts: [] };
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDb(data) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function initDb() {
  if (!fs.existsSync(DB_PATH)) writeDb({ drafts: [] });
}

function listDrafts(repKey, weekStart) {
  const db = readDb();
  return db.drafts.filter(
    (d) => (!repKey || d.repKey === repKey) && (!weekStart || d.weekStart === weekStart)
  );
}

function getDraft(id) {
  return readDb().drafts.find((d) => d.id === id) || null;
}

function saveDraft(payload) {
  const db = readDb();
  const existing = db.drafts.find(
    (d) => d.repKey === payload.repKey && d.weekStart === payload.weekStart && d.status === 'draft'
  );
  const now = new Date().toISOString();
  if (existing) {
    if (existing.status === 'approved') throw new Error('Cannot edit approved draft');
    existing.placements = payload.placements;
    existing.updatedAt = now;
    existing.createdBy = payload.createdBy || existing.createdBy;
    writeDb(db);
    return existing;
  }
  const draft = {
    id: `draft_${Date.now()}`,
    repKey: payload.repKey,
    weekStart: payload.weekStart,
    weekEnd: payload.weekEnd,
    weekLabel: payload.weekLabel,
    placements: payload.placements,
    status: 'draft',
    approvedAt: null,
    approvedBy: null,
    handoffJson: null,
    handoffMarkdown: null,
    reviewHtml: null,
    createdBy: payload.createdBy || 'local',
    createdAt: now,
    updatedAt: now,
  };
  db.drafts.push(draft);
  writeDb(db);
  return draft;
}

function approveDraft(id, approver, handoff) {
  const db = readDb();
  const draft = db.drafts.find((d) => d.id === id);
  if (!draft) throw new Error('Draft not found');
  if (draft.status === 'approved') throw new Error('Already approved');
  draft.status = 'approved';
  draft.approvedAt = new Date().toISOString();
  draft.approvedBy = approver;
  draft.handoffJson = handoff.json;
  draft.handoffMarkdown = handoff.markdown;
  draft.reviewHtml = handoff.reviewHtml;
  draft.updatedAt = draft.approvedAt;
  writeDb(db);
  return draft;
}

module.exports = { initDb, listDrafts, getDraft, saveDraft, approveDraft, DB_PATH };
