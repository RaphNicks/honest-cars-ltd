'use strict';

/**
 * Privacy — §18.3's NDPA duty, in two tables (migration 028).
 *
 *   consent_records  append-only events. A person ticking the deal-alert box,
 *                    opting into marketing, agreeing to let us show their
 *                    details to a lender. The wording they were shown is part
 *                    of the row, because "they agreed" is not a record — a
 *                    record says what, exactly, they agreed to.
 *   data_requests    the request log. §12.2's "data-subject request handling
 *                    (export/delete)" already worked end to end; this is where
 *                    it is *recorded*, so the duty can be evidenced and a
 *                    request that arrives by WhatsApp can be worked in the
 *                    console instead of living in someone's chat history.
 *
 * Two rules this module exists to keep:
 *
 *   • A closure carries a human sentence. Moving a request to `completed` or
 *     `refused` without saying what was done is refused here, not in a view —
 *     "completed" with nothing behind it is what a log of this kind looks like
 *     when it is theatre.
 *   • The clock is NDPA's 30 days, stored as `due_at` rather than computed at
 *     render time, so a request logged from last week's WhatsApp message keeps
 *     last week's deadline.
 */

const { query, queryOne } = require('./pool');

const DUE_DAYS = 30;

const TYPES = ['access', 'erasure', 'correction', 'withdraw_marketing', 'other'];
const STATUSES = ['received', 'in_progress', 'completed', 'refused'];
const OPEN_STATUSES = ['received', 'in_progress'];
const CLOSED_STATUSES = ['completed', 'refused'];
const CHANNELS = ['self_service', 'contact_form', 'whatsapp', 'phone', 'email', 'walk_in', 'other'];
const PURPOSES = ['marketing', 'deal_alerts', 'lender_share', 'service_contact'];

const TYPE_LABELS = {
  access: 'Copy of their data',
  erasure: 'Delete their data',
  correction: 'Correct something',
  withdraw_marketing: 'Stop marketing',
  other: 'Something else',
};

/** Short line for the console's table; the long-form copy lives in the view. */
const TYPE_SENTENCE = {
  access: 'They asked for everything we hold about them.',
  erasure: 'They asked us to delete what we are not legally required to keep.',
  correction: 'They asked us to fix something inaccurate.',
  withdraw_marketing: 'They asked us to stop marketing to them.',
  other: 'A data request that is none of the four above.',
};

const CHANNEL_LABELS = {
  self_service: 'Used the site itself',
  contact_form: 'Contact form',
  whatsapp: 'WhatsApp',
  phone: 'Phone call',
  email: 'Email',
  walk_in: 'In person',
  other: 'Other',
};

const PURPOSE_LABELS = {
  marketing: 'Marketing messages',
  deal_alerts: 'Deal alerts',
  lender_share: 'Sharing details with a lender',
  service_contact: 'Contacting them about a request or order',
};

