# Aerolíneas Argentinas Cargo

Aerolíneas Argentinas Cargo runs domestic and international air freight. Select the carrier explicitly and enter the eight-digit serial or the complete air waybill beginning with `044`.

The airline’s cargo site opens its [SmartKargo tracker](https://aerolineas.smartkargo.com/FrmAWBTracking.aspx) with separate `AWBPrefix` and `AWBNo` parameters. When using the carrier link, enter the serial in the form. The adapter verifies the complete air waybill in the response before reading its summary and both milestone tables.

The tracker gives the booking, acceptance, flight and delivery clocks without offsets. The adapter preserves them as reported with the three-letter airport codes. It omits flight and equipment identifiers and delivery order details. A blank result leaves the shipment unconfirmed.

```sh
AEROLINEAS_CARGO_TRACKING_NUMBER=044-33256462 AEROLINEAS_CARGO_EMPTY_NUMBER=044-36348933 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/aerolineas-argentinas-cargo/adapter.live.test.ts
```
