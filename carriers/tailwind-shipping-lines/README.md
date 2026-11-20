# Tailwind Shipping Lines

Tailwind Shipping Lines operates container freight services between Asia and Europe, with regional feeder services. Select it explicitly with a Tailwind booking, bill of lading, or container number.

The [guest tracking page](https://ecom.tailwind-ahead.com/tracking) reads the carrier's public v2 tracking endpoint. Selecting a booking reads its associated bills. A bill search keeps only that bill. A container search keeps only the requested container from the carrier's booking record, including containers leased from another operator.

The adapter keeps completed, dated milestones and the source UTC offsets. It omits forecast movements, suggested dates and vessel positions. Identical scan rows can occur across containers under the same bill. The adapter combines those rows and reports a shipment-wide stage when the latest scan on every selected container agrees.

Run the opt-in live tests with published bill and container numbers.

```sh
TAILWIND_SHIPPING_LINES_TRACKING_NUMBER=… TAILWIND_SHIPPING_LINES_CONTAINER_NUMBER=… npm run test:carriers:live -- carriers/tailwind-shipping-lines
```
