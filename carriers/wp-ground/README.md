# WP Ground

WP Ground (WPG) delivers large and bulky parcels on the last mile in the United States and Canada,
from hubs in Los Angeles, Miami, Dallas, Chicago and New York. Its site is www.wpglogis.com.

## Retrieval

One `direct` POST sends the number as the form field `trackNumberList` to `/api/trackQuery` on
www.wpglogis.com, as the site's tracker does; no key, cookie, session or browser is needed. The
tracker takes several numbers separated by commas, so the adapter sends one number of letters and
digits.

The answer lists scan rows, each naming the number it belongs to; only the requested number's rows
are read, and rows for another number alone are inconclusive. An empty list is the tracker's own
"No Data" and the only not-found. A refusal (`success: false`), a block page and a changed answer
keep their failure kinds.

## Notes

- A history with more than 100 distinct scans returns the newest 100 and sets `history_truncated`.

- A row's wording is its `remarks`, the line the site shows under the row's title and as the
  parcel's status; the title (`nodeCode`) is kept as the provider code. No wording has been seen
  yet, so the shared classifier reads each one and an unread wording leaves the row without a stage.
- Row clocks name no zone. They are kept as wall clocks, which Node lookups date on a deduced zone
  ([clocks](../../places/README.md#clocks)), the row's place first. Rows whose places all give a zone are ordered by instant across zones, others by wall clock.
- A row's address loses its postcode; an address that still holds a number is a street's and is left
  out. Sender and recipient cities, proof-of-delivery photos, the recipient-name check that opens
  them, sizes and weights are never read.

## Numbers

WP Ground publishes no number format, and no public page shows one of its tracking numbers, so
there is no rule and recognition never asks the tracker. The tests use made-up numbers.

## Links

Tracking links carry the number as `ext_trackingNumber` or `trackingId` on the `tracking` page of
www.wpglogis.com.

## Testing

`npm run test:carriers:live -- carriers/wp-ground`, with `WP_GROUND_TRACKING_NUMBER` and optionally
`WP_GROUND_UNKNOWN_NUMBER` set outside the repository.
