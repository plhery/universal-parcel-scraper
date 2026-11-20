# Akasa Air Cargo

Akasa Air tracks freight moving through its cargo network on a master air waybill.

## Retrieval

The public form supplies fresh ASP.NET state on a GET. The adapter posts that state
back with the airline prefix and serial from one air waybill. It checks the full
number in the shipment record before reading the booking, acceptance and movement
tables. The shipment summary takes precedence over the order of the history rows.
The portal gives no offsets, so the adapter preserves station wall clocks.

## Limitations

Select Akasa Air Cargo and enter the full master air waybill. The carrier's public
link opens the form for manual entry.

## Testing

`AKASA_AIR_CARGO_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/akasa-air-cargo`
