# Ryder Last Mile

Ryder Last Mile, part of Ryder System, Inc., delivers big and bulky goods such as furniture,
mattresses and appliances to homes across the United States for retailers. It was MXD Group, and
still tracks its orders on MXD Group's DispatchTrack account `mxd`, with the track code `6b8db72`,
read by the DispatchTrack reader in [High Energy Transport's folder](../high-energy-transport/dispatchtrack.ts).

## How it works

1. `direct`: two lookups on `mxd.dispatchtrack.com`, with no ZIP code or token.
   - `GET /api/v1/order_tracker/6b8db72?phone_number={number}`, the snapshot the newer tracker
     reads. It has the order's stage and delivery window, and no events.
   - `GET /track_orders/6b8db72/{number}`, the order widget the tracker page at
     `/track_order/6b8db72/{number}` reads. It has the order's numbers and a dated event at each
     milestone.
2. `retry`: both once more after a network failure or a timeout.

- An unknown order is HTTP 404 with `"error":"Order not found"` from the snapshot, and the widget
  is then not asked. Any other 404, a redirect or a reply that is not JSON is not a missing order.
  A widget that finds no order where the snapshot has one is inconclusive.
- A 422 with `captcha_error` from either lookup is the tracker's reCAPTCHA check.
- The snapshot labels the order with DispatchTrack's own order number, while customers get the
  retailer's reference. The widget's order must be the one the snapshot labels, and its own number,
  reference or tracking number must be the number asked.
- Recognition is off, as no rule offers these numbers.

## Notes

- The archived tracking links carry the delivery ZIP code after the order, and the snapshot takes
  it as `zip_code`. Both lookups answer the same without it, so the adapter asks for none.
- Event times carry an offset, Eastern time wherever the hub is, and are kept as instants. An
  event's place is the hub or the delivery town.
- An event reads as a status, a hyphen and the details ("Order Delivered-…"), and the status map
  reads the status. Scheduling calls and the appointment's time window are notices without a stage.
- The snapshot's stage is the current state. For an order that only has its delivery day set, a
  newer staged event, such as its arrival at the delivery hub, is further along and wins.
- The delivery window comes from the snapshot, in the zone it names, the delivery's. A delivered
  order keeps no estimate, and its delivery event gives the delivery time.
- The recipient's name, address and phone, the driver, the truck, the items and the shipper's
  details are not kept.

## Limitations

- An order looked up by the customer's phone number does not bind, since none of the order's
  numbers is the one asked.
- The stage codes other than a completed stop come from the tracker's script.

## Numbers

Orders carry the retailers' references, digits with or without letters. Ryder Last Mile prints no
tracking number of its own, so no rule claims them.

## Links

Tracking links are `mxd.dispatchtrack.com/track_order/6b8db72/{number}`, often with the ZIP code
after the number, which the link rule ignores. Ryderview at track.ryder.com, which ryder.com's
tracking page opens, asks for the ZIP code and hands over to the same tracker.

## Testing

`npm run test:carriers:live -- carriers/ryder-last-mile`, with `RYDER_LAST_MILE_TRACKING_NUMBER`
and `RYDER_LAST_MILE_UNKNOWN_NUMBER` optionally set.
