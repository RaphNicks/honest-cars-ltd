'use strict';

/**
 * Editorial seed content, kept apart from the generator so a writer can edit
 * copy without touching build logic.
 *
 * Pricing note: the PRD points at the Business Operating Document §12 for real
 * figures, which we do not have. The ₦ numbers below are market-plausible Port
 * Harcourt placeholders and are called out in the README as needing client
 * confirmation before launch.
 *
 * Body blocks are shared by service pages, blog posts and CMS pages:
 *   paragraph · heading · callout · checklist · table · quote · youtube ·
 *   listings · stats
 */

// ---------------------------------------------------------------------------
// §6.7 — service pages, on the shared template
// ---------------------------------------------------------------------------
const SERVICES = {
  inspection: {
    hero_copy:
      'An inspector stands next to the car, scans it, checks the papers and writes down what is actually wrong with it. You get the report before you spend a naira — including the parts the seller would rather you did not know about.',
    sla_copy: 'Report lands in your account within 4 hours of the check.',
    jobs_done: 612,
    booking_kind: 'inspection',
    deliverables: [
      { title: 'OBD2 scan', copy: 'Every fault code read and photographed, including the stored history the dash light hides.' },
      { title: 'Panel & chassis check', copy: 'Paint depth, panel gaps, jig marks and the spare-wheel well — the three places flood and accident repairs hide.' },
      { title: 'Documents sighted', copy: 'Customs papers, registration and duty documents read by us, not described to us by a seller.' },
      { title: 'Road test', copy: 'Gearbox, suspension, brakes and steering driven on real Port Harcourt roads — not around the lot.' },
      { title: 'Photo record', copy: 'Front ¾, rear ¾, interior, dash, engine bay and odometer, so you can compare two cars properly.' },
      { title: 'Honest note, in writing', copy: 'A plain-language paragraph naming the faults. It goes on the listing where the buyer can read it.' },
    ],
    included: [
      'Physical inspection at the seller’s location in Port Harcourt',
      'OBD2 scan with photographed codes',
      'Document verification (customs, registration, duty)',
      'Road test on public roads',
      'Photo set and written honesty note',
      'Report delivered within 4 hours of the check',
    ],
    excluded: [
      'Repairs of any kind — we inspect, we do not fix',
      'Government agency fees for document transfer',
      'Cars outside Rivers State (arrangeable, travel quoted separately)',
      'Lifting the car on a ramp — we can arrange it at extra cost if you want it',
    ],
    steps: [
      { title: 'Book and pay for the slot', copy: 'Pick a date, tell us where the car is, pay the inspection fee.', timeline: '2 minutes' },
      { title: 'We confirm with the seller', copy: 'We call the dealer and lock the appointment so the car is clean and ready.', timeline: 'Within 2 hours' },
      { title: 'The inspector attends', copy: 'You do not need to be there. You get a call 30 minutes before arrival if you want to be.', timeline: 'On your chosen date' },
      { title: 'Report delivered', copy: 'Photos, codes, documents status and the honest note land in your account and on WhatsApp.', timeline: 'Within 4 hours of the check' },
      { title: 'You decide', copy: 'Buy, negotiate with our report in hand, or walk away. We do not get paid by the seller, so we have no reason to sell you the car.', timeline: 'Your call' },
    ],
    pricing: [
      { tier: 'Single car', price: 'from ₦25,000', includes: ['One inspection, one car', 'Full report in 4 hours', 'WhatsApp follow-up with the inspector'] },
      { tier: 'Two cars compared', price: 'from ₦45,000', includes: ['Two inspections', 'Side-by-side comparison page', 'A recommendation you can act on'] },
      { tier: 'Certified listing pack', price: 'from ₦40,000', includes: ['Inspection + report', 'HonestCars-Certified grade on the listing', 'Better price positioning for sellers'] },
    ],
    proof: [
      { name: 'Chidi O.', area: 'Woji', quote: 'They told me the Camry I liked had a resprayed boot lid before I paid. No other lot would have said that. I bought it anyway, with my eyes open.' },
      { name: 'Tunde A.', area: 'Trans-Amadi', quote: 'The report had photos of the actual fault codes. My mechanic read it and agreed with every line.' },
    ],
  },

  documents: {
    hero_copy:
      'Customs verification, registration, licence renewal, tinted permit and insurance — handled by people who do it every week, with photos of your papers at every stage.',
    sla_copy: 'Most documents complete in 7–14 working days.',
    jobs_done: 388,
    booking_kind: 'documents',
    deliverables: [
      { title: 'Customs verification', copy: 'We verify that the duty paid matches the vehicle and VIN — the check that stops a cheap car becoming an expensive mistake.' },
      { title: 'Registration & plate transfer', copy: 'Documents lodged with the agency and followed up, so you are not the one queueing.' },
      { title: 'Licence renewal', copy: 'Driver’s and vehicle licence renewals, with the receipt sent to you the day it is issued.' },
      { title: 'Tinted permit', copy: 'Permit applications for tinted glass, including the checks the police will ask for at a checkpoint.' },
      { title: 'Insurance placement', copy: 'Third party or comprehensive, quoted from partner underwriters and placed in your name.' },
      { title: 'Document wallet', copy: 'Everything you paid for, scanned and stored in your account — so a lost paper is not a lost week.' },
    ],
    included: [
      'Document verification against your VIN and engine number',
      'Agency and permit fees at cost, itemised on your invoice',
      'Photo evidence of every paper we handle',
      'Status updates on WhatsApp without you chasing',
      'Scanned copies in your account when it is done',
    ],
    excluded: [
      'Fines or penalties already incurred on the vehicle — these are payable by the owner at the time',
      'Court-ordered or disputed ownership cases',
      'Papers for vehicles physically outside Nigeria',
    ],
    steps: [
      { title: 'Tell us what you need', copy: 'Pick the service, upload photos of the papers you already have.', timeline: '5 minutes' },
      { title: 'We quote and confirm', copy: 'A written quote itemising agency fees, our fee and the timeline. No hidden lines.', timeline: 'Within 1 working day' },
      { title: 'You pay, we file', copy: 'Payment moves through protected channels and we start the same day.', timeline: 'Same day' },
      { title: 'We chase it down', copy: 'Every agency step gets a photo and a message. You will know before you ask.', timeline: '7–14 working days' },
      { title: 'Handover', copy: 'Original documents handed over in PH, scans stored in your account.', timeline: 'On completion' },
    ],
    pricing: [
      { tier: 'Customs verification', price: 'from ₦30,000', includes: ['Duty and VIN cross-check', 'Written verification report', 'Advice if the papers do not match'] },
      { tier: 'Registration & plates', price: 'from ₦85,000', includes: ['Agency fees at cost', 'Lodgement and follow-up', 'Receipts and scans in your account'] },
      { tier: 'Full document pack', price: 'from ₦150,000', includes: ['Verification + registration + insurance', 'Tinted permit where eligible', 'One point of contact end to end'] },
    ],
    proof: [
      { name: 'Ngozi I.', area: 'Peter Odili Road', quote: 'The verification caught that the duty paper did not match the VIN. That one check saved me from a car I could never have registered.' },
    ],
  },

  concierge: {
    hero_copy:
      'Tell us the brief once — budget, use, must-haves — and we search the network, inspect the shortlist and bring you up to three verified options within 48–72 hours. You never speak to a dealer you have not chosen.',
    sla_copy: 'Up to 3 inspected options in 48–72 hours, or the retainer comes back to you.',
    jobs_done: 194,
    booking_kind: 'request',
    deliverables: [
      { title: 'A real search, not a filter', copy: 'We call partner lots, check stock we have not listed, and look at cars that match your brief rather than your keywords.' },
      { title: 'Every option inspected', copy: 'Physical inspection of each car we put in front of you, with the report attached. This is included, not an upsell.' },
      { title: 'Documents checked', copy: 'Customs, registration and duty status confirmed before the car makes your shortlist.' },
      { title: 'A shortlist, not a dump', copy: 'Up to three options with the honest case for and against each one. Fewer options is the point.' },
      { title: 'Negotiation on your behalf', copy: 'We know the market band for the model and we negotiate from it, with the inspection report on the table.' },
      { title: 'Protected purchase', copy: 'If you buy through us, payment moves through HonestCars-protected channels and milestones, not directly to a seller.' },
    ],
    included: [
      'Up to 3 inspected, document-checked options inside 48–72 hours',
      'An options page you can open on your phone, with photos and reports',
      'Viewings arranged and attended with you',
      'Negotiation against live market data',
      'Retainer credited against the success fee when you buy through us',
    ],
    excluded: [
      'The car itself — you pay the seller, through us',
      'Financing (we can introduce a partner, we do not lend)',
      'Cars outside Rivers State unless you ask for them',
      'The success fee, which is separate and always quoted before you commit',
    ],
    steps: [
      { title: 'Send the brief', copy: 'Four short steps: the car you want, the protection you want, who you are, and the retainer.', timeline: '10 minutes' },
      { title: 'We search and inspect', copy: 'Network calls, physical inspections, document checks — the work you would otherwise do for three weekends.', timeline: '48–72 hours' },
      { title: 'Options ready', copy: 'Up to three cars on a comparison page, with the honest case for each. You pick which to see.', timeline: 'Day 3' },
      { title: 'Viewings', copy: 'We attend with you, or go alone and send video. Your call.', timeline: 'Your schedule' },
      { title: 'Close, protected', copy: 'We negotiate, you pay through protected channels, and the documents are completed before handover.', timeline: 'Same week' },
    ],
    pricing: [
      { tier: 'Concierge search', price: '₦50,000 retainer', includes: ['Credited against the success fee', 'Refunded if we find nothing that meets your brief', 'Up to 3 inspected options'] },
      { tier: 'Concierge + documents', price: '₦50,000 + document pack', includes: ['Everything in Concierge', 'Customs verification and registration handled', 'One point of contact to the keys'] },
      { tier: 'Concierge + tracker', price: '₦50,000 + tracker bundle', includes: ['Everything in Concierge', 'Tracker fitted before handover', 'First year of monitoring'] },
    ],
    proof: [
      { name: 'Mrs. Amadi', area: 'GRA Phase 2', quote: 'I sent my brief at night and had three inspected options by Thursday. Only one had papers that were actually clean, and that is the one they pushed me towards.' },
      { name: 'Fleet officer, oil & gas firm', area: 'Port Harcourt', quote: 'We asked for four cars with the same brief. They came back with options, prices and documents in one document we could circulate internally.' },
    ],
  },

  tracking: {
    hero_copy:
      'Standard, Premium and Fleet tracker bundles fitted in Port Harcourt, with monitoring, geofencing and a renewal we remind you about before it lapses — not after.',
    sla_copy: 'Installation within 48 hours of booking in Port Harcourt.',
    jobs_done: 271,
    booking_kind: 'install',
    deliverables: [
      { title: 'Fitted, not posted', copy: 'An installer comes to your home or office in PH and hides the unit properly. No loose wiring under the dash.' },
      { title: 'Live location', copy: 'See your car on a map from your phone, with movement history for the last 90 days.' },
      { title: 'Geofencing & alerts', copy: 'Get a message if the car moves outside a zone you draw, at a time it should be parked, or above a speed you set.' },
      { title: 'Immobiliser options', copy: 'Remote fuel cut on Premium and Fleet, so a stolen car can be stopped rather than chased.' },
      { title: 'Fleet view', copy: 'Fleet bundles include one dashboard for every vehicle, driver behaviour and monthly reporting.' },
      { title: 'Renewal that does not lapse', copy: 'Subscription tracked in our system; you get a reminder at 30, 7 and 1 day, and you can renew online.' },
    ],
    included: [
      'Device, SIM and first-year monitoring subscription',
      'Professional installation in Port Harcourt',
      'Mobile app access with 90-day history',
      'Geofence and movement alerts by WhatsApp or SMS',
      'Replacement reminder before renewal',
    ],
    excluded: [
      'Recovery operations — we hand the location to the police and your insurer, we do not run a chase unit',
      'Damage to a vehicle during recovery by third parties',
      'Installation outside Rivers State (arrangeable, travel quoted separately)',
    ],
    steps: [
      { title: 'Pick a bundle', copy: 'Standard, Premium or Fleet. We tell you plainly what each one will not do.', timeline: '5 minutes' },
      { title: 'Book the install slot', copy: 'Choose a time and place. Home, office or the lot where you are collecting the car.', timeline: '2 minutes' },
      { title: 'Installation', copy: 'A technician fits and tests the unit, then shows you the app on your own phone.', timeline: '45–60 minutes' },
      { title: 'Activation', copy: 'Platform activated, alerts configured and the subscription clock started.', timeline: 'Same day' },
      { title: 'Renewals', copy: 'Reminders at 30, 7 and 1 day, and online renewal so cover never lapses.', timeline: 'Annual' },
    ],
    pricing: [
      { tier: 'Standard', price: 'from ₦45,000', includes: ['Live location + 90-day history', 'Geofence alerts', 'First-year subscription'] },
      { tier: 'Premium', price: 'from ₦85,000', includes: ['Everything in Standard', 'Remote fuel cut', 'Tow and impact alerts'] },
      { tier: 'Fleet', price: 'quoted per vehicle', includes: ['Everything in Premium', 'Fleet dashboard + driver scorecards', 'Monthly reporting and account manager'] },
    ],
    proof: [
      { name: 'Emeka N.', area: 'Rumuokoro', quote: 'Installed in my compound on a Saturday morning. The renewal reminder came a month early, which is the opposite of every other service I pay for.' },
    ],
  },

  research: {
    hero_copy:
      'Reports for people making a decision worth millions: total cost of ownership over five years, auction sourcing analysis, and an honest price check on a car you are about to buy.',
    sla_copy: 'Delivered to your account within 48–72 hours.',
    jobs_done: 96,
    booking_kind: 'request',
    deliverables: [
      { title: 'TCO report', copy: 'Five-year cost of ownership for a specific model: fuel at real PH consumption, parts, servicing, insurance, depreciation and the resale band.' },
      { title: 'Auction sourcing analysis', copy: 'What a specific grade actually lands at when you add duty, clearing, transport and the surprises. The number on the auction sheet is not the number you pay.' },
      { title: 'Market price check', copy: 'An independent read on whether a car you are looking at is priced fairly against live network data, in writing.' },
      { title: 'Written, not verbal', copy: 'A PDF you can send to a partner, a company finance team or your own future self.' },
      { title: 'Live data', copy: 'Built from our live inventory and price-band table, refreshed weekly — not from articles written three years ago.' },
      { title: 'A call to walk through it', copy: '30 minutes with the analyst who wrote it, included.' },
    ],
    included: [
      'Custom research against your brief',
      'PDF delivered to your account',
      'A 30-minute walkthrough call',
      'Data appendix so you can check our working',
    ],
    excluded: [
      'Guaranteed outcomes — these are estimates with stated assumptions',
      'Vehicle inspection (that is a separate service)',
      'Investment or tax advice',
    ],
    steps: [
      { title: 'Choose the report', copy: 'TCO, auction analysis or price check.', timeline: '2 minutes' },
      { title: 'Send the brief', copy: 'The model, year, usage and the decision you are trying to make.', timeline: '5 minutes' },
      { title: 'We research', copy: 'Live listings, price bands, parts pricing from PH suppliers and fuel data.', timeline: '48–72 hours' },
      { title: 'You get the file', copy: 'PDF in your account, plus the walkthrough call.', timeline: 'Day 3' },
    ],
    pricing: [
      { tier: 'Market price check', price: '₦35,000', includes: ['One model, one price question', 'Written verdict with comparables', '48-hour delivery'] },
      { tier: 'TCO report', price: '₦75,000', includes: ['Five-year cost model', 'Fuel, parts, service, insurance, depreciation', 'Walkthrough call'] },
      { tier: 'Auction sourcing analysis', price: '₦120,000', includes: ['Landed-cost model for a specific lot', 'Duty and clearing assumptions', 'Risk notes and inspection plan'] },
    ],
    proof: [
      { name: 'Adaora K.', area: 'Trans-Amadi', quote: 'The TCO report talked me out of the V6 I wanted and into a car I can actually run. That is the first time a report has saved me money instead of costing me.' },
    ],
  },

  consultation: {
    hero_copy:
      'Thirty minutes with someone who buys cars in Port Harcourt for a living. Bring your shortlist, your budget and your doubts; leave with a decision you can act on.',
    sla_copy: 'Slots same week, video call link issued instantly.',
    jobs_done: 143,
    booking_kind: 'consultation',
    deliverables: [
      { title: 'A straight opinion', copy: 'We tell you which of your shortlisted cars we would buy and which one we would walk away from — and why.' },
      { title: 'Budget reality check', copy: 'What your budget actually buys in PH this month, including the running costs people forget.' },
      { title: 'Paperwork briefing', copy: 'What to check on customs, registration and duty before you pay anyone.' },
      { title: 'Negotiation lines', copy: 'The specific facts from your inspection report that move a dealer’s price.' },
      { title: 'A written summary', copy: 'Notes from the call in your account, so you do not have to remember it in the dealer’s office.' },
    ],
    included: [
      '30-minute video or phone call with a senior team member',
      'Pre-call review of any listings you send us',
      'Written summary afterwards',
      'Follow-up question by WhatsApp within 7 days',
    ],
    excluded: [
      'Physical inspection of a specific car (book that separately)',
      'Legal advice on ownership disputes',
      'Dealer introductions where you have not asked for them',
    ],
    steps: [
      { title: 'Pick a slot', copy: 'See real availability and choose a time that works.', timeline: '2 minutes' },
      { title: 'Tell us about the decision', copy: 'Short brief and any listings you want us to look at first.', timeline: '5 minutes' },
      { title: 'The call', copy: 'Thirty focused minutes. Bring your questions, including the awkward ones.', timeline: '30 minutes' },
      { title: 'Summary and follow-up', copy: 'Notes in your account and a week of WhatsApp follow-up.', timeline: 'Same day' },
    ],
    pricing: [
      { tier: 'Single session', price: '₦10,000', includes: ['30-minute call', 'Written summary', '7 days of follow-up'] },
      { tier: 'Three sessions', price: '₦25,000', includes: ['Three calls over the buying process', 'Listing review between calls', 'Priority scheduling'] },
      { tier: 'Corporate briefing', price: 'quoted', includes: ['Session for a fleet or procurement team', 'Tailored to your vehicle policy', 'Written briefing pack'] },
    ],
    proof: [
      { name: 'Ibrahim S.', area: 'Choba', quote: 'He looked at the two adverts I sent, named the faults each one would have before I even inspected them, and was right about both.' },
    ],
  },

  parts: {
    hero_copy:
      'VIN-matched parts sourced from suppliers we buy from ourselves, with escrow-protected milestone payment. No guessing, no “it will fit”, no disappearing deposit.',
    sla_copy: 'Quote within 24 hours; most parts land in PH within 5–10 days.',
    jobs_done: 205,
    booking_kind: 'request',
    deliverables: [
      { title: 'VIN-matched, not guessed', copy: 'We match to your VIN and engine code so the part fits the car you actually own.' },
      { title: 'Sourced from real suppliers', copy: 'Local PH suppliers and importers we have a history with, with the option of genuine or OEM-grade parts priced side by side.' },
      { title: 'Escrow-protected payment', copy: 'Funds sit with us and release at milestones — part confirmed, part delivered, part fitted.' },
      { title: 'Fitment arrangement', copy: 'A workshop that knows the model, with the labour quoted before it starts.' },
      { title: 'Warranty in writing', copy: 'What the supplier will and will not cover, written on the quote rather than promised on a phone call.' },
    ],
    included: [
      'VIN and engine code matching',
      'Written quote with genuine vs OEM-grade options',
      'Escrow milestone payment',
      'Delivery in Port Harcourt and fitment referral',
      'Supplier warranty documented',
    ],
    excluded: [
      'Fitting fees are quoted separately unless you ask for them bundled',
      'Parts for vehicles we cannot identify by VIN',
      'Customs clearance on special imports beyond the quoted window',
    ],
    steps: [
      { title: 'Send the VIN and the part', copy: 'Photos of the old part help. So does the fault code.', timeline: '5 minutes' },
      { title: 'Quote', copy: 'Written quote with options, lead time and warranty terms.', timeline: 'Within 24 hours' },
      { title: 'You fund the escrow', copy: 'Money moves to a protected milestone, not to a stranger.', timeline: 'Same day' },
      { title: 'Part sourced and delivered', copy: 'Milestone released when the part is confirmed and delivered.', timeline: '5–10 days' },
      { title: 'Fitment', copy: 'Fitted at a workshop that knows the platform, if you want it.', timeline: '1 day' },
    ],
    pricing: [
      { tier: 'Sourcing', price: 'from ₦15,000 sourcing fee', includes: ['VIN matching and quote', 'Supplier comparison', 'Escrow protection'] },
      { tier: 'Sourcing + fitment', price: 'from ₦25,000 + labour', includes: ['Everything in Sourcing', 'Workshop booking', 'Post-fitment check'] },
      { tier: 'Fleet parts account', price: 'quoted', includes: ['Account terms for fleets', 'Consolidated monthly invoicing', 'Priority sourcing'] },
    ],
    proof: [
      { name: 'Godwin E.', area: 'Elelenwo', quote: 'Two shops sold me the wrong gearbox mount before these people matched it to the VIN. Third one fitted first time.' },
    ],
  },

  'sell-swap': {
    hero_copy:
      'A free valuation within 24 hours from live network data, then we sell it for you or swap it into the car you actually want. No tyre-kickers, no “bring your papers and we will see”.',
    sla_copy: 'Valuation within 24 hours; most sales close inside 14 days.',
    jobs_done: 158,
    booking_kind: 'request',
    deliverables: [
      { title: 'Valuation from live data', copy: 'Priced against what cars like yours are actually selling for in Port Harcourt this month — not a guess from a book.' },
      { title: 'Photography that sells it', copy: 'The full shot list — front ¾, rear ¾, interior, dash, engine, odometer — taken properly, once.' },
      { title: 'Buyers who are filtered', copy: 'We field the calls, screen the “last price?” merchants, and only bring you people who can pay.' },
      { title: 'Optional certification', copy: 'An inspection that earns your car the HonestCars-Certified grade and a higher price positioning.' },
      { title: 'Swap matching', copy: 'If you are upgrading, we search for your next car while selling this one, and you only pay the difference.' },
      { title: 'Paperwork handled', copy: 'Transfer, registration and change of ownership completed so there is no comeback on you later.' },
    ],
    included: [
      'Free valuation within 24 hours',
      'Listing on HonestCars with photography',
      'Buyer screening and viewings coordination',
      'Negotiation on your behalf',
      'Document transfer support at close',
    ],
    excluded: [
      'Outstanding fines, liens or loans on the vehicle — these must be cleared before sale',
      'Repair work before sale (we can quote it, you decide)',
      'Guaranteed sale price — valuations are ranges, final price is the market’s',
    ],
    steps: [
      { title: 'Tell us about the car', copy: 'Basics, condition, documents status and photos. Ten minutes, and you can finish it later if you are interrupted.', timeline: '10 minutes' },
      { title: 'Valuation', copy: 'A range with the reasoning, plus the price a certified example would fetch.', timeline: 'Within 24 hours' },
      { title: 'We list and screen', copy: 'Photos, listing, buyer calls and viewings — all handled.', timeline: 'Days 2–10' },
      { title: 'Deal and paperwork', copy: 'We negotiate, you approve, documents transfer cleanly.', timeline: 'Days 10–14' },
    ],
    pricing: [
      { tier: 'Sell for me', price: 'commission on sale', includes: ['Valuation, photography and listing', 'Buyer screening and viewings', 'Negotiation and paperwork'] },
      { tier: 'Sell + certification', price: 'commission + inspection fee', includes: ['Everything in Sell for me', 'Inspection and Certified grade', 'Higher price positioning'] },
      { tier: 'Swap', price: 'commission on sale + search fee', includes: ['Everything in Sell for me', 'Concierge search for your next car', 'You pay only the difference'] },
    ],
    proof: [
      { name: 'Blessing O.', area: 'Ada George', quote: 'They valued it on Tuesday, listed it Wednesday, and I signed on the following Monday. I did not take a single “last price” call.' },
    ],
  },

  hire: {
    hero_copy:
      'Daily, weekly and corporate hire with or without a driver, including Omagwa airport pickup. Vetted cars, real invoices, and a replacement if anything fails.',
    sla_copy: 'Quote within 2 hours; corporate RFQs within 1 working day.',
    jobs_done: 342,
    booking_kind: 'request',
    deliverables: [
      { title: 'A car that turns up', copy: 'Serviced, insured, tracked and fuelled, delivered where you asked for it.', phone: true },
      { title: 'Driver or self-drive', copy: 'Vetted drivers who know Port Harcourt, or the keys in your hand if you prefer.' },
      { title: 'Airport pickup', copy: 'Omagwa arrivals met with a name board, including the delayed-flight version of that plan.' },
      { title: 'Corporate terms', copy: 'RFQ, PO and invoice paperwork that finance departments actually accept, with monthly consolidated billing available.' },
      { title: 'Replacement guarantee', copy: 'If the vehicle fails during your hire, a replacement is dispatched — you are not left roadside in the rain.' },
      { title: 'Tracking on every unit', copy: 'Every hire vehicle carries a tracker, which is as much for your safety as our asset protection.' },
    ],
    included: [
      'Comprehensive insurance and tracker on every vehicle',
      'Routine maintenance and a 24-hour breakdown line',
      'Airport pickup at Omagwa on request',
      'Written quote with no hidden mileage surprises',
      'Invoice with TIN for corporate accounts',
    ],
    excluded: [
      'Traffic fines incurred during the hire period',
      'Fuel beyond the first tank on self-drive hires',
      'Damage excess, which is stated on the quote before you sign',
      'Interstate trips without prior agreement (they are allowed, just tell us)',
    ],
    steps: [
      { title: 'Send the request', copy: 'Dates, vehicle class, with or without driver, airport pickup, and where you need it.', timeline: '3 minutes' },
      { title: 'Quote', copy: 'Written quote with rates, deposit and mileage terms.', timeline: 'Within 2 hours' },
      { title: 'Booking and deposit', copy: 'Deposit secures the vehicle; balance on delivery or on account for corporate clients.', timeline: 'Same day' },
      { title: 'Delivery and return', copy: 'Vehicle delivered and inspected on both ends with a damage sheet.', timeline: 'Your dates' },
    ],
    pricing: [
      { tier: 'Self-drive daily', price: 'from ₦35,000/day', includes: ['Comprehensive insurance', 'Tracker and 24-hour support', 'First tank of fuel'] },
      { tier: 'With driver', price: 'from ₦50,000/day', includes: ['Everything in Self-drive', 'Vetted driver, 10 hours a day', 'Fuel within Port Harcourt'] },
      { tier: 'Corporate / project', price: 'quoted', includes: ['Monthly consolidated invoicing', 'Dedicated account manager', 'Framework rates for a project term'] },
    ],
    proof: [
      { name: 'Fleet officer, oil & gas firm', area: 'Port Harcourt', quote: 'Four vehicles for a two-week rotation, proper invoices, and the replacement arrived within an hour when one developed a fault.' },
    ],
  },

  'dealer-services': {
    hero_copy:
      'Media shoots, featured placement and market intelligence for lots in Port Harcourt. We bring you buyers; you keep selling the way you already do.',
    sla_copy: 'Shoot booked within 5 working days; leads routed to your phone same day.',
    jobs_done: 74,
    booking_kind: 'request',
    deliverables: [
      { title: 'Media shoot', copy: 'The full shot list per car, photographed to a consistent standard, delivered as web-ready files.' },
      { title: 'Featured placement', copy: 'Your stock in the homepage feed and the curated facet pages buyers actually browse.' },
      { title: 'Lead routing', copy: 'Enquiries on your listings sent to your phone the moment they land, with the buyer’s name and number.' },
      { title: 'Performance reporting', copy: 'Views, enquiries and response-time scorecard per listing, so you can see what sells and what sits.' },
      { title: 'Market intelligence', copy: 'Weekly price-band updates for the models on your lot, so you price to sell rather than to hope.' },
      { title: 'No lock-in', copy: 'Month to month. If we do not bring you buyers, you stop — there is no annual contract to argue about.' },
    ],
    included: [
      'Photography and listing preparation per car',
      'Listing moderation and quality control',
      'Lead routing by WhatsApp and portal inbox',
      'Monthly performance report',
      'Dealer portal access (phase 2)',
    ],
    excluded: [
      'Any cut of your sale price beyond the agreed commission',
      'Inspection of your stock (that is a paid service, priced separately)',
      'Guaranteed sales volumes',
    ],
    steps: [
      { title: 'Apply', copy: 'Tell us about the lot: location, size, what you sell and how you document your cars.', timeline: '5 minutes' },
      { title: 'Site visit and agreement', copy: 'We look at your stock and your paperwork, and agree commission terms in writing.', timeline: 'Within 5 working days' },
      { title: 'Shoot and list', copy: 'Media day, then listings live after moderation.', timeline: 'Within 10 days' },
      { title: 'Leads and reporting', copy: 'Leads to your phone, performance in your portal, review each month.', timeline: 'Ongoing' },
    ],
    pricing: [
      { tier: 'Listed', price: 'commission per sale', includes: ['Listings and moderation', 'Lead routing', 'Monthly report'] },
      { tier: 'Listed + media', price: 'commission + shoot fee', includes: ['Everything in Listed', 'Professional media shoot per car', 'Featured placement on new stock'] },
      { tier: 'Featured partner', price: 'retainer or commission', includes: ['Everything in Listed + media', 'Homepage and facet placement', 'Price intelligence subscription'] },
    ],
    proof: [
      { name: 'Aba Road Autos', area: 'Aba Road', quote: 'The photos alone changed how many calls we get. Buyers arrive already knowing the mileage and the papers, which saves everybody a wasted Saturday.' },
    ],
  },
};

