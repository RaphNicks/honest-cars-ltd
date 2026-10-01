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

  const condition = chance(0.14) ? 'new' : chance(0.62) ? 'tokunbo' : 'nigerian_used';
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
      ? new Date(Date.UTC(2026, 9, 1) + int(1, 14) * 86_400_000)
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

function mediaRows(listing) {
  const shots = listing.verificationGrade === 'certified' ? SHOTS : sample(SHOTS, int(6, 8));
  return shots.map((shot, i) => ({
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
}

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
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

  return { listings, media };
}

function render({ listings, media }) {
  const now = "UTC_TIMESTAMP()";
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
DELETE FROM leads;
DELETE FROM listing_media;
DELETE FROM vehicle_listings;
DELETE FROM price_bands;
DELETE FROM facets;
DELETE FROM services;
DELETE FROM testimonials;
DELETE FROM blog_posts;
DELETE FROM faqs;
DELETE FROM redirects;
DELETE FROM dealers;
`);

  out.push(insert('dealers',
    ['id', 'name', 'slug', 'lot_area', 'city', 'tier', 'verified', 'agreement_signed'],
    DEALERS.map((d, i) => [i + 1, d.name, d.slug, d.area, 'Port Harcourt', d.tier, d.verified, new Date(Date.UTC(2026, 5, 1 + i))])));

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
        l.honestNote, l.inspection, l.slug, int(40, 2400), int(0, 26), int(0, 180),
        l.publishedAt, l.expiresAt, l.soldAt, l.featured,
      ];
    })));

  out.push(insert('listing_media',
    ['id', 'listing_id', 'type', 'shot_label', 'url', 'alt_text', 'position', 'width', 'height'],
    media.map((m, i) => [i + 1, m.listingId, m.type, m.shotLabel, m.url, m.alt, m.position, m.width, m.height])));

  // Price bands: one per catalog entry per year bucket + condition 'any'
  const bands = [];
  for (const cat of CATALOG) {
    for (let y = cat.years[0]; y <= cat.years[1]; y += 3) {
      const span = cat.years[1] - cat.years[0] || 1;
      const ratio = (y - cat.years[0]) / span;
      const lo = cat.band[0] + (cat.band[1] - cat.band[0]) * ratio * 0.85;
      const hi = lo + (cat.band[1] - cat.band[0]) * 0.22;
      bands.push([cat.make, cat.model, y, Math.min(y + 2, cat.years[1]), 'any', millions(lo), millions(hi), int(6, 40), new Date(Date.UTC(2026, 8, 21))]);
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
      'Toyota Cars for Sale in Port Harcourt — Verified Stock | HonestCars',
      'Browse verified Toyota cars for sale in Port Harcourt — Camry, Corolla, RAV4, Highlander, Hilux. Honest prices, inspection grades, no dealer games.',
      { make: 'Toyota' }, '/cars/toyota', 1, 10],
    ['toyota/camry', 'model', 'toyota', 'Toyota Camry for sale in Port Harcourt',
      'Toyota Camry in Port Harcourt',
      'The Camry is the safest first buy in Port Harcourt: comfortable, cheap to service, and easy to resell. Below is live Camry stock with mileage, documents status and our verification grade on each one.',
      'Toyota Camry for Sale in Port Harcourt — Prices & Verified Stock | HonestCars',
      'Live Toyota Camry listings in Port Harcourt with honest prices, verified mileage and inspection grades. Compare 2010–2018 Camry stock before you travel.',
      { make: 'Toyota', model: 'Camry' }, '/cars/toyota/camry', 1, 11],
    ['toyota/corolla', 'model', 'toyota', 'Toyota Corolla for sale in Port Harcourt',
      'Toyota Corolla in Port Harcourt',
      'Corolla money is safe money in PH. Fuel is light, parts are cheap, and a well-kept example will not embarrass you. We list the mileage as it is — verified where an inspector has seen the odometer.',
      'Toyota Corolla for Sale in Port Harcourt — Verified Corolla Stock | HonestCars',
      'Toyota Corolla listings in Port Harcourt with verified mileage, document status and honest condition notes. Prices from the live PH market.',
      { make: 'Toyota', model: 'Corolla' }, '/cars/toyota/corolla', 1, 12],
    ['honda', 'make', null, 'Honda cars for sale in Port Harcourt',
      'Honda for sale in Port Harcourt',
      'Hondas hold their value in Port Harcourt and the Accord and CR-V are the two we see most. Check the grade on each listing — Certified means we scanned it ourselves and wrote down what we found.',
      'Honda Cars for Sale in Port Harcourt — Verified Accord & CR-V | HonestCars',
      'Browse Honda cars for sale in Port Harcourt — Accord, CR-V, Civic, Pilot. Verified grades, real mileage, honest condition notes.',
      { make: 'Honda' }, '/cars/honda', 1, 20],
    ['honda/accord', 'model', 'honda', 'Honda Accord for sale in Port Harcourt',
      'Honda Accord in Port Harcourt',
      'The Accord gives you Camry comfort with a bit more presence. Service costs are close, parts are available around Ikwerre Road and Rumuokoro. Ask us for the history on any car below.',
      'Honda Accord for Sale in Port Harcourt — Prices & Grades | HonestCars',
      'Honda Accord listings in Port Harcourt with honest prices, mileage and verification grades. Compare before you call.',
      { make: 'Honda', model: 'Accord' }, '/cars/honda/accord', 1, 21],
    ['lexus', 'make', null, 'Lexus cars for sale in Port Harcourt',
      'Lexus for sale in Port Harcourt',
      'Lexus money buys you Toyota reliability with a quieter cabin. Fuel and suspension parts cost more than a Camry, so we flag anything the inspector found before you commit.',
      'Lexus Cars for Sale in Port Harcourt — RX, ES & GX Stock | HonestCars',
      'Verified Lexus listings in Port Harcourt — RX 350, ES 350, GX 460. Real prices, inspection grades and document status on every car.',
      { make: 'Lexus' }, '/cars/lexus', 1, 30],
    ['suv-under-15m', 'body_budget', null, 'SUVs under ₦15m in Port Harcourt',
      'SUVs under ₦15m in Port Harcourt',
      'Family height and Abuja-road confidence do not have to start at ₦20m. Everything here is under ₦15,000,000 and every price is the price — what you see is what the dealer is asking.',
      'SUVs Under ₦15m in Port Harcourt — Verified Listings | HonestCars',
      'SUVs under ₦15 million in Port Harcourt — RAV4, CR-V, Sportage, X-Trail and more, with mileage, documents and verification grades.',
      { body_type: 'suv', max_price_kobo: 1_500_000_000 }, '/cars/suv-under-15m', 1, 40],
    ['suv-under-25m', 'body_budget', null, 'SUVs under ₦25m in Port Harcourt',
      'SUVs under ₦25m in Port Harcourt',
      'This is the sweet spot for a PH family: newer RAV4, Highlander and Santa Fe money. Compare the certified ones first — the inspection report tells you what the photos will not.',
      'SUVs Under ₦25m in Port Harcourt — Verified Stock | HonestCars',
      'SUVs under ₦25 million in Port Harcourt with verified mileage, inspection grades and honest condition notes.',
      { body_type: 'suv', max_price_kobo: 2_500_000_000 }, '/cars/suv-under-25m', 1, 41],
    ['sedan-under-10m', 'body_budget', null, 'Sedans under ₦10m in Port Harcourt',
      'Sedans under ₦10m in Port Harcourt',
      'Clean, sensible saloon cars under ₦10m — mostly Camry, Corolla, Elantra and Altima. Good for a first car, better for a daily commute through Rumuokoro.',
      'Sedans Under ₦10m in Port Harcourt — Verified Listings | HonestCars',
      'Sedans under ₦10 million in Port Harcourt — Camry, Corolla, Elantra, Altima. Honest prices, grades and mileage.',
      { body_type: 'sedan', max_price_kobo: 1_000_000_000 }, '/cars/sedan-under-10m', 1, 42],
    ['certified', 'tag', null, 'HonestCars-Certified cars in Port Harcourt',
      'HonestCars-Certified cars in Port Harcourt',
      'These are the cars our inspectors have scanned, driven and photographed themselves — with an honest condition note on each listing that names the faults instead of hiding them.',
      'HonestCars-Certified Cars in Port Harcourt — Full Inspection | HonestCars',
      'Every HonestCars-Certified car in Port Harcourt: OBD2 scan, documents sighted, road test, honest condition note. Browse the fully inspected stock.',
      { grade: 'certified' }, '/cars/certified', 1, 50],
  ];
  out.push(insert('facets',
    ['slug', 'page_type', 'parent_slug', 'h1', 'title', 'intro_copy', 'meta_title', 'meta_description', 'rules', 'canonical_path', 'indexable', 'position'],
    facets));

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
    ['slug', 'name', 'promise', 'icon', 'from_price_kobo', 'cta_label', 'position', 'is_active'],
    services.map((s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], 1])));

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
  ];
  out.push(insert('blog_posts',
    ['slug', 'title', 'category', 'excerpt', 'hero_image', 'hero_alt', 'author_name', 'author_role', 'read_minutes', 'status', 'published_at', 'is_featured', 'make_tags'],
    posts.map((p, i) => [p[0], p[1], p[2], p[3], `/img/seed/og-default.svg`, p[4], p[5], p[6], p[7], 'published',
      new Date(Date.UTC(2026, 8, 28) - i * 4 * 86_400_000), p[8], JSON.stringify(p[2] === 'market_intel' ? ['Toyota', 'Honda'] : ['Toyota'])])));

  const faqRows = [];
  for (const [scope, items] of Object.entries(FAQS)) {
    items.forEach(([q, a], i) => faqRows.push([scope, q, a, i + 1, 1]));
  }
  out.push(insert('faqs', ['scope', 'question', 'answer', 'position', 'is_active'], faqRows));

  // Sold-archive hand-off: >90-day sales map to their facet (§14.1).
  const expired = listings.filter((l) => l.status === 'sold' && l.soldAt && (Date.UTC(2026, 8, 30) - l.soldAt.getTime()) / 86_400_000 > 90);
  out.push(insert('redirects', ['from_path', 'to_path', 'status_code', 'reason'],
    expired.map((l) => [`/cars/${l.slug}`, `/cars/${slugify(l.make)}`, 301, 'sold_archive_90_days'])));

  out.push(`
-- ---------------------------------------------------------------------------
-- Post-seed sanity: the 90-day sold hand-off row on vehicle_listings so ops
-- can see the intended target without joining redirects.
-- ---------------------------------------------------------------------------
UPDATE vehicle_listings SET archive_redirect_path = CONCAT('/cars/', LOWER(REPLACE(make, ' ', '-')))
 WHERE status = 'sold' AND sold_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 DAY);
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
