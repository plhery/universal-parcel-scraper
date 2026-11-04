# JunFeng International

The adapter reads JunFeng's international guest service, which combines its China forwarding
leg with overseas delivery scans. It binds the whole `outwaybillCode` and requires first-mile
airline or airport activity before accepting a partner's postal history as JunFeng's service.

The official tracking page posts `outWaybillCodes` to
`www.junfengfast.com/api/public/tracking` without an account or session. The adapter reads the
nested `TrackInfo.Data.dataList` destination history. A number-bound empty result remains
inconclusive because it does not distinguish absent from expired history.

Postal issuer detection stays unchanged. Explicit carrier selection and tracking links reach
the adapter; it adds no broad S10 recognition rule or inferred delivery-partner handoff.

The carrier's newest-first order and unoffset wall clocks are preserved across facilities.
A planned flight notice is administrative, while an explicit airline delay is an exception.
Clearance completed and handed to post is onward transit. Database row identifiers and contact
suffixes are omitted. Enabled universal providers remain available for unsupported references.

## Testing

Supply `JUNFENG_INTERNATIONAL_TRACKING_NUMBER` and `JUNFENG_INTERNATIONAL_UNKNOWN_NUMBER` privately:

```sh
npm run test:carriers:live -- carriers/junfeng-international/adapter.live.test.ts
```