// ---------------------------------------------------------------------------
// §6.10 — CMS pages: company, trust and legal
// ---------------------------------------------------------------------------
const PAGES = {
  'how-it-works': {
    title: 'How HonestCars works',
    h1: 'How it works, end to end',
    hero: 'Five steps from “I need a car” to keys, papers and a tracker in your hand — with the verification happening before you pay, not after.',
    metaTitle: 'How HonestCars works — verification, pricing and protected purchase',
    metaDescription: 'How HonestCars buys, verifies, prices and hands over cars in Port Harcourt: the checklist, the grades, the documents and the protected payment steps.',
    body: [
      { type: 'heading', text: 'The short version' },
      { type: 'stats', items: [
        { value: '3', label: 'verification grades, no grey areas' },
        { value: '48–72h', label: 'concierge shortlist SLA' },
        { value: '≤4h', label: 'inspection report after the check' },
        { value: '7–14 days', label: 'typical document turnaround' },
      ] },
      { type: 'heading', text: 'Step by step' },
      { type: 'checklist', items: [
        'You browse verified stock, or send a brief to the concierge.',
        'We establish what the car actually is: inspection, documents, faults, mileage.',
        'We price it against live market bands for the model, year and condition — and tell you where it sits.',
        'You pay through HonestCars-protected channels, never to a seller directly.',
        'Documents transfer, the car is handed over, and any tracker or insurance is fitted on the same day.',
      ] },
      { type: 'callout', tone: 'amber', title: 'The part most buyers do not expect', text: 'If the inspection finds something that changes the value, we tell you before you pay and renegotiate or walk away. We would rather lose a sale than run a buyer through a car we do not believe in.' },
      { type: 'heading', text: 'What we check, every time' },
      { type: 'table', head: ['Check', 'What it means for you'], rows: [
        ['OBD2 scan', 'Fault codes read and photographed, including stored history'],
        ['Panel and chassis', 'Paint depth, panel gaps and jig marks — where accident repairs hide'],
        ['Flood tell-tales', 'Wiring loom, seat rails and spare-wheel well inspected'],
        ['Documents', 'Customs, registration and duty status sighted and verified'],
        ['Road test', 'Gearbox, suspension, brakes and steering on real PH roads'],
        ['Honest note', 'The faults, named in writing, on the listing'],
      ] },
      { type: 'heading', text: 'Where the money goes' },
      { type: 'paragraph', text: 'You pay HonestCars for the service: inspection, concierge, documents, tracking, hire. On a car purchase handled through us, milestones release to the seller only when each stage is confirmed — inspection passed, documents verified, handover complete.' },
      { type: 'quote', text: 'We do not take money from sellers to make a car look good. That single rule is the whole business.', attribution: 'Raph Nicks, Head of Inspections' },
      { type: 'heading', text: 'Still not sure where to start?' },
      { type: 'paragraph', text: 'Send the brief and we will do the searching, inspecting and negotiating. If we find nothing that meets it, the retainer comes back to you.' },
    ],
  },

  verification: {
    title: 'Verification',
    h1: 'What our badges actually mean',
    hero: 'Three grades, published on every car card and every listing. The grade tells you how much of this car a human being from HonestCars has personally seen — and the difference matters more than any photo.',
    metaTitle: 'HonestCars verification — what each grade really means',
    metaDescription: 'Network-Listed, Field-Checked and HonestCars-Certified explained, plus the full inspection checklist, real catches and our integrity rules.',
    body: [
      { type: 'heading', text: 'The three grades' },
      { type: 'table', head: ['Grade', 'What a human has done', 'What it does not mean'], rows: [
        ['Network-Listed', 'Nothing yet — the dealer gave us the data.', 'We have not seen this car. Use it for range and price only.'],
        ['Field-Checked', 'An inspector has physically stood next to the car and photographed it.', 'No OBD2 scan or document verification yet.'],
        ['HonestCars-Certified', 'Full checklist passed: OBD2, documents sighted, road test, honest note written.', 'It does not mean a new car — it means you know exactly what it is.'],
      ] },
      { type: 'callout', tone: 'green', title: 'Why we publish the bottom grade', text: 'If every car looked certified, the Certified badge would be worthless. Publishing the weak grades is what makes the strong one mean something.' },
      { type: 'heading', text: 'The HonestCars checklist' },
      { type: 'checklist', items: [
        'OBD2 scan — every code read and photographed, including stored history',
        'Paint-depth readings on all panels, checked against factory ranges',
        'Panel gaps, spot welds and jig marks inspected for structural repair',
        'Flood tell-tales: wiring loom, seat rails, spare-wheel well, door hinges',
        'Odometers cross-checked against service records and OBD2 history',
        'Customs papers, registration and duty documents sighted and photographed',
        'Road test on public roads, including cold start',
        'Tyres, brakes, suspension and exhaust inspected on the vehicle',
        'AC performance measured at the vents, not judged by hand',
        'Written honest note — the faults, in plain language, on the listing',
      ] },
      { type: 'heading', text: 'Catches we have made this year' },
      { type: 'paragraph', text: 'We are not publishing these to alarm you. We are publishing them because each one was found before a buyer paid — which is the only reason the badge is worth anything.' },
      { type: 'table', head: ['What the advert said', 'What the inspection found'], rows: [
        ['“First body, no accident”', 'Rear left quarter panel resprayed to a different paint depth; boot floor straightened'],
        ['“Genuine 62,000 km”', 'Odometer 62,000 km, but service book and OBD2 history both read past 140,000 km'],
        ['“Duty fully paid”', 'Duty receipt referenced a different VIN entirely — papers could not be registered'],
        ['“Clean interior, nothing to spend”', 'Water tide line in the spare-wheel well and corrosion on the seat rails'],
        ['“Ice-cold AC”', 'Vent temperature 18°C after ten minutes — compressor failing'],
        ['“Just drove it from Lagos”', 'Front subframe damage consistent with a significant impact, repaired off-jig'],
      ] },
      { type: 'heading', text: 'Our integrity rules' },
      { type: 'checklist', items: [
        'Inspectors never accept money, fuel, food or “transport” from a seller.',
        'No one at HonestCars takes commission from a dealer on a buyer’s purchase.',
        'A car that fails inspection still gets its report written — we never bury one.',
        'We publish the bad news to the listing, not just to the buyer.',
        'If we get something wrong, we say so publicly on the listing and fix the process.',
      ] },
      { type: 'quote', text: 'The report is the product. If we ever shade it, we have nothing left to sell.', attribution: 'HonestCars inspection team' },
      { type: 'callout', tone: 'amber', title: 'Inspection reports are opinions, not guarantees', text: 'An inspection describes the car on the day it was seen, with the access the seller allowed. It is not a warranty, and it does not cover faults that develop later. See our disclaimer for the full wording.' },
    ],
  },

  about: {
    title: 'About',
    h1: 'A quiet showroom run by a straight-talker',
    hero: 'Honest Cars LTD exists because buying a used car in Port Harcourt should not require a mechanic on standby, a lawyer on retainer and a strong stomach.',
    metaTitle: 'About Honest Cars LTD — Port Harcourt',
    metaDescription: 'Who we are, how we make money, and the rules we hold ourselves to as a Port Harcourt car marketplace and services company.',
    body: [
      { type: 'heading', text: 'Why we exist' },
      { type: 'paragraph', text: 'The used-car market in Port Harcourt runs on information asymmetry: the seller knows, the buyer hopes. Most people solve this by bringing an uncle who “knows cars”. We built the thing that uncle was standing in for — except with a paint-depth gauge, an OBD2 scanner and a written report.' },
      { type: 'heading', text: 'What we do' },
      { type: 'paragraph', text: 'We list verified cars from partner lots, inspect the ones buyers take seriously, handle customs and registration paperwork, arrange tracking, hire and parts — and, when someone would rather not do the hunting themselves, we do the searching and bring back up to three inspected options.' },
      { type: 'heading', text: 'How we make money' },
      { type: 'checklist', items: [
        'A commission from dealers on cars sold through the platform — agreed in writing, published to the buyer on request.',
        'Fees for services: inspections, concierge searches, document handling, tracking, hire and reports.',
        'Subscription and media packages for partner lots.',
      ] },
      { type: 'callout', tone: 'green', title: 'What we do not do', text: 'We do not take money from a seller to improve a car’s grade, and we do not take a buyer’s payment directly. Payment moves through protected channels with milestones, so the money and the car change hands at the same time.' },
      { type: 'heading', text: 'The team' },
      { type: 'paragraph', text: 'A small Port Harcourt team: inspectors who came out of the trade, a documentation lead who knows every queue at every agency, and analysts who keep the price bands honest. Between us we have inspected hundreds of cars this year and talked more buyers out of bad cars than into them.' },
      { type: 'stats', items: [
        { value: '612', label: 'inspections completed' },
        { value: '12', label: 'partner lots in PH' },
        { value: '11', label: 'services under one roof' },
        { value: '48–72h', label: 'concierge SLA' },
      ] },
      { type: 'heading', text: 'Company details' },
      { type: 'paragraph', text: 'Honest Cars LTD is registered in Nigeria and operates from Port Harcourt, Rivers State. We work virtually — there is no showroom to visit, because inspections come to you.' },
      { type: 'callout', tone: 'amber', title: 'Placeholder', text: 'The CAC registration number, registered address and team names are placeholders in this build and need to be supplied before launch.' },
    ],
  },

  contact: {
    title: 'Contact',
    h1: 'Talk to a human',
    hero: 'WhatsApp is the fastest way to reach us — that is where the ops team actually lives. Everything else works too, we are just slower on it.',
    metaTitle: 'Contact HonestCars — Port Harcourt',
    metaDescription: 'Reach HonestCars on WhatsApp, phone or email. We operate virtually in Port Harcourt — inspections come to you.',
    body: [
      { type: 'heading', text: 'How to reach us' },
      { type: 'table', head: ['Channel', 'Best for', 'Response'], rows: [
        ['WhatsApp', 'Anything urgent, viewing requests, document updates', 'Minutes during working hours'],
        ['Phone', 'Speak to the ops team directly', 'Immediate in working hours'],
        ['Email', 'Invoices, corporate RFQs, formal complaints', 'Within 1 working day'],
        ['This form', 'Detailed briefs, anything with photos attached', 'Within 1 working day'],
      ] },
      { type: 'callout', tone: 'navy', title: 'We operate virtually in Port Harcourt', text: 'There is no office to visit and no lot to walk around. Inspections happen at the seller’s location, handovers happen where it suits you, and documents are delivered to you.' },
      { type: 'heading', text: 'Before you write' },
      { type: 'checklist', items: [
        'For a viewing, have the stock number ready — it is on every listing and card.',
        'For a document question, send a photo of the paper you have.',
        'For a complaint, include the stock number or tracking ID so we can pull the record.',
      ] },
    ],
  },

  terms: {
    title: 'Terms of Service',
    h1: 'Terms of Service',
    hero: 'The rules that govern using honestcarsltd.com and buying our services.',
    legal: true,
    metaTitle: 'Terms of Service | HonestCars',
    metaDescription: 'Terms governing the use of honestcarsltd.com and the purchase of HonestCars services in Port Harcourt.',
    body: [
      { type: 'callout', tone: 'amber', title: 'Placeholder — pending legal review', text: 'This structure was built to the specification; the binding wording is being supplied by HonestCars’ legal retainer. Do not treat the text below as final legal terms.' },
      { type: 'heading', text: '1. Who we are' },
      { type: 'paragraph', text: 'honestcarsltd.com is operated by Honest Cars LTD, a company registered in Nigeria. References to “we”, “us” and “HonestCars” mean Honest Cars LTD.' },
      { type: 'heading', text: '2. What this site does' },
      { type: 'paragraph', text: 'We publish vehicle listings supplied by partner dealers, and we sell inspection, concierge, documentation, tracking, hire, parts and research services. A listing is an invitation to enquire, not an offer capable of acceptance.' },
      { type: 'heading', text: '3. Verification grades' },
      { type: 'paragraph', text: 'Grades describe the extent of our involvement with a vehicle, set out on our Verification page. A grade is not a warranty of condition, roadworthiness or legal title.' },
      { type: 'heading', text: '4. Prices and payment' },
      { type: 'paragraph', text: 'Prices shown are in Nigerian Naira and may change. Vehicle prices are set by the partner dealer. Payments for services and protected purchases are collected through our payment partners; we never store card details on our systems.' },
      { type: 'heading', text: '5. Protected purchases' },
      { type: 'paragraph', text: 'Where we handle a purchase, funds are held and released against agreed milestones. We are not a party to the sale contract between buyer and dealer unless we say so in writing for a specific transaction.' },
      { type: 'heading', text: '6. Your account and content' },
      { type: 'paragraph', text: 'You are responsible for the accuracy of information you submit and for keeping access to your phone number secure. You grant us permission to use submitted photographs and details to prepare your listing.' },
      { type: 'heading', text: '7. Liability' },
      { type: 'paragraph', text: 'We exclude liability to the extent permitted by law. Nothing in these terms limits liability that cannot be limited under Nigerian law, including for fraud.' },
      { type: 'heading', text: '8. Governing law' },
      { type: 'paragraph', text: 'These terms are governed by the laws of the Federal Republic of Nigeria, and the courts of Rivers State have jurisdiction.' },
    ],
  },

  privacy: {
    title: 'Privacy Policy',
    h1: 'Privacy Policy',
    hero: 'What we collect, why we collect it, who sees it, and how to get it deleted. Written to be read, and aligned to the Nigeria Data Protection Act.',
    legal: true,
    metaTitle: 'Privacy Policy | HonestCars',
    metaDescription: 'How HonestCars collects, uses and protects personal data under the Nigeria Data Protection Act, and how to exercise your rights.',
    body: [
      { type: 'callout', tone: 'amber', title: 'Placeholder — pending legal review', text: 'The structure below follows the NDPA-aligned requirements in the specification. Final wording is being supplied by HonestCars’ legal retainer.' },
      { type: 'heading', text: 'What we collect' },
      { type: 'checklist', items: [
        'Your name and WhatsApp number, when you enquire, book or apply.',
        'Details of the car you are selling or looking for, when you tell us.',
        'Documents you upload, such as customs papers or a licence, for document services.',
        'Usage data: pages visited, filters used and events fired, collected without your name attached.',
      ] },
      { type: 'heading', text: 'Why we collect it' },
      { type: 'paragraph', text: 'To answer your enquiry, arrange viewings and inspections, complete paperwork you have asked us to do, take payment, and improve the site. Marketing messages only go to people who opted in, and every one of them has a way out.' },
      { type: 'heading', text: 'Who sees it' },
      { type: 'paragraph', text: 'Our ops team, and the partner dealer whose car you are enquiring about — with your number masked until a viewing is appointed. Payment partners see what they need to process a payment. We do not sell personal data, ever.' },
      { type: 'heading', text: 'How long we keep it' },
      { type: 'paragraph', text: 'Enquiry records are kept for 24 months, transaction and document records for 7 years as required for tax and legal purposes, and analytics events without identifiers for 26 months.' },
      { type: 'heading', text: 'Your rights' },
      { type: 'checklist', items: [
        'Ask for a copy of everything we hold about you.',
        'Ask us to correct anything inaccurate.',
        'Ask us to delete what we are not legally required to keep.',
        'Withdraw marketing consent at any time.',
        'Complain to the Nigeria Data Protection Commission.',
      ] },
      { type: 'heading', text: 'Cookies and analytics' },
      { type: 'paragraph', text: 'We use local storage to remember your shortlist and recently viewed cars on your own device. Analytics is configured with IP anonymisation and never receives your name, phone number or anything you typed into a form.' },
      { type: 'heading', text: 'Contact' },
      { type: 'paragraph', text: 'Data requests go to our privacy contact using the details on the contact page, and are actioned within 30 days.' },
    ],
  },

  refunds: {
    title: 'Refunds & Cancellations',
    h1: 'Refunds & Cancellations',
    hero: 'When you get your money back, when you do not, and how long it takes.',
    legal: true,
    metaTitle: 'Refunds & Cancellations | HonestCars',
    metaDescription: 'HonestCars refund and cancellation terms for inspections, concierge retainers, bookings and shop orders.',
    body: [
      { type: 'callout', tone: 'amber', title: 'Placeholder — pending legal review', text: 'The policy below follows the specification and the operating model. Final wording is being supplied by HonestCars’ legal retainer.' },
      { type: 'heading', text: 'Concierge retainer' },
      { type: 'paragraph', text: 'The retainer is credited against the success fee when you buy a car through us. If we find nothing that meets your brief inside the agreed SLA, the retainer is refunded in full — you do not have to argue for it, the refund is automatic when we close the search as unsuccessful.' },
      { type: 'heading', text: 'Inspections' },
      { type: 'checklist', items: [
        'More than 24 hours before the slot: full refund or free reschedule.',
        'Within 24 hours: one reschedule free, refund at our discretion once the inspector’s time is committed.',
        'If we cannot attend for any reason: full refund, always, plus the reschedule at no cost.',
        'If the seller refuses access on the day: we refund the inspection fee in full.',
      ] },
      { type: 'heading', text: 'Bookings and consultations' },
      { type: 'paragraph', text: 'Consultations can be rescheduled free up to 12 hours before the call. Document-handling fees are refundable until lodgement has started, after which agency fees already paid are not recoverable.' },
      { type: 'heading', text: 'Shop orders' },
      { type: 'paragraph', text: 'Unopened products can be returned within 7 days of delivery for a refund less the delivery fee. Trackers already installed are non-refundable, but the monitoring subscription can be cancelled with pro-rata credit against a future purchase.' },
      { type: 'heading', text: 'How refunds are paid' },
      { type: 'paragraph', text: 'Refunds return to the same payment method used, within 5–10 working days, and you get a WhatsApp confirmation when the refund is initiated rather than when it clears.' },
    ],
  },

  disclaimer: {
    title: 'Disclaimer',
    h1: 'Disclaimer',
    hero: 'What our inspection reports do and do not cover, and how to read our price bands.',
    legal: true,
    metaTitle: 'Disclaimer | HonestCars',
    metaDescription: 'Limitations of HonestCars inspection reports, price bands, market data and third-party information.',
    body: [
      { type: 'callout', tone: 'amber', title: 'Placeholder — pending legal review', text: 'The wording below reflects the specification’s intent and is pending review by HonestCars’ legal retainer.' },
      { type: 'heading', text: 'Inspection reports' },
      { type: 'paragraph', text: 'An inspection is a professional opinion on the condition of a vehicle at the time it was examined, based on the access and conditions available that day. It is not a warranty or guarantee, and it does not cover faults that were hidden, that develop later, or that fall outside the stated checklist. Report liability is capped at the fee paid for the inspection.' },
      { type: 'heading', text: 'Price bands and market data' },
      { type: 'paragraph', text: 'Price-position indicators and price bands are estimates produced from network listings, transaction information and analyst judgement. They are information, not valuations, and they should not be relied upon as the sole basis for a purchase, sale or financing decision.' },
      { type: 'heading', text: 'Listing information' },
      { type: 'paragraph', text: 'Vehicle details are supplied by partner dealers and verified to the extent shown by the listing’s verification grade. Mileage is stated as recorded on the odometer unless the listing says it has been verified.' },
      { type: 'heading', text: 'Third-party services' },
      { type: 'paragraph', text: 'Tracking, insurance and hire involve third-party providers whose own terms apply. We select partners carefully but do not control their service standards or liability.' },
      { type: 'heading', text: 'No financial or legal advice' },
      { type: 'paragraph', text: 'Nothing on this site constitutes financial, investment, tax or legal advice, and research reports are estimates with stated assumptions rather than predictions.' },
    ],
  },
};

