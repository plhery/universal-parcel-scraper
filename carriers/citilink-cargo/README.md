# Citilink Cargo

Citilink Cargo carries air freight in Indonesia. Select Citilink Cargo for its domestic `888` waybill or the eight-digit serial.

Citilink's domestic waybill uses Garuda Indonesia's public [iCMS tracking form](https://cargo.garuda-indonesia.com/Search). The adapter sends the Citilink prefix, checks the returned document, and reads the latest event and the airport movement history. The tracker reports station-local clocks without offsets. The adapter keeps those clocks and the carrier's movement order.

The [published Diponegoro University shipment appendix](https://eprints2.undip.ac.id/id/eprint/40825/1/TA_MAL_CHEVA%20RAFFY%20MAULANA.pdf) shows a Citilink-issued domestic waybill. The adapter covers the `888` prefix only.

```sh
CITILINK_CARGO_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/citilink-cargo
```
