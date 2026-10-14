'use strict';

/**
 * Sign-in credentials for every account — email OTP or Google, and nothing
 * else. There are no passwords anywhere in this build, and phone numbers are
 * never a sign-in credential (they are optional contact data on `users`).
 *
 * One credential system, three audiences:
 *
 *   customer — /login. Open registration: a verified email with no account
 *              creates a customer account.
 *   staff    — /admin/login (admin host). Provisioned accounts only; the
 *              email must already carry a verified identity or nothing is
 *              ever sent (no enumeration, no self-service registration).
 *   dealer   — /dealer/login. Same closed rule as staff.
 *
 * The audience is chosen by the surface the form sits on and is checked at
 * every step: a code requested at one surface can never open an account on
 * another. Staff roles that move money still meet the TOTP challenge after
 * this first factor (§12.2) — `mfaPending` is part of the session.
 */

const crypto = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');
const config = require('../config');
const db = require('../db');
const auth = require('./auth');
const email = require('./email');
const mfa = require('./mfa');
const roles = require('./roles');

const GOOGLE_STATE_COOKIE = 'hc_google_state';
const GOOGLE_STATE_TTL_MS = 10 * 60_000;
const EMAIL_PURPOSES = ['sign_in', 'link'];
const AUDIENCES = ['customer', 'staff', 'dealer'];

/** Which sign-in surface a credential request belongs to. */
function normaliseAudience(value) {
  const audience = String(value || 'customer').trim().toLowerCase();
  return AUDIENCES.includes(audience) ? audience : 'customer';
}

/** Does this account belong on this surface? Staff is the §7.4 console set. */
function audienceMatches(user, audience) {
  if (!user) return false;
  const scope = normaliseAudience(audience);
  if (scope === 'staff') return roles.isStaff(user.role);
  if (scope === 'dealer') return user.role === 'dealer';
  return user.role === 'customer';
}

/** Where a finished sign-in lands. Accepts an audience or the account's role. */
function defaultRedirect(scopeOrRole) {
  const value = String(scopeOrRole || 'customer').trim().toLowerCase();
  if (value === 'staff' || roles.isStaff(value)) return '/admin';
  if (value === 'dealer') return '/dealer/dashboard';
  return '/account';
}

function resultError(code, status, message) {
  return { ok: false, code, status, error: message };
}

function normaliseEmail(raw) {
  return db.users.normaliseEmail(raw);
}

function googleClient(redirectUri = config.googleAuth.redirectUri) {
  if (!config.googleAuth.configured) return null;
  return new OAuth2Client(config.googleAuth.clientId, config.googleAuth.clientSecret, redirectUri);
}

/**
 * Which callback the Google round-trip must return to. The state cookie is
 * host-only, so the redirect URI has to be the host the sign-in started on:
 * the admin console in production, the public site for customers and dealers.
 */
function googleRedirectUri(onAdminHost) {
  return onAdminHost ? config.googleAuth.adminRedirectUri : config.googleAuth.redirectUri;
}

const UNAVAILABLE = 'We could not send a sign-in code to that email. Please contact Honest Cars for help.';
const UNAVAILABLE_GOOGLE = 'We could not sign you in with Google here. Please contact Honest Cars for help.';
const WRONG_SURFACE = 'That sign-in option is not available for this account. Please contact Honest Cars for help.';

