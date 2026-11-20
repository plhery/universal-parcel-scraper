# QuickShip

QuickShip moves cross-border parcels through its [international network](https://quickshipnow.com/), with operations in India, Canada, the United States and the United Kingdom. Select QuickShip explicitly and enter the QuickShip AWB or the last-mile AWB shown by the carrier.

The [public guest tracker](https://track.quickshipnow.com/) calls `GET https://qsapi.quickshipnow.com/public/track`. The adapter keeps only packages that echo the requested QuickShip or last-mile AWB. It uses the shared package status when the packages agree and keeps their dated history when they differ.

The response reports scan clocks without offsets and provides a separate delivery timestamp with a UTC offset for the confirmed delivery. The adapter keeps actual scans, excludes forecasts and omits locations, related identifiers and proof of delivery. The carrier asks for the receiving postal code to download proof of delivery.

Run the live test with both published AWBs and the published example the tracker reported missing.

```sh
QUICKSHIP_TRACKING_NUMBER=QS207431 QUICKSHIP_LAST_MILE_AWB=UUS63D1260298065799 QUICKSHIP_UNKNOWN_NUMBER=QS570719299745 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/quickship-canada/adapter.live.test.ts
```
