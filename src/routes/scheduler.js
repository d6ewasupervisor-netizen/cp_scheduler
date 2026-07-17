'use strict';

const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const { validatePlacements } = require('../lib/master-route-constraints');
const {
  loadMasterRoute,
  listReps,
  getRep,
} = require('../lib/master-route');
const { listWeeks, getWeekByStart, dayToDateInWeek, dateToDayOfWeek } = require('../lib/fiscal-calendar');
const { resolveInitialPlacements, toTemplatePlacements } = require('../lib/weekly-template');
const { fetchProdSchedule } = require('../lib/prod-schedule');
const {
  buildHandoffJson,
  buildHandoffMarkdown,
  buildReviewHtml,
  enrichPlacements,
} = require('../lib/schedule-handoff');
const { saveDraft, getDraft, listDrafts, approveDraft, getWeeklyTemplate, saveWeeklyTemplate, clearWeeklyTemplate } = require('../db');
const { requireAdmin } = require('../auth-middleware');
const { buildVisitDetail } = require('../lib/visit-instructions');
const { repKeyForEmail } = require('../lib/rep-emails');
const { parseScheduleExport } = require('../lib/parse-schedule-export');
const {
  listWeekKeys,
  getWeekSchedule,
  saveWeekSchedule,
  getShiftsForRep,
  updateShiftDay,
  setWeekMatchCache,
} = require('../lib/shift-day-store');
const { loadD8ShiftReps, shiftRepByEmail, shiftRepByKey } = require('../lib/d8-shift-reps');
const { getStoreAddress } = require('../lib/store-addresses');
const { matchVisits, statusForShift } = require('../lib/visit-matcher');
const { syncWeekFromProd } = require('../lib/prod-week-sync');
const { getSasSessionStatus, loadSasSession, SasSessionError } = require('../lib/sas-session');
const { eodApiBase } = require('../lib/eod-api-proxy');
const {
  pushWeekDayMovesToProd,
  rescheduleVisitDay,
  isLiveScheduleWriteEnabled,
} = require('../lib/schedule-writer');
const visitFlow = require('../lib/visit-flow');
const visitDraftStore = require('../lib/visit-draft-store');
const { runDryRun } = require('../lib/dryrun-runner');
const dryrunStore = require('../lib/dryrun-store');
const { isLiveTransmitEnabled, loadAllowlist, isDraftAllowlisted, draftIdFromParts } = require('../lib/live-allowlist');
const liveRegistry = require('../lib/live-registry');
const liveStore = require('../lib/live-store');
const { executeLiveTransmit, runRoundtripDiff } = require('../lib/live-executor');
const {
  deliverVisitPhotos,
  getDeliveryStatus,
  isPhotoDeliveryEnabled,
} = require('../lib/photo-delivery');

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

// Rep-layer users may only touch their own schedule.
// If a rep email has a mapping in data/rep-emails.json, any rep value they
// send (query or body) is overwritten with their mapped repKey — they cannot
// read or write another rep's drafts. Unmapped rep emails pass through
// unchanged (device-picker fallback) until a mapping is added.
function repScope(req, _res, next) {
  if (req.user?.layer === 'rep') {
    const mine = repKeyForEmail(req.user.email);
    if (mine) {
      if (req.query && 'rep' in req.query) req.query.rep = mine;
      if (req.body && 'repKey' in req.body) req.body.repKey = mine;
      if (req.params && 'name' in req.params) req.params.name = encodeURIComponent(mine);
    }
    if (req.body) req.body.createdBy = req.user.email;
  }
  next();
}

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

router.get('/reps/:name', repScope, (req, res) => {
  const rep = getRep(decodeURIComponent(req.params.name));
  if (!rep) return res.status(404).json({ error: 'Rep not found' });
  res.json(rep);
});

router.post('/schedule/validate', repScope, (req, res) => {
  const { repKey, weekStart, placements } = req.body;
  const rep = getRep(repKey);
  if (!rep) return res.status(404).json({ error: 'Rep not found' });
  const { results, warnings, allValid } = validatePlacements(rep.visitSlots, placements || []);
  res.json({ results, warnings, allValid });
});

router.get('/schedule/default', repScope, (req, res) => {
  const repKey = req.query.rep;
  const weekStart = req.query.weekStart;
  const rep = getRep(repKey);
  if (!rep) return res.status(404).json({ error: 'Rep not found' });
  const week = getWeekByStart(weekStart);
  if (!week) return res.status(400).json({ error: 'Unknown week' });
  const template = getWeeklyTemplate(rep.repKey || rep.name);
  const resolved = resolveInitialPlacements(rep, week.start, template);
  res.json({
    placements: resolved.placements,
    source: resolved.source,
    weeklyTemplate: resolved.template
      ? {
          updatedAt: resolved.template.updatedAt,
          setFromWeekLabel: resolved.template.setFromWeekLabel,
          setBy: resolved.template.setBy,
        }
      : null,
  });
});

router.post('/schedule/visit-detail', repScope, (req, res) => {
  const { repKey, storeNum, visitIndex, placement } = req.body || {};
  const rep = getRep(repKey);
  if (!rep) return res.status(404).json({ error: 'Rep not found' });
  const slot = rep.visitSlots.find(
    (s) => s.storeNum === Number(storeNum) && (s.visitIndex ?? 0) === (visitIndex ?? 0)
  );
  if (!slot) return res.status(404).json({ error: 'Visit slot not found' });
  res.json(buildVisitDetail(slot, placement || {}, {
    isD8Pool: rep.isD8Pool,
    allowsRepAvailability: rep.allowsRepAvailability,
  }));
});

