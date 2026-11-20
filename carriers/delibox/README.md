# Delibox

Delibox delivers parcels in South Korea. Select Delibox explicitly and enter the
waybill number from the shop's shipment notice.

## Retrieval

The [public tracking popup](https://www.dbox.co.kr/delivery.php) reads a waybill from
`laasInvcNo` and renders a dated scan table. The waybill must match the number in the
result's shipment details. The popup uses the same alert for an invalid waybill and a
lookup error, so the adapter reports that reply as inconclusive.

The adapter orders the scan table by its Korean local times. It reads locations shown
in brackets before scan notes. The progress graphic also shows milestones the parcel
has yet to reach. The adapter uses the dated scan rows for status and leaves worker
contacts and the delivery photo out of tracking.

## Testing

`DELIBOX_TRACKING_NUMBER=… DELIBOX_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/delibox`
