# Garuda Indonesia Cargo

Garuda Indonesia Cargo carries domestic and international air freight. Select the carrier and enter a complete `126` air waybill or its eight-digit serial.

The [public Garuda Cargo tracker](https://cargo.garuda-indonesia.com/Search) opens an iCMS iframe. The iframe's guest request returns a waybill summary, a latest event and flight history. The adapter requires an exact returned waybill and uses the carrier's latest event for the current status. It preserves station-local event times and the order of the airport movements. It uses the recorded event time when supplied and leaves the flight schedule, booking references, names, pieces and weights out of the result.

The fixtures come from a [published Singapore to Jakarta air waybill](https://www.scribd.com/document/960397122/Soft-Copy-Do-Hawb-Sav55226970-2) and a [published Denpasar to Pontianak shipping document](https://id.scribd.com/document/912777275/LOE-feri-1). The first records delivery. The second ends at receipt from the flight at the destination airport.

```sh
GARUDA_INDONESIA_CARGO_TRACKING_NUMBER=126-90464441 npx vitest run --config vitest.carriers-live.config.ts carriers/garuda-indonesia-cargo/adapter.live.test.ts --maxWorkers 1
```