async function requestEmailCode({ rawEmail, purpose = 'sign_in', userId = null, ip = null, audience = 'customer' }) {
  const address = normaliseEmail(rawEmail);
  if (!address) return resultError('INVALID_EMAIL', 422, 'Enter a valid email address.');
  if (!EMAIL_PURPOSES.includes(purpose)) return resultError('INVALID_PURPOSE', 422, 'Choose a valid email verification action.');
  const scope = normaliseAudience(audience);

  let owner = null;
  if (purpose === 'link') {
    // Linking is an action of an already signed-in account, on any surface.
    owner = await db.users.findById(userId);
    if (!owner || owner.status !== 'active') {
      return resultError('CUSTOMER_SESSION_REQUIRED', 401, 'Sign in to your account before linking an email.');
    }
    const verifiedOwner = await db.users.findByVerifiedEmail(address);
    if (verifiedOwner && Number(verifiedOwner.id) === Number(owner.id)) {
      return { ok: true, alreadyLinked: true, email: address };
    }
    if (verifiedOwner && Number(verifiedOwner.id) !== Number(owner.id)) {
      return resultError('EMAIL_IN_USE', 409, 'That verified email is already linked to another account.');
    }
  } else if (scope !== 'customer') {
    // Staff and dealer sign-in is closed: the address must already carry a
    // verified identity on an active account of the right role. Anything else
    // gets the same flat refusal — the form cannot be used to probe who has
    // an account here.
    const existing = await db.users.findByVerifiedEmail(address);
    if (!existing || existing.status !== 'active' || !audienceMatches(existing, scope)) {
      return resultError('SIGN_IN_UNAVAILABLE', 404, UNAVAILABLE);
    }
  }

  const recent = await db.users.countRecentEmailCodes(address, purpose, userId, { withinMinutes: 60 });
  if (recent >= config.auth.emailMaxRequestsPerHour) {
    return resultError('EMAIL_RATE_LIMITED', 429, 'We have sent several codes to that email already. Please wait a little while and try again.');
  }

  const code = auth.generateCode();
  const expiresAt = new Date(Date.now() + config.auth.otpTtlMinutes * 60_000);
  const codeId = await db.users.createEmailCode({
    email: address,
    purpose,
    userId: purpose === 'link' ? owner.id : null,
    codeHash: auth.hashEmailCode(address, purpose, code),
    expiresAt,
    ip,
    maxAttempts: config.auth.maxVerifyAttempts,
  });

  let delivery;
  try {
    delivery = await email.sendAuthCode({
      to: address,
      code,
      ttlMinutes: config.auth.otpTtlMinutes,
      purpose,
    });
  } catch (error) {
    await db.users.consumeEmailCode(codeId).catch(() => {});
    if (error.code === 'SMTP_NOT_CONFIGURED') {
      return resultError('SMTP_NOT_CONFIGURED', 503, error.message);
    }
    console.error('[auth] email code delivery failed:', error.code || error.name || 'delivery_error');
    return resultError('EMAIL_DELIVERY_FAILED', 503, 'We could not send a code right now. Please try again in a moment.');
  }

  await db.analytics
    .record('email_otp_requested', { payload: { channel: delivery.channel, purpose, audience: scope }, sourcePath: '/login' })
    .catch(() => {});

  return {
    ok: true,
    email: address,
    purpose,
    audience: scope,
    channel: delivery.channel,
    delivered: delivery.delivered,
    expiresAt,
    devCode: delivery.devCode,
  };
}

/**
 * The session, for every audience. The role check is the audience check: a
 * customer surface never opens a staff account, and the reverse is also true.
 * An enrolled account hands back an MFA-pending session — it has passed the
 * first factor and nothing else (§12.2).
 */
async function createSession(user, { audience = 'customer', ip = null, userAgent = null, source = 'email' } = {}) {
  const scope = normaliseAudience(audience);
  if (!user || user.status !== 'active') {
    return resultError('ACCOUNT_NOT_ACTIVE', 403, 'That account cannot sign in right now. Contact Honest Cars for help.');
  }
  if (!audienceMatches(user, scope)) {
    return resultError(scope === 'customer' ? 'CUSTOMER_ONLY' : 'SIGN_IN_UNAVAILABLE', 403, scope === 'customer' ? WRONG_SURFACE : UNAVAILABLE);
  }

  const currentUser = await db.users.touchUser(user.id);
  if (!currentUser || currentUser.status !== 'active' || !audienceMatches(currentUser, scope)) {
    return resultError('ACCOUNT_NOT_ACTIVE', 403, 'That account cannot sign in right now. Contact Honest Cars for help.');
  }

  const mfaPending = mfa.mustChallenge(currentUser);
  const token = auth.newSessionToken();
  const expiresAt = new Date(Date.now() + config.auth.sessionDays * 86_400_000);
  await db.users.createSession({
    userId: currentUser.id,
    tokenHash: auth.hashToken(token),
    expiresAt,
    ip,
    userAgent,
    mfaPending,
  });
  db.users.pruneSessions().catch(() => {});
  await db.analytics
    .record('customer_sign_in_succeeded', { payload: { method: source, audience: scope }, sourcePath: '/login' })
    .catch(() => {});

  return { ok: true, user: currentUser, token, expiresAt, mfaPending };
}

