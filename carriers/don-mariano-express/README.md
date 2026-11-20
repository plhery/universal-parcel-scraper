# Don Mariano Express

Don Mariano Express carries parcels and freight between Argentina's northeast and the central provinces. Select it explicitly and enter the numeric guide or the `FLET` tracking code shown by the shipper.

The carrier's [guest form](https://www.don-mariano.com/#tracking) opens `/tracking?cargaID={guide}` or `/tracking?codSeguimiento={code}`. The adapter reads the server-rendered tracking panel and verifies the exact guide or tracking code. Both modes are represented by real lookups published in the form. The response for the tracking-code sample also identifies its numeric guide.

The adapter records origin and destination depot movements marked `✓ Confirmado`. A destination depot may be an intermediate stop. The overall `CONFIRMADO` wording is kept as displayed. The scan cards use a 12-hour clock without an AM or PM indicator, so the adapter keeps the calendar date and the order shown within a day. It omits scheduled dates, contact information, delivery documents and free-form notes.

Run the opt-in live checks with the published examples.

```sh
DON_MARIANO_GUIDE_NUMBER=201808 DON_MARIANO_TRACKING_CODE=FLET-0040992405-W015 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/don-mariano-express/adapter.live.test.ts
```
