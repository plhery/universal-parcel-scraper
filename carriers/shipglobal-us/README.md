# ShipGlobal US

The adapter reads the public US guest API for FFUSA waybills. ShipGlobal India is a separate
carrier. The existing prefix rule remains a low-confidence suggestion; HTTP recognition asks
the native adapter for a whole, identity-bound dated history.

The public page posts a form-encoded `waybill` to `api.shipglobal.us/api/tracking` without a
session or token. The response combines numbered checkpoints with shipment metadata. The
adapter binds `waybill`, checks `CurrentStatus` against the newest checkpoint and preserves
all distinct carrier entries. The source can repeat Delivered at older in-transit clocks;
these remain visible rather than becoming inferred extra delivery legs.

Unknown and malformed references share an HTTP 400 `Invalid tracking number` reply, so it
remains inconclusive. Other errors, verification and rate limits retain their failure kinds.
Enabled universal providers remain available for fallback.

Clocks have no offsets and remain local times, including overseas scans. The adapter does not
infer a scan location from a destination in the wording, a time zone from the company's home,
or an event from its day-only shipment date. Proof-of-delivery links and recipient metadata
are omitted.

## Testing

Supply `SHIPGLOBAL_US_TRACKING_NUMBER` and `SHIPGLOBAL_US_UNKNOWN_NUMBER` privately:

```sh
npm run test:carriers:live -- carriers/shipglobal-us/adapter.live.test.ts
```
