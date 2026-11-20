# Topparcel

Topparcel, a courier booking site based in Ipswich, books parcels from Britain and the European
Union with couriers and posts, and tracks each one by the number of the courier or post it booked.
Its tracker lists its own steps, then those of that courier or post.

## How it works

1. `direct`: opens the tracking form at `topparcel.com/parcels/tracking` and posts the number back
   to it with the form's token, in a session of its own. The page that comes back lists the rows;
   "Parcel not found" is not found.
2. `retry`: a read that fails to reach the tracker, or hangs, is sent once more.

- The form asks for no check. Cloudflare sits in front of the site, so a challenge page or a 403 is
  a challenge, not a missing parcel.
- The page must name the number asked as its tracking number.

## Notes

- Topparcel's own rows come first: `Accepted` is the booking, before the courier collects the
  parcel, and `Collected` the collection. The partner's rows follow in its own wording, which the
  shared wording rules read; `statuses.json` maps the wording they misread or miss.
- Rows keep their wall clock: the page gives no zone, and Topparcel's own rows and the partner's
  are on different clocks.
- A row's location is its address and country. A post's delivery row adds the post office's
  address, which is left out with the parcel's weight.
- The tracker takes a number only in a form posted with the session's token, so no link opens a
  parcel.

## Limitations

- No delivery estimate or proof of delivery.
- A parcel booked but not yet handed over may have no rows.

## Numbers

The numbers are the booked courier's or post's, so detection names that carrier. The samples and
their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/topparcel`

The live test tracks the public samples in `numbers.json`; `TOPPARCEL_TRACKING_NUMBER` tracks
another number, and `TOPPARCEL_UNKNOWN_NUMBER` checks the not-found answer.
