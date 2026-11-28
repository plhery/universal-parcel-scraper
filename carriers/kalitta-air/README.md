# Kalitta Air

Kalitta Air, a US cargo airline, tracks freight on a master air waybill with its IATA prefix 272.

## How it works

1. `direct`: the tracking page on kalittaair.com frames a Cargo Network Manager tracker at `kalitta-cnm.com`.
   The adapter posts that tracker's form for the whole waybill and reads the page it returns: the waybill's
   panel, which it checks against the requested number, and the status table under it. No session or token is
   needed.

## Notes

- The tracker shows the messages of the airports and US Customs on each station's wall clock and labels them
  "Local timezone". It converts only its own messages, such as manifests, to the visitor's zone, which a
  `usertz` cookie sets; the adapter asks for UTC and keeps those as instants. Without the cookie they come in
  Central European time. A label naming another zone is a changed tracker, not a time to guess.
- The stations' clocks disagree, so events follow the tracker's own order rather than their clocks.
- Each row's class, such as `cargocleared` or `customs`, is kept as its provider code. US Customs' messages share
  `customs`: its release reads as in transit, like the tracker's "cleared by customs" row beside it.
- Freight flown from China to New York enters the United States at Anchorage. Documents delivered there to the
  consignee or its agent come before the flight on to the destination, so the adapter reads them as in transit;
  only at the waybill's destination do they leave the freight for collection. The generic wording rules would read that row as a
  delivery.
- An unknown waybill comes back in a panel that names it with "Air Waybill not found".

## Limitations

- The waybill's origin, destination, pieces, weight and flight plan are not kept.
- The tracker opens on an empty form, so no link names a waybill.

## Testing

`KALITTA_AIR_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/kalitta-air`
