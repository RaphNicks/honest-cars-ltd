'use strict';

/**
 * Roles & capabilities — §7.4 permission matrix, in one place.
 *
 * The matrix is the contract: every admin route declares the capability it
 * needs, and `can()` answers from here. Nothing checks a role string inline,
 * so the matrix can be read (and audited) as a table.
 */

const ROLES = ['customer', 'dealer', 'ops', 'inspector', 'marketing', 'finance', 'admin'];

/** Capability → who holds it. `inspector` and `dealer` are scoped, see below. */
const MATRIX = {
  'listings.moderate': ['admin', 'ops'],           // publish, unlist, mark sold
  'listings.grade': ['admin', 'ops'],              // set verification grade (audited)
  'listings.price': ['admin', 'ops'],              // price override (audited)
  'leads.manage': ['admin', 'ops'],                // inbox, assign, status, lost reason
  'leads.view_own': ['inspector', 'dealer'],       // scoped to their own records
  'concierge.manage': ['admin', 'ops'],            // pipeline board, candidates, stages
  'bookings.dispatch': ['admin', 'ops'],           // calendar, assign inspector
  'bookings.own_jobs': ['inspector'],              // today's jobs + checklist
  'payments.view': ['admin', 'finance'],           // PSP transactions, ledgers
  'payments.approve': ['finance', 'admin'],        // refunds, milestones, payouts
  'cms.manage': ['admin', 'marketing'],
  'intel.manage': ['admin', 'ops'],                // alerts console (§7.3)
  // §7.4 "Price-intel table": admin ✓, ops ✓, marketing read-only.
  // FR-22 hire management. §7.4's “Bookings & dispatch” row is admin ✓ / ops ✓
  // with inspectors scoped to their own jobs — hire is that desk's work, so
  // hire.manage is admin/ops. Finance is added to hire.view because a hire
  // carries money and an invoice, and §7.4 gives finance payments-view on
  // everything that bills. Marketing holds neither.
  'hire.view': ['admin', 'ops', 'finance'],
  'hire.manage': ['admin', 'ops'],
  'pricing.view': ['admin', 'ops', 'marketing'],
  'pricing.manage': ['admin', 'ops'],
  // §5.1 names a **dealers** screen in the console sitemap, and FR-18 hangs the
  // commission statements off it. Ops runs the partner desk and finance reads
  // every billing record, so both may open it; marketing may not. The screen is
  // read-only — a lot's terms are set at onboarding, and an add-on is delivered
  // by the payment landing, never by a button here.
  'dealers.view': ['admin', 'ops', 'finance'],
  // Revoking a lot's API key cuts an integration off mid-flight, so it is the
  // desk that runs partner onboarding (admin/ops), not finance reading the books.
  'dealers.manage': ['admin', 'ops'],
  'users.manage': ['admin'],                       // staff accounts, roles, audit log
  'reports.view': ['admin', 'ops', 'finance', 'marketing'],
  // §15.2 marketing dashboard. Read is the CMS-and-marketing column of §7.4
  // (admin, ops, marketing); entering spend is the marketing desk's own job, so
  // it is narrower — finance reads the money, it does not enter ad invoices.
  'marketing.view': ['admin', 'ops', 'marketing'],
  'marketing.spend': ['admin', 'marketing'],
};

/** Roles that may open the console at all. */
const STAFF_ROLES = [...new Set(Object.values(MATRIX).flat())];

function isStaff(role) {
  return STAFF_ROLES.includes(role);
}

function can(role, capability) {
  const holders = MATRIX[capability];
  return Boolean(holders && holders.includes(role));
}

/** Everything this role may do — used to build the console navigation. */
function capabilitiesFor(role) {
  return Object.entries(MATRIX)
    .filter(([, holders]) => holders.includes(role))
    .map(([capability]) => capability);
}

/** Labels for the staff picker (§7.3 “Users & Roles”). */
const ROLE_LABELS = {
  customer: 'Customer',
  dealer: 'Dealer partner',
  ops: 'Ops',
  inspector: 'Inspector',
  marketing: 'Content / Marketing',
  finance: 'Finance',
  admin: 'Super Admin',
};

module.exports = { ROLES, ROLE_LABELS, MATRIX, STAFF_ROLES, isStaff, can, capabilitiesFor };
