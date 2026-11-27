# Fliway

Fliway is a New Zealand freight company that carries consignments between its depots and
delivers them to businesses and homes. Its tracker takes a consignment note number or the number
of one of the consignment's items.

## How it works

1. `direct`: `POST https://online.fliway.com/Fme/Public` with
   `{"requestType":"PTRK","connoteNumber":"<number>"}`, the lookup the tracker page at
   `online.fliway.com/Public/Track/` asks, with no session or token. It answers the consignment's
   milestones, its status and its proof of delivery. A number the consignment lookup does not
   know is then asked as an item, with `{"requestType":"PTRK","trackNum":"<number>"}`, which
   answers the item's dated rows.
2. `retry`: once more after a network failure or a timeout.

- The only not-found answer is both lookups saying they do not know the number they were asked:
  `{"error":"Connote Number <number> is not found."}` and then `{"error":"Unknown Ticket: <number>"}`.
  Any other error, or an answer about another number, is not a missing consignment.
- RedShield's firewall in front of the lookup refuses some addresses with HTTP 403 and its block
  page, which the adapter reports as a challenge.
- The server sends its certificate and the Let's Encrypt intermediate, but not the cross-signed
  ISRG root between that intermediate and the root Node trusts. Over the global fetch the adapter
  trusts that certificate, kept in [`certificate.ts`](certificate.ts); a host's own fetcher is
  used as given.
- Recognition is off, as no rule offers these numbers.

## Notes

- The milestones' clocks have no zone. Fliway works in New Zealand only, and the one clock the
  reply writes with an offset, a residential milestone's placeholder date, says +13:00, so each
  clock keeps its wall clock and is dated on Auckland's clock, marked as the carrier's zone.
- A milestone names its depot by code. An item's rows name the depots in words, so AKL is read as
  Auckland and PMR as Palmerston North; another depot keeps its code.
- Residential consignments carry milestones that arrange the delivery slot with the receiver.
  They have no scan clock and are not scans; the `DeliveryArranged` milestone's date is the day of
  the lookup, not an estimate. An arranged slot later than the newest scan is the delivery window,
  unless a delivery failed or the van came back; otherwise the delivery milestone's expected day
  is the estimate.
- A consignment whose status says some of its pieces are not delivered yet, such as "1 of 2
  Delivered", is still on its way.
- The proof of delivery gives the delivery's time when the delivery milestone has none. The
  receiver's name and signature it carries are not read, nor the name an item's delivery row gives
  after "Signed By:".

## Limitations

- The firewall refuses some addresses outright, so from those every lookup is a challenge.
- `www.fliway.com/transport/tracking/jobstatus?connote_or_ticket=<number>`, where the home page's
  form now leads, renders the same history on the server and answers an unknown number with "No
  tracking details were found for this consignment." The adapter does not read it.
- OnePortal's tracking API at `oneportal.fliway.com/api/public/v1/tracking/` asks for an
  `X-Api-Key` header, which no public page gives.

## Numbers

The consignment note numbers seen are two or three letters followed by five or seven digits. An
item's number is its consignment's number followed by a three-digit piece number. Other carriers
print these short layouts too, and the samples start with different letters, so there is no rule
and the carrier is asked only when it is selected or a link names it.

## Links

`www.fliway.com/transport/tracking/jobstatus` opens one consignment or item from its
`connote_or_ticket` parameter. Older links open a consignment at `online.fliway.com/Public/Track/`
followed by the number, or a consignment or item at `/Public/Track/` and `/Public/TrackItem/` with
the number in the `id` parameter.

## Testing

`npm run test:carriers:live -- carriers/fliway`, with `FLIWAY_TRACKING_NUMBER` and
`FLIWAY_UNKNOWN_NUMBER` optionally set. From an address the firewall refuses, both cases meet the
challenge.
