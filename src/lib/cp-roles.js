'use strict';

function parseEmailList(envVal) {
  return (envVal || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Rep-layer accounts see a simplified schedule view (no handoff / admin outputs).
// Default: tgauthier2011@gmail.com — everyone else authenticated is admin.
const REP_LAYER_EMAILS = parseEmailList(
  process.env.CP_SCHEDULER_REP_EMAILS || 'tgauthier2011@gmail.com'
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
