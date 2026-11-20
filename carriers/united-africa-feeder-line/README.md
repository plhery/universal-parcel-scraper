# United Africa Feeder Line

Select United Africa Feeder Line and enter a booking or bill of lading number in the [public cargo tracker](https://www.uaflshipping.com/Tracking). The portal calls both references “Booking No”. The adapter verifies the complete identifier and reads dated movements from tables for the containers listed on that booking.

The tracker stamps every movement 00:01, so the adapter keeps its date alone. A full discharge or dispatch toward the consignee is transit. Empty equipment moves have no shipment stage.

```sh
UNITED_AFRICA_FEEDER_LINE_TRACKING_NUMBER=… UNITED_AFRICA_FEEDER_LINE_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/united-africa-feeder-line
```
