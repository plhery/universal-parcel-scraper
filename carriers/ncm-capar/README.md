# NCM Çapar

The adapter tracks Azerbaijan parcels through the [public NCM Çapar form](https://ncmcapar.az/az/tracking).
It opens a fresh anonymous form session and submits the tracking number. It checks the number
on the shipment card before reading the dated history. The carrier displays a wall clock
without an offset. Origin, destination and the recipient label sit outside the scan history.

Select **NCM Çapar** explicitly. The carrier's published example exercises parcel registration.

Run the live check with a published number.

```sh
NCM_CAPAR_TRACKING_NUMBER="$PUBLIC_NUMBER" npm run test:carriers:live -- carriers/ncm-capar/adapter.live.test.ts
```
