'use strict';

/**
 * ============================================================================
 * THE data-access module.
 * ============================================================================
 * Everything the rest of the app knows about persistence comes through here:
 *
 *   const db = require('../db');
 *   const listing = await db.listings.findBySlug('2010-toyota-camry-le-hc-ph-0032');
 *
 * Point it at your own MySQL by editing .env (DB_HOST/DB_PORT/DB_USER/
 * DB_PASSWORD/DB_NAME or DB_SOCKET) — no code changes anywhere else.
 * ============================================================================
 */

const { pool, query, queryOne, transaction, healthcheck } = require('./pool');
const listings = require('./listings');
const facets = require('./facets');
const content = require('./content');
const requests = require('./requests');
const commerce = require('./commerce');
const users = require('./users');
const admin = require('./admin');
const payments = require('./payments');
const subscriptions = require('./subscriptions');
const cms = require('./cms');
const pricing = require('./pricing');
const reports = require('./reports');
const dealers = require('./dealers');
const leads = require('./leads');
const analytics = require('./analytics');
const redirects = require('./redirects');
const staticPages = require('./static-pages');
const shape = require('./shape');

module.exports = {
  pool,
  query,
  queryOne,
  transaction,
  healthcheck,
  shape,
  listings,
  facets,
  content,
  requests,
  commerce,
  users,
  admin,
  payments,
  subscriptions,
  cms,
  pricing,
  reports,
  dealers,
  leads,
  analytics,
  redirects,
  staticPages,
};
