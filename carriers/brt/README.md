# BRT

Tracks shipment numbers, BRTcodes and BRT parcel IDs through BRT's anonymous
detailed event portal. Other shipment references use universal providers.

## How it works

One HTTP request retrieves the event table and shipment metadata. The returned
identifier must exactly match its own metadata field. Shipment numbers use the
form's POST route; BRTcodes use its linked event page. The [official tracking form](https://vas.brt.it/vas/sped_numspe_par.htm?lang=en)
keeps these identifier types separate. The modern consumer portal exposes a shorter
progress view and requires recipient verification for more details; the linked
event portal supplies the scan history without that extra input.
Detection and adapter eligibility use the same catalog shapes.

Fifteen-digit parcel IDs, printed on the parcel label, go through the form's
parcel search, which only covers about the last two months. Its result page does
not repeat the parcel ID, so a second request reads the shipment's own parcel
list and the result is accepted only when that list names the requested ID. A
parcel ID the search does not find stays inconclusive.

## Notes

Depot scans can span multiple countries without identifying their time zones.
Clock digits remain local times, while dates without a clock remain provider
text. Neither creates a delivery instant. Source order determines current
status even when the newest clock is unresolved.

Arrival at a locker or BRT-fermopoint means ready for pickup; collection from
it means delivery. A shipment returned to its sender ends with a delivery scan
at the origin depot; after a return scan that delivery reads as returned.
Held-parcel records and links to a delivering partner are not part of the
history.

Recipient details, sender references and shipment identifiers beyond the
requested identifier are excluded from the result.

A negative requires the portal's matching parcel-label error. Empty replies,
redirects and generic HTTP errors remain inconclusive.

## Testing

Set `BRT_TRACKING_NUMBER` to an authorized shipment number, BRTcode or parcel ID and optionally
`BRT_UNKNOWN_NUMBER` to a valid-looking unknown code, then run
`npm run test:carriers:live -- carriers/brt`.
