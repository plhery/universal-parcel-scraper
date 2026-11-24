# Fixtures

Replies of Obibox's tracker, `api.obibox.io/shipment_tracking/public/shipment_tracking`.

- `delivered.json`: the reply for the public sample in [`numbers.json`](../numbers.json), a parcel collected from the
  shop and handed to the recipient in person. The recipient's name and address, the shop's address, the delivery
  instructions, the order number, the map positions and the driver's position are replaced by placeholders.
- `not-found.json`: the reply, with HTTP 404, for a synthetic number of Obibox's shape the tracker does not know.