router.get('/schedule/weekly-template', requireAdmin, (req, res) => {
  const rep = getRep(req.query.rep);
  if (!rep) return res.status(404).json({ error: 'Rep not found' });
  const template = getWeeklyTemplate(rep.repKey || rep.name);
  if (!template) return res.json({ template: null });
  res.json({
    template: {
      repKey: template.repKey,
      placements: template.placements,
      updatedAt: template.updatedAt,
      setFromWeekLabel: template.setFromWeekLabel,
      setBy: template.setBy,
    },
  });
});

router.post('/schedule/weekly-template', requireAdmin, (req, res) => {
  try {
    const { repKey, placements, setFromWeekLabel, setBy } = req.body;
    const rep = getRep(repKey);
    if (!rep) return res.status(404).json({ error: 'Rep not found' });
    if (!placements?.length) return res.status(400).json({ error: 'No placements to save' });
    const template = saveWeeklyTemplate(rep.repKey || rep.name, toTemplatePlacements(placements), {
      setFromWeekLabel,
      setBy,
    });
    res.json({ template });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/schedule/weekly-template', requireAdmin, (req, res) => {
  const rep = getRep(req.query.rep);
  if (!rep) return res.status(404).json({ error: 'Rep not found' });
  const cleared = clearWeeklyTemplate(rep.repKey || rep.name);
  res.json({ cleared });
});

router.get('/schedule/draft', repScope, (req, res) => {
  res.json(listDrafts(req.query.rep, req.query.weekStart));
});

router.post('/schedule/draft', repScope, (req, res) => {
  try {
    const draft = saveDraft(req.body);
    res.json(draft);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/schedule/prod', requireAdmin, async (req, res) => {
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

router.post('/schedule/approve', requireAdmin, async (req, res) => {
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
      allowsRepAvailability: !!rep.allowsRepAvailability,
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

router.get('/schedule/handoff/:draftId', requireAdmin, (req, res) => {
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

router.get('/schedule/export/:draftId', requireAdmin, (req, res) => {
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

/* ---------- Shift Day (D8 individual reps) ---------- */

// Shift Day reps: overwrite any requested rep with the caller's mapped repKey
// so Brian cannot read James's schedule (and vice versa).
function shiftDayScope(req, _res, next) {
  if (req.user?.layer === 'rep') {
    const mine = shiftRepByEmail(req.user.email);
    if (mine) {
      if (req.query) req.query.rep = mine.repKey;
      if (req.body) req.body.repKey = mine.repKey;
      if (req.params && 'repKey' in req.params) req.params.repKey = mine.repKey;
    }
  }
  next();
}

function masterRouteContextForStore(storeNum) {
  const rep = getRep('__D8_CENTRAL_PET__');
  const slots = (rep?.visitSlots || []).filter((s) => Number(s.storeNum) === Number(storeNum));
  return {
    storeNum: Number(storeNum),
    slots: slots.map((s) => ({
      visitIndex: s.visitIndex,
      action: s.action,
      anchorServiceDay: s.anchorServiceDay,
      pickDay: s.pickDay,
      deliveryDay: s.deliveryDay,
      allowedDays: s.allowedDays,
      reason: s.reason,
    })),
  };
}

router.get('/shift-day/reps', (_req, res) => {
  res.json(loadD8ShiftReps());
});

router.get('/shift-day/weeks', (_req, res) => {
  const fiscal = listWeeks();
  const ingested = new Set(listWeekKeys());
  res.json(
    fiscal.map((w) => {
      const stored = getWeekSchedule(w.start);
      return {
        ...w,
        hasSchedule: ingested.has(w.start),
        source: stored?.source || null,
        matchStale: !!stored?.matchStale,
        lastSyncedAt: stored?.lastSyncedAt || null,
        lastMatchedAt: stored?.lastMatchedAt || null,
        shiftCount: stored?.shifts?.length ?? 0,
      };
    })
  );
});

router.get('/shift-day/schedule', shiftDayScope, (req, res) => {
  const repKey = req.query.rep;
  const weekStart = req.query.weekStart;
  if (!repKey) return res.status(400).json({ error: 'rep required' });
  if (!weekStart) return res.status(400).json({ error: 'weekStart required' });
  const shiftRep = shiftRepByKey(repKey);
  if (!shiftRep) return res.status(404).json({ error: 'Unknown Shift Day rep' });
  const week = getWeekByStart(weekStart);
  if (!week) return res.status(400).json({ error: 'Unknown week' });

  const shifts = getShiftsForRep(weekStart, repKey).map((s) => {
    const addr = getStoreAddress(s.actualStore);
    const ctx = masterRouteContextForStore(s.actualStore);
    const day = s.dayOfWeek || dateToDayOfWeek(s.date);
    const slot =
      ctx.slots.find((x) => x.anchorServiceDay === day) ||
      ctx.slots[0] ||
      null;
    return {
      ...s,
      dayOfWeek: day,
      store: addr,
      allowedDays: slot?.allowedDays || WORK_DAYS_FALLBACK(),
      masterRoute: ctx,
    };
  });

  const stored = getWeekSchedule(weekStart);
  res.json({
    rep: shiftRep,
    week,
    shifts,
    source: stored?.source || null,
    matchStale: !!stored?.matchStale,
    lastSyncedAt: stored?.lastSyncedAt || null,
    lastMatchedAt: stored?.lastMatchedAt || null,
    lastSyncedFrom: stored?.lastSyncedFrom || null,
  });
});

function WORK_DAYS_FALLBACK() {
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
}

router.post('/shift-day/move', shiftDayScope, async (req, res) => {
  const { repKey, weekStart, shiftId, dayOfWeek, pushToProd = false, dryRun = true } = req.body || {};
  if (!repKey || !weekStart || !shiftId || !dayOfWeek) {
    return res.status(400).json({ error: 'repKey, weekStart, shiftId, dayOfWeek required' });
  }
  // Only admins may push schedule mutations to PROD
  if (pushToProd && req.user?.layer !== 'admin') {
    return res.status(403).json({ error: 'Admin required to push schedule changes to PROD' });
  }
  const shiftRep = shiftRepByKey(repKey);
  if (!shiftRep) return res.status(404).json({ error: 'Unknown Shift Day rep' });
  const week = getWeekByStart(weekStart);
  if (!week) return res.status(400).json({ error: 'Unknown week' });

  const existing = getShiftsForRep(weekStart, repKey).find((s) => String(s.id) === String(shiftId));
  if (!existing) return res.status(404).json({ error: 'Shift not found' });

  const ctx = masterRouteContextForStore(existing.actualStore);
  const allowed = new Set(
    (ctx.slots[0]?.allowedDays || WORK_DAYS_FALLBACK()).map(String)
  );
  if (!allowed.has(dayOfWeek)) {
    return res.status(400).json({
      error: `Store ${existing.actualStore} can't go on ${dayOfWeek}`,
      allowedDays: [...allowed],
    });
  }

  const scheduledDate = dayToDateInWeek(weekStart, dayOfWeek);
  const updated = updateShiftDay(weekStart, shiftId, dayOfWeek, scheduledDate);

  if (!pushToProd) {
    return res.json({ ok: true, shift: updated, prod: null });
  }

  try {
    const prod = await pushWeekDayMovesToProd({
      weekStart,
      shiftIds: [shiftId],
      dryRun: dryRun !== false && dryRun !== 'false' && dryRun !== 0,
    });
    return res.json({ ok: prod.ok, shift: updated, prod });
  } catch (err) {
    return res.status(502).json({
      error: err.message,
      shift: updated,
      code: err.code,
    });
  }
});

/**
 * Admin: preview or apply local day-moves that differ from PROD visit dates.
 * Body: { weekStart, shiftIds?, dryRun? }
 * Live requires LIVE_SCHEDULE_WRITE=1.
 */
router.post('/shift-day/push-schedule-to-prod', requireAdmin, async (req, res) => {
  const weekStart = req.body?.weekStart || req.query.weekStart;
  const shiftIds = req.body?.shiftIds || null;
  const dryRun = req.body?.dryRun !== false && req.body?.dryRun !== 'false' && req.body?.dryRun !== 0;
  if (!weekStart) return res.status(400).json({ error: 'weekStart required' });
  try {
    const result = await pushWeekDayMovesToProd({ weekStart, shiftIds, dryRun });
    result.requestedBy = req.user?.email || null;
    result.liveScheduleWrite = isLiveScheduleWriteEnabled();
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message, code: err.code });
  }
});

/**
 * Admin: reschedule one PROD visit by id (copy+delete pattern).
 * Body: { visitId, toDate, dryRun? }
 */
router.post('/shift-day/reschedule-visit', requireAdmin, async (req, res) => {
  const visitId = req.body?.visitId;
  const toDate = req.body?.toDate;
  const dryRun = req.body?.dryRun !== false && req.body?.dryRun !== 'false' && req.body?.dryRun !== 0;
  if (!visitId || !toDate) return res.status(400).json({ error: 'visitId and toDate required' });
  try {
    const result = await rescheduleVisitDay({ visitId, toDate, dryRun });
    result.requestedBy = req.user?.email || null;
    result.liveScheduleWrite = isLiveScheduleWriteEnabled();
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(502).json({ error: err.message, code: err.code });
  }
});

router.get('/shift-day/schedule-write-status', requireAdmin, (_req, res) => {
  res.json({
    liveScheduleWrite: isLiveScheduleWriteEnabled(),
    liveTransmit: process.env.LIVE_TRANSMIT === '1',
    note:
      'Day-moves to PROD use copy-visit + soft-delete (SAS ignores scheduled_date PATCH). Requires LIVE_SCHEDULE_WRITE=1.',
  });
});

router.get('/shift-day/match', requireAdmin, async (req, res) => {
  const weekStart = req.query.weekStart;
  const supervisorId = req.query.supervisorId;
  if (!weekStart) return res.status(400).json({ error: 'weekStart required' });
  if (!supervisorId) return res.status(400).json({ error: 'supervisorId required' });
  const week = getWeekByStart(weekStart);
  if (!week) return res.status(400).json({ error: 'Unknown week' });
  try {
    const result = await matchVisits({
      startDate: week.start,
      endDate: week.end,
      weekStart: week.start,
      supervisorId,
    });
    setWeekMatchCache(week.start, result.summary);
    const stored = getWeekSchedule(week.start);
    res.json({
      week,
      summary: result.summary,
      matchStale: false,
      lastMatchedAt: stored?.lastMatchedAt || null,
      unmatched: result.unmatched,
      ambiguous: result.ambiguous,
      orphaned: result.orphaned,
      matched: result.matched.map((m) => ({
        status: m.status,
        appShiftId: m.appShift.id,
        visitId: m.prodVisit.visitId,
        repKey: m.appShift.repKey,
        date: m.appShift.date,
        actualStore: m.appShift.actualStore,
        scheduledStore: m.prodVisit.scheduledStore,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/shift-day/match-status', shiftDayScope, async (req, res) => {
  const repKey = req.query.rep;
  const weekStart = req.query.weekStart;
  const supervisorId = req.query.supervisorId;
  if (!repKey || !weekStart) {
    return res.status(400).json({ error: 'rep and weekStart required' });
  }
  if (!supervisorId) {
    return res.status(400).json({ error: 'supervisorId required for live match' });
  }
  const week = getWeekByStart(weekStart);
  if (!week) return res.status(400).json({ error: 'Unknown week' });
  try {
    const appShifts = getShiftsForRep(weekStart, repKey);
    const result = await matchVisits({
      startDate: week.start,
      endDate: week.end,
      weekStart: week.start,
      supervisorId,
      appShifts,
    });
    const byShift = {};
    for (const s of appShifts) {
      const st = statusForShift(result, s.id);
      // Prefer live match visitStatus; fall back to last PROD sync on the shift
      byShift[s.id] = {
        ...st,
        visitStatus: st.visitStatus || s.visitStatus || null,
      };
    }
    res.json({ week, byShift, summary: result.summary });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/shift-day/ingest', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file?.buffer) return res.status(400).json({ error: 'file required' });
  const weekStart = req.body?.weekStart || req.query.weekStart;
  if (!weekStart) return res.status(400).json({ error: 'weekStart required' });
  const week = getWeekByStart(weekStart);
  if (!week) return res.status(400).json({ error: 'Unknown week' });
  try {
    const parsed = await parseScheduleExport(req.file.buffer, {
      sourceFile: req.file.originalname,
    });
    const inWeek = parsed.shifts.filter(
      (s) => s.date && s.date >= week.start && s.date <= week.end
    );
    for (const s of inWeek) {
      s.dayOfWeek = dateToDayOfWeek(s.date);
    }
    const saved = saveWeekSchedule(weekStart, {
      weekEnd: week.end,
      weekLabel: week.label,
      source: req.file.originalname,
      meta: parsed.meta,
      flags: parsed.flags,
      shifts: inWeek,
      matchStale: true,
      matchStaleReason: 'xlsx_ingest',
    });
    res.json({
      ok: true,
      week,
      shiftCount: inWeek.length,
      flagCount: parsed.flags.length,
      flags: parsed.flags,
      matchStale: true,
      updatedAt: saved.updatedAt,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Resync week board from SAS PROD (project-cycles + field-data + note decode).
 * Available to **every signed-in user (reps + admin)** so field staff can pull
 * the freshest cycle data before/during a visit day.
 * Does not mutate team-scheduling — read → local store only.
 * Field completion writes remain dry-run → LIVE_TRANSMIT path.
 */
function resolveSupervisorId(req) {
  return (
    req.body?.supervisorId ||
    req.query.supervisorId ||
    process.env.SAS_SUPERVISOR_ID ||
    process.env.CP_SCHEDULER_SUPERVISOR_ID ||
    '800175315'
  );
}

/**
 * SAS morning-auth status for the app (no secrets).
 * Any signed-in user — beacon polls this; surfaces bridge/session health.
 */
router.get('/shift-day/sas-status', async (_req, res) => {
  const status = await getSasSessionStatus();
  res.status(status.ok ? 200 : 503).json(status);
});

/**
 * Force-refresh SAS PROD auth via eod-api in-process auto-refresh, then re-probe.
 * Any signed-in user (same policy as eod-api /api/trigger-auth).
 * Body/query: { force?: boolean } default true.
 */
router.post('/shift-day/sas-refresh', async (req, res) => {
  const force =
    req.query.force === '1' ||
    req.query.force === 'true' ||
    req.body?.force === true ||
    req.body?.force === 1 ||
    req.query.force == null; // default force on

  const base = eodApiBase();
  const userAuth = req.headers.authorization || '';
  let trigger = null;

  try {
    const r = await fetch(`${base}/api/trigger-auth?force=${force ? '1' : '0'}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(userAuth ? { Authorization: userAuth } : {}),
      },
      signal: AbortSignal.timeout(Number(process.env.SAS_REFRESH_TIMEOUT_MS) || 90000),
    });
    let body = null;
    try {
      body = await r.json();
    } catch {
      body = { error: r.statusText };
    }
    trigger = {
      ok: r.ok && body?.success !== false,
      status: r.status,
      message: body?.message || body?.error || null,
      skipped: !!body?.skipped,
      reason: body?.reason || null,
      elapsed_ms: body?.elapsed_ms || null,
    };
  } catch (err) {
    trigger = {
      ok: false,
      status: 0,
      message: err.message || 'Failed to reach eod-api trigger-auth',
    };
  }

  // Give eod-api a moment to install the minted session before we pull it.
  await new Promise((r) => setTimeout(r, trigger?.ok ? 1200 : 400));

  // Clear any cached assumptions by re-loading; status never returns secrets.
  let pull = null;
  try {
    const session = await loadSasSession();
    pull = {
      ok: true,
      source: session.source,
      generatedAt: session.generatedAt,
      hasToken: !!session.token,
    };
  } catch (err) {
    pull = {
      ok: false,
      code: err.code || 'sas_session_unavailable',
      error: err.message,
    };
  }

  const status = await getSasSessionStatus();
  const http = status.ok ? 200 : trigger?.ok ? 202 : 503;
  res.status(http).json({
    status,
    trigger,
    pull,
    refreshedAt: new Date().toISOString(),
  });
});

router.post('/shift-day/sync-from-prod', async (req, res) => {
  const weekStart = req.body?.weekStart || req.query.weekStart;
  const supervisorId = resolveSupervisorId(req);
  if (!weekStart) return res.status(400).json({ error: 'weekStart required' });
  if (!supervisorId) return res.status(400).json({ error: 'supervisorId required' });
  try {
    const result = await syncWeekFromProd({ weekStart, supervisorId });
    // Fresh match cache for the week so visit pills stay accurate after resync
    try {
      const week = getWeekByStart(weekStart);
      if (week) {
        const match = await matchVisits({
          startDate: week.start,
          endDate: week.end,
          weekStart: week.start,
          supervisorId,
        });
        setWeekMatchCache(week.start, match.summary);
        result.matchSummary = match.summary;
      }
    } catch (matchErr) {
      result.matchError = matchErr.message;
    }
    result.requestedBy = req.user?.email || null;
    res.json(result);
  } catch (err) {
    const code = err.code || (err instanceof SasSessionError ? err.code : null);
    const message =
      code === 'sas_session_stale' || /sas_session_stale|session stale/i.test(err.message || '')
        ? `SAS session stale — run morning auth / wait for eod-api refresh. ${err.message}`
        : code === 'sas_session_unavailable' || /sas_session_unavailable|No sas-auth session/i.test(err.message || '')
          ? `SAS session unavailable — ${err.message}`
          : err.message;
    res.status(502).json({ error: message, code: code || undefined });
  }
});

/* ---------- Stage 3: guided visit flow (local-only, no SAS writes) ---------- */

function findShift(repKey, weekStart, shiftId) {
  return getShiftsForRep(weekStart, repKey).find((s) => String(s.id) === String(shiftId)) || null;
}

router.get('/shift-day/visit-flow/scope-checklist', (_req, res) => {
  res.json(visitFlow.scopeChecklist);
});

router.get('/shift-day/visit-flow/survey', (_req, res) => {
  res.json(visitFlow.serviceSurvey);
});

router.get('/shift-day/visit-flow/category-targets', (_req, res) => {
  res.json(visitFlow.CATEGORY_PHOTO_TARGETS);
});

router.post('/shift-day/visit/start', shiftDayScope, (req, res) => {
  const { repKey, weekStart, shiftId, startedAt } = req.body || {};
  if (!repKey || !weekStart || !shiftId) {
    return res.status(400).json({ error: 'repKey, weekStart, shiftId required' });
  }
  const shift = findShift(repKey, weekStart, shiftId);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  try {
    const draft = visitDraftStore.startVisit({
      repKey,
      weekStart,
      shiftId,
      date: shift.date,
      actualStore: shift.actualStore,
      scheduledStore: shift.scheduledStore,
      writeOrder: !!shift.writeOrder,
      workLoad: !!shift.workLoad,
      picksDay: shift.picksDay,
      startedAt: startedAt || undefined,
      startedBy: req.user?.email || null,
    });
    res.json(visitDraftStore.enrichDraftForUi(draft));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/shift-day/visit', shiftDayScope, (req, res) => {
  const { rep, date, store } = req.query;
  if (!rep || !date || store == null) {
    return res.status(400).json({ error: 'rep, date, store required' });
  }
  const draft = visitDraftStore.getDraft(rep, date, store);
  if (!draft) return res.status(404).json({ error: 'No draft for this rep/date/store' });
  res.json(visitDraftStore.enrichDraftForUi(draft));
});

router.get('/shift-day/visit/mine', shiftDayScope, (req, res) => {
  const { rep } = req.query;
  if (!rep) return res.status(400).json({ error: 'rep required' });
  res.json(visitDraftStore.listDraftsForRep(rep).map(visitDraftStore.summarize));
});

router.get('/shift-day/visit/drafts', requireAdmin, (_req, res) => {
  res.json(visitDraftStore.listAllDrafts());
});

function draftMutationHandler(fn) {
  return (req, res) => {
    const { repKey, date, actualStore } = req.body || {};
    if (!repKey || !date || actualStore == null) {
      return res.status(400).json({ error: 'repKey, date, actualStore required' });
    }
    try {
      const draft = fn(repKey, date, actualStore, req.body || {});
      res.json(visitDraftStore.enrichDraftForUi(draft));
    } catch (err) {
      if (err.code === 'SEAL_BLOCKED') {
        return res.status(400).json({ error: err.message, code: err.code, unmet: err.unmet || [] });
      }
      res.status(400).json({ error: err.message });
    }
  };
}

router.post(
  '/shift-day/visit/photo',
  upload.single('file'),
  shiftDayScope,
  (req, res) => {
    const { repKey, date, actualStore, target, categoryId, itemId } = req.body || {};
    if (!repKey || !date || actualStore == null || !target) {
      return res.status(400).json({ error: 'repKey, date, actualStore, target required' });
    }
    if (!req.file?.buffer) return res.status(400).json({ error: 'file required' });
    const ext = (req.file.originalname || 'photo.jpg').split('.').pop() || 'jpg';
    try {
      const photoPath = visitDraftStore.savePhotoBuffer(repKey, date, actualStore, req.file.buffer, ext);
      let draft;
      if (target === 'before') {
        draft = visitDraftStore.recordBeforePhoto(repKey, date, actualStore, { photoPath });
      } else if (target === 'after') {
        draft = visitDraftStore.recordAfterPhoto(repKey, date, actualStore, { photoPath });
      } else if (target === 'load') {
        draft = visitDraftStore.setLoadCheck(repKey, date, actualStore, {
          status: req.body.status || 'yes',
          photoPath,
        });
      } else if (target === 'category') {
        if (!categoryId) return res.status(400).json({ error: 'categoryId required for category photo' });
        draft = visitDraftStore.recordCategoryPhoto(repKey, date, actualStore, categoryId, { photoPath });
      } else if (target === 'checklist') {
        if (!itemId) return res.status(400).json({ error: 'itemId required for checklist photo' });
        draft = visitDraftStore.recordChecklistPhoto(repKey, date, actualStore, itemId, { photoPath });
      } else {
        return res.status(400).json({ error: `Unknown photo target: ${target}` });
      }
      res.json(visitDraftStore.enrichDraftForUi(draft));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

router.post(
  '/shift-day/visit/photo/remove',
  shiftDayScope,
  draftMutationHandler((repKey, date, actualStore, body) => {
    if (body.target === 'before') {
      return visitDraftStore.removeBeforePhoto(repKey, date, actualStore, { seq: body.seq });
    }
    if (body.target === 'after') {
      return visitDraftStore.removeAfterPhoto(repKey, date, actualStore, { seq: body.seq });
    }
    throw new Error(`Unknown photo remove target: ${body.target}`);
  })
);

router.post(
  '/shift-day/visit/load-check',
  shiftDayScope,
  draftMutationHandler((repKey, date, actualStore, body) =>
    visitDraftStore.setLoadCheck(repKey, date, actualStore, { status: body.status })
  )
);

router.post(
  '/shift-day/visit/checklist',
  shiftDayScope,
  draftMutationHandler((repKey, date, actualStore, body) =>
    visitDraftStore.setChecklistItem(repKey, date, actualStore, body.itemId, { checked: body.checked })
  )
);

router.post(
  '/shift-day/visit/survey',
  shiftDayScope,
  draftMutationHandler((repKey, date, actualStore, body) =>
    visitDraftStore.setSurveyAnswers(repKey, date, actualStore, body.answers || {})
  )
);

router.post(
  '/shift-day/visit/time',
  shiftDayScope,
  draftMutationHandler((repKey, date, actualStore, body) =>
    visitDraftStore.setTimes(repKey, date, actualStore, {
      startActual: body.startActual,
      startNote: body.startNote,
      stopActual: body.stopActual,
      stopNote: body.stopNote,
      isLastStopOfDay: body.isLastStopOfDay,
    })
  )
);

router.post('/shift-day/visit/mileage', shiftDayScope, (req, res) => {
  const { repKey, date, actualStore, repNote } = req.body || {};
  if (!repKey || !date || actualStore == null) {
    return res.status(400).json({ error: 'repKey, date, actualStore required' });
  }
  const shiftRep = shiftRepByKey(repKey);
  if (!shiftRep) return res.status(404).json({ error: 'Unknown Shift Day rep' });
  const draft = visitDraftStore.getDraft(repKey, date, actualStore);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  try {
    let leg;
    if (draft.isLastStopOfDay) {
      leg = visitFlow.computeMileageLeg({
        workdayGivenId: shiftRep.workdayGivenId,
        actualStore,
        isLastStopOfDay: true,
      });
    } else {
      const previousCompletedStore = visitDraftStore.previousCompletedStoreForDay(repKey, date, {
        excludeActualStore: actualStore,
        beforeIso: draft.visitStart?.actual || null,
      });
      leg = visitFlow.computeMileageLeg({
        workdayGivenId: shiftRep.workdayGivenId,
        actualStore,
        previousCompletedStore,
      });
    }
    const updated = visitDraftStore.setMileage(repKey, date, actualStore, {
      leg,
      ...(repNote !== undefined ? { repNote } : {}),
    });
    res.json(visitDraftStore.enrichDraftForUi(updated));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post(
  '/shift-day/visit/step',
  shiftDayScope,
  draftMutationHandler((repKey, date, actualStore, body) =>
    visitDraftStore.goToStep(repKey, date, actualStore, body.step)
  )
);

/**
 * POST /shift-day/visit/abandon
 * Discard an in-progress local visit draft (wrong day, accidental start).
 * Cannot abandon sealed visits.
 */
router.post('/shift-day/visit/abandon', shiftDayScope, (req, res) => {
  const { repKey, date, actualStore } = req.body || {};
  if (!repKey || !date || actualStore == null) {
    return res.status(400).json({ error: 'repKey, date, actualStore required' });
  }
  try {
    const result = visitDraftStore.abandonVisit(repKey, date, actualStore);
    res.json(result);
  } catch (err) {
    const status = err.code === 'SEALED' ? 409 : err.code === 'NO_DRAFT' ? 404 : 400;
    res.status(status).json({ error: err.message, code: err.code || null });
  }
});

router.post(
  '/shift-day/visit/finish',
  shiftDayScope,
  draftMutationHandler((repKey, date, actualStore) =>
    visitDraftStore.finishVisit(repKey, date, actualStore)
  )
);

/* ---------- Stage 4: prod overlay dry run (Planning Desk) ----------
 * runDryRun()/transmitVisit() only ever perform read-only GETs against prod
 * to resolve ids/enums for assembly; nothing is written from those paths.
 * Live writes require LIVE_TRANSMIT=1 + per-draft allowlist + two-tap arm. */

router.get('/shift-day/dryrun', requireAdmin, (_req, res) => {
  res.json({ runs: dryrunStore.listRuns() });
});

router.post('/shift-day/dryrun', requireAdmin, async (req, res) => {
  const { weekStart, startDate, endDate, supervisorId, repKeys, timeChangeComment } = req.body || {};
  if (!supervisorId) return res.status(400).json({ error: 'supervisorId required' });
  const week = weekStart ? getWeekByStart(weekStart) : null;
  const effectiveStart = startDate || week?.start;
  const effectiveEnd = endDate || week?.end;
  if (!effectiveStart || !effectiveEnd) {
    return res.status(400).json({ error: 'weekStart (or startDate+endDate) required' });
  }
  if (!timeChangeComment) {
    return res.status(400).json({ error: 'timeChangeComment required — never defaults to a placeholder' });
  }
  try {
    const manifest = await runDryRun({
      startDate: effectiveStart,
      endDate: effectiveEnd,
      weekStart: weekStart || effectiveStart,
      supervisorId,
      repKeys: Array.isArray(repKeys) && repKeys.length ? repKeys : null,
      transmitOpts: {
        timeChangeComment,
        isAlreadyTransmitted: (visitId) => liveRegistry.isAlreadyTransmittedVisitId(visitId),
      },
    });
    res.json(manifest);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/shift-day/dryrun/:runId', requireAdmin, (req, res) => {
  const manifest = dryrunStore.readManifest(req.params.runId);
  if (!manifest) return res.status(404).json({ error: 'Run not found' });
  res.json(manifest);
});

router.get('/shift-day/dryrun/:runId/:file', requireAdmin, (req, res) => {
  const data = dryrunStore.readVisitFile(req.params.runId, req.params.file);
  if (!data) return res.status(404).json({ error: 'File not found' });
  res.json(data);
});

/* ---------- Stage 4 live transmit (gated) ---------- */

router.get('/shift-day/live/status', requireAdmin, (_req, res) => {
  const allowlist = loadAllowlist();
  res.json({
    liveTransmitEnabled: isLiveTransmitEnabled(),
    allowlistCount: allowlist.draftIds.length,
    draftIds: allowlist.draftIds,
  });
});

/**
 * POST /shift-day/live/transmit
 * Body: {
 *   dryRunId, visitFile, confirmStore, mode?: 'start'|'resume', draftId?,
 *   testMode?: boolean, goldenExportPath?: string, postExportPath?: string
 * }
 * testMode requires goldenExportPath (export-cp-shift-full folder, allChecksPassed).
 * 403 if LIVE_TRANSMIT off or draft not allowlisted.
 * Two-tap arm: confirmStore must equal the assembled actualStore.
 */
router.post('/shift-day/live/transmit', requireAdmin, async (req, res) => {
  if (!isLiveTransmitEnabled()) {
    return res.status(403).json({ error: 'LIVE_TRANSMIT is disabled', code: 'live_transmit_disabled' });
  }

  const {
    dryRunId,
    visitFile,
    confirmStore,
    mode = 'start',
    draftId: bodyDraftId,
    testMode = false,
    goldenExportPath = null,
    postExportPath = null,
  } = req.body || {};
  if (!dryRunId || !visitFile) {
    return res.status(400).json({ error: 'dryRunId and visitFile required' });
  }
  if (confirmStore == null || confirmStore === '') {
    return res.status(400).json({ error: 'confirmStore required (type the store number to arm)' });
  }
  if (testMode && !goldenExportPath) {
    return res.status(400).json({
      error: 'testMode requires goldenExportPath (export-cp-shift-full folder with allChecksPassed)',
      code: 'golden_export_required',
    });
  }

  const assembled = dryrunStore.readVisitFile(dryRunId, visitFile);
  if (!assembled) return res.status(404).json({ error: 'Assembled visit file not found' });

  const draftId = bodyDraftId || draftIdFromParts(assembled.repKey, assembled.date, assembled.actualStore);
  if (!isDraftAllowlisted(draftId)) {
    return res.status(403).json({
      error: `Draft ${draftId} is not on the live allowlist`,
      code: 'not_allowlisted',
      draftId,
    });
  }

  try {
    const result = await executeLiveTransmit({
      dryRunId,
      visitFile,
      draftId,
      confirmStore,
      mode: mode === 'resume' ? 'resume' : 'start',
      testMode: !!testMode,
      goldenExportPath,
      postExportPath,
    });

    if (result.abortReason === 'live_transmit_disabled' || result.abortReason === 'not_allowlisted') {
      return res.status(403).json(result);
    }
    if (result.abortReason === 'golden_export_required') {
      return res.status(400).json(result);
    }
    if (result.status === 'complete') {
      return res.json(result);
    }
    if (result.abortReason === 'preflight_failed') {
      return res.status(409).json(result);
    }
    if (result.status === 'partial') {
      return res.status(409).json(result);
    }
    return res.status(400).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /shift-day/live/roundtrip-diff
 * After re-export, compare golden vs post-run export folders.
 * Body: { dryRunId, visitFile?, goldenExportPath, postExportPath, draftId?, visitId? }
 */
router.post('/shift-day/live/roundtrip-diff', requireAdmin, (req, res) => {
  const { dryRunId, visitFile, goldenExportPath, postExportPath, draftId, visitId } = req.body || {};
  if (!dryRunId || !goldenExportPath || !postExportPath) {
    return res.status(400).json({
      error: 'dryRunId, goldenExportPath, and postExportPath required',
    });
  }
  let transmittedCalls = [];
  if (visitFile) {
    const assembled = dryrunStore.readVisitFile(dryRunId, visitFile);
    transmittedCalls = assembled?.calls || [];
  }
  try {
    const roundtrip = runRoundtripDiff({
      dryRunId,
      goldenExportPath,
      postExportPath,
      transmittedCalls,
      visitId: visitId || null,
      draftId: draftId || null,
    });
    res.json(roundtrip);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/shift-day/live/state/:dryRunId/:file', requireAdmin, (req, res) => {
  const state = liveStore.readExecutorState(req.params.dryRunId, req.params.file);
  const log = liveStore.readExecutionLog(req.params.dryRunId, req.params.file);
  const assembled = dryrunStore.readVisitFile(req.params.dryRunId, req.params.file);
  const draftId = assembled
    ? draftIdFromParts(assembled.repKey, assembled.date, assembled.actualStore)
    : null;
  const registry = draftId ? liveRegistry.getTransmitRecord(draftId) : null;
  res.json({ state, log, registry, draftId, liveTransmitEnabled: isLiveTransmitEnabled() });
});

/* ---------- Stage 5: photo delivery (admin only, Resend gated) ---------- */

router.get('/shift-day/photo-delivery/status', requireAdmin, (_req, res) => {
  res.json({
    enabled: isPhotoDeliveryEnabled(),
    trigger: 'event-driven',
    note:
      'Sends fire only after a completed LIVE transmit or explicit admin re-send. ' +
      'No boot/startup scan of historical transmitted visits. Code default is off; Railway may set PHOTO_DELIVERY_ENABLED=1.',
  });
});

/**
 * GET /shift-day/photo-delivery?rep=&date=&store=
 * Per-visit photo delivery inventory + last run state.
 */
router.get('/shift-day/photo-delivery', requireAdmin, (req, res) => {
  const { rep, date, store } = req.query;
  if (!rep || !date || store == null || store === '') {
    return res.status(400).json({ error: 'rep, date, and store required' });
  }
  const draft = visitDraftStore.getDraft(rep, date, store);
  if (!draft) return res.status(404).json({ error: 'Visit draft not found' });
  res.json({
    draftId: draft.id,
    status: draft.status,
    delivery: getDeliveryStatus(draft),
  });
});

/**
 * POST /shift-day/photo-delivery/send
 * Body: { rep, date, store, onlyFailed?: boolean }
 * Inventories photos and attempts Resend when PHOTO_DELIVERY_ENABLED=1.
 */
router.post('/shift-day/photo-delivery/send', requireAdmin, async (req, res) => {
  const { rep, date, store, onlyFailed = false } = req.body || {};
  if (!rep || !date || store == null || store === '') {
    return res.status(400).json({ error: 'rep, date, and store required' });
  }
  const draft = visitDraftStore.getDraft(rep, date, store);
  if (!draft) return res.status(404).json({ error: 'Visit draft not found' });

  try {
    const delivery = await deliverVisitPhotos({
      draft,
      existingDelivery: draft.photoDelivery || null,
      onlyFailed: !!onlyFailed,
    });
    visitDraftStore.setPhotoDelivery(rep, date, store, delivery);
    res.json({
      draftId: draft.id,
      delivery,
      enabled: isPhotoDeliveryEnabled(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /shift-day/photo-delivery/resend-failed
 * Body: { rep, date, store }
 * Re-sends only failed (and still-pending) photos; keeps sent entries.
 */
router.post('/shift-day/photo-delivery/resend-failed', requireAdmin, async (req, res) => {
  const { rep, date, store } = req.body || {};
  if (!rep || !date || store == null || store === '') {
    return res.status(400).json({ error: 'rep, date, and store required' });
  }
  const draft = visitDraftStore.getDraft(rep, date, store);
  if (!draft) return res.status(404).json({ error: 'Visit draft not found' });

  try {
    const delivery = await deliverVisitPhotos({
      draft,
      existingDelivery: draft.photoDelivery || null,
      onlyFailed: true,
    });
    visitDraftStore.setPhotoDelivery(rep, date, store, delivery);
    res.json({
      draftId: draft.id,
      delivery,
      enabled: isPhotoDeliveryEnabled(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
