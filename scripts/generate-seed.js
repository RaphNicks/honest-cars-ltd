'use strict';

/**
 * Deterministic seed generator.
 *
 *   node scripts/generate-seed.js           # rewrites db/seed.sql + public/img/seed/*
 *
 * Everything is derived from a fixed PRNG seed, so the committed db/seed.sql is
 * reproducible byte-for-byte. Inventory is synthetic but market-plausible for
 * Port Harcourt (₦ bands, PH areas, real makes/models). Swap for your importer
 * when real stock arrives — the schema is the contract, not this file.
 */

const fs = require('node:fs');
const path = require('node:path');

const CONTENT = require('./seed-content');

const ROOT = path.join(__dirname, '..');
const SEED_SQL = path.join(ROOT, 'db', 'seed.sql');
const IMG_DIR = path.join(ROOT, 'public', 'img', 'seed');

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32)
// ---------------------------------------------------------------------------
let state = 0x9e3779b9;
function rnd() {
  state |= 0;
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (min, max) => Math.floor(rnd() * (max - min + 1)) + min;
const chance = (p) => rnd() < p;
const sample = (arr, n) => {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(rnd() * copy.length), 1)[0]);
  return out;
};

const millions = (value) => Math.round(value * 1_000_000 * 100); // kobo

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------
const AREAS = [
  'GRA Phase 2', 'Woji', 'Rumuokoro', 'Trans-Amadi', 'Aba Road', 'Peter Odili Road',
  'Ada George', 'Elelenwo', 'Choba', 'Rukpokwu', 'Mgbuoba', 'Eliozu', 'Old GRA', 'Rumuola',
];

const DEALERS = [
  { name: 'Aba Road Autos', slug: 'aba-road-autos', area: 'Aba Road', tier: 'pilot', verified: 1 },
  { name: 'Trans-Amadi Motors', slug: 'trans-amadi-motors', area: 'Trans-Amadi', tier: 'premium', verified: 1 },
  { name: 'Woji Car Mart', slug: 'woji-car-mart', area: 'Woji', tier: 'standard', verified: 1 },
  { name: 'GRA Premium Motors', slug: 'gra-premium-motors', area: 'GRA Phase 2', tier: 'premium', verified: 1 },
  { name: 'Rumuokoro Auto Hub', slug: 'rumuokoro-auto-hub', area: 'Rumuokoro', tier: 'pilot', verified: 1 },
  { name: 'Peter Odili Motors', slug: 'peter-odili-motors', area: 'Peter Odili Road', tier: 'standard', verified: 1 },
  { name: 'Elelenwo Autos', slug: 'elelenwo-autos', area: 'Elelenwo', tier: 'standard', verified: 1 },
  { name: 'Choba Car Centre', slug: 'choba-car-centre', area: 'Choba', tier: 'pilot', verified: 1 },
  { name: 'Ada George Motors', slug: 'ada-george-motors', area: 'Ada George', tier: 'standard', verified: 1 },
  { name: 'Igwuruta Auto Sales', slug: 'igwuruta-auto-sales', area: 'Rukpokwu', tier: 'standard', verified: 1 },
  { name: 'Mgbuoba Motorline', slug: 'mgbuoba-motorline', area: 'Mgbuoba', tier: 'standard', verified: 0 },
  { name: 'Diobu Cars & Trucks', slug: 'diobu-cars-trucks', area: 'Old GRA', tier: 'pilot', verified: 1 },
];

/**
 * Catalog: make, model, body, year range, ₦ band (millions) by condition.
 * Bands approximate the PH market the price-intel table would carry.
 */
const CATALOG = [
  { make: 'Toyota', model: 'Camry', body: 'sedan', fuel: 'petrol', years: [2010, 2018], band: [6.5, 16.5], trims: ['LE', 'SE', 'XLE'], engines: ['2.4L I4', '2.5L I4', '3.5L V6'] },
  { make: 'Toyota', model: 'Corolla', body: 'sedan', fuel: 'petrol', years: [2011, 2019], band: [7.0, 18.5], trims: ['LE', 'S', 'XLE'], engines: ['1.8L I4'] },
  { make: 'Toyota', model: 'RAV4', body: 'suv', fuel: 'petrol', years: [2010, 2019], band: [9.5, 28.0], trims: ['LE', 'XLE', 'Limited'], engines: ['2.5L I4', '2.0L I4'] },
  { make: 'Toyota', model: 'Highlander', body: 'suv', fuel: 'petrol', years: [2011, 2018], band: [14.0, 38.0], trims: ['LE', 'XLE', 'Limited'], engines: ['3.5L V6', '2.7L I4'] },
  { make: 'Toyota', model: 'Hilux', body: 'pickup', fuel: 'diesel', years: [2014, 2020], band: [20.0, 46.0], trims: ['SR', 'SR5', 'Adventure'], engines: ['2.4L TD', '2.8L TD'] },
  { make: 'Toyota', model: 'Sienna', body: 'van', fuel: 'petrol', years: [2011, 2018], band: [11.0, 25.0], trims: ['LE', 'XLE', 'Limited'], engines: ['3.5L V6'] },
  { make: 'Toyota', model: 'Prado', body: 'suv', fuel: 'petrol', years: [2012, 2019], band: [32.0, 78.0], trims: ['TX', 'VX', 'GX'], engines: ['4.0L V6', '2.7L I4'] },
  { make: 'Toyota', model: 'Avalon', body: 'sedan', fuel: 'petrol', years: [2012, 2017], band: [9.5, 17.0], trims: ['XLE', 'Limited'], engines: ['3.5L V6'] },
  { make: 'Honda', model: 'Accord', body: 'sedan', fuel: 'petrol', years: [2012, 2018], band: [7.5, 18.0], trims: ['LX', 'EX', 'EX-L'], engines: ['2.4L I4', '3.5L V6'] },
  { make: 'Honda', model: 'CR-V', body: 'suv', fuel: 'petrol', years: [2012, 2019], band: [9.0, 24.0], trims: ['LX', 'EX', 'EX-L'], engines: ['2.4L I4', '1.5L Turbo'] },
  { make: 'Honda', model: 'Civic', body: 'sedan', fuel: 'petrol', years: [2013, 2019], band: [7.0, 15.5], trims: ['LX', 'EX', 'Sport'], engines: ['1.8L I4', '1.5L Turbo'] },
  { make: 'Honda', model: 'Pilot', body: 'suv', fuel: 'petrol', years: [2013, 2018], band: [15.0, 30.0], trims: ['EX', 'EX-L', 'Touring'], engines: ['3.5L V6'] },
  { make: 'Lexus', model: 'RX 350', body: 'suv', fuel: 'petrol', years: [2012, 2018], band: [17.0, 38.0], trims: ['Base', 'F Sport', 'Luxury'], engines: ['3.5L V6'] },
  { make: 'Lexus', model: 'ES 350', body: 'sedan', fuel: 'petrol', years: [2013, 2018], band: [12.5, 24.0], trims: ['Base', 'Luxury'], engines: ['3.5L V6'] },
  { make: 'Lexus', model: 'GX 460', body: 'suv', fuel: 'petrol', years: [2014, 2019], band: [28.0, 55.0], trims: ['Base', 'Premium'], engines: ['4.6L V8'] },
  { make: 'Mercedes-Benz', model: 'C-Class', body: 'sedan', fuel: 'petrol', years: [2013, 2018], band: [11.0, 26.0], trims: ['C300', 'C250', 'C200'], engines: ['2.0L Turbo', '1.8L Turbo'] },
  { make: 'Mercedes-Benz', model: 'GLE', body: 'suv', fuel: 'petrol', years: [2016, 2019], band: [32.0, 72.0], trims: ['GLE 350', 'GLE 400', 'GLE 450'], engines: ['3.0L V6', '3.5L V6'] },
  { make: 'Mercedes-Benz', model: 'E-Class', body: 'sedan', fuel: 'petrol', years: [2014, 2018], band: [16.0, 34.0], trims: ['E350', 'E300'], engines: ['3.5L V6', '2.0L Turbo'] },
  { make: 'Hyundai', model: 'Elantra', body: 'sedan', fuel: 'petrol', years: [2014, 2018], band: [6.0, 12.0], trims: ['SE', 'SEL', 'Limited'], engines: ['1.8L I4', '2.0L I4'] },
  { make: 'Hyundai', model: 'Santa Fe', body: 'suv', fuel: 'petrol', years: [2014, 2019], band: [11.0, 22.0], trims: ['SE', 'SEL', 'Limited'], engines: ['2.4L I4', '3.3L V6'] },
  { make: 'Hyundai', model: 'Tucson', body: 'suv', fuel: 'petrol', years: [2015, 2019], band: [10.0, 20.0], trims: ['SE', 'SEL', 'Limited'], engines: ['2.0L I4', '1.6L Turbo'] },
  { make: 'Kia', model: 'Sportage', body: 'suv', fuel: 'petrol', years: [2015, 2019], band: [11.0, 22.0], trims: ['LX', 'EX', 'SX'], engines: ['2.4L I4', '2.0L I4'] },
  { make: 'Kia', model: 'Rio', body: 'hatchback', fuel: 'petrol', years: [2015, 2018], band: [5.5, 9.5], trims: ['LX', 'EX'], engines: ['1.6L I4'] },
  { make: 'Kia', model: 'Sorento', body: 'suv', fuel: 'petrol', years: [2015, 2019], band: [13.0, 24.0], trims: ['LX', 'EX'], engines: ['2.4L I4', '3.3L V6'] },
  { make: 'Nissan', model: 'X-Trail', body: 'suv', fuel: 'petrol', years: [2015, 2019], band: [13.0, 25.0], trims: ['S', 'SV', 'SL'], engines: ['2.5L I4'] },
  { make: 'Nissan', model: 'Altima', body: 'sedan', fuel: 'petrol', years: [2013, 2017], band: [6.5, 13.0], trims: ['S', 'SV', 'SL'], engines: ['2.5L I4'] },
  { make: 'Nissan', model: 'Rogue', body: 'suv', fuel: 'petrol', years: [2015, 2019], band: [10.0, 21.0], trims: ['S', 'SV', 'SL'], engines: ['2.5L I4'] },
  { make: 'Ford', model: 'Explorer', body: 'suv', fuel: 'petrol', years: [2013, 2018], band: [13.0, 27.0], trims: ['XLT', 'Limited', 'Sport'], engines: ['3.5L V6', '2.3L EcoBoost'] },
  { make: 'Ford', model: 'Ranger', body: 'pickup', fuel: 'diesel', years: [2016, 2020], band: [20.0, 42.0], trims: ['XLT', 'Wildtrak', 'XL'], engines: ['2.2L TD', '3.2L TD'] },
  { make: 'Mazda', model: 'CX-5', body: 'suv', fuel: 'petrol', years: [2015, 2019], band: [12.0, 23.0], trims: ['Sport', 'Touring', 'Grand Touring'], engines: ['2.0L I4', '2.5L I4'] },
  { make: 'Mitsubishi', model: 'Pajero', body: 'suv', fuel: 'petrol', years: [2013, 2017], band: [14.0, 28.0], trims: ['GLS', 'GLX'], engines: ['3.0L V6'] },
  { make: 'Acura', model: 'MDX', body: 'suv', fuel: 'petrol', years: [2012, 2017], band: [12.0, 24.0], trims: ['Base', 'Tech', 'Advance'], engines: ['3.5L V6'] },
  { make: 'Infiniti', model: 'QX60', body: 'suv', fuel: 'petrol', years: [2014, 2018], band: [15.0, 28.0], trims: ['Base', 'Premium'], engines: ['3.5L V6'] },
  { make: 'BMW', model: 'X5', body: 'suv', fuel: 'petrol', years: [2013, 2017], band: [20.0, 44.0], trims: ['xDrive35i', 'xDrive50i'], engines: ['3.0L Turbo', '4.4L V8'] },
  { make: 'BMW', model: '3 Series', body: 'sedan', fuel: 'petrol', years: [2013, 2017], band: [11.0, 22.0], trims: ['328i', '320i', '335i'], engines: ['2.0L Turbo', '3.0L Turbo'] },
  { make: 'Volkswagen', model: 'Passat', body: 'sedan', fuel: 'petrol', years: [2013, 2017], band: [6.5, 13.0], trims: ['S', 'SE', 'SEL'], engines: ['1.8L Turbo', '2.5L I5'] },
];

const seedMedia = require('./seed-media');

const SHOTS = [
  { key: 'front-3q', label: 'Front three-quarter' },
  { key: 'side', label: 'Side profile' },
  { key: 'rear-3q', label: 'Rear three-quarter' },
  { key: 'interior', label: 'Interior' },
  { key: 'dash', label: 'Dashboard' },
  { key: 'odometer', label: 'Odometer close-up' },
  { key: 'engine', label: 'Engine bay' },
  { key: 'tyres', label: 'Tyres & tread' },
];

const FEATURES = [
  'Reverse camera', 'Apple CarPlay', 'Android Auto', 'Leather seats', 'Alloy wheels',
  'Push-button start', 'Cruise control', 'Bluetooth', 'Power windows', 'Keyless entry',
  'Fog lights', 'Roof rails', 'Third-row seats', 'Heated seats', 'Lane assist',
  'Blind-spot monitor', 'Dual-zone climate', 'Parking sensors', 'Sunroof', 'USB charging',
];

const HONEST_NOTES = [
  'AC blows cold across all vents. Two panels resprayed (rear left quarter, boot lid) — no structural repair on the chassis jig. Tyres at roughly 60%. Front brake pads about 40% life left.',
  'Genuine mileage, verified on the OBD2 history. Small stone chips on the bonnet. One key fob. Suspension bushes replaced at 70k km with receipts.',
  'Interior is clean, no smoking smell. Rear bumper has a scuff that we photographed at close range. Everything electrical works — we tested each switch with the inspector present.',
  'No fault codes on the scan. Battery is 8 months old. Windscreen is original with one short hairline crack at the passenger edge — priced in.',
  'Freshly serviced before listing. AC compressor replaced last year with a receipt. Driver seat bolster shows normal wear for the mileage.',
  'Underside is clean, no flood tell-tales (we checked the wiring loom, seat rails and spare-wheel well). One alloy has kerb rash. Spare tyre unused.',
];

const DESCRIPTIONS = [
  'First-body {model} with full service history in the glovebox. Sound engine and gearbox, cold AC, and a clean undercarriage. Inspected by our team — ask us anything about it.',
  'This {year} {make} {model} came in from a single owner and has been driven mainly within Port Harcourt. Reason for sale: owner relocated. Documentation is complete and verified.',
  'Popular PH family car with strong resale value. We have driven it on the Aba Road stretch ourselves and the suspension is tight. Bring your own mechanic if you want — we encourage it.',
  'Low-mileage {model} with tidy interior and no accident history on record. Papers are ready for a same-week transfer. Viewing slots available any weekday.',
];

const FAQS = {
  global: [
    ['What do the three verification grades mean?', 'Network-Listed means the dealer gave us the data but we have not seen the car. Field-Checked means an inspector physically stood next to it and photographed it. HonestCars-Certified means it passed our full checklist — OBD2 scan, documents sighted, road test and an honest condition note you can read on the listing.'],
    ['Do I pay the seller directly?', 'No. All payments for a car we are handling go through HonestCars-protected channels. If someone asks you to pay a seller or a "third party" directly, it is not us — stop and message our WhatsApp.'],
    ['Can I bring my own mechanic?', 'Yes, always. We would rather you did. We only ask that you book the viewing so the dealer opens the car for you and nothing is hidden between visits.'],
  ],
  'facet:suv-under-15m': [
    ['Are these SUVs really under ₦15m?', 'Every car on this page is listed below ₦15,000,000. Prices move — we refresh the page as dealers update stock, and we will tell you if a price changes before you travel.'],
    ['Will an older SUV cost me more in fuel and parts?', 'Usually yes on fuel, and it depends on the model for parts. The Camry and Corolla platforms are the cheapest to keep on the road in PH; among SUVs, older RAV4 and CR-V models have the best parts availability.'],
  ],
  'facet:toyota': [
    ['Why are there so many Toyotas on HonestCars?', 'Because Port Harcourt buys them — parts are everywhere, mechanics know them, and resale value holds. We list whatever is genuinely good stock, and Toyota tends to pass our checklist more often.'],
    ['Tokunbo or Nigerian-used Toyota?', 'Both, and we label each one. A Nigerian-used car with a verifiable service history can be better value than a low-grade import. Ask us and we will give you the honest comparison on the specific cars you are looking at.'],
  ],
};

// ---------------------------------------------------------------------------
// Placeholder media (committed, cacheable, tiny). Honest about being a stub.
// ---------------------------------------------------------------------------
const CLIP = {
  sedan: 'M28 60 L58 60 C66 44 84 38 112 38 C142 38 158 44 168 60 L196 60 C200 60 202 63 202 67 L202 74 L20 74 L20 67 C20 63 24 60 28 60 Z',
  suv: 'M24 58 L52 58 C58 40 78 30 110 30 C144 30 162 40 168 58 L196 58 C200 58 203 61 203 66 L203 74 L18 74 L18 66 C18 61 21 58 24 58 Z',
  pickup: 'M22 58 L50 58 C56 42 76 34 106 34 C132 34 148 42 154 58 L198 58 L198 74 L18 74 L18 64 C18 60 20 58 22 58 Z',
  hatchback: 'M34 62 L60 62 C66 48 82 42 108 42 C134 42 150 48 158 62 L186 62 C190 62 192 65 192 69 L192 75 L26 75 L26 69 C26 65 30 62 34 62 Z',
  van: 'M22 52 L46 52 C54 36 76 28 112 28 C150 28 172 36 178 52 L200 52 L200 74 L18 74 Z',
};

