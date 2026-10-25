# NACEX

Tracks composite agency/shipment references through the anonymous Spanish portal.
Other reference formats and international detail modes use universal providers.

## How it works

Each lookup opens a fresh anonymous session, submits the agency and shipment
fields, then follows one identity-checked redirect to the detailed scan table.
The returned shipment label and agency/shipment details must match. The legacy
external link shows a reduced view; it is used for public links, not retrieval.

## Notes

Public scans sit under calendar headings without a clock or zone. Each scan keeps
its heading's day as a date-only `local_time`, with no invented clock, midnight or
delivery instant; a heading that is not a date stays provider text. The headings name
the month in the request's language, English without one. Scans retain
their source order, including repeated descriptions on the same day. Unknown
current wording cannot inherit an older delivery. A delivered summary must agree
with the newest mapped physical scan; contradictory responses are rejected.

A shipment booked online is accepted at the agency's web channel (`WEB` as
its place) and notified the same day, before or after that acceptance; NACEX
has no collection scan, so the booking registers the shipment until its first
transit scan. Notices (`Notificado`, or an administrative note) record a
message, not a movement: they keep the stage of the scan before them, and only
a first notice registers the shipment. Agreed redeliveries, address changes and pickup point
redirects resume delivery; requests to contact the agency and incidents closed
without success are problems. A parenthetical agency or pickup point code after
a label is dropped.

Only status labels and depot localities of movement scans are retained. A
platform's locality is its town after "PLAT", cut to twelve letters
("PLATMADRID"); the location leaves "PLAT" out, and a scan stored with it keeps
its row.
Delivery recipient text, signatures and free-form instructions are excluded.
A negative requires the portal's explicit no-shipment result after submission;
empty pages, generic HTTP errors and missing histories remain inconclusive.

Links to nacex.es's home page and its `seguimiento` pages name NACEX; its other
pages name none.

## Testing

Set `NACEX_TRACKING_NUMBER` to an authorized real reference and optionally
`NACEX_UNKNOWN_NUMBER` to a valid-looking unknown reference, then run
`npm run test:carriers:live -- carriers/nacex`.
