# Alaska Air Cargo

Alaska Air Cargo carries freight, mail and parcels on Alaska Airlines' flights, Alaska and Hawaii included; Hawaiian
Air Cargo's site now leads to it. It tracks freight on a master air waybill with Alaska's IATA prefix 027. Enter the
whole waybill or its eight-digit serial.

## How it works

1. `direct`: the [iCargo portal](https://alaska-icargo.ibsplc.aero/icargoportal/portal/loginFlow) that
   alaskacargo.com's Track link opens tracks without an account. The adapter opens the portal's landing page for a
   guest session and the form token its scripts send back, then posts the tracking form to
   `trackshipments?fragments=trackPanel` as the tracking page's script does. The reply is the HTML panel the page
   shows, with a tab named after the waybill, which must be the one asked for.

## Notes

- Each history row names a step and the station that wrote it, "Departed at SEA", on that station's clock with no
  offset. Events keep the wall clocks and the tracker's order, the oldest row first; the station goes to `location`.
- The rows carry no codes, so stages come from the wording. A manifest keeps the stage before it. A notice to the
  consignee or a delivery away from the waybill's destination, the second station on its tab, is a step on the way.
- Each booked flight gives its own "Booked" row at the same minute; the step is kept once.
- The status follows the tab's latest status of the pieces, such as "Notified" where the history lists a receipt
  from the flight at the same minute after it. A delivery row always wins.
- A waybill the portal does not hold comes back with an empty panel and a `tracking.default.shipmentnotfound`
  message naming it in the `applicationmessages` header. A form without its token gets HTTP 400, and a lapsed
  session the `session-expired` header; neither is a missing waybill.
- Since the single cargo system, Hawaiian Air Cargo shipments are booked on 027 waybills too. Hawaiian's earlier
  173 waybills are not taken.

## Limitations

- The portal drops older waybills, so most public waybills come back not found.
- The flights, pieces, weight, commodity and route are not kept. The delivery receipt needs an account.
- The portal takes the waybill only from its form, so no address opens one shipment.

## Testing

`ALASKA_AIR_CARGO_TRACKING_NUMBER=… ALASKA_AIR_CARGO_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/alaska-air-cargo`
