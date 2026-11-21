# Copa Airlines Cargo

Copa Airlines Cargo carries air freight on Copa's network through its Panama hub, under master air
waybills with the airline prefix 230. Copa Airlines Courier ([`copa-courier`](../copa-courier/README.md))
is a separate door-to-door service with its own `H` house waybills and tracker; this carrier tracks
the airline's own air waybills.

## How it works

1. `direct`: `GET https://copa.smartkargo.com/FrmAWBTracking.aspx?AWBPrefix=230&AWBNo={serial}`. The
   tracker redirects once to the same page with an encrypted query, which the adapter follows. It
   uses the shared SmartKargo helper in [`akasa-air-cargo`](../akasa-air-cargo/smartKargo.ts).

- The result must name the whole waybill asked. An unknown waybill is the tracker's "No Records Found"
  beside its own echo of the prefix and serial; anything else without a waybill is a changed page.
- Copa's tracker sits in a master page, so its control ids carry a `ctl00_ContentPlaceHolder1_`
  prefix. The posted form also needs an anti-forgery cookie, which the link route avoids.

## Notes

- Booking and acceptance rows have their own event clock. The flight milestones only give the flight
  clock, which for a departure or an arrival is the time of that movement, so it is the event's
  time. No clock has an offset, so all stay station wall clocks.
- The shipment panel and the waybill list each show a latest activity, and either can lag: the
  panel can show an arrival at Panama while the list already says delivered at the destination. A
  delivery in either one stands; otherwise the panel wins.
- Pieces, route, flights and containers are not kept.

## Limitations

- Select Copa Airlines Cargo and enter the full air waybill. Every airline uses the same waybill
  format, so detection does not offer it.
- A delivery shown only in the waybill list has no clock, so such a shipment's last clock is its
  last flight.

## Testing

`COPA_AIRLINES_CARGO_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/copa-airlines-cargo`
