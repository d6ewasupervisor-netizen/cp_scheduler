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

async function sendLinkEmail({ to, link }) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not configured');
  }
  const subject = 'Your sign-in link for Central Pet Scheduler';
  const safeLink = escapeHtml(link);
  const text = [
    'Hello,',
    '',
    'Use the link below to sign in to the Central Pet weekly scheduler.',
    'It is unique to you, expires in 30 days, and can only be clicked once.',
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
  return resend.emails.send({ from: FROM, to, subject, text, html });
}

module.exports = { sendLinkEmail };
