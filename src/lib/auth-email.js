'use strict';

const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY || 'unset');
const FROM =
  process.env.AUTH_EMAIL_FROM || 'Central Pet Scheduler <info@retail-odyssey.com>';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function normalizeCc(cc) {
  if (!cc) return undefined;
  const list = (Array.isArray(cc) ? cc : [cc])
    .map((e) => String(e || '').trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : undefined;
}

/**
 * Default magic-link email (button + fallback). Prefer sendCopyPasteLinkEmail
 * when the recipient is on a phone / mail-app that burns one-tap links.
 */
async function sendLinkEmail({ to, link, cc } = {}) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not configured');
  }
  const subject = 'Your sign-in link for Central Pet Scheduler';
  const safeLink = escapeHtml(link);
  const text = [
    'Hello,',
    '',
    'Use the link below to sign in to the Central Pet weekly scheduler.',
    'It is unique to you, expires in 30 days, and can only be used once.',
    'After signing in you stay signed in for 45 days on this device.',
    '',
    'On a phone: press and hold the link, then choose Open in browser.',
    '',
    link,
    '',
    'If you did not request this, you can ignore this message.',
    '',
    '— Retail Odyssey',
  ].join('\n');
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 16px;color:#1f2937;">
      <h2 style="color:#1a3a6e;margin:0 0 16px;">Central Pet Scheduler</h2>
      <p style="margin:0 0 12px;">Use the button below to sign in to your weekly schedule.</p>
      <p style="margin:0 0 24px;">
        <a href="${safeLink}" style="display:inline-block;background:#1a3a6e;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Sign in</a>
      </p>
      <p style="color:#6b7280;font-size:13px;margin:0;">Can't click the button? Copy and paste this link:<br>${safeLink}</p>
    </div>
  `;
  const payload = { from: FROM, to, subject, text, html };
  const ccList = normalizeCc(cc);
  if (ccList) payload.cc = ccList;
  return resend.emails.send(payload);
}

/**
 * Copy-paste sign-in email — no Sign-in button.
 * Instructs: press-and-hold → Copy → paste into an Incognito/Private address bar.
 * This avoids mail-app / link-preview agents burning the one-time token.
 */
async function sendCopyPasteLinkEmail({ to, link, cc, recipientName } = {}) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not configured');
  }
  const hello = recipientName ? `Hello ${recipientName},` : 'Hello,';
  const subject = 'Central Pet Scheduler — copy this sign-in link (do not tap it)';
  const safeLink = escapeHtml(link);
  const text = [
    hello,
    '',
    'Here is your sign-in link for the Central Pet Scheduler app.',
    'It lasts 30 days and works one time — do NOT tap/open it from this email.',
    'Mail apps and link scanners can use it up if you tap it here.',
    '',
    'How to sign in on your phone:',
    '1. Press and HOLD the blue link below until a menu appears.',
    '2. Tap Copy (not Open / Open in browser).',
    '3. Open Chrome (or Safari), start a new Incognito / Private tab.',
    '4. Tap the address bar, paste the link, and go.',
    '',
    'After that you stay signed in on that browser for about 45 days.',
    '',
    'Your link:',
    link,
    '',
    'If you did not expect this, you can ignore this message.',
    '',
    '— Retail Odyssey',
  ].join('\n');
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 16px;color:#1f2937;">
      <h2 style="color:#1a3a6e;margin:0 0 16px;">Central Pet Scheduler</h2>
      <p style="margin:0 0 12px;">${escapeHtml(hello)}</p>
      <p style="margin:0 0 12px;">Here is your sign-in link for the Central Pet Scheduler app. It lasts <strong>30 days</strong> and works <strong>one time</strong>.</p>
      <p style="margin:0 0 16px;padding:12px 14px;background:#fff7ed;border:1px solid #fdba74;border-radius:8px;color:#9a3412;font-weight:600;line-height:1.45;">
        Do <u>not</u> tap or open the link from this email. Mail apps and link scanners can use it up.
      </p>
      <p style="margin:0 0 8px;font-weight:600;">How to sign in on your phone:</p>
      <ol style="margin:0 0 20px;padding-left:1.25rem;line-height:1.55;">
        <li>Press and <strong>hold</strong> the blue link below until a menu appears.</li>
        <li>Tap <strong>Copy</strong> (not Open).</li>
        <li>Go back to your <strong>Incognito / Private</strong> browser tab.</li>
        <li>Tap the address bar, <strong>paste</strong> the link, and go.</li>
      </ol>
      <p style="margin:0 0 8px;color:#6b7280;font-size:13px;">Your sign-in link (press and hold → Copy):</p>
      <p style="margin:0 0 20px;word-break:break-all;line-height:1.5;">
        <a href="${safeLink}" style="color:#1a3a6e;font-size:14px;text-decoration:underline;">${safeLink}</a>
      </p>
      <p style="color:#6b7280;font-size:13px;margin:0;">After signing in you stay signed in on that browser for about 45 days.</p>
      <p style="color:#6b7280;font-size:13px;margin:16px 0 0;">If you did not expect this, you can ignore this message.</p>
      <p style="color:#6b7280;font-size:13px;margin:16px 0 0;">— Retail Odyssey</p>
    </div>
  `;
  const payload = { from: FROM, to, subject, text, html };
  const ccList = normalizeCc(cc);
  if (ccList) payload.cc = ccList;
  return resend.emails.send(payload);
}

module.exports = { sendLinkEmail, sendCopyPasteLinkEmail };
