# Chronopost

Chronopost France, including Chrono Shop2Shop and partner scans after export.

## Retrieval

One direct HTTP POST calls `trackSkybillV2` on the
[official tracking service](https://ws.chronopost.fr/tracking-cxf/TrackingServiceWS?wsdl).
The operation requires only the language and whole tracking number, with no
account credentials or browser. The returned `skybillNumber` must match.
An identity-bound, successful empty event list is not-found; service errors,
SOAP faults, blocked pages and malformed replies stay failures.

The service includes international scans and the partner reference that
[La Poste's unified feed](../la-poste/README.md) can omit. That feed has no
reliable completeness flag, so it does not substitute for Chronopost history.
The public page's `tracking-no-cms/suivi-colis` fragment and Shop2Shop's
`tracking-ws-rest` endpoint can require a browser challenge.

## Routing and interpretation

Dedicated postal prefixes select Chronopost when their S10 check digit passes.
Their suffix can be a code of Chronopost's own, such as TS or JF, rather than
a country, so these numbers are not international mail. Other postal-shaped
identifiers need direct confirmation. A fifteen-character numeric identifier
must pass the shared DPD check-character validation. These shapes suggest a
lookup, not carrier ownership.

Scans retain their supplied offsets and seconds. Offset-less clocks stay
local. Notifications retain activity without changing the last established
shipment stage, and neither does a courier's drop-off scan that follows the
pickup point's arrival scan. Observed codes are used only when their wording
agrees, because partner scans can reuse codes.

A delivery instruction can carry the redelivery day the recipient chose, and
scans can carry the booked appointment window. The newest scan with either
becomes the expected delivery, a redelivery day replacing a window on the same
scan; an unreadable value gives none. It lapses once a later scan is not
progress towards that delivery or falls on a later day.

The pickup point's name, the first part of its address, is kept only while the
parcel waits there.

A checked `GEO/` parcel reference with an explicit German delivery country
proposes DPD Germany. The tracker asks that adapter with the partner's number
and returns its independent confirmation for consumer routing. Other safe
partner references remain available for catalog-based confirmation. Conflicting
references or countries do not select a partner. Master and child identities
remain separate.

## Limitations

The tracking operation supplies no delivery estimate beyond appointment
windows and chosen redelivery days. Recipient addresses, postcodes,
delivery-point contact details and free-form supplementary comments are
discarded; only the delivery country's code and a pickup point's name are read
from the address field.

## Testing

`npm run test:carriers:live -- carriers/chronopost` checks unknown-number handling.
Set `CHRONOPOST_TRACKING_NUMBER` outside Git to check positive retrieval and
HTTP recognition.
