# AirAsia Cargo

AirAsia Cargo tracks the air waybills of the AirAsia airlines on their SmartKargo tracker. It
accepts AirAsia's own prefix 807 ([prefix list](https://www.beacon.com/resources/air-waybill-prefix-codes))
and Indonesia AirAsia's 975, which the tracker answers.

[`teleport`](../teleport/README.md) is AirAsia's logistics arm. It sells the airlines' cargo
capacity, but its own TNTZ and TNX parcel numbers go through its own tracker and universal
providers. An air waybill is a different number on a different tracker, so it has its own id
rather than an adapter under Teleport.

## How it works

1. `direct`: `GET https://airasia.smartkargo.com/FrmAWBTracking.aspx?AWBPrefix={prefix}&AWBNo={serial}`,
   which the tracker answers in place. It uses the shared SmartKargo helper in
   [`akasa-air-cargo`](../akasa-air-cargo/smartKargo.ts).

- The result must name the whole waybill asked. An unknown waybill is the tracker's "AWB Details
  not available" beside its own echo of the prefix and serial; anything else without a waybill is
  a changed page.

## Notes

- Booking and acceptance rows have their own event clock. The flight milestones only give the flight
  clock, which is the event's time. No clock has an offset, so all stay station wall clocks.
- Pieces, route, flights and containers are not kept.

## Limitations

- Select AirAsia Cargo and enter the full air waybill. Every airline uses the same waybill format,
  so detection does not offer it.
- AirAsia X and the other AirAsia airlines' prefixes are refused until a waybill of theirs shows
  that this tracker holds them.

## Testing

`AIRASIA_CARGO_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/airasia-cargo`
