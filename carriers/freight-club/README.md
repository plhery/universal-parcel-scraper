# Freight Club

Freight Club arranges parcel, less-than-truckload and final-mile shipments in
Canada and the United States. Its public tracking page calls
`GET /Tracking/GetTrackingInfo/{reference}` on `app.freightclub.com`.

The direct step sends the whole reference without signing in. The endpoint
returns the delivery partner's reference for Freight Club booking numbers, or
echoes the partner reference when one was submitted. The SDK keeps the lookup
reference and reports a different partner identifier as `delivery_tracking_number`.
An explicit missing reply must echo the requested reference.

The adapter takes the current stage from the portal's progress summary when
available and keeps the carrier's event wording, locations and timestamps with
their published offsets. For example, the portal can report delivered with a
later pickup appointment or damage report still present in the activity log.
Street addresses, map coordinates and partner contact details are omitted.

The fixtures retain the parser fields from three indexed, carrier-hosted results
listed in `numbers.json` and a missing-reference control.

`FREIGHT_CLUB_TRACKING_NUMBER=FCT1331382558750932992 npm run test:carriers:live -- carriers/freight-club`
