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
  // §5.1's console sitemap ends at **settings**: the things ops owns about the
  // shape of the business rather than one listing or one order. What lives here
  // today is the market/area list (FR-32), because the PRD makes the area list
  // admin-managed — a neighbourhood that is not in this table cannot be
  // filtered for. Admin and ops hold it; marketing curates content, not markets.
  'settings.manage': ['admin', 'ops'],
  // FR-28 referrals. §7.4 has no referrals column, so this follows the two
  // screens nearest to it: the money desk reads every payment (`dealers.view`,
  // `hire.view` include finance for exactly this reason), and the decision to
  // pay a customer is ops' work, entered by hand like §15.2 spend.
  'referrals.view': ['admin', 'ops', 'finance'],
  // FR-34 financing. The enquiry is a lead, and §7.4 gives leads to admin/ops;
  // but it is a lead that turns into a lender's money, so finance reads it too
  // (`dealers.view`, `hire.view` and `payments.view` all include finance for the
  // same reason). Routing it and recording what a lender said is the desk's
  // work: it happens outside this system and the screen records it, so it stays
  // with admin/ops rather than with whoever reads the ledger.
  'financing.view': ['admin', 'ops', 'finance'],
  'financing.manage': ['admin', 'ops'],
  'referrals.reward': ['admin', 'ops'],
  // §18.3's privacy desk. §7.4 has no privacy column, so it follows the two
  // screens nearest to it — the audit log and settings, both admin/ops. A
  // request log is a list of people who asked us to delete their data, which is
  // not a list to hand around: ops works the queue, marketing never sees who
  // asked, and finance reads the ledgers rather than the inbox.
  'privacy.view': ['admin', 'ops'],
  'privacy.manage': ['admin', 'ops'],
  'reports.view': ['admin', 'ops', 'finance', 'marketing'],
  // §15.2 marketing dashboard. Read is the CMS-and-marketing column of §7.4
  // (admin, ops, marketing); entering spend is the marketing desk's own job, so
  // it is narrower — finance reads the money, it does not enter ad invoices.
  'marketing.view': ['admin', 'ops', 'marketing'],
  'marketing.spend': ['admin', 'marketing'],
  // §12.2's own screen: every role that works in the console may see and set up
  // its *own* second factor. A dealer is not in the console (their portal is a
  // separate surface) and a customer never is, so neither holds it — and the
  // screen this gates shows one account only, the one asking.
  'staff.security': ['admin', 'ops', 'inspector', 'marketing', 'finance'],
};

/**
 * §12.2 — "MFA for admin roles". That reads narrowly on purpose: the two roles
 * that can move money or grant a role. `admin` holds `users.manage` (it can
 * hand out capabilities, including its own) and `payments.approve`; `finance`
 * holds `payments.approve`. A stolen session for either one is a loss, not a
 * nuisance.
 *
 * Ops, inspectors and marketing are not on the list and are not locked out of a
 * shift by it: they can enrol voluntarily, the console tells them how many of
 * their colleagues have, and `mfa.coverage()` reports who is still missing one.
 * Widening this list is a one-line change in the one file that holds policy.
 */
const MFA_ROLES = ['admin', 'finance'];

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

module.exports = {
  MFA_ROLES, ROLES, ROLE_LABELS, MATRIX, STAFF_ROLES, isStaff, can, capabilitiesFor };
