# Huuneh

Huuneh is a courier in Ontario, Canada. It delivers next-day and same-day parcels for pharmacies,
florists and online shops across the Greater Toronto Area, the Golden Horseshoe and the Waterloo
area. Its site is huuneh.com.

## Retrieval

1. `direct`: one `GET https://huuneh.com/dashboard/track.php?order_track={number}`, the address
   the tracking form builds. It needs no cookie, token or browser. The page is rendered on the
   server and names the waybill it shows.
2. `retry`: the same request once more when the first fails to reach Huuneh or hangs.

- The form takes several numbers separated by commas; the adapter sends one whole waybill and
  requires the page to name it.
- An unknown waybill is HTTP 200 with `Invoice number not found` and the number echoed, which is
  not found only when the echo matches. A 404 or a redirect is a moved route, and a 401 or 403 a
  refusal.
- Recognition makes the same request. With no detection rule, preflight does not ask Huuneh.

## Notes

- Each scan shows a status name, such as `Pick_up` or `On Route`, and a note after a `+`. The
  stage comes from the name, by the map, else the shared wording rules; the note is kept after
  it when it says more.
- `Pick_up` is the pickup the customer books, before the courier collects the parcel, so it is
  registered. `On Route` is the local delivery round, so it is out for delivery.
- Scans are dated to the second with no zone, so each is a `local_time` wall clock, which a
  consumer reads on the carrier's Ontario clock.
- The sender and recipient contact names and the recipient's street and destination town are
  kept. The sender's address, origin town, shipment date, quantity and description are not.

## Limitations

- No scan places, instants, estimated delivery, weight or signatory.

## Numbers

Its waybill numbers are AWB and ten digits, as the form's placeholder and the public sample show.
Other carriers use the same layout, so there is no detection rule; the adapter answers an
explicit selection, and takes a letter prefix and digits. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`huuneh.com/dashboard/track.php?order_track=<number>` opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/huuneh`, with `HUUNEH_TRACKING_NUMBER` and
`HUUNEH_UNKNOWN_NUMBER` set outside the repository.
