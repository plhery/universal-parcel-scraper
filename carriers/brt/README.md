# BRT

Tracks shipment numbers and BRTcodes through BRT's anonymous detailed event portal.
Other shipment references use universal providers.

## How it works

One HTTP request retrieves the event table and shipment metadata. The returned
identifier must exactly match its own metadata field. Shipment numbers use the
form's POST route; BRTcodes use its linked event page. The [official tracking form](https://vas.brt.it/vas/sped_numspe_par.htm?lang=en)
keeps these identifier types separate. The modern consumer portal exposes a shorter
progress view and requires recipient verification for more details; the linked
event portal supplies the scan history without that extra input.
Detection and adapter eligibility use the same catalog shapes.

## Notes

Depot scans can span multiple countries without identifying their time zones.
Clock digits remain local times, while dates without a clock remain provider
text. Neither creates a delivery instant. Source order determines current
status even when the newest clock is unresolved.

Arrival at a locker means ready for pickup; collection from it means delivery.
Recipient details, sender references and shipment identifiers beyond the
requested identifier are excluded from the result.

A negative requires the portal's matching parcel-label error. Empty replies,
redirects and generic HTTP errors remain inconclusive.

## Testing

Set `BRT_TRACKING_NUMBER` to an authorized shipment number or BRTcode and optionally
`BRT_UNKNOWN_NUMBER` to a valid-looking unknown code, then run
`npm run test:carriers:live -- carriers/brt`.
