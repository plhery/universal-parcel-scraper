# T.S. Lines

T.S. Lines (德翔海運) is the Taiwanese container line. Tracked through the service behind the
[cargo tracking page](https://www.tslines.com/en/tracking) of its website, for a container or a
bill of lading.

## How it works

1. `direct` asks the page's JSON service at `https://epd.tslines.com/v1` as the page does:
   - a captcha, `GET captcha`, whose SVG the adapter reads and whose single-use token goes with
     the search;
   - a container: `POST CargoTrackingByContainerNumber`, which lists the container's latest move
     in each cycle and names the cycle's bill once one is issued; then the moves of the latest
     cycle under that bill, `POST CargoTrackingHis`;
   - a bill: `POST CargoTrackingByBLNumber`, which lists the latest move of each container; then
     the moves of its first three containers under the bill.
2. `retry` reads once more, with new captchas, when a request did not reach T.S. Lines.

The service asks for the site's `Origin` and `Referer` and nothing else: no account or cookie.

## Notes

- The captcha draws each of its four digits as one filled path, among unfilled noise strokes.
  A digit is read by the number of quadratic curves in each subpath of its glyph, and the digits
  are ordered by each glyph's leftmost point. No OCR. An image that does not read as four known
  glyphs is a challenge, never a guess.
- A wrong code is answered with HTTP 400 `captcha code invalid.`: the adapter asks one new
  captcha, then reports a challenge. Empty lists after an accepted code are a number T.S. Lines
  does not hold; a blocked or changed reply, another 400 or a missing route never is.
- Every row must name the container or bill asked.
- A cycle without a bill has its latest move as its only known move. Under a bill, the search's
  latest move is kept where the history lacks it, since the two can differ.
- The return of the empty container is the delivery, and a full container out for devanning goes
  out for delivery. An empty container returned before it moved is an unused one, and a gate in
  after the container moved is transit. The wordings, typos included, are staged in
  [statuses.json](statuses.json).
- A bill's containers move apart. The bill is delivered once every container is back; until then
  the latest open stage leads. The containers past the first three keep their latest move, and
  the history is marked truncated.
- Times are wall clocks: T.S. Lines states no zone. Locations are the facility and its country.
- Estimated dates, routes, vessels, voyages and seals are not read.

## Limitations

- A container lookup returns the container's latest cycle, which may be a later shipment than the
  one asked about.

## Numbers

Containers are ISO 6346 numbers, whose check digit is checked before the lookup. Bills are twelve
digits. Detection has no rule: both shapes are shared with other carriers. The samples and their
sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/ts-lines`, with `TS_LINES_TRACKING_NUMBER` and
`TS_LINES_UNKNOWN_NUMBER` set outside the repository.
