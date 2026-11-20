# THAI Cargo

THAI Cargo is the air freight service of Thai Airways. Select THAI Cargo and enter a full `217` master air waybill or its eight-digit serial.

The [public SkyChain tracker](https://chorus.thaicargo.com/skychain/app?service=page%2Fnwp%3ATrackshipmt) submits the prefix and serial with the anonymous session's form state. The adapter checks the returned waybill and reads its detailed movements in the order shown. The tracker supplies station-local times without offsets. The adapter keeps those local times and airport codes, and omits the flight, shipment and weight details. A delivery row can cover just part of a split shipment. The adapter uses destination delivery rows and the waybill's piece count to determine when all pieces have arrived.

The fixtures retain the movement rows for a [published Delhi to Singapore master waybill](https://www.scribd.com/document/1036437539/Sin-Mawb-Copy) and a [published Frankfurt to Ho Chi Minh City waybill](https://www.scribd.com/document/958745455/oqo).

```sh
THAI_AIRWAYS_CARGO_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/thai-airways-cargo
```
