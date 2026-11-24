# Interparcel UK

Interparcel books parcels with couriers such as FedEx, UPS and Parcelforce and gives each
booking its own reference, GB and ten digits. Its tracking page shows the courier's service,
the delivery town, the signer and the courier's scans. Tracked through that page.

## How it works

1. `direct`: one `GET https://uk.interparcel.com/tracking/{reference}`, the page Interparcel's
   track form opens.
2. `retry`: one more request when the first fails to reach the site or hangs.
3. `trawl`: Cloudflare puts a managed challenge in front of the page and answers a direct request
   with it. After that challenge, the configured browser service opens the same address and the
   adapter reads the page it renders. Definite answers, rate limits and malformed replies do not
   launch a browser.

- A reference the site does not hold gets the empty track form with the reference in its box.
  A form or page for another reference is inconclusive.

## Notes

- The page has two lists. Its summary gives a few rows a status letter (`B` booked, `I`
  information, `T` transit, `O` out for delivery, `D` delivered) in Interparcel's words; the
  detailed list has every scan in the courier's words. The adapter keeps the detailed list and
  puts each letter on the row at the same clock and place, in the same words where two share
  them. The letters stage their rows; the other rows are staged by their wording.
- The detailed list leaves out the year. Each row takes the year, around the summary's newest,
  whose calendar puts the row's weekday on its day.
- The page gives clocks without a zone, and a courier's scans can come from several countries,
  so each row keeps its wall clock as `local_time` alone.
- Interparcel's own steps take place "Online", which is not kept as a location.
- Detection names Interparcel UK for GB and ten digits, the reference its
  [help page](https://uk.interparcel.com/help/knowledge-base/general-advice/how-do-i-track-my-parcel)
  describes. Amazon's British shipment ids
  [start with UK](https://developer-docs.shipping.amazon.com/apis/changelog/pre-launch-announcement-amazon-shipping-tracking-id-format-update-for-uk)
  instead, so Amazon's rule leaves GB out.
- The code and shared reading live in [interparcel.ts](interparcel.ts), which
  [Interparcel Australia](../interparcel-au/README.md) also uses.

## Limitations

- No delivery estimate, weight or recipient. The sender's order reference and the courier's own
  tracking number are not kept, so the courier's tracking is not linked.
- TRAWL is required in practice: the direct request meets Cloudflare's check.

## Testing

`npm run test:carriers:live -- carriers/interparcel-uk`, with `FLARESOLVERR_URL`,
`INTERPARCEL_UK_TRACKING_NUMBER` and optionally `INTERPARCEL_UK_UNKNOWN_NUMBER` set outside the
repository.
