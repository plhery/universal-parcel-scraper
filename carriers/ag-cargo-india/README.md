# AG Cargo

AG Cargo provides parcel and freight transport across India. Select AG Cargo explicitly and enter the LR or airway bill shown on the shipment.

The [carrier’s tracker](https://agcargo.in/Home/AWBTrack) submits `LrNo` to `https://api.agcargo.in/api/Delhivery/TrackingLR`. The adapter uses the carrier’s own LR result, checks the returned reference, and reads the aggregate status and the available scan for each listed waybill.

The carrier’s public sample shows one dated delivery movement. The adapter uses the exact movement timestamp when present. A manifest time applies to a manifested entry. It omits associated waybill identifiers and free-form scan remarks.

Run the live test with the LR published by AG Cargo.

```sh
AG_CARGO_TRACKING_NUMBER=312850305 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/ag-cargo-india/adapter.live.test.ts
```
