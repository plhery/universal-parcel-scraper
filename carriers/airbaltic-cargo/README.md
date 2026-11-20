# airBaltic Cargo

Select airBaltic Cargo and enter its eleven-digit master air waybill. The adapter sends the airline prefix and serial separately, as the [public cargo form](https://www.airbaltic.com/en/cargo) does.

The result contains the complete waybill in its heading and an embedded cargo record for the same serial. The adapter uses the recorded Unix timestamps for actual movements. It uses the destination airport for receipt from flight or cargo delivery and the origin for acceptance and departure. A booking records a reservation. The adapter omits flight schedules, package counts and weights.

The carrier's indexed shipment page returned 14 movements when checked on November 20, 2026. The history ends with cargo delivery in Istanbul on September 25, 2025.

```sh
AIRBALTIC_CARGO_TRACKING_NUMBER=657-32006306 AIRBALTIC_CARGO_UNKNOWN_NUMBER=657-00000000 npm run test:carriers:live -- carriers/airbaltic-cargo
```
