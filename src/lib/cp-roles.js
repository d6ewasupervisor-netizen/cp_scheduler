'use strict';

function parseEmailList(envVal) {
  return (envVal || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Full-admin accounts (Planning Desk, match, dry-run, live UI, photo delivery).
// Explicit list always wins over rep-layer mapping.
const DEFAULT_ADMIN_EMAILS =
  'tyson.gauthier@retailodyssey.com,d6ewa.supervisor@gmail.com,tgauthier2011@gmail.com,aiyana.natarisalazar@retailodyssey.com';

// Rep-layer accounts: Shift Day only, scoped to their repKey.
// Do NOT put supervisor/admin tester emails here — use CP_SCHEDULER_ADMIN_EMAILS instead.
const DEFAULT_REP_EMAILS =
  'patricia.marks@youradv.com,bcampb9565@sbcglobal.net,kimberlyjanellclaf@gmail.com,james.duchene@retailodyssey.com';

const ADMIN_EMAILS = parseEmailList(
  process.env.CP_SCHEDULER_ADMIN_EMAILS || DEFAULT_ADMIN_EMAILS
);

const REP_LAYER_EMAILS = parseEmailList(
  process.env.CP_SCHEDULER_REP_EMAILS || DEFAULT_REP_EMAILS
);

function cpSchedulerLayer(email) {
  const e = (email || '').trim().toLowerCase();
  if (!e) return 'rep';
  // Admin list wins — never force a supervisor into a single-rep view.
  if (ADMIN_EMAILS.includes(e)) return 'admin';
  if (REP_LAYER_EMAILS.includes(e)) return 'rep';
  // Authenticated users who are not explicitly reps are admins (Planning Desk).
  return 'admin';
}

function isCpSchedulerAdmin(email) {
  return cpSchedulerLayer(email) === 'admin';
}

module.exports = {
  ADMIN_EMAILS,
  REP_LAYER_EMAILS,
  DEFAULT_ADMIN_EMAILS,
  DEFAULT_REP_EMAILS,
  cpSchedulerLayer,
  isCpSchedulerAdmin,
};
