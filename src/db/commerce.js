'use strict';

/**
 * Shop commerce — §6.8 products, cart, guest checkout, orders and the tracker
 * subscription records that tracker SKUs create on purchase.
 *
 * Money is integer kobo everywhere. Totals are always recomputed server-side
 * from the products table — never trusted from the client (§11).
 */

const { query, queryOne, transaction } = require('./pool');
const { parseJson } = require('./shape');

const DELIVERY_OPTIONS = {
  pickup_meet_point: 'Pickup at a PH meet-point',
  ph_delivery: 'Delivery within Port Harcourt',
  install_booking: 'Installation booked (tracker)',
};

async function deliveryAreas() {
  const rows = await query('SELECT * FROM delivery_areas WHERE is_active = 1 ORDER BY position ASC, id ASC');
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    feeKobo: Number(row.fee_kobo),
    note: row.note,
    corporate: Boolean(row.corporate),
  }));
}

async function deliveryFeeFor(areaName) {
  const areas = await deliveryAreas();
  const match = areas.find((area) => area.name.toLowerCase() === String(areaName || '').toLowerCase());
  return match ? match.feeKobo : 0;
}

function shapeOrderItem(row) {
  return {
    id: row.id,
    productId: row.product_id,
    name: row.name,
    qty: Number(row.qty),
    unitPriceKobo: Number(row.unit_price_kobo),
    installRequested: Boolean(row.install_requested),
    lineTotalKobo: Number(row.unit_price_kobo) * Number(row.qty),
  };
}

function shapeOrder(row, items = []) {
  if (!row) return null;
  return {
    id: row.id,
    orderNo: row.order_no,
    name: row.name,
    phone: row.phone,
    deliveryArea: row.delivery_area,
    deliveryFeeKobo: Number(row.delivery_fee_kobo),
    subtotalKobo: Number(row.subtotal_kobo),
    totalKobo: Number(row.total_kobo),
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    items,
    url: `/order/${row.order_no}`,
  };
}

async function nextOrderNo(conn) {
  const [rows] = await conn.query("SELECT MAX(CAST(SUBSTRING(order_no, 8) AS UNSIGNED)) AS last FROM orders WHERE order_no LIKE 'HC-ORD-%'");
  const next = Number(rows[0] && rows[0].last ? rows[0].last : 0) + 1;
  return `HC-ORD-${String(next).padStart(4, '0')}`;
}

/**
 * Guest checkout (§6.8). Recomputes every price from `products`, applies the
 * area delivery fee, writes order + items, and creates a subscription row for
 * each tracker SKU (activation checklist lives in admin, §7.3).
 *
 * @param {object} input
 * @param {Array<{slug: string, qty: number, installRequested?: boolean}>} input.items
 */
