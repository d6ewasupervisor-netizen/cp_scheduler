'use strict';

/**
 * Pure CSV formatting for the admin shift-log export. No I/O — trivially testable.
 * RFC-4180: fields containing comma, double-quote, CR or LF are wrapped in
 * double-quotes and internal double-quotes are doubled.
 */

function escapeCsvValue(value) {
  if (value == null) return '';
  let s = String(value);
  if (/[",\r\n]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * @param {Array<Object>} records
 * @param {Array<{key:string,label:string}>} columns
 * @returns {string} CSV text (header row + one row per record), CRLF line breaks.
 */
function toCsv(records, columns) {
  const header = columns.map((c) => escapeCsvValue(c.label)).join(',');
  const lines = (records || []).map((rec) =>
    columns.map((c) => escapeCsvValue(rec[c.key])).join(',')
  );
  return [header, ...lines].join('\r\n') + '\r\n';
}

/** Column order for the shift-log export (keys match rowsFromShiftEvents output). */
const SHIFT_EXPORT_COLUMNS = [
  { key: 'shift_date', label: 'Date' },
  { key: 'rep_key', label: 'Rep' },
  { key: 'scheduled_store', label: 'Scheduled Store' },
  { key: 'actual_store', label: 'Actual Store' },
  { key: 'redirected', label: 'Redirected' },
  { key: 'processes', label: 'Processes' },
  { key: 'start_actual', label: 'Start' },
  { key: 'stop_actual', label: 'Stop' },
  { key: 'hours', label: 'Hours' },
  { key: 'mileage_miles', label: 'Miles' },
  { key: 'outcome_summary', label: 'Outcomes' },
  { key: 'variance_summary', label: 'Variances' },
  { key: 'custom_note', label: 'Shift Note' },
  { key: 'next_visit_note', label: 'Next-Visit Note' },
  { key: 'stage_notes', label: 'Stage Notes' },
  { key: 'survey_summary', label: 'Survey Summary' },
  { key: 'visit_id', label: 'Visit ID' },
  { key: 'shift_id', label: 'Shift ID' },
  { key: 'event_type', label: 'Status' },
  { key: 'sealed_at', label: 'Sealed At' },
  { key: 'transmitted_at', label: 'Transmitted At' },
];

function hoursBetween(startIso, stopIso) {
  if (!startIso || !stopIso) return '';
  const ms = new Date(stopIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return (ms / 3_600_000).toFixed(2);
}

function flattenStageNotes(stageNotes) {
  if (!stageNotes || typeof stageNotes !== 'object') return '';
  return Object.entries(stageNotes)
    .map(([step, v]) => `[${step}] ${typeof v === 'string' ? v : v?.text || ''}`)
    .filter((s) => s.replace(/^\[[^\]]*\]\s*/, '').trim())
    .join(' | ');
}

function summarizeSurvey(survey) {
  if (!survey || typeof survey !== 'object') return '';
  return Object.entries(survey)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * Normalize a shift_events DB row (or an equivalent JSON-fallback object) into a
 * flat CSV-ready record. Accepts already-parsed JSONB fields or JSON strings.
 */
function rowFromShiftEvent(ev) {
  const parse = (v) => {
    if (v == null) return null;
    if (typeof v === 'string') {
      try {
        return JSON.parse(v);
      } catch {
        return null;
      }
    }
    return v;
  };
  const stageNotes = parse(ev.stage_notes);
  const survey = parse(ev.survey);
  const dateOnly = (v) => (v == null ? '' : String(v).slice(0, 10));
  return {
    shift_date: dateOnly(ev.shift_date),
    rep_key: ev.rep_key || '',
    scheduled_store: ev.scheduled_store ?? '',
    actual_store: ev.actual_store ?? '',
    redirected: ev.redirected ? 'yes' : 'no',
    processes: ev.processes || '',
    start_actual: ev.start_actual || '',
    stop_actual: ev.stop_actual || '',
    hours: hoursBetween(ev.start_actual, ev.stop_actual),
    mileage_miles: ev.mileage_miles ?? '',
    outcome_summary: ev.outcome_summary || '',
    variance_summary: ev.variance_summary || '',
    custom_note: ev.custom_note || '',
    next_visit_note: ev.next_visit_note || '',
    stage_notes: flattenStageNotes(stageNotes),
    survey_summary: summarizeSurvey(survey),
    visit_id: ev.visit_id ?? '',
    shift_id: ev.shift_id ?? '',
    event_type: ev.event_type || '',
    sealed_at: ev.sealed_at || '',
    transmitted_at: ev.transmitted_at || '',
  };
}

/** Build the full CSV text for a list of shift_events rows. */
function shiftEventsCsv(events) {
  const records = (events || []).map(rowFromShiftEvent);
  return toCsv(records, SHIFT_EXPORT_COLUMNS);
}

module.exports = {
  escapeCsvValue,
  toCsv,
  SHIFT_EXPORT_COLUMNS,
  rowFromShiftEvent,
  shiftEventsCsv,
  hoursBetween,
};
