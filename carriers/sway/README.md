# Sway

Tracks U.S. deliveries from Sway, formerly Returnmates. The current tracker
also serves older Swyft shipments with U.S. destinations.

## Retrieval

The public page reads `/api/tracking/<number>`. The reply must name the same
shipment. A JSON `null` with HTTP 404 is the tracker's not-found response.

Scan times keep the offsets in the reply. The current status can carry a more
recent update than the scan list. Addresses, delivery photos and actions that
change a delivery are outside the history lookup.

## Numbers

Select Sway explicitly or open its tracking link. The request restores the
lowercase form of older Swyft IDs and the hyphen in the form's `SWY-` number
format.

## Testing

`SWAY_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/sway`
