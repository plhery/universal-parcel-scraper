# Fixtures

Replies of `cbd-tracking.locate2u.com/api/track`, the lookup CODExpress's tracking page posts the barcode to,
as they came.

- `delivered.json`: the reply for the first public sample in [`numbers.json`](../numbers.json), a parcel created,
  put on board for delivery and delivered on one day. It holds the statuses and their times, and an empty
  live-tracking link; it names no person or address.
- `not-found.json`: the reply, with HTTP 404, for a barcode the account does not hold.
