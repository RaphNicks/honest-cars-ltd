'use strict';

/**
 * Lead capture — every public form lands here (§6.3 Request Viewing,
 * §6.5 concierge, §6.6 sell/swap, §6.7 service requests, deal alerts).
 */

const { query, queryOne } = require('./pool');
const phones = require('../lib/phone');
const { sanitizeUtm } = require('../lib/campaign');

const LEAD_TYPES = ['viewing', 'concierge', 'sell_swap', 'hire', 'service', 'parts', 'b2b', 'deal_alert'];

async function createLead(lead) {
  const type = LEAD_TYPES.includes(lead.type) ? lead.type : 'viewing';
  const result = await query(
    `INSERT INTO leads (type, listing_id, name, phone, message, preferred_day, source_path, utm)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      type,
      lead.listingId || null,
      String(lead.name || '').slice(0, 120),
      phones.canonical(lead.phone, { fallback: '' }),
      lead.message ? String(lead.message).slice(0, 2000) : null,
      lead.preferredDay || null,
      String(lead.sourcePath || '/').slice(0, 200),
      // Cleaned here rather than at each caller: there are four entry points
      // (viewing, concierge, sell/swap, services) and the campaign must land
      // identically from all of them, or §15.2's channel report is wrong.
      sanitizeUtm(lead.utm) ? JSON.stringify(sanitizeUtm(lead.utm)).slice(0, 2000) : null,
    ],
  );
  if (lead.listingId) {
    await query('UPDATE vehicle_listings SET enquiries = enquiries + 1 WHERE id = ?', [lead.listingId]);
  }
  return { id: result.insertId };
}

async function countNew() {
  const row = await queryOne("SELECT COUNT(*) AS total FROM leads WHERE status = 'new'");
  return row ? Number(row.total) : 0;
}

module.exports = { LEAD_TYPES, createLead, countNew };
