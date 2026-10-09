# PostNord

Tracks individual parcels through the anonymous JSON service used by PostNord's official tracking widget.

An SSCC typed with its 00 identifier is suggested with PostNord first when it
carries a Danish (57) or Swedish (73) GS1 prefix and its check digit passes.
Bring stays first for its 00370 and 00373 parcels, and Norwegian and Finnish
prefixes keep PostNord among the other candidates. Several carriers share
twenty digits, so recognition asks PostNord through the same lookup.

## How it works

One GET returns the shipment and scans. The request carries the widget's bounded SHA-512
nonce proof and tracking-site origin. Both are required: an incomplete request can look
like a missing shipment. Only the service's structured not-found response is a clean negative.

## Notes

The requested identifier must match the shipment, selected item and returned identifier.
Shipment group references and aliases need an exact item reference. Offset timestamps
are ordered by instant; incomplete scans fail rather than allowing older progress to appear current.
Each event uses its own code and, where the code covers several milestones, exact portal wording.
Pickup availability remains distinct from parcel delivery. Confirmed notification and
recipient-choice notices, a chosen pickup point among them, are omitted from shipment
history, so a delivered message cannot become a parcel-delivery milestone. A notice-only
response is inconclusive.
Summary status comes from the selected item's current status. A drop-off by the sender, even
after the day's last collection, reads as accepted. Customs clearance and a hold for a
booked delivery are not exceptions. The sender the portal names, usually the shop, the
destination country and the shipment's `serviceName` are kept. Recipient names and addresses,
sender references, delivery instructions and proof data are excluded.

A parcel waiting at a service point gets that point as its pickup point: the shipment's
`servicePoint` record, which the widget shows under a parcel ready for pickup, gives its
name, street, then postcode and town. Without it, the name the scan gives stands alone.
A parcel collected there keeps the point when the delivery, scanned at the same point,
directly follows its arrival there. The reply no longer carries the record once the
parcel is collected, and scans name the point without an id to look it up by, so a
collected parcel keeps only the name.

## Testing

`npm run test:carriers:live -- carriers/postnord` checks a structured negative.
Set `POSTNORD_TRACKING_NUMBER` to check history for an authorized real parcel.
