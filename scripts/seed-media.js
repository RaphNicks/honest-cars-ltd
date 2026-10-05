'use strict';

/**
 * Seed media resolver.
 *
 * The seed used to point every listing at a generated "photo pending" SVG. Real
 * photographs now live in public/img/{cars,details,site,blog,shop,hire}, and
 * this module decides which photo each seeded row gets:
 *
 *   • the gallery leads with the photo whose model (then body type) matches —
 *     a Camry listing leads with the Camry photo, an SUV with an SUV photo;
 *   • the rest of the gallery is the detail set (interior, dash, engine bay,
 *     tyres, boot) that every inspection sheet photographs anyway;
 *   • anything we do not have a photo for falls back to the placeholder SVG, so
 *     the seed never renders a broken image.
 *
 * Swap this file for a real importer the day the first dealer uploads stock —
 * the schema is the contract, not this resolver.
 */

const fs = require('node:fs');
const path = require('node:path');

const IMG_DIR = path.join(__dirname, '..', 'public', 'img');

/**
 * Photos we have, richest first. `colour` is the colour family in the frame, so
 * a red listing does not get handed the white car when a red one exists.
 * Add a line here when a new photo lands in public/img/cars/.
 */
const CAR_PHOTOS = [
  { file: 'toyota-camry-silver', model: /camry/i, make: /toyota/i, body: 'sedan', colour: 'light' },
  { file: 'toyota-corolla-white', model: /corolla/i, make: /toyota/i, body: 'sedan', colour: 'light' },
  { file: 'honda-accord-black', model: /accord/i, make: /honda/i, body: 'sedan', colour: 'dark' },
  { file: 'honda-civic-silver', model: /civic/i, make: /honda/i, body: 'sedan', colour: 'light' },
  { file: 'honda-crv-silver', model: /cr-?v/i, make: /honda/i, body: 'suv', colour: 'light' },
  { file: 'nissan-xtrail-grey', model: /x-?trail/i, make: /nissan/i, body: 'suv', colour: 'grey' },
  { file: 'lexus-rx350-grey', model: /rx\s?350/i, make: /lexus/i, body: 'suv', colour: 'grey' },
  { file: 'toyota-rav4-silver', model: /rav4/i, make: /toyota/i, body: 'suv', colour: 'light' },
  { file: 'toyota-prado-white', model: /prado|land\s?cruiser/i, make: /toyota/i, body: 'suv', colour: 'light' },
  { file: 'toyota-hilux-silver', model: /hilux/i, make: /toyota/i, body: 'pickup', colour: 'light' },
  { file: 'toyota-sienna-grey', model: /sienna/i, make: /toyota/i, body: 'van', colour: 'grey' },
  { file: 'mazda-cx5-red', model: /cx-?5/i, make: /mazda/i, body: 'suv', colour: 'red' },
  { file: 'ford-explorer-blue', model: /explorer/i, make: /ford/i, body: 'suv', colour: 'blue' },
  { file: 'mercedes-gle-white', model: /gle/i, make: /mercedes/i, body: 'suv', colour: 'light' },
  { file: 'mercedes-eclass-grey', model: /e-?class/i, make: /mercedes/i, body: 'sedan', colour: 'grey' },
];

/** Body-type stand-ins for models we have no photo of yet. */
const BODY_FALLBACK = {
  sedan: 'toyota-corolla-white',
  suv: 'honda-crv-silver',
  pickup: 'toyota-hilux-silver',
  van: 'toyota-sienna-grey',
  hatchback: 'toyota-corolla-white',
};

const COLOUR_FAMILY = {
  white: 'light',
  'pearl white': 'light',
  ash: 'light',
  silver: 'light',
  grey: 'grey',
  gray: 'grey',
  'champagne gold': 'grey',
  black: 'dark',
  'midnight blue': 'blue',
  'midnight-blue': 'blue',
  blue: 'blue',
  red: 'red',
};

/** The detail set — one photo per slot, filled as the photos land. */
const DETAIL_PHOTOS = {
  interior: 'interior',
  dash: 'dashboard',
  engine: 'engine-bay',
  tyres: 'tyres',
  boot: 'boot',
  odometer: 'odometer',
  rear: 'rear-seats',
};

const SHOT_KEYS = ['front-3q', 'side', 'rear-3q', 'interior', 'dash', 'odometer', 'engine', 'tyres'];

const SHOT_LABELS = {
  'front-3q': 'Front three-quarter',
  side: 'Side profile',
  'rear-3q': 'Rear three-quarter',
  interior: 'Interior',
  dash: 'Dashboard',
  odometer: 'Odometer close-up',
  engine: 'Engine bay',
  tyres: 'Tyres & tread',
  boot: 'Boot',
};

function exists(url) {
  if (typeof url !== 'string' || !url.startsWith('/img/')) return false;
  return fs.existsSync(path.join(IMG_DIR, url.replace('/img/', '')));
}

