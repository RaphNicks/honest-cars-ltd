#!/usr/bin/env node
/**
 * Mail-path diagnostic. Exercises the exact SMTP configuration the app uses
 * and reports each step: config → DNS → connection/auth → delivery.
 *
 * Usage:  node scripts/test-email.js [recipient@example.com]
 *
 * On the panel: Node.js App → Run JS script → scripts/test-email.js
 */
'use strict';

const dns = require('node:dns').promises;
const nodemailer = require('nodemailer');
const config = require('../src/config');

async function main() {
  const to = process.argv[2] || process.env.TEST_EMAIL_TO || 'hello@honestcarsltd.com';

  console.log('1 · Configuration');
  const url = config.mail.smtpUrl;
  const from = config.mail.from;
  if (!url) {
    console.log('   ✗ SMTP_URL is missing from .env — the app cannot send anything.');
    process.exit(1);
  }
  if (!from) {
    console.log('   ✗ SMTP_FROM is missing from .env — the app treats email as NOT configured');
    console.log('     (config.mail.configured requires BOTH SMTP_URL and SMTP_FROM) and the');
    console.log('     sign-in endpoint fails before ever showing the code page.');
    process.exit(1);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    console.log('   ✗ SMTP_URL is not a valid URL:', error.message);
    process.exit(1);
  }
  const user = decodeURIComponent(parsed.username || '');
  console.log(`   ✓ SMTP_URL → ${parsed.hostname}:${parsed.port || '(default)'} · user ${user || '(none)'}`);
  console.log(`   ✓ SMTP_FROM → ${from}`);

  console.log('2 · DNS lookup of the mail host');
  try {
    const records = await dns.lookup(parsed.hostname, { all: true });
    console.log(`   ✓ ${parsed.hostname} → ${records.map((r) => r.address).join(', ')}`);
  } catch (error) {
    console.log(`   ✗ ${parsed.hostname} does not resolve (${error.code}).`);
    console.log('     The DNS record is missing or still propagating — check the mail A record.');
    process.exit(1);
  }

  console.log('3 · SMTP connection + TLS + authentication');
  const transport = nodemailer.createTransport(url);
  try {
    await transport.verify();
    console.log('   ✓ server reachable, TLS OK, credentials accepted');
  } catch (error) {
    console.log(`   ✗ SMTP failed [${error.code || 'no code'}] ${error.message}`);
    process.exit(1);
  }

  console.log(`4 · Sending a real message to ${to}`);
  const info = await transport.sendMail({
    from,
    to,
    subject: 'HonestCars test email',
    text: 'Test message from the HonestCars server. If you are reading this, sign-in codes can be delivered.',
  });
  console.log(`   ✓ accepted (${info.response ? info.response.trim() : info.messageId})`);

  console.log('\nAll steps passed — the mail path is healthy. Codes will send.');
}

main().catch((error) => {
  console.error('Unexpected failure:', error.message || error);
  process.exit(1);
});
