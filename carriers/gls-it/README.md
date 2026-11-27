# GLS Italy

GLS Italy's national shipments, tracked through the national search of GLS's Italian
tracking page.

## How it works

1. `direct`: one `GET https://gls-group.com/app/service/open/rest/IT/en/rstt030?match={number}&type=NAT&caller=witt002`,
   the request the Italian tracking page makes for a national shipment, in its English
   locale. The JSON reply carries the whole history. No cookie, token, postcode, account or
   browser is needed.
2. `retry`: one more try when the request fails to reach GLS or hangs. The first try gets
   half of the budget.
3. `recheck`: when tracking, a shipment the tracker answers not found is asked once more after
   a second's pause. Now and then, mostly around the Italian late morning, the tracker answers
   not found for a shipment it holds and lists it again moments later. Only the second answer's
   shipment or not-found replaces the first; its other failures leave the not-found.
   Recognition takes the first answer, since a number the tracker does not find is most often
   another carrier's.

The GLS group tracker that GLS Switzerland and Germany use does not know Italian national
numbers, so this adapter does not share their route.

- The reply names its shipment with a space after the depot code; it must be the requested
  number, otherwise `SchemaError`. A parcel that also has a GLS international parcel number
  is listed under that number instead, repeated as the row's international reference; its
  parcel number reference (`UNITNO`) must then be the requested number. A reply of several
  rows is read as the page reads it: the shipment first, then its parcels.
- A number the tracker does not know returns HTTP 404 with its "no results" notice, in
  English or Italian: `NotFoundError`. Any other error reply or web page is inconclusive, and
  a bot check is a challenge.
- Recognition makes the same request; the not-found notice is the only unknown answer.

## Notes

- Scans carry a sentence and no code. The sentences are mapped whole in [status.ts](status.ts);
  others go to the shared wording rules. The English locale sometimes answers with the Italian
  sentences. Each is shown in the English locale's words for that scan, which take over a row
  stored in Italian at the same instant and place. A request that names a language with
  `Accept-Language` gets an internal error instead. When the newest sentence gives no stage, the
  current step of the page's progress rail stands in. GLS's return flag makes the shipment
  returned.
- A shipment sent on to another GLS country gets that country's GLS group sentences too. Its
  handover to GLS there is that country's receipt from GLS Italy, so it reads as in transit:
  GLS Italy's own first movement is the sending depot's dispatch. A parcel the group's sentences
  say was delivered at a ParcelShop waits there for its recipient, so it reads as ready for
  pickup until the shop hands it over.
- A redelivery the recipient books after a failed attempt is a scan in Italian only, "Consegna
  prenotata il dd/mm/yy": the parcel is on its way again, and the booked day is the estimate
  while that scan is the newest.
- The national search writes every timed scan in Italian time, a depot's abroad on a parcel
  sent on to another GLS country too, so each is read in Italian time. A scan with only a date
  keeps the date as a local clock, and so does an hour the clocks skip in spring.
- The receiving depot can date its delay notice ("The shipment did not arrive at the receiving
  GLS Depot.") hours after the lookup that reads it. A scan dated after the lookup is held back
  until it is due (`plannedScans`).
- The weight, the consignee's town and the masked signer are kept; without the shipment's
  signature, the masked name beside the delivery stands in. The depots, the sender's town,
  the customer's reference and the departure date are never read.

## Numbers

A national shipment number is the two-character code of the sending depot, a letter then a
letter or digit, followed by at most nine digits. The page prints it with a space after the
code, and the service fails on that space, so the adapter sends the number without it.
`gls-it-1` suggests GLS Italy at low confidence when the code is two letters and nine digits
follow, `gls-it-8-digits` when eight digits follow, a shape TNT Italy's waybills share, and
`gls-it-digit-depot` when the code is a letter and a digit. That last shape, a
letter and ten digits, is also UPS's, DTDC's and Packeta's, so it stays one suggestion among
theirs and recognition asks GLS Italy. The eleven-digit cross-border numbers and the long
parcel IDs ending `GLS` stay unclaimed.

## Links

The Italian search page reads the number from `?match=` and the search type from `type`.
Without `type=NAT` the page sends its search with an empty type, which the service
rejects, so the catalog link carries it.

## Limitations

- Parcel numbers, delivery-note references and international searches are not supported.
- A shipment forwarded or returned under a new number is not followed.
- No delivery estimate beyond a booked redelivery's day, no pickup point or sender name.
- Older shipments drop out of the tracker and come back not found. A not-found the recheck
  confirms is still the tracker's own answer, so a consumer with saved history keeps it.

## Testing

```sh
GLS_IT_TRACKING_NUMBER=... GLS_IT_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/gls-it
```
