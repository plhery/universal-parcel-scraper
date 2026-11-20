# Thabit Logistics

The adapter reads the Saudi carrier's public HTML tracking page with a normal browser User-Agent. A scoped native “Record Not Found” table is a missing parcel; generic error pages and unfinished results are not.

TRAWL can recover a challenged guest page when configured. The browser localizes visible scan clocks, so the parser reads their original `data-utc-time` values. Direct HTML carries those same explicit UTC clocks. It requires the whole waybill in both the tracking form and canonical URL, together with the native result table.

Known administrative updates preserve the preceding physical milestone; unsupported wordings remain inconclusive. Sender, recipient and delivery-document details are not extracted. No account or phone digits are required. No number-shape rule establishes ownership.

## Testing

```sh
THABIT_NUMBER=… npm run test:live -- carriers/thabit-logistics/adapter.live.test.ts
```
