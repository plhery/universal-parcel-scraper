# United Africa Feeder Line

Select United Africa Feeder Line and enter a booking or bill of lading number in the [public cargo tracker](https://www.uaflshipping.com/Tracking). The portal calls both references “Booking No”. The adapter verifies the complete identifier and reads dated movements from tables for the containers listed on that booking.

The carrier's port clocks are preserved as reported. A full discharge or dispatch toward the consignee is transit. Empty equipment moves have no shipment stage.

The [published bill](https://www.scribd.com/document/1015096432/u-Fln-Sam-Um-0005121) for `UFLNSAMUM000512` includes container `GAOU6376038`. The carrier returned both identifiers and six dated movements on November 20, 2026.

```sh
UNITED_AFRICA_FEEDER_LINE_TRACKING_NUMBER=UFLNSAMUM000512 UNITED_AFRICA_FEEDER_LINE_UNKNOWN_NUMBER=UAFLINVALID0 npm run test:carriers:live -- carriers/united-africa-feeder-line
```
