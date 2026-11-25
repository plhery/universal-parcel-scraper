# FyNEX

Tracks shipments of FyNEX (F Y N Express Couriers LLC), a courier based in Al Qusais, Dubai, on its
own tracking page. It delivers documents and parcels within the UAE, the same day or later, to the
other Gulf states and abroad, and delivers for online shops. Its site is fynexcourierdubai.com.

## How it works

1. `direct`: `POST https://fynexcourierdubai.com/tracking/` with `trackno={number}`, as the page's
   form sends it. It needs no cookie, key or CAPTCHA.
2. `retry`: the same post once more when FyNEX cannot be reached.

- The page is rendered on FyNEX's server. Its tracking panel names the number, then gives the route,
  the current status, the scans newest first with a day, a 12-hour clock, a place and an activity,
  and the shipment type, weight and pieces. The adapter keeps a panel only when it names the number
  asked.
- For a number it does not know, the panel stays empty, exactly as it does when the page gets no
  number, so an empty panel leaves the result open and is never read as not found.
- A bot check or a 401 or 403 is a block, a 503 maintenance, a redirect or a missing page a moved
  tracker, and any other page a changed one.
- The site is TSS Smart's courier build, which [MAX Express](../max-express-ae/README.md) and
  [DDU Express](../ddu-express/README.md) also run. The request and parser live in
  [tssSmart.ts](tssSmart.ts), with the host, number layout and status map passed in. Their panels
  answer an unknown number with "Invalid airwaybill or booking number", which the parser reads as
  not found.

## Numbers

FyNEX publishes no layout. The public sample is seven digits, a length many carriers share, so no
rule offers FyNEX. The adapter takes 5 to 30 letters and digits.

## Notes

- Scans are staged by their whole wording. Clocks are wall clocks without an offset, kept local.
- A delivery scan goes on with "Received By" and who took the shipment; that part is cut off and
  never read. The page shows no sender or recipient.
- The destination's country, the shipment type and the weight are read; the origin, the pieces and
  the progress rail are not.

## Links

The tracking page also reads the number from its `trackno` parameter.

## Testing

```sh
npm run test:carriers:live -- carriers/fynex
```

`FYNEX_TRACKING_NUMBER` and `FYNEX_UNKNOWN_NUMBER` replace the delivered sample and the invented number.
