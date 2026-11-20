# SFL Worldwide

[SFL Worldwide](https://www.sflworldwide.com/) provides parcel shipping, freight forwarding and moving services. Select SFL Worldwide and enter its tracking number.

The [guest tracking form](https://track.sflworldwide.com/) sends a read-only JSON request to `POST /locations/getshipmentbytracking`. The adapter checks the exact shipment number in the response and keeps the carrier's shipment status and dated movements. A dated Blue Dart handoff appears in the shipment history. Partner tracking instructions and partner waybill numbers are excluded.

[SFL Worldwide's public complaint response](https://www.bbb.org/us/tx/farmers-branch/profile/logistics/sfl-worldwide-0875-90225242/complaints) identifies the confirmed shipment. The native reply reports delivery without a delivery timestamp. Its dated handoff uses a local clock.

```sh
SFL_WORLDWIDE_TRACKING_NUMBER=155411113354 SFL_WORLDWIDE_TRACKING_MISSING=101038384 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/sfl-worldwide/adapter.live.test.ts
```