// ---------------------------------------------------------------------------
// §6.9 — blog post bodies
// ---------------------------------------------------------------------------
const POST_BODIES = {
  '2015-toyota-camry-honest-buyers-guide': {
    serviceCta: 'inspection',
    metaTitle: 'The 2015 Toyota Camry: what ₦12m buys in Port Harcourt',
    metaDescription: 'Three 2015 Camrys, the same week, the same checklist. What a clean one is worth, what the tired ones hide, and what to check before you pay.',
    authorBio: 'Raph Nicks leads HonestCars inspections in Port Harcourt. He has inspected more than 600 used cars and has talked more buyers out of bad ones than into them.',
    body: [
      { type: 'paragraph', text: 'A 2015 Camry is the [default sensible buy in Port Harcourt](/cars?make=Toyota), and that is exactly why you should be suspicious of it. Popular models attract the most repair-and-flip activity, because there is always a buyer.' },
      { type: 'paragraph', text: 'We put three 2015 Camrys through the full checklist in the same week. Here is what ₦12m bought in each case, with the numbers.' },
      { type: 'heading', text: 'What ₦12m buys in this market' },
      { type: 'table', head: ['Car', 'Asking', 'Mileage', 'Grade', 'Notable finding'], rows: [
        ['Camry LE, 2015', '₦11.8m', '88,000 km', 'Certified', 'Clean; two panels resprayed, priced in'],
        ['Camry SE, 2015', '₦12.4m', '62,000 km', 'Field-Checked', 'Odometer inconsistent with service book'],
        ['Camry XLE, 2015', '₦13.2m', '104,000 km', 'Certified', 'AC compressor weak; rear bushings due'],
      ] },
      { type: 'callout', tone: 'amber', title: 'The one that looked best was the worst', text: 'The lowest-mileage car had the most inconsistent paperwork. A 62,000 km reading on a ten-year-old car is possible — it is just rare enough that the odometer history has to survive scrutiny.' },
      { type: 'heading', text: 'The five things that actually decide the price' },
      { type: 'checklist', items: [
        'Odometer consistency: service book, OBD2 history and physical wear all have to agree.',
        'Panel history: paint-depth readings on all four quarters, and the boot floor for accident repair.',
        'AC performance: measured at the vent. “Blows cold” is not a measurement.',
        'Suspension and bushings: Port Harcourt roads eat them, and the repair bill is real.',
        'Document status: customs verified and duty sighted, or a discount that reflects the missing papers.',
      ] },
      { type: 'heading', text: 'What we would pay' },
      { type: 'paragraph', text: 'For a clean 2015 Camry with verified mileage, complete papers and everything working: ₦10.5m–₦12.5m depending on trim and km — compare that against [the Camrys we have actually inspected](/cars?make=Toyota&model=Camry). Below ₦10m, start asking what is wrong, because something usually is.' },
      { type: 'quote', text: 'The cheapest Camry on the road is rarely the cheapest Camry to own.', attribution: 'Raph Nicks' },
      { type: 'heading', text: 'Before you pay for one' },
      { type: 'paragraph', text: 'Book the [inspection](/services/inspection), not the car. Any inspection we do lands in writing, names the faults and stays attached to the listing — including the faults that cost the seller money.' },
    ],
  },

  'tokunbo-vs-nigerian-used-ph': {
    serviceCta: 'consultation',
    metaTitle: 'Tokunbo vs Nigerian-used: the honest maths for PH',
    metaDescription: 'A cheaper import is not always cheaper. The five-year cost lines we actually add up for Port Harcourt buyers, and when each side wins.',
    authorBio: 'Ada George analyses the Port Harcourt market for HonestCars, building the price bands behind every listing.',
    body: [
      { type: 'paragraph', text: 'The reflex is “tokunbo is better”. The maths is not that simple, especially once you add registration, clearing and the first six months of repairs. Worth saying up front: you can inspect [either kind of car](/cars) the same way, on the same checklist.' },
      { type: 'heading', text: 'The cost lines people forget' },
      { type: 'table', head: ['Cost', 'Tokunbo', 'Nigerian-used'], rows: [
        ['Duty and clearing', 'Landed in the asking price', 'Usually already paid and verified'],
        ['First-year repairs', 'Higher — systems have sat unused', 'Lower if the owner drove it properly'],
        ['Document risk', 'Mismatched papers are common', 'Papers usually already registered here'],
        ['Depreciation', 'Already taken the big hit', 'Flatter curve from here'],
      ] },
      { type: 'callout', tone: 'navy', title: 'The rule of thumb we use', text: 'If the Nigerian-used car has a verifiable service history and the tokunbo does not, the Nigerian-used car usually wins on five-year cost — even when it is a year older.' },
      { type: 'heading', text: 'Where tokunbo wins' },
      { type: 'checklist', items: [
        'You want specific trim or options that rarely get ordered here.',
        'You want a platform with fewer miles on Nigerian roads, which matters for suspension.',
        'You are buying a grade you can verify before shipping, not after — an [import inspection](/services/inspection) or a [research brief](/services/research) does that.',
      ] },
      { type: 'video', src: '/video/flood-damage-check.mp4', title: 'Spotting flood damage before you pay', caption: 'Where water leaves a mark on an imported car — and why sellers clean two of the three. 10 seconds, no sound.' },
      { type: 'heading', text: 'Where Nigerian-used wins' },
      { type: 'checklist', items: [
        'Papers are already clean and registered in Nigeria.',
        'You can inspect the actual car in person, today, with its service history.',
        'The seller is the long-term owner rather than a trader who has had it three weeks. Cars with the full [Customs verified](/verification) status are the ones to compare.',
      ] },
    ],
  },

  'odometer-fraud-check-yourself': {
    serviceCta: 'inspection',
    metaTitle: 'How to check an odometer before you pay a deposit',
    metaDescription: 'Seven checks anyone can do in ten minutes, the two tricks that survive them all, and the ₦1.5m–₦3m you are betting when you trust the dash.',
    authorBio: 'Raph Nicks leads HonestCars inspections in Port Harcourt and has written the checklist every inspector works to.',
    body: [
      { type: 'paragraph', text: 'Odometer fraud is the most common lie in the used-car market, and the easiest to catch if you know where the car keeps its own records. If you would rather not do it yourself, every [HonestCars inspection](/services/inspection) includes an OBD2 read and an odometer verdict.' },
      { type: 'heading', text: 'Seven checks you can do in ten minutes' },
      { type: 'checklist', items: [
        'Service book: look for a chain of stamps whose km readings increase consistently with the dates.',
        'OBD2 history: stored distance and fault snapshots often carry a higher figure than the dash.',
        'Driver’s seat bolster and pedals: wear should match the claimed km.',
        'Steering wheel and gear knob: shine and worn leather betray high mileage.',
        'Suspension bushings: at 150,000 km they have usually been replaced, and the receipts prove it.',
        'Windscreen: original glass with a manufacturer date before the car’s build year is a tell.',
        'Tyre dates: four tyres stamped years apart suggest replacements driven by distance — the same quick read we do on every [field inspection](/services/inspection).',
      ] },
      { type: 'video', src: '/video/odometer-check.mp4', title: 'Two odometer checks anyone can do', caption: 'The wear test and the service-record cross-check, shown on a real Port Harcourt car. 10 seconds, no sound.' },
      { type: 'callout', tone: 'amber', title: 'The two tricks that survive all of the above', text: 'A worn interior can be swapped from a scrap car, and a service book can be forged entirely. If the numbers only come from the book and the interior, get an OBD2 read — the ECU keeps its own distance in most modern cars, and that is the number a seller cannot reach.' },
      { type: 'heading', text: 'What it costs you when you miss it' },
      { type: 'paragraph', text: 'A 60,000 km car priced against a 140,000 km one typically carries a ₦1.5m–₦3m premium. That is the size of the bet you are making when you take the number on trust. Every [car in the listings](/cars) shows its grade openly, and the ones we have physically checked say so.' },
    ],
  },

  'customs-papers-explained': {
    serviceCta: 'documents',
    metaTitle: 'Customs papers, explained without the jargon',
    metaDescription: 'Duty paid, duty sighted, customs verified, registration complete — what each term really means, and the VIN check that decides whether you can register the car.',
    authorBio: 'Chinelo U. leads documentation at HonestCars, handling customs verification, registration and permits across Rivers State.',
    body: [
      { type: 'paragraph', text: '“Duty paid” and “duty sighted” are not the same statement, and the difference is the difference between a car you can register and a car you cannot. Our [documentation service](/services/documents) exists because of how often that sentence comes back to bite people.' },
      { type: 'heading', text: 'The words, translated' },
      { type: 'table', head: ['Term', 'What it actually means'], rows: [
        ['Duty paid', 'Someone says the import duty was paid. There is no document in front of you.'],
        ['Duty sighted', 'We have looked at the duty document and checked its reference against the VIN.'],
        ['Customs verified', 'The paperwork reconciles with the vehicle: VIN, engine number and entry reference all agree.'],
        ['Registration complete', 'The vehicle is on the Nigerian register in an owner’s name and transfer can be lodged.'],
      ] },
      { type: 'callout', tone: 'green', title: 'The check that matters most', text: 'Match the VIN on the customs document to the VIN on the chassis. If they disagree, nothing else about the papers matters — you are looking at a car you may never be able to register.' },
      { type: 'heading', text: 'What to do when papers are missing' },
      { type: 'checklist', items: [
        'Get the missing-papers discount in writing before you commit to anything.',
        'Confirm the vehicle is not flagged before you spend on repairs.',
        'Budget [the document service](/services/documents) and the timeline — 7 to 14 working days in a straightforward case.',
        'Do not pay a seller in full while documents are unresolved; [concierge purchases](/services/concierge) hold funds against milestones for exactly this.',
      ] },
      { type: 'heading', text: 'Red flags' },
      { type: 'checklist', items: [
        'Photocopies offered “because the original is with a brother”.',
        'A duty document whose reference does not appear in any register.',
        'Urgency: a genuine paper does not become more urgent because you asked to see it.',
      ] },
    ],
  },

  'ph-fuel-cost-by-model': {
    serviceCta: 'research',
    metaTitle: 'What 100km really costs in PH traffic, by model',
    metaDescription: 'Observed consumption for Corolla, Camry, CR-V, RX 350 and Hilux on the same Port Harcourt run, converted into what a year of driving actually costs.',
    authorBio: 'Ada George runs market intelligence at HonestCars, including the fuel and running-cost data behind our TCO reports.',
    body: [
      { type: 'paragraph', text: 'We tracked real consumption on the same Port Harcourt run for a week: GRA to Trans-Amadi and back, with the Aba Road stretch at peak. Here are the numbers owners reported, plus what they mean per year. The models below are the ones that move through [our listings](/cars) fastest, so the maths sticks.' },
      { type: 'table', head: ['Model', 'Observed', 'Per 100 km', 'Yearly (15,000 km)'], rows: [
        ['Corolla 1.8', '11.5 km/l', '8.7 L', '≈ ₦405,000'],
        ['Camry 2.5', '9.8 km/l', '10.2 L', '≈ ₦475,000'],
        ['CR-V 2.4', '8.4 km/l', '11.9 L', '≈ ₦555,000'],
        ['RX 350 3.5', '6.6 km/l', '15.2 L', '≈ ₦705,000'],
        ['Hilux 2.8 TD', '10.4 km/l', '9.6 L', '≈ ₦445,000 (diesel)'],
      ] },
      { type: 'callout', tone: 'navy', title: 'Read the yearly column, not the monthly one', text: 'A ₦150,000 yearly fuel difference is easy to ignore in a test drive and impossible to ignore by month five. It is also the reason the V6 you love is usually cheaper to buy than to own.' },
      { type: 'heading', text: 'What moves the number most' },
      { type: 'checklist', items: [
        'Tyre pressure: under-inflated tyres cost more than any driving style change.',
        'Cold-start trips: short school runs in traffic are the worst case for consumption.',
        'AC: it is not free, but in Port Harcourt it is not optional either.',
        'Fuel quality: the cheaper pump is not always the cheaper tank.',
      ] },
      { type: 'paragraph', text: 'If you are choosing between two cars and the ₦150,000 a year matters, ask for a [running-cost research brief](/services/research) — we model fuel, tyres, servicing and the model-specific repair bills before you commit, and it is credited against the car if you buy through us.' },
      { type: 'paragraph', text: 'Every car we list carries its [full service price list](/services) so you can price the care as well as the car.' },
    ],
  },

  'first-car-under-10m-port-harcourt': {
    serviceCta: 'inspection',
    metaTitle: 'Your first car under ₦10m in Port Harcourt',
    metaDescription: 'What ₦6m–₦10m actually buys in PH right now, the four cars we would shortlist, and the three costs nobody puts on the windscreen.',
    authorBio: 'Ada George is HonestCars’ market analyst. She prices every car we list against live Port Harcourt transactions.',
    body: [
      { type: 'paragraph', text: 'A first car in Port Harcourt is bought against three prices, not one: the car, the fuel, and the repairs the last owner deferred. Under ₦10m the third one decides whether you bought well. Here is what we see moving in that band — and you can [browse the sedans under ₦10m live](/cars/sedan-under-10m).' },
      { type: 'heading', text: 'What ₦6m–₦10m buys this month' },
      { type: 'table', head: ['Band', 'What it buys', 'What to expect'], rows: [
        ['₦6m–₦7.5m', '2010–2013 Corolla, Civic, Elantra', 'Usually 150,000 km-plus. Budget ₦400k for suspension and tyres in year one.'],
        ['₦7.5m–₦9m', '2013–2016 Camry, Corolla, Sonata', 'The sweet spot: still serviceable, parts everywhere on Aba Road.'],
        ['₦9m–₦10m', '2014–2017 small SUVs, clean sedans', 'Check tyres and battery first — they are the usual reason the price is here.'],
      ] },
      { type: 'callout', tone: 'green', title: 'The four we would shortlist', text: 'Corolla 1.8, Camry 2.5, Elantra 1.8, and the CR-V 2.4 if you need the space. All four have parts on every street in PH and a mechanic who has seen a hundred of them.' },
      { type: 'heading', text: 'The three costs nobody puts on the windscreen' },
      { type: 'checklist', items: [
        'Transfer and papers: ₦150k–₦300k if the customs documents are clean, and a refusal if they are not.',
        'Insurance and tracker: ₦120k a year for comprehensive, plus installation if you want the tracker on day one.',
        'The first service: whoever sold it did not do this for you. Assume filters, oil, plugs and a battery test.',
      ] },
      { type: 'heading', text: 'How to buy it without guessing' },
      { type: 'paragraph', text: 'Book an [inspection](/services/inspection) before money moves. We read the ECU, check the papers against the chassis, and put a written verdict in your hands — the same one that decides whether the car appears in [our listings](/cars) at all.' },
    ],
  },

  'inspection-walkaround-video': {
    serviceCta: 'inspection',
    metaTitle: 'Watch a HonestCars inspection, start to finish',
    metaDescription: 'Twelve seconds of the 45-minute checklist every car goes through before it reaches you, plus what each step is looking for.',
    authorBio: 'Raph Nicks leads HonestCars inspections in Port Harcourt and has written the checklist every inspector works to.',
    body: [
      { type: 'paragraph', text: 'Every car on this site has been through the same 45-minute checklist. This is the short version — no narration, no music, just the steps, in order, on a real Port Harcourt car.' },
      { type: 'video', src: '/video/inspection-walkaround.mp4', title: 'The 45-minute inspection, in 12 seconds', caption: 'Silent clip, 12 seconds. Nothing loads until you press play.' },
      { type: 'heading', text: 'What the inspector is doing at each step' },
      { type: 'checklist', items: [
        'Walkaround: panel gaps and paint depth, because filler shows up as a shadow before it shows up on a meter.',
        'Cold start: what the engine does before it is warm is the honest version of it.',
        'OBD2 read: stored fault codes and the ECU’s own distance figure.',
        'Papers against metal: VIN on the chassis, VIN on the customs document, engine number.',
        'Road test: brakes, gearbox under load, and the suspension on a real PH road rather than a smooth one.',
      ] },
      { type: 'callout', tone: 'blue', title: 'What you get for it', text: 'A written report with photos of every finding, a verdict, and a [price comparison](/cars) against the market band for that exact model and year. If the car is wrong, you find out before you have paid for it.' },
      { type: 'paragraph', text: 'Book one on any car in Port Harcourt, from any seller — it does not have to be one of ours. [Request an inspection](/services/inspection) and we will route the nearest inspector.' },
    ],
  },

  'tyres-you-should-walk-away-from': {
    serviceCta: 'inspection',
    metaTitle: 'Three tyre conditions that should end your inspection',
    metaDescription: 'Uneven wear, mismatched brands and cracked sidewalls: what each one tells you about the owner, and what replacement really costs in Port Harcourt.',
    authorBio: 'Raph Nicks leads HonestCars inspections, where tyre condition is the fastest read on how a car has been maintained.',
    body: [
      { type: 'paragraph', text: 'Tyres tell you what the service history will not: how the car was driven, whether the owner noticed problems, and how much they were willing to spend on maintenance. It is one of the first things checked in a [HonestCars inspection](/services/inspection), along with the wheel bearings and alignment.' },
      { type: 'heading', text: 'Three conditions that should end the inspection' },
      { type: 'checklist', items: [
        'Uneven wear across one tyre — alignment or suspension geometry is wrong, and the cause costs more than the tyre.',
        'Different brands on the same axle — the owner was solving problems one wheel at a time.',
        'Cracking on sidewalls with plenty of tread left — a six-year-old tyre is finished regardless of the tread depth. Cars whose tyres and suspension have already been checked carry the HonestCars-Certified badge in [the listings](/cars).',
      ] },
      { type: 'video', src: '/video/tyre-tread.mp4', title: 'What uneven tyre wear tells you', caption: 'Three wear patterns, filmed on a car we walked away from. 9 seconds, no sound.' },
      { type: 'callout', tone: 'amber', title: 'The cheap tell', text: 'Four new matched tyres on a car that is otherwise average usually means the seller was preparing it to be driven away, which is a good sign. Cheap part-worn tyres on a car with premium trim usually means the opposite.' },
      { type: 'heading', text: 'What replacement actually costs in PH' },
      { type: 'table', head: ['Size class', 'Set of four', 'Notes'], rows: [
        ['15–16" economy (Corolla, Elantra)', '₦180,000–₦280,000', 'Widely available; price varies by brand'],
        ['17–18" mid (Camry, CR-V)', '₦320,000–₦520,000', 'Check dates; old stock is common'],
        ['19" + (RX, Prado)', '₦650,000+', 'Budget for it before you buy the car'],
      ] },
      { type: 'heading', text: 'Do this before you agree a price' },
      { type: 'paragraph', text: 'Walk the four corners yourself, or let a [field inspection](/services/inspection) do it before you travel. If the tyres fail any of the three checks above, put the replacement cost on the negotiating table that day — it is the one repair every seller understands and cannot argue with.' },
    ],
  },
};