async function verifyEmailCode({
  rawEmail,
  code,
  purpose = 'sign_in',
  userId = null,
  name = null,
  referralCode = null,
  ip = null,
  userAgent = null,
  audience = 'customer',
}) {
  const address = normaliseEmail(rawEmail);
  const cleanCode = String(code || '').replace(/\D/g, '');
  if (!address || !cleanCode) return resultError('INVALID_CODE', 422, 'Enter the email address and the code we sent you.');
  if (!EMAIL_PURPOSES.includes(purpose)) return resultError('INVALID_PURPOSE', 422, 'Choose a valid email verification action.');
  if (cleanCode.length < 4 || cleanCode.length > 8) return resultError('INVALID_CODE', 422, 'Enter the full code from your email.');
  const scope = normaliseAudience(audience);

  const codeUserId = purpose === 'link' ? Number(userId) || 0 : null;
  const active = await db.users.findActiveEmailCode(address, purpose, codeUserId);
  if (!active) return resultError('CODE_EXPIRED', 410, 'That code has expired or is no longer active. Request a new one.');
  if (active.attempts >= active.maxAttempts) {
    await db.users.consumeEmailCode(active.id);
    return resultError('TOO_MANY_ATTEMPTS', 429, 'Too many tries on that code. Request a new one.');
  }

  const expected = auth.hashEmailCode(address, purpose, cleanCode);
  if (!auth.safeEqual(expected, active.codeHash)) {
    const attempts = await db.users.registerEmailAttempt(active.id);
    const left = Math.max(0, active.maxAttempts - attempts);
    return resultError('CODE_NOT_VALID', 401, left
      ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`
      : 'Too many tries on that code. Request a new one.');
  }

  await db.users.consumeEmailCode(active.id);

  if (purpose === 'link') {
    if (!codeUserId || Number(active.userId) !== codeUserId) {
      return resultError('EMAIL_LINK_SESSION_MISMATCH', 401, 'Sign in again before verifying this email.');
    }
    try {
      const user = await db.users.linkVerifiedEmail(codeUserId, address);
      return { ok: true, linked: true, user };
    } catch (error) {
      return resultError(error.code || 'EMAIL_LINK_FAILED', error.code === 'EMAIL_IN_USE' ? 409 : 422, error.message || 'We could not link that email.');
    }
  }

  let user = await db.users.findByVerifiedEmail(address);
  let newAccount = false;

  if (scope !== 'customer') {
    // Closed surfaces: no registration, and the wrong role is the same flat
    // refusal as no account at all.
    if (!user || user.status !== 'active' || !audienceMatches(user, scope)) {
      return resultError('SIGN_IN_UNAVAILABLE', 403, UNAVAILABLE);
    }
  } else if (!user) {
    const legacy = await db.users.findLegacyEmailOwner(address);
    if (legacy) {
      return resultError(
        'LEGACY_EMAIL_REQUIRES_PHONE_LINK',
        409,
        legacy.role === 'customer'
          ? 'This email is linked to an older account. Please contact Honest Cars for help signing in.'
          : 'This email cannot be used for a customer account. Please contact Honest Cars for help.',
      );
    }
    try {
      user = await db.users.createEmailAccount({ email: address, name, referralCode });
      newAccount = true;
    } catch (error) {
      return resultError(error.code || 'ACCOUNT_CREATE_FAILED', error.code === 'LEGACY_EMAIL_REQUIRES_PHONE_LINK' ? 409 : 422, error.message || 'We could not open an account with that email.');
    }
  } else if (!audienceMatches(user, scope)) {
    return resultError('CUSTOMER_ONLY', 403, WRONG_SURFACE);
  }

  if (user.status !== 'active') {
    return resultError('ACCOUNT_NOT_ACTIVE', 403, 'That account cannot sign in right now. Contact Honest Cars for help.');
  }

  if (!user.name && String(name || '').trim().length >= 2) {
    user = await db.users.updateProfile(user.id, { name: String(name).trim().slice(0, 120) });
  }

  const session = await createSession(user, { audience: scope, ip, userAgent, source: 'email_otp' });
  if (!session.ok) return session;
  session.newAccount = newAccount;
  return session;
}

// ---------------------------------------------------------------------------
// Google OpenID Connect — the same three audiences, carried in the signed
// state. The callback URI is single: one registration covers every surface.
// ---------------------------------------------------------------------------
function createGoogleState({ audience = 'customer', next = null, linkUserId = null, saveListingId = null } = {}) {
  const state = crypto.randomBytes(32).toString('base64url');
  const nonce = crypto.randomBytes(32).toString('base64url');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const scope = normaliseAudience(audience);
  const payload = {
    state,
    nonce,
    codeVerifier,
    audience: scope,
    next: auth.safeNextPath(next) || defaultRedirect(scope),
    linkUserId: Number(linkUserId) || null,
    saveListingId: Number(saveListingId) || null,
    issuedAt: Date.now(),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { payload, cookie: `${encoded}.${auth.signAuthState(encoded)}` };
}

function readGoogleState(cookie, state) {
  const [encoded, signature, extra] = String(cookie || '').split('.');
  if (!encoded || !signature || extra) throw Object.assign(new Error('That Google sign-in expired. Start again.'), { code: 'GOOGLE_STATE_INVALID' });
  if (!auth.safeEqual(signature, auth.signAuthState(encoded))) {
    throw Object.assign(new Error('That Google sign-in could not be verified. Start again.'), { code: 'GOOGLE_STATE_INVALID' });
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw Object.assign(new Error('That Google sign-in could not be verified. Start again.'), { code: 'GOOGLE_STATE_INVALID' });
  }
  if (!payload || Date.now() - Number(payload.issuedAt) > GOOGLE_STATE_TTL_MS || Date.now() < Number(payload.issuedAt) - 30_000) {
    throw Object.assign(new Error('That Google sign-in expired. Start again.'), { code: 'GOOGLE_STATE_EXPIRED' });
  }
  if (!state || !auth.safeEqual(String(state), String(payload.state || ''))) {
    throw Object.assign(new Error('That Google sign-in could not be verified. Start again.'), { code: 'GOOGLE_STATE_INVALID' });
  }
  payload.audience = normaliseAudience(payload.audience);
  return payload;
}

function beginGoogleAuth(options = {}) {
  const client = googleClient(googleRedirectUri(Boolean(options.onAdminHost)));
  if (!client) return resultError('GOOGLE_NOT_CONFIGURED', 503, 'Google sign-in is not set up yet. Use email code instead.');
  const state = createGoogleState(options);
  const challenge = crypto.createHash('sha256').update(state.payload.codeVerifier).digest('base64url');
  const url = client.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state: state.payload.state,
    nonce: state.payload.nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return { ok: true, url, cookie: state.cookie, context: state.payload };
}

async function verifyGoogleCallback({ cookie, state, code, onAdminHost = false }) {
  const context = readGoogleState(cookie, state);
  if (!code) throw Object.assign(new Error('Google did not return a sign-in code. Please try again.'), { code: 'GOOGLE_CODE_MISSING' });
  const client = googleClient(googleRedirectUri(onAdminHost));
  if (!client) throw Object.assign(new Error('Google sign-in is not set up yet. Use email code instead.'), { code: 'GOOGLE_NOT_CONFIGURED' });

  const { tokens } = await client.getToken({ code: String(code), codeVerifier: context.codeVerifier });
  if (!tokens || !tokens.id_token) throw Object.assign(new Error('Google did not confirm this sign-in. Please try again.'), { code: 'GOOGLE_TOKEN_MISSING' });
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.googleAuth.clientId });
  const payload = ticket.getPayload() || {};
  const address = normaliseEmail(payload.email);
  if (!payload.sub || !address || !(payload.email_verified === true || payload.email_verified === 'true')) {
    throw Object.assign(new Error('Google did not provide a verified email address. Use email code instead.'), { code: 'GOOGLE_EMAIL_UNVERIFIED' });
  }
  if (!payload.nonce || !auth.safeEqual(String(payload.nonce), String(context.nonce))) {
    throw Object.assign(new Error('That Google sign-in could not be verified. Start again.'), { code: 'GOOGLE_NONCE_INVALID' });
  }
  const name = String(payload.name || '').trim().slice(0, 120);
  if (name.length < 2) throw Object.assign(new Error('Google did not share your name. Use email code and enter your name instead.'), { code: 'GOOGLE_NAME_MISSING' });

  return {
    context,
    profile: {
      subject: String(payload.sub).slice(0, 255),
      email: address,
      name,
    },
  };
}

async function signInWithGoogle(profile, options = {}) {
  const scope = normaliseAudience(options.audience);
  let bySubject = await db.users.findByGoogleSubject(profile.subject);
  const byEmail = await db.users.findByVerifiedEmail(profile.email);
  if (bySubject && byEmail && Number(bySubject.id) !== Number(byEmail.id)) {
    return resultError('GOOGLE_ACCOUNT_CONFLICT', 409, 'That Google account and email are linked to different customer accounts. Contact Honest Cars before continuing.');
  }

  let user = bySubject;
  if (!user && byEmail) {
    if (!audienceMatches(byEmail, scope)) {
      return resultError(scope === 'customer' ? 'CUSTOMER_ONLY' : 'SIGN_IN_UNAVAILABLE', 403, scope === 'customer' ? WRONG_SURFACE : UNAVAILABLE_GOOGLE);
    }
    try {
      user = await db.users.linkVerifiedEmail(byEmail.id, profile.email, { googleSubject: profile.subject });
    } catch (error) {
      return resultError(error.code || 'GOOGLE_LINK_FAILED', error.code === 'GOOGLE_IDENTITY_IN_USE' ? 409 : 422, error.message || 'We could not link that Google account.');
    }
  }

  if (!user && scope !== 'customer') {
    // Closed surfaces never create accounts — Google must already be linked
    // to a provisioned staff or dealer account.
    return resultError('SIGN_IN_UNAVAILABLE', 403, UNAVAILABLE_GOOGLE);
  }

  if (!user) {
    const legacy = await db.users.findLegacyEmailOwner(profile.email);
    if (legacy) {
      return resultError(
        'LEGACY_EMAIL_REQUIRES_PHONE_LINK',
        409,
        legacy.role === 'customer'
          ? 'This email is linked to an older account. Please contact Honest Cars for help signing in.'
          : 'This Google account cannot be used for a customer account. Please contact Honest Cars for help.',
      );
    }
    try {
      user = await db.users.createEmailAccount({ email: profile.email, name: profile.name, googleSubject: profile.subject });
    } catch (error) {
      return resultError(error.code || 'GOOGLE_ACCOUNT_CREATE_FAILED', error.code === 'LEGACY_EMAIL_REQUIRES_PHONE_LINK' ? 409 : 422, error.message || 'We could not open an account with that Google profile.');
    }
  }

  if (!audienceMatches(user, scope)) {
    return resultError(scope === 'customer' ? 'CUSTOMER_ONLY' : 'SIGN_IN_UNAVAILABLE', 403, scope === 'customer' ? WRONG_SURFACE : UNAVAILABLE_GOOGLE);
  }
  if (user.status !== 'active') return resultError('ACCOUNT_NOT_ACTIVE', 403, 'That account cannot sign in right now. Contact Honest Cars for help.');
  if (!user.name && profile.name) user = await db.users.updateProfile(user.id, { name: profile.name });
  return createSession(user, { ...options, audience: scope, source: 'google' });
}

async function linkGoogleIdentity(userId, profile) {
  try {
    const user = await db.users.linkVerifiedEmail(userId, profile.email, { googleSubject: profile.subject });
    return { ok: true, linked: true, user };
  } catch (error) {
    return resultError(error.code || 'GOOGLE_LINK_FAILED', error.code === 'EMAIL_IN_USE' || error.code === 'GOOGLE_IDENTITY_IN_USE' ? 409 : 422, error.message || 'We could not link that Google account.');
  }
}

async function linkEmail({ rawEmail, code, userId }) {
  return verifyEmailCode({ rawEmail, code, purpose: 'link', userId });
}

module.exports = {
  AUDIENCES,
  GOOGLE_STATE_COOKIE,
  GOOGLE_STATE_TTL_MS,
  normaliseAudience,
  audienceMatches,
  defaultRedirect,
  requestEmailCode,
  verifyEmailCode,
  createSession,
  createGoogleState,
  readGoogleState,
  beginGoogleAuth,
  verifyGoogleCallback,
  signInWithGoogle,
  linkGoogleIdentity,
  linkEmail,
};
