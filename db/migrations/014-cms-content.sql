-- ---------------------------------------------------------------------------
-- 014 — CMS content: post meta and homepage modules
--
-- Two gaps closed here.
--
-- 1. The six seeded posts predate the CMS meta columns, so the workflow could
--    never move them to Published (meta title and description are required at
--    that gate, and §6.9 requires at least three listing or service links).
--    The descriptions below are the same ones the seed now carries.
--
-- 2. homepage_modules existed but was empty. Four modules are seeded so the
--    console opens onto real content: the marketing banner (shipped inactive,
--    so the homepage design does not change until someone turns it on), the
--    hero copy, the counter labels, and the hand-picked featured rail.
--
-- The counters module intentionally holds labels, not numbers. Live counts keep
-- coming from the database, so a stale figure can never be published by
-- accident — marketing can reword what the counter says, not what it counts.
--
-- DOWN
--   UPDATE blog_posts SET meta_title = NULL, meta_description = NULL
--    WHERE slug IN (six slugs above);
--   DELETE FROM homepage_modules WHERE key IN ('hero','announcement','counters','featured');
-- ---------------------------------------------------------------------------

UPDATE blog_posts SET
  meta_title = 'The 2015 Toyota Camry: what ₦12m buys in Port Harcourt',
  meta_description = 'Three 2015 Camrys, the same week, the same checklist. What a clean one is worth, what the tired ones hide, and what to check before you pay.'
WHERE slug = '2015-toyota-camry-honest-buyers-guide' AND meta_title IS NULL;

UPDATE blog_posts SET
  meta_title = 'Tokunbo vs Nigerian-used: the honest maths for PH',
  meta_description = 'A cheaper import is not always cheaper. The five-year cost lines we actually add up for Port Harcourt buyers, and when each side wins.'
WHERE slug = 'tokunbo-vs-nigerian-used-ph' AND meta_title IS NULL;

UPDATE blog_posts SET
  meta_title = 'How to check an odometer before you pay a deposit',
  meta_description = 'Seven checks anyone can do in ten minutes, the two tricks that survive them all, and the ₦1.5m–₦3m you are betting when you trust the dash.'
WHERE slug = 'odometer-fraud-check-yourself' AND meta_title IS NULL;

UPDATE blog_posts SET
  meta_title = 'Customs papers, explained without the jargon',
  meta_description = 'Duty paid, duty sighted, customs verified, registration complete — what each term really means, and the VIN check that decides whether you can register the car.'
WHERE slug = 'customs-papers-explained' AND meta_title IS NULL;

UPDATE blog_posts SET
  meta_title = 'What 100km really costs in PH traffic, by model',
  meta_description = 'Observed consumption for Corolla, Camry, CR-V, RX 350 and Hilux on the same Port Harcourt run, converted into what a year of driving actually costs.'
WHERE slug = 'ph-fuel-cost-by-model' AND meta_title IS NULL;

UPDATE blog_posts SET
  meta_title = 'Three tyre conditions that should end your inspection',
  meta_description = 'Uneven wear, mismatched brands and cracked sidewalls: what each one tells you about the owner, and what replacement really costs in Port Harcourt.'
WHERE slug = 'tyres-you-should-walk-away-from' AND meta_title IS NULL;

INSERT INTO homepage_modules (`key`, title, payload, is_active, position) VALUES
  ('hero', 'Homepage hero', JSON_OBJECT(
      'headline', NULL,
      'subhead', NULL
   ), 0, 10),
  ('announcement', 'Marketing banner', JSON_OBJECT(
      'text', 'Free inspection on any car over ₦20m booked before the end of the month.',
      'label', 'Book a slot',
      'href', '/services/inspection'
   ), 0, 20),
  ('counters', 'Trust counter labels', JSON_OBJECT(
      'note', 'Counts stay live from the database. Edit the wording only.',
      'labels', JSON_OBJECT(
        'carsLive', 'cars live in the network',
        'partnerDealers', 'partner dealers in PH',
        'certified', 'HonestCars-Certified cars',
        'carsSold90d', 'deals closed in 90 days'
      )
   ), 1, 30),
  ('featured', 'Featured rail', JSON_OBJECT(
      'heading', 'Featured this week',
      'subheading', 'Hand-picked by the ops desk. Every one of them has been inspected.',
      'listing_slugs', JSON_ARRAY(),
      'service_slugs', JSON_ARRAY()
   ), 0, 40)
ON DUPLICATE KEY UPDATE `key` = `key`;
