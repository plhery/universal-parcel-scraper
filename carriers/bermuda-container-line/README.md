# Bermuda Container Line

[Bermuda Container Line](https://neptunebermuda.com/) operates a cargo shipping service between the United States and Bermuda. Select Bermuda Container Line and enter a booking number or container identifier.

The adapter uses the [public tracking form](https://neptunebermuda.com/track-shipment/) and its JSON lookup at `POST /wp-json/bcl-tracker/v1/search`. It matches the exact booking or container in the reply and reads the dated equipment movements. For bookings with several containers, the adapter reports a shared current status only when the containers agree. The dates and times in the reply are local clocks.

A [public customs record](https://www.importgenius.com/suppliers/bermuda-institute-of-ocean-sciences) identifies the sample container. Its booking comes from the carrier's reply for that container. Empty-container moves and the portal's completion flag carry no shipment stage. The carrier's site opens with a blank search form.

```sh
BERMUDA_CONTAINER_LINE_TRACKING_NUMBER=… BERMUDA_CONTAINER_LINE_BOOKING_NUMBER=… BERMUDA_CONTAINER_LINE_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/bermuda-container-line
```
