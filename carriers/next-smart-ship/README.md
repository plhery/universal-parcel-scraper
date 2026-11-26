# Next Smart Ship

Next Smart Ship (NSS) is a Shenzhen fulfilment company for online shops, with warehouses in China
and abroad. Its NSS Standard and NSS Expedited lines carry orders under its own `NSS` numbers and
hand them to a carrier in the destination country, such as USPS or Australia Post. Tracked
through the lookup its tracker at `fulfillship.nextsmartship.com/track` makes.

## How it works

1. `direct`: one `POST https://api.nextsmartship.com/oms/v3/tracks/v2/query` with the body
   `{"search":["{number}"]}`, as the tracker page sends the numbers in its address. It needs no
   cookie, token or browser. The reply lists one entry per number asked, with the status, the
   scans, the countries and the last-mile carrier's name, number and link.
2. `retry`: one more try when the request fails to reach the service or hangs. The first try
   gets half of the budget.

- The tracker reads a number in lower case as unknown, so the number is sent in capitals.
- An unknown number comes back as its entry with no history and every field empty, which the
  page shows as "Logistics tracking not found": that reads as not found.
- An entry without scans that holds anything else, such as a link to another tracker, its
  countries or a last-mile number, is a parcel listed without scans, not a missing one.
- A `code` other than 0 is inconclusive. CloudFront serves the API; an AWS WAF check in place of
  the reply is a challenge.
- The entry must name the number asked.

## Notes

- Scan times are instants in UTC and are kept as such.
- Scans carry wording only: Next Smart Ship's own lines, then the line's and the last-mile
  carrier's, relayed as each words them. Many open with a place in brackets, which becomes the
  scan's location; a bracket naming an agent rather than a place is dropped. A small map stages
  Next Smart Ship's own lines and the last mile's acceptance scans, which come days after the
  parcel left the warehouse; the shared wording rules stage the rest.
- The entry's status decides the stage. Within In Transit, the newest scan says when the last
  mile has gone further, such as out for delivery or waiting for collection, but a relayed
  delivery waits for the status to say Delivered. The tracker shows any entry flagged for
  compensation as Abnormal, and so does the adapter.
- The last-mile number is the delivery hand-off. Its carrier is handed over when the reply names
  one the catalog knows and its rules fit that number. A USPS routing barcode gives its package
  identifier.
- The origin country, the days in transit and the last-mile carrier's phone and website are not
  kept.

## Limitations

- An order split into several packages lists them under their own numbers, which the adapter
  does not follow: it answers inconclusive.
- The tracker can show a delivery estimate; no reply seen so far gave one, so it is flagged as
  unread rather than parsed.
- No weight, service, sender or recipient.

## Numbers

Next Smart Ship numbers start `NSS`; the samples are `NSS` and 19 digits. The samples and their
sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/next-smart-ship`

The live test tracks the public samples in `numbers.json`; `NEXT_SMART_SHIP_TRACKING_NUMBER`
tracks another number, and `NEXT_SMART_SHIP_UNKNOWN_NUMBER` checks the not-found answer.
