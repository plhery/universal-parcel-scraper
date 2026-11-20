# Hulak Logistics

Hulak Logistics operates domestic parcel and branch-to-branch cargo services in Nepal. Select Hulak Logistics explicitly and enter the reference printed on the consignment receipt.

The [carrier’s public tracker](https://logistics.hulakexpress.com/tracking/) accepts `tracking_number`. It embeds the shipment record in the results page. The adapter verifies the reference and supports both published formats.

The adapter reads the carrier’s current status, local last-update time, and dated movements. An undated timeline step does not become a scan. Both published replies show one dated pickup-order creation. One also confirms delivery in the summary. The adapter omits names, addresses, contents, handling instructions, and financial fields.

Run the live checks with the references published on the tracking page.

```sh
HULAK_TRACKING_NUMBER=POKH1-20260826-302931 HULAK_SECOND_NUMBER=HL334158257POKH1 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/hulak-logistics/adapter.live.test.ts
```