async function createOrder({ name, phone, items, deliveryArea, notes = null }) {
  const wanted = (Array.isArray(items) ? items : [])
    .map((item) => ({
      slug: String(item.slug || '').slice(0, 120),
      qty: Math.min(10, Math.max(1, Number.parseInt(item.qty, 10) || 1)),
      installRequested: Boolean(item.installRequested),
    }))
    .filter((item) => item.slug);

  if (!wanted.length) throw Object.assign(new Error('Your cart is empty.'), { statusCode: 422 });

  const order = await transaction(async (conn) => {
    const slugs = wanted.map((item) => item.slug);
    const [productRows] = await conn.query(
      `SELECT * FROM products WHERE slug IN (${slugs.map(() => '?').join(',')}) AND is_active = 1`,
      slugs,
    );

    const lines = [];
    for (const item of wanted) {
      const product = productRows.find((row) => row.slug === item.slug);
      if (!product) continue;
      if (product.stock_status === 'out_of_stock') {
        throw Object.assign(new Error(`${product.name} is out of stock right now.`), { statusCode: 422 });
      }
      lines.push({ product, qty: item.qty, installRequested: item.installRequested });
    }
    if (!lines.length) throw Object.assign(new Error('None of those products are available.'), { statusCode: 422 });

    const [areaRows] = await conn.query('SELECT * FROM delivery_areas WHERE name = ? AND is_active = 1 LIMIT 1', [
      String(deliveryArea || '').slice(0, 80),
    ]);
    const deliveryFee = areaRows.length ? Number(areaRows[0].fee_kobo) : 0;

    const subtotal = lines.reduce((sum, line) => sum + Number(line.product.price_kobo) * line.qty, 0);
    const total = subtotal + deliveryFee;
    const orderNo = await nextOrderNo(conn);

    const [result] = await conn.query(
      `INSERT INTO orders (order_no, name, phone, delivery_area, delivery_fee_kobo, subtotal_kobo, total_kobo, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?)`,
      [
        orderNo,
        String(name || '').slice(0, 120),
        String(phone || '').slice(0, 40),
        String(deliveryArea || 'Pickup at a PH meet-point').slice(0, 80),
        deliveryFee,
        subtotal,
        total,
        notes ? String(notes).slice(0, 400) : null,
      ],
    );

    for (const line of lines) {
      await conn.query(
        `INSERT INTO order_items (order_id, product_id, name, qty, unit_price_kobo, install_requested)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [result.insertId, line.product.id, line.product.name, line.qty, line.product.price_kobo, line.installRequested ? 1 : 0],
      );

      // Tracker SKUs auto-create a subscription record (§6.8).
      if (line.product.category === 'trackers') {
        for (let i = 0; i < line.qty; i += 1) {
          await conn.query(
            `INSERT INTO subscriptions (order_id, product_id, customer_name, customer_phone, device_state, renewal_at)
             VALUES (?, ?, ?, ?, 'ordered', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 12 MONTH))`,
            [result.insertId, line.product.id, String(name || '').slice(0, 120), String(phone || '').slice(0, 40)],
          );
        }
      }
    }

    const [orderRow] = await conn.query('SELECT * FROM orders WHERE id = ?', [result.insertId]);
    return shapeOrder(orderRow[0]);
  });

  const withItems = await findByOrderNo(order.orderNo);
  return withItems;
}

async function findByOrderNo(orderNo) {
  const row = await queryOne('SELECT * FROM orders WHERE order_no = ? LIMIT 1', [
    String(orderNo || '').toUpperCase().slice(0, 24),
  ]);
  if (!row) return null;
  const items = await query('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', [row.id]);
  return shapeOrder(row, items.map(shapeOrderItem));
}

async function listForPhone(phone) {
  const rows = await query('SELECT * FROM orders WHERE phone = ? ORDER BY created_at DESC LIMIT 20', [
    String(phone || '').slice(0, 40),
  ]);
  return rows.map((row) => shapeOrder(row));
}

/** Tracker activation checklist state (§6.8 / §7.3) — admin flips these. */
async function subscriptionsForOrder(orderNo) {
  const rows = await query(
    `SELECT s.*, p.name AS product_name FROM subscriptions s
      JOIN products p ON p.id = s.product_id
      JOIN orders o ON o.id = s.order_id
     WHERE o.order_no = ? ORDER BY s.id ASC`,
    [String(orderNo || '').toUpperCase().slice(0, 24)],
  );
  return rows.map((row) => ({
    id: row.id,
    productName: row.product_name,
    deviceState: row.device_state,
    renewalAt: row.renewal_at,
    installedAt: row.installed_at,
    activatedAt: row.activated_at,
  }));
}

/** Cart totals without writing anything — used to render /cart honestly. */
function summariseCart(lines) {
  const subtotalKobo = lines.reduce((sum, line) => sum + line.product.priceKobo * line.qty, 0);
  return { subtotalKobo, itemCount: lines.reduce((sum, line) => sum + line.qty, 0) };
}

module.exports = {
  DELIVERY_OPTIONS,
  deliveryAreas,
  deliveryFeeFor,
  createOrder,
  findByOrderNo,
  listForPhone,
  subscriptionsForOrder,
  summariseCart,
  shapeOrder,
};
