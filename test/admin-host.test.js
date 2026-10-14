'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdminHostMiddleware, phoneRoleForHost } = require('../src/lib/admin-host');

function request({ hostname = 'honestcarsltd.com', path = '/', method = 'GET', originalUrl = path, url = path } = {}) {
  return { hostname, path, method, originalUrl, url, headers: {}, get() { return ''; } };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    status(value) { this.statusCode = value; return this; },
    type(value) { this.contentType = value; return this; },
    send(value) { this.body = value; return this; },
    redirect(value, location) { this.statusCode = value; this.location = location; return this; },
  };
}

const middleware = createAdminHostMiddleware({
  enabled: true,
  adminUrl: 'https://admin.honestcarsltd.com',
  adminHostname: 'admin.honestcarsltd.com',
});

test('production phone OTP role follows the request host', () => {
  const options = { enforce: true, adminHostname: 'admin.honestcarsltd.com' };
  assert.equal(phoneRoleForHost(request({ hostname: 'admin.honestcarsltd.com' }), options), 'staff');
  assert.equal(phoneRoleForHost(request({ hostname: 'honestcarsltd.com' }), options), 'dealer');
  assert.equal(phoneRoleForHost(request({ hostname: 'honestcarsltd.com' }), { ...options, enforce: false }), null);
});

test('public /admin paths move to the staff subdomain and preserve query strings', () => {
  const req = request({ path: '/admin/settings', originalUrl: '/admin/settings?tab=markets' });
  const res = response();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 302);
  assert.equal(res.location, 'https://admin.honestcarsltd.com/admin/settings?tab=markets');
});

test('the public /admin entry point redirects to the clean admin subdomain root', () => {
  const req = request({ path: '/admin', originalUrl: '/admin?tab=overview' });
  const res = response();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.location, 'https://admin.honestcarsltd.com/?tab=overview');
});

test('legacy /admin/login links on the admin host redirect to the staff sign-in', () => {
  const req = request({ hostname: 'admin.honestcarsltd.com', path: '/admin/login', originalUrl: '/admin/login?next=%2Fadmin%2Fstaff', url: '/admin/login?next=%2Fadmin%2Fstaff' });
  const res = response();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.location, '/login?next=%2Fadmin%2Fstaff');
});

test('the admin subdomain root internally opens the console dashboard', () => {
  const req = request({ hostname: 'admin.honestcarsltd.com', path: '/', originalUrl: '/?from=bookmark', url: '/?from=bookmark' });
  const res = response();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(req.url, '/admin?from=bookmark');
});

test('case variations of public /admin cannot bypass host isolation', () => {
  const req = request({ path: '/ADMIN', originalUrl: '/ADMIN' });
  const res = response();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.location, 'https://admin.honestcarsltd.com/');
});

test('normal public paths stay on the main site', () => {
  const req = request({ path: '/cars', originalUrl: '/cars?city=Port%20Harcourt' });
  const res = response();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(res.location, undefined);
});

test('mutating requests to the old public /admin path are not forwarded across hosts', () => {
  const req = request({ path: '/admin/payments', method: 'POST', originalUrl: '/admin/payments' });
  const res = response();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body, 'Not found.');
});

test('host-split can be switched off: /admin stays a path on the main site', () => {
  const pathMode = createAdminHostMiddleware({
    enabled: false,
    adminUrl: 'https://admin.honestcarsltd.com',
    adminHostname: 'admin.honestcarsltd.com',
  });
  const req = request({ path: '/admin', originalUrl: '/admin' });
  const res = response();
  let nextCalled = false;
  pathMode(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(res.location, undefined);

  const req2 = request({ path: '/admin/settings', originalUrl: '/admin/settings' });
  const res2 = response();
  let next2 = false;
  pathMode(req2, res2, () => { next2 = true; });
  assert.equal(next2, true);
  assert.equal(res2.location, undefined);
});

test('ENFORCE_ADMIN_HOST env switch overrides the production default', () => {
  const config = require('../src/config');
  const previous = process.env.ENFORCE_ADMIN_HOST;
  try {
    process.env.ENFORCE_ADMIN_HOST = 'false';
    assert.equal(config.admin.enforceHost, false);
    process.env.ENFORCE_ADMIN_HOST = 'true';
    assert.equal(config.admin.enforceHost, true);
    delete process.env.ENFORCE_ADMIN_HOST;
    assert.equal(config.admin.enforceHost, config.isProduction);
  } finally {
    if (previous === undefined) delete process.env.ENFORCE_ADMIN_HOST;
    else process.env.ENFORCE_ADMIN_HOST = previous;
  }
});
