# ICASA Cargo

The [ICASA Cargo tracker](https://integracargo.com/rastreo/) takes an air waybill
alone. Select ICASA Cargo and enter the number printed on the air waybill. The
adapter opens the public form for a fresh anonymous anti-CSRF cookie and
submits the waybill to the same page.

The shipment summary must echo the requested waybill. Booking and acceptance
contribute their own events. A departure uses the carrier's explicit Partió scan.
Movement events keep their airport codes and the local date and minute from the
page. The fixtures retain the fields used by the adapter.

Run the live test with `ICASA_CARGO_TRACKING_NUMBER` set and
`npm run test:carriers:live -- carriers/icasa-cargo`.