function placeholderSvg(body, shot) {
  const clip = CLIP[body] || CLIP.sedan;
  const zoom = { 'front-3q': 1.0, side: 0.98, 'rear-3q': 1.02, interior: 1.25, dash: 1.45, odometer: 1.9, engine: 1.35, tyres: 1.7 }[shot.key] || 1;
  const label = shot.label.toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 900" width="1200" height="900" role="img" aria-label="${label} placeholder">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#F7FAFC"/><stop offset="100%" stop-color="#E7EEF5"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="900" fill="url(#bg)"/>
  <rect x="24" y="24" width="1152" height="852" fill="none" stroke="#D8E0E8" stroke-width="2" stroke-dasharray="10 8"/>
  <g transform="translate(600 470) scale(${(4.6 * zoom).toFixed(2)}) translate(-110 -55)" opacity="0.16">
    <path d="${clip}" fill="#0E2A47"/>
    <circle cx="66" cy="78" r="16" fill="#0E2A47"/>
    <circle cx="164" cy="78" r="16" fill="#0E2A47"/>
  </g>
  <text x="600" y="300" text-anchor="middle" font-family="Inter, -apple-system, Segoe UI, Roboto, sans-serif" font-size="46" font-weight="700" fill="#0E2A47" letter-spacing="2">${label}</text>
  <text x="600" y="352" text-anchor="middle" font-family="Inter, -apple-system, Segoe UI, Roboto, sans-serif" font-size="26" font-weight="400" fill="#5B6B7C">Photo pending — media pipeline stub</text>
  <text x="600" y="800" text-anchor="middle" font-family="Inter, -apple-system, Segoe UI, Roboto, sans-serif" font-size="24" font-weight="500" fill="#5B6B7C">HONESTCARS · PORT HARCOURT</text>
</svg>
`;
}

function writePlaceholders() {
  fs.mkdirSync(IMG_DIR, { recursive: true });
  let count = 0;
  for (const body of Object.keys(CLIP)) {
    for (const shot of SHOTS) {
      fs.writeFileSync(path.join(IMG_DIR, `${body}-${shot.key}.svg`), placeholderSvg(body, shot));
      count += 1;
    }
  }
  // Hero + section art
  fs.writeFileSync(path.join(IMG_DIR, 'hero-lot.svg'), heroSvg());
  fs.writeFileSync(path.join(IMG_DIR, 'og-default.svg'), ogSvg());
  return count + 2;
}

function heroSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 900" width="1200" height="900" role="img" aria-label="HonestCars inspection in Port Harcourt">
  <defs><linearGradient id="h" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0E2A47"/><stop offset="100%" stop-color="#12395F"/></linearGradient></defs>
  <rect width="1200" height="900" fill="url(#h)"/>
  <g opacity="0.22" fill="#FFFFFF">
    <path d="M120 620 L210 620 C230 560 290 528 380 528 C474 528 530 560 552 620 L640 620 C652 620 658 628 658 640 L658 668 L100 668 L100 640 C100 628 108 620 120 620 Z"/>
    <circle cx="200" cy="690" r="34"/><circle cx="546" cy="690" r="34"/>
  </g>
  <g opacity="0.35" stroke="#12A150" stroke-width="6" fill="none">
    <circle cx="880" cy="300" r="86"/><path d="M840 302 L868 330 L926 268"/>
  </g>
  <text x="100" y="220" font-family="Inter, -apple-system, Segoe UI, Roboto, sans-serif" font-size="72" font-weight="700" fill="#FFFFFF">Every vehicle checked</text>
  <text x="100" y="310" font-family="Inter, -apple-system, Segoe UI, Roboto, sans-serif" font-size="72" font-weight="700" fill="#12A150">in PH, by us.</text>
  <text x="100" y="380" font-family="Inter, -apple-system, Segoe UI, Roboto, sans-serif" font-size="30" font-weight="400" fill="#D8E0E8">Placeholder art — swap for real lot photography.</text>
  <text x="100" y="800" font-family="Inter, -apple-system, Segoe UI, Roboto, sans-serif" font-size="26" font-weight="500" fill="#8FA8C0">HONESTCARS · PORT HARCOURT, RIVERS STATE</text>
</svg>
`;
}

function ogSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <rect width="1200" height="630" fill="#0E2A47"/>
  <rect x="0" y="0" width="14" height="630" fill="#12A150"/>
  <text x="80" y="180" font-family="Inter, -apple-system, Segoe UI, Roboto, sans-serif" font-size="60" font-weight="700" fill="#FFFFFF">HONESTCARS</text>
  <text x="80" y="300" font-family="Inter, -apple-system, Segoe UI, Roboto, sans-serif" font-size="42" font-weight="400" fill="#D8E0E8">Every vehicle verified. Every price compared.</text>
  <text x="80" y="368" font-family="Inter, -apple-system, Segoe UI, Roboto, sans-serif" font-size="42" font-weight="400" fill="#D8E0E8">Every deal honest.</text>
  <text x="80" y="520" font-family="Inter, -apple-system, Segoe UI, Roboto, sans-serif" font-size="30" font-weight="500" fill="#12A150">honestcarsltd.com · Port Harcourt</text>
