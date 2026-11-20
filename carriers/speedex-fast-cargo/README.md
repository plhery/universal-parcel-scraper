# Speedex Fast Cargo

Speedex Fast Cargo operates express cargo and reverse pickups from Mumbai. Select this carrier explicitly and use the numeric docket from the original consignment slip.

The carrier’s [guest form](https://speedexfastcargo.com/#smart-track) submits a GET to `track.php?awb={trackingNumber}`. It publishes an actual docket in the input example. The numbered page confirms the docket and displays the shipment’s scan history and current status.

The scan table gives calendar dates in Indian local time. The adapter preserves the sequence within each day. It reads carrier status labels and extracts hub locations only from the standard Inscan and Outscan lines. Contact and consignor information, free-form remarks, and proof-of-delivery images are discarded. The empty-lookup fixture comes from opening the guest route without a number.

Run the live test with the carrier-published docket.

```sh
SPEEDEX_FAST_CARGO_TRACKING_NUMBER=359769 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/speedex-fast-cargo/adapter.live.test.ts
```
