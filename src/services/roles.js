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
  'intel.manage': ['admin', 'ops'],
  'users.manage': ['admin'],                       // staff accounts, roles, audit log
  'reports.view': ['admin', 'ops', 'finance', 'marketing'],
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
