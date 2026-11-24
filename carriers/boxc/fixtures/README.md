# Fixtures

Replies of `POST boxc.com/api/track`, the lookup BoxC's tracking page posts the number to, without the
destination's town and province.

- `delivered.json`: the reply for the first public sample in [`numbers.json`](../numbers.json), a delivered
  shipment without events.
- `en-route.json`: the reply for the second public sample, a shipment on its way without events.
- `not-found.json`: the reply, with HTTP 200, for an invented number.
