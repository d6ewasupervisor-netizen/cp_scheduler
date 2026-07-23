'use strict';

/**
 * Order-timing / process-flag helpers shared by shift-day, prod sync, and visit start.
 * Keep semantics aligned with public/shared.js (isWriteOrderVisit / isWorkLoadVisit).
 *
 * Master-route slot actions are the planner source of truth when present — stale SAS
 * notes often say "WORK LOAD/WRITE ORDER" even for write-order-only or work-load-only days.
 */

function priorVisitDeliveryDay(slots, slot) {
  if (!slot || !slots?.length) return null;
  const idx = slot.visitIndex ?? 0;
  if (idx === 0) return slot.deliveryDay || null;
  const prev = slots.find(
    (s) => Number(s.storeNum) === Number(slot.storeNum) && (s.visitIndex ?? 0) === idx - 1
  );
  return prev?.deliveryDay || null;
}

/** Follow-up work-load visit: blank pick/delivery (and usually visitIndex > 0). */
function isWorkLoadVisit(slot) {
  if (!slot || slot.pickDay || slot.deliveryDay) return false;
  const action = (slot.action || '').toUpperCase();
  return action.includes('WORK LOAD') || (slot.visitIndex ?? 0) > 0;
}

/** Write-order visit: has a pick day and WRITE ORDER in the action. */
function isWriteOrderVisit(slot) {
  if (!slot?.pickDay) return false;
  const action = (slot.action || '').toUpperCase();
  return action.includes('WRITE ORDER') || action.includes('WORK LOAD/WRITE ORDER');
}

/**
 * Derive visit process flags from a master-route slot action.
 * Prefer this over decoded PROD notes when a matching slot exists.
 *
 * @returns {{ writeOrder: boolean, workLoad: boolean } | null}
 */
function processFlagsFromSlot(slot) {
  if (!slot) return null;
  const action = (slot.action || '').toUpperCase();
  const hasWrite = action.includes('WRITE ORDER');
  const hasLoad = action.includes('WORK LOAD');

  // Blank pick/delivery follow-ups are work-load only (never write order).
  if (!slot.pickDay && !slot.deliveryDay) {
    return {
      writeOrder: false,
      workLoad: hasLoad || (slot.visitIndex ?? 0) > 0,
    };
  }

  return {
    writeOrder: hasWrite,
    workLoad: hasLoad,
  };
}

/**
 * Pick the slot for a service day, then return process flags.
 * When a matching master-route slot exists, its action wins over note flags.
 *
 * @param {object} opts
 * @param {object[]} [opts.slots]
 * @param {string|null} [opts.dayOfWeek]
 * @param {boolean|null} [opts.writeOrder] - from notes / prior shift
 * @param {boolean|null} [opts.workLoad] - from notes / prior shift
 */
function resolveProcessFlags({
  slots = [],
  dayOfWeek = null,
  writeOrder = null,
  workLoad = null,
} = {}) {
  const slot =
    (dayOfWeek && slots.find((x) => x.anchorServiceDay === dayOfWeek)) || null;
  const fromSlot = processFlagsFromSlot(slot);
  if (fromSlot) {
    return {
      ...fromSlot,
      fromMasterRoute: true,
      slot,
    };
  }
  return {
    // Match prod-week-sync legacy: missing note flag defaults to write-order true.
    writeOrder: writeOrder !== false,
    workLoad: !!workLoad,
    fromMasterRoute: false,
    slot: null,
  };
}

function orderTimingLine(slot, slots) {
  if (!slot) return '';
  if (isWriteOrderVisit(slot)) {
    return `Order picks ${slot.pickDay}`;
  }
  if (isWorkLoadVisit(slot)) {
    const delivered = priorVisitDeliveryDay(slots, slot);
    if (delivered) return `Order delivered ${delivered}`;
  }
  return '';
}

module.exports = {
  priorVisitDeliveryDay,
  isWorkLoadVisit,
  isWriteOrderVisit,
  processFlagsFromSlot,
  resolveProcessFlags,
  orderTimingLine,
};
