# COSCO SHIPPING Lines

COSCO SHIPPING Lines, based in Shanghai, is the container line of China COSCO Shipping. Tracked
through the lookups its public cargo tracking page asks.

## How it works

1. `direct`: a `POST` to
   `https://elines.coscoshipping.com/scct/scct_customer_ex/public/cargoTracking/detail` with
   `{"businessNumber":…,"businessNumberType":"blNumber","notFilterResult":false}` answers a bill
   of lading or a booking: its summary with the latest milestone, its chain of milestones and its
   vessel legs. The same body with `containerNumber` sent to `…/containers` answers the bookings
   a container serves, each with its latest milestone.
2. `retry`: a lookup that fails to reach the service, or hangs, is sent once more within the
   budget. The first try gets half of it.
3. `browser`: with `TRACKING_CHROMIUM_PATH`, after the bot manager blocks the plain lookup or
   COSCO rate limits it, the page at `/scct/public/ct/base` opens with the number in its address in
   a fresh context. The adapter reads the page's own calls for that number: its check for the
   shipment, which finds nothing for an unknown number, and then its lookup.

Every reply is a JSON string of base64 that the page's script XORs with a key it ships to every
visitor. The adapter decodes it the same way. No account, cookie or CAPTCHA is needed, but
Wangsu's bot manager in front of the service blocks a plain client with HTTP 403 for a few
minutes after a handful of lookups, and a browser passes its check.

## Notes

- COSCO gives each milestone its place's wall clock and, beside it, the place's IANA zone. The
  adapter keeps the wall clock and reads it in that zone.
- The latest milestone carries a facility code but no zone. It takes the zone of the chain's row
  at that facility, or at another facility of the same town, which shares the code's first three
  letters. A milestone at a facility the chain does not list keeps its wall clock alone. COSCO
  masks some trucking milestones' places with asterisks; those are left out.
- The vessel legs give every departure and arrival, transshipments included, so the chain's own
  first departure and last arrival are not read again beside them. Estimates without an actual
  time are planned steps.
- COSCO files Taiwan's ports under China while giving them Taipei's clock. A country the zone
  contradicts is left out of the place.
- The milestones are staged in [statuses.json](statuses.json): the chain's by their name as a
  code, the latest one by its wording. The empty container's return after the consignee
  unloaded it is a delivery.
- A booking is looked up as a bill of lading, which COSCO accepts, and a bill matches when the
  summary names it or its booking.
- The vessel, voyage, ports of loading and discharge and the customs dates are not read.

## Limitations

- A container lookup gives only its latest booking's latest milestone, on its wall clock, and
  the estimated arrival at the last port. The history is marked as cut short.

## Numbers

COSCO's bills of lading are `COSU`, its carrier code, and the booking's ten digits; the page
takes the digits. Bookings are ten digits, and containers ISO 6346 numbers, whose check digit is
checked before the lookup. Detection has no rule. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/cosco-shipping-lines`, with
`COSCO_SHIPPING_LINES_TRACKING_NUMBER` and `COSCO_SHIPPING_LINES_UNKNOWN_NUMBER` set outside the
repository, and `TRACKING_CHROMIUM_PATH` for the browser step.
