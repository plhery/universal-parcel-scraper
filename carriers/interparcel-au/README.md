# Interparcel Australia

Interparcel's Australian site books parcels with couriers such as Couriers Please and StarTrack
and gives each booking its own reference, AU and ten digits. Tracked through its tracking page,
which is the same page as [Interparcel UK](../interparcel-uk/README.md)'s.

## How it works

1. `direct`: one `GET https://au.interparcel.com/tracking/{reference}`.
2. `retry`: one more request when the first fails to reach the site or hangs.
3. `trawl`: Cloudflare answers a direct request with a managed challenge. After that challenge,
   the configured browser service opens the same address and the adapter reads the page it
   renders.

- A reference the site does not hold gets the empty track form with the reference in its box.

## Notes

- The page, its reading and its status letters are Interparcel UK's: see its README and
  [interparcel.ts](../interparcel-uk/interparcel.ts). This site answers only for its own
  references.
- Rows keep their wall clocks as `local_time` alone, as the page gives no zone.

## Limitations

- No delivery estimate, weight or recipient. The courier's own tracking number is not kept.
- TRAWL is required in practice: the direct request meets Cloudflare's check.
- Other carriers use two letters and ten digits, so no rule claims the shape. Select Interparcel
  Australia or paste its tracking link.

## Testing

`npm run test:carriers:live -- carriers/interparcel-au`, with `FLARESOLVERR_URL`,
`INTERPARCEL_AU_TRACKING_NUMBER` and optionally `INTERPARCEL_AU_UNKNOWN_NUMBER` set outside the
repository.
