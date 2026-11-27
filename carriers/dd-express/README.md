# DD Express

DD Express Sdn Bhd, also called DD Cold Chain, delivers chilled and frozen e-commerce parcels
door to door in Peninsular Malaysia and Singapore. Its site is dd.express, and its tracker is at
`tracking.dd.express/v2/`.

## How it works

1. `direct`: `GET trackapi.dd.express/corporate/tracking/query?tracking_ids=<number>`, the
   lookup the tracker makes, with no key, session or check. An empty `data` list is its answer
   for a number it has no parcel under, and reads as not found.
2. `retry`: a read that fails to reach the lookup, or hangs, is sent once more.

- Another `status` or `message` in the reply, a page in place of JSON, a redirect or a 404 says
  nothing about the parcel.
- The lookup finds a parcel by its tracking id or by the shipper's reference, and the tracker
  lists both. Shippers' references may repeat, so only the parcel whose own tracking id is the
  number asked is read, and each of its statuses must name that number.

## Notes

- Statuses are instants in UTC and are kept as instants. The tracker dates a status by its
  `status_time` when the row has one, else by `created_at`, when the row was written; the
  adapter does the same and keeps `created_at` as `written_at` beside a different `status_time`.
- Statuses have no code and are staged by their whole wording. The tracker writes one with a
  stray opening bracket, which the adapter drops.
- "Shipment Scheduled Out For Delivery" is a delivery booked for a later run, so it reads as in
  transit: on the public sample it came minutes after the collection and days before the delivery.
- The shipper's reference and the photos a status can carry stay behind.
- The tracker's Singapore, Thai and Indonesian hosts ask `api-sg`, `api-thai` and
  `api-indo.dd.express`, which do not answer; the main lookup has the public sample.
- The tracker's older page at `tracking.dd.express/?tracking_ids=` asks `apiv2.dd.express`, which
  refuses every lookup with HTTP 401.

## Limitations

- Statuses name no place, and the lookup gives no delivery estimate.

## Numbers

The public sample is eleven digits, a shape many carriers share, so no rule names DD Express.
It and its source are in [`numbers.json`](numbers.json).

## Links

The tracker reads `tracking_ids` from its address and asks the lookup, but lists only the
numbers typed in its box, so the parcel's link opens the tracker alone. Links of both pages
carry the number in `tracking_ids`, which the link rule reads.

## Testing

`npm run test:carriers:live -- carriers/dd-express`

The live test tracks the public sample in `numbers.json`; `DD_EXPRESS_TRACKING_NUMBER` tracks
another number, and `DD_EXPRESS_UNKNOWN_NUMBER` checks the not-found answer.
