# HIT Cargo

HIT Cargo ships packages its customers have delivered to its Miami warehouse on to Nicaragua by
air or sea, for delivery or collection in Managua. Its tracking page looks a package up by its
guía, the number of its Miami warehouse receipt. Tracked through the reply that page reads.

## How it works

1. `direct`: one `GET https://api.hit-cargo.com/track/{guía}`, the request the tracking page
   at `hit-cargo.com/track/` makes. The reply is JSON: the package's status, its service, weight
   and piece count, and its events with their office and clock.
2. `retry`: one more request when the first fails to reach the site or hangs.
3. `trawl`: Cloudflare answers a direct request with its managed challenge. After that check,
   the configured browser service opens the same address and the adapter reads the reply it
   shows. Definite answers, rate limits and malformed replies do not launch a browser.

- An unknown guía gets HTTP 404 with a message that quotes it; the browser service passes that
  reply on with its body. A reply for another guía, or a message quoting another one, is
  inconclusive. The tracker also takes a courier's tracking number and then answers with the
  package's guía, so the adapter asks for guías alone.

## Notes

- The tracker's own system stores the warehouse's wall clocks labeled as UTC and writes them to
  the minute. Those events keep their wall clocks as `local_time` alone: the Miami and Managua
  offices keep different zones and the reply does not say which office's clock was used. An
  event the tracker wrote itself, to the second or finer, keeps its instant.
- The package's status code gives the current stage, and events keep their wording and office,
  staged by [statuses.json](statuses.json). The status codes come from the operator's published
  source.
- Weight comes in pounds and is converted. The piece count and the progress bar's step are not
  kept.

## Limitations

- No delivery estimate, recipient or sender.
- TRAWL is required in practice: the direct request meets Cloudflare's check.
- Guías are six-digit counters, so no rule claims them. Select HIT Cargo.

## Testing

`npm run test:carriers:live -- carriers/hit-cargo-nicaragua`, with `FLARESOLVERR_URL`,
`HIT_CARGO_NICARAGUA_TRACKING_NUMBER` and optionally `HIT_CARGO_NICARAGUA_UNKNOWN_NUMBER` set
outside the repository.