const carUrl = (file) => `/img/cars/${file}.jpg`;
const detailUrl = (file) => `/img/details/${file}.jpg`;

function colourFamily(value) {
  return COLOUR_FAMILY[String(value || '').trim().toLowerCase()] || null;
}

/**
 * Pick the photo whose model matches first, then the colour family, then the
 * body type. Deterministic, so the same listing always gets the same photo.
 */
function carPhotoFor(listing) {
  const body = String(listing.body || '').toLowerCase();
  const colour = colourFamily(listing.extColour);

  const scored = CAR_PHOTOS.map((photo) => {
    if (!exists(carUrl(photo.file))) return null;
    let score = 0;
    if (photo.model && photo.model.test(listing.model || '')) score += 8;
    if (photo.make && photo.make.test(listing.make || '')) score += 2;
    if (colour && photo.colour === colour) score += 3;
    if (photo.body === body) score += 2;
    return { photo, score };
  }).filter(Boolean);

  scored.sort((a, b) => b.score - a.score || a.photo.file.localeCompare(b.photo.file));
  if (scored.length && scored[0].score > 0) return scored[0].photo.file;

  const fallback = BODY_FALLBACK[body] || BODY_FALLBACK.sedan;
  return exists(carUrl(fallback)) ? fallback : null;
}

function detailPhoto(slot) {
  const file = DETAIL_PHOTOS[slot];
  if (!file) return null;
  return exists(detailUrl(file)) ? file : null;
}

/**
 * The gallery for one listing: the hero photo, the side/rear frames if we have
 * them, then the detail set. Missing photos are simply not faked.
 */
function galleryFor(listing) {
  const hero = carPhotoFor(listing);
  const shots = [];

  if (hero) {
    shots.push({ key: 'front-3q', url: carUrl(hero) });
    if (exists(detailUrl('side'))) shots.push({ key: 'side', url: detailUrl('side') });
    if (exists(detailUrl('rear-3q'))) shots.push({ key: 'rear-3q', url: detailUrl('rear-3q') });
  }

  for (const slot of ['interior', 'dash', 'engine', 'tyres', 'boot', 'odometer']) {
    const file = detailPhoto(slot);
    if (file) shots.push({ key: slot, url: detailUrl(file) });
  }

  return shots;
}

/**
 * Named slots that are honestly the same subject as a photo we already have.
 *
 * §6.7 hire classes name their examples, so "Sedan — Camry, Corolla, Accord"
 * is a Camry photo, "Pickup — Hilux, Ranger" is the Hilux, and so on. This is
 * not a placeholder: it is the right picture, and it is why the hire page has
 * real photographs before the shoot for it has happened.
 */
const HIRE_PHOTOS = {
  sedan: '/img/cars/toyota-camry-silver.jpg',
  suv: '/img/hire/suv.jpg',
  pickup: '/img/cars/toyota-hilux-silver.jpg',
  luxury: '/img/cars/toyota-prado-white.jpg',
  'executive-corporate': '/img/cars/mercedes-eclass-grey.jpg',
  bus: '/img/hire/bus.jpg',
};

/**
 * Blog hero fallbacks: an article about a specific car, or about a specific
 * part of one, is illustrated by that car or that part.
 */
const BLOG_HEROES = {
  '2015-toyota-camry-honest-buyers-guide': '/img/cars/toyota-camry-silver.jpg',
  // The photo does not carry the whole slug in its filename; these two posts
  // were written after the images landed.
  'first-car-under-10m-port-harcourt': '/img/blog/first-car-under-10m.jpg',
  'inspection-walkaround-video': '/img/blog/inspection-walkaround-video.jpg',
};

/** The hire-class photo: the dedicated one if it exists, else the honest match. */
function hirePhoto(slug) {
  return photo('hire', slug) || (exists(HIRE_PHOTOS[slug]) ? HIRE_PHOTOS[slug] : null);
}

/** The blog hero: the dedicated file if it exists, else the subject match. */
function blogHero(slug) {
  return photo('blog', slug) || (exists(BLOG_HEROES[slug]) ? BLOG_HEROES[slug] : null);
}

/** True when a listing has at least one real photograph. */
function hasRealPhotos(listing) {
  return galleryFor(listing).length > 0;
}

/**
 * A named photo for products, posts, hire classes and page heroes.
 * @returns {string|null} public URL of the prepared photo, or null.
 */
function photo(group, name) {
  const url = `/img/${group}/${name}.jpg`;
  return exists(url) ? url : null;
}

module.exports = {
  CAR_PHOTOS,
  DETAIL_PHOTOS,
  HIRE_PHOTOS,
  BLOG_HEROES,
  SHOT_KEYS,
  SHOT_LABELS,
  carPhotoFor,
  detailPhoto,
  galleryFor,
  hasRealPhotos,
  photo,
  hirePhoto,
  blogHero,
  exists,
};
