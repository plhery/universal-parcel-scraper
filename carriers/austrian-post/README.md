# Austrian Post

Tracks domestic 22-digit and Austrian S10 postal numbers through the public
tracking website's anonymous GraphQL read.

## How it works

`direct` queries the public endpoint once and requires the returned item number
to match. The optional Post account flow is unnecessary for public history.

## Notes

Summary codes and scan codes use different vocabularies. A scan marked `IZ` can
describe completed delivery; its reason and wording determine the event stage.
Timestamps carry explicit offsets, which are preserved. A scan place given
only as `PLZ` and a postcode is the delivery area and is dropped; a facility
keeps its name without the postcode.

A scan can come without wording. The tracking page lists it under its date
and time alone, with no label from its codes, so it keeps its code but gets
no stage, and the status text comes from the newest scan with wording. A scan
with neither wording nor a code is skipped.

The query also asks for the measured size, in whole centimetres. It never
asks for the shipper, which the public page shows only after sign-in, or
anything about the recipient.

The delivery estimate is read as the tracking page reads it. Its dates are
days on Vienna time, and its start and end times, which carry offsets, make a
window when they fall on those days. The page shows it only while the item
is accepted, in distribution or out for delivery, and not once the newest
scan gives a delay, a problem to resolve or a missed delivery. A later scan
than the estimate's end also drops it.

## Limitations

Account-only delivery options and recipient details are not retrieved. The
estimate follows the page's code: no public item in transit was available to
check a live value. Empty history and GraphQL errors remain inconclusive so
another source can help.

## Testing

Set `AUSTRIAN_POST_TRACKING_NUMBER` outside the repository, then run
`npm run test:carriers:live -- carriers/austrian-post`.
