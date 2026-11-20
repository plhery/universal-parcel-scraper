# DPS Cargo

Select DPS Cargo and enter the full shipment number from the waybill. The [public tracking page](https://dpscargo.co.id/lacak) shows the date and sequence groups in its example.

## Retrieval

The adapter uses the public site's shipment endpoint and checks the full returned number. It reads the carrier's movement codes, city names and timestamp offsets. Sender, recipient, notes, cargo details and estimates are omitted.

The code `DITERIMA` means received. It stays unstaged because the same history uses it at several points in the journey.

## Testing

`DPS_CARGO_TRACKING_NUMBER=… DPS_CARGO_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/dps-cargo`
