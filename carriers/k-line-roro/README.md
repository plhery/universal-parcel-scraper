# K Line Global RoRo

Select K Line Global RoRo and enter the full bill of lading with its `KKLU` prefix. The adapter uses the carrier’s anonymous bill search to resolve the booking, then checks the same full bill in the movement reply. [Official tracker](https://apps.klineglobalroro.com/tracking/search)

The adapter keeps actual port arrivals and departures at the carrier’s minute-only local precision. Both public examples returned a departure and an arrival. A port arrival is a transit movement. The adapter omits vessel schedules, customs fields and individual vehicle details.

```sh
K_LINE_RORO_TRACKING_NUMBER=KKLUSOU012222 K_LINE_RORO_UNKNOWN_NUMBER=KKLUZZZ000000 npm run test:carriers:live -- carriers/k-line-roro
K_LINE_RORO_TRACKING_NUMBER=KKLUSOU012307 npm run test:carriers:live -- carriers/k-line-roro
```
