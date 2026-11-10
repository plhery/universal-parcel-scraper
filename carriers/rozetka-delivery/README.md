# ROZETKA Delivery

Tracks domestic ROZETKA Delivery waybills through the anonymous JSON service used by
the [official tracker](https://rozetka.delivery/tracking/parcel). No account,
session or recipient input is needed.

## Retrieval

`direct` reads `track/public/{number}` on `https://rz-delivery.rozetka.ua/api/`,
checks the whole returned identifier, then reads `track/status-group` with that
identifier and `sort=asc`. `retry` repeats these reads after a network failure
within the same lookup budget. HTTP rejections and malformed replies are not retried.

The adapter restores the dash the API requires for marketplace waybills.
HTTP recognition stays within the existing detection candidates.

The public `track-status` dictionary supplies the code meanings. Actual dated
statuses form the history; the planned route and the page's future progress rail
do not. Cancellation, partial receipt and return movements retain their own
meaning: a return under way is an exception until it reaches the sender's
branch. The newest reached state wins when the overview and history differ.

Clocks without offsets remain local wall times. Explicit upstream offsets are
preserved. A status without scans is marked as a summary. A history that omits
the current state or exceeds the event bound is marked as truncated so enabled
providers can supply missing scans. An empty or expired response is inconclusive; only the
overview's explicit missing-waybill reply means not found.

## Testing

`ROZETKA_DELIVERY_TRACKING_NUMBER=... npm run test:carriers:live -- carriers/rozetka-delivery/adapter.live.test.ts`

Set `ROZETKA_DELIVERY_UNKNOWN_NUMBER` to check the explicit negative reply.
