'use strict';

const { WORK_DAYS } = require('./constants');

function visitTypeLabel(slot) {
  const action = (slot.action || '').toUpperCase();
  const hasPick = !!slot.pickDay;
  const hasDelivery = !!slot.deliveryDay;
  if (!hasPick && !hasDelivery && (slot.visitIndex ?? 0) > 0) {
    return 'Follow-up visit (work load only — no write order)';
  }
  if (hasPick && hasLoadWriteOnly(action)) {
    return 'Write order visit (no work load)';
  }
  if (hasPick && hasDelivery && action.includes('WORK LOAD') && action.includes('WRITE ORDER')) {
    return 'Full service visit (work load + write order)';
  }
  if (hasPick && hasDelivery) {
    return 'Full service visit';
  }
  return 'Single service visit';
}

function hasLoadWriteOnly(action) {
  return action.includes('WRITE ORDER') && !action.includes('WORK LOAD');
}

function schedulingRule(slot) {
  const allowed = (slot.allowedDays || []).join(', ') || 'Mon–Fri';
  if (!slot.pickDay && !slot.deliveryDay && (slot.visitIndex ?? 0) > 0) {
    return `Place on one of: ${allowed}. Default day: ${slot.anchorServiceDay} (work prior delivery — do not write order).`;
  }
  if (hasLoadWriteOnly((slot.action || '').toUpperCase()) && slot.deliveryDay) {
    return `Place on one of: ${allowed}. Default day: ${slot.anchorServiceDay}. Order picks ${slot.pickDay}, delivers ${slot.deliveryDay} (one delivery/week).`;
  }
  return `Place on one of: ${allowed}. Default day: ${slot.anchorServiceDay}.`;
}

function fieldTimeNote() {
  return 'Most visits take about 1–2 hours on site.';
}

const { loadD8Assignees } = require('./master-route');
const { isCoverageNeeded, REP_AVAILABILITY_LABELS } = require('./rep-availability');

function proposedAssigneeNote(isD8Pool, placement) {
  if (!isD8Pool) return null;
  if (placement?.proposedAssignee) {
    return `Proposed for ${placement.proposedAssignee} (planning label only — not notified).`;
  }
  const names = (loadD8Assignees().proposedAssignees || []).map((a) => a.name);
  const list = names.length ? names.join(', ') : 'a proposed assignee';
  return `Choose a proposed D8 assignee: ${list}.`;
}

function repAvailabilityNote(allowsRepAvailability, placement) {
  if (!allowsRepAvailability) return null;
  if (isCoverageNeeded(placement)) {
    return 'Marked Not Available — supervisor must arrange coverage from someone else.';
  }
  return 'If you cannot work a visit, set availability to Not Available so coverage can be planned.';
}

function buildVisitBrief(slot, placement, { isD8Pool = false, allowsRepAvailability = false } = {}) {
  const lines = [];
  lines.push(visitTypeLabel(slot));
  if (slot.action) lines.push(`Do: ${slot.action}`);
  if (slot.cadence) lines.push(slot.cadence);
  lines.push(schedulingRule(slot));
  lines.push(fieldTimeNote());
  const assignee = proposedAssigneeNote(isD8Pool, placement);
  if (assignee) lines.push(assignee);
  const availability = repAvailabilityNote(allowsRepAvailability, placement);
  if (availability) lines.push(availability);
  return lines;
}

function buildVisitDetail(slot, placement, { isD8Pool = false, allowsRepAvailability = false } = {}) {
  const brief = buildVisitBrief(slot, placement, { isD8Pool, allowsRepAvailability });
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
    repAvailability: placement?.repAvailability || null,
    repAvailabilityLabel:
      REP_AVAILABILITY_LABELS[placement?.repAvailability] || REP_AVAILABILITY_LABELS.available,
    coverageNeeded: isCoverageNeeded(placement),
    brief,
    checklist: [
      'Place the visit on a valid day (green columns accept it).',
      isD8Pool ? 'Select who should take this D8 visit (proposed assignee).' : null,
      allowsRepAvailability
        ? 'If you cannot work a visit, choose Not Available so coverage can be planned.'
        : null,
      'Save your week when the layout looks right.',
    ].filter(Boolean),
  };
}

function layerHelpText(layer) {
  if (layer === 'rep') {
    return [
      'Your job: place each store on the correct day and save your draft.',
      'Green-bordered days accept that visit; invalid drops are blocked.',
      'Tap a visit card for store action and allowed-day details.',
    ];
  }
  return [
    'Admin: build the week, optionally save as a weekly template, then approve for handoff.',
    'Rep view hides export/approve controls — reps only schedule and save drafts.',
    'D8 visits need a proposed assignee before approval.',
    'D1 rep weeks may mark visits Not Available — those shifts need coverage from someone else.',
  ];
}

module.exports = {
  visitTypeLabel,
  schedulingRule,
  buildVisitBrief,
  buildVisitDetail,
  layerHelpText,
};
