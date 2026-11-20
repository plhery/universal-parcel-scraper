# SACO Shipping Line

SACO Shipping Line issues house bills for consolidated ocean freight. Select the carrier explicitly and enter either the house bill or the reference after the `SSLL` carrier code. The [public form](https://sacoshipping.com/track/) takes the reference without `SSLL`; select **Bill of Lading Number** before submitting it there.

The tracker fetches the public WordPress form, submits the reference with the anonymous form nonce, and looks up the event history for the matching bill. It uses the latest movement in the history as the current status when a movement is available. Carrier history is newest first. Dates in the history use the carrier’s reported wall clock, and event locations use the reported UN/LOCODE.

The adapter omits routing estimates, arrival notices, administrative actions, and customer and equipment details. It recognizes a completed CFS pickup by the customer as delivery. Freight available at the CFS stays ready for pickup.

```sh
SACO_SHIPPING_TRACKING_NUMBER=SSLLNYC296044 SACO_SHIPPING_UNKNOWN_NUMBER=SSLL202613474401 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/saco-shipping-line/adapter.live.test.ts
```
