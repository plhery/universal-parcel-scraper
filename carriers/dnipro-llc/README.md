# Dnipro LLC

Dnipro LLC of Roselle, New Jersey, is an air and sea forwarder that ships personal parcels, goods and
vehicles from the United States to Ukraine and other countries, with warehouses in New Jersey,
Delaware and Kyiv. Its site is dniprollc.com. The adapter reads a parcel's events from the lookup
behind its tracking page.

## How it works

1. `direct`: the tracking page posts `{"number", "language", "fingerprint"}` to
   `POST https://dniprollc.com/wp-json/dnipro-tracking/v1/lookup` and gets JSON. It needs no login,
   cookie or CAPTCHA; the page's browser fingerprint is optional and sent empty. The adapter asks in
   English.
2. `retry`: one more read after a lookup that fails to connect or hangs. The first try gets half of
   the budget.

- The reply lists `items`, one per parcel. An empty list is the page's "Parcel not found" and the
  only not-found.
- The lookup echoes the number as typed, so the adapter sends it in capitals and keeps only the
  item under that number. Several items under it are inconclusive.
- A JSON `rate_limited` code is a rate limit. Other refusals, a block page, a redirect, WordPress's
  missing route and a changed reply keep their own failure kinds.

## Notes

- Events come newest first, each with a code, a message, a wall clock and a town. Clocks carry no
  zone and a parcel crosses the United States and Ukraine, so they stay local times.
- Codes are staged as the page's script groups them in [`statuses.json`](statuses.json). The page's
  "Out for delivery in the destination country" covers four codes, hand-overs to the local network
  among them, so it stays in transit. A code the page does not group is staged by its message, if
  at all.
- The destination's name is shown by the page as the recipient's. It is never read, nor are the
  postcodes, the origin, the transport or the container, line, voyage and booking.

## Limitations

- No offsets, estimate, weight or proof of delivery.
- Parcels carry S10 numbers ending in US, a shape shared with other US-origin postal numbers, so no
  rule claims them and preflight does not ask Dnipro LLC. A parcel reaches the adapter when it is
  filed under Dnipro LLC.

## Numbers

The samples and their sources are in [`numbers.json`](numbers.json).

## Links

Tracking links carry the number as `tracking` on the `packages-tracking` page at dniprollc.com.

## Testing

`npm run test:carriers:live -- carriers/dnipro-llc`, with `DNIPRO_LLC_TRACKING_NUMBER` and
optionally `DNIPRO_LLC_UNKNOWN_NUMBER` set outside the repository.
