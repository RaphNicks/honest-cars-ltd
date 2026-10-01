'use strict';

/**
 * Concierge flow spec — §6.5, shared by the view, the client module and the
 * server endpoint so the four steps can never drift apart.
 *
 * The promise is fixed: three verified options in 48–72 hours. What varies is
 * how fast you want them — three SLA options, all inside that window — and the
 * retainer is credited against the success fee either way.
 */

const SLA_OPTIONS = [
  {
    key: 'standard',
    label: 'Standard — 72 hours',
    hours: 72,
    retainerKobo: 5_000_000,
    note: 'Three verified options inside three working days.',
  },
  {
    key: 'priority',
    label: 'Priority — 48 hours',
    hours: 48,
    retainerKobo: 6_500_000,
    note: 'Front of the queue: two working days, same three options.',
  },
  {
    key: 'urgent',
    label: 'Same-week urgent — 48 hours + daily WhatsApp updates',
    hours: 48,
    retainerKobo: 7_500_000,
    note: 'For buyers flying in or holding a deposit deadline.',
  },
];

const MUST_HAVES = [
  'AC must chill',
  'low mileage',
  'first-car friendly',
  'fuel economy',
  'family size',
  'ground clearance',
  'automatic only',
  'service history',
];

const INTENDED_USE = [
  { key: 'commute', label: 'Daily commute' },
  { key: 'family', label: 'Family car' },
  { key: 'business', label: 'Business / executive' },
  { key: 'ride_hailing', label: 'Ride-hailing' },
];

const TIMELINES = [
  { key: 'asap', label: 'ASAP' },
  { key: 'two_weeks', label: 'Within 2 weeks' },
  { key: 'month', label: 'This month' },
  { key: 'researching', label: 'Just researching' },
];

const ADDONS = [
  {
    key: 'inspection_included',
    label: 'Physical inspection of every option',
    copy: 'Included on every concierge search — an inspector stands next to each car before you do.',
    included: true,
  },
  {
    key: 'document_verification',
    label: 'Document deep-verification',
    copy: 'Customs, registration and duty papers checked at the source before you commit.',
    priceKobo: 2_500_000,
  },
  {
    key: 'tracker_install',
    label: 'Tracker installed on delivery',
    copy: 'Standard tracker fitted before handover, first year of monitoring paid.',
    priceKobo: 4_500_000,
  },
  {
    key: 'service_intro',
    label: 'Post-purchase service intro',
    copy: 'We introduce you to a mechanic who knows the model, and schedule the first service.',
    priceKobo: 0,
  },
];

const DEFAULT_SLA = 'standard';

function slaOption(key) {
  return SLA_OPTIONS.find((option) => option.key === key) || SLA_OPTIONS[0];
}

module.exports = { SLA_OPTIONS, MUST_HAVES, INTENDED_USE, TIMELINES, ADDONS, DEFAULT_SLA, slaOption };
