# TopDelivery

The adapter reads TopDelivery's server-rendered guest order history through plain HTTP.
It binds the complete reference in the search field and the result's order-id field before
accepting the timeline. The numeric format is shared, so explicit carrier selection and
tracking links reach it without a broad detection rule.

`www.topdelivery.ru/tracking/?order={number}` needs no account or verification step. Only the
specific absence view becomes not-found; changed markup and other errors retain their failure
kinds. Enabled universal providers remain available for fallback.

Completed timeline steps are listed oldest first. The adapter reverses their order and retains
unoffset clocks as local times. A day-only scan stays a day; it gets no invented midnight.
Preparing dispatch is registration, while receipt by the delivery service establishes acceptance.
The projection omits order-management controls, tokens, addresses and recipient details. The
page's unrelated forms do not participate in tracking.

## Testing

Supply `TOPDELIVERY_TRACKING_NUMBER` and `TOPDELIVERY_UNKNOWN_NUMBER` privately:

```sh
npm run test:carriers:live -- carriers/topdelivery/adapter.live.test.ts
```
