# Evergreen Line

Evergreen Line tracks ocean freight through [ShipmentLink](https://ct.shipmentlink.com/servlet/TDB1_CargoTracking.do). Select the carrier explicitly and enter a single-container bill of lading, with or without the `EGLV` prefix.

## Retrieval

The adapter submits ShipmentLink's public quick-tracking form and checks the bill number in the result. It then posts the returned container movement form and checks the container number in the movement table. The table gives dates without times, so scans keep their calendar day.

For merchant haulage, pickup of the laden container marks handover to the merchant's haulier. Empty equipment movements stay visible without changing the cargo stage. The adapter reads one container's history when the bill lists a single container. Multi-container bills need a shipment-level interpretation of their separate histories.

## Testing

`EVERGREEN_LINE_TRACKING_NUMBER=… EVERGREEN_LINE_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/evergreen-line`
