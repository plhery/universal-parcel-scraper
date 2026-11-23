# Gold Star Line

Gold Star Line is ZIM's Hong Kong container line. Tracked through the lookup its public tracking
page makes, for a bill of lading or a container.

## How it works

1. `direct` posts the page's lookup to `https://www.goldstarline.com/api/cms`, a JSON body with
   the action `get_track_shipment_val` and the number, as the page does. The reply lists each
   container of the shipment and its activities.
2. `retry` asks once more when the request did not reach Gold Star Line.
3. `browser`: with `TRACKING_CHROMIUM_PATH`, when Akamai refuses the lookup, a fresh context opens
   the page's link for the number, `/tools/track_shipment/<number>`, and reads the reply to the
   lookup the page then makes. When Akamai shows its check in place of the page, the step moves
   the pointer to the check's box and its button and presses each, as ZIM's does.

Akamai answers a client that does not name a browser with a 403 page, so the lookup sends a Chrome
user agent and the browser step recovers a refusal. No account, cookie or CAPTCHA is needed.

## Notes

- Only the main frame's POST whose body asks for the whole number is read; the page's other calls
  to the same address fetch its header. A reply must name the number asked, and a container's must
  hold that container alone.
- `reference not found` (`GSL-0016`) for the number asked is not found. The service behind the page
  answers some numbers, such as another ZIM line's containers, with an internal error inside a
  successful reply: that error is the upstream status it gives, never not found.
- Most activities state their place's offset, which is kept. Carrier and customs releases and the
  container's availability carry ZIM's own +03:00 label on the place's wall clock, so those are
  read in the place's zone: a US state's or Canadian province's from the code after the town, or
  the country's, whose code comes from the UN/LOCODEs of the reply's ports.
- Activities carry no code and come sorted by wording, so they are ordered by time, and activities
  of one time by stage. Their English wording is staged in [statuses.json](statuses.json).
- The return of the empty container is the delivery. An empty container returned before it moved
  is an unused one, and a gate in after the container moved is transit. Carrier and customs
  releases are notices without a stage.
- A bill's containers move apart. The bill is delivered once every container is back; until then
  the latest open stage leads. Activities the containers share are kept once.
- The route, vessels, container sizes and final estimate are not read: the estimate is the
  vessel's arrival at the destination, not a delivery.

## Limitations

- A container lookup returns the container's latest cycle, which may be a later shipment than the
  one asked about.
- A shipment listed without activities, as older bills are, is no history.

## Numbers

Bills of lading are `GOSU`, Gold Star Line's carrier code, three letters for the issuing office
and seven to nine digits; a bill typed without `GOSU` gets it, as the lookup needs it. Containers
are ISO 6346 numbers, Gold Star Line's own `GOSU` and those it leases, whose check digit is
checked before the lookup. Detection has no rule. The samples and their sources are in
[`numbers.json`](numbers.json). The page's own link, `https://www.goldstarline.com/tools/track_shipment/…`,
and the former page's `CCM.aspx?textContainerNumber=…` are read as Gold Star Line's. ZIM hands
it the containers ZIM's tracker says Gold Star Line holds.

## Testing

`npm run test:carriers:live -- carriers/gold-star-line`, with `GOLD_STAR_LINE_TRACKING_NUMBER`,
`GOLD_STAR_LINE_UNKNOWN_NUMBER` and optionally `TRACKING_CHROMIUM_PATH` set outside the repository.
