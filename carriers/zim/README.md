# ZIM

ZIM Integrated Shipping Services is the Israeli container line. Tracked through the lookup its
public tracking page makes, for a bill of lading or a container.

## How it works

1. `direct` asks `https://apigw.zim.com/digital/TrackShipment/v2/complete-result` for the number,
   with the subscription key the page sends every visitor, as the page does. The reply lists each
   container of the shipment and its activities.
2. `retry` asks once more when the request did not reach ZIM.
3. `browser`: with `TRACKING_CHROMIUM_PATH`, when Akamai refuses the lookup, a fresh context opens
   the page's link for the number, `?consnumber=`, and reads the reply to the lookup the page then
   makes. When Akamai shows its check in place of the page, the step moves the pointer to the
   check's box and its button and presses each; the check then reloads the page.

Akamai answers a client that does not name a browser, or whose TLS does not look like one, with a
403 page, so the lookup sends a Chrome user agent and the browser step recovers a refusal. Akamai's
check weighs how the pointer reaches its box: a click without movement loops back to the check.
No account, cookie or CAPTCHA is needed.

## Notes

- Only the main frame's GET of the lookup whose `reference` is the whole number is read. A reply
  must name the bill, or the container, it was asked for.
- ZIM's answer for a number it does not hold differs by kind; only the answer for the kind asked
  is not found.
- For a container another ZIM line holds, the result's code names that line in the reply's
  `carriers`. Gold Star Line's containers answer with no history and hand the container to
  [Gold Star Line](../gold-star-line/README.md). The other lines, LNL and SETH, are not in the
  catalog: their containers are invalid input naming another carrier.
- A bill's reply states each activity's time with its place's offset. A container's reply labels
  some wall clocks with an offset of ZIM's own, so its times are read as wall clocks in their
  place's zone: a US state's or Canadian province's from the code after the town, or the
  country's. A time without a stated offset is read the same way.
- The return of the empty container is the delivery. An empty container returned before it moved
  is an unused one, and a gate in after the container moved, at the port after an inland depot, is
  transit. Carrier and customs releases are notices without a stage. The codes are staged in
  [statuses.json](statuses.json).
- A bill's containers move apart. The bill is delivered once every container is back; until then
  the latest open stage leads. Activities the containers share are kept once.
- The route legs' dates label the port's wall clock with ZIM's server offset, so the estimated
  arrival is not read. Vessels, voyages, parties and container sizes are not read either.

## Limitations

- A container lookup returns the container's latest cycle, which may be a later shipment than the
  one asked about.
- A shipment listed without activities is no history.

## Numbers

Bills of lading are `ZIMU`, ZIM's carrier code, three letters for the issuing office and seven to
nine digits; a bill typed without `ZIMU` gets it, as ZIM looks bills up with it. Containers are
ISO 6346 numbers, whose check digit is checked before the lookup. Detection has no rule. The
samples and their sources are in [`numbers.json`](numbers.json). The page's own link,
`https://www.zim.com/tools/track-a-shipment?consnumber=…`, is read as ZIM's.

## Testing

`npm run test:carriers:live -- carriers/zim`, with `ZIM_TRACKING_NUMBER`, `ZIM_UNKNOWN_NUMBER`
and optionally `TRACKING_CHROMIUM_PATH` set outside the repository.
