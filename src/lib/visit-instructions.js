'use strict';

const { WORK_DAYS } = require('./constants');

function visitTypeLabel(slot) {
  const hasPick = !!slot.pickDay;
  const hasDelivery = !!slot.deliveryDay;
  if (!hasPick && !hasDelivery && (slot.visitIndex ?? 0) > 0) {
    return 'Follow-up visit (work load only)';
  }
  if (hasPick && hasDelivery) {
    return 'Full service visit (pick + delivery window)';
  }
  return 'Single service visit';
}

function schedulingRule(slot) {
  const allowed = (slot.allowedDays || []).join(', ') || 'Mon–Fri';
  const hasPick = !!slot.pickDay;
  const hasDelivery = !!slot.deliveryDay;

  if (!hasPick && !hasDelivery && (slot.visitIndex ?? 0) > 0) {
    return `Schedule on ${allowed}. Anchor day is ${slot.anchorServiceDay}; this is the lighter follow-up stop for the week.`;
  }
  if (hasPick && hasDelivery) {
    return `Must fall between prior delivery (${slot.deliveryDay || '—'}) and pick (${slot.pickDay}). Allowed days: ${allowed}.`;
  }
  return `Anchor service day is ${slot.anchorServiceDay}. Allowed days this week: ${allowed}.`;
}

function shiftExpectations(placement) {
  const start = placement?.shiftStart || '06:00';
  const end = placement?.shiftEnd || '14:30';
  return `Lead shift ${start}–${end} (~${placement?.estimatedHours ?? 8}h). Complete the store action below, then sign out in SAS when finished.`;
}

const { loadD8Assignees } = require('./master-route');

function proposedAssigneeNote(isD8Pool, placement) {
  if (!isD8Pool) return null;
  if (placement?.proposedAssignee) {
    return `Proposed for ${placement.proposedAssignee} (planning label only — not notified).`;
  }
  const names = (loadD8Assignees().proposedAssignees || []).map((a) => a.name);
  const list = names.length ? names.join(', ') : 'a proposed assignee';
  return `Choose a proposed D8 assignee: ${list}.`;
}

function buildVisitBrief(slot, placement, { isD8Pool = false } = {}) {
  const lines = [];
  lines.push(visitTypeLabel(slot));
  if (slot.action) lines.push(`Do: ${slot.action}`);
  lines.push(schedulingRule(slot));
  lines.push(shiftExpectations(placement));
  const assignee = proposedAssigneeNote(isD8Pool, placement);
  if (assignee) lines.push(assignee);
  return lines;
}

function buildVisitDetail(slot, placement, { isD8Pool = false } = {}) {
  const brief = buildVisitBrief(slot, placement, { isD8Pool });
  return {
    storeNum: slot.storeNum,
    account: slot.account || placement?.account || '',
    visitIndex: slot.visitIndex ?? 0,
    visitType: visitTypeLabel(slot),
    action: slot.action || '',
    anchorServiceDay: slot.anchorServiceDay,
    pickDay: slot.pickDay || null,
    deliveryDay: slot.deliveryDay || null,
    allowedDays: slot.allowedDays || [...WORK_DAYS],
    scheduledDay: placement?.dayOfWeek || null,
    scheduledDate: placement?.scheduledDate || null,
    shiftStart: placement?.shiftStart || '06:00',
    shiftEnd: placement?.shiftEnd || '14:30',
    proposedAssignee: placement?.proposedAssignee || '',
    brief,
    checklist: [
      'Drag the visit to a valid day (highlighted columns accept drops).',
      isD8Pool ? 'Select who should take this D8 visit (proposed assignee).' : null,
      'Confirm pick/delivery timing matches the Master Route window.',
      'Save your week when the layout looks right.',
    ].filter(Boolean),
  };
}

function layerHelpText(layer) {
  if (layer === 'rep') {
    return [
      'Your job: place each store on the correct day and save your draft.',
      'Green-bordered days accept that visit; invalid drops are blocked.',
      'Click a visit card for full pick/delivery instructions.',
    ];
  }
  return [
    'Admin: build the week, optionally save as a weekly template, then approve for handoff.',
    'Rep view hides export/approve controls — reps only schedule and save drafts.',
    'D8 visits need a proposed assignee before approval.',
  ];
}

module.exports = {
  visitTypeLabel,
  schedulingRule,
  buildVisitBrief,
  buildVisitDetail,
  layerHelpText,
};
