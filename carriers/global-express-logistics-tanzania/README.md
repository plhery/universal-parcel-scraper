# Global Express Logistics Tanzania

Global Express Logistics Tanzania operates parcel pickup and delivery in Tanzania. Select this carrier explicitly and enter the number from the consignment.

The [public tracker](https://globalexpress.co.tz/tracking) uses `GET /api/track/{trackingNumber}`. The adapter restores the hyphens in the published GEL format, verifies the returned number, and reads the current status and dated events.

The carrier records a separate confirmation after delivery. The adapter preserves both events and uses the delivery timestamp for the carrier’s delivered summary. It omits names, addresses, phone numbers, confirmation details, and free-form notes.

Run the live test with the number published by the carrier.

```sh
GEL_TANZANIA_TRACKING_NUMBER=GEL-2026-000001 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/global-express-logistics-tanzania/adapter.live.test.ts
```
