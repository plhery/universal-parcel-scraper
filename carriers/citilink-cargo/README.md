# Citilink Cargo

Citilink Cargo carries air freight in Indonesia. Select Citilink Cargo for its verified domestic `888` waybill or the eight-digit serial.

Citilink's domestic waybill uses Garuda Indonesia's public [iCMS tracking form](https://cargo.garuda-indonesia.com/Search). The adapter sends the Citilink prefix, checks the returned document, and reads the latest event and the airport movement history. The tracker reports station-local clocks without offsets. The adapter keeps those clocks and the carrier's movement order.

The [published Diponegoro University shipment appendix](https://eprints2.undip.ac.id/id/eprint/40825/1/TA_MAL_CHEVA%20RAFFY%20MAULANA.pdf) shows a Citilink-issued domestic waybill. Its public result records receipt from the flight at Banjarmasin. The verified domestic service uses `888`. Citilink freight documented under other prefixes requires separate verification.

```sh
CITILINK_CARGO_TRACKING_NUMBER=888-84379245 npx vitest run --config vitest.carriers-live.config.ts carriers/citilink-cargo/adapter.live.test.ts --maxWorkers 1
```
