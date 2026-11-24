# DER KURIER

DER KURIER, DER KURIER GmbH & Co. KG of Neuenstein (Hesse), is a German courier and express network
of independent stations whose parent company is GLS. It delivers parcels across Germany, reaches
several European countries through its partner network and sends to the rest through GLS. Its site
is derkurier.de. GLS's job offers name its Neuenstein company OverNight Express & Logistics GmbH.
[DER KURIER Slovakia](../der-kurier-sk/README.md) is a separate company. Tracked through its
tracker on leotrace.derkurier.de.

## How it works

1. `direct`: one `GET https://leotrace.derkurier.de/paketstatus.aspx?Lang=DE&parcel={number}`. The
   ASP.NET page renders the parcel's rows on the server; no session, form state or browser is
   needed. When it lists no row under the number, one
   `GET https://api.derkurier.de/rs/api/v1/order/find?parcel-no={number}&archive=true` to the order
   service the derkurier.de widget asks, and one more for the number's GLS form when it has one.
2. `retry`: one more read after a network failure or a timeout. The first gets half of the budget.

- The tracker lists every parcel related to the number, each under its own number on its first
  row. Only the rows under the number asked are read; when there are none, the rows under its GLS
  form, the layout the widget rewrites a number to when it has 8 and 5 in third and fourth place,
  with the 8 moved to the front.
- For a number it holds nothing under, the tracker shows another parcel's rows rather than an
  empty table, so its page never says not found. The order service's answer `No order for
  parcel-no {number}` for the number and its GLS form is not found; an order there without a row
  on the tracker is a parcel listed before its first scan. The order service keeps less history
  than the tracker, so it is asked only to settle a page without the number.
- A 403 is a challenge, a 503 maintenance, a redirect a moved tracker, and any other page or
  service reply a schema failure.

## Notes

- Rows keep the station's wall clock: the tracker gives a day and a time without a zone.
- DER KURIER reuses parcel numbers, and the tracker lists every parcel that carried the number
  under it. Rows more than 60 days apart belong to different parcels, and only the newest is kept.
- The status column gives each row's wording. The remark column is read only for the remarks the
  tracker words alike for every parcel, such as `Kunde nicht angetroffen`, joined to the status
  after a colon. Any other remark is a driver's free text, which can name the recipient, and is
  never read.
- [`status.ts`](status.ts) stages the rows by their status; wording the map lacks goes through the
  shared German rules. The newest row with a stage decides.

## Limitations

- No place, delivery estimate, weight or service. With the recipient's postcode the tracker
  would show the recipient, which the adapter never asks for.
- A reused number shows its last parcel until the new one gets its first scan.

## Numbers

The tracker takes the first 11 digits of the label's number. The adapter also takes the label's
twelve digits and drops the last, a check digit, as the widget does. Eleven digits are shared by
many carriers and nothing in the number points to DER KURIER, so there is no rule and no
recognition. The widget's other inputs, a sender's order id and a station reference, are not
taken. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`https://derkurier.de/sendungsverfolgung/?d-pt-search={trackingNumber}` opens the tracking page on
the number. The library reads the number from that address.

## Testing

`npm run test:carriers:live -- carriers/der-kurier` reads the first public sample, or
`DER_KURIER_TRACKING_NUMBER`, and with `DER_KURIER_UNKNOWN_NUMBER` checks that number is not found.
