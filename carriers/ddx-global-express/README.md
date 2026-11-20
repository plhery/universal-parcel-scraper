# DDX Global Express

DDX Global Express moves domestic and international parcels from Vietnam. Select DDX Global Express explicitly and enter the shipment number from DDX.

The [public tracking page](https://ddxpress.vn/tracking) looks up the entered reference at `https://api.ddxpress.vn/api/v1/tracking/{trackingNumber}`. The adapter verifies the returned shipment number and reads the current status and any dated movements.

The public sample is awaiting an update and has no dated movements. The adapter returns a status summary for that case. When the service supplies dated events, it preserves their reported time precision. It omits partner tracking numbers, destination details, estimates, and free-form text.

Run the live check with the reference printed in the public form.

```sh
DDX_TRACKING_NUMBER=DDX178722 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/ddx-global-express/adapter.live.test.ts
```
