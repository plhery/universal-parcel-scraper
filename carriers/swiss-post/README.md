# Swiss Post

Swiss Post domestic parcels and inbound international letter-post (`…CH` S10
numbers), tracked through the anonymous API behind the public `service.post.ch`
tracker. AliExpress/Cainiao letter-post that ends in Switzerland is handed off
here (`src/server/carrierHandoff.ts`). Freight goes to
[swiss-post-cargo](../swiss-post-cargo/README.md) and PostLogistics
track-and-trace to [postlogistics](../postlogistics/README.md).

## How it works

`direct`: four or five calls on one cookie jar under `https://service.post.ch/ekp-web/api`,
each bounded at 10 s. The first four are sent once more if they fail to reach
Swiss Post or hang: until then a call gets at most half of the time left, so
the retry fits in the rest.

1. `GET /user` creates a throwaway anonymous user and returns an `x-csrf-token` header.
2. `POST /history?userId=…` with `{ searchQuery }` returns a search `hash`.
3. `GET /history/not-included/{hash}?userId=…` returns matching shipments.
   An empty array is the clean not-found.
4. `GET /shipment/id/{identity}/events` returns the scans. Optional: if it fails,
   the shipment summary is still returned.
5. `GET /autocomplete/postoffice/id/{site}` returns the record of the office or
   My Post 24 terminal holding the parcel, only while it waits there. Optional:
   if it fails, the parcel has no pickup point.

Event wording comes from `core/rest/translations/en/shipment-text-messages`,
fetched once per process and only when there are events. Keys are dotted
patterns with `*` wildcards; the most specific match of the same length wins,
and the `INLAND`/`IMPORT`/`EXPORT` segment comes from the shipment's own flags.

## Notes

- 18-digit `98`/`99` parcel numbers carry no check digit (identifier, franking
  licence and counter), so detection cannot reject a mistyped one.
- One cookie jar per lookup — the user, CSRF token and hash are only valid
  together, and a shared jar could leak one search's hash into another.
- Exactly one result must match the number, on `shipmentNumber` or the echoed
  `internationalBarcode` — the endpoint is a search and can return neighbouring
  shipments. None or two matches are refused. Numbers are compared without
  spaces, dots or dashes, so the portal's dotted form matches.
- The newest event code overrides `globalStatus`, which lags: a MyPost24 locker
  deposit (`2102`) reads `DELIVERED` at shipment level while the parcel still
  waits for pickup. When the newest scan has no stage (an enquiry or delay
  note, a recipient's order, an unmapped code, no scans yet), `globalStatus`
  gives it. `statusMap` in [status.ts](status.ts) lists the notes and orders
  left without a stage on purpose.
- Codes are classified, not wording. One table serves letters and parcels:
  Swiss Post's own wording table gives each mapped code the same meaning for
  both. Several English wordings mislead: "Completion of customs clearance" and
  "Arrival at the collection/delivery point" are neither active customs nor a
  delivery, and `910` "Registered for collection" is a pickup notice. Unmapped
  codes get no stage and are left to the sync.
- A shipment sent back reads "Delivered" once it reaches its sender again;
  `globalStatus` `RETURNED` or the `returned` flag turns that into returned. A
  sub-event starting `CAN` ("Revocation") withdraws its scan, which then takes
  no stage.
- While the parcel waits for pickup, the pickup notice in the shipment summary
  (`avis`) gives the site number of the office or terminal holding it, the
  arrival office first, as the tracker's own page reads it. That site's record
  becomes the pickup point: its name, then its street and its town on their own
  lines, as the pickup notice shows them. The record must name the same site.
  A terminal's record can repeat its name in place of a street, which is then
  left out; without a town the name stands alone. The notice's deadlines are
  not read. A delivered parcel has none, collected there or not.
- Weight (sent in grams), measurements (millimetres; most letters have two),
  destination country and delivery time come from the shipment summary. The
  delivery estimate is dropped once the shipment is delivered or returned.
- Timestamps are kept exactly as sent and parsed only to sort (offset-less
  values read as UTC for that comparison). `core/time` is not used for this reason.
- Wording is only trimmed, not whitespace-collapsed, so `core/transport`'s
  `clean()` is not used.
- Scan locations keep the facility's name and number as sent ("Zürich
  Briefzentrum 801050"): the six-digit number is Swiss Post's site number, not
  the recipient's postcode (see [PRIVACY.md](https://github.com/plhery/delivery-tracker/blob/main/PRIVACY.md)). The map
  places known sites by it ([places](../../places/README.md)).
  A scan without a city keeps its explicit country; the carrier's home country is never substituted.
  Recipient name, address, signature and delivery instructions are never read;
  a test asserts it.

## Testing

`npm run test:carriers:live -- carriers/swiss-post` (no env
vars; checks that a valid-shaped unknown number returns a clean 404). The
fixture is constructed in the public result shape with a synthetic number.
