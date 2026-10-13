'use strict';

const config = require('../config');

function requestHostname(req) {
  const host = String(req.hostname || req.get?.('host') || req.headers?.host || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  return host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
}

function isAdminHost(req) {
  return requestHostname(req) === config.admin.hostname;
}

function phoneRoleForHost(req, { enforce = config.admin.enforceHost, adminHostname = config.admin.hostname } = {}) {
  if (!enforce) return null;
  return requestHostname(req) === String(adminHostname).toLowerCase() ? 'staff' : 'dealer';
}

function isAdminPath(pathname) {
  const path = String(pathname || '/').toLowerCase();
  return path === '/admin' || path.startsWith('/admin/');
}

/**
 * Keep the console off the public hostname in production. A preview is a
 * single-origin app, so host enforcement stays off there unless explicitly
 * enabled; production always redirects old /admin links to the admin subdomain.
 */
function createAdminHostMiddleware({
  enabled = config.admin.enforceHost,
  adminUrl = config.admin.url,
  adminHostname = config.admin.hostname,
} = {}) {
  const destination = new URL(adminUrl);
  const expectedHost = String(adminHostname || destination.hostname).toLowerCase();

  return function adminHostMiddleware(req, res, next) {
    if (!enabled) return next();

    const hostname = requestHostname(req);
    const onAdminHost = hostname === expectedHost;
    const pathname = String(req.path || '/');

    if (!onAdminHost && isAdminPath(pathname)) {
      if (!['GET', 'HEAD'].includes(String(req.method || 'GET').toUpperCase())) {
        return res.status(404).type('text/plain').send('Not found.');
      }
      const original = String(req.originalUrl || req.url || pathname);
      const safePath = original.startsWith('/') && !original.startsWith('//')
        ? original
        : `/${original.replace(/^\/+/, '')}`;
      const queryAt = safePath.indexOf('?');
      const pathOnly = queryAt < 0 ? safePath : safePath.slice(0, queryAt);
      const normalizedPath = pathOnly.toLowerCase().replace(/\/+$/, '') || '/';
      const search = queryAt < 0 ? '' : safePath.slice(queryAt);
      const destinationPath = normalizedPath === '/admin'
        ? `/${search}`
        : normalizedPath === '/admin/login'
          ? `/login${search}`
          : safePath;
      return res.redirect(302, `${destination.origin}${destinationPath}`);
    }

    const normalizedPath = pathname.toLowerCase().replace(/\/+$/, '') || '/';
    if (onAdminHost && normalizedPath === '/admin/login') {
      if (!['GET', 'HEAD'].includes(String(req.method || 'GET').toUpperCase())) {
        return res.status(404).type('text/plain').send('Not found.');
      }
      const query = String(req.url || '').match(/\?.*$/)?.[0] || '';
      return res.redirect(302, `/login${query}`);
    }

    // Make the console dashboard the landing page of admin.honestcarsltd.com
    // without changing the route names or breaking its existing form links.
    if (onAdminHost && pathname === '/') {
      const query = String(req.url || '/').match(/\?.*$/)?.[0] || '';
      req.url = `/admin${query}`;
    }

    return next();
  };
}

module.exports = { requestHostname, isAdminHost, phoneRoleForHost, isAdminPath, createAdminHostMiddleware };