</svg>
`;
}

// ---------------------------------------------------------------------------
// Listing generation
// ---------------------------------------------------------------------------
const sqlEscape = (value) => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function buildListing({ index, status, soldDaysAgo = null, upgraded = false, catalogEntry = null }) {
  const cat = catalogEntry || pick(CATALOG);
  const year = int(cat.years[0], cat.years[1]);
  const [lo, hi] = cat.band;
  // Older cars sit nearer the bottom of the band.
  const ageSpan = cat.years[1] - cat.years[0] || 1;
  const ageRatio = (year - cat.years[0]) / ageSpan;
  const base = lo + (hi - lo) * (0.15 + 0.75 * ageRatio);
  const jitter = 1 + (rnd() * 0.16 - 0.08);
  let priceMillions = Math.round(base * jitter * 10) / 10;

  // Curated facet /cars/suv-under-15m needs honest depth.
  if (cat.body === 'suv' && priceMillions > 14.4 && chance(0.55)) priceMillions = Math.round((9.5 + rnd() * 4.5) * 10) / 10;

  // “New” means unregistered, so it can only apply to current-model stock —
  // a 2013 SUV with 40 km on the clock is a data bug, not a listing.
  const canBeNew = year >= 2019;
  const condition = canBeNew && chance(0.14) ? 'new' : chance(0.62) ? 'tokunbo' : 'nigerian_used';
  const mileage = condition === 'new' ? int(10, 90) : Math.max(12_000, Math.round((2026 - year) * int(9_000, 22_000) * (chance(0.25) ? 0.55 : 1) / 500) * 500);
  const area = pick(AREAS);
  const dealer = pick(DEALERS);
  const trim = pick(cat.trims);
  const engine = pick(cat.engines);

  const gradeRoll = rnd();
  const verificationGrade = upgraded || gradeRoll > 0.62 ? 'certified' : gradeRoll > 0.28 ? 'field_checked' : 'network_listed';

  const documents = {
    customs_verified: condition !== 'new' ? chance(0.82) : chance(0.5),
    registration: chance(0.9),
    duty_sighted: condition === 'tokunbo' ? chance(0.78) : chance(0.4),
    tinted_permit: chance(0.35),
  };

  const daysOnMarket = int(1, 42);
  const publishedAt = new Date(Date.UTC(2026, 8, 30) - daysOnMarket * 86_400_000 + int(0, 20) * 3_600_000);
  // Appendix B: 14-day expiry with a refresh flow. Ops confirm live stock is
  // still available, which pushes expires_at forward — so live/reserved rows
  // are always in the future and the stale ones show the expiry behaviour.
  const expiresAt =
    status === 'live' || status === 'reserved'
      ? { sql: `DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${int(3, 20)} DAY)` }
      : new Date(publishedAt.getTime() + 14 * 86_400_000);
  const soldAt = soldDaysAgo === null ? null : new Date(Date.UTC(2026, 8, 30) - soldDaysAgo * 86_400_000);

  const stockNo = `HC-PH-${String(index).padStart(4, '0')}`;
  const slug = [year, slugify(cat.make), slugify(cat.model), slugify(trim), stockNo.toLowerCase()].join('-');

  const pricePosition = (() => {
    const bandLo = millions(lo);
    const bandHi = millions(hi);
    const price = millions(priceMillions);
    if (price < bandLo) return 'below';
    if (price > bandHi) return 'premium';
    return 'within';
  })();

  const listing = {
    id: index,
    stockNo,
    status,
    verificationGrade,
    make: cat.make,
    model: cat.model,
    year,
    trim,
    body: cat.body,
    transmission: cat.make === 'Volkswagen' && chance(0.3) ? 'manual' : chance(0.88) ? 'automatic' : 'manual',
    fuel: cat.fuel,
    engine,
    drivetrain: cat.body === 'suv' || cat.body === 'pickup' ? pick(['fwd', 'awd', '4wd', 'rwd']) : pick(['fwd', 'rwd']),
    exterior: pick(['Pearl White', 'Black', 'Silver', 'Grey', 'Midnight Blue', 'Red', 'Champagne Gold', 'Ash']),
    interior: pick(['Black leather', 'Cream leather', 'Grey fabric', 'Black fabric']),
    condition,
    mileage,
    mileageVerified: verificationGrade !== 'network_listed' && chance(0.85),
    features: sample(FEATURES, int(6, 11)),
    price: millions(priceMillions),
    pricePosition,
    city: 'Port Harcourt',
    area,
    documents,
    floodCheck: chance(0.12) ? 'pass' : 'none',
    accidentFlag: chance(0.08) ? 'repaired' : 'none',
    description: DESCRIPTIONS[int(0, DESCRIPTIONS.length - 1)]
      .replace('{year}', year)
      .replace('{make}', cat.make)
      .replace('{model}', cat.model),
    honestNote: verificationGrade === 'certified' ? HONEST_NOTES[int(0, HONEST_NOTES.length - 1)] : null,
    inspection: verificationGrade === 'certified'
      ? {
          grade: 'A',
          obd2_codes: chance(0.75) ? 0 : int(1, 2),
          verdict: 'Passed HonestCars checklist',
          checked_on: new Date(Date.UTC(2026, 8, 30) - int(3, 25) * 86_400_000).toISOString().slice(0, 10),
          photos: sample(SHOTS, 6).map((s) => s.label),
        }
      : null,
    slug,
    priceMillions,
    dealer,
    publishedAt,
    expiresAt,
    soldAt,
    daysOnMarket,
    featured: chance(0.18) ? int(1, 3) : 0,
  };
  return listing;
}

/**
 * The clips available to listings (FR-24), from the generated manifest.
 *
 * The manifest is written by scripts/generate-videos.js, so a listing's video
 * label states the duration and size the file actually has.
 */
function videoManifest() {
  if (!videoManifest.cache) videoManifest.cache = require('../src/lib/video-manifest.json');
  return videoManifest.cache;
}

/**
 * The listing video (FR-24), for the cars that have one.
 *
 * Positioned last so it lands at the end of the gallery strip and never becomes
 * `primaryImage` — a card showing an <img> pointed at an .mp4 is exactly the bug
 * that would otherwise appear the moment a listing has a video.
 */
function listingVideo(listing) {
  const clip = { 'HC-PH-0032': '/video/inspection-walkaround.mp4', 'HC-PH-0068': '/video/flood-damage-check.mp4' }[listing.stockNo];
  if (!clip) return null;
  const info = videoManifest()[clip];
  if (!info) return null;
  return {
    listingId: listing.id,
    type: 'video',
    shotKey: 'walkaround',
    shotLabel: 'Walkaround video',
    url: clip,
    poster: info.poster,
    seconds: info.seconds,
    bytes: info.bytes,
    alt: `${listing.year} ${listing.make} ${listing.model} walkaround — video, ${info.seconds} seconds`,
    position: 99,
    width: 960,
    height: 540,
  };
}

/**
 * Gallery rows. Real photographs come first (public/img/cars + public/img/details,
 * resolved by seed-media.js); listings we have no photo for still get the honest
 * placeholder rather than a broken image.
 */
function mediaRows(listing) {
  const real = seedMedia.galleryFor(listing);

  const rows = real.map((shot, i) => {
    const label = seedMedia.SHOT_LABELS[shot.key] || 'Photo';
    return {
      listingId: listing.id,
      type: 'image',
      shotKey: shot.key,
      shotLabel: label,
      url: shot.url,
      alt: `${listing.year} ${listing.make} ${listing.model} ${listing.trim} — ${label.toLowerCase()} (${listing.area}, Port Harcourt)`,
      position: i,
      width: 1200,
      height: 900,
    };
  });

  const clip = listingVideo(listing);
  if (rows.length) return clip ? [...rows, clip] : rows;

  const shots = listing.verificationGrade === 'certified' ? SHOTS : sample(SHOTS, int(6, 8));
  const placeholders = shots.map((shot, i) => ({
    listingId: listing.id,
    type: 'image',
    shotKey: shot.key,
    shotLabel: shot.label,
    url: `/img/seed/${listing.body}-${shot.key}.svg`,
    alt: `${listing.year} ${listing.make} ${listing.model} ${listing.trim} — ${shot.label.toLowerCase()} (${listing.area}, Port Harcourt)`,
    position: i,
    width: 1200,
    height: 900,
  }));
  return clip ? [...placeholders, clip] : placeholders;
}

/**
 * `{ sql: '…' }` writes the expression through untouched. Used for anything
 * that must be relative to when the seed is loaded rather than when this
 * generator ran — listing expiry, above all: a frozen date silently turns
 * "live" stock into 404s the next day.
 */
function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object' && !(value instanceof Date) && typeof value.sql === 'string') return value.sql;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Date) return `'${value.toISOString().slice(0, 19).replace('T', ' ')}'`;
  if (typeof value === 'object') return `'${sqlEscape(JSON.stringify(value))}'`;
  return `'${sqlEscape(value)}'`;
}

function insert(table, columns, rows) {
  if (!rows.length) return '';
  const chunks = [];
  for (let i = 0; i < rows.length; i += 40) {
    const slice = rows.slice(i, i + 40);
    chunks.push(
      `INSERT INTO ${table} (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES\n` +
        slice.map((row) => `  (${row.map(sqlValue).join(', ')})`).join(',\n') +
        ';',
    );
  }
  return `\n-- ${table}: ${rows.length} rows\n${chunks.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
function build() {
  let id = 1;
  const listings = [];

  // 34 live
  for (let i = 0; i < 34; i += 1) listings.push(buildListing({ index: id++, status: 'live' }));
  // 3 reserved
  for (let i = 0; i < 3; i += 1) listings.push(buildListing({ index: id++, status: 'reserved' }));
  // 6 sold inside the 7-day visible window (badge on /cars, "Sold in N days")
  for (let i = 0; i < 6; i += 1) listings.push(buildListing({ index: id++, status: 'sold', soldDaysAgo: int(0, 6) }));
  // 4 in the 7→90 day archive window (sold-archive page, indexable)
  for (let i = 0; i < 4; i += 1) listings.push(buildListing({ index: id++, status: 'sold', soldDaysAgo: int(9, 80) }));
  // 3 past 90 days (must 301 to their facet)
  for (let i = 0; i < 3; i += 1) listings.push(buildListing({ index: id++, status: 'sold', soldDaysAgo: int(95, 200) }));
  // 2 non-public statuses
  listings.push(buildListing({ index: id++, status: 'draft' }));
  listings.push(buildListing({ index: id++, status: 'in_review' }));
  listings.push(buildListing({ index: id++, status: 'expired' }));

  // §7.2: Woji Car Mart (the seeded dealer login) needs a draft it can actually
  // submit, otherwise the portal's "send for review" path has nothing to show.
  // It belongs to the lot, has documents sighted, and the media pass gives it
  // photographs — so it clears the submission gate on the button.
  const wojiDraft = listings.find((row) => row.status === 'draft' && row.dealer && row.dealer.name === 'Woji Car Mart')
    || listings.find((row) => row.status === 'draft');
  wojiDraft.dealer = DEALERS.find((d) => d.name === 'Woji Car Mart');
  wojiDraft.documents = { ...wojiDraft.documents, registration: true, customs_verified: true };
  wojiDraft.honestNote = wojiDraft.honestNote || HONEST_NOTES[0];

  // Guarantee curation depth: force a certified, sub-₦15m SUV block for the
  // /cars/suv-under-15m facet and a Camry/Corolla block for /cars/toyota/*.
  const guarantees = [
    { make: 'Toyota', model: 'Camry', body: 'sedan', fuel: 'petrol', years: [2013, 2017], band: [8.5, 14.0], trims: ['LE', 'SE', 'XLE'], engines: ['2.5L I4'] },
    { make: 'Toyota', model: 'Corolla', body: 'sedan', fuel: 'petrol', years: [2014, 2018], band: [9.0, 15.0], trims: ['LE', 'S'], engines: ['1.8L I4'] },
    { make: 'Honda', model: 'CR-V', body: 'suv', fuel: 'petrol', years: [2013, 2016], band: [9.5, 14.5], trims: ['LX', 'EX'], engines: ['2.4L I4'] },
    { make: 'Toyota', model: 'RAV4', body: 'suv', fuel: 'petrol', years: [2012, 2016], band: [10.0, 14.8], trims: ['LE', 'XLE'], engines: ['2.5L I4'] },
    { make: 'Kia', model: 'Sportage', body: 'suv', fuel: 'petrol', years: [2015, 2017], band: [11.0, 14.6], trims: ['LX', 'EX'], engines: ['2.4L I4'] },
    { make: 'Nissan', model: 'X-Trail', body: 'suv', fuel: 'petrol', years: [2015, 2017], band: [12.5, 14.9], trims: ['SV'], engines: ['2.5L I4'] },
  ];
  for (let i = 0; i < 26; i += 1) {
    const cat = guarantees[i % guarantees.length];
    listings.push(buildListing({ index: id++, status: 'live', upgraded: chance(0.6), catalogEntry: cat }));
  }

  const media = listings.flatMap(mediaRows);

  // The Woji draft must clear its own submission gate (three photographs), or
  // the portal's "send for review" path is a button that can only fail.
  const draftMedia = media.filter((row) => row.listingId === wojiDraft.id);
  if (draftMedia.length < 3) {
    const used = new Set(draftMedia.map((row) => row.shotKey));
    let position = draftMedia.length;
    for (const shot of SHOTS) {
      if (draftMedia.length >= 3) break;
      if (used.has(shot.key)) continue;
      media.push({
        listingId: wojiDraft.id,
        type: 'image',
        shotKey: shot.key,
        shotLabel: shot.label,
        url: `/img/seed/${wojiDraft.body}-${shot.key}.svg`,
        alt: `${wojiDraft.year} ${wojiDraft.make} ${wojiDraft.model} ${wojiDraft.trim} — ${shot.label.toLowerCase()} (${wojiDraft.area}, Port Harcourt)`,
        position: position++,
        width: 1200,
        height: 900,
      });
      used.add(shot.key);
    }
  }

  return { listings, media };
}

function render({ listings, media }) {
  const now = "UTC_TIMESTAMP()";
  // FR-18: three lots, three of their own cars. Named here so the seed fails
  // loudly if the generator ever stops producing stock for them.
  const lotStock = (lotName, status) => {
    const dealerId = DEALERS.findIndex((d) => d.name === lotName) + 1;
    const car = listings.find((l) => DEALERS.indexOf(l.dealer) + 1 === dealerId && l.status === status);
    if (!car) throw new Error(`seed: no ${status} stock for ${lotName}`);
    return car.stockNo;
  };
  const featuredCar = lotStock('Aba Road Autos', 'live');
  const shootCar = lotStock('Woji Car Mart', 'live');
  const expiredCar = lotStock('Trans-Amadi Motors', 'live');
  const out = [];

  out.push(`-- ============================================================================
-- Honest Cars LTD — seed data (GENERATED FILE — do not edit by hand)
--   Regenerate: node scripts/generate-seed.js
--   Apply:      node scripts/db-setup.js
--
-- Synthetic but market-plausible Port Harcourt inventory: ${listings.length} listings
-- across ${DEALERS.length} partner lots, with media, price bands, curated facets,
-- services, testimonials, blog posts and FAQs.
-- ============================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';
SET @NOW = UTC_TIMESTAMP();

DELETE FROM analytics_events;
DELETE FROM marketing_spend;
-- Payments first: payment_events and dealer_ledger point at orders, bookings,
-- requests and listings, so they must go before any of those.
DELETE FROM payment_events;
DELETE FROM dealer_ledger;
DELETE FROM payments;
DELETE FROM payment_milestones;
DELETE FROM notifications;
DELETE FROM saved_cars;
DELETE FROM saved_searches;
DELETE FROM leads;
DELETE FROM listing_media;
DELETE FROM subscription_reminders;
DELETE FROM subscriptions;
DELETE FROM delivery_areas;
DELETE FROM order_items;
DELETE FROM orders;
DELETE FROM bookings;
DELETE FROM hire_incidents;
DELETE FROM hire_bookings;
DELETE FROM hire_vehicles;
DELETE FROM service_requests;
DELETE FROM products;
DELETE FROM hire_classes;
DELETE FROM pages;
DELETE FROM dealer_purchases;
DELETE FROM vehicle_listings;
DELETE FROM price_bands;
DELETE FROM facets;
DELETE FROM services;
DELETE FROM testimonials;
DELETE FROM blog_post_tags;
DELETE FROM blog_posts;
DELETE FROM blog_tags;
DELETE FROM blog_authors;
DELETE FROM homepage_modules;
DELETE FROM content_revisions;
DELETE FROM faqs;
DELETE FROM redirects;
DELETE FROM dealer_addons;
DELETE FROM dealers;
`);

  out.push(insert('dealers',
    ['id', 'name', 'slug', 'lot_area', 'city', 'tier', 'verified', 'agreement_signed'],
    DEALERS.map((d, i) => [i + 1, d.name, d.slug, d.area, 'Port Harcourt', d.tier, d.verified, new Date(Date.UTC(2026, 5, 1 + i))])));

  // FR-18 — the add-on catalogue the dealer portal sells from (§7.2). Each
  // `effect` is delivered by services/addons.applyPurchase when the money
  // lands; the console cannot offer a benefit no code delivers.
  out.push(insert('dealer_addons',
    ['id', 'slug', 'name', 'tagline', 'description', 'price_kobo', 'interval', 'effect', 'duration_days', 'needs_listing', 'is_active', 'position'],
    [
      [1, 'media-shoot', 'Media shoot', 'A photographer and a 25-shot set for one car, shot at your lot.',
        'Front three-quarter, rear, interior, dashboard, odometer and engine bay to the same shot list the portal wizard asks you for. Delivered as web-sized photos plus a 15-second walkaround clip.',
        4500000, 'one_off', 'media_shoot', null, 1, 1, 10],
      [2, 'featured-placement', 'Featured placement', 'Thirty days of featured placement on one listing.',
        'The car leads the /cars grid and the homepage featured rail for the paid window. It is ranked by the same featured_rank column the ops desk uses, so nothing about it is a separate promise.',
        3000000, 'one_off', 'featured_placement', 30, 1, 1, 20],
      [3, 'market-intelligence', 'Market intelligence', 'The monthly price-band and demand report for your segments.',
        'Every month: what your models actually sold for in Port Harcourt, which bands are moving, and which of your cars are priced above the market. Billed monthly, cancel any time.',
        2500000, 'monthly', 'intelligence', null, 0, 1, 30],
    ]));

  out.push(insert('vehicle_listings',
    ['id', 'stock_no', 'dealer_id', 'status', 'verification_grade', 'make', 'model', 'year', 'trim',
      'body_type', 'transmission', 'fuel_type', 'engine_size', 'drivetrain', 'ext_colour', 'int_colour',
      'condition', 'mileage_km', 'mileage_verified', 'features', 'asking_price_kobo', 'negotiable',
      'price_position', 'city', 'area', 'documents', 'flood_check', 'accident_flag', 'description',
      'honest_note', 'inspection_summary', 'seo_slug', 'views', 'enquiries', 'saves',
      'published_at', 'expires_at', 'sold_at', 'featured_rank'],
    listings.map((l) => {
      const dealerId = DEALERS.indexOf(l.dealer) + 1;
      return [
        l.id, l.stockNo, dealerId, l.status, l.verificationGrade, l.make, l.model, l.year, l.trim,
        l.body, l.transmission, l.fuel, l.engine, l.drivetrain, l.exterior, l.interior,
        l.condition, l.mileage, l.mileageVerified, l.features, l.price, chance(0.7),
        l.pricePosition, l.city, l.area, l.documents, l.floodCheck, l.accidentFlag, l.description,
        l.honestNote, l.inspection, l.slug,
        // A draft the lot has not submitted yet has no traffic story to tell —
        // seeded views on an unpublished car would read as a bug in the portal.
        l.status === 'draft' ? 0 : int(40, 2400),
        l.status === 'draft' ? 0 : int(0, 26),
        l.status === 'draft' ? 0 : int(0, 180),
        l.publishedAt, l.expiresAt, l.soldAt, l.featured,
      ];
    })));

  out.push(insert('listing_media',
    ['id', 'listing_id', 'type', 'shot_label', 'duration_seconds', 'size_bytes', 'url', 'poster_url', 'alt_text', 'position', 'width', 'height'],
    media.map((m, i) => [
      i + 1, m.listingId, m.type, m.shotLabel,
      m.seconds || null, m.bytes || null,
      m.url, m.poster || null, m.alt, m.position, m.width, m.height,
    ])));

  // Price bands: one per catalog entry per year bucket + condition 'any'
  const bands = [];
  for (const cat of CATALOG) {
    for (let y = cat.years[0]; y <= cat.years[1]; y += 3) {
      const span = cat.years[1] - cat.years[0] || 1;
      const ratio = (y - cat.years[0]) / span;
      const lo = cat.band[0] + (cat.band[1] - cat.band[0]) * ratio * 0.85;
      const hi = lo + (cat.band[1] - cat.band[0]) * 0.22;
      // §7.3 asks for a weekly pass, so the demo opens with a real mix: most
      // bands are days old, some are overdue. All-stale would make the badge
      // meaningless — and all-fresh would hide the work the console exists for.
      const ageDays = chance(0.7) ? int(0, 5) : int(9, 34);
      const refreshed = new Date(Date.now() - ageDays * 86_400_000);
      bands.push([cat.make, cat.model, y, Math.min(y + 2, cat.years[1]), 'any', millions(lo), millions(hi), int(6, 40), refreshed]);
    }
  }
  out.push(insert('price_bands',
    ['make', 'model', 'year_from', 'year_to', 'condition', 'band_min_kobo', 'band_max_kobo', 'sample_size', 'refreshed_at'],
    bands));

  // Curated facet pages (§14.1) — the ONLY facet URLs that may be indexed.
  const facets = [
    ['toyota', 'make', null, 'Toyota cars for sale in Port Harcourt',
      'Toyota for sale in Port Harcourt',
      'Toyota is the default PH buy for a reason: parts on every street, mechanics who know the platform, and resale value that holds. Every car here is graded honestly — you can see which ones our inspectors have physically checked.',
      'Toyota Cars for Sale in Port Harcourt | HonestCars',
      'Browse verified Toyota cars for sale in Port Harcourt — Camry, Corolla, RAV4, Highlander, Hilux. Honest prices, inspection grades, no dealer games.',
      { make: 'Toyota' }, '/cars/toyota', 1, 10],
    ['toyota/camry', 'model', 'toyota', 'Toyota Camry for sale in Port Harcourt',
      'Toyota Camry in Port Harcourt',
      'The Camry is the safest first buy in Port Harcourt: comfortable, cheap to service, and easy to resell. Below is live Camry stock with mileage, documents status and our verification grade on each one.',
      'Toyota Camry for Sale in Port Harcourt | HonestCars',
      'Live Toyota Camry listings in Port Harcourt with honest prices, verified mileage and inspection grades. Compare 2010–2018 Camry stock before you travel.',
      { make: 'Toyota', model: 'Camry' }, '/cars/toyota/camry', 1, 11],
    ['toyota/corolla', 'model', 'toyota', 'Toyota Corolla for sale in Port Harcourt',
      'Toyota Corolla in Port Harcourt',
      'Corolla money is safe money in PH. Fuel is light, parts are cheap, and a well-kept example will not embarrass you. We list the mileage as it is — verified where an inspector has seen the odometer.',
      'Toyota Corolla for Sale in Port Harcourt | HonestCars',
      'Toyota Corolla listings in Port Harcourt with verified mileage, document status and honest condition notes. Prices from the live PH market.',
      { make: 'Toyota', model: 'Corolla' }, '/cars/toyota/corolla', 1, 12],
    ['honda', 'make', null, 'Honda cars for sale in Port Harcourt',
      'Honda for sale in Port Harcourt',
      'Hondas hold their value in Port Harcourt and the Accord and CR-V are the two we see most. Check the grade on each listing — Certified means we scanned it ourselves and wrote down what we found.',
      'Honda Cars for Sale in Port Harcourt | HonestCars',
      'Browse Honda cars for sale in Port Harcourt — Accord, CR-V, Civic, Pilot. Verified grades, real mileage, honest condition notes.',
      { make: 'Honda' }, '/cars/honda', 1, 20],
    ['honda/accord', 'model', 'honda', 'Honda Accord for sale in Port Harcourt',
      'Honda Accord in Port Harcourt',
      'The Accord gives you Camry comfort with a bit more presence. Service costs are close, parts are available around Ikwerre Road and Rumuokoro. Ask us for the history on any car below.',
      'Honda Accord for Sale in Port Harcourt | HonestCars',
      'Honda Accord listings in Port Harcourt with honest prices, mileage and verification grades. Compare before you call.',
      { make: 'Honda', model: 'Accord' }, '/cars/honda/accord', 1, 21],
    ['lexus', 'make', null, 'Lexus cars for sale in Port Harcourt',
      'Lexus for sale in Port Harcourt',
      'Lexus money buys you Toyota reliability with a quieter cabin. Fuel and suspension parts cost more than a Camry, so we flag anything the inspector found before you commit.',
      'Lexus Cars for Sale in Port Harcourt | HonestCars',
      'Verified Lexus listings in Port Harcourt — RX 350, ES 350, GX 460. Real prices, inspection grades and document status on every car.',
      { make: 'Lexus' }, '/cars/lexus', 1, 30],
    ['suv-under-15m', 'body_budget', null, 'SUVs under ₦15m in Port Harcourt',
      'SUVs under ₦15m in Port Harcourt',
      'Family height and Abuja-road confidence do not have to start at ₦20m. Everything here is under ₦15,000,000 and every price is the price — what you see is what the dealer is asking.',
      'SUVs Under ₦15m in Port Harcourt | HonestCars',
      'SUVs under ₦15 million in Port Harcourt — RAV4, CR-V, Sportage, X-Trail and more, with mileage, documents and verification grades.',
      { body_type: 'suv', max_price_kobo: 1_500_000_000 }, '/cars/suv-under-15m', 1, 40],
    ['suv-under-25m', 'body_budget', null, 'SUVs under ₦25m in Port Harcourt',
      'SUVs under ₦25m in Port Harcourt',
      'This is the sweet spot for a PH family: newer RAV4, Highlander and Santa Fe money. Compare the certified ones first — the inspection report tells you what the photos will not.',
      'SUVs Under ₦25m in Port Harcourt | HonestCars',
      'SUVs under ₦25 million in Port Harcourt with verified mileage, inspection grades and honest condition notes.',
      { body_type: 'suv', max_price_kobo: 2_500_000_000 }, '/cars/suv-under-25m', 1, 41],
    ['sedan-under-10m', 'body_budget', null, 'Sedans under ₦10m in Port Harcourt',
      'Sedans under ₦10m in Port Harcourt',
      'Clean, sensible saloon cars under ₦10m — mostly Camry, Corolla, Elantra and Altima. Good for a first car, better for a daily commute through Rumuokoro.',
      'Sedans Under ₦10m in Port Harcourt | HonestCars',
      'Sedans under ₦10 million in Port Harcourt — Camry, Corolla, Elantra, Altima. Honest prices, grades and mileage.',
      { body_type: 'sedan', max_price_kobo: 1_000_000_000 }, '/cars/sedan-under-10m', 1, 42],
    ['certified', 'tag', null, 'HonestCars-Certified cars in Port Harcourt',
      'HonestCars-Certified cars in Port Harcourt',
      'These are the cars our inspectors have scanned, driven and photographed themselves — with an honest condition note on each listing that names the faults instead of hiding them.',
      'HonestCars-Certified Cars in Port Harcourt | HonestCars',
      'Every HonestCars-Certified car in Port Harcourt: OBD2 scan, documents sighted, road test, honest condition note. Browse the fully inspected stock.',
      { grade: 'certified' }, '/cars/certified', 1, 50],
  ];
  out.push(insert('facets',
    ['slug', 'page_type', 'parent_slug', 'h1', 'title', 'intro_copy', 'meta_title', 'meta_description', 'rules', 'canonical_path', 'indexable', 'position'],
    facets));

  // “from ₦25,000” → 2500000 kobo, so pricing tiers carry structured prices as
  // well as their display string (§12.4 Service Offers).
  const priceKobo = (text) => {
    const match = String(text || '').replace(/,/g, '').match(/₦\s*(\d+)(?:\.(\d{1,2}))?/);
    if (!match) return null;
    return Number(match[1]) * 100 + Number((match[2] || '0').padEnd(2, '0'));
  };

  // §6.7 — the suite, each with its full service-page template content.
  const services = [
    ['inspection', 'Pre-Purchase Inspection', 'An inspector stands next to the car, scans it and tells you the truth before you pay.', 'search-check', 2_500_000, 'Book inspection', 10],
    ['concierge', 'Find-My-Car Concierge', 'Tell us the brief once. We bring up to 3 verified, inspected options in 48–72 hours.', 'compass', 5_000_000, 'Start my search', 20],
    ['documents', 'Customs & Document Services', 'Customs verification, registration, licence renewal, tinted permit and insurance — handled.', 'file-check', 3_000_000, 'Request service', 30],
    ['sell-swap', 'Sell or Swap Your Car', 'Free valuation within 24 hours from live network data, then we sell or swap it.', 'repeat', null, 'Get valuation', 40],
    ['tracking', 'Car Tracking & Security', 'Standard, Premium and Fleet tracker bundles installed in Port Harcourt, with renewal handled.', 'shield', 4_500_000, 'See bundles', 50],
    ['hire', 'Car Hire', 'Daily, weekly and corporate hire with or without a driver — airport pickup available.', 'car', null, 'Request quote', 60],
    ['research', 'Research & Reports', 'TCO reports, auction sourcing analysis and market price checks, delivered in 48–72 hours.', 'bar-chart', 3_500_000, 'Order a report', 70],
    ['consultation', 'Paid Consultation', '30 minutes with someone who buys cars in Port Harcourt for a living. Bring your shortlist.', 'video', 1_000_000, 'Book 30 minutes', 80],
    ['parts', 'Spare-Parts Sourcing', 'VIN-matched parts sourced with escrow-protected milestone payment — not guesswork.', 'package', null, 'Request a part', 90],
    ['dealer-services', 'B2B: Dealer Services', 'Media shoots, featured placement and market intelligence for lots in Port Harcourt.', 'store', null, 'See packages', 100],
  ];
  out.push(insert('services',
    ['slug', 'name', 'promise', 'icon', 'from_price_kobo', 'cta_label', 'position', 'is_active',
      'hero_copy', 'deliverables', 'included', 'excluded', 'steps', 'pricing', 'proof', 'jobs_done', 'booking_kind', 'sla_copy'],
    services.map((s) => {
      const page = CONTENT.SERVICES[s[0]] || {};
      return [
        s[0], s[1], s[2], s[3], s[4], s[5], s[6], 1,
        page.hero_copy || s[2],
        page.deliverables || [],
        page.included || [],
        page.excluded || [],
        page.steps || [],
        (page.pricing || []).map((tier) => ({ ...tier, price_kobo: priceKobo(tier.price) })),
        page.proof || [],
        page.jobs_done || 0,
        page.booking_kind || 'request',
        page.sla_copy || null,
      ];
    })));

  // §6.10 — CMS pages: company, trust and legal.
  const pageRows = Object.entries(CONTENT.PAGES).map(([slug, page]) => [
    slug, page.title, page.h1, page.hero || null, page.metaTitle, page.metaDescription,
    page.body || [], page.legal ? 0 : 1, page.legal ? 1 : 0,
  ]);
  out.push(insert('pages',
    ['slug', 'title', 'h1', 'hero_copy', 'meta_title', 'meta_description', 'body', 'indexable', 'legal_review'],
    pageRows));

  // §6.7 /hire — vehicle classes.
  out.push(insert('hire_classes',
    ['slug', 'name', 'seats', 'examples', 'image', 'daily_rate_kobo', 'weekly_rate_kobo', 'with_driver_kobo', 'airport_pickup', 'corporate', 'position'],
    CONTENT.HIRE_CLASSES.map((c) => [c.slug, c.name, c.seats, c.examples, seedMedia.hirePhoto(c.slug), millions(c.daily / 1_000_000), c.weekly ? millions(c.weekly / 1_000_000) : null, c.driver ? millions(c.driver / 1_000_000) : null, c.airport, c.corporate, c.position])));

  // §6.8 — shop products.
  out.push(insert('products',
    ['slug', 'category', 'name', 'summary', 'description', 'price_kobo', 'specs', 'install_included', 'warranty_text', 'stock_status', 'delivery_options', 'image', 'position', 'is_active'],
    CONTENT.PRODUCTS.map((prod) => [
      prod.slug, prod.category, prod.name, prod.summary, prod.description,
      millions(prod.price / 1_000_000), prod.specs || [], prod.install, prod.warranty, prod.stock,
      prod.options || [], seedMedia.photo('shop', prod.slug) || prod.image, prod.position, 1,
    ])));

  // Demo operational record so the concierge status page can be reviewed.
  const demo = CONTENT.DEMO_REQUEST;
  out.push(insert('service_requests',
    ['tracking_id', 'type', 'status', 'name', 'phone', 'brief', 'sla_due_at', 'source_path', 'notes'],
    [[demo.trackingId, demo.type, demo.status, demo.name, demo.phone, demo.brief,
      new Date(Date.UTC(2026, 9, 1) + demo.slaHours * 3_600_000), '/find-my-car', demo.notes]]));

  const testimonials = [
    ['Chidi O.', 'Woji', 'They told me the Camry I liked had a resprayed boot lid before I paid for the inspection. No other lot would have said that. I bought it anyway, with my eyes open.', 'inspection', 5],
    ['Mrs. Amadi', 'GRA Phase 2', 'I sent my brief on WhatsApp at night and had three inspected options by Thursday. The swap was handled end to end — I only showed up to sign.', 'concierge', 5],
    ['Emeka N.', 'Rumuokoro', 'The tracker was installed in my compound and the renewal reminder came before I even thought about it. Small thing, but it means they are watching.', 'tracking', 5],
    ['Tunde A.', 'Trans-Amadi', 'Documents were the part I dreaded. Customs verification and registration were done in nine days and I got updates without chasing anybody.', 'documents', 5],
    ['Ngozi I.', 'Peter Odili Road', 'I have bought two cars through HonestCars. The second one they talked me out of a bad buy and into a better one. That is why I came back.', 'sell-swap', 5],
    ['Fleet officer, oil & gas firm', 'Port Harcourt', 'We needed four hire vehicles for a two-week rotation with proper invoices. Quote, paperwork and tracking proposals all arrived in one day.', 'hire', 5],
  ];
  out.push(insert('testimonials',
    ['customer_name', 'area', 'quote', 'service_tag', 'rating', 'position', 'is_published'],
    testimonials.map((t, i) => [t[0], t[1], t[2], t[3], t[4], i + 1, 1])));

  const posts = [
    ['2015-toyota-camry-honest-buyers-guide', "The 2015 Toyota Camry: what ₦12m actually buys in Port Harcourt", 'honest_buyers_guide',
      'We put a 2015 Camry through the full checklist and wrote down everything — the good, the tired and the priced-in.',
      '2015 Toyota Camry inspection in Port Harcourt', 'Raph Nicks', 'Head of Inspections', 9, 1],
    ['tokunbo-vs-nigerian-used-ph', 'Tokunbo vs Nigerian-used: the honest maths for Port Harcourt buyers', 'market_intel',
      'A cheaper import is not always cheaper. Here is the running-cost maths we run for buyers before they commit.',
      'Comparing tokunbo and Nigerian-used cars in Port Harcourt', 'Ada George', 'Market Analyst', 7, 0],
    ['odometer-fraud-check-yourself', 'How to check an odometer yourself before you pay a deposit', 'honest_buyers_guide',
      'Seven checks anyone can do in ten minutes, plus the two tricks dealers use to reset a mileage that still fool buyers.',
      'Odometer close-up during a HonestCars inspection', 'Raph Nicks', 'Head of Inspections', 6, 0],
    ['customs-papers-explained', 'Customs papers, explained without the jargon', 'ownership_maintenance',
      'What "duty sighted" really means, what happens if papers are missing, and how to verify them yourself.',
      'Verifying customs documents for a car in Port Harcourt', 'Chinelo U.', 'Documentation Lead', 8, 0],
    ['ph-fuel-cost-by-model', 'What 100km really costs in PH traffic, by model', 'market_intel',
      'We tracked real consumption on Camry, Corolla, CR-V, RX 350 and Hilux over the same Aba Road run.',
      'Fuel economy comparison chart for Port Harcourt cars', 'Ada George', 'Market Analyst', 5, 0],
    ['tyres-you-should-walk-away-from', 'Three tyre conditions that should end your inspection', 'honest_buyers_guide',
      'Uneven wear tells you more about a car than the dealer ever will. What to look for and what it costs to fix.',
      'Tyres and tread depth check on a used car', 'Raph Nicks', 'Head of Inspections', 4, 0],
    // §16 asks for 8 posts and 3 embedded videos. The clips live in the four
    // posts above and this pair below; the last one is the video-first post
    // FR-24 names (category `video`).
    ['first-car-under-10m-port-harcourt', 'Your first car under ₦10m in Port Harcourt', 'honest_buyers_guide',
      'What ₦6m–₦10m buys right now, the four cars we would shortlist, and the three costs nobody puts on the windscreen.',
      'A first car parked on a Port Harcourt street', 'Ada George', 'Market Analyst', 6, 0],
    ['inspection-walkaround-video', 'Watch a HonestCars inspection, start to finish', 'video',
      'Twelve seconds of the 45-minute checklist every car goes through before it reaches you.',
      'An inspector filming the walkaround on a silver sedan', 'Raph Nicks', 'Head of Inspections', 3, 0],
  ];
  // FR-35 — the byline as an entity (§6.9 “author card ... E-E-A-T”). One row
  // per writer: the post keeps `author_name/role/bio` as the printed byline,
  // `author_id` is the link that makes /blog/author/{slug} possible.
  const AUTHORS = [
    ['raph-nicks', 'Raph Nicks', 'Head of Inspections',
      'Raph leads HonestCars inspections in Port Harcourt. He has inspected more than 600 used cars and has talked more buyers out of bad ones than into them.'],
    ['ada-george', 'Ada George', 'Market Analyst',
      'Ada runs market intelligence at HonestCars, building the price bands behind every listing.'],
    ['chinelo-u', 'Chinelo U.', 'Documentation Lead',
      'Chinelo leads documentation at HonestCars, handling customs verification, registration and permits across Rivers State.'],
  ];
  out.push(insert('blog_authors', ['id', 'slug', 'name', 'role', 'bio'], AUTHORS.map((row, i) => [i + 1, ...row])));

  // FR-35 — the governed tag list (“categories fixed, tags governed”). Make
  // tags match `make_tags` so a tag page and the live-listing module agree.
  const TAGS = [
    ['buying', 'Buying', 'topic', 'Choosing a car, reading a seller, and the questions to ask before money moves.'],
    ['inspection', 'Inspection', 'topic', 'What our inspectors look at, in the order they look at it — and what a report can miss.'],
    ['paperwork', 'Paperwork & customs', 'topic', 'Customs duty, registration, change of ownership and the order of operations.'],
    ['running-costs', 'Running costs', 'topic', 'Fuel, servicing, insurance and what a car really costs per year in Port Harcourt.'],
    ['mileage', 'Mileage & odometer', 'topic', 'Reading wear instead of believing a number on a dashboard.'],
    ['tyres', 'Tyres', 'topic', 'The fastest read on how a car has been driven and maintained.'],
    ['first-car', 'First car', 'topic', 'Buying your first car in Nigeria without a story to tell afterwards.'],
    ['maintenance', 'Maintenance', 'topic', 'Keeping a Nigerian used car on the road.'],
    ['toyota', 'Toyota', 'make', 'Toyotas we have inspected, priced and written about — the safest default in this market.'],
    ['honda', 'Honda', 'make', 'Hondas in Port Harcourt: what holds value and what to check.'],
    ['lexus', 'Lexus', 'make', 'Lexus SUVs and sedans: the running costs nobody mentions at the point of sale.'],
    ['video-guide', 'Video guides', 'format', 'Short clips from real inspections — the checks, run on a real car.'],
    ['market-report', 'Market reports', 'format', 'What the Port Harcourt market is actually doing this quarter, priced from live deals.'],
  ];
  out.push(insert('blog_tags', ['id', 'slug', 'label', 'kind', 'description'], TAGS.map((row, i) => [i + 1, ...row])));

  // post slug → the authors and tags it carries.
  const POST_BYLINE = {
    '2015-toyota-camry-honest-buyers-guide': ['raph-nicks', ['toyota', 'buying', 'maintenance']],
    'tokunbo-vs-nigerian-used-ph': ['ada-george', ['buying', 'paperwork', 'market-report']],
    'odometer-fraud-check-yourself': ['raph-nicks', ['mileage', 'inspection']],
    'customs-papers-explained': ['chinelo-u', ['paperwork', 'buying']],
    'ph-fuel-cost-by-model': ['ada-george', ['running-costs', 'toyota', 'honda', 'market-report']],
    'tyres-you-should-walk-away-from': ['raph-nicks', ['tyres', 'inspection']],
    'first-car-under-10m-port-harcourt': ['ada-george', ['first-car', 'buying', 'market-report']],
    'inspection-walkaround-video': ['raph-nicks', ['inspection', 'video-guide']],
  };

  out.push(insert('blog_posts',
    ['id', 'slug', 'title', 'category', 'excerpt', 'hero_image', 'hero_alt', 'author_name', 'author_role', 'read_minutes',
      'status', 'published_at', 'is_featured', 'make_tags', 'body', 'service_cta', 'author_bio', 'author_id',
      'meta_title', 'meta_description'],
    posts.map((p, i) => {
      const content = CONTENT.POST_BODIES[p[0]] || {};
      const hero = seedMedia.blogHero(p[0]) || '/img/seed/og-default.svg';
      const byline = POST_BYLINE[p[0]] || ['raph-nicks', []];
      return [i + 1, p[0], p[1], p[2], p[3], hero, p[4], p[5], p[6], p[7], 'published',
        new Date(Date.UTC(2026, 8, 28) - i * 4 * 86_400_000), p[8],
        JSON.stringify(p[2] === 'market_intel' ? ['Toyota', 'Honda'] : ['Toyota']),
        content.body || [], content.serviceCta || null, content.authorBio || null,
        AUTHORS.findIndex((row) => row[0] === byline[0]) + 1,
        content.metaTitle || null, content.metaDescription || null];
    })));

  // FR-35 — which posts carry which tags.
  const tagRows = [];
  posts.forEach((p, i) => {
    const byline = POST_BYLINE[p[0]] || ['raph-nicks', []];
    for (const slug of byline[1]) tagRows.push([i + 1, TAGS.findIndex((row) => row[0] === slug) + 1]);
  });
  out.push(insert('blog_post_tags', ['post_id', 'tag_id'], tagRows));

  // §7.3 CMS: the homepage modules the console owns. Counters hold labels,
  // never numbers, so a published figure can never go stale.
  out.push(`INSERT INTO homepage_modules (\`key\`, title, payload, is_active, position) VALUES
  ('hero', 'Homepage hero', JSON_OBJECT('headline', NULL, 'subhead', NULL), 0, 10),
  ('announcement', 'Marketing banner', JSON_OBJECT(
     'text', 'Free inspection on any car over \u20a620m booked before the end of the month.',
     'label', 'Book a slot', 'href', '/services/inspection'), 0, 20),
  ('counters', 'Trust counter labels', JSON_OBJECT(
     'note', 'Counts stay live from the database. Edit the wording only.',
     'labels', JSON_OBJECT(
       'carsLive', 'cars live in the network',
       'partnerDealers', 'partner dealers in PH',
       'certified', 'HonestCars-Certified cars',
       'carsSold90d', 'deals closed in 90 days')), 1, 30),
  ('featured', 'Featured rail', JSON_OBJECT(
     'heading', 'Featured this week',
     'subheading', 'Hand-picked by the ops desk. Every one of them has been inspected.',
     'listing_slugs', JSON_ARRAY(), 'service_slugs', JSON_ARRAY()), 0, 40)
ON DUPLICATE KEY UPDATE \`key\` = \`key\`;`);

  const faqRows = [];
  for (const [scope, items] of Object.entries({ ...FAQS, ...CONTENT.FAQS })) {
    items.forEach(([q, a], i) => faqRows.push([scope, q, a, i + 1, 1]));
  }
  out.push(insert('faqs', ['scope', 'question', 'answer', 'position', 'is_active'], faqRows));

  // §6.8 delivery-fee rules by area (admin table).
  out.push(insert('delivery_areas',
    ['name', 'fee_kobo', 'note', 'position', 'is_active'],
    CONTENT.DELIVERY_AREAS.map((area) => [area.name, millions(area.fee / 1_000_000), area.note, area.position, 1])));

  // Sold-archive hand-off: >90-day sales map to their facet (§14.1).
  const expired = listings.filter((l) => l.status === 'sold' && l.soldAt && (Date.UTC(2026, 8, 30) - l.soldAt.getTime()) / 86_400_000 > 90);
  out.push(insert('redirects', ['from_path', 'to_path', 'status_code', 'reason'],
    expired.map((l) => [`/cars/${l.slug}`, `/cars/${slugify(l.make)}`, 301, 'sold_archive_90_days'])));

  // -------------------------------------------------------------------------
  // §7.3 console: staff accounts, then the operational day the console opens
  // onto — a moderation queue, a CRM-lite pipeline with an SLA that has
  // already been missed, a concierge request with cars attached to it, and a
  // dispatch sheet with jobs for the inspector. Timestamps are relative to
  // now, so the console looks alive whenever the seed is loaded.
  // -------------------------------------------------------------------------
  out.push(`
-- Staff accounts for the pilot (§7.4). Sign in at /login with the number,
-- then open /admin. Nothing here is a password: access is by OTP.
INSERT INTO \`users\` (phone, name, role, referral_code, status) VALUES
  ('+2348000000001', 'Admin — Honest Cars', 'admin',     'HCADMN', 'active'),
  ('+2348000000002', 'Ops Desk',            'ops',       'HCSTFF', 'active'),
  ('+2348000000003', 'Field Inspector',     'inspector', 'HCINSP', 'active'),
  ('+2348000000004', 'Finance Desk',        'finance',   'HCFINC', 'active'),
  ('+2348000000005', 'Content Desk',        'marketing', 'HCMKTG', 'active'),
  ('+2348000000006', 'Woji Car Mart',       'dealer',    'HCWOJI', 'active'),
  ('+2348000000007', 'Aba Road Autos',      'dealer',    'HCABAR', 'active')
ON DUPLICATE KEY UPDATE role = VALUES(role), name = VALUES(name), status = 'active';

-- The CRM-lite inbox (§7.3): every one of these came in through a real form.
INSERT INTO leads (type, listing_id, name, phone, message, preferred_day, source_path, status,
                   assigned_to, assigned_at, last_contacted_at, lost_reason, created_at) VALUES
  ('viewing', (SELECT id FROM vehicle_listings WHERE stock_no = 'HC-PH-0018' LIMIT 1),
    'Chidi Okafor', '+2348031110001', 'Please can I see the Prado this Saturday? I am in Woji.',
    DATE_ADD(UTC_DATE(), INTERVAL 3 DAY), '/cars/2016-toyota-prado-tx-hc-ph-0018', 'new',
    NULL, NULL, NULL, NULL, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 HOUR)),
  ('viewing', (SELECT id FROM vehicle_listings WHERE stock_no = 'HC-PH-0032' LIMIT 1),
    'Blessing Etim', '+2348031110002', 'Is the Camry still available? What is the lowest price you will take?',
    DATE_ADD(UTC_DATE(), INTERVAL 1 DAY), '/cars/2010-toyota-camry-le-hc-ph-0032', 'contacted',
    (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 HOUR),
    DATE_SUB(UTC_TIMESTAMP(), INTERVAL 6 HOUR), NULL, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 26 HOUR)),
  ('concierge', NULL, 'Ngozi Ibe', '+2348031110003',
    'Looking for an automatic SUV under ₦20m for a family of five. Must have working AC.',
    NULL, '/find-my-car', 'viewing',
    (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY),
    DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY), NULL, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY)),
  ('b2b', NULL, 'Fleet officer, oil & gas firm', '+2348031110004',
    'We need four hire vehicles for a two-week rotation. Please quote with proper invoices and tracking.',
    NULL, '/hire', 'assigned',
    (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY),
    NULL, NULL, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY)),
  ('service', NULL, 'Mrs. Amadi', '+2348031110007', 'Do you sell the OBD2 scanner on its own?',
    NULL, '/shop', 'new', NULL, NULL, NULL, NULL, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 HOUR)),
  ('parts', NULL, 'Emeka Nwosu', '+2348031110005', 'Pre-purchase inspection for a car in Owerri — do you travel?',
    NULL, '/services/inspection', 'closed',
    (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 6 DAY),
    DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 DAY), NULL, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 6 DAY)),
  ('viewing', (SELECT id FROM vehicle_listings WHERE stock_no = 'HC-PH-0018' LIMIT 1),
    'Tunde Adeyemi', '+2348031110006', 'I want to swap my Corolla for something bigger.',
    NULL, '/sell-swap', 'lost',
    (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 8 DAY),
    DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY), 'Bought elsewhere — price', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 8 DAY)),
  ('deal_alert', NULL, 'Ifeoma Chukwu', '+2348031110008',
    'Please alert me when a 2017 or newer CR-V under ₦18m comes in.',
    NULL, '/cars', 'assigned',
    (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 DAY),
    NULL, NULL, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 DAY));

-- Service requests across the pipeline. HC-2482 is deliberately past its SLA.
INSERT INTO service_requests (tracking_id, type, status, name, phone, brief, sla_due_at, source_path,
                              notes, assigned_to, assigned_at, last_contacted_at) VALUES
  ('HC-2482', 'hire', 'new', 'Fleet officer, oil & gas firm', '+2348031110004',
    '{"vehicle_class":"suv","vehicles":4,"days":14,"with_driver":"yes","airport_pickup":"yes","corporate":"yes","location":"Woji yard, with driver change-over at the base"}',
    DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 HOUR), '/hire', 'Corporate rotation — needs an invoice.',
    NULL, NULL, NULL),
  ('HC-2483', 'sell', 'new', 'Uche Nnamdi', '+2348031110009',
    '{"make":"Honda","model":"Accord EX","year":2014,"mileage_km":148000,"condition":"nigerian_used","timeline":"asap"}',
    DATE_ADD(UTC_TIMESTAMP(), INTERVAL 18 HOUR), '/sell-swap', 'Wants a valuation inside 24 hours.',
    (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 HOUR), NULL),
  ('HC-2484', 'documents', 'searching', 'Tunde Adeyemi', '+2348031110006',
    '{"service":"customs_verification","vehicle":"Toyota Prado 2016","has_papers":true}',
    DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 HOUR), '/services/documents', NULL,
    (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY),
    DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 HOUR)),
  ('HC-2485', 'tracking', 'options_ready', 'Emeka Nwosu', '+2348031110005',
    '{"product":"tracker-standard","vehicle":"Toyota Corolla 2015","install_area":"Rumuokoro"}',
    DATE_ADD(UTC_TIMESTAMP(), INTERVAL 40 HOUR), '/services/tracking', 'Quoted standard unit + install.',
    (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY),
    DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)),
  ('HC-2486', 'consultation', 'closed', 'Mrs. Amadi', '+2348031110007',
    '{"topic":"first_car_buying","budget_min":6000000,"budget_max":9000000}', NULL, '/services/consultation',
    'Call held, brief sent afterwards.',
    (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 9 DAY),
    DATE_SUB(UTC_TIMESTAMP(), INTERVAL 8 DAY)),
  ('HC-2487', 'concierge', 'new', 'Boma George', '+2348031110010',
    '{"budget_min":15000000,"budget_max":22000000,"makes":["Toyota","Lexus"],"body_types":["suv"],"transmission":"automatic","must_haves":["reverse camera","service history"],"intended_use":"family","timeline":"one_month","financing":"no"}',
    DATE_ADD(UTC_TIMESTAMP(), INTERVAL 46 HOUR), '/find-my-car', NULL, NULL, NULL, NULL),
  ('HC-2488', 'concierge', 'viewings', 'Halima Yusuf', '+2348031110011',
    '{"budget_min":5000000,"budget_max":8000000,"makes":["Toyota","Honda"],"body_types":["sedan"],"transmission":"automatic","must_haves":["cold AC","clean papers"],"intended_use":"commute","timeline":"two_weeks","financing":"no"}',
    DATE_ADD(UTC_TIMESTAMP(), INTERVAL 12 HOUR), '/find-my-car', 'Two viewings booked for Thursday.',
    (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY),
    DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 HOUR));

-- The cars attached to the demo request: exactly what the buyer's comparison reads.
INSERT INTO request_candidates (request_id, listing_id, note, rank_no, added_by) VALUES
  ((SELECT id FROM service_requests WHERE tracking_id = 'HC-2481' LIMIT 1),
   (SELECT id FROM vehicle_listings WHERE stock_no = 'HC-PH-0032' LIMIT 1),
   'Cleanest papers of the three; two panels resprayed and priced in.', 1,
   (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1)),
  ((SELECT id FROM service_requests WHERE tracking_id = 'HC-2481' LIMIT 1),
   (SELECT id FROM vehicle_listings WHERE stock_no = 'HC-PH-0068' LIMIT 1),
   'The SUV alternative: same budget, more room, and the papers are clean.', 2,
   (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1)),
  ((SELECT id FROM service_requests WHERE tracking_id = 'HC-2481' LIMIT 1),
   (SELECT id FROM vehicle_listings WHERE stock_no = 'HC-PH-0066' LIMIT 1),
   'Newest of the three and still under the budget ceiling — worth the drive to see.', 3,
   (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1));

-- Dispatch sheet (§7.3): one job unassigned, one dispatched to our inspector
-- for 2pm today, one install booked, one consultation already filed.
INSERT INTO bookings (reference, type, service_slug, slot_at, location, vehicle, name, phone,
                      amount_kobo, payment_status, status, inspector_id, dispatched_at,
                      completed_at, checklist, verdict, report_notes, created_at) VALUES
  ('HC-BK-0001', 'inspection', 'inspection', DATE_ADD(UTC_DATE(), INTERVAL 1 DAY) + INTERVAL 10 HOUR,
    'Dealer lot, Trans-Amadi, Port Harcourt',
    '{"make":"Toyota","model":"Prado TX","year":2016,"mileage_km":96000}',
    'Chidi Okafor', '+2348031110001', 4500000, 'unpaid', 'requested', NULL, NULL, NULL, NULL, NULL, NULL,
    DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 HOUR)),
  ('HC-BK-0002', 'inspection', 'inspection', UTC_DATE() + INTERVAL 14 HOUR,
    'Customer compound, Woji, Port Harcourt',
    '{"make":"Toyota","model":"Camry LE","year":2010,"mileage_km":132000}',
    'Blessing Etim', '+2348031110002', 4500000, 'paid', 'dispatched',
    (SELECT id FROM \`users\` WHERE phone = '+2348000000003' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 HOUR),
    NULL, NULL, NULL, NULL, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)),
  ('HC-BK-0003', 'install', 'tracker', DATE_ADD(UTC_DATE(), INTERVAL 3 DAY) + INTERVAL 11 HOUR,
    'Honest Cars workshop, GRA Phase 2', '{"make":"Toyota","model":"Corolla","year":2015}',
    'Emeka Nwosu', '+2348031110005', 4500000, 'pending', 'confirmed', NULL, NULL, NULL, NULL, NULL, NULL,
    DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY)),
  ('HC-BK-0004', 'inspection', 'inspection', DATE_SUB(UTC_DATE(), INTERVAL 8 DAY) + INTERVAL 16 HOUR,
    'Dealer lot, Trans-Amadi, Port Harcourt',
    '{"make":"Toyota","model":"Prado TX","year":2016,"mileage_km":96000,"vin":"JTEHT05J402015882"}',
    'Mrs. Amadi', '+2348031110007', 4500000, 'paid', 'completed',
    (SELECT id FROM \`users\` WHERE phone = '+2348000000003' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 9 DAY),
    DATE_SUB(UTC_TIMESTAMP(), INTERVAL 8 DAY),
    CONCAT('{"sections":{"engine":"ok","transmission":"ok","suspension":"attention","brakes":"ok","electricals":"ok","body":"ok","documents":"ok"}',
      ',"obd2_codes":"none stored — no stored faults on the reader, battery healthy","photos":"11 photos filed against VIN JTEHT05J402015882"',
      ',"checked_on":"', DATE_FORMAT(DATE_SUB(UTC_DATE(), INTERVAL 8 DAY), '%Y-%m-%d'), '"}'),
    'pass_with_advisory',
    'Straight body, no accident repair found, and the VIN plate matches the documents. Rear suspension bushings are due within the year — budget about ₦180,000 — and the second key is missing. Everything else checked out; the client was briefed on running costs before deciding.',
    DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 DAY)),
  ('HC-BK-0005', 'inspection', 'inspection', DATE_SUB(UTC_DATE(), INTERVAL 2 DAY) + INTERVAL 9 HOUR,
    'Dealer lot, Aba Road', '{"make":"Honda","model":"Accord EX","year":2014}',
    'Uche Nnamdi', '+2348031110009', 4500000, 'refunded', 'cancelled', NULL, NULL, NULL, NULL, NULL,
    'Customer rescheduled — car was sold before we arrived.', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY));

-- ---------------------------------------------------------------------------
-- Money (§7.3 Orders & Payments). Deliberately *not* PSP transactions: no
-- Paystack/Flutterwave keys exist yet (merchant account is a §18 launch item),
-- so every seeded payment is a bank transfer or a manual entry — the same
-- records the console creates when a transfer lands on the statement.
-- ---------------------------------------------------------------------------
INSERT INTO payments (reference, provider, provider_ref, purpose, order_id, booking_id, request_id,
                      customer_name, customer_phone, amount_kobo, status, paid_at, refunded_at,
                      refund_kobo, refund_reason, created_by, created_at) VALUES
  ('HC-PAY-000001', 'manual', 'SEED-MANUAL-0001', 'order',
   (SELECT id FROM orders WHERE order_no = 'HC-ORD-0001' LIMIT 1), NULL, NULL,
   'Ada Okafor', '+2348031234567', 4500000, 'paid', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 DAY), NULL,
   0, NULL, (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1),
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 DAY)),
  ('HC-PAY-000002', 'bank_transfer', 'SEED-BT-0002', 'booking', NULL,
   (SELECT id FROM bookings WHERE reference = 'HC-BK-0002' LIMIT 1), NULL,
   'Blessing Etim', '+2348031110002', 4500000, 'paid', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY), NULL,
   0, NULL, (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1),
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY)),
  ('HC-PAY-000003', 'manual', NULL, 'booking', NULL,
   (SELECT id FROM bookings WHERE reference = 'HC-BK-0001' LIMIT 1), NULL,
   'Chidi Okafor', '+2348031110001', 4500000, 'pending', NULL, NULL,
   0, NULL, (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1),
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 HOUR)),
  ('HC-PAY-000004', 'bank_transfer', 'SEED-BT-0004', 'booking', NULL,
   (SELECT id FROM bookings WHERE reference = 'HC-BK-0005' LIMIT 1), NULL,
   'Uche Nnamdi', '+2348031110009', 4500000, 'refunded', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 6 DAY),
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY), 4500000,
   'Car was sold before we arrived — inspection fee returned in full.',
   (SELECT id FROM \`users\` WHERE phone = '+2348000000001' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 6 DAY)),
  ('HC-PAY-000005', 'bank_transfer', 'SEED-BT-0005', 'retainer', NULL, NULL,
   (SELECT id FROM service_requests WHERE tracking_id = 'HC-2481' LIMIT 1),
   'Demo buyer (seeded record)', '+2348030000000', 5000000, 'paid',
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 DAY), NULL, 0, NULL,
   (SELECT id FROM \`users\` WHERE phone = '+2348000000001' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 DAY));

INSERT INTO payment_events (payment_id, provider, event_id, type, signature_ok, payload, created_at) VALUES
  ((SELECT id FROM payments WHERE reference = 'HC-PAY-000001' LIMIT 1), 'manual', 'created:HC-PAY-000001', 'payment.created', NULL,
   '{"purpose":"order","amountKobo":4500000,"provider":"manual"}', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 DAY)),
  ((SELECT id FROM payments WHERE reference = 'HC-PAY-000001' LIMIT 1), 'manual', 'manual:HC-PAY-000001', 'manual.paid', NULL,
   '{"note":"Transfer seen on the GTBank statement, matched to HC-ORD-0001"}', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 DAY)),
  ((SELECT id FROM payments WHERE reference = 'HC-PAY-000002' LIMIT 1), 'bank_transfer', 'created:HC-PAY-000002', 'payment.created', NULL,
   '{"purpose":"booking","amountKobo":4500000,"provider":"bank_transfer"}', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY)),
  ((SELECT id FROM payments WHERE reference = 'HC-PAY-000002' LIMIT 1), 'bank_transfer', 'manual:HC-PAY-000002', 'bank_transfer.paid', NULL,
   '{"note":"Payment confirmed by ops before the inspector was dispatched"}', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY)),
  ((SELECT id FROM payments WHERE reference = 'HC-PAY-000003' LIMIT 1), 'manual', 'created:HC-PAY-000003', 'payment.created', NULL,
   '{"purpose":"booking","amountKobo":4500000,"provider":"manual"}', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 HOUR)),
  ((SELECT id FROM payments WHERE reference = 'HC-PAY-000004' LIMIT 1), 'bank_transfer', 'created:HC-PAY-000004', 'payment.created', NULL,
   '{"purpose":"booking","amountKobo":4500000,"provider":"bank_transfer"}', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 6 DAY)),
  ((SELECT id FROM payments WHERE reference = 'HC-PAY-000004' LIMIT 1), 'bank_transfer', 'manual:HC-PAY-000004', 'bank_transfer.paid', NULL,
   '{"note":"Transfer matched"}', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 6 DAY)),
  ((SELECT id FROM payments WHERE reference = 'HC-PAY-000004' LIMIT 1), 'bank_transfer', 'refund:HC-PAY-000004', 'payment.refunded', NULL,
   '{"amountKobo":4500000,"reason":"Car was sold before we arrived"}', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY)),
  ((SELECT id FROM payments WHERE reference = 'HC-PAY-000005' LIMIT 1), 'bank_transfer', 'created:HC-PAY-000005', 'payment.created', NULL,
   '{"purpose":"retainer","amountKobo":5000000,"provider":"bank_transfer"}', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 DAY)),
  ((SELECT id FROM payments WHERE reference = 'HC-PAY-000005' LIMIT 1), 'bank_transfer', 'manual:HC-PAY-000005', 'bank_transfer.paid', NULL,
   '{"note":"Concierge retainer for HC-2481, receipted to the buyer"}', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 DAY));

-- Escrow: one protected purchase waiting on documents, one already inspected,
-- one parts escrow that has only just received funds — the whole ladder.
INSERT INTO payment_milestones (reference, kind, subject, listing_id, booking_id, customer_name,
                                customer_phone, amount_kobo, stage, stage_note, released_by, released_at,
                                created_by, created_at) VALUES
  ('HC-ML-000001', 'protected_purchase', '2010 Toyota Camry LE — protected purchase deposit',
   (SELECT id FROM vehicle_listings WHERE stock_no = 'HC-PH-0032' LIMIT 1),
   (SELECT id FROM bookings WHERE reference = 'HC-BK-0004' LIMIT 1),
   'Blessing Etim', '+2348031110002', 50000000, 'inspection_passed',
   'Inspection passed 8 days ago with rear bushings noted — dealer re-quoted inside the band.',
   NULL, NULL, (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1),
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 12 DAY)),
  ('HC-ML-000002', 'protected_purchase', '2018 Infiniti QX60 — protected purchase deposit',
   (SELECT id FROM vehicle_listings WHERE stock_no = 'HC-PH-0045' LIMIT 1), NULL,
   'Uche Nnamdi', '+2348031110009', 75000000, 'documents_verified',
   'Customs and registration papers sighted and copied to the file — waiting on the buyer to confirm the pickup date.',
   NULL, NULL, (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1),
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 DAY)),
  ('HC-ML-000003', 'parts_escrow', 'Tracker + installation kit — HC-ORD-0001',
   NULL, NULL, 'Ada Okafor', '+2348031234567', 4500000, 'funds_received',
   'Funds received with the order — installation books a slot once the kit lands.',
   NULL, NULL, (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1),
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 DAY));

-- Messages (§11). WhatsApp and email have no provider configured in the demo,
-- so those rows are honestly 'skipped'; the console rows really were delivered.
INSERT INTO notifications (channel, template, recipient, subject, body, status, entity, entity_id, created_by, created_at) VALUES
  ('console', 'payment_receipt', '+2348031234567', NULL,
   'Payment received — thank you. ₦45,000 against HC-PAY-000001 (HC-ORD-0001). Your receipt is on your dashboard.',
   'sent', 'payment', (SELECT id FROM payments WHERE reference = 'HC-PAY-000001' LIMIT 1),
   (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 DAY)),
  ('whatsapp', 'payment_request', '+2348031110001', NULL,
   'Hello Chidi Okafor — your inspection is booked for tomorrow morning. Please send ₦45,000 to Honest Cars Ltd, 0123456789 (GTBank), using reference HC-PAY-000003 so we can match it.',
   'skipped', 'payment', (SELECT id FROM payments WHERE reference = 'HC-PAY-000003' LIMIT 1),
   (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 HOUR)),
  ('console', 'milestone_stage', '+2348031110002', NULL,
   'Escrow update — HC-ML-000001 moved to “inspection passed”. The deposit stays with us until the documents are verified and you release it.',
   'sent', 'milestone', (SELECT id FROM payment_milestones WHERE reference = 'HC-ML-000001' LIMIT 1),
   (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 8 DAY));

-- Dealer ledger (§7.2/§7.3). Signed amounts: positive is commission the dealer
-- owes us, negative is money we have paid out. Balances are never recomputed
-- away — a correction is another row.
INSERT INTO dealer_ledger (dealer_id, listing_id, payment_id, entry_type, amount_kobo, reference, detail, created_by, created_at) VALUES
  ((SELECT id FROM dealers WHERE name = 'Trans-Amadi Motors' LIMIT 1),
   (SELECT id FROM vehicle_listings WHERE stock_no = 'HC-PH-0045' LIMIT 1),
   (SELECT id FROM payments WHERE reference = 'HC-PAY-000002' LIMIT 1),
   'sale_commission', 25000000, 'STMT-2026-09',
   'Commission on the QX60 sale — agreed rate on the signed terms, statement STMT-2026-09.',
   (SELECT id FROM \`users\` WHERE phone = '+2348000000001' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 9 DAY)),
  ((SELECT id FROM dealers WHERE name = 'Trans-Amadi Motors' LIMIT 1), NULL, NULL,
   'payout', -15000000, 'PO-2026-09-14',
   'Payout sent by transfer — balance carried to October.',
   (SELECT id FROM \`users\` WHERE phone = '+2348000000001' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 DAY)),
  ((SELECT id FROM dealers WHERE name = 'Woji Car Mart' LIMIT 1),
   (SELECT id FROM vehicle_listings WHERE stock_no = 'HC-PH-0038' LIMIT 1),
   (SELECT id FROM payments WHERE reference = 'HC-PAY-000003' LIMIT 1),
   'sale_commission', 18000000, 'STMT-2026-09',
   'Commission on the GLE sale plus the tracking install — statement STMT-2026-09.',
   (SELECT id FROM \`users\` WHERE phone = '+2348000000001' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 8 DAY)),
  ((SELECT id FROM dealers WHERE name = 'Woji Car Mart' LIMIT 1), NULL, NULL,
   'payout', -10000000, 'PO-2026-09-20',
   'Part settlement of the September statement, sent by transfer.',
   (SELECT id FROM \`users\` WHERE phone = '+2348000000001' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 DAY)),
  ((SELECT id FROM dealers WHERE name = 'GRA Premium Motors' LIMIT 1),
   (SELECT id FROM vehicle_listings WHERE stock_no = 'HC-PH-0018' LIMIT 1), NULL,
   'sale_commission', 12000000, 'STMT-2026-09',
   'Commission on the Santa Fe sale, plus the two add-on installs.',
   (SELECT id FROM \`users\` WHERE phone = '+2348000000001' LIMIT 1), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY));

-- Three sensitive actions already on file, so the audit page is not blank on
-- first open. Everything the console does from here appends its own row.
INSERT INTO admin_audit (actor_id, action, entity, entity_id, detail, created_at) VALUES
  ((SELECT id FROM \`users\` WHERE phone = '+2348000000001' LIMIT 1), 'listing.grade', 'listing',
   (SELECT id FROM vehicle_listings WHERE stock_no = 'HC-PH-0032' LIMIT 1),
   '{"grade":"certified","note":"VIN, documents, OBD2 and road test all completed in person."}',
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY)),
  ((SELECT id FROM \`users\` WHERE phone = '+2348000000001' LIMIT 1), 'listing.price', 'listing',
   (SELECT id FROM vehicle_listings WHERE stock_no = 'HC-PH-0045' LIMIT 1),
   '{"note":"Dealer dropped ₦250k after the inspection found rear bushings due."}',
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)),
  ((SELECT id FROM \`users\` WHERE phone = '+2348000000001' LIMIT 1), 'listing.publish', 'listing',
   (SELECT id FROM vehicle_listings WHERE stock_no = 'HC-PH-0018' LIMIT 1),
   '{"grade":"certified"}', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 HOUR));

-- ---------------------------------------------------------------------------
-- The demo customer (§7.1). Ada can sign in on 08031234567 — in development
-- the code is printed to the server log — and see a populated dashboard.
-- This block belongs to the seed on purpose: \`db:setup\` truncates these
-- tables, so anything created by hand disappears on the next reseed.
-- ---------------------------------------------------------------------------
INSERT INTO \`users\` (phone, name, role, referral_code, status, marketing_opt_in) VALUES
  ('+2348031234567', 'Ada Okafor', 'customer', 'HCADA2', 'active', 1)
ON DUPLICATE KEY UPDATE name = VALUES(name), role = 'customer', status = 'active';

-- FR-25. Two saved cars: one watched at the price Ada saw (no pending alert),
-- and one whose price has already moved down since she saved it — which is
-- exactly what the sweep is for. Nothing here invents a price: the baseline on
-- the second row is the honest "what it was when she looked".
-- §7.2: link each dealer account to the lot it owns. One account, one lot —
-- uq_dealer_user enforces it, so a mistake here fails loudly rather than
-- letting two logins see the same stock.
UPDATE dealers SET user_id = (SELECT id FROM \`users\` WHERE phone = '+2348000000006' LIMIT 1),
                   agreement_ref = 'HCL-PA-2026-004', agreement_signed = '2026-03-14', commission_pct = 5.00
 WHERE name = 'Woji Car Mart';
UPDATE dealers SET user_id = (SELECT id FROM \`users\` WHERE phone = '+2348000000007' LIMIT 1),
                   agreement_ref = 'HCL-PA-2026-007', agreement_signed = '2026-04-02', commission_pct = 5.00
 WHERE name = 'Aba Road Autos';

-- §7.2 leads inbox: enquiries on one lot's stock (Woji Car Mart), across the
-- pipeline, so the dealer portal opens onto a working day rather than zeroes.
INSERT INTO leads (type, listing_id, name, phone, message, preferred_day, source_path, status,
                   assigned_to, assigned_at, last_contacted_at, lost_reason, created_at) VALUES
  ('viewing', (SELECT id FROM vehicle_listings WHERE stock_no = 'HC-PH-0008' LIMIT 1),
    'Emeka Ogbonna', '+2348032220001', 'Is the Pajero still available? I can come to Woji tomorrow morning.',
    DATE_ADD(UTC_DATE(), INTERVAL 1 DAY), '/cars/2014-mitsubishi-pajero-hc-ph-0008', 'new',
    NULL, NULL, NULL, NULL, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 HOUR)),
  ('viewing', (SELECT id FROM vehicle_listings WHERE stock_no = 'HC-PH-0025' LIMIT 1),
    'Blessing Nwosu', '+2348032220002', 'What is the lowest you will take on the Elantra? I am paying cash.',
    DATE_ADD(UTC_DATE(), INTERVAL 2 DAY), '/cars/2017-hyundai-elantra-hc-ph-0025', 'contacted',
    (SELECT id FROM \`users\` WHERE phone = '+2348000000006' LIMIT 1),
    DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 HOUR), NULL,
    DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY)),
  ('viewing', (SELECT id FROM vehicle_listings WHERE stock_no = 'HC-PH-0057' LIMIT 1),
    'Tunde Alabi', '+2348032220003', 'Does the RAV4 have full service history? Any accident on it?',
    NULL, '/cars/2014-toyota-rav4-hc-ph-0057', 'viewing',
    (SELECT id FROM \`users\` WHERE phone = '+2348000000006' LIMIT 1),
    DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY), NULL,
    DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 DAY)),
  ('viewing', (SELECT id FROM vehicle_listings WHERE stock_no = 'HC-PH-0064' LIMIT 1),
    'Ify Chukwu', '+2348032220004', 'I came to see the Sportage but the AC was not blowing cold.',
    NULL, '/cars/2017-kia-sportage-hc-ph-0064', 'lost',
    (SELECT id FROM \`users\` WHERE phone = '+2348000000006' LIMIT 1),
    DATE_SUB(UTC_TIMESTAMP(), INTERVAL 6 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 DAY),
    'AC not working — buyer walked away, told ops to fix before relisting.',
    DATE_SUB(UTC_TIMESTAMP(), INTERVAL 6 DAY)),
  -- The two customers who actually paid (§15.2): every payer has an enquiry
  -- behind them, and the dashboard credits the channel that produced it. A
  -- payment with no lead at all reads as "(unattributed)" — honest, but it is
  -- not how this business works, so the demo shows the real shape.
  ('concierge', NULL, 'Demo buyer (seeded record)', '+2348030000000',
    'Wants a family SUV, budget ₦25m, prefers something with service history.',
    NULL, '/find-my-car', 'closed',
    (SELECT id FROM \`users\` WHERE phone = '+2348000000002' LIMIT 1),
    DATE_SUB(UTC_TIMESTAMP(), INTERVAL 21 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 19 DAY),
    NULL, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 21 DAY)),
  ('viewing', (SELECT id FROM vehicle_listings WHERE stock_no = 'HC-PH-0029' LIMIT 1),
    'Ada Okafor', '+2348031234567', 'Do you have a tracker for this one? I want it installed before delivery.',
    NULL, '/cars/2015-toyota-corolla-hc-ph-0029', 'closed',
    (SELECT id FROM \`users\` WHERE phone = '+2348000000006' LIMIT 1),
    DATE_SUB(UTC_TIMESTAMP(), INTERVAL 14 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 12 DAY),
    NULL, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 14 DAY));

INSERT INTO saved_cars (user_id, listing_id, note, last_price_kobo) VALUES
  ((SELECT id FROM \`users\` WHERE phone = '+2348031234567' LIMIT 1),
   (SELECT id FROM vehicle_listings WHERE stock_no = 'HC-PH-0020' LIMIT 1),
   'Watching this one — asking about the service history',
   (SELECT asking_price_kobo FROM vehicle_listings WHERE stock_no = 'HC-PH-0020' LIMIT 1)),
  ((SELECT id FROM \`users\` WHERE phone = '+2348031234567' LIMIT 1),
   (SELECT id FROM vehicle_listings WHERE stock_no = 'HC-PH-0069' LIMIT 1),
   'Missed this one at the old price — watching it now',
   (SELECT asking_price_kobo FROM vehicle_listings WHERE stock_no = 'HC-PH-0069' LIMIT 1) + 20000000);

INSERT INTO saved_searches (user_id, label, query, alerts_enabled, alert_price_drop, alert_new_match, last_alerted_at) VALUES
  ((SELECT id FROM \`users\` WHERE phone = '+2348031234567' LIMIT 1),
   'Toyota SUVs under ₦15m', 'make=toyota&body=suv&max_price=15000000', 1, 1, 1,
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY));

INSERT INTO service_requests (tracking_id, type, status, name, phone, brief, sla_due_at, source_path, notes) VALUES
  ('HC-2490', 'hire', 'options_ready', 'Ada Okafor', '+2348031234567',
   JSON_OBJECT('vehicle_class', 'suv',
               'date_from', DATE_FORMAT(DATE_ADD(UTC_DATE(), INTERVAL 4 DAY), '%Y-%m-%d'),
               'date_to',   DATE_FORMAT(DATE_ADD(UTC_DATE(), INTERVAL 7 DAY), '%Y-%m-%d'),
               'days', 4, 'location', 'Omagwa arrivals',
               'airport_pickup', 'yes', 'addons', JSON_ARRAY('tracking')),
   DATE_ADD(UTC_TIMESTAMP(), INTERVAL 20 HOUR), '/hire', 'Four days with an SUV, airport pickup — the brief matches what /hire posts.');

INSERT INTO orders (order_no, name, phone, delivery_area, delivery_fee_kobo, subtotal_kobo, total_kobo, status, payment_ref, notes) VALUES
  ('HC-ORD-0001', 'Ada Okafor', '+2348031234567', 'GRA Phase 2', 0, 4500000, 4500000, 'paid', 'SEED-DEMO-0001',
   'Seeded demo order: tracker plus installation, with the receipt on her dashboard.');

INSERT INTO order_items (order_id, product_id, name, qty, unit_price_kobo, install_requested) VALUES
  ((SELECT id FROM orders WHERE order_no = 'HC-ORD-0001' LIMIT 1),
   (SELECT id FROM products WHERE slug = 'tracker-standard' LIMIT 1),
   'Tracker — Standard', 1, 4500000, 1);

-- FR-20. Five tracker subscriptions across the whole lifecycle, so every state
-- the console and the account screen can render is visible on a fresh seed:
--
--   #1  active, most of a year to run         nothing to do, shows the happy path
--   #2  9 days out                            inside the 30-day window, reminder pending
--   #3  2 days past the renewal date          inside the 7-day grace, still renewable
--   #4  40 days past, never renewed            lapsed — the queue's reason to exist
--   #5  paid, not yet fitted                   the activation checklist, mid-flight
--
-- amount_kobo is the renewal price and unit_label is the car the unit is in:
-- together they make a renewal quotable and a unit identifiable on a phone call. The renewal dates are anchored to the seed run, not to fixed calendar
-- dates, so the demo is never stale.
INSERT INTO subscriptions
  (kind, order_id, product_id, customer_name, customer_phone, unit_label, plan_name, amount_kobo,
   device_state, installed_at, activated_at, renewal_at, period_months)
VALUES
  ('tracker', (SELECT id FROM orders WHERE order_no = 'HC-ORD-0001' LIMIT 1),
   (SELECT id FROM products WHERE slug = 'tracker-standard' LIMIT 1),
   'Ada Okafor', '+2348031234567',
   '2016 Honda CR-V · ABC-123-PH', 'Tracker — Standard, 12 months', 4500000,
   'activated',
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 DAY),
   DATE_ADD(UTC_TIMESTAMP(), INTERVAL 355 DAY), 12),
  ('tracker', NULL,
   (SELECT id FROM products WHERE slug = 'tracker-standard' LIMIT 1),
   'Ada Okafor', '+2348031234567',
   '2019 Toyota Corolla · KJA-884-XA', 'Tracker — Standard, 12 months', 4500000,
   'activated',
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 361 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 361 DAY),
   DATE_ADD(UTC_TIMESTAMP(), INTERVAL 9 DAY), 12),
  ('tracker', NULL,
   (SELECT id FROM products WHERE slug = 'tracker-pro' LIMIT 1),
   'Ada Okafor', '+2348031234567',
   '2014 Lexus RX 350 · LSR-201-PH', 'Tracker Pro — 12 months', 6500000,
   'activated',
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 367 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 367 DAY),
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY), 12),
  ('tracker', NULL,
   (SELECT id FROM products WHERE slug = 'tracker-standard' LIMIT 1),
   'Ada Okafor', '+2348031234567',
   '2008 Toyota Corolla · GGE-410-XA', 'Tracker — Standard, 12 months', 4500000,
   'lapsed',
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 410 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 410 DAY),
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 40 DAY), 12);

-- ...and one paid for but not yet fitted, which is the only row the activation
-- checklist (installed → platform activated → renewal date) has anything to do on.
INSERT INTO subscriptions
  (kind, order_id, product_id, customer_name, customer_phone, unit_label, plan_name, amount_kobo,
   device_state, installed_at, activated_at, renewal_at, period_months)
VALUES
  ('tracker', (SELECT id FROM orders WHERE order_no = 'HC-ORD-0001' LIMIT 1),
   (SELECT id FROM products WHERE slug = 'tracker-standard' LIMIT 1),
   'Ada Okafor', '+2348031234567',
   '2012 Honda Accord · PH-552-KJA', 'Tracker — Standard, 12 months', 4500000,
   'ordered', NULL, NULL, NULL, 12);

-- FR-20 / §7.3 “dealer retainer/subs management”: two lots on monthly plans —
-- one paid up, one overdue — created with the checklist already complete because
-- a retainer is a paperwork arrangement, not a device waiting to be fitted.
INSERT INTO subscriptions
  (kind, dealer_id, customer_name, customer_phone, unit_label, plan_name, amount_kobo,
   device_state, installed_at, activated_at, renewal_at, period_months)
VALUES
  ('dealer_retainer', (SELECT id FROM dealers WHERE name = 'Woji Car Mart' LIMIT 1),
   'Woji Car Mart', '+2348000000006', 'Woji Car Mart',
   'Dealer retainer — monthly', 2500000,
   'activated',
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 DAY),
   DATE_ADD(UTC_TIMESTAMP(), INTERVAL 21 DAY), 1),
  ('dealer_retainer', (SELECT id FROM dealers WHERE name = 'Aba Road Autos' LIMIT 1),
   'Aba Road Autos', '+2348000000007', 'Aba Road Autos',
   'Dealer retainer — monthly', 2500000,
   'renewal_due',
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 120 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 120 DAY),
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 6 DAY), 1);

-- ---------------------------------------------------------------------------
-- Post-seed sanity: the 90-day sold hand-off row on vehicle_listings so ops
-- can see the intended target without joining redirects.
-- ---------------------------------------------------------------------------
UPDATE vehicle_listings SET archive_redirect_path = CONCAT('/cars/', LOWER(REPLACE(make, ' ', '-')))
 WHERE status = 'sold' AND sold_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 DAY);

-- ---------------------------------------------------------------------------
-- §7.3 UTM report / §15.2 channel report: the links the demo traffic arrived on.
--
-- Bucketed by each lead's *rank* (1st, 2nd, 3rd…), not by its id: ids drift as
-- the table is reseeded, and an attribution that changes between two loads of
-- the same database is worse than no attribution. One bucket in five stays NULL
-- on purpose — "direct / none" is a real answer, and hiding it would make the
-- channel mix look tidier than it is.
-- ---------------------------------------------------------------------------
UPDATE leads
   SET utm = CASE (
         SELECT COUNT(*) FROM (SELECT id FROM leads) AS ranked WHERE ranked.id <= leads.id
       ) % 5
         WHEN 0 THEN JSON_OBJECT('source', 'instagram', 'medium', 'social',   'campaign', 'ph-suv-september')
         WHEN 1 THEN JSON_OBJECT('source', 'google',    'medium', 'cpc',      'campaign', 'ph-inspection-search')
         WHEN 2 THEN JSON_OBJECT('source', 'facebook',  'medium', 'social',   'campaign', 'ph-diesel-trucks')
         WHEN 3 THEN JSON_OBJECT('source', 'whatsapp',  'medium', 'referral', 'campaign', 'dealer-referral')
         ELSE NULL
       END;

-- ...and the two paying customers explicitly, so the demo shows a full chain
-- rather than the pattern landing them in the NULL bucket by accident.
UPDATE leads SET utm = JSON_OBJECT('source', 'instagram', 'medium', 'social', 'campaign', 'ph-suv-september')
 WHERE phone = '+2348030000000';
UPDATE leads SET utm = JSON_OBJECT('source', 'google', 'medium', 'cpc', 'campaign', 'ph-inspection-search')
 WHERE phone = '+2348031234567';

-- ---------------------------------------------------------------------------
-- §15.2 Marketing dashboard: thirty days of arrival traffic.
--
-- Events are only ever written by a real browser, so a fresh database has an
-- empty analytics_events table and every channel reads zero — a dashboard that
-- demoes as a wall of dashes. This seeds the month a business this size would
-- actually have: six channels, hours spread through the day, and the funnel
-- events each channel converts on.
--
-- Direct traffic carries no utm key at all, because that is what direct means;
-- the dashboard must show it as "(direct / none)" rather than folding it into a
-- channel it may not have come from.
--
-- Built by cross join (channel × day × session) rather than a thousand literal
-- rows: the file stays small, and changing a channel's volume is one number.
-- ---------------------------------------------------------------------------
CREATE TEMPORARY TABLE seed_channel (
  slot     VARCHAR(20) NOT NULL,
  source   VARCHAR(40) NULL,
  medium   VARCHAR(30) NULL,
  campaign VARCHAR(60) NULL,
  per_day  INT NOT NULL,   -- sessions a day
  views    INT NOT NULL,   -- of those, how many open a listing
  clicks   INT NOT NULL,   -- WhatsApp hand-offs
  starts   INT NOT NULL,   -- concierge/booking/checkout started
  retainer INT NOT NULL,   -- concierge retainers paid
  buys     INT NOT NULL,   -- shop purchases
  books    INT NOT NULL    -- hire/booking completed
);

INSERT INTO seed_channel (slot, source, medium, campaign, per_day, views, clicks, starts, retainer, buys, books) VALUES
  ('google',    'google',    'cpc',      'ph-inspection-search', 9, 6, 2, 3, 1, 1, 0),
  ('instagram', 'instagram', 'social',   'ph-suv-september',     7, 5, 2, 2, 1, 0, 1),
  ('facebook',  'facebook',  'social',   'ph-diesel-trucks',     5, 3, 1, 1, 0, 0, 1),
  ('whatsapp',  'whatsapp',  'referral', 'dealer-referral',      3, 2, 2, 1, 1, 1, 0),
  ('direct',    NULL,        NULL,       NULL,                   6, 4, 1, 1, 0, 0, 0),
  ('tiktok',    'tiktok',    'social',   'ph-first-car-october', 3, 2, 0, 1, 0, 0, 0);

CREATE TEMPORARY TABLE seed_day (d INT NOT NULL);
INSERT INTO seed_day (d) VALUES
  (0),(1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12),(13),(14),
  (15),(16),(17),(18),(19),(20),(21),(22),(23),(24),(25),(26),(27),(28),(29);

CREATE TEMPORARY TABLE seed_slot (n INT NOT NULL);
INSERT INTO seed_slot (n) VALUES
  (0),(1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12),(13),(14),(15);

-- One statement per event name, and the per-channel columns above decide which
-- sessions emit it, so the volumes stay in one readable table and nothing is
-- random (a seed that reshuffles on every load cannot be compared with itself).
-- The session id is shared by every event of one visit, which is what makes
-- "sessions" a count of people rather than of page views.
INSERT INTO analytics_events (event_name, payload, source_path, session_id, created_at)
SELECT 'listing_impression',
       IF(ch.source IS NULL, NULL,
          JSON_OBJECT('utm', JSON_OBJECT('source', ch.source, 'medium', ch.medium, 'campaign', ch.campaign),
                      'result_count', 40 + (d.d % 20))),
       '/cars',
       CONCAT('seed-', ch.slot, '-', d.d, '-', s.n),
       -- Midnight-anchored, and today's sessions stop at the current hour: a
       -- seeded visit dated tomorrow would fall outside the very window the
       -- dashboard opens on, and the traffic would read as less than it is.
       DATE_ADD(DATE_ADD(DATE_SUB(UTC_DATE(), INTERVAL d.d DAY),
                INTERVAL ((s.n * 5 + d.d * 7) % IF(d.d = 0, GREATEST(1, HOUR(UTC_TIMESTAMP())), 24)) HOUR),
                INTERVAL ((s.n * 13 + d.d * 11) % 60) MINUTE)
  FROM seed_channel ch, seed_day d, seed_slot s
 WHERE s.n < ch.per_day;

INSERT INTO analytics_events (event_name, payload, source_path, session_id, created_at)
SELECT 'listing_view',
       IF(ch.source IS NULL, NULL,
          JSON_OBJECT('utm', JSON_OBJECT('source', ch.source, 'medium', ch.medium, 'campaign', ch.campaign),
                      'listing_id', 1 + ((s.n * 7 + d.d) % 60), 'grade', ELT(1 + ((s.n + d.d) % 4), 'verified', 'inspected', 'listed', 'pending'),
                      'price_position', ELT(1 + ((s.n + d.d) % 3), 'below', 'within', 'premium'))),
       '/cars',
       CONCAT('seed-', ch.slot, '-', d.d, '-', s.n),
       -- Midnight-anchored, and today's sessions stop at the current hour: a
       -- seeded visit dated tomorrow would fall outside the very window the
       -- dashboard opens on, and the traffic would read as less than it is.
       DATE_ADD(DATE_ADD(DATE_SUB(UTC_DATE(), INTERVAL d.d DAY),
                INTERVAL ((s.n * 5 + d.d * 7) % IF(d.d = 0, GREATEST(1, HOUR(UTC_TIMESTAMP())), 24)) HOUR),
                INTERVAL ((s.n * 13 + d.d * 11) % 60) MINUTE)
  FROM seed_channel ch, seed_day d, seed_slot s
 WHERE s.n < ch.views;

INSERT INTO analytics_events (event_name, payload, source_path, session_id, created_at)
SELECT 'whatsapp_click',
       IF(ch.source IS NULL, NULL,
          JSON_OBJECT('utm', JSON_OBJECT('source', ch.source, 'medium', ch.medium, 'campaign', ch.campaign),
                      'source', 'vdp')),
       '/cars',
       CONCAT('seed-', ch.slot, '-', d.d, '-', s.n),
       -- Midnight-anchored, and today's sessions stop at the current hour: a
       -- seeded visit dated tomorrow would fall outside the very window the
       -- dashboard opens on, and the traffic would read as less than it is.
       DATE_ADD(DATE_ADD(DATE_SUB(UTC_DATE(), INTERVAL d.d DAY),
                INTERVAL ((s.n * 5 + d.d * 7) % IF(d.d = 0, GREATEST(1, HOUR(UTC_TIMESTAMP())), 24)) HOUR),
                INTERVAL ((s.n * 13 + d.d * 11) % 60) MINUTE)
  FROM seed_channel ch, seed_day d, seed_slot s
 WHERE s.n < ch.clicks;

INSERT INTO analytics_events (event_name, payload, source_path, session_id, created_at)
SELECT 'concierge_started',
       IF(ch.source IS NULL, NULL,
          JSON_OBJECT('utm', JSON_OBJECT('source', ch.source, 'medium', ch.medium, 'campaign', ch.campaign),
                      'type', 'concierge')),
       '/find-my-car',
       CONCAT('seed-', ch.slot, '-', d.d, '-', s.n),
       -- Midnight-anchored, and today's sessions stop at the current hour: a
       -- seeded visit dated tomorrow would fall outside the very window the
       -- dashboard opens on, and the traffic would read as less than it is.
       DATE_ADD(DATE_ADD(DATE_SUB(UTC_DATE(), INTERVAL d.d DAY),
                INTERVAL ((s.n * 5 + d.d * 7) % IF(d.d = 0, GREATEST(1, HOUR(UTC_TIMESTAMP())), 24)) HOUR),
                INTERVAL ((s.n * 13 + d.d * 11) % 60) MINUTE)
  FROM seed_channel ch, seed_day d, seed_slot s
 WHERE s.n < ch.starts;

INSERT INTO analytics_events (event_name, payload, source_path, session_id, created_at)
SELECT 'concierge_retainer_paid',
       IF(ch.source IS NULL, NULL,
          JSON_OBJECT('utm', JSON_OBJECT('source', ch.source, 'medium', ch.medium, 'campaign', ch.campaign),
                      'type', 'concierge', 'value', 50000, 'currency', 'NGN')),
       '/find-my-car',
       CONCAT('seed-', ch.slot, '-', d.d, '-', s.n),
       -- Midnight-anchored, and today's sessions stop at the current hour: a
       -- seeded visit dated tomorrow would fall outside the very window the
       -- dashboard opens on, and the traffic would read as less than it is.
       DATE_ADD(DATE_ADD(DATE_SUB(UTC_DATE(), INTERVAL d.d DAY),
                INTERVAL ((s.n * 5 + d.d * 7) % IF(d.d = 0, GREATEST(1, HOUR(UTC_TIMESTAMP())), 24)) HOUR),
                INTERVAL ((s.n * 13 + d.d * 11) % 60) MINUTE)
  FROM seed_channel ch, seed_day d, seed_slot s
 WHERE s.n < ch.retainer;

INSERT INTO analytics_events (event_name, payload, source_path, session_id, created_at)
SELECT 'purchase',
       IF(ch.source IS NULL, NULL,
          JSON_OBJECT('utm', JSON_OBJECT('source', ch.source, 'medium', ch.medium, 'campaign', ch.campaign),
                      'type', 'order', 'value', 45000, 'currency', 'NGN')),
       '/checkout',
       CONCAT('seed-', ch.slot, '-', d.d, '-', s.n),
       -- Midnight-anchored, and today's sessions stop at the current hour: a
       -- seeded visit dated tomorrow would fall outside the very window the
       -- dashboard opens on, and the traffic would read as less than it is.
       DATE_ADD(DATE_ADD(DATE_SUB(UTC_DATE(), INTERVAL d.d DAY),
                INTERVAL ((s.n * 5 + d.d * 7) % IF(d.d = 0, GREATEST(1, HOUR(UTC_TIMESTAMP())), 24)) HOUR),
                INTERVAL ((s.n * 13 + d.d * 11) % 60) MINUTE)
  FROM seed_channel ch, seed_day d, seed_slot s
 WHERE s.n < ch.buys;

INSERT INTO analytics_events (event_name, payload, source_path, session_id, created_at)
SELECT 'booking_completed',
       IF(ch.source IS NULL, NULL,
          JSON_OBJECT('utm', JSON_OBJECT('source', ch.source, 'medium', ch.medium, 'campaign', ch.campaign),
                      'type', 'hire', 'value', 45000, 'currency', 'NGN')),
       '/hire',
       CONCAT('seed-', ch.slot, '-', d.d, '-', s.n),
       -- Midnight-anchored, and today's sessions stop at the current hour: a
       -- seeded visit dated tomorrow would fall outside the very window the
       -- dashboard opens on, and the traffic would read as less than it is.
       DATE_ADD(DATE_ADD(DATE_SUB(UTC_DATE(), INTERVAL d.d DAY),
                INTERVAL ((s.n * 5 + d.d * 7) % IF(d.d = 0, GREATEST(1, HOUR(UTC_TIMESTAMP())), 24)) HOUR),
                INTERVAL ((s.n * 13 + d.d * 11) % 60) MINUTE)
  FROM seed_channel ch, seed_day d, seed_slot s
 WHERE s.n < ch.books;

DROP TEMPORARY TABLE seed_channel;
DROP TEMPORARY TABLE seed_day;
DROP TEMPORARY TABLE seed_slot;

-- ---------------------------------------------------------------------------
-- FR-22 — hire management.
--
-- The pool is ten real units, not ten of the same car: two partner-owned,
-- one whose papers are missing (so the allocation guard has something to
-- refuse), one with papers expiring inside the month, one with a tracker still
-- on order, one in the workshop. A demo where every unit is identical hides
-- exactly the decisions this screen exists to support.
--
-- The hire book covers every state the lifecycle can be in: quoted (waiting on
-- the client), accepted (payment raised), confirmed (paid, car allocated),
-- on hire (out now), completed (came back, invoice issued) and cancelled. The
-- corporate RFQ from HC-2482 is four references under one request — a hire is
-- one car, so four cars is four hires.
-- ---------------------------------------------------------------------------
INSERT INTO hire_vehicles (plate, class_slug, make, model, year, colour, seats, owner, partner_name,
                           driver_available, documents_state, documents_due, tracker_state, status,
                           location, notes) VALUES
  ('KJA-482-PH', 'suv',    'Toyota', 'Highlander', 2019, 'Silver',  7, 'honestcars', NULL, 1, 'current',  DATE_ADD(UTC_DATE(), INTERVAL 400 DAY), 'fitted',   'on_hire',   'Woji yard',      'Corporate favourite — out on the Saipem rotation.'),
  ('RUM-119-PH', 'suv',    'Ford',   'Explorer',   2018, 'Black',   7, 'partner',    'Delta Fleet Services', 1, 'missing', NULL, 'none', 'available', 'GRA Phase 2', 'Partner unit. Insurance lapsed — nothing goes out on it until papers are back.'),
  ('WOJ-630-PH', 'sedan',  'Toyota', 'Corolla',    2018, 'White',   5, 'honestcars', NULL, 1, 'current',  DATE_ADD(UTC_DATE(), INTERVAL 250 DAY), 'fitted',   'available', 'Woji yard',      NULL),
  ('GRA-274-PH', 'sedan',  'Toyota', 'Camry',      2019, 'Grey',    5, 'partner',    'Rivers Fleet Ltd', 1, 'current',  DATE_ADD(UTC_DATE(), INTERVAL 120 DAY), 'fitted',   'available', 'GRA Phase 2', 'Partner unit, driver supplied by us.'),
  ('PHC-905-PH', 'suv',    'Lexus',  'RX 350',     2017, 'Blue',    5, 'honestcars', NULL, 1, 'expiring', DATE_ADD(UTC_DATE(), INTERVAL 18 DAY),  'fitted',   'available', 'Woji yard',      'Papers due this month — renewal with the underwriter.'),
  ('RUM-518-PH', 'suv',    'Toyota', 'RAV4',       2019, 'Green',   5, 'honestcars', NULL, 1, 'current',  DATE_ADD(UTC_DATE(), INTERVAL 275 DAY), 'fitted',   'available', 'Woji yard',      'Spare SUV — the one the desk puts on a late corporate ask.'),
  ('TRA-188-PH', 'pickup', 'Toyota', 'Hilux',      2020, 'White',   5, 'honestcars', NULL, 1, 'current',  DATE_ADD(UTC_DATE(), INTERVAL 310 DAY), 'fitted',   'available', 'Trans-Amadi',    'Site and project work.'),
  ('OBI-357-PH', 'bus',    'Toyota', 'Hiace',      2016, 'White',  14, 'honestcars', NULL, 1, 'current',  DATE_ADD(UTC_DATE(), INTERVAL 200 DAY), 'on_order', 'available', 'Rumuokoro',      'Tracker still on order — booked to be fitted next week.'),
  ('ELE-712-PH', 'luxury', 'Lexus',  'GX 460',     2018, 'Black',   5, 'honestcars', NULL, 1, 'current',  DATE_ADD(UTC_DATE(), INTERVAL 140 DAY), 'fitted',   'available', 'Woji yard',      'Weddings, delegations, the chairman.'),
  ('RIV-204-PH', 'sedan',  'Hyundai','Elantra',    2017, 'Ash',     5, 'honestcars', NULL, 1, 'current',  DATE_ADD(UTC_DATE(), INTERVAL 60 DAY),  'fitted',   'service',   'Woji workshop',  'In the workshop — see the open incident against it.');

-- The hire book. Amounts are computed off the rate card the client saw, with the
-- 10% refundable deposit the /hire page describes.
INSERT INTO hire_bookings (reference, request_id, vehicle_id, class_slug, client_name, client_phone, company,
                           pickup_at, dropoff_at, pickup_point, days, with_driver, driver_name, airport_pickup,
                           day_rate_kobo, driver_kobo, extras_kobo, deposit_kobo, total_kobo, status,
                           quote_sent_at, accepted_at, completed_at, cancelled_at, cancel_reason,
                           notes, fuel_out, fuel_in, odometer_out, odometer_in) VALUES
  -- ① The concierge hire request: quoted, waiting on Ada to accept.
  ('HC-HIRE-0001',
   (SELECT id FROM service_requests WHERE tracking_id = 'HC-2490' LIMIT 1), NULL, 'suv',
   'Ada Okafor', '+2348031234567', NULL,
   DATE_ADD(UTC_DATE(), INTERVAL 4 DAY), DATE_ADD(UTC_DATE(), INTERVAL 7 DAY), 'Omagwa arrivals', 3, 0, NULL, 1,
   5500000, 0, 0, 1650000, 18150000, 'quoted',
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 HOUR), NULL, NULL, NULL, NULL,
   'Airport pick-up Friday morning; add the tracking add-on after handover.', NULL, NULL, NULL, NULL),

  -- ②–⑤ The corporate RFQ (HC-2482): fourteen days, four SUVs, with drivers.
  ('HC-HIRE-0002',
   (SELECT id FROM service_requests WHERE tracking_id = 'HC-2482' LIMIT 1),
   (SELECT id FROM hire_vehicles WHERE plate = 'KJA-482-PH' LIMIT 1), 'suv',
   'Fleet officer, oil & gas firm', '+2348031110004', 'Saipem Nigeria field rotation',
   DATE_SUB(UTC_DATE(), INTERVAL 2 DAY), DATE_ADD(UTC_DATE(), INTERVAL 12 DAY), 'Woji yard', 14, 1, 'Monday Chukwu', 1,
   33000000, 25200000, 0, 9120000, 100320000, 'on_hire',
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 6 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 DAY), NULL, NULL, NULL,
   'Rotation 1 — unit out, driver assigned.', 92, NULL, 61240, NULL),
  ('HC-HIRE-0003',
   (SELECT id FROM service_requests WHERE tracking_id = 'HC-2482' LIMIT 1),
   (SELECT id FROM hire_vehicles WHERE plate = 'PHC-905-PH' LIMIT 1), 'suv',
   'Fleet officer, oil & gas firm', '+2348031110004', 'Saipem Nigeria field rotation',
   DATE_ADD(UTC_DATE(), INTERVAL 1 DAY), DATE_ADD(UTC_DATE(), INTERVAL 15 DAY), 'Woji yard', 14, 1, 'Ibrahim Sule', 1,
   33000000, 25200000, 0, 9120000, 100320000, 'confirmed',
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 6 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 DAY), NULL, NULL, NULL,
   'Rotation 1 — paid, unit allocated, goes out tomorrow.', NULL, NULL, NULL, NULL),
  ('HC-HIRE-0004',
   (SELECT id FROM service_requests WHERE tracking_id = 'HC-2482' LIMIT 1), NULL, 'suv',
   'Fleet officer, oil & gas firm', '+2348031110004', 'Saipem Nigeria field rotation',
   DATE_ADD(UTC_DATE(), INTERVAL 1 DAY), DATE_ADD(UTC_DATE(), INTERVAL 15 DAY), 'Woji yard', 14, 1, NULL, 1,
   33000000, 25200000, 0, 9120000, 100320000, 'accepted',
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 6 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY), NULL, NULL, NULL,
   'Rotation 1 — client accepted, transfer not yet landed. Fourth unit owes us a car: the Explorer cannot go out.', NULL, NULL, NULL, NULL),
  ('HC-HIRE-0005',
   (SELECT id FROM service_requests WHERE tracking_id = 'HC-2482' LIMIT 1), NULL, 'suv',
   'Fleet officer, oil & gas firm', '+2348031110004', 'Saipem Nigeria field rotation',
   DATE_ADD(UTC_DATE(), INTERVAL 16 DAY), DATE_ADD(UTC_DATE(), INTERVAL 30 DAY), 'Woji yard', 14, 1, NULL, 1,
   33000000, 25200000, 0, 9120000, 100320000, 'quoted',
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY), NULL, NULL, NULL, NULL,
   'Rotation 2 — quoted, waiting on their procurement.', NULL, NULL, NULL, NULL),

  -- ⑥ A hire that ran and closed, with the readings taken both ways.
  ('HC-HIRE-0006',
   NULL, (SELECT id FROM hire_vehicles WHERE plate = 'WOJ-630-PH' LIMIT 1), 'sedan',
   'Chinedu Okafor', '+2348031110013', 'Zenith Bank, Aba Road branch',
   DATE_SUB(UTC_DATE(), INTERVAL 9 DAY), DATE_SUB(UTC_DATE(), INTERVAL 5 DAY), 'Our Woji office', 5, 0, NULL, 0,
   3500000, 0, 0, 1750000, 19250000, 'completed',
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 12 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 11 DAY),
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 DAY), NULL, NULL,
   'Left with a full tank and came back with three-quarters — no charge, within tolerance.',
   100, 74, 45120, 45533),

  -- ⑦ A hire that stopped before it started.
  ('HC-HIRE-0007',
   NULL, (SELECT id FROM hire_vehicles WHERE plate = 'OBI-357-PH' LIMIT 1), 'bus',
   'Bright Iheanacho', '+2348031110014', 'Iheanacho Events',
   DATE_ADD(UTC_DATE(), INTERVAL 9 DAY), DATE_ADD(UTC_DATE(), INTERVAL 11 DAY), 'Hotel Presidential', 3, 1, NULL, 1,
   9500000, 7500000, 0, 3600000, 39600000, 'cancelled',
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 8 DAY), NULL, NULL, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 DAY),
   'Event moved to next month — the client will rebook.',
   'Cancelled before any money moved; the unit was never allocated for the new dates.', NULL, NULL, NULL, NULL);

-- The hire payments: two paid (the unit is out, and the one that closed) and one
-- raised and still pending (the fourth rotation car, waiting on procurement).
INSERT INTO payments (reference, provider, provider_ref, purpose, order_id, booking_id, request_id,
                      subscription_id, hire_booking_id, customer_name, customer_phone, amount_kobo, status,
                      checkout_url, created_by, paid_at) VALUES
  ('HC-PAY-000006', 'bank_transfer', 'SEED-BT-0006', 'hire', NULL, NULL, NULL, NULL,
   (SELECT id FROM hire_bookings WHERE reference = 'HC-HIRE-0002' LIMIT 1),
   'Fleet officer, oil & gas firm', '+2348031110004', 100320000, 'paid', NULL, NULL,
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 DAY)),
  ('HC-PAY-000007', 'bank_transfer', 'SEED-BT-0007', 'hire', NULL, NULL, NULL, NULL,
   (SELECT id FROM hire_bookings WHERE reference = 'HC-HIRE-0003' LIMIT 1),
   'Fleet officer, oil & gas firm', '+2348031110004', 100320000, 'paid', NULL, NULL,
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 DAY)),
  ('HC-PAY-000008', 'manual', NULL, 'hire', NULL, NULL, NULL, NULL,
   (SELECT id FROM hire_bookings WHERE reference = 'HC-HIRE-0004' LIMIT 1),
   'Fleet officer, oil & gas firm', '+2348031110004', 100320000, 'pending', NULL, NULL, NULL),
  ('HC-PAY-000009', 'bank_transfer', 'SEED-BT-0009', 'hire', NULL, NULL, NULL, NULL,
   (SELECT id FROM hire_bookings WHERE reference = 'HC-HIRE-0006' LIMIT 1),
   'Chinedu Okafor', '+2348031110013', 19250000, 'paid', NULL, NULL,
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 11 DAY));

-- The incident log. One open against the workshop car (which is why it is off
-- the road), and one closed from the hire that just finished — the resolved
-- record is the point of keeping a log at all.
INSERT INTO hire_incidents (booking_id, vehicle_id, kind, severity, detail, cost_kobo, charged_kobo,
                            status, occurred_at, resolved_at, resolution, reported_by) VALUES
  (NULL, (SELECT id FROM hire_vehicles WHERE plate = 'RIV-204-PH' LIMIT 1), 'breakdown', 'major',
   'Overheated on Aba Road during a hire — head gasket suspected. Recovered to the Woji workshop.',
   0, 0, 'open', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY), NULL, NULL, NULL),
  ((SELECT id FROM hire_bookings WHERE reference = 'HC-HIRE-0006' LIMIT 1),
   (SELECT id FROM hire_vehicles WHERE plate = 'WOJ-630-PH' LIMIT 1), 'fuel', 'minor',
   'Returned with the tank at 74% against 100% at handover.',
   0, 0, 'resolved', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 DAY),
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 DAY),
   'Within the tolerance we allow on a five-day hire — no charge to the client.', NULL);

-- ---------------------------------------------------------------------------
-- FR-18 — dealer add-on purchases (§7.2).
--
-- Three of the four states the lifecycle can be in, so the portal and the
-- console have something real to show:
--
--   HC-ADD-0001  featured placement, PAID and running   (featured_rank is set)
--   HC-ADD-0002  media shoot, raised and UNPAID         (the dealer owes it)
--   HC-ADD-0003  featured placement, PAID and EXPIRED   (rank taken back)
--
-- Each purchase names a car that lot actually holds: a lot cannot buy a
-- featured slot for someone else's stock, so the seed must not either.
-- ---------------------------------------------------------------------------
INSERT INTO dealer_purchases (id, reference, dealer_id, addon_id, listing_id, amount_kobo, status,
                              starts_at, ends_at, detail, created_by) VALUES
  (1, 'HC-ADD-0001',
   (SELECT id FROM dealers WHERE name = 'Aba Road Autos' LIMIT 1), 2,
   (SELECT id FROM vehicle_listings WHERE stock_no = '${featuredCar}' LIMIT 1),
   3000000, 'active',
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 9 DAY), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 21 DAY),
   'Featured placement is live on that listing.', NULL),
  (2, 'HC-ADD-0002',
   (SELECT id FROM dealers WHERE name = 'Woji Car Mart' LIMIT 1), 1,
   (SELECT id FROM vehicle_listings WHERE stock_no = '${shootCar}' LIMIT 1),
   4500000, 'pending', NULL, NULL, NULL, NULL),
  (3, 'HC-ADD-0003',
   (SELECT id FROM dealers WHERE name = 'Trans-Amadi Motors' LIMIT 1), 2,
   (SELECT id FROM vehicle_listings WHERE stock_no = '${expiredCar}' LIMIT 1),
   3000000, 'expired',
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 48 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 18 DAY),
   'Featured placement is live on that listing.', NULL);

INSERT INTO payments (reference, provider, provider_ref, purpose, order_id, booking_id, request_id,
                      subscription_id, hire_booking_id, dealer_purchase_id, customer_name, customer_phone,
                      amount_kobo, status, created_by, paid_at) VALUES
  ('HC-PAY-000010', 'bank_transfer', 'SEED-BT-0010', 'addon', NULL, NULL, NULL, NULL, NULL,
   (SELECT id FROM dealer_purchases WHERE reference = 'HC-ADD-0001' LIMIT 1),
   'Aba Road Autos', '+2348000000007', 3000000, 'paid', NULL,
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 9 DAY)),
  ('HC-PAY-000011', 'manual', NULL, 'addon', NULL, NULL, NULL, NULL, NULL,
   (SELECT id FROM dealer_purchases WHERE reference = 'HC-ADD-0002' LIMIT 1),
   'Woji Car Mart', '+2348000000006', 4500000, 'pending', NULL, NULL),
  ('HC-PAY-000012', 'bank_transfer', 'SEED-BT-0012', 'addon', NULL, NULL, NULL, NULL, NULL,
   (SELECT id FROM dealer_purchases WHERE reference = 'HC-ADD-0003' LIMIT 1),
   'Trans-Amadi Motors', '+2348000000008', 3000000, 'paid', NULL,
   DATE_SUB(UTC_TIMESTAMP(), INTERVAL 48 DAY));

UPDATE dealer_purchases p
   SET p.payment_id = (SELECT pay.id FROM payments pay WHERE pay.dealer_purchase_id = p.id LIMIT 1)
 WHERE p.reference IN ('HC-ADD-0001', 'HC-ADD-0002', 'HC-ADD-0003');

-- The paid, running placement is what puts featured_rank back on its car.
UPDATE vehicle_listings SET featured_rank = 1 WHERE stock_no = '${featuredCar}';


-- ---------------------------------------------------------------------------
-- §15.2 CAC guardrail: what the advertising cost.
--
-- An invoice arrives from Meta or Google after the month closes, so spend is
-- entered by hand (admin → Marketing) rather than derived. Seeded here for the
-- two 30-day blocks the dashboard's default window sits inside, so a reader can
-- widen or shift the dates and see the window actually do something.
--
-- No row for direct (organic) or WhatsApp (referral): untracked cost is not
-- zero cost, it is unknown, and the screen shows a dash rather than a
-- flattering ₦0.
-- ---------------------------------------------------------------------------
INSERT INTO marketing_spend (channel, period_start, period_end, amount_kobo, note) VALUES
  ('google',    DATE_SUB(UTC_DATE(), INTERVAL 29 DAY), UTC_DATE(), 7400000, 'Search — inspection and concierge terms (demo figure)'),
  ('instagram', DATE_SUB(UTC_DATE(), INTERVAL 29 DAY), UTC_DATE(), 3950000, 'Reels + carousel, SUV pillar (demo figure)'),
  ('facebook',  DATE_SUB(UTC_DATE(), INTERVAL 29 DAY), UTC_DATE(), 1500000, 'Marketplace audience retargeting (demo figure)'),
  ('tiktok',    DATE_SUB(UTC_DATE(), INTERVAL 29 DAY), UTC_DATE(),  700000, 'First-car series, test spend (demo figure)'),
  ('google',    DATE_SUB(UTC_DATE(), INTERVAL 60 DAY), DATE_SUB(UTC_DATE(), INTERVAL 31 DAY), 6800000, 'Search — previous month (demo figure)'),
  ('instagram', DATE_SUB(UTC_DATE(), INTERVAL 60 DAY), DATE_SUB(UTC_DATE(), INTERVAL 31 DAY), 3600000, 'Reels — previous month (demo figure)'),
  ('facebook',  DATE_SUB(UTC_DATE(), INTERVAL 60 DAY), DATE_SUB(UTC_DATE(), INTERVAL 31 DAY), 1200000, 'Retargeting — previous month (demo figure)');
`);
  return out.join('\n');
}

function main() {
  const data = build();
  const sql = render(data);
  fs.mkdirSync(path.dirname(SEED_SQL), { recursive: true });
  fs.writeFileSync(SEED_SQL, sql);
  const images = writePlaceholders();
  const live = data.listings.filter((l) => l.status === 'live').length;
  const sold = data.listings.filter((l) => l.status === 'sold').length;
  console.log(`db/seed.sql written: ${data.listings.length} listings (${live} live, ${sold} sold), ${data.media.length} media rows`);
  console.log(`public/img/seed/: ${images} placeholder images`);
}

main();
