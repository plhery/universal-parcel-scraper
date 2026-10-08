# 4PX

The public tracking site sends an anonymous JSON request to its tracking API.
The adapter selects the exact requested parcel and keeps its newest-first scan
order. Multi-package orders require separate parcel histories and fall back to
the providers.

Cainiao-style `LP` references ending in `CN` suggest 4PX without selecting it.
HTTP recognition uses the same identity-bound feed to confirm matching shipment activity.

The portal displays each scan's `tkDateStr` with `tkTimezone`, an offset or,
for some partners' scans, a zone name. The adapter uses that pair because
`tkDate` carries different clock digits. A scan without a zone, or with a zone
name the clock database does not know, is retained as `local_time`, without an
invented instant.

Event codes map to stages. `FPX_O_IR` and `FPX_O_IRI` relay whatever step a
partner reported, from a label to an arrival abroad, so their wording decides.
Other unknown codes stay unstaged.

The server reference can identify a delivery partner's tracking number. A USPS
routing barcode keeps only its package number, never the ZIP code before it.
The contact card names the last-mile provider and its website; the adapter
reports the catalog carrier both agree on, never the card's phone numbers, and
provider discovery confirms the operator separately. The feed also answers
partners' numbers and 4PX's `OLS` references, which detection does not route
here.

Run `npm run test:carriers:live -- carriers/four-px`.
Set `FOUR_PX_TRACKING_NUMBER` outside the repository to check a real parcel.