function shapeRequest(row) {
  if (!row) return null;
  const dueAt = row.due_at ? new Date(row.due_at) : null;
  const open = OPEN_STATUSES.includes(row.status);
  const overdue = Boolean(open && dueAt && dueAt.getTime() < Date.now());
  const daysLeft = dueAt ? Math.ceil((dueAt.getTime() - Date.now()) / 86_400_000) : null;
  return {
    id: row.id,
    reference: row.reference,
    type: row.request_type,
    typeLabel: TYPE_LABELS[row.request_type] || row.request_type,
    typeSentence: TYPE_SENTENCE[row.request_type] || '',
    status: row.status,
    channel: row.channel,
    channelLabel: CHANNEL_LABELS[row.channel] || row.channel,
    userId: row.user_id || null,
    name: row.name || null,
    phone: row.phone || null,
    email: row.email || null,
    subject: row.subject || null,
    resolution: row.resolution || null,
    requestedAt: row.requested_at,
    dueAt: row.due_at,
    completedAt: row.completed_at || null,
    handledBy: row.handled_by || null,
    handledByName: row.handled_name || null,
    sourcePath: row.source_path || null,
    open,
    overdue,
    daysLeft,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function shapeConsent(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id || null,
    phone: row.phone || null,
    name: row.name || null,
    purpose: row.purpose,
    purposeLabel: PURPOSE_LABELS[row.purpose] || row.purpose,
    granted: Boolean(row.granted),
    source: row.source,
    path: row.path || null,
    notice: row.notice,
    actor: row.actor,
    recordedBy: row.recorded_by || null,
    createdBy: row.created_at,
  };
}

/** `HC-DSR-000001` — the number the person is given and quotes back at us. */
async function nextReference() {
  const row = await queryOne(
    "SELECT MAX(CAST(SUBSTRING(reference, 8) AS UNSIGNED)) AS last FROM data_requests WHERE reference LIKE 'HC-DSR-%'",
  );
  const next = (row && Number(row.last)) || 0;
  return `HC-DSR-${String(next + 1).padStart(6, '0')}`;
}

/**
 * File a request. The reference is retried on the unique key, so two people
 * (or one person and a sweep) filing at the same moment cannot collide.
 */
async function createRequest(input = {}) {
  const requestedAt = input.requestedAt ? new Date(input.requestedAt) : new Date();
  const dueAt = new Date(requestedAt.getTime() + DUE_DAYS * 86_400_000);
  const columns = {
    reference: input.reference || (await nextReference()),
    request_type: input.type,
    status: input.status || 'received',
    channel: input.channel || 'other',
    user_id: input.userId || null,
    name: input.name || null,
    phone: input.phone || null,
    email: input.email || null,
    subject: input.subject || null,
    resolution: input.resolution || null,
    requested_at: requestedAt,
    due_at: input.dueAt ? new Date(input.dueAt) : dueAt,
    completed_at: input.completedAt ? new Date(input.completedAt) : null,
    handled_by: input.handledBy || null,
    source_path: input.sourcePath || null,
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const names = Object.keys(columns);
    const params = names.map((name) => columns[name]);
    try {
      const result = await query(
        `INSERT INTO data_requests (${names.map((name) => `\`${name}\``).join(', ')})
         VALUES (${names.map(() => '?').join(', ')})`,
        params,
      );
      return { ok: true, request: await findRequest(result.insertId) };
    } catch (error) {
      if (error && error.code === 'ER_DUP_ENTRY') {
        columns.reference = await nextReference();
        continue;
      }
      return { ok: false, error: error && error.message ? error.message : 'Could not file that request.' };
    }
  }
  return { ok: false, error: 'Could not allocate a request reference.' };
}

const SELECT_REQUEST = `
  SELECT r.*, u.name AS handled_name
    FROM data_requests r
    LEFT JOIN \`users\` u ON u.id = r.handled_by`;

async function findRequest(id) {
  return shapeRequest(await queryOne(`${SELECT_REQUEST} WHERE r.id = ? LIMIT 1`, [id]));
}

async function findByReference(reference) {
  return shapeRequest(
    await queryOne(`${SELECT_REQUEST} WHERE r.reference = ? LIMIT 1`, [String(reference || '').toUpperCase()]),
  );
}

/** The queue. Open requests first and oldest deadline first — the order the duty is owed in. */
async function requests({ status = null, type = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (status === 'open') where.push(`r.status IN ('received','in_progress')`);
  else if (status && STATUSES.includes(status)) {
    where.push('r.status = ?');
    params.push(status);
  }
  if (type && TYPES.includes(type)) {
    where.push('r.request_type = ?');
    params.push(type);
  }
  params.push(Math.max(1, Math.min(Number(limit) || 100, 500)));
  const rows = await query(
    `${SELECT_REQUEST}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
     ORDER BY FIELD(r.status, 'received','in_progress','refused','completed'), r.due_at ASC, r.id DESC
     LIMIT ?`,
    params,
  );
  return rows.map(shapeRequest);
}

/**
 * Move a request. `completed_at` is stamped when it closes and cleared when it
 * reopens, so the two can never disagree about whether the clock is running.
 */
async function updateRequest(id, { status, resolution, handledBy = null } = {}) {
  const before = await findRequest(id);
  if (!before) return { ok: false, error: 'That request does not exist.' };
  if (!STATUSES.includes(status)) return { ok: false, error: 'Unknown status.' };
  const closing = CLOSED_STATUSES.includes(status);
  if (closing && !String(resolution || '').trim()) {
    return {
      ok: false,
      error:
        status === 'refused'
          ? 'Say why it is refused — a refusal with no reason is not a record.'
          : 'Say what was actually done — that sentence is the record.',
    };
  }
  await query(
    `UPDATE data_requests
        SET status = ?, resolution = ?, handled_by = ?, completed_at = ?
      WHERE id = ?`,
    [
      status,
      resolution ? String(resolution).slice(0, 240) : null,
      // Only a closing move keeps the handler's name on the row: reopening it
      // puts the request back in the queue, where nobody is claimed to own it.
      closing ? handledBy : null,
      closing ? new Date() : null,
      id,
    ],
  );
  return { ok: true, request: await findRequest(id), moved: before.status !== status };
}

/** Counts for the console's KPI row: open, overdue, closed this month, all time. */
async function counts() {
  const rows = await query(
    `SELECT
       COUNT(*)                                                                        AS total,
       SUM(status IN ('received','in_progress'))                                       AS open,
       SUM(status IN ('received','in_progress') AND due_at < NOW())                    AS overdue,
       SUM(status = 'completed')                                                       AS completed,
       SUM(status = 'refused')                                                         AS refused,
       SUM(status IN ('completed','refused') AND completed_at >= DATE_FORMAT(NOW(), '%Y-%m-01')) AS closed_this_month,
       SUM(status IN ('received','in_progress') AND due_at >= NOW() AND due_at < NOW() + INTERVAL 7 DAY) AS due_soon
     FROM data_requests`,
  );
  const row = rows[0] || {};
  return {
    total: Number(row.total) || 0,
    open: Number(row.open) || 0,
    overdue: Number(row.overdue) || 0,
    completed: Number(row.completed) || 0,
    refused: Number(row.refused) || 0,
    closedThisMonth: Number(row.closed_this_month) || 0,
    dueSoon: Number(row.due_soon) || 0,
  };
}

/** One consent event. Never updates — withdrawing is a second row, not an edit. */
async function recordConsent(input = {}, conn = null) {
  const run = conn ? (sql, params) => conn.query(sql, params) : query;
  const granted = input.granted === false || input.granted === 0 ? 0 : 1;
  await run(
    `INSERT INTO consent_records
       (user_id, phone, name, purpose, granted, source, path, notice, actor, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.userId || null,
      input.phone || null,
      input.name || null,
      input.purpose,
      granted,
      input.source,
      input.path ? String(input.path).slice(0, 200) : null,
      String(input.notice || '').slice(0, 400),
      input.actor === 'staff' ? 'staff' : 'self',
      input.recordedBy || null,
    ],
  );
  return { ok: true };
}

/** The log, newest first. `purpose` narrows it; a person's history uses `phone`. */
async function consentEvents({ purpose = null, phone = null, limit = 25 } = {}) {
  const where = [];
  const params = [];
  if (purpose && PURPOSES.includes(purpose)) {
    where.push('purpose = ?');
    params.push(purpose);
  }
  if (phone) {
    where.push('phone = ?');
    params.push(phone);
  }
  params.push(Math.max(1, Math.min(Number(limit) || 25, 200)));
  const rows = await query(
    `SELECT * FROM consent_records${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
     ORDER BY id DESC LIMIT ?`,
    params,
  );
  return rows.map(shapeConsent);
}

/**
 * The events summary: grants and withdrawals per purpose over a window. This is
 * the "consent records exist" evidence — the *current* state of marketing
 * consent lives on the account (`users.marketing_opt_in`) and of deal alerts on
 * the saved cars and searches themselves, so those counts are read from where
 * they actually are rather than from this log.
 */
async function consentTally({ days = 30 } = {}) {
  const rows = await query(
    `SELECT purpose, granted, COUNT(*) AS n
       FROM consent_records
      WHERE created_at >= NOW() - INTERVAL ? DAY
      GROUP BY purpose, granted`,
    [Math.max(1, Math.min(Number(days) || 30, 365))],
  );
  const out = {};
  for (const purpose of PURPOSES) out[purpose] = { granted: 0, withdrawn: 0 };
  for (const row of rows) {
    const key = Number(row.granted) ? 'granted' : 'withdrawn';
    out[row.purpose][key] = Number(row.n);
  }
  return out;
}

/**
 * The current state of each list, read from where it actually lives. A consent
 * *log* can be complete and still leave the obvious question unanswered — "how
 * many people are on the deal-alert list right now?" — so the console asks the
 * tables that hold the flags rather than counting log rows backwards.
 */
async function consentState() {
  const rows = await query(
    `SELECT
       (SELECT COUNT(*) FROM \`users\` WHERE marketing_opt_in = 1 AND status = 'active')                 AS marketing_opt_ins,
       (SELECT COUNT(DISTINCT user_id) FROM saved_cars)                                                 AS deal_alert_savers,
       (SELECT COUNT(DISTINCT user_id) FROM saved_searches WHERE alerts_enabled = 1)                    AS alert_searchers,
       (SELECT COUNT(*) FROM financing_leads)                                                           AS lender_shares,
       (SELECT COUNT(*) FROM service_requests)                                                          AS service_contacts,
       (SELECT COUNT(*) FROM consent_records)                                                           AS events`,
  );
  const row = rows[0] || {};
  return {
    marketingOptIns: Number(row.marketing_opt_ins) || 0,
    dealAlertSavers: Number(row.deal_alert_savers) || 0,
    alertSearchers: Number(row.alert_searchers) || 0,
    lenderShares: Number(row.lender_shares) || 0,
    serviceContacts: Number(row.service_contacts) || 0,
    events: Number(row.events) || 0,
  };
}

/** A person's consent history, for the console's per-request view. */
async function consentForPhone(phone) {
  return consentEvents({ phone, limit: 20 });
}

module.exports = {
  DUE_DAYS,
  TYPES,
  STATUSES,
  OPEN_STATUSES,
  CLOSED_STATUSES,
  CHANNELS,
  PURPOSES,
  TYPE_LABELS,
  TYPE_SENTENCE,
  CHANNEL_LABELS,
  PURPOSE_LABELS,
  nextReference,
  createRequest,
  findRequest,
  findByReference,
  requests,
  updateRequest,
  counts,
  recordConsent,
  consentEvents,
  consentTally,
  consentForPhone,
  consentState,
  shapeRequest,
  shapeConsent,
};
