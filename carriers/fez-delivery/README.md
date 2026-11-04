# Fez Delivery

The adapter reads Fez Delivery's public guest history API with one whole order reference.
It binds `order.orderNo` before accepting the newest-first scan list. The existing date-shaped
number rule remains a suggestion; HTTP recognition confirms it through a dated history.

`customerapi.fezdelivery.co/v1/order/historyv2/{number}` needs no account or session. Only its
separate, exact `Order Not Found` envelope becomes not-found. Changed replies, rate limits and
verification failures remain distinct, with enabled universal providers available for fallback.

Scan clocks have no stated offset and remain local times. Dispatched describes a delivery round;
a failed attempt returning to the last-mile hub is an exception, not a return to the sender.
The projection omits recipient fields, proof-of-delivery URLs and free-text delivery reasons.
It adds no event from the order's creation date.

## Testing

Supply `FEZ_DELIVERY_TRACKING_NUMBER` and `FEZ_DELIVERY_UNKNOWN_NUMBER` privately:

```sh
npm run test:carriers:live -- carriers/fez-delivery/adapter.live.test.ts
```
