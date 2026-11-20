# Bermuda Container Line

[Bermuda Container Line](https://neptunebermuda.com/) operates a cargo shipping service between the United States and Bermuda. Select Bermuda Container Line and enter a booking number or container identifier.

The adapter uses the [public tracking form](https://neptunebermuda.com/track-shipment/) and its JSON lookup at `POST /wp-json/bcl-tracker/v1/search`. It matches the exact booking or container in the reply and reads the dated equipment movements. For bookings with several containers, the adapter reports a shared current status only when the containers agree. The dates and times in the reply are local clocks.

A [public customs record](https://www.importgenius.com/suppliers/bermuda-institute-of-ocean-sciences) identifies the sample container. The carrier's tracker also identifies a booking for it and returns the same movements when queried by that booking. The latest empty-container return and the portal's completion flag are equipment milestones. The carrier's site opens with a blank search form.

```sh
BCL_TRACKING_CONTAINER=BCLU8009690 BCL_TRACKING_BOOKING=IM09189 BCL_TRACKING_MISSING=BCLU2388WBC86217 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/bermuda-container-line/adapter.live.test.ts
```
