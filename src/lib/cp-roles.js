'use strict';

function parseEmailList(envVal) {
  return (envVal || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Rep-layer accounts see a simplified schedule view (no handoff / admin outputs).
// Default: d6ewa.supervisor@gmail.com — cp_scheduler rep UI tester only; all other
// authenticated users are admin unless listed in CP_SCHEDULER_REP_EMAILS.
const REP_LAYER_EMAILS = parseEmailList(
  process.env.CP_SCHEDULER_REP_EMAILS || 'd6ewa.supervisor@gmail.com'
);

function cpSchedulerLayer(email) {
  const e = (email || '').trim().toLowerCase();
  if (REP_LAYER_EMAILS.includes(e)) return 'rep';
  return 'admin';
}

function isCpSchedulerAdmin(email) {
  return cpSchedulerLayer(email) === 'admin';
}

module.exports = {
  REP_LAYER_EMAILS,
  cpSchedulerLayer,
  isCpSchedulerAdmin,
};
