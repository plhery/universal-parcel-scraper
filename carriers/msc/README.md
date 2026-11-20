# MSC

MSC, the Mediterranean Shipping Company, is the Swiss-based container line. Tracked through the
lookup its public tracking page makes, for a bill of lading, a container or a booking.

## How it works

1. `direct` posts `{"trackingNumber": number, "trackingMode": mode}` to
   `https://www.msc.com/api/feature/tools/TrackingInfo`, as the page does: mode `0` for a bill or
   a container, `1` for a booking. The reply lists each container of the shipment and its moves.
2. `retry` asks once more when the request did not reach MSC.
3. `browser`: with `TRACKING_CHROMIUM_PATH`, when Akamai refuses the lookup, a fresh context opens
   the page's own link for the number, `?params=` and the search in base64, and reads the reply to
   the lookup the page then makes.

Akamai answers a client that does not name a browser with a 403 page, so the lookup sends a
Chrome user agent. A client whose TLS does not look like a browser's is refused whatever it sends,
and right after a refusal Akamai may answer with an empty 200; both are challenges, which the
browser step recovers. No account, cookie or CAPTCHA is needed.

## Notes

- The page's link is the only one it gives, and it hides the number in base64, so no link is
  read as MSC's.
- Only the main frame's POST whose body names the whole number and its mode is read. A reply must
  name the number and its kind, and a bill's must list that bill alone. A container lookup reads
  that container alone.
- MSC's answer for a number it does not hold names the kind of number it looked for; only the
  answer for the kind asked is not found.
- Moves are dated without a time and keep the reply's day. Each place is the terminal, when the
  reply names one, then MSC's place name.
- The return of the empty container, at a yard or a rail ramp, and the end of the import cycle are
  the delivery. An empty container returned before it moved is an unused one, and a move back to
  the export yard after the container moved is transit. Customs release and the end of free time
  are notices without a stage. The wordings are staged in [statuses.json](statuses.json).
- A bill's containers move apart. The bill is delivered once every container is back; until then
  the latest open stage leads. Moves the containers share are kept once.
- Moves dated after the reply's day, which the page greys, and the estimated arrival are planned
  steps. Vessels, voyages, container sizes and the ports summary are not read.

## Limitations

- A container lookup returns the container's latest cycle, which may be a later shipment than the
  one asked about.
- No public booking was found, so the booking reply is read as a bill's reply under the booking's
  type, from a synthetic test.
- A shipment listed without moves is no history.

## Numbers

Bills of lading are `MEDU`, MSC's carrier code, and eight characters. Containers are ISO 6346
numbers, whose check digit is checked before the lookup. Any other code of six to twenty letters
and digits that does not start with `MEDU` is read as a booking. Detection has no rule. The
samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/msc`, with `MSC_TRACKING_NUMBER`, `MSC_UNKNOWN_NUMBER`
and optionally `TRACKING_CHROMIUM_PATH` set outside the repository.
