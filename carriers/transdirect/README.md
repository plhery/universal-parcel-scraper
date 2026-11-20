# Transdirect

Transdirect arranges Australian parcel and freight deliveries through partner couriers.

## Retrieval

The [public tracking API](https://developer-center.transdirect.com.au/api-reference/bookings/track/)
returns a booking summary and scans for each consignment. The adapter checks the full reference
against the returned booking, consignment or item label. Item lookups show that item's scans.
The adapter keeps the offsets from the API and uses its normalized stages.

## Limitations

Select Transdirect for bookings made through its network. Its partners publish their own
consignment formats. Proof-of-delivery documents and item-level estimates are available
through the carrier's portal.

## Testing

`TRANSDIRECT_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/transdirect`
