'use strict';

/**
 * The cities the switcher lists — every Nigerian city a buyer might be in, not
 * only the four markets we operate.
 *
 * Why this is a file and not a table. `service_cities` means **a market we
 * operate**: it carries the stock prefix, the area list buyers filter by, and
 * an entry in the /cars filter rail. `db.listings.filterFacets` reads that table
 * straight through — deliberately, so "a market with no stock still shows as a
 * real 0" — which means rows added here would also put forty-eight radio
 * buttons in the filter rail on every /cars request. Two different questions
 * ("everywhere a buyer could be" and "where we have lots") deserve two
 * different answers.
 *
 * So: this list is the catalogue the city picker advertises and searches. A
 * city in it is reachable — `/cars?city=lagos` filters to Lagos and tells the
 * truth when the shelf is empty — but it is not a market until ops make it one
 * (a `service_cities` row, lots, and an area list). `served` marks the four that
 * are markets today, and it is the flag that decides whether a city is
 * remembered as the visitor's market: remembering "Lagos" for someone who will
 * always land on an empty grid is not a kindness.
 *
 * The list is the 36 state capitals plus the Federal Capital Territory and the
 * country's major commercial cities — the places people actually buy and sell
 * cars. It is deliberately reviewable: add a city by adding a line, and
 * `test/city-directory.test.js` holds the invariants (unique slugs, unique
 * stock prefixes, lengths the columns and URLs accept).
 */

