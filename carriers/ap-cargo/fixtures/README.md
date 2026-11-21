# Fixtures

Whole replies for the public samples in [`numbers.json`](../numbers.json) and for a made-up
number, as each tracker gave them.

- `out-for-delivery.json`: the tracker's `waybill-tracking` record of a shipment whose history
  stops at the delivery round. `legacy-delivered.json` is the older tracker's reply for the same
  waybill, which records its delivery.
- `received.json`: the tracker's record of a shipment the consignee received.
  `legacy-received.json` is the older tracker's reply for it.
- `not-found.json`: the tracker's wrapped 404 around an empty record for the made-up number.
  `legacy-not-found.json` is the older tracker's empty record for it.
