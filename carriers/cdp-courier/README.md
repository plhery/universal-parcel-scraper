# CDP Courier

[CDP Courier](https://cdpcourier.com/) delivers parcels, documents and freight across Fiji. Select CDP Courier explicitly and enter the tracking reference from the carrier.

## Retrieval

The adapter opens the carrier's guest tracking form and submits the reference through the same search action as the site. The form publishes short-lived request state to all guests. The reply contains scans for the search and a separate alternate reference.

The result keeps the carrier's local update clocks, status wordings and locations. Remarks and alternate references stay out of the normalized result. Use the shipment reference from CDP, since a generic alternate reference can match multiple shipments.

## Testing

`CDP_COURIER_TRACKING_NUMBER=… CDP_COURIER_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/cdp-courier`