// ---------------------------------------------------------------------------
// §6.7 /hire — vehicle classes
// ---------------------------------------------------------------------------
const HIRE_CLASSES = [
  { slug: 'sedan', name: 'Sedan', seats: 4, examples: 'Camry, Corolla, Accord', daily: 35_000, weekly: 210_000, driver: 15_000, airport: 1, corporate: 0, position: 10 },
  { slug: 'suv', name: 'SUV', seats: 5, examples: 'RAV4, CR-V, X-Trail', daily: 55_000, weekly: 330_000, driver: 18_000, airport: 1, corporate: 0, position: 20 },
  { slug: 'pickup', name: 'Pickup', seats: 5, examples: 'Hilux, Ranger', daily: 70_000, weekly: 420_000, driver: 20_000, airport: 1, corporate: 0, position: 30 },
  { slug: 'bus', name: 'Bus / Coaster', seats: 14, examples: 'Hiace, Coaster', daily: 95_000, weekly: 570_000, driver: 25_000, airport: 1, corporate: 1, position: 40 },
  { slug: 'luxury', name: 'Luxury SUV', seats: 5, examples: 'Prado, GX 460, X5', daily: 140_000, weekly: 840_000, driver: 30_000, airport: 1, corporate: 0, position: 50 },
  { slug: 'executive-corporate', name: 'Executive / corporate pool', seats: 4, examples: 'Any class, dedicated unit, monthly billing', daily: 0, weekly: 0, driver: 0, airport: 1, corporate: 1, position: 60 },
];

