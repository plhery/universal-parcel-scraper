# Karya Pratama Cargo

Select Karya Pratama Cargo and enter the shipment number from the [public tracking form](https://karyapratamacargo.co.id/cek-resi/).

## Retrieval

The adapter uses the public tracker's JSON lookup and verifies the full returned shipment number. The history keeps the carrier's date, wall clock, status and tracking location. Customer and cargo details, notes and estimates are omitted.

An arrival at the destination city port is a transport milestone. Delivery requires a separate scan that confirms handover.

## Testing

`KARYA_PRATAMA_CARGO_TRACKING_NUMBER=… KARYA_PRATAMA_CARGO_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/karya-pratama-cargo`
