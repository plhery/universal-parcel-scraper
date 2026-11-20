# Nacionales Delivery Services

Nacionales Delivery Services operates parcel delivery in Guatemala under the Nexgo brand. Select Nacionales Delivery Services explicitly and enter the parcel’s tracking number.

The [public tracking form](https://nacionalesdeliveryservices.com/rastreo) looks up shipments at `https://api.nexgo.delivery/api/public/shipments/track/{trackingNumber}`. The adapter restores the hyphens of the published NX format, verifies the response’s exact tracking number, and reads current status and dated scan history.

History timestamps include a UTC offset. The adapter uses the scan timestamps and omits estimates, addresses, customer field values, and free-form notes.

Run the live test with the identifier published in the guest form.

```sh
NEXGO_TRACKING_NUMBER=NX-2026-0700123 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/nacionales-delivery-services/adapter.live.test.ts
```