// ---------------------------------------------------------------------------
// §6.8 — shop products
// ---------------------------------------------------------------------------
const PRODUCTS = [
  {
    slug: 'tracker-standard', category: 'trackers', name: 'Tracker — Standard',
    summary: 'Live location, 90-day history and geofence alerts, fitted in Port Harcourt.',
    description: 'The bundle most buyers take. A hidden unit fitted by our installer, live location on your phone, 90 days of movement history and WhatsApp alerts when the car moves outside a zone you set. Includes the first year of monitoring.',
    price: 45_000, install: 1, warranty: '12 months on the device, 12 months monitoring included',
    stock: 'in_stock', options: ['pickup_meet_point', 'ph_delivery'],
    specs: [['Monitoring', '12 months included'], ['History', '90 days'], ['Alerts', 'Geofence, movement, ignition'], ['Install', 'Included, within PH'], ['Immobiliser', 'No']],
    position: 10, image: '/img/seed/hatchback-dash.svg',
  },
  {
    slug: 'tracker-premium', category: 'trackers', name: 'Tracker — Premium',
    summary: 'Adds remote fuel cut, tow detection and impact alerts.',
    description: 'For cars that are a genuine asset rather than a convenience. Remote fuel cut so a stolen car can be stopped rather than chased, tow detection, impact alerts and the same 90-day history with a longer retention option.',
    price: 85_000, install: 1, warranty: '24 months on the device, 12 months monitoring included',
    stock: 'in_stock', options: ['pickup_meet_point', 'ph_delivery'],
    specs: [['Monitoring', '12 months included'], ['History', '180 days'], ['Alerts', 'Geofence, tow, impact, speed'], ['Install', 'Included, within PH'], ['Immobiliser', 'Remote fuel cut']],
    position: 20, image: '/img/seed/suv-dash.svg',
  },
  {
    slug: 'tracker-fleet', category: 'trackers', name: 'Tracker — Fleet unit',
    summary: 'Per-vehicle unit with a fleet dashboard and driver scorecards.',
    description: 'Priced per vehicle with volume terms. Every unit reports into one dashboard with driver behaviour scoring, monthly reporting and consolidated invoicing. Includes installation and activation for each vehicle.',
    price: 65_000, install: 1, warranty: '24 months on the device; subscriptions billed annually',
    stock: 'in_stock', options: ['pickup_meet_point', 'ph_delivery'],
    specs: [['Monitoring', '12 months per unit'], ['Dashboard', 'Fleet view + scorecards'], ['Reporting', 'Monthly, exportable'], ['Install', 'Included'], ['Minimum', '5 units']],
    position: 30, image: '/img/seed/pickup-dash.svg',
  },
  {
    slug: 'obd2-scanner-basic', category: 'diagnostics', name: 'OBD2 Scanner — Basic',
    summary: 'Read and clear fault codes on any post-2001 petrol or diesel car.',
    description: 'The scanner we hand to buyers who want to keep checking a car after purchase. Reads and clears engine codes, shows live sensor data and I/M readiness, and works on every OBD2 car sold in Nigeria.',
    price: 32_000, install: 0, warranty: '12 months replacement warranty',
    stock: 'in_stock', options: ['pickup_meet_point', 'ph_delivery'],
    specs: [['Protocols', 'OBD2, CAN, ISO, PWM, VPW'], ['Live data', 'Yes'], ['Freeze frame', 'Yes'], ['Works with', 'Android app (included)'], ['Codes', 'Generic + manufacturer for common makes']],
    position: 10, image: '/img/seed/sedan-engine.svg',
  },
  {
    slug: 'obd2-scanner-pro', category: 'diagnostics', name: 'OBD2 Scanner — Pro',
    summary: 'Bidirectional scanner with ABS and airbag diagnostics.',
    description: 'For mechanics and serious owners: reads and clears ABS and airbag systems, runs actuator tests, and supports manufacturer-specific codes for Toyota, Honda, Lexus and Mercedes. Includes a hard case.',
    price: 145_000, install: 0, warranty: '12 months replacement warranty',
    stock: 'low_stock', options: ['pickup_meet_point', 'ph_delivery'],
    specs: [['Systems', 'Engine, ABS, SRS, transmission'], ['Bidirectional', 'Yes, actuator tests'], ['Manufacturer codes', 'Toyota, Honda, Lexus, Mercedes, Ford'], ['Updates', 'Free for 24 months'], ['Case', 'Included']],
    position: 20, image: '/img/seed/suv-engine.svg',
  },
  {
    slug: 'care-kit-essentials', category: 'care_kits', name: 'Care Kit — Essentials',
    summary: 'Everything for the first month of ownership, in one bag.',
    description: 'Put together after watching what new owners actually buy in their first month: coolant, engine oil top-up, screen wash, microfibre set, tyre gauge, jump leads, a torch and a printed copy of our owner checklist.',
    price: 28_000, install: 0, warranty: null,
    stock: 'in_stock', options: ['pickup_meet_point', 'ph_delivery'],
    specs: [['Includes', 'Oil top-up, coolant, screen wash'], ['Tools', 'Jump leads, gauge, torch, microfibres'], ['Extras', 'Owner checklist booklet'], ['Bag', 'Reusable, boot-sized']],
    position: 10, image: '/img/seed/hatchback-interior.svg',
  },
  {
    slug: 'care-kit-detailing', category: 'care_kits', name: 'Care Kit — Detailing',
    summary: 'Interior and exterior detailing set for PH conditions.',
    description: 'Built for the reality of Harmattan dust and rainy-season mud: wash and wax, interior cleaner, dashboard protectant that does not turn plastic shiny, glass treatment and clay bar for overspray.',
    price: 42_000, install: 0, warranty: null,
    stock: 'in_stock', options: ['pickup_meet_point', 'ph_delivery'],
    specs: [['Exterior', 'Wash, wax, clay bar'], ['Interior', 'Cleaner + matt protectant'], ['Glass', 'Hydrophobic treatment'], ['Applicators', 'Included']],
    position: 20, image: '/img/seed/sedan-interior.svg',
  },
  {
    slug: 'care-kit-roadside', category: 'care_kits', name: 'Care Kit — Roadside',
    summary: 'For the boot: pressure, power, light and a way to call for help.',
    description: 'Tyre compressor and sealer, quality jump leads, hi-vis vest, triangle, first-aid kit, 12V work light and a printed card with every number you might need on a bad night on the East-West road.',
    price: 55_000, install: 0, warranty: '12 months on the compressor',
    stock: 'in_stock', options: ['pickup_meet_point', 'ph_delivery'],
    specs: [['Tyre', 'Compressor + sealer'], ['Electrical', 'Jump leads, 12V lamp'], ['Safety', 'Vest, triangle, first aid'], ['Extras', 'Emergency numbers card']],
    position: 30, image: '/img/seed/van-interior.svg',
  },
];

