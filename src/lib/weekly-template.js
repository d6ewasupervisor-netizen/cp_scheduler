'use strict';

const { dayToDateInWeek } = require('./fiscal-calendar');
const { defaultPlacementsForWeek } = require('./master-route');

function toTemplatePlacements(placements) {
  return placements.map((p) => {
    const row = {
      storeNum: p.storeNum,
      visitIndex: p.visitIndex ?? 0,
      dayOfWeek: p.dayOfWeek,
      account: p.account,
      action: p.action,
      shiftStart: p.shiftStart || '06:00',
      shiftEnd: p.shiftEnd || '14:30',
      estimatedHours: p.estimatedHours ?? 8,
      isLead: p.isLead ?? true,
    };
    if (p.proposedAssignee !== undefined) {
      row.proposedAssignee = p.proposedAssignee || '';
    }
    return row;
  });
}

function applyWeeklyTemplate(templatePlacements, rep, weekStart) {
  const templateByKey = new Map(
    templatePlacements.map((p) => [`${p.storeNum}:${p.visitIndex ?? 0}`, p])
  );

  return rep.visitSlots.map((slot) => {
    const key = `${slot.storeNum}:${slot.visitIndex ?? 0}`;
    const tpl = templateByKey.get(key);
    const dayOfWeek = tpl?.dayOfWeek || slot.anchorServiceDay;
    return {
      storeNum: slot.storeNum,
      visitIndex: slot.visitIndex,
      account: tpl?.account || slot.account,
      action: tpl?.action || slot.action,
      dayOfWeek,
      scheduledDate: dayToDateInWeek(weekStart, dayOfWeek),
      shiftStart: tpl?.shiftStart || '06:00',
      shiftEnd: tpl?.shiftEnd || '14:30',
      estimatedHours: tpl?.estimatedHours ?? 8,
      isLead: tpl?.isLead ?? true,
      proposedAssignee: rep.isD8Pool ? tpl?.proposedAssignee || '' : undefined,
    };
  });
}

function resolveInitialPlacements(rep, weekStart, weeklyTemplate) {
  if (weeklyTemplate?.placements?.length) {
    return {
      placements: applyWeeklyTemplate(weeklyTemplate.placements, rep, weekStart),
      source: 'weeklyTemplate',
      template: weeklyTemplate,
    };
  }
  return {
    placements: defaultPlacementsForWeek(rep, weekStart),
    source: 'masterRoute',
    template: null,
  };
}

module.exports = {
  toTemplatePlacements,
  applyWeeklyTemplate,
  resolveInitialPlacements,
};
