# Zimpost

Tracks the S10 items in Zimpost's IPS record, its own and those other posts send to Zimbabwe, through
the lookup the tracking overlay on its home page makes.

Zimpost (Zimbabwe Posts) is Zimbabwe's designated postal operator. Its site is zimpost.co.zw.

## How it works

1. `direct`: one `GET https://www.zimpost.co.zw/api/track?number=<code>`, as the overlay sends it. It
   needs no account, cookie, token, key or browser. The site relays the item's record from IPS, the
   UPU's system.
2. `retry`: a lookup that fails to reach the site, or hangs, is sent once more within the budget. The
   first try gets half of the budget.

- A found item comes with HTTP 200, `success: true` and `data`: the site's summary and, under
  `raw.data`, the IPS record itself. The adapter reads the record: the summary has no clocks or event
  numbers. `MAILITM_FID`, the summary's number and the relay's `fid` must all be the whole code asked
  for.
- An item the tracker does not hold gets HTTP 404 with the JSON error "Tracking number not found",
  the only reply read as not found. A 404 without that JSON is a missing route, another error a
  changed reply, a block page a challenge and a 429 a rate limit.

## Notes

- A scan names its IPS event by number and by IPS's English name. The number sets the stage: IPS
  numbers its events the same in every post's system. An event the map does not know is staged by
  the shared wording rules from its name.
- `EVENT_GMT_DATETIME` is the scan's instant and `EVENT_LOCAL_OFFSET` the office's offset in hours.
  Each scan keeps its instant written with that offset. An office can state a wrong one, such as
  −7 hours in Zimbabwe; the instant still orders the scans. An offset no clock has leaves the
  instant in UTC.
- The weight and the destination country are read. The origin country, mail class, next office, bag
  state and item condition are not.

## Limitations

- The tracker has no ETA, sender, recipient or signatory.
- Items leave the record after a while: the parcel the overlay offers as an example, which it
  answered with its scans, now gets the not-found reply. Universal providers are still asked after
  a not-found answer.
- Delivery and the outward leg of Zimpost's own items have not been seen live; the map reads their
  IPS event numbers.
- The adapter takes only S10 codes with a valid check digit. The overlay's other example, eight
  characters starting `ZP`, is not found and its service is unknown.

## Numbers

Its items carry UPU S10 numbers ending `ZW`, which generic postal detection keeps: no public Zimpost
item is known to test a rule of its own against. The overlay also offers a German parcel as an example, which stays Deutsche Post's.

## Links

The tracker opens in an overlay on the home page with no address for a single number.

## Testing

`npm run test:carriers:live -- carriers/zimpost`, with `ZIMPOST_TRACKING_NUMBER` set outside the
repository.