// ---------------------------------------------------------------------------
// Delivery-fee rules by area (§6.8 “delivery-fee rules by area (admin table)”).
// ---------------------------------------------------------------------------
const DELIVERY_AREAS = [
  { name: 'Pickup at a PH meet-point', fee: 0, note: 'Pleasant Stores, GRA — we text you when your order is ready.', position: 10 },
  { name: 'GRA / Old GRA', fee: 2_000, note: 'Same-day within working hours.', position: 20 },
  { name: 'D-Line / Diobu', fee: 2_500, note: 'Same-day within working hours.', position: 30 },
  { name: 'Trans-Amadi / Rumuokoro', fee: 3_000, note: 'Next working day.', position: 40 },
  { name: 'Woji / Rumuigbo / Ada George', fee: 3_500, note: 'Next working day.', position: 50 },
  { name: 'Choba / Uniport / Aluu', fee: 4_000, note: 'Next working day.', position: 60 },
  { name: 'Rumuokwuta / Igwuruta', fee: 4_500, note: 'Next working day.', position: 70 },
  { name: 'Omagwa / Airport corridor', fee: 5_000, note: 'Airport pickup by arrangement.', position: 80 },
  { name: 'Bonny / Onne (river)', fee: 6_000, note: 'We send by courier and confirm the day before.', position: 90 },
];

