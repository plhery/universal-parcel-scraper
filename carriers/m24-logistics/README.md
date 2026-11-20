# M24 Logistics

M24 Logistics, a division of Media24, handles online shops' orders in South Africa and hands them to
partner couriers for the last mile. Its site is m24logistics.com. The adapter reads an order's
history through the server action its order page calls. Select the carrier explicitly.

## How it works

1. `direct`: one `POST https://lms.m24logistics.com/track-my-order/{reference}` with the page's
   `Next-Action` id and the reference as a one-item argument list, with no cookie, token or
   browser. The React Server Components reply holds the orders that answer to the reference, each
   with its parcels and their scans.
2. `action`: Next binds the action's id to each build of the site and answers an id it no longer
   has with the order page itself. The lookup then reads the current id from the page's chunks:
   the route's chunk names the module and export it awaits with the reference, and that module
   builds the export from the id. The id is tried once more and kept for later lookups.
3. `retry`: the same read once more after a network failure or a hang.

- The order in the reply must answer to the reference asked: its own order reference, the shop's
  reference, its invoice, shipment or parcel number.
- The order page reads an empty list as no order, and so does the adapter. The tracker fails a
  reference it holds no order for with a bare HTTP 500 page, the same as any other failure, so
  that reply is a failure, never a missing order. A browser check, a refusal or a reply that is
  not the action's is never read as not found.

## Notes

- Scans give a wall clock without a zone. They are read in South Africa's, where M24 delivers.
- The scans come from each parcel's history, which files a missed round under the courier or the
  customer; the order's own summary files the same scans under the round and is read only when
  the parcels list none. A scan repeated across parcels is kept once.
- The signee is read only for an order of one parcel, the one the page shows it for.

## Limitations

- No estimated delivery is read: the order's latest delivery date stays as booked after missed
  rounds.
- The partner courier is named without its own number for the parcel, so no delivery carrier is
  kept.
- References the tracker holds several orders for fail the lookup; the page asks the visitor to
  pick one.

## Numbers

Its tracker takes M24's own parcel and shipment numbers, its invoice numbers or the shop's order
reference, without regard to case. Those shapes are too generic to claim, so there is no rule.

## Links

Tracking links carry the number in the path after `/track-my-order/` on lms.m24logistics.com.

## Testing

`npm run test:carriers:live -- carriers/m24-logistics`, with `M24_LOGISTICS_TRACKING_NUMBER` and
optionally `M24_LOGISTICS_UNKNOWN_NUMBER` set outside the repository.
