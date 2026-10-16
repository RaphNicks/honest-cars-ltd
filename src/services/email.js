'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');

let cachedTransport = null;
let cachedUrl = null;

function emailConfigured() {
  return Boolean(config.mail.configured);
}

function emailTransport() {
  if (!emailConfigured()) return null;
  if (!cachedTransport || cachedUrl !== config.mail.smtpUrl) {
    cachedTransport = nodemailer.createTransport(config.mail.smtpUrl);
    cachedUrl = config.mail.smtpUrl;
  }
  return cachedTransport;
}

function maskEmail(email) {
  const [local = '', domain = ''] = String(email || '').split('@');
  if (!domain) return '•••';
  const visible = local.length < 3 ? local.slice(0, 1) : `${local.slice(0, 2)}•••`;
  return `${visible}@${domain}`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

/** Deliver an authentication code through generic SMTP or the local dev seam. */
async function sendAuthCode({ to, code, ttlMinutes, purpose = 'sign_in' }) {
  const transport = emailTransport();
  if (!transport) {
    if (config.isProduction) {
      const error = new Error('Email sign-in is not configured. Please try again later or contact Honest Cars.');
      error.code = 'SMTP_NOT_CONFIGURED';
      throw error;
    }
    console.log(`[auth] email OTP for ${maskEmail(to)} → ${code} (SMTP not configured, ${config.env})`);
    return {
      channel: 'console',
      delivered: false,
      devCode: config.auth.showCodeInResponse ? code : undefined,
    };
  }

  const linking = purpose === 'link';
  const subject = linking ? 'Verify your email for Honest Cars' : 'Your Honest Cars sign-in code';
  const text = linking
    ? `Your verification code is ${code}. Enter it in your Honest Cars account to link this email address. It expires in ${ttlMinutes} minutes. If you did not request this, you can ignore this message.`
    : `Your Honest Cars sign-in code is ${code}. It expires in ${ttlMinutes} minutes. Never share it. If you did not request this code, you can ignore this message.`;
  const safeCode = escapeHtml(code);
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#f5f4f1;color:#20211f;font-family:Arial,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#fff;border-radius:12px;padding:32px"><tr><td><p style="margin:0 0 20px;color:#6c6d68;font-size:13px;letter-spacing:.08em;text-transform:uppercase">Honest Cars</p><h1 style="margin:0 0 12px;font-size:24px">${linking ? 'Verify your email' : 'Your sign-in code'}</h1><p style="margin:0 0 24px;color:#555">${linking ? 'Enter this code in your account to verify and link this email address.' : 'Use this one-time code to sign in to your account.'}</p><p style="display:inline-block;margin:0 0 20px;padding:14px 20px;background:#f5f4f1;border-radius:8px;font-size:30px;font-weight:700;letter-spacing:.25em">${safeCode}</p><p style="margin:0;color:#6c6d68;font-size:14px">This code expires in ${Number(ttlMinutes) || 10} minutes. Never share it with anyone.</p></td></tr></table></td></tr></table></body></html>`;

  await transport.sendMail({
    from: config.mail.from,
    to,
    subject,
    text,
    html,
  });
  return { channel: 'email', delivered: true };
}

/**
 * Deliver a plain-text notification (a partner decision, a status update, …)
 * through the same SMTP as the sign-in codes. Unlike sendAuthCode there is no
 * dev seam: a notification that cannot be sent is a delivery failure the caller
 * records honestly, not a code to print on the server.
 */
async function sendEmail({ to, subject, text }) {
  const transport = emailTransport();
  if (!transport) {
    return { ok: false, error: 'Email is not configured (SMTP_URL + SMTP_FROM).' };
  }
  const message = String(text || '');
  const html =
    `<!doctype html><html lang="en"><body style="margin:0;background:#f5f4f1;color:#20211f;font-family:Arial,sans-serif">` +
    `<div style="max-width:520px;margin:0 auto;padding:32px 16px"><div style="background:#fff;border-radius:12px;padding:32px">` +
    `<p style="margin:0 0 20px;color:#6c6d68;font-size:13px;letter-spacing:.08em;text-transform:uppercase">Honest Cars</p>` +
    `<p style="margin:0;font-size:15px;line-height:1.65;white-space:pre-line">${escapeHtml(message)}</p>` +
    `</div></div></body></html>`;
  try {
    await transport.sendMail({
      from: config.mail.from,
      to,
      subject: String(subject || 'A message from Honest Cars'),
      text: message,
      html,
    });
    return { ok: true, providerRef: 'smtp' };
  } catch (error) {
    return { ok: false, error: `Email delivery failed: ${error.code || error.message || 'unknown'}` };
  }
}

module.exports = { emailConfigured, maskEmail, escapeHtml, sendAuthCode, sendEmail };