// ---------------------------------------------------------------------------
// FAQs — one scope per surface that renders an accordion (§6.7 service pages,
// §6.10 trust pages, §6.8 shop). The route passes the scope; the FAQPage
// schema is only emitted where the accordion actually renders (§12.4).
// ---------------------------------------------------------------------------
const FAQS = {
  'service:inspection': [
    ['How long does the inspection take?', 'An hour to an hour and a half on site, then the written report and photos land in your WhatsApp within 4 hours of the check.'],
    ['Do you inspect cars I found somewhere else?', 'Yes — that is most of our work. Send us the dealer or the location; you do not have to bring the car to us.'],
    ['What if the car fails the inspection?', 'You get the report either way. If we find something that kills the deal, we say so, and the fee still covers the work we did.'],
    ['Can I be there for the inspection?', 'You can, and many buyers are. It is also fine to stay away and let the report do the talking.'],
    ['Is the engine opened during inspection?', 'No. We do not dismantle engines or gearboxes. We scan, test-drive, sight documents and read the body — engine opening is a workshop job we will point you to if it is needed.'],
  ],
  'service:concierge': [
    ['What do I get for the retainer?', 'A brief-writing session on WhatsApp, three verified options inside 48–72 hours, and the retainer credited against the success fee when you buy through us.'],
    ['What if you find nothing that meets my brief?', 'You get the retainer back. The brief is written down so we both know what “nothing” means.'],
    ['Do I have to buy one of the three cars?', 'No. The options are for you to choose from, walk away from, or compare against something you already found.'],
    ['Who pays the dealer?', 'HonestCars does, through protected channels. You never pay a seller directly for a car we are handling.'],
    ['Can you find a specific trim or colour?', 'Usually. Rare trims take longer than 72 hours — we will tell you honestly at the brief stage rather than at the deadline.'],
  ],
  'service:documents': [
    ['What documents can you handle?', 'Customs verification, registration, licence renewal, plate numbers, tinted-glass permits, insurance and change of ownership.'],
    ['How do I know my papers are genuine?', 'We sight them at the source: customs portal, licensing office, or the issuing underwriter. You get photos of what we verified and what we could not.'],
    ['Can you renew a licence for someone else?', 'Yes, with signed authority and a copy of the holder\u2019s ID. We will list exactly what to send before you pay anything.'],
    ['How long does registration take?', 'Routine registration is 3–7 working days; customs verification depends on the terminal queue. We give you a realistic date, not a hopeful one.'],
    ['Do you collect the car or do I bring it?', 'Both are possible across Port Harcourt. Some paperwork needs the vehicle physically present; we tell you up front.'],
  ],
  'service:tracking': [
    ['Which tracker brands do you install?', 'We fit the bundles listed on this page and support the platform that comes with them. If you already own a device, we can advise before you buy another.'],
    ['How long does installation take?', 'Standard and Premium installs are 60–90 minutes at a partner bay or a location you choose. Fleet installs are scheduled as a batch.'],
    ['What happens if the device stops reporting?', 'Message us. A device that has gone quiet is a support case, not a wait-and-see — that is the point of paying for a monitored bundle.'],
    ['Do I have to keep paying every year?', 'The platform subscription renews yearly. We send a reminder 30 days out and you can renew by transfer, card or on this site.'],
    ['Can you track a car I am buying before I complete payment?', 'Not before handover. We can, however, fit the tracker as part of a protected purchase so it is live the day you take the keys.'],
  ],
  'service:research': [
    ['What is in a TCO report?', 'A five-year cost estimate for the specific car: fuel at PH prices, service intervals, common failure points for that model and year, insurance band and expected resale.'],
    ['Can you check a price before I travel to see a car?', 'Yes — that is the fastest thing we do. Send the link and the asking price; you get a market position and the reasons behind it.'],
    ['Do you use real Port Harcourt data?', 'Our own deals, our dealers\u2019 transactions and live network pricing — not a scrape of foreign listings converted at the wrong rate.'],
    ['How is it delivered?', 'A written PDF in your account and a WhatsApp summary. Reports go out inside 48–72 hours of the brief being confirmed.'],
  ],
  'service:consultation': [
    ['What happens in the 30 minutes?', 'You bring your shortlist and your budget; we go through them one by one and you leave with a ranked list and a price ceiling.'],
    ['Can I record the call?', 'Yes. We send a written summary afterwards either way.'],
    ['What if I have no shortlist yet?', 'Come anyway. Half of these calls end with \u201cdo not buy any of these three\u201d, which is the cheapest advice you will get.'],
    ['Do you sell me a car on the call?', 'No. The consultation is advice, not a sales call — if a car on our network fits, you will still be told the faults first.'],
  ],
  'service:parts': [
    ['How do you match the part?', 'By VIN and engine code, not by \u201cthe same model\u201d. Send the VIN or the chassis number and we confirm the match before quoting.'],
    ['How does escrow-protected payment work?', 'You pay a milestone amount into the protected flow; the supplier is paid when the part is delivered and verified. No full upfront payment to a stranger.'],
    ['What if the part is wrong?', 'If we supplied the wrong match, we fix it. If the part number came from you, we will help you return it but the supplier\u2019s terms apply — we say this before you pay.'],
    ['Do you fit parts too?', 'We do not run a workshop. We can point you to mechanics in PH who work on your model, and we can send an inspector to confirm the fitting on request.'],
  ],
  'service:sell-swap': [
    ['How fast is the valuation?', 'Within 24 hours from live network data. If you want the certified listing, we book an inspection first — that is what pushes the price up.'],
    ['What does it cost to sell?', 'Nothing up front. We agree a success commission before the car is listed; if it does not sell, you owe nothing.'],
    ['Can I swap instead of selling?', 'Yes. The swap brief reuses the concierge flow: we value yours, then bring verified options and net off the difference.'],
    ['Will you list my car on other sites?', 'We list it on HonestCars with its real condition note. If you also want it on other platforms, that is your call and we will tell you how to describe it honestly.'],
  ],
  'service:dealer-services': [
    ['What is in the media package?', 'A shot list per car — front three-quarter, sides, interior, dash, odometer, engine bay and any faults — uploaded to your listing with descriptions written for buyers.'],
    ['How does lead protection work?', 'Buyer contact details stay with HonestCars until you accept a viewing; we route the buyer to you when it is real, not when it is curious.'],
    ['Is there a minimum number of cars?', 'No, but per-car pricing improves from five cars a month. Talk to us about the lot as a whole.'],
    ['Do you take a commission on cars I sell?', 'Not on your own walk-in sales. Featured placement and services are a fee; cars that come through HonestCars-protected purchases carry the agreed commission.'],
  ],
  'page:hire': [
    ['Is fuel included?', 'No. The vehicle comes with a full tank and returns full, or we charge the difference at pump price.'],
    ['Do you deliver and pick up?', 'Yes, within Port Harcourt. Airport pickup at Omagwa is available on every class.'],
    ['What documents do I need?', 'A valid licence, a second ID for the file, and a refundable caution deposit. Corporate accounts sign a simple agreement instead.'],
    ['Can I take the car out of Rivers State?', 'With written approval before the trip — it changes the insurance cover. Ask us and we will arrange it.'],
  ],
  'page:verification': [
    ['Who inspects the cars?', 'HonestCars inspectors, paid by HonestCars. Not the dealer, not a freelance agent who also works for the lot.'],
    ['Can a grade change?', 'Yes, in both directions. A car can be re-inspected and re-graded if it is repaired, damaged or simply older than the last report.'],
    ['What does the honest note actually contain?', 'What we found: paint work, leaks, codes, tyre life, panel gaps, electrical faults and anything that made us hesitate. It is written to be read by a buyer, not a workshop.'],
    ['Can I see the photos of a known fault?', 'Every fault we record is photographed where it can be. If something is invisible in a photo, the note explains how to check it yourself.'],
    ['Do inspectors take money from sellers?', 'No. It is a dismissable offence and we audit it. If a dealer ever offers an inspector anything, tell us and we will show you the outcome.'],
  ],
  'page:how-it-works': [
    ['How much of this is free?', 'Browsing, comparing and asking questions are free. Inspections, documents, tracking, research and the concierge retainer are paid services, priced on each page.'],
    ['What if a car sells while I am deciding?', 'It happens — PH moves fast. We will offer the next closest match, and the concierge keeps your brief on file.'],
    ['Can I skip the inspection and just buy?', 'Yes, but we will say plainly that you are buying on the dealer\u2019s word. For network-listed cars that is exactly what the grade means.'],
    ['Do I need an account?', 'No. Enquiries, booking and guest checkout all work without one. An account just keeps your requests, orders and saved cars in one place.'],
  ],
  'page:about': [
    ['Where are you based?', 'Port Harcourt, Rivers State. We operate virtually — inspections come to the car, wherever it is in PH.'],
    ['How do you make money?', 'Service fees, the shop, hire, and a success commission on cars bought through protected purchases. We do not charge buyers to look.'],
    ['Is Honest Cars LTD a registered company?', 'Yes. The CAC registration is shown in the footer and on every receipt.'],
    ['Do you buy cars yourself?', 'No. We are not a dealer and we do not hold stock — our incentive is to tell you the truth about someone else\u2019s car, then help you buy it well.'],
  ],
  'page:partner': [
    ['What does it cost a dealer?', 'There is no listing fee. You pay for the services you use — photography, featured placement, intelligence — and commission on protected sales.'],
    ['Do you hide the buyer from me?', 'Until you accept a viewing, yes. After that you get the buyer\u2019s name and number, and we stay in the middle for documents and payment.'],
    ['Can I keep selling on other platforms?', 'Yes. Non-exclusive is the default. We only ask that you tell us when a car goes under offer elsewhere so we stop sending buyers.'],
    ['How do you verify a lot before it joins?', 'We visit, sight the CAC papers and a utility bill, check two references from previous customers, and agree the honesty rules in writing.'],
  ],
  'page:contact': [
    ['What is the fastest way to reach you?', 'WhatsApp. It is answered by the ops team in Port Harcourt, not a bot, and it is the same number on every page.'],
    ['Can I come to an office?', 'We do not run a walk-in office — inspections come to you and meetings happen where the car is. Say the word and we will arrange a meet-point.'],
    ['How long until someone replies?', 'Within working hours, minutes on WhatsApp. Anything sent after 6pm is answered the next morning.'],
    ['How do I report a seller who asked for a direct payment?', 'Message us on WhatsApp immediately with the car reference. We investigate, and if a partner dealer is involved, their agreement with us is reviewed.'],
  ],
  'page:shop': [
    ['Is checkout secure?', 'Payment runs through Paystack or Flutterwave inline checkout. We never see or store your card details.'],
    ['Can I pay on delivery?', 'Within Port Harcourt, yes on some items — the checkout will show it. Trackers with installation are paid before the install slot is confirmed.'],
    ['What is the warranty on trackers?', '12 months on the device, 24 months on the Premium unit, with the platform subscription renewed yearly.'],
    ['Do you deliver outside Port Harcourt?', 'We courier small items nationwide and list river towns separately at checkout. Installation is Port Harcourt only.'],
  ],
  'shop:trackers': [
    ['Will you install it in my car at my house?', 'Yes, within Port Harcourt, by appointment. Pick the install add-on and we will call you to fix a slot.'],
    ['Does the tracker need a SIM card subscription?', 'The device needs a data SIM and a platform subscription; the first year is included in the price shown.'],
    ['Can a thief remove it?', 'A determined thief can remove anything; the point is time and noise. Premium includes a second device hidden elsewhere, which is why we recommend it for 2020-up models.'],
  ],
  'shop:diagnostics': [
    ['Will the scanner work on my car?', 'The models we sell cover OBD2-compliant vehicles from 2004 onward. Pre-2004 and some older diesels need the manufacturer tool — message us your car first.'],
    ['Does it clear airbag lights?', 'It reads and clears standard engine codes. Airbag and ABS modules depend on the model; the page lists what each unit supports.'],
  ],
  'shop:care_kits': [
    ['Is the care kit worth it if I have a new car?', 'The basic kit is for anyone doing PH roads. Add the roadside kit if you drive at night or out of town.'],
    ['Can I buy just one item from a kit?', 'Message us on WhatsApp — we can usually split a kit and adjust the price.'],
  ],
};

// ---------------------------------------------------------------------------
// Demo operational records so the reviewer can open a real status page.
// Clearly labelled as demo data.
// ---------------------------------------------------------------------------
const DEMO_REQUEST = {
  trackingId: 'HC-2481',           // the ID used in the PRD's microcopy example
  type: 'concierge',
  status: 'options_ready',
  name: 'Demo buyer (seeded record)',
  phone: '08030000000',
  brief: {
    budget_min: 8_000_000,
    budget_max: 13_000_000,
    makes: ['Toyota', 'Honda'],
    body_types: ['sedan', 'suv'],
    transmission: 'automatic',
    must_haves: ['AC must chill', 'low mileage', 'first-car friendly'],
    intended_use: 'family',
    timeline: 'two_weeks',
    financing: 'no',
    addons: ['inspection_included'],
  },
  notes: 'Seeded demo record used by the reviewer to open the concierge status page.',
  slaHours: 72,
};

module.exports = { SERVICES, PAGES, POST_BODIES, HIRE_CLASSES, PRODUCTS, DELIVERY_AREAS, FAQS, DEMO_REQUEST };
