'use strict';

const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const { validatePlacements } = require('../lib/master-route-constraints');
const {
  loadMasterRoute,
  listReps,
  getRep,
  defaultPlacementsForWeek,
} = require('../lib/master-route');
const { listWeeks, getWeekByStart } = require('../lib/fiscal-calendar');
const { fetchProdSchedule } = require('../lib/prod-schedule');
const {
  buildHandoffJson,
  buildHandoffMarkdown,
  buildReviewHtml,
  enrichPlacements,
} = require('../lib/schedule-handoff');
const { saveDraft, getDraft, listDrafts, approveDraft } = require('../db');

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

router.get('/weeks', (_req, res) => {
  res.json(listWeeks());
});

router.get('/master-route', (_req, res) => {
  const data = loadMasterRoute();
  res.json({
    versionDate: data.versionDate,
    sourceFile: data.sourceFile,
    rowCount: data.rowCount,
  });
});

router.get('/reps', (req, res) => {
  const district = req.query.district ? Number(req.query.district) : null;
  res.json(listReps(district));
});

router.get('/reps/:name', (req, res) => {
  const rep = getRep(decodeURIComponent(req.params.name));
  if (!rep) return res.status(404).json({ error: 'Rep not found' });
  res.json(rep);
});

router.post('/schedule/validate', (req, res) => {
  const { repKey, weekStart, placements } = req.body;
  const rep = getRep(repKey);
  if (!rep) return res.status(404).json({ error: 'Rep not found' });
  const { results, warnings, allValid } = validatePlacements(rep.visitSlots, placements || []);
  res.json({ results, warnings, allValid });
});

router.get('/schedule/default', (req, res) => {
  const repKey = req.query.rep;
  const weekStart = req.query.weekStart;
  const rep = getRep(repKey);
  if (!rep) return res.status(404).json({ error: 'Rep not found' });
  const week = getWeekByStart(weekStart);
  if (!week) return res.status(400).json({ error: 'Unknown week' });
  res.json({ placements: defaultPlacementsForWeek(rep, week.start) });
});

router.get('/schedule/draft', (req, res) => {
  res.json(listDrafts(req.query.rep, req.query.weekStart));
});

router.post('/schedule/draft', (req, res) => {
  try {
    const draft = saveDraft(req.body);
    res.json(draft);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/schedule/prod', async (req, res) => {
  const rep = getRep(req.query.rep);
  if (!rep?.employeeId) {
    return res.status(400).json({ error: 'Rep has no employeeId for PROD lookup' });
  }
  const week = getWeekByStart(req.query.weekStart);
  if (!week) return res.status(400).json({ error: 'Unknown week' });
  try {
    const data = await fetchProdSchedule(rep.employeeId, week.start, week.end);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/schedule/approve', async (req, res) => {
  const { draftId, approvedBy, prodShifts } = req.body;
  const draft = getDraft(draftId);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });

  const rep = getRep(draft.repKey);
  const masterRoute = loadMasterRoute();
  const { results, warnings } = validatePlacements(rep.visitSlots, draft.placements);
  const enriched = enrichPlacements(draft.placements, results, prodShifts || []);

  const payload = {
    status: 'approved',
    approvedAt: new Date().toISOString(),
    approvedBy: approvedBy || 'supervisor',
    rep: {
      name: rep.name,
      repKey: rep.repKey || rep.name,
      employeeId: rep.employeeId,
      workdayId: rep.workdayId,
      district: rep.district,
      email: rep.email,
      isD8Pool: !!rep.isD8Pool,
      proposedAssignees: rep.proposedAssignees || [],
      proposedAssigneeNote: rep.proposedAssigneeNote || null,
    },
    week: {
      label: draft.weekLabel,
      start: draft.weekStart,
      end: draft.weekEnd,
    },
    masterRouteVersion: masterRoute.versionDate,
    placements: enriched,
    warnings,
  };

  const json = buildHandoffJson(payload);
  const markdown = buildHandoffMarkdown(json);
  const reviewHtml = buildReviewHtml(json);

  try {
    const approved = approveDraft(draftId, payload.approvedBy, {
      json,
      markdown,
      reviewHtml,
    });
    res.json({ draft: approved, handoff: { json, markdown, reviewHtml } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/schedule/handoff/:draftId', (req, res) => {
  const draft = getDraft(req.params.draftId);
  if (!draft || draft.status !== 'approved') {
    return res.status(404).json({ error: 'Approved handoff not found' });
  }
  res.json({
    json: draft.handoffJson,
    markdown: draft.handoffMarkdown,
    reviewHtml: draft.reviewHtml,
  });
});

router.get('/schedule/export/:draftId', (req, res) => {
  const draft = getDraft(req.params.draftId);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  const format = req.query.format || 'json';

  if (format === 'json') {
    return res.json(draft.handoffJson || { draft });
  }
  if (format === 'markdown') {
    res.type('text/markdown');
    return res.send(draft.handoffMarkdown || '# No handoff yet — approve first\n');
  }
  if (format === 'review') {
    res.type('text/html');
    return res.send(draft.reviewHtml || '<p>Approve draft first</p>');
  }
  if (format === 'handoff') {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="schedule-handoff-${draft.repKey}-${draft.weekLabel}.zip"`
    );
    const archive = archiver('zip');
    archive.pipe(res);
    if (draft.handoffJson) archive.append(JSON.stringify(draft.handoffJson, null, 2), { name: 'schedule-handoff.json' });
    if (draft.handoffMarkdown) archive.append(draft.handoffMarkdown, { name: 'schedule-handoff.md' });
    if (draft.reviewHtml) archive.append(draft.reviewHtml, { name: 'schedule-review.html' });
    archive.finalize();
    return undefined;
  }
  return res.status(400).json({ error: 'Unknown format' });
});

router.post('/master-route/upload', upload.single('file'), (_req, res) => {
  res.status(501).json({ error: 'Upload parsing not yet wired — run scripts/parse-master-route.js locally' });
});

module.exports = router;
