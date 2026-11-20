# SB Express Limited

SB Express Limited carries domestic and international parcels from Bangladesh. Select the carrier explicitly and enter the parcel number from the shipment.

The [public tracking page](https://www.sbexpresslimited.com/tracking) accepts the number in the `code` query field. Its homepage also uses the guest `POST /api/track` route. The adapter uses that route and checks the exact returned number.

The adapter uses the carrier’s current status and orders the local movement timestamps. The published example includes an earlier delivery and a later hub scan. It retains both and uses the carrier’s latest hub status for the current stage. The adapter keeps named hubs and dispatch stations and omits addresses, names, phone numbers, and free-form notes.

Run the live check with the sample the carrier publishes in its form.

```sh
SB_EXPRESS_TRACKING_NUMBER=NET-98214 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/sb-express-bangladesh/adapter.live.test.ts
```
