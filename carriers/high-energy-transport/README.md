# High Energy Transport

High Energy Transport is a final-mile courier in Canada that delivers furniture and appliances
to homes for retailers. Its orders are tracked on DispatchTrack, under the account
`highenergytransport` and the track code `f7ea831`, by the DispatchTrack reader in
[dispatchtrack.ts](dispatchtrack.ts), which Ryder Last Mile uses too.

## How it works

1. `direct`: one `GET https://highenergytransport.dispatchtrack.com/api/v1/order_tracker/f7ea831?phone_number={number}`,
   the lookup the tracker page's frame makes. The order number goes in `phone_number`, where the
   page's script puts it. It needs no ZIP code or token. The JSON reply is a snapshot of the order
   without its events.
2. `retry`: the same lookup once more after a network failure or a timeout.

- An unknown order is HTTP 404 with `"error":"Order not found"`. Any other 404, a redirect or a
  reply that is not JSON is not a missing order.
- A 422 with `captcha_error` is the tracker's reCAPTCHA check. The page writes a reCAPTCHA
  Enterprise token into a cookie, which the lookup has not asked for so far.
- The snapshot's `shortLabel` must be the number asked. When it names another order number, the
  order widget at `/track_orders/f7ea831/{number}` binds it: one of the widget order's numbers
  must be the number asked.
- Recognition is off, as no rule offers these numbers.

## Notes

- With no event list, the result is a summary: the stage from `stage`, the status from
  `displayStatus` or `statusLabel`, and no last update. The order widget holds no events for this
  firm either.
- The window `eta.etaLabel` on `eta.dateLabel` is read in the zone `eta.timeZone` names, which the
  page converts to the visitor's own. The replies seen name `America/New_York`, the clock of the
  catalog's `America/Toronto`. A delivered order keeps no estimate.
- `details.delivery.promisedWindow` has held a time unrelated to the delivery, so it is not read.
- The recipient's name, the drop address and its map position, the items, the driver and the live
  channel the page subscribes to are not kept.

## Limitations

- No scan history, places or delivery time.
- The stage codes other than a completed stop come from the tracker's script, not from a reply.

## Numbers

Orders carry High Energy Transport's or its retailers' references, digits with or without letters.
Nothing in them points to High Energy Transport, so no rule claims them.

## Links

Tracking links are `highenergytransport.dispatchtrack.com/track_order/f7ea831/{number}`, sometimes
with the ZIP code after the number, which the link rule ignores. The page draws its answer inside a
frame. The firm's own site answers automated requests with a block page, so the catalog has no
search or help page for it.

## Testing

`npm run test:carriers:live -- carriers/high-energy-transport`, with
`HIGH_ENERGY_TRANSPORT_TRACKING_NUMBER` and `HIGH_ENERGY_TRANSPORT_UNKNOWN_NUMBER` optionally set.
