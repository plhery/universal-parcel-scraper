# SriCourier

SriCourier provides parcel delivery, pickups, and merchant services in Sri Lanka. Select SriCourier explicitly and enter the tracking number shown on the shipment.

The [public tracker](https://sricourier.lk/track) returns a shipment card at `/track?tracking_no={trackingNumber}`. It displays the exact number and current status. The adapter restores the hyphen in an SC number after the library normalizes it.

The carrier’s delivery progress list has no scan dates. The adapter returns the current stage as a summary and omits progress markers, projected delivery, destination fields, and driver information.

Run the live check with the number published in the tracking form.

```sh
SRI_COURIER_TRACKING_NUMBER=SC-239485 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/sri-courier/adapter.live.test.ts
```
