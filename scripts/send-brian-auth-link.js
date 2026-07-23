'use strict';

/**
 * Issue a durable (30-day) one-time magic link for Brian Campbell and email it
 * as a copy-paste link (no Sign-in button), CC Tyson.
 *
 * Prefer running with Railway env so JWT_SECRET / RESEND / DATABASE match prod:
 *   railway run --service cp_scheduler --environment production -- node scripts/send-brian-auth-link.js
 */

const { issueLinkToken } = require('../src/lib/tokens');
const { buildDestinationUrl } = require('../src/lib/magic-link');
const { sendCopyPasteLinkEmail } = require('../src/lib/auth-email');
const { isCpSchedulerEmailAllowed } = require('../src/lib/cp-auth-allowlist');
const { query, getPool } = require('../src/lib/db');

const TO = 'brian.campbell@sasretailservices.com';
const CC = 'tyson.gauthier@retailodyssey.com';
const RETURN_TO =
  (process.env.CP_SCHEDULER_PUBLIC_URL || 'https://cpscheduler-production.up.railway.app').replace(
    /\/+$/,
    ''
  ) + '/shiftday.html';

async function main() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET missing');
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY missing');
  if (!getPool()) throw new Error('DATABASE_URL missing / pool not ready');

  if (!(await isCpSchedulerEmailAllowed(TO))) {
    throw new Error(`${TO} is not allowed for cp-scheduler`);
  }

  // Direct destination URL (not open-sign-in wrapper): Brian will paste into
  // Incognito himself. Auto-open wrappers are what mail scanners burn.
  const { token, jti } = issueLinkToken(TO);
  const link = buildDestinationUrl(token, RETURN_TO);
  if (!link) throw new Error('failed to build destination URL');

  await query(
    `INSERT INTO link_requests (email, jti, ip, user_agent) VALUES ($1, $2, $3, $4)`,
    [TO, jti, 'script:send-brian-auth-link', 'copy-paste-durable']
  );

  const result = await sendCopyPasteLinkEmail({
    to: TO,
    cc: CC,
    link,
    recipientName: 'Brian',
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        to: TO,
        cc: CC,
        jtiPrefix: jti.slice(0, 8),
        returnTo: RETURN_TO,
        ttlDays: Number(process.env.LINK_TTL_DAYS || 30),
        resendId: result?.data?.id || result?.id || null,
        // do not print the live link / token
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
