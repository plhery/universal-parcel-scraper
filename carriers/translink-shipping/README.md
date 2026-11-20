# Translink Shipping

Translink Shipping tracks house bills through its [public cargo tracker](https://vip.translinkshipping.com/Pages/CargoTracking.aspx). Select the carrier explicitly and enter a single-container house bill, with or without the `TLKP` prefix.

## Retrieval

The adapter requests the same HTML fragment as the tracking page. It matches the whole house bill and reads the movement grid under the returned container number. Actual movements keep the carrier's calendar days and the sequence it assigns to scans with the same date.

The carrier marks scheduled movements in blue. The adapter omits those rows from the scan history. Customs release and availability for delivery are transit events. Pickup at the final destination for delivery marks the last-mile dispatch. Empty equipment movements stay in the history without changing the cargo stage. The adapter reads a single container with an inline movement grid. A multi-container history needs a separate shipment-level interpretation.

## Testing

`TRANSLINK_SHIPPING_TRACKING_NUMBER=… TRANSLINK_SHIPPING_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/translink-shipping`
