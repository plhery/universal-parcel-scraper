# Sky Courier Colombia

Select Sky Courier Colombia and enter the carrier's own guide number from the [public tracking form](https://casillero.skycourier.com.co/track).

The guide endpoint can also search incoming partner references. The adapter requires an exact match on the Sky Courier guide and returns its current status. The package creation time records setup in the system. The portal uses it to calculate dates for a display timeline when it has no dated scans. The adapter leaves the shipment history and status update time empty.

The form publishes `SKY-2026-00010` as its example. On November 20, 2026 the tracker returned that exact guide and status `ENTREGADO`.

```sh
SKY_COURIER_CO_TRACKING_NUMBER=SKY-2026-00010 SKY_COURIER_CO_UNKNOWN_NUMBER=SKY-0000-00000 npm run test:carriers:live -- carriers/sky-courier-co
```