/** `{ slug, name, state, prefix, served? }` — slug is the `?city=` token. */
const CITIES = [
  // --- the markets we operate today (FR-32) --------------------------------
  { slug: 'port-harcourt', name: 'Port Harcourt', state: 'Rivers', prefix: 'HC-PH', served: true },
  { slug: 'owerri', name: 'Owerri', state: 'Imo', prefix: 'HC-OW', served: true },
  { slug: 'aba', name: 'Aba', state: 'Abia', prefix: 'HC-AB', served: true },
  { slug: 'benin-city', name: 'Benin City', state: 'Edo', prefix: 'HC-BN', served: true },

  // --- the 36 state capitals, and the FCT -------------------------------
  { slug: 'umuahia', name: 'Umuahia', state: 'Abia', prefix: 'HC-UM' },
  { slug: 'yola', name: 'Yola', state: 'Adamawa', prefix: 'HC-YL' },
  { slug: 'uyo', name: 'Uyo', state: 'Akwa Ibom', prefix: 'HC-UY' },
  { slug: 'awka', name: 'Awka', state: 'Anambra', prefix: 'HC-AW' },
  { slug: 'bauchi', name: 'Bauchi', state: 'Bauchi', prefix: 'HC-BC' },
  { slug: 'yenagoa', name: 'Yenagoa', state: 'Bayelsa', prefix: 'HC-YG' },
  { slug: 'makurdi', name: 'Makurdi', state: 'Benue', prefix: 'HC-MK' },
  { slug: 'maiduguri', name: 'Maiduguri', state: 'Borno', prefix: 'HC-MD' },
  { slug: 'calabar', name: 'Calabar', state: 'Cross River', prefix: 'HC-CB' },
  { slug: 'asaba', name: 'Asaba', state: 'Delta', prefix: 'HC-AS' },
  { slug: 'abakaliki', name: 'Abakaliki', state: 'Ebonyi', prefix: 'HC-AK' },
  { slug: 'ado-ekiti', name: 'Ado-Ekiti', state: 'Ekiti', prefix: 'HC-AD' },
  { slug: 'enugu', name: 'Enugu', state: 'Enugu', prefix: 'HC-EN' },
  { slug: 'gombe', name: 'Gombe', state: 'Gombe', prefix: 'HC-GM' },
  { slug: 'dutse', name: 'Dutse', state: 'Jigawa', prefix: 'HC-DU' },
  { slug: 'kaduna', name: 'Kaduna', state: 'Kaduna', prefix: 'HC-KD' },
  { slug: 'kano', name: 'Kano', state: 'Kano', prefix: 'HC-KN' },
  { slug: 'katsina', name: 'Katsina', state: 'Katsina', prefix: 'HC-KT' },
  { slug: 'birnin-kebbi', name: 'Birnin Kebbi', state: 'Kebbi', prefix: 'HC-BK' },
  { slug: 'lokoja', name: 'Lokoja', state: 'Kogi', prefix: 'HC-LK' },
  { slug: 'ilorin', name: 'Ilorin', state: 'Kwara', prefix: 'HC-IR' },
  { slug: 'lagos', name: 'Lagos', state: 'Lagos', prefix: 'HC-LG' },
  { slug: 'lafia', name: 'Lafia', state: 'Nasarawa', prefix: 'HC-LF' },
  { slug: 'minna', name: 'Minna', state: 'Niger', prefix: 'HC-MN' },
  { slug: 'abeokuta', name: 'Abeokuta', state: 'Ogun', prefix: 'HC-OG' },
  { slug: 'akure', name: 'Akure', state: 'Ondo', prefix: 'HC-AKR' },
  { slug: 'osogbo', name: 'Osogbo', state: 'Osun', prefix: 'HC-OS' },
  { slug: 'ibadan', name: 'Ibadan', state: 'Oyo', prefix: 'HC-IB' },
  { slug: 'jos', name: 'Jos', state: 'Plateau', prefix: 'HC-JS' },
  { slug: 'sokoto', name: 'Sokoto', state: 'Sokoto', prefix: 'HC-SK' },
  { slug: 'jalingo', name: 'Jalingo', state: 'Taraba', prefix: 'HC-JL' },
  { slug: 'damaturu', name: 'Damaturu', state: 'Yobe', prefix: 'HC-DM' },
  { slug: 'gusau', name: 'Gusau', state: 'Zamfara', prefix: 'HC-GZ' },
  // Spelled FCT, not “FCT State”: the label rule below writes “{state} State”
  // for every other entry, and “FCT State” is not a thing anybody says.
  { slug: 'abuja', name: 'Abuja', state: 'FCT', prefix: 'HC-FC' },

  // --- the major commercial cities, where the trade actually happens ------
  { slug: 'onitsha', name: 'Onitsha', state: 'Anambra', prefix: 'HC-ON' },
  { slug: 'nnewi', name: 'Nnewi', state: 'Anambra', prefix: 'HC-NN' },
  { slug: 'nsukka', name: 'Nsukka', state: 'Enugu', prefix: 'HC-NS' },
  { slug: 'warri', name: 'Warri', state: 'Delta', prefix: 'HC-WR' },
  { slug: 'ijebu-ode', name: 'Ijebu-Ode', state: 'Ogun', prefix: 'HC-IJ' },
  { slug: 'ikorodu', name: 'Ikorodu', state: 'Lagos', prefix: 'HC-IK' },
  { slug: 'zaria', name: 'Zaria', state: 'Kaduna', prefix: 'HC-ZR' },
  { slug: 'ogbomoso', name: 'Ogbomoso', state: 'Oyo', prefix: 'HC-OB' },
  { slug: 'ile-ife', name: 'Ile-Ife', state: 'Osun', prefix: 'HC-IF' },
  { slug: 'ilesa', name: 'Ilesa', state: 'Osun', prefix: 'HC-IS' },
];

/** How a city's state reads in a sentence: “Rivers State”, but just “FCT”. */
function stateLabel(city) {
  if (!city || !city.state) return '';
  return city.state === 'FCT' ? 'FCT' : `${city.state} State`;
}

/** The catalogue entry for a token — a slug or the name as a person spells it. */
function findCity(token) {
  const value = String(token || '').trim();
  if (!value || value.length > 80) return null;
  const lower = value.toLowerCase();
  return CITIES.find((city) => city.slug === lower) || CITIES.find((city) => city.name.toLowerCase() === lower) || null;
}

module.exports = { CITIES, stateLabel, findCity };
