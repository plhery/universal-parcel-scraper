# Lerdex

Lerdex (乐易汇) sends e-commerce parcels from its warehouse in China on lines such as
YunExpress, whose partners deliver them abroad. Tracked through the lookup of its public
tracking page.

## How it works

1. `direct`: one `POST https://api.bestdealer.com/logistics/orderTracking/queryOrderTracking`
   with `{"numbers":["{number}"]}`, the lookup the
   [tracking page](https://website.bestdealer.com/tracking.html) makes. It sends the `tk` key
   the page sends for every visitor; there is no session, account or CAPTCHA.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- A number the tracker does not hold comes back as an entry whose fields are all null, which
  is not found. A parcel without scans is no history, and any `code` but 200 inconclusive.
- The entry's `number` must be the number asked.
- The API drops a lookup that closely follows another, which ends in a timeout, not in not
  found.

## Notes

- The reply merges the warehouse's scans and the line's, each newest first, so the result keeps
  the tracker's order. Each clock is the wall clock of its place, in China or at the
  destination, with no zone, so scans keep `local_time`.
- The reply leaves `location` empty and starts each wording with its place, joined by a comma
  without a space, as `DELANO, MN 55328,Delivered`; commas inside a place or a wording have
  one. The place drops postcodes, and a delivery's wording drops whoever signed for it.
- The warehouse's own wordings are in [`statuses.json`](statuses.json); the line's and the
  delivering carrier's scans go through the shared wording rules.
- `oriNumber` is the line's waybill, kept as `delivery_tracking_number`. A YunExpress waybill on
  the YunExpress line also names `yunexpress`.

## Limitations

- No delivery estimate or weight.

## Numbers

The only public number is the example the tracking page prints. One sample is too few to tell
its series from other forwarders' numbers, so no rule claims it and the adapter answers explicit
selection. The sample and its source are in [`numbers.json`](numbers.json).

## Testing

`LERDEX_TRACKING_NUMBER=… LERDEX_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/lerdex`
