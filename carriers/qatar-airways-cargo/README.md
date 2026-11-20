# Qatar Airways Cargo

Select Qatar Airways Cargo and enter the full master air waybill including its 157 prefix. The [guest shipment tracker](https://www.qrcargo.com/s/track-your-shipment) accepts the eight-digit serial next to the prefix.

## Retrieval

The adapter loads the public Salesforce page to get its current framework identifiers and submits the same guest master air waybill lookup as the form. It uses no account credentials or cookies. The returned document type, prefix and serial must match the search.

The history uses the cargo movement feed. It keeps the displayed clock and station for each scan and collapses repeated scans with the same timestamp, station and movement code. Flight schedules and cargo details are excluded. Notification of arrival is kept as an in-transit milestone until a delivery scan establishes handover.

## Testing

`QATAR_AIRWAYS_CARGO_TRACKING_NUMBER=… QATAR_AIRWAYS_CARGO_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/qatar-airways-cargo`
